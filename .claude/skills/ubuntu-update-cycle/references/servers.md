# Server inventory and per-host verification

These three are configured in `servers.json` for the ubuntu-mcp-server; use
`ubuntu_list_servers` if you need to confirm this is still current rather than trusting
this file blindly — inventories can change.

Passwordless sudo is `ALL=(ALL) NOPASSWD: ALL` on all three (set up after the OpenClaw
decommission in August 2026 — see the `postgresql-server-state` and
`ubuntu-mcp-server-project` memory files for that history). `ubuntu_run_command` with
`sudo: true` works broadly; you don't need to work around scoped sudo restrictions.

SSH host-key verification is TOFU (trust-on-first-use) via the MCP server's own
hardening. If a connection is ever refused with a "host key changed" style error,
that is a real signal worth surfacing to Nic, not a transient glitch to retry past.

## Plex — 192.168.0.61 (user: plex)

- **Role:** Plex Media Server. Lowest blast radius of the three — use as the canary.
- **Boot time:** slower than Portal. Mounts two CIFS shares at boot (`/plex` from
  TrueNAS `.253`, `/plex_unas` from the UNAS `.5`) — expect several connection
  retries before SSH answers after a reboot.
- **Key service check:**
  ```bash
  systemctl is-active plexmediaserver
  mount | grep -cE ' /plex | /plex_unas '   # expect 2
  ```

## Portal — 192.168.0.116 (user: portal)

- **Role:** Apache web server.
- **Boot time:** fastest of the three — no network-mounted storage, comes back first
  after a reboot.
- **Key service check:**
  ```bash
  systemctl is-active apache2
  ```

## PostgreSQL — 192.168.0.134 (user: postgresql)

- **Role:** Production PostgreSQL 16 database (`postgresql@16-main`, port 5432),
  serving the `homeassistant` database. This is the highest-stakes host of the three —
  give it the most scrutiny after any change.
- **Boot time:** moderate. The live data directory is on **local disk** (a good thing —
  it moved off CIFS at some point); only `/PostgreSQL_Backups` is a network mount.
- **PG16 only, deliberately** — PG18 binaries were installed alongside it at one point
  (pulled in automatically by the `postgresql` meta-package) but were never actually
  used and were removed in August 2026. If PG18 packages show up again in an update
  check, something re-added that meta-package — worth a note to Nic rather than
  silently reinstalling PG18 alongside 16.
- `alf_memory` (a former vector database used by a since-decommissioned tool called
  OpenClaw) no longer exists. Don't expect to find it; its absence is expected, not a
  problem.
- **Key service check:**
  ```bash
  systemctl is-active postgresql@16-main
  pg_isready
  sudo -u postgres psql -d homeassistant -tAc \
    "select 'OK, tables='||count(*) from information_schema.tables where table_schema='public';"
  ```
  Baseline is **13 tables**. This exact count matters less than *consistency* — if it
  drops sharply or the query errors outright, stop and investigate before treating the
  round as a success. A `needrestart` triggered by `libc6`/library updates will often
  restart `postgresql@16-main` live; that's expected and not itself a problem as long
  as this check passes afterward.
