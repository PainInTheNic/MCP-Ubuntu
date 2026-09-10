# Lessons learned — the incidents behind each rule

Read this if a situation comes up that the main SKILL.md doesn't obviously cover. The
rules in the main file are there because one of these actually happened, not because
they sounded like good general practice in the abstract — knowing the incident behind
a rule usually makes it obvious how to handle a variant of it.

## "Kept back" packages and the wasted reboot

During a kernel security update, `apt-get upgrade` reported success but silently
listed the actual kernel packages (`linux-generic`, `linux-image-generic`,
`linux-headers-generic`, `linux-firmware`) under "The following packages have been
kept back" — plain `upgrade` refuses to pull in packages that require installing new
dependencies, which a kernel transition often does. A reboot had already been
scheduled based on the (wrong) assumption that the upgrade had actually applied the
new kernel. It rebooted into the *same* kernel — a fully wasted cycle, caught only by
checking `uname -r` after the host came back. The fix was `apt-get dist-upgrade`,
which handles the dependency change correctly, followed by a second, real reboot.
Lesson generalized: **always use `dist-upgrade`, never plain `upgrade`**, and always
confirm the *actual* installed version/kernel after the fact rather than trusting the
apt log alone.

## Phased updates aren't a problem to route around blindly

Twice now (a krb5 point release, and a later batch of `base-files`/apt-tooling
packages), `dist-upgrade` reported `0 upgraded ... N deferred due to phasing` — Ubuntu
holding a non-security update back from this machine's rollout cohort. Overriding it
with `Always-Include-Phased-Updates=true` was the right call both times: these were
low-risk library/tooling bumps, and there's no real reason to wait a few extra days
for a phased rollout to reach these specific machines when the update has already
proven safe enough to publish. The judgment call is on *how risky the specific
package is*, not "phasing exists, therefore always override it" — if something with
real behavioral risk ever gets held back by phasing, that's worth flagging to Nic
rather than assuming the same default applies.

## Change-doc sequence numbers: never assume you're first

A fleet-update doc was created as `-001` without checking the folder first. It was
actually `-003` — another automated process (a Grafana update) had already filed
`-001` earlier that same day, and something else had filed `-002`. Nic caught it and
had to point it out. The underlying mistake wasn't carelessness so much as an
implicit assumption that this session's work is the only thing touching that folder
on a given day — it isn't. Multiple processes and Nic himself file into the same
Change Management folder. The fix generalizes beyond just "check first": **any shared
resource that other actors write to needs a fresh read before you write your own
entry**, not just this specific Drive folder.

A secondary wrinkle: Drive's `title contains '2026.08.20'` search (dotted date) proved
unreliable and can miss real documents. A `createdTime`-range query is more trustworthy
for figuring out what already exists for a given day.

## An apt lock isn't the same as "no updates"

A post-reboot recheck on PostgreSQL returned `total: 0` but carried a
`refresh_warning` — the apt lock was held by a concurrent `unattended-upgrades` run
(entirely plausible right after a fresh boot). A "0 pending" result that came with a
warning about a failed cache refresh isn't actually a confirmed clean result; it might
just be reporting stale, pre-existing cache state. Retrying once, after the lock
cleared, gave a genuinely clean confirmation. Generalized: **treat any `refresh_warning`
as "this result is unverified," not as "this result is probably fine."**

## When you genuinely can't find what the user is describing, say so and ask

Nic once asked to install "several more updates" when a thorough check (apt refresh,
snap, even a `dist-upgrade` dry-run) found nothing pending anywhere on the three
servers. Rather than guess and start pushing changes to an unrelated system (UniFi
network gear was a live possibility, and firmware-updating network infrastructure on
a guess carries real connectivity risk), the right move was to report the discrepancy
plainly and ask which system he actually meant. It turned out to be a stale dashboard
on his end — nothing to fix. **A confident, thorough "I checked and found nothing" is
a completely valid outcome of this skill**, and it's better to surface a mismatch
between what Nic expects and what you find than to quietly expand scope to a system
you haven't been asked to touch.

## Full-parallel execution is a real trade-off, not a free speedup

When explicitly asked to run all three servers in parallel to save time, the update
class that round (glibc + Python security patches) was judged safe enough for it —
Canonical's most heavily pre-tested package class, already risk-assessed in prior
canary-first rounds. But it was still called out explicitly, both to Nic in the
response and in the change doc's risk section, that skipping the staged rollout meant
a bad update would have hit all three simultaneously rather than being caught on Plex
alone first. The point isn't that parallel execution is dangerous — it's that the
choice should be visible and deliberate each time, not something that quietly becomes
the new default just because it worked once.
