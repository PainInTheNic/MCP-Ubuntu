/**
 * SSH layer: one cached connection per server, plus a helper that runs a
 * command and returns { stdout, stderr, exitCode }.
 *
 * Connections open lazily on first use and are reused across tool calls, so a
 * session of "check disk, check services, tail a log" pays the SSH handshake
 * cost only once per server.
 *
 * Failure semantics (the tricky part):
 *  - Retries happen ONLY for errors that provably occurred before the remote
 *    command started (RetryableExecError). Anything after that point must NOT
 *    be retried — the command may have partially executed.
 *  - A connection that dies mid-command rejects with ConnectionLostError
 *    instead of being misreported as a completed command with partial output.
 *  - A timeout on one command must not destroy the shared connection while
 *    sibling commands are still running on it.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Client } from "ssh2";
import type { ClientChannel, ConnectConfig } from "ssh2";
import type { ResolvedServer } from "./config.js";
import { shellQuote } from "./format.js";
import { checkHostKey } from "./hostkeys.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** set when the remote command was killed by a signal (e.g. "KILL") */
  signal?: string;
  /** true when capture stopped because a stream exceeded MAX_CAPTURE */
  captureTruncated: boolean;
}

export interface ExecOptions {
  timeoutMs?: number;
  /** wrap as `sudo -n -- bash -c '<command>'` (root, passwordless sudo required) */
  sudo?: boolean;
  /**
   * wrap as `bash -c '<command>'` with LC_ALL=C. Internal tools that compose
   * multi-part commands ($?, markers, && chains) must set this so the command
   * is independent of the remote user's login shell (fish/csh) and locale.
   */
  posix?: boolean;
  /** appended to timeout errors; tells the model an actually-available remedy */
  timeoutAdvice?: string;
}

/** The command ran too long (or the server never accepted it). Never retried. */
export class ExecTimeoutError extends Error {}
/** The connection died at a point where the command may have (partially) run. Never retried. */
export class ConnectionLostError extends Error {}
/** The failure provably happened before the command started. Safe to retry once. */
export class RetryableExecError extends Error {}

const DEFAULT_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
/** Per-stream capture cap; keeps a runaway command from exhausting memory. */
const MAX_CAPTURE = 200_000;

const DEFAULT_TIMEOUT_ADVICE =
  "Narrow the request (fewer lines, add filters), or use ubuntu_run_command with a larger timeout_seconds.";

const connections = new Map<string, Client>();
const pending = new Map<string, Promise<Client>>();
/** Number of in-flight execs per client, so timeouts know if siblings exist. */
const inFlight = new Map<Client, number>();

/**
 * Evict only if this exact client is still the cached one — a stale client's
 * late 'close' event must never evict a newer, healthy replacement connection.
 */
function evictIfCurrent(name: string, client: Client): void {
  if (connections.get(name) === client) connections.delete(name);
}

function defaultKeyCandidates(): string[] {
  const sshDir = path.join(homedir(), ".ssh");
  return ["id_ed25519", "id_rsa", "id_ecdsa"].map((f) => path.join(sshDir, f));
}

/**
 * Credential resolution order:
 *   1. privateKeyPath from servers.json (per-server or defaults)
 *   2. default keys in ~/.ssh (id_ed25519, id_rsa, id_ecdsa)
 *   3. a running ssh-agent (Windows OpenSSH agent pipe, or SSH_AUTH_SOCK)
 * Passwords are deliberately unsupported — key-based auth only.
 */
function buildAuth(server: ResolvedServer): Partial<ConnectConfig> {
  const auth: Partial<ConnectConfig> = {};

  if (server.privateKeyPath) {
    if (!existsSync(server.privateKeyPath)) {
      throw new Error(
        `Private key not found at ${server.privateKeyPath} (configured for server '${server.name}'). ` +
          `Fix privateKeyPath in servers.json, or generate a key with: ssh-keygen -t ed25519`,
      );
    }
    auth.privateKey = readFileSync(server.privateKeyPath);
  } else {
    const found = defaultKeyCandidates().find((p) => existsSync(p));
    if (found) auth.privateKey = readFileSync(found);
  }

  if (process.env.UBUNTU_MCP_KEY_PASSPHRASE) {
    auth.passphrase = process.env.UBUNTU_MCP_KEY_PASSPHRASE;
  }

  // Also offer the local ssh-agent when one exists; ssh2 falls back to it if
  // key-file auth is unavailable or rejected.
  if (process.platform === "win32") {
    auth.agent = "\\\\.\\pipe\\openssh-ssh-agent";
  } else if (process.env.SSH_AUTH_SOCK) {
    auth.agent = process.env.SSH_AUTH_SOCK;
  }

  if (!auth.privateKey && !auth.agent) {
    throw new Error(
      `No SSH credentials available for '${server.name}'. Set privateKeyPath in servers.json, or create ` +
        `a default key (ssh-keygen -t ed25519) and install its .pub on the server's ~/.ssh/authorized_keys.`,
    );
  }
  return auth;
}

