/**
 * systemd service tools: list, inspect, and manage services.
 *
 * Unit names are validated against a strict pattern (and may not start with a
 * hyphen), then shell-quoted — belt and braces against command injection.
 *
 * Where a composed command needs the exit code of an earlier part, we echo a
 * marker containing a per-call random nonce and split on it anchored to line
 * start. `systemctl status` embeds recent journal lines — externally
 * influenced text — so a static, unanchored marker could be forged by log
 * content; a nonce cannot.
 */
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getServer } from "../config.js";
import { clampText, errMessage, fail, lastNonEmptyLine, ok, shellQuote, sudoHint } from "../format.js";
import { execOnServer } from "../ssh.js";

const UNIT_PATTERN = /^[A-Za-z0-9@._:][A-Za-z0-9@._:-]{0,255}$/;

const UnitName = z
  .string()
  .regex(
    UNIT_PATTERN,
    "service name may contain letters, digits, @ . _ : - and must not start with a hyphen",
  )
  .describe("systemd unit name, e.g. 'nginx' or 'nginx.service'");

const ServerParam = z
  .string()
  .min(1)
  .describe("Server name from the inventory (see ubuntu_list_servers)");

interface ServiceRow {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

const ServiceRowSchema = z.object({
  unit: z.string(),
  load: z.string(),
  active: z.string(),
  sub: z.string(),
  description: z.string(),
});

const ListServicesOutput = {
  server: z.string(),
  total: z.number().int(),
  count: z.number().int(),
  offset: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().optional(),
  capture_truncated: z.boolean().optional(),
  services: z.array(ServiceRowSchema),
};

const ServiceStatusOutput = {
  server: z.string(),
  service: z.string(),
  active_state: z.string(),
  enabled_state: z.string(),
  status: z.string(),
};

const ManageServiceOutput = {
  server: z.string(),
  service: z.string(),
  action: z.string(),
  state_after: z.string(),
};

function parseServiceList(stdout: string): ServiceRow[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      return {
        unit: parts[0] ?? "",
        load: parts[1] ?? "",
        active: parts[2] ?? "",
        sub: parts[3] ?? "",
        description: parts.slice(4).join(" "),
      };
    })
    .filter((row) => row.unit.endsWith(".service"));
}

