#!/usr/bin/env python3
"""148-T6 landlock probes (write jail). Pure ctypes, no compiler needed.

Each scenario prints PASS/FAIL against an expectation we are testing, not
against what we hope: the point is to find out what landlock does.
Run: python3 -I landlock_probe.py
"""
import ctypes
import errno
import os
import shutil
import struct
import sys
import tempfile

libc = ctypes.CDLL(None, use_errno=True)
SYS_create, SYS_add, SYS_restrict = 444, 445, 446
PR_SET_NO_NEW_PRIVS = 38

A = dict(EXECUTE=1 << 0, WRITE_FILE=1 << 1, READ_FILE=1 << 2, READ_DIR=1 << 3, REMOVE_DIR=1 << 4,
         REMOVE_FILE=1 << 5, MAKE_CHAR=1 << 6, MAKE_DIR=1 << 7, MAKE_REG=1 << 8, MAKE_SOCK=1 << 9,
         MAKE_FIFO=1 << 10, MAKE_BLOCK=1 << 11, MAKE_SYM=1 << 12, REFER=1 << 13, TRUNCATE=1 << 14)


def sc(n, *args):
    r = libc.syscall(n, *args)
    if r < 0:
        e = ctypes.get_errno()
        raise OSError(e, os.strerror(e))
    return r


def abi():
    return sc(SYS_create, None, 0, 1)  # LANDLOCK_CREATE_RULESET_VERSION


def write_mask(v):
    m = sum(A[k] for k in ("WRITE_FILE", "REMOVE_DIR", "REMOVE_FILE", "MAKE_CHAR", "MAKE_DIR", "MAKE_REG",
                           "MAKE_SOCK", "MAKE_FIFO", "MAKE_BLOCK", "MAKE_SYM"))
    if v >= 2:
        m |= A["REFER"]
    if v >= 3:
        m |= A["TRUNCATE"]
    return m


def new_ruleset(handled):
    attr = struct.pack("Q", handled)
    return sc(SYS_create, attr, len(attr), 0)


def add_path(rs, path, access):
    fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
    try:
        attr = struct.pack("=Qi", access, fd)  # packed: 12 bytes
        sc(SYS_add, rs, 1, attr, 0)  # LANDLOCK_RULE_PATH_BENEATH
    finally:
        os.close(fd)


def restrict(rs):
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(NO_NEW_PRIVS)")
    sc(SYS_restrict, rs, 0)


def can_write(path):
    try:
        with open(path, "w") as f:
            f.write("x")
        return True
    except OSError as e:
        if e.errno in (errno.EACCES, errno.EPERM):
            return False
        raise


def in_child(fn):
    """Run fn in a forked child; return its (exit code)."""
    pid = os.fork()
    if pid == 0:
        try:
            os._exit(0 if fn() else 1)
        except BaseException as e:  # noqa
            print("child error:", repr(e), file=sys.stderr)
            os._exit(2)
    _, st = os.waitpid(pid, 0)
    return os.WEXITSTATUS(st)


results = []
sys.stdout.reconfigure(line_buffering=True)


