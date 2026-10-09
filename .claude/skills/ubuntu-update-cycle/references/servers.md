# Server inventory and per-host verification

These four (three at home, plus Rex-PostgreSQL in the camper) are configured in
`servers.json` for the ubuntu-mcp-server; use
`ubuntu_list_servers` if you need to confirm this is still current rather than trusting
this file blindly — inventories can change.

Passwordless sudo is `ALL=(ALL) NOPASSWD: ALL` on all four (set up on the home hosts after the OpenClaw
decommission in August 2026 — see the `postgresql-server-state` and
`ubuntu-mcp-server-project` memory files for that history). `ubuntu_run_command` with
`sudo: true` works broadly; you don't need to work around scoped sudo restrictions.

SSH host-key verification is TOFU (trust-on-first-use) via the MCP server's own
hardening. If a connection is ever refused with a "host key changed" style error,
that is a real signal worth surfacing to Nic, not a transient glitch to retry past.

## Out of scope: Kitchen Sales Production VM

The Production VM for Nic's Kitchen Sales side gig is **never** part of this cycle — no
update checks, installs, reboots, or Change Management docs. It has its own automated
update and change-management processes. If it ever appears in `ubuntu_list_servers`,
skip it and note the skip in the report.

## Rex-PostgreSQL — 100.93.156.59 (user: postgresql) — remote, over Tailscale

- **Role:** the camper's PostgreSQL 18 database (`postgresql@18-main`, port 5432),
  serving its own `homeassistant` database for Rex's Home Assistant. It's live data, so
  give it the same scrutiny as the home PostgreSQL host.
- **Where:** a VM on rex-truenas, listed there by `truenas_list_vms` as `PostgreSQL`
  (the other VM, `HomeAssistant`, isn't this host). Ubuntu 26.04, unlike the home hosts'
  24.04, so Plex isn't a canary for its packages. Reached **only** by its tailnet IP over
  a cellular link. It fails whenever this Mac is off the tailnet. Follow the
  "Remote host: Rex-PostgreSQL" rules in `SKILL.md`: longer waits, a detached install,
  and Tailscale link recovery.
- **Sudo:** the same as the home hosts (`/etc/sudoers.d/ubuntu-mcp-server`,
  `NOPASSWD: ALL`, added 2026-10-09). An older scoped rule file, `postgresql-updates`,
  is still there and is redundant.
- **SSH:** host key pinned in `servers.json` (ED25519
  `SHA256:vTsWSrpeuH7O8Ojkgnbmba5ub3GTmW7NU0ErCmM6zD4`). The MCP key only works from
  this Mac's tailnet IP (`from="100.68.23.53"`). Its hostname is also `PostgreSQL`, so
  identify it by the server name, not `hostname`.
- **Boot time:** slowest of the four. The VM boots, then Tailscale on it has to reconnect
  over cellular before SSH answers. No network mounts.
- **PG18 is correct here.** Unlike the home host, PG18 packages in an update check are
  expected.
- **Key service check:**
  ```bash
  systemctl is-active postgresql@18-main
  pg_isready
  sudo -u postgres psql -d homeassistant -tAc \
    "select 'OK, tables='||count(*) from information_schema.tables where table_schema='public';"
  ```
  The baseline is **13 tables** (as of 2026-10-09). As at home, what matters is
  consistency: if the count drops sharply or the query errors, stop and investigate.

## Plex — 192.168.0.60 (user: plex)

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
