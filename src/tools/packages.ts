/**
 * ubuntu_check_updates — pending apt package updates.
 *
 * Never installs anything; it only lists what 'apt list --upgradable' reports,
 * flags security updates, and checks whether a reboot is pending.
 *
 * Ordering matters: the fixed-size sections (refresh result, reboot flag) are
 * emitted BEFORE the unbounded package listing, so even if a huge listing hits
 * the SSH capture cap, the reboot answer is never lost. The command runs under
 * LC_ALL=C (via posix exec) so '[upgradable from: ...]' is never localized.
 */
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getServer } from "../config.js";
import { errMessage, fail, ok, sudoHint, withProgress } from "../format.js";
import { execOnServer } from "../ssh.js";

interface UpgradablePackage {
  name: string;
  repo: string;
  new_version: string;
  old_version?: string;
  security: boolean;
}

// Example line: nginx/noble-updates 1.24.0-2ubuntu7.1 amd64 [upgradable from: 1.24.0-2ubuntu7]
const PACKAGE_LINE = /^([^/\s]+)\/(\S+)\s+(\S+)\s+\S+(?:\s+\[upgradable from:\s*([^\]]+)\])?/;

function parseUpgradable(stdout: string): UpgradablePackage[] {
  const packages: UpgradablePackage[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim() || line.startsWith("Listing")) continue;
    const match = PACKAGE_LINE.exec(line.trim());
    if (!match) continue;
    packages.push({
      name: match[1] ?? "",
      repo: match[2] ?? "",
      new_version: match[3] ?? "",
      ...(match[4] ? { old_version: match[4] } : {}),
      security: /-security/.test(match[2] ?? ""),
    });
  }
  return packages;
}

const InputShape = {
  server: z.string().min(1).describe("Server name from the inventory (see ubuntu_list_servers)"),
  refresh_cache: z
    .boolean()
    .default(false)
    .describe(
      "Run 'sudo -n apt-get update' first so results are current (requires passwordless sudo). " +
        "When false, results come from the last time the package cache was refreshed.",
    ),
  limit: z.number().int().min(1).max(200).default(50).describe("Maximum packages to list"),
  response_format: z
    .enum(["markdown", "json"])
    .default("markdown")
    .describe("'markdown' for human-readable output, 'json' for machine-readable"),
};

const OutputShape = {
  server: z.string(),
  total: z.number().int(),
  count: z.number().int(),
  security_count: z.number().int(),
  reboot_required: z.boolean(),
  has_more: z.boolean(),
  list_truncated: z.boolean().optional(),
  refresh_warning: z.string().optional(),
  packages: z.array(
    z.object({
      name: z.string(),
      repo: z.string(),
      new_version: z.string(),
      old_version: z.string().optional(),
      security: z.boolean(),
    }),
  ),
};

export function registerPackageTools(server: McpServer): void {
  server.registerTool(
    "ubuntu_check_updates",
    {
      title: "Check Package Updates",
      description: `List pending apt package updates on an Ubuntu server, flag security updates, and report whether a reboot is required. Does NOT install anything.

Args:
  - server (string): server name from the inventory (see ubuntu_list_servers)
  - refresh_cache (boolean): run 'apt-get update' first via sudo -n for current results (default false)
  - limit (number): max packages to list, 1-200 (default 50)
  - response_format ('markdown' | 'json'): output format (default 'markdown')

Returns: total pending updates, security update count, reboot-required flag, and per-package old → new versions.

To actually install updates, use ubuntu_run_command with sudo, e.g. command='apt-get upgrade -y' sudo=true — after confirming with the user.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ server: serverName, refresh_cache, limit, response_format }, extra) => {
      try {
        const target = getServer(serverName);
        const nonce = randomUUID();

        let command = "";
        if (refresh_cache) {
          command += `sudo -n apt-get update -qq 2>&1; echo "===${nonce}:REFRESH:$?==="; `;
        }
        command +=
          `[ -f /var/run/reboot-required ] && echo yes || echo no; ` +
          `echo "===${nonce}:LIST==="; apt list --upgradable 2>/dev/null`;

        const result = await withProgress(extra, () =>
          execOnServer(target, command, { posix: true, timeoutMs: 120_000 }),
        );

        let remaining = result.stdout;
        let refreshWarning = "";
        if (refresh_cache) {
          const match = remaining.split(
            new RegExp(`(?:^|\\r?\\n)===${nonce}:REFRESH:(\\d+)===\\r?\\n?`),
          );
          if (match.length >= 3) {
            const refreshOutput = (match[0] ?? "").trim();
            const refreshRc = Number(match[1]);
            remaining = match[2] ?? "";
            if (refreshRc !== 0) {
              refreshWarning =
                `Warning: could not refresh the package cache (exit ${refreshRc}); results may be stale.\n` +
                (refreshOutput || "") +
                sudoHint(refreshOutput);
            }
          } else {
            refreshWarning = "Warning: cache refresh produced no marker; results may be stale.";
          }
        }

        const listSplit = remaining.split(new RegExp(`(?:^|\\r?\\n)===${nonce}:LIST===\\r?\\n?`));
        if (listSplit.length < 2) {
          return fail(
            `Could not check updates on '${target.name}' (exit ${result.exitCode}): ` +
              (result.stderr.trim() || result.stdout.trim() || "no output"),
          );
        }
        const rebootRequired = (listSplit[0] ?? "").trim().endsWith("yes");
        const packages = parseUpgradable(listSplit[1] ?? "");
        const securityCount = packages.filter((p) => p.security).length;
        const page = packages.slice(0, limit);

        const structured = {
          server: target.name,
          total: packages.length,
          count: page.length,
          security_count: securityCount,
          reboot_required: rebootRequired,
          has_more: packages.length > page.length,
          // If the capture cap was hit, the tail of the listing is missing —
          // the counts are a floor, not the truth. Say so instead of guessing.
          ...(result.captureTruncated ? { list_truncated: true } : {}),
          ...(refreshWarning ? { refresh_warning: refreshWarning } : {}),
          packages: page,
        };

        if (response_format === "json") {
          return ok(JSON.stringify(structured, null, 2), structured);
        }

        const lines = [`# Pending updates on ${target.name}`, ""];
        if (refreshWarning) lines.push(refreshWarning, "");
        lines.push(
          `- **Pending updates**: ${packages.length}${result.captureTruncated ? "+ (listing was cut off — treat as a minimum)" : ""} (${securityCount} security)`,
          `- **Reboot required**: ${rebootRequired ? "YES" : "no"}`,
          "",
        );
        if (page.length) {
          for (const p of page) {
            lines.push(
              `- **${p.name}** ${p.old_version ? `${p.old_version} → ` : ""}${p.new_version}` +
                ` (${p.repo})${p.security ? " **[security]**" : ""}`,
            );
          }
          if (packages.length > page.length) {
            lines.push("", `…and ${packages.length - page.length} more (raise 'limit' to see them).`);
          }
        } else {
          lines.push("Everything is up to date.");
        }
        return ok(lines.join("\n"), structured);
      } catch (error) {
        return fail(errMessage(error));
      }
    },
  );
}