def check(name, ok, note=""):
    results.append((name, ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{note}]" if note else ""))


def main():
    v = abi()
    print(f"landlock ABI version: {v}")
    handled = write_mask(v)
    base = tempfile.mkdtemp(prefix="ll-probe-")
    W, O, M = (os.path.join(base, d) for d in ("W", "O", "M"))
    for d in (W, O, M):
        os.mkdir(d)
    os.symlink(O, os.path.join(W, "escape-link"))      # symlink out of W
    os.symlink(M, os.path.join(W, "node_modules"))      # worktree-style node_modules -> shared checkout
    print("base:", base)

    # --- A: confinement basics -------------------------------------------------
    def a():
        rs = new_ruleset(handled)
        add_path(rs, W, handled)
        restrict(rs)
        return (can_write(os.path.join(W, "ok")) and not can_write(os.path.join(O, "no")))
    check("A1 write inside W allowed, outside W denied", in_child(a) == 0)

    def a2():
        rs = new_ruleset(handled)
        add_path(rs, W, handled)
        restrict(rs)
        return not can_write(os.path.join(W, "escape-link", "via-symlink"))
    check("A2 write through a symlink in W that points outside is denied", in_child(a2) == 0)

    def a3():
        rs = new_ruleset(handled)
        add_path(rs, W, handled)
        restrict(rs)
        return not can_write(os.path.join(W, "node_modules", "pkg"))
    check("A3 write through W/node_modules -> M is DENIED unless M is a rule (npm install would fail)", in_child(a3) == 0)

    def a4():
        rs = new_ruleset(handled)
        add_path(rs, W, handled)
        add_path(rs, M, handled)  # M as a static root
        restrict(rs)
        return can_write(os.path.join(W, "node_modules", "pkg")) and not can_write(os.path.join(O, "no"))
    check("A4 with M added as a static root, the node_modules write works and O stays denied", in_child(a4) == 0)

    def a5():
        rs = new_ruleset(handled)
        add_path(rs, W, handled)
        add_path(rs, "/dev/null", A["WRITE_FILE"] | (A["TRUNCATE"] if v >= 3 else 0))  # sh itself needs it: a real static root
        restrict(rs)
        # a program the child execs inherits the domain
        rc = os.system(f"sh -c 'echo x > {O}/via-sh' 2>/dev/null")
        rc2 = os.system(f"sh -c 'echo x > {W}/via-sh' 2>/dev/null")
        return rc != 0 and rc2 == 0
    check("A5 an exec'd shell inherits the confinement (interpreters, make, npm run are covered)", in_child(a5) == 0)

    def a6():
        rs = new_ruleset(handled)
        add_path(rs, W, handled)
        restrict(rs)
        src = os.path.join(W, "mv-src")
        open(src, "w").close()
        try:
            os.rename(src, os.path.join(O, "mv-dst"))
            return False
        except OSError as e:
            return e.errno in (errno.EXDEV, errno.EACCES)
    check("A6 rename out of W is refused", in_child(a6) == 0)

    # --- B: can a running domain be widened? -----------------------------------
    def b1():
        rs = new_ruleset(handled)
        add_path(rs, W, handled)
        restrict(rs)
        add_path(rs, O, handled)  # add to the ruleset AFTER enforcement
        return not can_write(os.path.join(O, "late"))
    check("B1 adding a rule to the ruleset fd AFTER restrict_self does NOT widen the enforced domain", in_child(b1) == 0)

    # --- C: parent holds the ruleset, child restricts, parent adds later -------
    r_ready, w_ready = os.pipe()
    r_go, w_go = os.pipe()
    r_res, w_res = os.pipe()
    rs = new_ruleset(handled)
    add_path(rs, W, handled)
    pid = os.fork()
    if pid == 0:
        os.close(r_ready); os.close(w_go); os.close(r_res)
        restrict(rs)                      # child enforces the (shared) ruleset on itself
        os.write(w_ready, b"1")
        os.read(r_go, 1)                  # wait for the parent to add a rule
        os.write(w_res, b"1" if can_write(os.path.join(O, "late-c")) else b"0")
        os._exit(0)
    os.close(w_ready); os.close(r_go); os.close(w_res)
    os.read(r_ready, 1)
    add_path(rs, O, handled)              # supervisor adds an approved path while the child lives
    os.write(w_go, b"1")
    got = os.read(r_res, 1)
    os.waitpid(pid, 0)
    check("C1 a supervisor adding a rule to its ruleset fd while the child lives does NOT grant the child access", got == b"0",
          "the T6 sequencing note's 'incremental landlock_add_rule' premise")

    # --- D: monotonic: a confined process can only narrow ----------------------
    def d1():
        rs1 = new_ruleset(handled)
        add_path(rs1, W, handled)
        add_path(rs1, O, handled)
        restrict(rs1)
        rs2 = new_ruleset(handled)
        add_path(rs2, W, handled)
        restrict(rs2)  # stack a narrower layer
        return can_write(os.path.join(W, "n")) and not can_write(os.path.join(O, "n"))
    check("D1 a second restrict_self narrows (layers intersect); cannot widen", in_child(d1) == 0)

    # --- E: restart-with-wider-scope model -------------------------------------
    def e1():
        rs = new_ruleset(handled)
        add_path(rs, W, handled)
        add_path(rs, O, handled)  # a NEW child process started with the approved path already in its set
        restrict(rs)
        return can_write(os.path.join(O, "fresh"))
    check("E1 a freshly started child confined with the approved path included can write it (grant = restart)", in_child(e1) == 0)

    bad = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(bad)}/{len(results)} expectations held")
    shutil.rmtree(base, ignore_errors=True)
    sys.exit(1 if bad else 0)


main()
