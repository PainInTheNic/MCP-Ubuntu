#!/usr/bin/env node
/**
 * ubuntu-mcp-server — MCP server for managing Ubuntu machines over SSH.
 *
 * Claude Code launches this file as a subprocess and speaks the Model Context
 * Protocol (JSON-RPC) with it over stdin/stdout. That is why nothing here may
 * ever print to stdout — logs go to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CONFIG_PATH, loadServers } from "./config.js";
import { registerCommandTools } from "./tools/command.js";
import { registerLogTools } from "./tools/logs.js";
import { registerPackageTools } from "./tools/packages.js";
import { registerServerTools } from "./tools/servers.js";
import { registerServiceTools } from "./tools/services.js";
import { registerSystemTools } from "./tools/system.js";

const server = new McpServer(
  { name: "ubuntu-mcp-server", version: "1.0.0" },
  {
    // Surfaced to the model as top-level guidance at initialize time, so the
    // discovery/selection convention doesn't depend on it reading one specific
    // tool's description first.
    instructions:
      "Tools for managing Ubuntu servers over SSH. Every tool takes a `server` argument " +
      "that must be a name from the inventory — call `ubuntu_list_servers` first if you " +
      "don't already know the names. Prefer the specialized tools (`ubuntu_system_overview`, " +
      "`ubuntu_list_services`, `ubuntu_service_status`, `ubuntu_check_updates`, " +
      "`ubuntu_tail_log`); `ubuntu_run_command` is the escape hatch for anything they don't " +
      "cover. The state-changing tools (`ubuntu_manage_service`, `ubuntu_run_command` with " +
      "sudo, and `ubuntu_check_updates` with refresh_cache) require passwordless sudo on the " +
      "target host.",
  },
);

registerServerTools(server);
registerSystemTools(server);
registerServiceTools(server);
registerPackageTools(server);
registerLogTools(server);
registerCommandTools(server);

// Sanity-check the inventory at startup. A broken or missing servers.json is
// only a warning — the server still starts so the tools can return helpful
// error messages instead of the whole server dying.
try {
  const servers = loadServers();
  console.error(`ubuntu-mcp-server: loaded ${servers.length} server(s) from ${CONFIG_PATH}`);
} catch (error) {
  console.error(
    `ubuntu-mcp-server: WARNING — ${error instanceof Error ? error.message : String(error)}`,
  );
}

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
  console.error("ubuntu-mcp-server: ready (stdio)");
} catch (error) {
  // A failed transport bind/handshake should exit with a clean single-line
  // diagnostic on stderr (consistent with the logging above), not an uncaught
  // rejection stack trace. stdout stays untouched either way.
  console.error(
    `ubuntu-mcp-server: FATAL — could not start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