/** Translate low-level socket/auth failures into messages that say what to fix. */
function describeConnectError(
  server: ResolvedServer,
  error: Error & { code?: string; level?: string },
): string {
  const target = `${server.username}@${server.host}:${server.port}`;
  if (error.level === "client-authentication" || /authentication/i.test(error.message)) {
    return (
      `Error: SSH authentication failed for ${target}. Check the username, and that your public key is in ` +
      `~/.ssh/authorized_keys on the server. If your key has a passphrase, load it into ssh-agent or set ` +
      `the UBUNTU_MCP_KEY_PASSPHRASE environment variable.`
    );
  }
  if (error.code === "ETIMEDOUT" || /timed? ?out/i.test(error.message)) {
    return (
      `Error: Connection to ${target} timed out. Check the host address, that the machine is up, and that ` +
      `port ${server.port} is reachable (firewall/VPN).`
    );
  }
  if (error.code === "ECONNREFUSED") {
    return `Error: ${target} refused the connection. Is sshd running on port ${server.port}?`;
  }
  if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") {
    return `Error: Could not resolve host '${server.host}'. Check the hostname/IP in servers.json.`;
  }
  return `Error: SSH connection to ${target} failed: ${error.message}`;
}

function connect(server: ResolvedServer): Promise<Client> {
  const auth = buildAuth(server); // throws an actionable message if no credentials exist

  return new Promise<Client>((resolve, reject) => {
    const client = new Client();
    let settled = false;
    // Set when hostVerifier refuses the key, so the resulting 'error'/'close'
    // is reported as the actionable host-key message rather than a generic
    // "handshake failed". ssh2 gives hostVerifier no way to pass a reason out.
    let hostKeyRejection: string | undefined;

    client.on("ready", () => {
      settled = true;
      connections.set(server.name, client);
      resolve(client);
    });
    client.on("error", (error) => {
      evictIfCurrent(server.name, client);
      if (!settled) {
        settled = true;
        reject(new Error(hostKeyRejection ?? describeConnectError(server, error)));
      }
    });
    // ssh2 can emit a clean 'close' with no 'error' (e.g. the peer sends its
    // banner then drops the socket, or hostVerifier rejected the key). Without
    // this rejection the promise would never settle and every future call for
    // this server would hang on it.
    client.on("close", () => {
      evictIfCurrent(server.name, client);
      if (!settled) {
        settled = true;
        reject(
          new Error(
            hostKeyRejection ??
              `Error: SSH connection to ${server.username}@${server.host}:${server.port} closed before it ` +
                `became ready. The server may be restarting or dropping connections — try again shortly.`,
          ),
        );
      }
    });

    client.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
      // Authenticate the SERVER (not just ourselves): reject a host whose key
      // is unknown/changed per the configured policy. Without this ssh2 accepts
      // any host key, leaving privileged commands open to a man-in-the-middle.
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        const decision = checkHostKey(server, key);
        if (decision.accept) {
          if (decision.learned) {
            console.error(
              `ubuntu-mcp-server: learned host key for '${server.name}' ` +
                `(${server.host}:${server.port}): ${decision.learned}`,
            );
          }
          verify(true);
        } else {
          hostKeyRejection = decision.reason?.startsWith("Error")
            ? decision.reason
            : `Error: ${decision.reason}`;
          verify(false);
        }
      },
      ...auth,
    });
  });
}

async function getConnection(server: ResolvedServer): Promise<Client> {
  const cached = connections.get(server.name);
  if (cached) return cached;

  const existing = pending.get(server.name);
  if (existing) return existing;

  const attempt = connect(server).finally(() => pending.delete(server.name));
  pending.set(server.name, attempt);
  return attempt;
}

