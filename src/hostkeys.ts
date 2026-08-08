/**
 * SSH host-key verification.
 *
 * Without this, ssh2 accepts ANY server host key, so an on-path attacker who
 * can redirect an IP/DNS entry could impersonate one of your servers and watch
 * (or influence) the privileged `sudo -n` commands this server runs. Key-based
 * auth stops the attacker from stealing your private key, but does nothing to
 * authenticate the *server* — that is what host-key verification adds.
 *
 * Two mechanisms, checked in this order:
 *   1. An explicit `fingerprint` pin in servers.json (per-server or defaults).
 *      The presented key must match exactly or the connection is refused.
 *   2. A managed trust store (a small JSON file next to servers.json). The
 *      first time a host is seen its fingerprint is remembered ("TOFU"); if the
 *      fingerprint later CHANGES, the connection is refused — that change is the
 *      real man-in-the-middle signal.
 *
 * Policy is controlled by UBUNTU_MCP_HOST_KEY_CHECKING:
 *   - "tofu" (default): trust-on-first-use, then detect changes.
 *   - "strict": refuse any host that is not already pinned/remembered.
 *   - "off": accept anything (the old, unauthenticated behaviour).
 *
 * The fingerprint format is OpenSSH's SHA256 form — exactly what
 * `ssh-keyscan <host> | ssh-keygen -lf -` prints — so a pin can be copy-pasted
 * from a value you verified out-of-band.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_PATH } from "./config.js";
import type { ResolvedServer } from "./config.js";

export type HostKeyPolicy = "tofu" | "strict" | "off";

export interface HostKeyDecision {
  accept: boolean;
  /** When rejected: an actionable, user-facing explanation. */
  reason?: string;
  /** When a new key was remembered: its fingerprint, for stderr logging. */
  learned?: string;
}

/** The managed trust store lives next to servers.json unless overridden. */
const STORE_PATH = process.env.UBUNTU_MCP_HOST_KEYS
  ? path.resolve(process.env.UBUNTU_MCP_HOST_KEYS)
  : path.join(path.dirname(CONFIG_PATH), ".host-keys.json");

/** OpenSSH-style fingerprint: "SHA256:" + base64(sha256(key)) with padding stripped. */
export function fingerprintOf(key: Buffer): string {
  const digest = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}

/** Accept a pin with or without the "SHA256:" prefix and with/without padding. */
export function normalizeFingerprint(pin: string): string {
  const trimmed = pin.trim();
  const body = (trimmed.startsWith("SHA256:") ? trimmed.slice("SHA256:".length) : trimmed).replace(
    /=+$/,
    "",
  );
  return `SHA256:${body}`;
}

function readPolicy(): HostKeyPolicy {
  const raw = (process.env.UBUNTU_MCP_HOST_KEY_CHECKING ?? "tofu").toLowerCase();
  if (raw === "strict" || raw === "off" || raw === "tofu") return raw;
  return "tofu";
}

function storeKeyFor(server: ResolvedServer): string {
  return `${server.host}:${server.port}`;
}

function loadStore(): Record<string, string> {
  if (!existsSync(STORE_PATH)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    // A corrupt store must not crash a tool call; treat it as empty. Under the
    // default "tofu" policy the key is simply re-learned on this connection.
    return {};
  }
}

/**
 * Persist a newly learned fingerprint. Best-effort: re-reads immediately before
 * writing to avoid clobbering a fingerprint another concurrent connection just
 * learned, and never throws (a write failure only costs change-detection until
 * the next successful write, which we surface as a stderr warning).
 */
function rememberFingerprint(storeKey: string, fingerprint: string): void {
  try {
    const store = loadStore();
    store[storeKey] = fingerprint;
    writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(
      `ubuntu-mcp-server: WARNING — could not persist host key to ${STORE_PATH}: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `Host-key change detection is degraded until this write succeeds.`,
    );
  }
}

/**
 * Decide whether to accept a server's presented host key. Pure decision plus an
 * optional persistence side effect (remembering a first-seen key under "tofu").
 */
export function checkHostKey(server: ResolvedServer, key: Buffer): HostKeyDecision {
  const actual = fingerprintOf(key);

  // 1. Explicit pin always wins — it does not consult or update the store.
  if (server.fingerprint) {
    const expected = normalizeFingerprint(server.fingerprint);
    if (expected === actual) return { accept: true };
    return {
      accept: false,
      reason:
        `Host key for '${server.name}' (${server.host}:${server.port}) does NOT match the ` +
        `fingerprint pinned in servers.json.\n` +
        `  expected: ${expected}\n  actual:   ${actual}\n` +
        `If you deliberately rebuilt or replaced the server, update its "fingerprint". ` +
        `Otherwise this may be a man-in-the-middle — refusing to connect.`,
    };
  }

  const policy = readPolicy();
  if (policy === "off") return { accept: true };

  const storeKey = storeKeyFor(server);
  const known = loadStore()[storeKey];

  if (known) {
    const expected = normalizeFingerprint(known);
    if (expected === actual) return { accept: true };
    return {
      accept: false,
      reason:
        `REMOTE HOST KEY CHANGED for '${server.name}' (${server.host}:${server.port}).\n` +
        `  remembered: ${expected}\n  now:        ${actual}\n` +
        `This can mean the server was reinstalled — or a man-in-the-middle attack. ` +
        `If you trust the change, delete the '${storeKey}' entry from ${STORE_PATH} ` +
        `(or set it to the new fingerprint) and reconnect. Refusing to connect for now.`,
    };
  }

  // Host not seen before.
  if (policy === "strict") {
    return {
      accept: false,
      reason:
        `Unknown host key for '${server.name}' (${server.host}:${server.port}): ${actual}. ` +
        `Host-key checking is 'strict'. Verify this fingerprint out-of-band, then either add ` +
        `"fingerprint": "${actual}" to the server entry in servers.json, or set ` +
        `UBUNTU_MCP_HOST_KEY_CHECKING=tofu to trust-on-first-use.`,
    };
  }

  // Default "tofu": remember it and accept.
  rememberFingerprint(storeKey, actual);
  return { accept: true, learned: actual };
}
