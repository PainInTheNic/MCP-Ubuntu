/**
 * ubuntu_list_servers — the discovery tool.
 *
 * Claude calls this first to learn which machines exist and what to call them.
 * It only reads servers.json; it makes no network connections.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadServers } from "../config.js";
import { errMessage, fail, ok } from "../format.js";

const InputShape = {
  response_format: z
    .enum(["markdown", "json"])
    .default("markdown")
    .describe("'markdown' for human-readable output, 'json' for machine-readable"),
};

const OutputShape = {
  count: z.number().int(),
  servers: z.array(
    z.object({
      name: z.string(),
      host: z.string(),
      port: z.number().int(),
      username: z.string(),
      description: z.string().optional(),
    }),
  ),
};

export function registerServerTools(server: McpServer): void {
  server.registerTool(
    "ubuntu_list_servers",
    {
      title: "List Ubuntu Servers",
      description: `List all Ubuntu servers configured in the inventory (servers.json), with their connection details.

Call this first to discover valid values for the 'server' parameter used by every other ubuntu_* tool.

Args:
  - response_format ('markdown' | 'json'): output format (default 'markdown')

Returns: name, host, port, username and description for each configured server. Does not contact the servers, so a listed server is not necessarily reachable right now.`,
      inputSchema: InputShape,
      outputSchema: OutputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ response_format }) => {
      try {
        const servers = loadServers();
        const structured = {
          count: servers.length,
          servers: servers.map((s) => ({
            name: s.name,
            host: s.host,
            port: s.port,
            username: s.username,
            ...(s.description ? { description: s.description } : {}),
          })),
        };

        if (response_format === "json") {
          return ok(JSON.stringify(structured, null, 2), structured);
        }

        const lines = [`# Configured Ubuntu servers (${servers.length})`, ""];
        for (const s of structured.servers) {
          lines.push(
            `- **${s.name}** — ${s.username}@${s.host}:${s.port}` +
              (s.description ? ` — ${s.description}` : ""),
          );
        }
        return ok(lines.join("\n"), structured);
      } catch (error) {
        return fail(errMessage(error));
      }
    },
  );
}
