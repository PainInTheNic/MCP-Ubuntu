/**
 * ubuntu_system_overview — one call, full health picture.
 *
 * Rather than making Claude run six commands (six SSH round trips, six
 * permission prompts), this batches hostname/OS/uptime/memory/disk/failed
 * services into a single delimited command and parses the result.
 */
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getServer } from "../config.js";
import { errMessage, fail, ok } from "../format.js";
import { execOnServer } from "../ssh.js";

/**
 * Each section's command is a fixed literal (never user input), echoed between
 * markers so the combined output can be split apart again. The marker carries
 * a per-call random nonce so nothing a command prints can forge a section
 * boundary.
 */
const SECTIONS: Array<[key: string, cmd: string]> = [
  ["hostname", "hostname"],
  ["os", `grep PRETTY_NAME /etc/os-release | cut -d= -f2 | tr -d '"'`],
  ["kernel", "uname -r"],
  ["uptime", "uptime -p"],
  ["load", "cat /proc/loadavg"],
  ["memory", "free -h"],
  ["disk", "df -h -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs"],
  ["reboot_required", "[ -f /var/run/reboot-required ] && echo yes || echo no"],
  ["failed_units", "systemctl --failed --no-legend --plain 2>/dev/null | head -20"],
];

function buildOverviewCommand(nonce: string): string {
  return SECTIONS.map(([key, cmd]) => `echo "===${nonce}:${key}==="; ${cmd}`).join("; ");
}

function parseSections(stdout: string, nonce: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = stdout.split(new RegExp(`(?:^|\\r?\\n)===${nonce}:([a-z_]+)===\\r?\\n?`));
  for (let i = 1; i < parts.length; i += 2) {
    sections[parts[i]] = (parts[i + 1] ?? "").trim();
  }
  return sections;
}

const InputShape = {
  server: z.string().min(1).describe("Server name from the inventory (see ubuntu_list_servers)"),
  response_format: z
    .enum(["markdown", "json"])
    .default("markdown")
    .describe("'markdown' for human-readable output, 'json' for machine-readable"),
};

const OutputShape = {
  server: z.string(),
  hostname: z.string(),
  os: z.string(),
  kernel: z.string(),
  uptime: z.string(),
  load_average: z.string(),
  reboot_required: z.boolean(),
  memory: z.string(),
  disk: z.string(),
  failed_units: z.string(),
};

export function registerSystemTools(server: McpServer): void {
  server.registerTool(
    "ubuntu_system_overview",
    {
      title: "System Overview",
      description: `Get a one-shot health overview of an Ubuntu server: hostname, OS release, kernel, uptime, load average, memory usage, disk usage, whether a reboot is required, and any failed systemd services.

This is the best first call when asked "how is server X doing?" — it gathers everything in a single SSH round trip.

Args:
  - server (string): server name from the inventory (see ubuntu_list_servers)
  - response_format ('markdown' | 'json'): output format (default 'markdown')

Returns: the sections listed above; memory and disk are the raw 'free -h' / 'df -h' tables.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ server: serverName, response_format }) => {
      try {
        const target = getServer(serverName);
        const nonce = randomUUID();
        const result = await execOnServer(target, buildOverviewCommand(nonce), { posix: true });
        const sections = parseSections(result.stdout, nonce);

        // If even the first marker is missing, the composed command itself
        // failed — report that instead of rendering an empty "overview".
        if (!("hostname" in sections)) {
          return fail(
            `Could not gather an overview from '${target.name}' (exit ${result.exitCode}): ` +
              (result.stderr.trim() || result.stdout.trim() || "no output"),
          );
        }

        const load = (sections.load ?? "").split(/\s+/).slice(0, 3).join(" ");
        const structured = {
          server: target.name,
          hostname: sections.hostname ?? "",
          os: sections.os ?? "",
          kernel: sections.kernel ?? "",
          uptime: sections.uptime ?? "",
          load_average: load,
          reboot_required: sections.reboot_required === "yes",
          memory: sections.memory ?? "",
          disk: sections.disk ?? "",
          failed_units: sections.failed_units ?? "",
        };

        if (response_format === "json") {
          return ok(JSON.stringify(structured, null, 2), structured);
        }

        const lines = [
          `# ${target.name} — system overview`,
          "",
          `- **Hostname**: ${structured.hostname}`,
          `- **OS**: ${structured.os}`,
          `- **Kernel**: ${structured.kernel}`,
          `- **Uptime**: ${structured.uptime}`,
          `- **Load average (1/5/15m)**: ${structured.load_average}`,
          `- **Reboot required**: ${structured.reboot_required ? "YES" : "no"}`,
          "",
          "## Memory",
          "```",
          structured.memory,
          "```",
          "",
          "## Disk",
          "```",
          structured.disk,
          "```",
          "",
          "## Failed services",
          structured.failed_units ? "```\n" + structured.failed_units + "\n```" : "(none)",
        ];
        return ok(lines.join("\n"), structured);
      } catch (error) {
        return fail(errMessage(error));
      }
    },
  );
}
