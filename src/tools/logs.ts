/**
 * ubuntu_tail_log — read recent lines from the systemd journal or a log file.
 *
 * User-influenced values (unit, path, since, grep) are validated and
 * shell-quoted before being embedded in the remote command.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getServer } from "../config.js";
import { errMessage, fail, ok, shellQuote } from "../format.js";
import { execOnServer } from "../ssh.js";

const InputShape = {
  server: z.string().min(1).describe("Server name from the inventory (see ubuntu_list_servers)"),
  source: z
    .enum(["journal", "file"])
    .default("journal")
    .describe("'journal' reads systemd's journal (journalctl); 'file' tails a log file"),
  unit: z
    .string()
    .regex(/^[A-Za-z0-9@._:][A-Za-z0-9@._:-]{0,255}$/, "invalid systemd unit name")
    .optional()
    .describe("journal only: limit to one systemd unit, e.g. 'nginx' (omit for the full journal)"),
  path: z
    .string()
    .max(512)
    .regex(/^\/[^\n\r\0]*$/, "path must be absolute (start with /)")
    .optional()
    .describe("file only: absolute path of the log file, e.g. '/var/log/nginx/error.log'"),
  lines: z.number().int().min(1).max(1000).default(100).describe("Number of lines to return"),
  since: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9 :.+-]{0,63}$/, "invalid --since value")
    .optional()
    .describe("journal only: e.g. '1 hour ago', 'today', '2026-08-08 10:00'"),
  grep: z
    .string()
    .min(1)
    .max(200)
    // Multi-line patterns silently change grep -F semantics (each line becomes
    // an OR-alternative; an empty line matches everything), so require one line.
    .regex(/^(?=.*\S)[^\n\r\0]+$/, "grep must be a single non-empty line of text")
    .optional()
    .describe("Only return lines containing this text (fixed string, case-insensitive)"),
  use_sudo: z
    .boolean()
    .default(false)
    .describe("Read via sudo -n, for logs your user cannot read (requires passwordless sudo)"),
};

const OutputShape = {
  server: z.string(),
  source: z.enum(["journal", "file"]),
  line_count: z.number().int(),
  filtered: z.boolean(),
  truncated: z.boolean().optional(),
};

export function registerLogTools(server: McpServer): void {
  server.registerTool(
    "ubuntu_tail_log",
    {
      title: "Tail Logs",
      description: `Read recent log lines from an Ubuntu server — either from the systemd journal (journalctl) or from a log file — optionally filtered to lines containing a search string.

Args:
  - server (string): server name from the inventory (see ubuntu_list_servers)
  - source ('journal' | 'file'): where to read from (default 'journal')
  - unit (string, journal only): systemd unit, e.g. 'nginx' — omit for the whole journal
  - path (string, file only, required): absolute file path, e.g. '/var/log/syslog'
  - lines (number): how many recent lines, 1-1000 (default 100)
  - since (string, journal only): time filter like '1 hour ago' or 'today'
  - grep (string): only lines containing this text (case-insensitive fixed string)
  - use_sudo (boolean): read as root for protected logs (default false)

Returns: the matching log lines as plain text.

Error handling: permission errors suggest use_sudo=true or adding the user to the 'adm'/'systemd-journal' groups.

Examples:
  - "errors in nginx logs in the last hour" -> source='journal', unit='nginx', since='1 hour ago', grep='error'
  - "last 50 lines of /var/log/auth.log" -> source='file', path='/var/log/auth.log', lines=50`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ server: serverName, source, unit, path, lines, since, grep, use_sudo }) => {
      try {
        const target = getServer(serverName);

        let command: string;
        if (source === "file") {
          if (!path) {
            return fail(
              "source='file' requires the 'path' parameter (an absolute path such as '/var/log/syslog'). " +
                "Or use source='journal' to read the systemd journal.",
            );
          }
          command = `tail -n ${lines} -- ${shellQuote(path)}`;
        } else {
          command = `journalctl --no-pager -n ${lines}`;
          if (unit) command += ` -u ${shellQuote(unit)}`;
          if (since) command += ` --since ${shellQuote(since)}`;
        }
        if (grep) command += ` | grep -i -F -- ${shellQuote(grep)}`;

        const result = await execOnServer(target, command, { sudo: use_sudo, posix: !use_sudo });

        // grep exits 1 when nothing matches — that's "no results", not a failure.
        if (grep && result.exitCode === 1 && !result.stdout.trim() && !result.stderr.trim()) {
          return ok(`No log lines matched '${grep}'.`, {
            server: target.name,
            source,
            line_count: 0,
            filtered: true,
          });
        }

        if (result.exitCode !== 0 && !result.stdout.trim()) {
          let message = `Could not read logs on '${target.name}' (exit ${result.exitCode}).\n${result.stderr.trim()}`;
          if (/permission denied|not seeing messages from other users/i.test(result.stderr)) {
            message +=
              "\n\nHint: try use_sudo=true, or add the SSH user to the 'adm' and 'systemd-journal' groups on the server.";
          }
          return fail(message);
        }

        const trimmed = result.stdout.trim();
        const output = trimmed || "(no log lines returned)";
        const header =
          source === "file"
            ? `# Last ${lines} lines of ${path} on ${target.name}`
            : `# Journal on ${target.name}${unit ? ` — unit ${unit}` : ""}${since ? ` — since ${since}` : ""}`;
        // Structured content on every success branch (not just the no-match
        // branch), with a stable shape a client can rely on.
        const structured = {
          server: target.name,
          source,
          line_count: trimmed ? trimmed.split("\n").length : 0,
          filtered: !!grep,
          ...(result.captureTruncated ? { truncated: true } : {}),
        };
        return ok(
          `${header}${grep ? ` — filtered by '${grep}'` : ""}\n\n\`\`\`\n${output}\n\`\`\``,
          structured,
        );
      } catch (error) {
        return fail(errMessage(error));
      }
    },
  );
}
