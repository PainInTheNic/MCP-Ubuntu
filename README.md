# ubuntu-mcp-server

An MCP server that lets Claude manage your Ubuntu machines over SSH — check health, inspect services, tail logs, review pending updates, and run commands, all from a Claude conversation.

This README doubles as a tutorial: it explains **where an MCP server runs**, **how this one is put together**, and **how to extend it** — so the next one you build takes an afternoon, not a weekend.

---

## 1. What is an MCP server, actually?

MCP (Model Context Protocol) is a standard way to give an AI client (Claude Code, Claude Desktop, etc.) extra abilities, called **tools**. The mental model:

```
┌──────────────────────── Your Windows PC ───────────────────────┐
│                                                                │
│  Claude Code  ── JSON-RPC over stdin/stdout ──►  this server   │
│  (MCP client)                                   (Node process) │
│                                                      │         │
└──────────────────────────────────────────────────────┼─────────┘
                                                       │ SSH (port 22)
                                     ┌─────────────────┼─────────────────┐
                                     ▼                 ▼                 ▼
                                  web-01             db-01            backup-01
                              (your Ubuntu servers — nothing installed on them)
```

Key facts that answer "where does this run?":

- **The MCP server runs on this PC.** Claude Code starts `node dist/index.js` as a child process automatically whenever you start a session, and stops it when you're done. You never launch it by hand.
- **They talk over stdin/stdout** ("stdio transport") using JSON-RPC messages. That's why the code only ever logs to *stderr* — a stray `console.log` would corrupt the protocol stream.
- **Your Ubuntu servers need nothing new.** The server reaches them with plain SSH key authentication, same as your terminal does.
- The conversation flow: you ask Claude something → Claude picks a tool and arguments → Claude Code asks *you* for permission (for non-read-only tools) → the tool runs over SSH → the result goes back into Claude's context → Claude answers you.

## 2. Quick start

### a. One-time SSH key setup (skip if `ssh you@server` already works without a password)

```bash
ssh-keygen -t ed25519
```

Then install the public key on each Ubuntu server (from PowerShell):