function execOnce(
  server: ResolvedServer,
  client: Client,
  command: string,
  timeoutMs: number,
  timeoutAdvice: string,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    let finished = false;
    let channel: ClientChannel | undefined;

    inFlight.set(client, (inFlight.get(client) ?? 0) + 1);
    const settle = (outcome: () => void): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const count = (inFlight.get(client) ?? 1) - 1;
      if (count <= 0) inFlight.delete(client);
      else inFlight.set(client, count);
      outcome();
    };

    // The deadline is armed BEFORE client.exec so it also bounds the
    // channel-open phase — a silently dead connection would otherwise block
    // until ssh2's keepalive teardown (~60s) regardless of timeoutMs.
    const seconds = Math.round(timeoutMs / 1000);
    const timer = setTimeout(() => {
      settle(() => {
        const siblings = (inFlight.get(client) ?? 0) > 0;
        if (channel && siblings) {
          // Surgical: close only this channel. Ending the shared client would
          // abort and misreport every other in-flight command on this server.
          channel.close();
          reject(
            new ExecTimeoutError(
              `Command timed out after ${seconds}s on '${server.name}'. The remote process may still be ` +
                `running. ${timeoutAdvice}`,
            ),
          );
        } else if (channel) {
          // Sole user: reset the connection so the remote side is actually torn down.
          evictIfCurrent(server.name, client);
          client.end();
          reject(
            new ExecTimeoutError(
              `Command timed out after ${seconds}s on '${server.name}'. The SSH connection was reset ` +
                `(the remote process may still be running). ${timeoutAdvice}`,
            ),
          );
        } else {
          // The channel never opened, so the command never started — safe to retry.
          evictIfCurrent(server.name, client);
          if (!siblings) client.end();
          reject(
            new RetryableExecError(
              `Timed out after ${seconds}s waiting for '${server.name}' to accept the command — the ` +
                `cached connection may be stale.`,
            ),
          );
        }
      });
    }, timeoutMs);

    try {
      client.exec(command, (error: Error | undefined, stream: ClientChannel) => {
        if (finished) {
          // Deadline already fired while the channel was opening.
          if (stream) stream.close();
          return;
        }
        if (error) {
          settle(() => {
            if (/unable to exec/i.test(error.message)) {
              // The exec request was written but the reply was lost — the
              // server may have already spawned the command. NOT retryable.
              reject(
                new ConnectionLostError(
                  `Connection to '${server.name}' was lost while the command was being started; it may or ` +
                    `may not have run. Verify state before retrying anything non-idempotent.`,
                ),
              );
            } else {
              // Channel-open failures ('No response from server', open refusals)
              // happen strictly before the command exists remotely.
              reject(
                new RetryableExecError(`Failed to start command on '${server.name}': ${error.message}`),
              );
            }
          });
          return;
        }

        channel = stream;
        let stdout = "";
        let stderr = "";
        let captureTruncated = false;

        stream.on("data", (chunk: Buffer) => {
          if (stdout.length < MAX_CAPTURE) stdout += chunk.toString("utf8");
          else captureTruncated = true;
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < MAX_CAPTURE) stderr += chunk.toString("utf8");
          else captureTruncated = true;
        });
        stream.on("close", (code: unknown, signal: unknown) => {
          settle(() => {
            if (typeof code === "number") {
              resolve({ stdout, stderr, exitCode: code, captureTruncated });
            } else if (typeof signal === "string" && signal) {
              resolve({ stdout, stderr, exitCode: null, signal, captureTruncated });
            } else {
              // Neither an exit code nor a signal: the connection died under
              // us. Partial output must not masquerade as a completed command.
              evictIfCurrent(server.name, client);
              reject(
                new ConnectionLostError(
                  `SSH connection to '${server.name}' was lost while the command was running. The command ` +
                    `may have partially executed and its output was discarded as incomplete.`,
                ),
              );
            }
          });
        });
        stream.on("error", (streamError: Error) => {
          settle(() =>
            reject(
              new ConnectionLostError(
                `Command stream failed on '${server.name}' after the command started: ${streamError.message}. ` +
                  `The command may have partially executed.`,
              ),
            ),
          );
        });
      });
    } catch (error) {
      // Synchronous 'Not connected' throw: the cached socket was already dead,
      // the command never left this machine — retryable.
      settle(() =>
        reject(
          new RetryableExecError(
            `Connection to '${server.name}' is not usable: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
      );
    }
  });
}

/**
 * Run a shell command on a server.
 *
 * sudo wraps as `sudo -n -- bash -c '<command>'` so pipes/redirects also run
 * as root; -n means "never prompt for a password" — it fails fast with a clear
 * error when passwordless sudo is not configured, instead of hanging.
 *
 * Both wrappers use `env LC_ALL=C` so output parsing and error-message
 * sniffing (e.g. sudo's "a password is required") are locale-independent.
 */
export async function execOnServer(
  server: ResolvedServer,
  command: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const advice = options.timeoutAdvice ?? DEFAULT_TIMEOUT_ADVICE;

  let finalCommand = command;
  if (options.sudo) {
    finalCommand = `env LC_ALL=C sudo -n -- bash -c ${shellQuote(command)}`;
  } else if (options.posix) {
    finalCommand = `env LC_ALL=C bash -c ${shellQuote(command)}`;
  }

  try {
    const client = await getConnection(server);
    return await execOnce(server, client, finalCommand, timeoutMs, advice);
  } catch (error) {
    // Only failures that provably preceded command start are retried, exactly
    // once, on a fresh connection (the failed client evicted itself).
    if (!(error instanceof RetryableExecError)) throw error;
    const fresh = await getConnection(server);
    return execOnce(server, fresh, finalCommand, timeoutMs, advice);
  }
}
