/**
 * Smoke test: starts the built server as a real MCP client would (subprocess +
 * stdio), performs the protocol handshake, lists tools, and exercises the
 * paths that don't need a live SSH target.
 *
 * Run with: npm run smoke   (after npm run build)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value;
}
env.UBUNTU_MCP_CONFIG = path.join(root, "test", "servers.test.json");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "index.js")],
  env,
  stderr: "pipe",
});
const client = new Client({ name: "smoke-test", version: "1.0.0" });

let failures = 0;
function check(name, condition, extra = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition || !extra ? "" : ` — ${extra}`}`);
  if (!condition) failures += 1;
}

await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const expected = [
  "ubuntu_check_updates",
  "ubuntu_list_servers",
  "ubuntu_list_services",
  "ubuntu_manage_service",
  "ubuntu_run_command",
  "ubuntu_service_status",
  "ubuntu_system_overview",
  "ubuntu_tail_log",
];
check(
  "all 8 tools registered",
  JSON.stringify(names) === JSON.stringify(expected),
  `got: ${names.join(", ")}`,
);
for (const tool of tools) {
  check(`${tool.name} has a substantive description`, (tool.description ?? "").length > 100);
  check(`${tool.name} has annotations`, tool.annotations !== undefined);
}

const list = await client.callTool({ name: "ubuntu_list_servers", arguments: {} });
const listText = list.content?.[0]?.text ?? "";
check("list_servers is not an error", list.isError !== true, listText);
check("list_servers mentions the fixture server", listText.includes("test-box"), listText);
check("list_servers returns structuredContent", list.structuredContent?.count === 1);

const unknown = await client.callTool({
  name: "ubuntu_run_command",
  arguments: { server: "nope", command: "true" },
});
check("unknown server -> tool error (isError)", unknown.isError === true);
check(
  "unknown server error lists valid names",
  (unknown.content?.[0]?.text ?? "").includes("test-box"),
);

const badPath = await client.callTool({
  name: "ubuntu_tail_log",
  arguments: { server: "test-box", source: "file" },
});
check("file tail without path -> tool error", badPath.isError === true);
check(
  "file tail error explains the fix",
  (badPath.content?.[0]?.text ?? "").includes("path"),
);

const badGrep = await client.callTool({
  name: "ubuntu_tail_log",
  arguments: { server: "test-box", grep: "error\nwarn" },
});
check("multi-line grep pattern rejected", badGrep.isError === true);

// The SDK surfaces input-validation failures as tool-level errors (isError)
// with the Zod message, so the model can read the message and self-correct.
const badEnum = await client.callTool({
  name: "ubuntu_list_servers",
  arguments: { response_format: "yaml" },
});
check("invalid enum value rejected by Zod schema", badEnum.isError === true);
// Assert on the meaningful content (both allowed values are named) rather than
// exact punctuation — Zod's enum-error wording differs across major versions.
const badEnumText = badEnum.content?.[0]?.text ?? "";
check(
  "validation error names the expected values",
  badEnumText.includes("markdown") && badEnumText.includes("json"),
  badEnumText,
);

await client.close();
console.log(failures === 0 ? "\nAll smoke tests passed." : `\n${failures} smoke test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
