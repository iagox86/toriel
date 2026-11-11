#!/bin/bash
# 148-T6 bwrap probes (per-command write jail) on a throwaway repo + linked worktree.
# Prints PASS/FAIL against expectations we are testing. Run: bash bwrap_probe.sh
set -u
# NOT under /tmp: the jail masks /tmp with a tmpfs, which would hide the repo (an earlier draft
# failed B5 and passed B6/B8/B9 for exactly that reason)
BASE=${CLAUDE_JOB_DIR:-$HOME/.cache}/tmp; mkdir -p "$BASE"
T=$(mktemp -d "$BASE/bw-probe-XXXXXX")
R=$T/repo; W=$T/repo-worktrees/feat; O=$T/outside; M=$R/node_modules
mkdir -p "$R" "$O" "$T/repo-worktrees"
git -C "$R" init -q -b main
git -C "$R" config user.email t@t; git -C "$R" config user.name t
echo a > "$R/a"; mkdir -p "$M"; git -C "$R" add a; git -C "$R" commit -qm init
git -C "$R" worktree add -q -b feat "$W"
ln -s "$M" "$W/node_modules"            # worktree layout: node_modules -> shared checkout
G=$R/.git                                # common dir

pass=0; fail=0
check() { # name expected(0|1) cmd...  (expected = whether cmd should succeed)
  local name=$1 want=$2; shift 2
  "$@" >/dev/null 2>&1; local rc=$?
  if { [ "$want" = 1 ] && [ $rc -eq 0 ]; } || { [ "$want" = 0 ] && [ $rc -ne 0 ]; }; then echo "PASS  $name"; pass=$((pass+1)); else echo "FAIL  $name (rc=$rc)"; fail=$((fail+1)); fi
}

base=(bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --die-with-parent)
jail() { "${base[@]}" --bind "$W" "$W" "$@"; }

# 1: minimal jail, W only
check "B1 write inside W works"                       1 jail bash -c "echo x > $W/ok"
check "B2 write outside W is denied (read-only fs)"   0 jail bash -c "echo x > $O/no"
check "B3 write through W/node_modules -> M denied unless M bound" 0 jail bash -c "echo x > $W/node_modules/pkg"
check "B4 with M bound rw, the node_modules write works" 1 jail --bind "$M" "$M" bash -c "echo x > $W/node_modules/pkg"

# 2: git in the worktree
check "B5 git status in the worktree (read) works with .git read-only (ro root)" 1 jail bash -c "cd $W && git status"
check "B6 git commit in the worktree FAILS when the common dir is read-only"     0 jail bash -c "cd $W && echo y > f && git add f && git commit -qm c"
wt=$(basename "$(git -C "$W" rev-parse --git-dir)")
GD=$(git -C "$W" rev-parse --git-dir)
# minimal write set for commit: objects, this worktree's gitdir, the branch ref + logs, packed-refs
refs="$G/refs/heads"; logs="$G/logs"
jail_git=(jail --bind "$G/objects" "$G/objects" --bind "$GD" "$GD" --bind "$refs" "$refs" --bind "$logs" "$logs")
check "B7 git commit works with ONLY objects/, the worktree gitdir, refs/heads and logs/ writable" 1 "${jail_git[@]}" bash -c "cd $W && echo y > f && git add f && git commit -qm c"
check "B8 ...and the shared hooks/ dir stays unwritable (no planted hook)" 0 "${jail_git[@]}" bash -c "echo '#!/bin/sh' > $G/hooks/post-commit"
check "B9 ...and the shared config stays unwritable (no core.fsmonitor / aliases planted)" 0 "${jail_git[@]}" bash -c "git config -f $G/config core.fsmonitor 'touch $O/pwned'"
# the trap: a naive whole-.git rw bind
check "B10 TRAP: binding the whole common dir rw lets a hook be planted (host-side escape)" 1 jail --bind "$G" "$G" bash -c "echo '#!/bin/sh' > $G/hooks/post-commit"

# 3: runtime grant = next invocation (per-command sandbox)
check "B11 an approved extra path is writable on the NEXT command with no restart of anything" 1 jail --bind "$O" "$O" bash -c "echo x > $O/granted"

# 4: network is separable
check "B12 --unshare-net blocks the network for the command" 0 jail --unshare-net bash -c "exec 3<>/dev/tcp/1.1.1.1/53"

echo; echo "$pass passed, $fail failed"; echo "tmp: $T"
[ $fail -eq 0 ]
