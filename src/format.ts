/**
 * Shared helpers for building tool responses.
 *
 * Every MCP tool returns a CallToolResult: a list of content blocks (we use
 * text) plus optional machine-readable `structuredContent`. Centralizing the
 * helpers here means every tool formats output, errors, and truncation the
 * same way.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Hard cap on response size so a huge log file can't flood the model's context. */
export const CHARACTER_LIMIT = 25_000;

export function clampText(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n[Output truncated at ${CHARACTER_LIMIT.toLocaleString()} characters. ` +
    `Narrow the request (fewer lines, add a filter/grep) to see the rest.]`
  );
}

/** Successful tool result: human-readable text plus optional structured data. */
export function ok(text: string, structured?: Record<string, unknown>): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text: clampText(text) }] };
  if (structured) result.structuredContent = structured;
  return result;
}

/**
 * Failed tool result. Note this is a *tool-level* error (isError: true), not a
 * protocol error — the model sees the message and can correct course, which is
 * exactly what we want for "unknown server" or "SSH auth failed".
 */
export function fail(message: string): CallToolResult {
  const text = message.startsWith("Error") ? message : `Error: ${message}`;
  return { isError: true, content: [{ type: "text", text: clampText(text) }] };
}

export function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Quote a value for safe use inside a POSIX shell command.
 * Wraps in single quotes; embedded single quotes become '\'' (close quote,
 * escaped quote, reopen quote). This is the standard defense against command
 * injection when embedding user-supplied values (paths, search strings) in an
 * SSH command line.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Last non-empty line of a command's output. Tools like `systemctl is-enabled`
 * print warnings BEFORE the answer (e.g. SysV redirect notices), so the state
 * word is on the last line whenever the output is multi-line.
 */
export function lastNonEmptyLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/**
 * Keep a long-running tool call alive by emitting MCP progress notifications
 * every 10s while `work` runs. Clients abort requests on their own timeout
 * (commonly 60s) unless progress arrives, so any exec that may legitimately
 * exceed ~45s should run through this. No-op when the client sent no
 * progressToken.
 */
export async function withProgress<T>(
  extra: {
    _meta?: { progressToken?: string | number };
    sendNotification: (notification: {
      method: "notifications/progress";
      params: { progressToken: string | number; progress: number };
    }) => Promise<void>;
  },
  work: () => Promise<T>,
): Promise<T> {
  const token = extra._meta?.progressToken;
  if (token === undefined) return work();

  let progress = 0;
  const timer = setInterval(() => {
    progress += 1;
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress },
      })
      .catch(() => {
        /* a failed notification must never break the actual work */
      });
  }, 10_000);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

/** Detect the classic "sudo needs a password" failure and explain the fix. */
export function sudoHint(stderr: string): string {
  if (!/a password is required|a terminal is required/i.test(stderr)) return "";
  return (
    "\n\nHint: this server requires a password for sudo, but the MCP server runs non-interactively (sudo -n). " +
    "Either run the command without sudo, or grant passwordless sudo to this user on that machine, e.g.:\n" +
    "  echo 'youruser ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/youruser"
  );
}