```bash
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh youruser@your-server "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

### b. Describe your servers

Copy `servers.example.json` to `servers.json` and fill in your machines:

```json
{
  "defaults": { "username": "youruser", "port": 22, "privateKeyPath": "~/.ssh/id_ed25519" },
  "servers": [
    { "name": "web-01", "host": "192.168.1.10", "description": "Main web server" },
    { "name": "db-01",  "host": "192.168.1.11", "username": "ubuntu", "description": "Database" }
  ]
}
```

Notes:
- `defaults` applies to every server; each entry can override `username`, `port`, `privateKeyPath`, or `fingerprint`.
- `servers.json` is git-ignored — your inventory stays on your machine.
- The file is re-read on every tool call, so you can add servers without restarting anything.
- Passwords are deliberately unsupported: key auth only. Keys with a passphrase work if the key is loaded in `ssh-agent`, or set the `UBUNTU_MCP_KEY_PASSPHRASE` environment variable.
- **Host-key verification** authenticates the *server* (not just you). By default the server remembers each host's key on first connection and refuses to connect if that key later changes (the tell-tale sign of a man-in-the-middle). To pin a key up front, add `"fingerprint": "SHA256:…"` to an entry — get the value with `ssh-keyscan your-server | ssh-keygen -lf -`. See §7.

### c. Build and register with Claude Code

```bash
npm install
```

```bash
npm run build
```

Register it (the `--scope user` flag makes it available in every project, not just this folder):

```bash
claude mcp add --scope user ubuntu -- node "C:\path\to\MCP-Ubuntu\dist\index.js"
```

Verify with `/mcp` inside a Claude Code session — you should see `ubuntu` connected with 8 tools.

### d. Use it

Just talk to Claude:

- *"How is web-01 doing?"* → `ubuntu_system_overview`
- *"Is anything failing on db-01?"* → `ubuntu_list_services` with `state=failed`
- *"Show me nginx errors from the last hour on web-01"* → `ubuntu_tail_log`
- *"Any security updates pending across my servers?"* → `ubuntu_check_updates` per server
- *"Restart nginx on web-01"* → `ubuntu_manage_service` (Claude Code will ask your permission first)

## 3. The tools

| Tool | What it does | Mutates? |
|---|---|---|
| `ubuntu_list_servers` | Lists the inventory from servers.json (no SSH) | no |
| `ubuntu_system_overview` | Hostname, OS, kernel, uptime, load, memory, disk, reboot-required, failed units — one SSH round trip | no |
| `ubuntu_list_services` | systemd services, filterable by `running`/`failed`, paginated | no |
| `ubuntu_service_status` | Full `systemctl status` + enabled state for one service | no |
| `ubuntu_manage_service` | start/stop/restart/reload/enable/disable via `sudo -n` | **yes** |
| `ubuntu_check_updates` | Pending apt updates, security flags, reboot-required | no* |
| `ubuntu_tail_log` | journalctl or file tail, with `since`/`grep` filters | no |
| `ubuntu_run_command` | Arbitrary shell command — the escape hatch | **can** |

\* `refresh_cache=true` runs `apt-get update` first (metadata only, needs passwordless sudo). Because of that optional refresh the tool is annotated `readOnlyHint: false`, so a client may prompt for it even in the default `refresh_cache=false` case, which really is read-only.

Anything that uses `sudo` runs it as `sudo -n` (never prompt): if the server doesn't allow passwordless sudo, the tool fails fast with an explanation instead of hanging forever waiting for a password nobody can type.

## 4. Reading the code (suggested order)

1. **`src/index.ts`** — the whole MCP lifecycle in ~40 lines: create an `McpServer`, register tools, connect a stdio transport. Everything else is plumbing for the tools.
2. **`src/config.ts`** — loads `servers.json` and validates it with [Zod](https://zod.dev). Zod is the pattern to internalize: you declare the shape once and get runtime validation *and* TypeScript types from it.
3. **`src/format.ts`** — small but load-bearing: response helpers (`ok`/`fail`), the 25k-character truncation cap (protects Claude's context from a 10MB log), and `shellQuote` (the injection defense).
4. **`src/ssh.ts`** — one cached SSH connection per server, lazy connect, a single retry on stale connections, hard timeouts, and error messages rewritten to say *what to fix* ("is sshd running?", "check authorized_keys") rather than raw socket errors.
5. **`src/tools/*.ts`** — one file per domain. Each follows the same recipe, which is 90% of what "writing an MCP server" means day-to-day.

### Anatomy of one tool (the recipe)

```ts
server.registerTool(
  "ubuntu_service_status",              // 1. name: {service}_{action}_{resource}, snake_case
  {
    title: "Service Status",            // 2. human-facing label
    description: `...`,                 //3. THE MOST IMPORTANT PART — this is Claude's
                                        //   only manual for the tool: args, returns,
                                        //   examples, error behavior
    inputSchema: {                      // 4. Zod shape — validated before your code runs
      server: z.string().min(1).describe("..."),
      service: UnitName,                //    invalid input never reaches the handler
    },
    outputSchema: {                     // 5. shape of `structuredContent` you return —
      server: z.string(),               //    lets clients validate/type the machine-
      active_state: z.string(),         //    readable output. REQUIRED if you return
      enabled_state: z.string(),        //    structuredContent, and the SDK validates
      status: z.string(),               //    every result against it at runtime.
    },
    annotations: {                      // 6. behavior hints for the client:
      readOnlyHint: true,               //    read-only tools can be auto-approved;
      destructiveHint: false,           //    destructive ones always prompt
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ server, service }) => {      // 7. handler: typed, validated args in →
    try {                               //    CallToolResult out
      ...
      return ok(markdownText, structuredData);  // structuredData MUST match outputSchema
    } catch (error) {
      return fail(errMessage(error));   // 8. errors are RESULTS (isError: true), not
    }                                   //    crashes — Claude reads them and adapts
  },
);
```

Design choices worth copying into future servers:

- **Batch round trips.** `ubuntu_system_overview` runs nine commands in one SSH exec with `===SECTION:x===` markers and splits the output, instead of nine tool calls.
- **Errors teach.** "Unknown server 'web1'. Configured servers: web-01, db-01" lets Claude fix its own mistake without asking you.
- **Validate + quote everything.** Unit names and paths pass a strict regex *and* get single-quote shell escaping. `run_command` is intentionally open — that's what the destructive annotation and permission prompt are for.
- **Two output shapes.** Human-readable text plus `structuredContent` (machine-readable JSON) in the same response — and every tool that returns `structuredContent` declares a matching `outputSchema` so clients can validate it.

## 5. Adding a new tool (10-minute recipe)

Say you want `ubuntu_disk_hogs` — biggest directories under a path:

1. Pick the file (`src/tools/system.ts`) or create a new one.
2. Define the input shape:
   ```ts
   const InputShape = {
     server: z.string().min(1).describe("Server name from the inventory"),
     path: z.string().regex(/^\/[^\n\r\0]*$/).default("/").describe("Directory to analyze"),
     top: z.number().int().min(1).max(50).default(10),
   };
   ```
3. Register it: build the command with `shellQuote(path)`, run `execOnServer`, format with `ok()`/`fail()`.
   ```ts
   const result = await execOnServer(target, `du -xh --max-depth=2 ${shellQuote(path)} 2>/dev/null | sort -rh | head -n ${top}`, { timeoutMs: 60_000 });
   ```
4. If you created a new file, add its `register...` call in `src/index.ts`.
5. `npm run build`, then restart the Claude Code session (it launches the new build). Add a check to `test/smoke.mjs` if the tool has SSH-free paths.

## 6. Testing

- **`npm run smoke`** — starts the built server exactly like Claude Code does (subprocess + stdio), performs the MCP handshake, and checks all tools, error paths, and schema validation. No real Ubuntu server needed.
- **MCP Inspector** — a browser UI to poke tools by hand, great for learning:
  ```bash
  npx @modelcontextprotocol/inspector node dist/index.js
  ```

## 7. Security model

- Runs locally with your permissions; nothing listens on any network port.
- SSH key auth only — the code has no concept of a password and stores no secrets. Inventory (`servers.json`) is git-ignored.
- **The server's host key is verified on every connection**, so a spoofed host (IP/DNS redirection) can't impersonate one of your machines and harvest the privileged `sudo -n` commands the tools run. Policy is set by `UBUNTU_MCP_HOST_KEY_CHECKING`:
  - `tofu` *(default)* — trust-on-first-use: the key is remembered in a `.host-keys.json` store next to `servers.json`, and a **changed** key afterwards is refused.
  - `strict` — refuse any host that isn't already pinned (via `fingerprint` in `servers.json`) or remembered.
  - `off` — accept any host key (the old, unauthenticated behaviour).
  A per-server `fingerprint` pin always wins over the store and is never auto-learned. The store path can be overridden with `UBUNTU_MCP_HOST_KEYS`.
- Every model-supplied value is Zod-validated and shell-quoted before touching a command line; names/paths also can't start with `-` (option-injection).
- `sudo -n` never prompts — it fails with instructions instead of hanging.
- Composed commands run under `bash -c` with `LC_ALL=C` (immune to the remote user's shell and locale), and exit-code markers embedded in remote output carry a per-call random nonce so log content can't forge them.
- Retries after connection failures happen only when the command provably never started — a mid-command drop is reported as a connection loss, never as a "successful" partial result, and never silently re-run.
- Mutating tools are annotated so Claude Code shows you a permission prompt before they run; output is capped at 25k characters so a runaway command can't flood the model.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `/mcp` shows the server as failed | Run `node dist\index.js` manually — startup errors print to stderr. Usually a missing `npm run build`. |
| "No server inventory found" | Copy `servers.example.json` → `servers.json` (next to `package.json`). |
| "SSH authentication failed" | Does `ssh user@host` work in PowerShell? If your key has a passphrase, load it into ssh-agent or set `UBUNTU_MCP_KEY_PASSPHRASE`. |
| "sudo: a password is required" | Grant passwordless sudo on the server: `echo 'user ALL=(ALL) NOPASSWD:ALL' \| sudo tee /etc/sudoers.d/user` — or skip sudo. |
| "REMOTE HOST KEY CHANGED" | The server's SSH key differs from the one remembered in `.host-keys.json`. If you rebuilt/reinstalled the host, delete its entry there (or update `fingerprint` in `servers.json`) and reconnect. If you didn't, investigate — it can indicate a man-in-the-middle. |
| Tool changes not showing up | Rebuild (`npm run build`) **and** restart the Claude Code session — the old process keeps running until then. |
| Connection timed out | Host/port right? VPN up? Firewall allows 22? |
