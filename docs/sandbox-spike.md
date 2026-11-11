# 148-T6 findings: sandbox spike (landlock vs bwrap)

2026-11-10, host Linux 7.1.4-204.fc44, landlock ABI 9 (`/sys/kernel/security/lsm` has it), bwrap 0.11.0
unprivileged, python 3.14, **no C compiler**. Probes: `probes/sandbox/landlock_probe.py` (10 expectations,
ctypes on the raw syscalls; run `python3 -I probes/sandbox/landlock_probe.py`) and
`probes/sandbox/bwrap_probe.sh` (12 expectations, throwaway repo + linked worktree; run
`bash probes/sandbox/bwrap_probe.sh`). Both ran green and are kept so the findings can be re-checked
after a kernel or bwrap update; neither touches toriel. Two bwrap checks failed on the first run
because my test tree sat under `/tmp`, which the jail masks - fixed in the script and noted there.
Caveat: B12 (network cut) would also pass on a host with no network; it is not a control test.

## Headline

1. **The premise in the ticket's sequencing note is false: landlock cannot grant a path to a live
   child.** `landlock_add_rule` on a ruleset after `restrict_self` changes nothing (B1), and a
   supervisor adding a rule to its ruleset fd while the child lives does nothing for the child
   (C1). Restrictions are self-imposed, monotonic (D1: a second `restrict_self` only narrows) and
   snapshotted at enforcement. So on the "runtime-approved outside write" criterion landlock and
   bwrap are **equal: neither can widen a running process.** The criterion does not pick a winner.
2. **Per-command sandboxing makes runtime grants free.** toriel already owns the bash tool
   (`pi/extensions/toriel-jobs.ts`); every command goes through one seam,
   `launch()` at line 108 (`spawn("bash", ["-c", command], ...)`). If the sandbox is applied *per
   command*, the policy is read fresh from the daemon at each launch, so an approved path is
   writable on the NEXT command with nothing restarted (bwrap B11; landlock E1 is the same thing,
   a fresh process confined with the path included). No session restart, no mid-flight widening.
3. **bwrap is the better fit for that seam.** It is a distro binary (`bubblewrap`, a doctor entry),
   needs no helper to write, and it does more than landlock for free: `--unshare-net` (B12), a
   read jail by simply not binding things (T7), and nested read-only binds to carve exceptions
   (B8/B9, below). Landlock from node needs a python (or prebuilt) launcher because there is no
   compiler and node cannot make the syscalls; that is a new doctor requirement and a new moving
   part. Landlock's real advantage (same path view, no mount namespace, no tmpfs surprises) is
   small next to that.

**Recommendation:** wrap the per-command bash spawn in bwrap, with the policy computed from the
scope root (worktree + git common dir pieces + node_modules target) plus daemon-held approved
paths. Keep the TORIEL_SCOPE_ROOT link as the wall for pi's own write/edit tools (the sandbox does
not cover those). Do not sandbox the whole pi child: it would reintroduce the restart-to-grant
cost and pull pi's own state dirs into the static roots.

## What each probe established

Landlock (write jail; reads unhandled):

- A1/A2/A6: write outside the root denied; a symlink in W pointing outside is denied (landlock
  decides on the resolved inode); rename out of W refused.
- A3/A4: the worktree layout's `node_modules -> <main checkout>/node_modules` symlink: writes
  through it are **denied** unless the target is a rule, and work once it is added. So `npm
  install` in a worktree needs the resolved target as a static root, exactly as the board note said.
- A5: an exec'd shell inherits the confinement (interpreters, `make`, `npm run`, `find -exec` are
  covered - the program-side residue phase 1 could not reach). It also showed a real requirement:
  `sh` itself failed because `/dev/null` was not writable. A write jail needs a few static write
  roots (`/dev/null`, `/dev/tty`, a tmp dir) or ordinary tools break.

bwrap (`--ro-bind / /` + `--bind W W`, per command):

- B1-B4: same confinement results as landlock, including the node_modules target needing a bind.
- B5-B7: `git status` works read-only; `git commit` in a linked worktree **needs the shared git
  dir partly writable**, and the minimal set that works is: `objects/`, the worktree's own gitdir
  (`.git/worktrees/<name>`), `refs/heads/`, `logs/`.
- B8-B10, the trap: binding the whole common dir read-write lets the agent plant
  `hooks/post-commit` or set `core.fsmonitor` in the shared `config`; those run **outside** the
  sandbox the next time you (or any tool) run git in the main checkout. With only the four
  subpaths above writable, hooks/ and config stay read-only. The same enumeration works in
  landlock (rules are additive allow-lists); bwrap can also do it as a nested `--ro-bind` over a
  broader bind. (Landlock enumeration was not separately probed; it follows from the additive
  semantics in A1/A4.)
- B11: runtime grant = next command. B12: network can be cut per command.

## Unenforced residue (stated plainly)

- pi's own process and its write/edit tools are not inside a per-command sandbox; they stay guarded
  by the scope link (a hard wall in deny mode, a prompt in ask mode, and a config allow still
  short-circuits it).
- MCP servers pi spawns are separate processes with their own tool surface; board 153 covers them.
- Background jobs get the grants that existed at launch; a later approval does not widen a job
  already running.
- A kernel or bwrap escape is out of scope; this stops an honest-but-wrong or prompt-injected
  agent, not a kernel exploit. `--die-with-parent` only (no seccomp) was probed.
- Reads are unrestricted in these probes (T7 is the read jail; the mount namespace makes it
  natural but it needs an allowlist, and a wrong one silently breaks tools).

## Open design decisions this surfaces

1. **/tmp - DECIDED (Ron, 2026-11-10).** A private tmpfs `/tmp` per command (as in the probe)
   breaks anything that passes files through /tmp between commands, e.g. the
   `/tmp/permissions.review.md` flow. Decision: keep `/tmp` private and bind one dedicated shared
   directory, `~/.local/share/toriel/shared`, read-write at the same path. The real /tmp was
   rejected: on the dev machine it holds live unix sockets (tmux, X11, ICE, Chrome, the login
   manager) that a sandboxed command could connect to, acting outside the sandbox.
2. **Static roots list**: `/dev/null`, `/dev/tty`, tmp, the package caches
   (`~/.npm`, `~/.cache`), and the shared node_modules target. Concrete list belongs in the
   implementation ticket, found by running real agent workloads under the wrapper.
3. **Where the policy lives:** the daemon computes it per spawn (scope root, git common dir pieces,
   approved paths) and passes it to the extension via env/socket; one pure module + unit tests.

## Not tested

- Inside a real toriel child (this was probes only): in particular connecting to `TORIEL_SOCK` and
  pi's own session-file writes from a sandboxed command (the latter should not happen, since pi
  stays outside).
- Real agent workloads (npm install, test suites, the doctor) under the wrapper.
- Landlock with ABI < 9 hosts; bwrap on hosts where unprivileged user namespaces are disabled
  (the doctor needs a check that runs `bwrap` once, not just `which bwrap`).

## Follow-ups to file

- Implement the bwrap per-command wrapper (pure policy module + tests, extension seam at
  `launch()`, doctor entry that actually executes bwrap, docs). Dormant-by-default behind a
  profile/setting until dogfooded with `toriel --isolated`.
- T7 read jail becomes "bind only the allowlist" on the same wrapper.
- Feed the git subpath set into the daemon-owned worktree tool (board 188).
