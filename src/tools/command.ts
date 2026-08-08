/**
 * ubuntu_run_command — the escape hatch.
 *
 * The specialized tools (services, logs, updates, overview) cover the common
 * cases with better output; this tool covers everything else. It is annotated
 * as destructive so MCP clients treat it with appropriate caution.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getServer } from "../config.js";
import { clampText, errMessage, fail, ok, sudoHint, withProgress } from "../format.js";
import { execOnServer } from "../ssh.js";

const InputShape = {
  server: z
    .string()
    .min(1)
    .describe("Server name from the inventory (see ubuntu_list_servers)"),
  command: z
    .string()
    .min(1)
    .max(4000)
    .describe("Shell command line to execute; pipes, &&, and redirects are allowed"),
  sudo: z
    .boolean()
    .default(false)
    .describe("Run as root via 'sudo -n' (requires passwordless sudo on the server)"),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(300)
    .default(30)
    .describe("Abort if the command runs longer than this (default 30)"),
};

const OutputShape = {
  server: z.string(),
  exit_code: z.number().int().nullable(),
  signal: z.string().optional(),
  stdout: z.string(),
  stderr: z.string(),
  capture_truncated: z.boolean(),
};

export function registerCommandTools(server: McpServer): void {
  server.registerTool(
    "ubuntu_run_command",
    {
      title: "Run Shell Command",
      description: `Run an arbitrary shell command on a configured Ubuntu server over SSH and return stdout, stderr, and the exit code.

Prefer the specialized tools when they fit (ubuntu_system_overview, ubuntu_list_services, ubuntu_service_status, ubuntu_check_updates, ubuntu_tail_log) — they produce cleaner output. Use this tool for everything they don't cover.

Args:
  - server (string): server name from the inventory (see ubuntu_list_servers)
  - command (string): shell command line; pipes and redirects work
  - sudo (boolean): run as root via 'sudo -n' — requires passwordless sudo on the server (default false)
  - timeout_seconds (number): 1-300, default 30

Returns: exit code plus stdout/stderr text, also available as structured content.

Error handling:
  - Unknown server names return the list of valid names.
  - A non-zero exit code is NOT a tool error — inspect stderr to understand what the command reported.
  - If sudo fails with "a password is required", the server lacks passwordless sudo; the output includes the fix.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ server: serverName, command, sudo, timeout_seconds }, extra) => {
      try {
        const target = getServer(serverName);
        // withProgress keeps the MCP request alive past the client's own
        // timeout (often 60s) for legitimately long commands.
        const result = await withProgress(extra, () =>
          execOnServer(target, command, {
            sudo,
            timeoutMs: timeout_seconds * 1000,
            timeoutAdvice: "Raise timeout_seconds if the command legitimately needs longer.",
          }),
        );

        // Clamp the structured copy too — otherwise it would smuggle the full
        // capture (up to ~400KB) past the 25k cap applied to the text block.
        const structured = {
          server: target.name,
          exit_code: result.exitCode,
          ...(result.signal ? { signal: result.signal } : {}),
          stdout: clampText(result.stdout),
          stderr: clampText(result.stderr),
          capture_truncated: result.captureTruncated,
        };

        const outcome =
          result.exitCode !== null
            ? `Exit code ${result.exitCode}`
            : result.signal
              ? `Terminated by signal ${result.signal}`
              : "Exit code unknown";
        const lines = [
          `${outcome} on '${target.name}'`,
          "",
          "--- stdout ---",
          result.stdout.trim() || "(empty)",
        ];
        if (result.stderr.trim()) {
          lines.push("", "--- stderr ---", result.stderr.trim());
        }
        if (result.captureTruncated) {
          lines.push("", "[Note: output exceeded the capture limit and was truncated.]");
        }

        let text = lines.join("\n");
        if (sudo && result.exitCode !== 0) text += sudoHint(result.stderr);
        return ok(text, structured);
      } catch (error) {
        return fail(errMessage(error));
      }
    },
  );
}
