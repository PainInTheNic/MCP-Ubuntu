/**
 * Loads and validates servers.json — the inventory of Ubuntu machines this
 * MCP server is allowed to connect to.
 *
 * The file is re-read on every tool call (it is tiny), so you can add or edit
 * servers without restarting Claude Code.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

const DefaultsSchema = z
  .object({
    username: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    privateKeyPath: z.string().min(1).optional(),
    fingerprint: z.string().min(1).optional(),
  })
  .strict();

const ServerEntrySchema = z
  .object({
    name: z
      .string()
      .regex(NAME_PATTERN, "name may only contain letters, digits, dot, underscore and hyphen"),
    host: z.string().min(1),
    description: z.string().optional(),
    username: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    privateKeyPath: z.string().min(1).optional(),
    // Optional pinned SSH host-key fingerprint (OpenSSH SHA256 form, e.g.
    // "SHA256:abc..."). When set, the server's presented host key must match
    // exactly or the connection is refused. See src/hostkeys.ts.
    fingerprint: z.string().min(1).optional(),
  })
  .strict();

const ConfigSchema = z
  .object({
    defaults: DefaultsSchema.optional(),
    servers: z.array(ServerEntrySchema).min(1, "servers.json must define at least one server"),
  })
  .strict();

/** A server entry with defaults applied — what the SSH layer consumes. */
export interface ResolvedServer {
  name: string;
  host: string;
  port: number;
  username: string;
  privateKeyPath?: string;
  description?: string;
  /** Optional pinned host-key fingerprint (OpenSSH SHA256 form). */
  fingerprint?: string;
}

// This file compiles to dist/config.js, so the package root is one level up.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CONFIG_PATH = process.env.UBUNTU_MCP_CONFIG
  ? path.resolve(process.env.UBUNTU_MCP_CONFIG)
  : path.join(packageRoot, "servers.json");

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir(), p.slice(2));
  return p;
}

export function loadServers(): ResolvedServer[] {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `No server inventory found at ${CONFIG_PATH}. ` +
        `Copy servers.example.json to servers.json (next to package.json) and fill in your hosts, ` +
        `or point the UBUNTU_MCP_CONFIG environment variable at your inventory file.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    throw new Error(
      `${CONFIG_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${CONFIG_PATH} failed validation: ${issues}`);
  }

  const { defaults, servers } = parsed.data;
  const seen = new Set<string>();
  return servers.map((entry) => {
    if (seen.has(entry.name)) {
      throw new Error(`${CONFIG_PATH}: duplicate server name '${entry.name}'`);
    }
    seen.add(entry.name);

    const username = entry.username ?? defaults?.username;
    if (!username) {
      throw new Error(
        `${CONFIG_PATH}: server '${entry.name}' has no username and no defaults.username is set. ` +
          `Add a username to the entry or to the defaults block.`,
      );
    }

    const resolved: ResolvedServer = {
      name: entry.name,
      host: entry.host,
      port: entry.port ?? defaults?.port ?? 22,
      username,
    };
    const keyPath = entry.privateKeyPath ?? defaults?.privateKeyPath;
    if (keyPath) resolved.privateKeyPath = expandHome(keyPath);
    if (entry.description) resolved.description = entry.description;
    const fingerprint = entry.fingerprint ?? defaults?.fingerprint;
    if (fingerprint) resolved.fingerprint = fingerprint;
    return resolved;
  });
}

export function getServer(name: string): ResolvedServer {
  const servers = loadServers();
  const match = servers.find((s) => s.name === name);
  if (!match) {
    const available = servers.map((s) => s.name).join(", ");
    throw new Error(
      `Unknown server '${name}'. Configured servers: ${available}. ` +
        `Use ubuntu_list_servers to see connection details.`,
    );
  }
  return match;
}