export function registerServiceTools(server: McpServer): void {
  server.registerTool(
    "ubuntu_list_services",
    {
      title: "List systemd Services",
      description: `List systemd services on an Ubuntu server, optionally filtered by state.

Args:
  - server (string): server name from the inventory (see ubuntu_list_servers)
  - state ('all' | 'running' | 'failed'): filter (default 'all')
  - limit (number): max services to return, 1-200 (default 50)
  - offset (number): skip this many for pagination (default 0)
  - response_format ('markdown' | 'json'): output format (default 'markdown')

Returns: unit name, active/sub state, and description per service, with pagination metadata (total, has_more, next_offset).

Example: state='failed' answers "is anything broken on web-01?"`,
      inputSchema: {
        server: ServerParam,
        state: z
          .enum(["all", "running", "failed"])
          .default("all")
          .describe("Filter services by state"),
        limit: z.number().int().min(1).max(200).default(50).describe("Maximum services to return"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
        response_format: z
          .enum(["markdown", "json"])
          .default("markdown")
          .describe("'markdown' for human-readable output, 'json' for machine-readable"),
      },
      outputSchema: ListServicesOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ server: serverName, state, limit, offset, response_format }) => {
      try {
        const target = getServer(serverName);
        const stateFlag = state === "all" ? "" : ` --state=${state}`;
        const result = await execOnServer(
          target,
          `systemctl list-units --type=service --all --no-legend --no-pager --plain${stateFlag}`,
          { posix: true },
        );

        // A host without a running systemd (container, WSL) exits non-zero with
        // empty stdout — that must not read as "this server has no services".
        if (result.exitCode !== 0 && !result.stdout.trim()) {
          return fail(
            `systemctl failed on '${target.name}' (exit ${result.exitCode}): ` +
              (result.stderr.trim() || "no error output"),
          );
        }

        const all = parseServiceList(result.stdout);
        const page = all.slice(offset, offset + limit);
        const hasMore = offset + page.length < all.length;

        const structured = {
          server: target.name,
          total: all.length,
          count: page.length,
          offset,
          has_more: hasMore,
          ...(hasMore ? { next_offset: offset + page.length } : {}),
          ...(result.captureTruncated ? { capture_truncated: true } : {}),
          services: page,
        };

        if (response_format === "json") {
          return ok(JSON.stringify(structured, null, 2), structured);
        }

        const lines = [
          `# Services on ${target.name} (${state})`,
          "",
          `Showing ${page.length} of ${all.length}${hasMore ? ` — use offset=${offset + page.length} for more` : ""}`,
          "",
        ];
        for (const s of page) {
          lines.push(`- **${s.unit}** — ${s.active} (${s.sub}) — ${s.description}`);
        }
        if (!page.length) lines.push("(no services matched)");
        if (result.captureTruncated) {
          lines.push("", "[Warning: raw output was capped; the total may undercount.]");
        }
        return ok(lines.join("\n"), structured);
      } catch (error) {
        return fail(errMessage(error));
      }
    },
  );

  server.registerTool(
    "ubuntu_service_status",
    {
      title: "Service Status",
      description: `Show detailed status of one systemd service: the full 'systemctl status' output (state, recent log lines, PID, memory) plus whether it is enabled at boot.

Args:
  - server (string): server name from the inventory (see ubuntu_list_servers)
  - service (string): unit name, e.g. 'nginx' or 'ssh'

Returns: raw status text plus parsed active_state ('active'/'inactive'/'failed') and enabled state ('enabled'/'disabled'/'static').

Error handling: reports if the unit does not exist and suggests ubuntu_list_services to find the right name.`,
      inputSchema: { server: ServerParam, service: UnitName },
      outputSchema: ServiceStatusOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ server: serverName, service }) => {
      try {
        const target = getServer(serverName);
        const q = shellQuote(service);
        const nonce = randomUUID();
        const result = await execOnServer(
          target,
          `systemctl status --no-pager -l ${q} 2>&1; echo "===${nonce}:RC:$?==="; ` +
            `systemctl is-enabled ${q} 2>&1; echo "===${nonce}:ENA==="; systemctl is-active ${q} 2>&1`,
          { posix: true },
        );

        const rcSplit = result.stdout.split(
          new RegExp(`(?:^|\\r?\\n)===${nonce}:RC:(\\d+)===\\r?\\n?`),
        );
        if (rcSplit.length < 3) {
          return fail(
            `Could not query '${service}' on '${target.name}' (exit ${result.exitCode}): ` +
              (result.stderr.trim() || result.stdout.trim() || "no output"),
          );
        }
        const statusText = (rcSplit[0] ?? "").trim();
        const statusRc = Number(rcSplit[1]);
        const rest = rcSplit[2] ?? "";
        const [enabledRaw = "", activeRaw = ""] = rest.split(
          new RegExp(`(?:^|\\r?\\n)===${nonce}:ENA===\\r?\\n?`),
        );
        // Warnings (e.g. SysV redirect notices) precede the state word, so the
        // answer is the LAST non-empty line, not the first.
        const enabled = lastNonEmptyLine(enabledRaw);
        const active = lastNonEmptyLine(activeRaw);

        // systemctl status exit codes: 0 = running, 3 = not running, 4 = no such unit
        if (statusRc === 4) {
          return fail(
            `Service '${service}' was not found on '${target.name}'. ` +
              `Use ubuntu_list_services to see available services.`,
          );
        }

        const structured = {
          server: target.name,
          service,
          active_state: active,
          enabled_state: enabled,
          // Clamp like the text block: systemctl status embeds recent journal
          // lines, so without this the structured copy could smuggle output far
          // past the 25k cap the text path enforces (mirrors command.ts).
          status: clampText(statusText),
        };
        const text = [
          `# ${service} on ${target.name}`,
          "",
          `- **Active**: ${active}`,
          `- **Enabled at boot**: ${enabled}`,
          "",
          "```",
          statusText,
          "```",
        ].join("\n");
        return ok(text, structured);
      } catch (error) {
        return fail(errMessage(error));
      }
    },
  );

  server.registerTool(
    "ubuntu_manage_service",
    {
      title: "Manage Service",
      description: `Start, stop, restart, reload, enable, or disable a systemd service. Runs via 'sudo -n', so the server must allow passwordless sudo for the configured user.

Args:
  - server (string): server name from the inventory (see ubuntu_list_servers)
  - service (string): unit name, e.g. 'nginx'
  - action ('start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable'): what to do

Returns: confirmation plus the service's state after the action.

Error handling: if sudo requires a password the error explains how to configure passwordless sudo. 'reload' fails for services that don't support it — use 'restart' instead.`,
      inputSchema: {
        server: ServerParam,
        service: UnitName,
        action: z
          .enum(["start", "stop", "restart", "reload", "enable", "disable"])
          .describe("Action to perform on the service"),
      },
      outputSchema: ManageServiceOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ server: serverName, service, action }) => {
      try {
        const target = getServer(serverName);
        const q = shellQuote(service);
        const nonce = randomUUID();
        const result = await execOnServer(
          target,
          `sudo -n -- systemctl ${action} ${q} 2>&1; echo "===${nonce}:RC:$?==="; systemctl is-active ${q} 2>&1`,
          { posix: true },
        );

        const rcSplit = result.stdout.split(
          new RegExp(`(?:^|\\r?\\n)===${nonce}:RC:(\\d+)===\\r?\\n?`),
        );
        if (rcSplit.length < 3) {
          return fail(
            `Could not run 'systemctl ${action} ${service}' on '${target.name}' (exit ${result.exitCode}): ` +
              (result.stderr.trim() || result.stdout.trim() || "no output"),
          );
        }
        const actionOutput = (rcSplit[0] ?? "").trim();
        const rc = Number(rcSplit[1]);
        const stateAfter = lastNonEmptyLine(rcSplit[2] ?? "");

        if (rc !== 0) {
          return fail(
            `'systemctl ${action} ${service}' failed on '${target.name}' (exit ${rc}).\n` +
              (actionOutput || "(no output)") +
              sudoHint(actionOutput),
          );
        }

        const structured = {
          server: target.name,
          service,
          action,
          state_after: stateAfter,
        };
        return ok(
          `Ran 'systemctl ${action} ${service}' on '${target.name}'. Current state: ${stateAfter || "unknown"}.` +
            (actionOutput ? `\n\n${actionOutput}` : ""),
          structured,
        );
      } catch (error) {
        return fail(errMessage(error));
      }
    },
  );
}
