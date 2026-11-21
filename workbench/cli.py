"""wb: hand a coding task to a local model, review it, accept or discard it.

Every command prints a short, plain report: it is read by Claude, whose tokens are the scarce
resource, and by a person at a terminal.
"""
import argparse
import fnmatch
import functools
import io
import json
import math
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
from collections import defaultdict
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse

from . import (__version__, ask_mcp, audio, bench, chat, context, gitops, hardware, images, lane, lessons,
               media, models, optimize, progress, results, router, savings, scan, skills, spend, stats, store,
               transcript, tuning, verify, webpush)
from .watch import Watcher, wait_exit
from . import runner
from .runner import PKG_ROOT

PROTOCOL = """

---
How to work (workbench protocol):
- You are in a git worktree on branch {branch}. Git is read-only for you; leave the changes
  uncommitted. Claude commits, pushes and deploys.
{test_line}- If the spec is genuinely ambiguous, you may call the `ask_reviewer` tool ({budget} \
question(s) for this task). Otherwise make reasonable choices and say what you assumed.
- Stay inside the scope of the spec. No unrelated refactors, no new dependencies unless asked.
- You can write only in this worktree, the temp directory and build caches: "Permission denied"
  anywhere else is that limit, so don't probe it. Need a directory outside? Call `ask_reviewer`
  with `path` set to it (this doesn't use the question budget).
- CLAUDE.md and AGENTS.md are Claude's, and you can't edit them. When the task asks for a change
  to one, write the whole new file next to it as `<name>.proposed` (`CLAUDE.md.proposed`); Claude
  reads the difference and takes it.
- Finish with a short summary: the files you changed, the test result, and any assumptions.
  If you hit something the next agent would trip on too (a library's quirk, a pitfall, a check
  worth running), add a line `Lesson: <the rule, and why>` to it.
"""


def test_line(test: str | None) -> str:
    """The protocol's acceptance line (bench.TEST_LINE reads it back for a task from before status
    `step_tests`, #941). It names the command and
    keeps the agent to it: two agents in a row ran the whole suite for half an hour after theirs
    passed (2026-11-18, #127), and the runner runs the command after each round anyway."""
    return (f"- The acceptance command is `{test}`. Run it before you finish and make it pass. "
            "Never weaken, skip or delete tests to get there. Don't run the whole suite unless the "
            "spec asks: it can outlast your round, and Claude runs it at review.\n") if test else ""



def die(msg: str, code: int = 1):
    print(f"wb: {msg}", file=sys.stderr)
    sys.exit(code)


def read_text(src: str, what: str) -> str:
    """A spec or message: the file `src`, or stdin for "-", as strict UTF-8. A Latin-1 or CP1252
    file raised a traceback, and piped from a C-locale shell (stdin's surrogateescape) passed every
    check and died writing prompt.md, leaving a task with no status that only discard cleared
    (#873, Claude's audit of 1.90.24)."""
    if src == "-" and not hasattr(sys.stdin, "buffer"):  # already text (a StringIO)
        return sys.stdin.read()
    data = sys.stdin.buffer.read() if src == "-" else Path(src).read_bytes()
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as e:
        die(f"{'stdin' if src == '-' else src}: {what} isn't UTF-8 (byte {e.start}): save it as UTF-8")


def need(name: str) -> store.Task:
    """The task a command names, by its name exactly. 'foo/', './foo' (or 'Foo' on macOS) opened
    tasks/foo too, but the runner's command line says 'foo': its live runner read as dead, so
    reap failed the task under a notice no reader takes, and discard removed the worktree under
    the agent (#782)."""
    if not store.NAME_RE.match(name):
        canon = os.path.normpath(name.strip()).lower()
        hint = f": wb … {canon}" if store.NAME_RE.match(canon) and store.Task(canon).exists else ""
        die(f"{name!r} isn't a task name (lowercase letters, digits and hyphens){hint}")
    t = store.Task(name)
    if not t.exists:
        die(f"no task named {name!r} (wb status lists them)")
    return t


# When Claude may write code for a delegated task (#92): the user's choice, `wb coding`. The local
# agent gets the first shot in all three; Claude can always review and advise. Without a saved
# choice it is "decide", which is how Claude worked before there was a choice.
CODING = {"only": ("Only when I say", "You tell Claude when to write code."),
          "ask": ("Ask me first", "Claude can ask to make a specific fix and waits for your yes."),
          "decide": ("Let Claude decide",
                     "Claude uses its judgment to guide the local agent or make a fix itself.")}


def coding_mode() -> str:
    mode = (store.read_json(store.home() / "coding.json", {}) or {}).get("mode")
    return mode if mode in CODING else "decide"


def _allowances(task: store.Task) -> list[dict]:
    return (store.read_json(task.dir / "coding.json", {}) or {}).get("allowed") or []


def _allow(task: store.Task, edit: str, said: str, when: str | None = None) -> None:
    rows = _allowances(task) + [{"edit": edit, "said": said, "ts": store.now(), "used": None,
                                 **({"when": when} if when else {})}]
    store.write_json(task.dir / "coding.json", {"allowed": rows})
    task.event({"ts": store.now(), "round": task.status.get("round"), "kind": "coding",
                "text": f"the user allowed Claude: {edit}" + (f", if {when}" if when else "")})


def coding_allowed(task: store.Task) -> dict | None:
    """What the user allowed Claude to edit in this task and Claude hasn't handed back yet."""
    return next((x for x in _allowances(task) if not x.get("used")), None)


def _spent(x: dict) -> bool:
    """Whether handing the work back spends this allowance: a plain yes always; a one-task
    exception (#94, its `when`) only once Claude has started on it (the mod stamps `started` at
    its first edit), so one granted for "if the next try still fails" waits through that try."""
    return not x.get("when") or bool(x.get("started"))


def _coding_used(task: store.Task) -> None:
    """An allowance ends when the work goes back to the agent: a retried or resumed task
    remembers it was used, and the next edit needs the user again."""
    rows = _allowances(task)
    if any(not x.get("used") and _spent(x) for x in rows):
        store.write_json(task.dir / "coding.json", {"allowed": [
            {**x, "used": x.get("used") or (store.now() if _spent(x) else None)} for x in rows]})


def _opencode_again(task: store.Task) -> None:
    """wb start's check of OpenCode, again before feedback, next or resume writes anything:
    reinstalled from npm or GitHub's Latest (1.x) mid-task, the round failed as "opencode exited
    1" and was charged to the model (#866). The version it finds is the runner's to compare with
    (status `opencode`, runner.opencode_moved)."""
    if (have := runner.opencode_version()) and have < (2, 0):
        die(f"OpenCode {have[0]}.{have[1]} can't run tasks: workbench needs OpenCode 2.x: "
            f"{runner.OPENCODE_GET}", 3)
    if have:
        if drift := runner.untested(have):
            print(f"note: {drift}")
        task.set_status(opencode=f"{have[0]}.{have[1]}")


def spawn_runner(task: store.Task) -> int:
    _coding_used(task)  # work handed (back) to the agent: Claude's allowance, if any, is spent
    env = context.detached_env()  # the user's PYTHONPATH kept for the agent (#512)
    env.pop("WB_TASK", None)  # the agent's mark (runner.sweep kills what carries it), not the runner's
    # a stop wb made earlier says nothing about this runner, nor an earlier runner's beat (#872)
    task.set_status(stopping=None, parked=None, beat=None)
    # handed back to the agent: no longer Claude's, so a later session adopting its review turns
    # workbench mode back on (#926: the mod's delegatedWork read the old takeover). Kept for a
    # task not checked out, whose runner's #655 guard reads it
    if task.status.get("taken_over") and runner.checked_out(task):
        task.set_status(taken_over=None)
    with open(task.dir / "runner.log", "a") as log:
        # -X utf8: the runner reads and writes its files as UTF-8 under any locale (the
        # 2026-11-16 audit); a flag, not PYTHONUTF8, so the agent and its tests keep their own
        proc = detach([sys.executable, "-X", "utf8", "-m", "workbench.runner", task.name],
                      awake=f"task {task.name}", cwd=PKG_ROOT, env=env, stdout=log, stderr=log)
    task.set_status(pid=proc.pid, machine=store.machine(), host=store.host())  # whose pid (#849)
    return proc.pid


def _loginctl(*argv) -> str:
    """loginctl's answer, or "" when it has none (absent, failing, slow)."""
    try:
        r = subprocess.run(["loginctl", *argv], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def kills_sessions() -> bool:
    """logind kills every process of a login session at logout (KillUserProcesses=yes). The
    manager's property: `show-session` with no session (systemd 262 has no `show` verb, and
    asking it found nothing to warn about anywhere)."""
    return bool(shutil.which("loginctl")) and \
        _loginctl("show-session", "-p", "KillUserProcesses", "--value") == "yes"


@functools.cache
def runner_scope() -> tuple[str, ...]:
    """What starts a detached process (`detach`) in a scope of its own under the user's systemd
    manager, where logind kills a login session's processes at logout: a runner started from an
    SSH or desktop session died with it, and the night's backlog too (#351, the audit of 1.4).
    `--scope` execs the command, so the pid is the command's. Empty anywhere else, or when the
    manager doesn't answer."""
    if not kills_sessions() or not shutil.which("systemd-run"):
        return ()
    argv = ("systemd-run", "--user", "--scope", "--quiet", "--collect")
    try:
        ok = subprocess.run([*argv, "true"], capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.SubprocessError):
        ok = False
    return argv if ok else ()


def detach(argv: list[str], awake: str = "", **kw) -> subprocess.Popen:
    """Start what outlives this command: a runner, the bench driver, wb optimize, the chat `wb
    chat on` starts. Its own session, stdin from /dev/null, and its own scope where logind kills
    a session's processes at logout (runner_scope): the runners alone had one, so the others
    still died there (#531). With ``awake`` (why, for the inhibitor's list), the machine is kept
    from idle-sleeping while it runs (keep_awake)."""
    proc = subprocess.Popen([*runner_scope(), *argv], stdin=subprocess.DEVNULL,
                            start_new_session=True, **kw)
    if awake:
        keep_awake(proc.pid, awake)
    return proc


# Waits for a pid to exit (argv[1]): a pidfd where Linux has one, else kill -0 every 15 s.
AWAIT_PID = """import os, select, sys, time
pid = int(sys.argv[1])
try:
    fd = os.pidfd_open(pid)
except (AttributeError, OSError):
    fd = None
if fd is not None:
    select.select([fd], [], [])
else:
    while True:
        try:
            os.kill(pid, 0)
        except OSError:
            break
        time.sleep(15)
"""


def awake_how() -> str:
    """What keeps this machine awake while a run lives: "caffeinate" (macOS), "systemd-inhibit"
    (Linux booted with systemd), "windows" (WSL2 with interop and Windows' powershell.exe: Windows
    sleeps whatever Linux holds, so the request is made on its side, #777), or "" where nothing
    can."""
    kind = hardware.system()
    if kind == "macos":
        return "caffeinate" if shutil.which("caffeinate") else ""
    if kind == "wsl":
        return "windows" if context.interop_on() and hardware.powershell() else ""
    if kind == "linux" and shutil.which("systemd-inhibit") and Path("/run/systemd/system").is_dir():
        return "systemd-inhibit"
    return ""


def keep_awake(pid: int, why: str) -> bool:
    """Hold an idle-sleep inhibitor for as long as ``pid`` lives: an overnight backlog, wb
    optimize or wb bench froze with the machine when it idle-slept, runner, lease and model server
    alike, and the monotonic guards counted none of the gap (#516). macOS: `caffeinate -i -w
    <pid>`. Linux: `systemd-inhibit --what=idle:sleep --mode=block` around a wait for the pid;
    logind lets a local active session block sleep, and where it refuses (polkit: an SSH session,
    a scope outside any session) an idle lock alone. Started in this session, not a scope, for
    that reason. WSL2: Windows' powershell.exe asks SetThreadExecutionState(ES_CONTINUOUS |
    ES_SYSTEM_REQUIRED) and blocks reading its stdin, a pipe from the wait for the pid: once the
    pid is gone the pipe closes, the read returns and the request ends with the process (#777;
    idle sleep only, a closed lid or a chosen sleep still sleeps). Where nothing can (WSL2 without
    interop, no tool) or the start fails: nothing, and False."""
    how = awake_how()
    if how == "caffeinate":
        argv = ["caffeinate", "-i", "-w", str(pid)]
    elif how == "windows":
        ps = hardware.powershell()
        if not ps:
            return False
        argv = ["sh", "-c", shlex.join([sys.executable, "-c", AWAIT_PID, str(pid)]) + " | "
                + shlex.join([ps, "-NoProfile", "-NonInteractive", "-Command", WINDOWS_AWAKE])]
    elif how == "systemd-inhibit":
        def lock(what: str) -> str:
            return shlex.join(["systemd-inhibit", f"--what={what}", "--who=workbench", f"--why={why}",
                               "--mode=block", sys.executable, "-c", AWAIT_PID, str(pid)])
        argv = ["sh", "-c", f"{lock('idle:sleep')} 2>/dev/null || exec {lock('idle')}"]
    else:
        return False
    try:
        subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        return False
    return True


def awake_line() -> tuple[bool, str]:
    """For wb doctor: whether runs keep the machine awake here, and how (or why not)."""
    how = awake_how()
    if how == "caffeinate":
        return True, "runs keep the Mac awake (caffeinate -i)"
    if how == "systemd-inhibit":
        try:
            ok = subprocess.run(["systemd-inhibit", "--what=idle:sleep", "--who=workbench",
                                 "--why=wb doctor", "--mode=block", "true"], capture_output=True,
                                timeout=10).returncode == 0
        except (OSError, subprocess.SubprocessError):
            ok = False
        return ok, ("runs keep the machine from idle-sleeping (systemd-inhibit)" if ok else
                      "runs hold an idle lock only (systemd-inhibit): logind refuses a sleep lock "
                      "from this session (polkit grants one to a local active session)")
    if how == "windows":
        return True, WINDOWS_AWAKE_SAID
    if hardware.system() == "wsl":
        return False, WSL_SLEEPS
    return False, ("nothing here keeps the machine from idle-sleeping during a run (no "
                   "systemd-inhibit): a machine that sleeps pauses its tasks until it wakes")


# Windows' side of keep_awake on WSL2 (#777): ES_CONTINUOUS | ES_SYSTEM_REQUIRED, written in
# decimal since Windows PowerShell reads 0x80000001 as a negative Int32, which no uint takes;
# held by this thread until stdin closes
WINDOWS_AWAKE = ("$k = Add-Type -Name Awake -Namespace Workbench -PassThru -MemberDefinition "
                 "'[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState"
                 "(uint flags);'; [void]$k::SetThreadExecutionState([uint32]2147483649); "
                 "[void][Console]::In.ReadLine()")
WINDOWS_AWAKE_SAID = ("runs keep Windows from idle-sleeping (powershell.exe, SetThreadExecutionState); "
                      "closing the lid or choosing sleep still sleeps it")
WSL_SLEEPS = ("WSL2 can't keep Windows awake: when the laptop sleeps, its tasks pause until it "
              "wakes; for a night's run set Windows' sleep to Never while plugged in (Settings, "
              "System, Power)")


def runner_alive(task: store.Task) -> bool:
    pid = task.status.get("pid")
    if not pid:
        return False
    if store.elsewhere(task.status):  # another machine's, on a shared state directory: its pid
        return _beats(task)           # isn't in this process table (#849), its lock file beats
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):  # gone, or a recycled pid that isn't ours
        return False
    # A recycled pid of ours runs something else: trusting any live pid let wb discard, after a
    # reboot, SIGKILL an unrelated process group given the dead runner's pid (the 2026-11-16
    # audit). Whole words: task "a" isn't the runner of task "ab".
    return models.runs(pid, "workbench.runner", task.name)


# Another machine's runner is dead once its lock file hasn't beaten (runner.BEAT_SECS) for this
# long: one killed with its machine kept its task live for good (#872). Generous, for clock skew
# between machines and a machine asleep, whose runner finds its task failed when it wakes.
BEAT_DEAD = 30 * 60


def _beats(task: store.Task) -> bool:
    """Whether another machine's runner still beats (BEAT_DEAD). A runner from before the beat
    (no status `beat`) is trusted, as before."""
    if not task.status.get("beat"):
        return True
    try:
        at = runner.lock_file(task.name, "runner").stat().st_mtime
    except OSError:
        return False
    return time.time() - at < BEAT_DEAD


# A live task whose runner is gone without a word (SIGKILL, out of memory, a reboot) would sit
# in its phase forever: `wb wait` blocked, feedback and resume refused it (the 2026-11-16
# audit). After REAP_GRACE seconds with no status change (feedback, resume and next set phase
# queued just before spawn_runner writes the new pid, their slow work done first) it is failed,
# with one notice.
REAP_GRACE = 15
_DISK_SAID: list = []
RUNNER_DIED = "the runner died (see runner.log)"
# A runner recorded under another boot (status `boot`, store.boot_id): a restart ended it. After
# one, every live task was failed with a wake of its own guessing why, and resumed one at a
# time (#544): one notice now names them all, and `wb resume --all` continues them.
RESTARTED = "interrupted by a restart (the machine started again under it)"


def _restarted(st: dict) -> bool:
    return bool(st.get("boot")) and store.boot_id() not in (None, st["boot"])


def reap(task: store.Task, quiet: bool = False) -> bool:
    """Fail a live task whose runner is dead; True when this call did it. quiet: no notice (a
    restart's batch, which one notice names)."""
    far = store.elsewhere(task.status)  # its pids and boot are another machine's (#872)
    agent = None if far else task.status.get("agent_pid")
    restart = _restarted(task.status) and not far
    try:
        st = task.set_status_if(  # one reaper wins: two waiters, one notice
            lambda st: st.get("phase") in LIVE and not runner_alive(task)
            and time.time() - (st.get("updated_at") or 0) >= REAP_GRACE,
            phase="failed", last=RESTARTED if restart else RUNNER_DIED, pid=None,
            agent_pid=None, asking=None,  # infra: the machine's, wb bench grades none of it (#508)
            infra="restart" if restart else "runner died")
    except OSError as e:
        if not store.disk_full(e):
            raise
        # wb status, wb wait and the mod's poll ended in a traceback until space was freed
        # (#342): said once a command, and reaped on the first call that can write
        if not _DISK_SAID:
            _DISK_SAID.append(True)
            print(f"wb: the disk is full ({store.home()}): a task whose runner died can't be "
                  "marked failed until there is room", file=sys.stderr)
        return False
    if st is None:
        return False
    # The agent it left, if the kernel didn't take it with the runner. Off Linux nothing else
    # does (no PDEATHSIG, no /proc for sweep), and it went on editing a task reported failed
    # (the 2026-11-19 audit): its group, once its command line shows it is still that agent
    if agent and models.runs(agent, "run", "--standalone"):
        try:
            os.killpg(agent, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    runner.sweep(task)
    ask_mcp.close_all(task)  # and its questions, which nothing will relay (the 0.90 review)
    task.event({"ts": store.now(), "round": st.get("round"), "kind": "error",
                "text": "the runner was " + RESTARTED if restart else "the runner died without a report"})
    if restart:
        if not quiet:
            _restart_notice(task)
        return True
    free = store.free_bytes()
    full = free is not None and free < DISK_SPARE  # a full disk is the likely why (#342)
    silent = f"no heartbeat for {BEAT_DEAD // 60} min: " if far else ""  # #872
    task.notify("failed", f"task {task.name}: the runner{' on ' + far if far else ''} died "
                f"without a report ({silent}killed, out of memory or a reboot{'; the disk has ' + store.gb(free) + ' free' if full else ''}); "
                f"see {task.dir / 'runner.log'}. wb resume {task.name} "
                "continues it in a fresh session", round=st.get("round"), cause="died")  # #582
    return True


_owner = store.owner


def _restart_notice(task: store.Task) -> None:
    """One notice for the tasks one restart interrupted in task's session (its others reaped
    here, quietly), raised on the first started, the rest acknowledged with it: the mod woke
    Claude once per task (#544)."""
    batch = [t for t in store.all_tasks() if t.name == task.name or (
        _owner(t) == _owner(task) and t.status.get("phase") in LIVE
        and _restarted(t.status) and reap(t, quiet=True))]
    ts = store.now()
    # the batch by name: `wb resume --all --repo <cwd>` resumed nothing for a session in ~ (a
    # broad directory claims no task) and, in a repo two sessions share, the other's tasks too (#692)
    row = batch[0].notify("failed", (f"task {task.name}: {RESTARTED}" if len(batch) == 1 else
                               f"{len(batch)} tasks were {RESTARTED.replace('it)', 'them)')}: "
                               + ", ".join(t.name for t in batch))
                    + f". wb resume {' '.join(t.name for t in batch)}"
                    + " continues them in the order they were started (one that never ran a "
                    "round starts it again)", round=batch[0].status.get("round"), ts=ts,
                    tasks=[t.name for t in batch], cause="died")  # not the step's size (#582)
    store.ack_batch(batch, row, ts)  # had with the first's notice: neither wb wait nor the mod wakes for it


def _whose(t) -> str:
    """Whose a task is, for a line naming it: its Claude Code session and directory."""
    sid, where = store.owner(t)
    return (f"session {sid}" if sid else "no session") + (f" in {where}" if where else "")


def _stop_for_update(tasks) -> str:
    """`wb update --stop`: every running agent stopped, each task left stuck with UPDATE_STOP and
    a notice per owner (store.owner, as a restart's batch) naming `wb resume`, so each session,
    this one or another, is woken to continue its own. `wb stop --all` parked them and
    acknowledged their news: another session's Claude waited for a wake that never came (#694)."""
    stopped = []
    for t in tasks:
        with store.locked(runner.lock_file(t.name, "cmd")):
            if t.status.get("phase") in store.CLOSED or (t.status.get("pid") and store.elsewhere(
                    t.status) and runner_alive(t)):
                continue  # another machine's live runner (#849): that machine's wb stops it
            _stop_runner(t)
            t.event({"ts": store.now(), "round": t.status.get("round"), "kind": "stopped",
                     "by": "user", "text": UPDATE_STOP})
            t.set_status(phase="stuck", last=UPDATE_STOP, pid=None)
            stopped.append(t)
    groups: dict = {}
    for t in stopped:
        groups.setdefault(store.owner(t), []).append(t)
    for batch in groups.values():
        names, ts = [t.name for t in batch], store.now()
        row = batch[0].notify("stuck", (f"task {names[0]}: {UPDATE_STOP}" if len(batch) == 1 else
                                  f"{len(batch)} tasks were {UPDATE_STOP}: " + ", ".join(names))
                        + f". wb resume {' '.join(names)} continues "
                        + ("it" if len(batch) == 1 else "them") + " in a fresh session",
                        round=batch[0].status.get("round"), ts=ts, tasks=names, cause="update")
        store.ack_batch(batch, row, ts)  # had with the first's notice, as a restart's batch (#544)
    return "stopped for the update: " + (", ".join(f"{t.name} ({_whose(t)})" for t in stopped)
                                          or "nothing was running")


def _worktree_problem(task: store.Task) -> str | None:
    """Why the task can't go on where it stands, its worktree missing. A worktree removed by hand
    turned the next round into a runner crash (the 2026-11-16 audit). Its committed steps are on
    the branch; discard --keep-branch keeps them. Or its repository is nowhere (moved, renamed:
    not even a main worktree of its git dir): wb feedback, next and resume sent a runner that
    crashed and never named wb relocate, as accept's _repo does (#776)."""
    if task.spec.get("repo") and not gitops.repo_of(task.spec).is_dir():  # damaged: the runner says (#475)
        return (f"{task.spec['repo']} moved or was deleted: wb relocate {task.name} --repo <its "
                "new path>, then try again")
    if why := _accepting(task):  # before the discard advice (#878)
        return why
    if task.worktree.is_dir():
        return None
    if not runner.checked_out(task):
        return (f"{task.name} never got its worktree (its checkout didn't finish): wb discard "
                f"{task.name}, then start the task again under a new name")
    return (f"{task.name}'s worktree is gone ({task.worktree}): its committed work is on branch "
            f"{task.spec.get('branch')}; wb discard {task.name} --keep-branch drops the task and "
            "keeps the branch")


def _accepting(task: store.Task) -> str | None:
    """Why the task can't be changed or dropped: an earlier wb accept got past its commit
    (status `closing`) and stopped before it finished (Claude's Bash limit, an Esc, a signer
    waiting on a touch). It looked like a task still in review: discard recorded committed work
    as discarded, and feedback or next added work that the retried accept's forced worktree
    removal then deleted (#878, Claude's audit of 1.90.24)."""
    close = task.status.get("closing")
    if not close or task.status.get("phase") in store.CLOSED:
        return None
    return (f"{task.name} is being accepted: an earlier wb accept committed {close.get('commit')} "
            f"and stopped partway; wb accept {task.name} finishes it")


def _need_worktree(task: store.Task) -> None:
    if why := _worktree_problem(task):
        die(why)


def _stale_notes(task: store.Task) -> list[dict]:
    """The notes the last runner never delivered (sent as its round ended, or before a stuck
    stop), marked taken: else the next runner delivered them first, and a stale --now note cut a
    feedback round short (the 2026-11-16 audit). Claude's own come back, for the caller to carry
    or report; the runner's nudges are dropped."""
    rows = runner.pending_steer(task)
    if rows:
        task.set_status(steer_taken=task.status.get("steer_taken", 0) + len(rows))
    return [r for r in rows if r.get("by") != "workbench"]


def _say_dropped(notes: list[dict]) -> None:
    for r in notes:
        print("not delivered, dropped (put it in the feedback if it still matters): "
              + r["text"].strip().replace("\n", " ")[:120])


def one_at_a_time(cmd):
    """Run a command that changes a task under the task's command lock, so two at once (two
    sessions woken by one review, the chat and the terminal) run one after the other, the second
    seeing what the first did: an accept racing a discard once deleted the accepted commit and
    wrote two results rows (the 2026-11-16 audit). The lock (runner.lock_file) is where no lane
    reads it: an agent holding it would wedge every command. The runner never takes it."""
    @functools.wraps(cmd)
    def run(a):
        name = getattr(a, "name", None)
        if getattr(a, "all", False) or getattr(a, "more", None) or not name \
                or not store.NAME_RE.match(name) \
                or not store.Task(name).exists:
            return cmd(a)
        with store.locked(runner.lock_file(name, "cmd")):
            return cmd(a)
    return run


def ago(ts) -> str:
    if not ts:
        return "-"
    s = int(time.time() - ts)
    return f"{s}s" if s < 90 else f"{s // 60}m" if s < 5400 else f"{s // 3600}h"


def pick_model(size: str, wanted: str | None, stack=(), name: str | None = None) -> tuple[models.Model, dict, str]:
    """The task's model: the one asked for, else the router's choice on the evidence (the
    record on this kind of work first: router.score; ``name``: the task's, which decides
    whether it explores, router.explores)."""
    if wanted:
        try:
            m = models.resolve(wanted)
        except KeyError as e:
            die(str(e).strip('"'))
        return m, models.status(m), "asked for"
    top, why = router.choose(size, stack, name)
    if top is None:
        die(why, 3)
    return top.model, top.state, why


def _gpu_holders(me: str | None = None, of: models.Model | None = None) -> dict:
    """Who holds or waits for the GPU (``of``'s: a remote model's server, else this machine's),
    but ``me``: its gpu.json's live entries, plus each task whose runner is alive but hasn't
    reached the lease yet (one just started), as an entry of its own. A runner that has (status
    `leased`, its pid) and isn't in gpu.json stepped aside for its tests or a server's wait:
    counted, wb start refused (exit 4) a task the lease would have let in (#805). Another
    machine's task (a network home's) isn't, with this machine's own lease: it is on that
    machine's GPU, and its checkout or base check here refused an idle GPU (#895)."""
    pool = models.pool(of)
    held = {p: h for p, h in models.holders(pool=pool).items() if h.get("task") != me}
    named = {h.get("task") for h in held.values()}
    found = models.discover()
    own = not models.lease_shared()
    for t in store.all_tasks():
        m = found.get(t.spec.get("model") or "")
        if t.name not in named and t.name != me and m and models.pool(m) == pool \
                and not (own and store.elsewhere(t.status)) \
                and t.status.get("phase") in store.ACTIVE and runner_alive(t) \
                and t.status.get("leased") != t.status.get("pid"):
            held[f"task {t.name}"] = {"model": m.id, "task": t.name}
    return held


def _gpu_wait(m: models.Model, me: str | None = None) -> tuple[dict, bool]:
    """The GPU's other holders, and whether ``m`` would have to wait for them (queued) rather
    than run beside them. A remote model waits for the other tasks on its server (#116)."""
    held = _gpu_holders(me, m)
    return held, bool(held) and not models.admits(m, held)


def _preempt_bench(m: models.Model, me: str | None = None) -> str:
    """Real work first: the bench's replays that keep `m` off the GPU are stopped (the driver
    records them preempted and replays them once no real task runs). An overnight run must
    never make the morning's task queue."""
    held, waits = _gpu_wait(m, me)
    # never another machine's: _stop_runner refuses it, and wb start, feedback, next and resume
    # died with "runs on <host>" before their --queue check (#895)
    names = sorted({h["task"] for h in held.values() if h.get("task")
                    and store.Task(h["task"]).spec.get("bench")
                    and not store.elsewhere(store.Task(h["task"]).status)}) if waits else []
    for name in names:
        t = store.Task(name)
        with store.locked(runner.lock_file(name, "cmd")):
            if t.status.get("phase") in store.CLOSED:
                continue
            _stop_runner(t)
            t.set_status(phase="stuck", last=bench.PREEMPTED, pid=None)
    out = [f"the bench's replay ({', '.join(names)})"] if names else []
    if waits and any(h.get("task") == optimize.HOLDER for h in held.values()) and (pid := optimize.stop()):
        out.append("wb optimize (what it measured is kept)")  # real work first, here too
        # and gone before the caller reads the GPU's holders: a stop is a SIGTERM, and wb try
        # right after wb setup's run was refused by the entry it hadn't yet let go (#161)
        wait_exit(pid, OPTIMIZE_EXIT)
    return f"note: stopped {' and '.join(out)} to make room" if out else ""


OPTIMIZE_EXIT = 30  # seconds a stopped wb optimize gets to let go of the GPU (it stops between requests)


def _fixed_line(task: store.Task, m: models.Model) -> str:
    """A line when the agent's fixed prompt takes FIXED_SHARE of the model's window or more."""
    window = (m.config.get("limit") or {}).get("context")
    try:
        tokens, parts = context.fixed_prompt(task)
    except (OSError, gitops.GitError):
        return ""
    if not window or tokens < context.FIXED_SHARE * window:
        return ""
    big = ", ".join(f"{name} {n / 1000:.1f}K" for name, n in parts[:3])
    return (f"the agent reads about {tokens / 1000:.0f}K tokens before its first step, "
            f"{100 * tokens // window}% of {m.id}'s {window // 1024}K window ({big}): it will hand "
            "over to fresh sessions early and often; trim the largest, or --model one with a bigger window")


def _gpu_note(task: store.Task) -> str:
    """For wb feedback/next/resume, which queue the task anyway: who it will wait for."""
    m = models.discover().get(task.spec.get("model") or "")
    if m and not task.spec.get("bench"):
        _say(_preempt_bench(m, task.name))
    held, waits = _gpu_wait(m, task.name) if m else ({}, False)
    return (f"note: the GPU is busy with {', '.join(sorted({h['task'] for h in held.values()}))}; "
            f"{task.name} waits as queued until it's free") if waits else ""


# --- commands -----------------------------------------------------------------------------------

def _has_file(repo: Path, ref: str, path: str) -> bool:
    return subprocess.run(["git", "-C", str(repo), "cat-file", "-e", f"{ref}:{path}"],
                          capture_output=True).returncode == 0


def _ignored(repo: Path, path: str) -> bool:
    """Whether git ignores ``path`` in ``repo`` (a tracked file never is)."""
    return subprocess.run(["git", "-C", str(repo), "check-ignore", "-q", path],
                          capture_output=True).returncode == 0


def _local_claude_md(repo: Path) -> bool:
    """A CLAUDE.md kept out of git on purpose: the agents get the checkout's copy
    (context.instruction_files), so it is never to be committed (the 2026-11-16 audit)."""
    return (repo / "CLAUDE.md").is_file() and _ignored(repo, "CLAUDE.md")


# Where a project's committed instructions may live, as Claude Code reads them (context.ROOT_FILES
# loads both): a repo with only .claude/CLAUDE.md was refused as having none (the 2026-11-16
# audit). CLAUDE.local.md is the user's own, rarely committed, so it doesn't count.
PROJECT_MEMORY = ("CLAUDE.md", ".claude/CLAUDE.md")


def _claude_md_at(repo: Path, ref: str, under: str = "") -> str | None:
    """The first of PROJECT_MEMORY committed at ``ref`` (in directory ``under``), or None."""
    return next((p for p in PROJECT_MEMORY if _has_file(repo, ref, f"{under}/{p}".lstrip("/"))), None)


def _package(repo: Path, given: Path, base: str) -> str | None:
    """The nearest directory from ``given`` up to (not including) the repo's top with a CLAUDE.md
    of its own at ``base``: a monorepo's package, where the agent, the setup and the tests then
    run (task.json `subdir`). From packages/app, wb start refused the repo for a CLAUDE.md at its
    root, and the agent worked from the root (#375, the audit of 1.6); from packages/app/src it
    still did, since only ``given`` itself was looked at (#606, the audit of v1.90). Claude Code
    loads the nearest CLAUDE.md above it too. A plain subdirectory still means the whole repo."""
    try:
        parts = given.relative_to(repo).parts
    except ValueError:
        return None
    for n in range(len(parts), 0, -1):
        # not a `.claude` directory: its CLAUDE.md is its parent's .claude/CLAUDE.md, and from
        # .claude/skills/x the walk took the repo's own for a package at .claude (review of #606)
        if parts[n - 1] != ".claude" and (_claude_md_at(repo, base, sub := "/".join(parts[:n]))
                                          or _local_package_md(repo, sub)):
            return sub
    return None


def _local_package_md(repo: Path, sub: str) -> bool:
    """A package's CLAUDE.md (or .claude/CLAUDE.md) kept out of git, as _local_claude_md at the
    root: only committed ones made a package, so the agent, the setup and the tests ran at the
    root and the package's instructions never reached the agent (#785)."""
    return any((repo / sub / p).is_file() and _ignored(repo, f"{sub}/{p}") for p in PROJECT_MEMORY)


def _need_claude_md(repo: Path, base: str, a, sub: str | None = None) -> None:
    if sub and not _claude_md_at(repo, base, sub):  # a package's own, kept local (#785)
        print(f"note: {sub}'s CLAUDE.md is gitignored: the agent gets your checkout's copy")
    if a.no_claude_md or sub:  # a package's own CLAUDE.md counts
        return
    if not _claude_md_at(repo, base) and _local_claude_md(repo):
        print("note: CLAUDE.md is gitignored: the agent gets your checkout's copy")
    elif not _claude_md_at(repo, base):
        die(f"{repo} has no CLAUDE.md (or .claude/CLAUDE.md) at {base}: the agent would start "
            "blind. Write it (what the project is, how to build and test it, its conventions), "
            f"commit it, and run wb init {shlex.quote(str(repo))} to link AGENTS.md (a monorepo "
            "package with its own: --repo <the package's directory>); --no-claude-md skips this check")


def _identity(repo: Path) -> bool:
    """Whether git can sign a commit in ``repo`` as someone: what `git commit` itself resolves
    (repo config, includeIf, GIT_AUTHOR_*/EMAIL), strictly. Without one a task ran for its whole
    length and only wb accept found out (the 2026-11-16 audit)."""
    return all(gitops.git(repo, "var", v, check=False).strip()
               for v in ("GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"))


def _signed(spec: dict, a) -> bool:
    """Whether accept's or next's commit is signed as the user's git says: not after --no-sign,
    given at start (task.json `sign`) or now (#374)."""
    return spec.get("sign", True) and not getattr(a, "no_sign", False)


def _lane_fits(repo: Path, test: str | None, *, off: bool = False) -> None:
    """Refuse a task the agent's lane can't hold (the 2026-11-16 audit): a repo that is the home
    directory (the lane would read all of it) or lies where credentials live (it couldn't read
    the repo at all), and an acceptance command that is a snap (no-new-privileges, which the
    lane sets, stops snap-confine, so every test round would fail). `off`: `--allow-path '*'`
    turned the lane off for this task (the 0.90 review: it was refused all the same)."""
    if off or not context.lane_on():
        return
    real = os.path.realpath(repo)
    if real in ("/", os.path.realpath(Path.home())):
        die(f"{repo} is your home directory: the agent's lane would read all of it. Delegate "
            "from the project's own repository")
    if any(real == h or real.startswith(h + os.sep) for h in context.secret_paths()):
        die(f"{repo} lies where credentials live (context.SECRETS), which the agent can't read: "
            "delegate from a repository outside it")
    try:
        first = shlex.split(test)[:1] if test else []
    except ValueError:
        first = []
    if first and sys.platform.startswith("linux") and context.snaps(first):
        die(f"{first[0]} is a snap, which can't run in the agent's lane (no-new-privileges stops "
            "snap-confine): install it another way, or start with --allow-path '*' (the lane "
            'off for this task), or commands.json "paths": ["*"] for every task')


# Ignored directories a worktree lacks that are only caches, not worth a note at wb start
CACHE_DIRS = ("__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox",
              ".cache", ".idea", ".vscode")


def _worktree_setup(repo: Path, a, sub: str | None = None) -> dict:
    """The task's `setup`, `copy` and `siblings`: commands.json's `repos` entry for the repo,
    with --setup in its place and --copy/--sibling added, each checked (#201, the 2026-11-19
    audit). A copied path must be ignored in the checkout (else it shows in the review diff) and
    no secret (SECRET_FILES): the user's settings stay theirs. A sibling is a directory beside
    the repo the lane may read."""
    conf = context.repo_conf(repo, sub)  # the package's entry, not the repo's first (#778)
    setup = a.setup if a.setup is not None else conf.get("setup") or ""
    copy, sibs = [], []
    for raw in [*conf.get("copy", []), *(a.copy or [])]:
        p = os.path.normpath(raw.strip()).rstrip("/")
        if os.path.isabs(p) or p == ".." or p.startswith("../") or p in (".", ""):
            die(f"--copy {raw}: a path inside the repo, ignored there (e.g. node_modules)")
        parts = p.split("/")
        if any(x not in NOT_SECRET and any(fnmatch.fnmatch(x, pat) for pat in SECRET_FILES)
               for x in parts):
            die(f"--copy {raw}: looks like a secret or a user's setting "
                f"({', '.join(SECRET_FILES[:4])}…), which stays out of the agent's worktree")
        if not os.path.lexists(repo / p):
            die(f"--copy {raw}: no {p} in {repo}")
        # a virtualenv can't move: its activate and its scripts' shebangs name the checkout, so a
        # copied .venv ran the developer's environment, and its writes left the lane (#260, the
        # audit of 1.2)
        if venv := runner.venv_in(repo / p):
            die(f"--copy {raw}: {venv.relative_to(repo)} is a Python virtualenv, which still runs "
                f"from {repo} once copied; recreate it with --setup instead, e.g. --setup "
                f"'python3 -m venv {venv.relative_to(repo)} && {venv.relative_to(repo)}/bin/pip "
                "install -r requirements.txt' or --setup 'uv sync'")
        if not gitops.ignored(repo, p):
            die(f"--copy {raw}: not ignored in {repo}, so a copy would show in the review diff; "
                "a tracked file is in the worktree already")
        # ignored in the checkout isn't untracked where the task starts: a tag given as --base
        # tracked generated/config, the developer's local copy went over it, and it reached the
        # accepted commit; nor is an ignored directory empty of tracked files (#244, the audit of 1.2)
        base = gitops.base_commit(repo, a.base) or "HEAD"
        held = [x for x in gitops.git(repo, "ls-tree", "-r", "--name-only", "-z", base, "--", p).split("\0")
                + gitops.git(repo, "ls-files", "-z", "--", p).split("\0") if x]
        if held:
            die(f"--copy {raw}: {held[0]} under it is tracked (at {a.base} or in the checkout's "
                "index), and the copy would replace it in the task's worktree and its commit; "
                "copy only the ignored files inside")
        if p not in copy:
            copy.append(p)
    guard = context.repo_dirs(SimpleNamespace(spec={"repo": str(repo)}))
    for name in [*conf.get("siblings", []), *(a.sibling or [])]:
        ups, rest = context.sibling_parts(name.strip().rstrip("/"))
        parts = rest.split("/")
        if not rest or any(c in ("", ".", "..") for c in parts) or ups > len(repo.parents):
            die(f"--sibling {name}: a directory beside the repo (<name> or ../<name>) or further up "
                "(../../<path>), by the path the project's own files use")
        name = rest if ups == 1 else "../" * ups + rest  # kept as `lib` when one up, as before
        real = context.sibling_real(repo, name)
        if not os.path.isdir(real):
            die(f"--sibling {name}: no directory {repo.parents[ups - 1] / rest}")
        if why := context.lane_refusal(real):
            die(f"--sibling {why}")
        if any(g == real or g.startswith(real.rstrip(os.sep) + os.sep) for g in guard):
            die(f"--sibling {name}: it holds the repo itself")
        if name not in sibs:
            sibs.append(name)
    # each link is made where the worktree reaches it, under the task's directory: one inside
    # another would be made through the first link, in the real directory (#261)
    wt = context.tree(Path("/t"), repo, sibs, "worktree")
    for n in sibs:
        at = context.sibling_link(wt, n)
        if wt.parent == Path("/t") and at.relative_to("/t").parts[0] in context.TASK_FILES:
            die(f"--sibling {n}: the name of one of the task's own files; link it by hand")
        for other in [*(m for m in sibs if m != n), None]:
            there = context.sibling_link(wt, other) if other else wt
            if at == there or there.is_relative_to(at) or at.is_relative_to(there):
                die(f"--sibling {n}: " + (f"it overlaps --sibling {other}: name one of them"
                                          if other else "its link would be the task's worktree"))
    limit = a.setup_timeout if getattr(a, "setup_timeout", None) is not None \
        else conf.get("setup_timeout")
    if limit is not None and limit <= 0:
        die("--setup-timeout is seconds: a positive whole number")
    return {k: v for k, v in (("setup", setup), ("copy", copy), ("siblings", sibs),
                              ("setup_timeout", limit if setup else None)) if v}


# What an install makes, at any depth: a monorepo's per-package node_modules or .venv
INSTALL_DIRS = ("node_modules", ".venv", "venv", "target", "vendor")


def _missing_dirs(repo: Path, sub: str | None = None) -> list[str]:
    """The checkout's ignored directories (but caches), which a task's worktree won't have:
    what a --setup would install (node_modules/, .venv/, target/). Those at the top, directly
    in the package (`sub`) and any install directory (INSTALL_DIRS) deeper, named from the
    package: only the top level was looked at, so a monorepo's services/api/.venv and
    web/node_modules got no note, and every round ran against a base that could never pass
    (#877, Claude's audit of 1.90.24)."""
    try:
        out = gitops.git(repo, "ls-files", "--others", "--ignored", "--exclude-standard",
                         "--directory", "-z")
    except gitops.GitError:
        return []
    pre = f"{sub.strip('/')}/" if sub else ""
    keep = []
    for p in out.split("\0"):
        if not p.endswith("/"):
            continue
        name = p[:-1].rsplit("/", 1)[-1]
        if name in CACHE_DIRS or name.endswith("cache"):
            continue
        if p.count("/") == 1 or (pre and p.startswith(pre) and p[len(pre):].count("/") == 1) \
                or name in INSTALL_DIRS:
            keep.append(os.path.relpath(p, pre or ".") + "/" if pre else p)
    return keep


# A task takes its checkout and --copy paths, then the base check's and wb verify's scratch
# checkouts copy them again (a full copy on ext4, where reflinks don't exist) (#342, the audit
# of 1.4). The setup's build output can't be measured before it runs: runner._no_room_for checks
# it before each scratch copy (#860).
DISK_COPIES, DISK_SPARE = 3, runner.CHECKOUT_SPARE


def history_held(budget: float = 2) -> str:
    """What the state directory's history holds that wb can prune, for the disk advice: the
    archive and wb bench's cases and runs, each with what frees it; '' when they hold little.
    The advice named only open tasks, never the space history took for good (#740)."""
    parts = []
    for path, what, fix in ((store.archive_dir(), "the archive", "wb gc trims its old logs"),
                            (bench.home() / "cases", "wb bench's cases", "wb bench rm <case>"),
                            (bench.home() / "runs", "wb bench's runs", "a new run trims old ones")):
        size, whole = store.dir_size(path, budget=budget)
        if size >= 100_000_000:
            parts.append(f"{what} {'' if whole else 'at least '}{store.gb(size)} ({fix})")
    return "; ".join(parts)


def noexec_line() -> str:
    """wb start's refusal and wb doctor's BAD line for a state directory on a noexec mount (#851)."""
    return (f"the state directory {store.home()} is on a noexec mount: the agent's git shim and the "
            "worktree's own programs (./gradlew, node_modules/.bin, .venv/bin, built tests) can't run "
            "there; set WB_HOME to a directory on a mount that allows exec, or remount it exec")


def _disk_room(repo: Path, base: str, setup: dict) -> int | None:
    """Refuse a task the disk has no room for: a full one mid-round failed every status write.
    The checkouts the open tasks' runners haven't made yet count as taken: since the runner makes
    the checkout (#529), a batch of starts each saw the disk as the first did, and four 8 GB
    checkouts ran at once on 40 GB (#676). Returns the size it measured (task.json
    `checkout_bytes`), or None when the free space is unknown."""
    free = store.free_bytes()
    if free is None:
        return None
    # Git LFS files at their own size (#382), the sparse cone only, a partial clone's local blobs
    size, unknown = gitops.checkout_size(repo, base)  # (#436)
    for p in setup.get("copy", ()):
        size += store.dir_size(repo / p, budget=5)[0]
    need = size * DISK_COPIES + DISK_SPARE
    gap = (f"; {unknown} of its files aren't fetched yet (a partial clone), so their size isn't "
           "counted" if unknown else "")
    pending = runner.pending_checkouts()
    if pending:
        gap += f"; {store.gb(pending)} more is promised to the checkouts of tasks just started"
        free = max(free - pending, 0)
    if free >= need:
        if unknown:
            print(f"note: the disk check counted {store.gb(size)} of the checkout{gap}")
        return size
    held = sorted(((store.dir_size(t.dir, budget=2)[0], t.name) for t in store.all_tasks()
                   if t.status.get("phase") not in store.CLOSED), reverse=True)
    die(f"{store.gb(free)} free where the state directory is ({store.home()}), and a task of this "
        f"repo wants {store.gb(need)} (its checkout and --copy paths, {store.gb(size)}, three "
        f"times over, and 2 GB{gap}): free some, or wb discard an open task"
        + ("; the open tasks: " + ", ".join(f"{n} {store.gb(b)}" for b, n in held[:8]) if held else "")
        + (f"; history: {kept}" if (kept := history_held()) else ""))


# A batch is started in one sitting: a backlog whose tasks are all closed, the newest started
# this long ago, is an earlier night's
BACKLOG_GAP = 6 * 3600


def _backlog_done(name: str) -> str | None:
    """Why `--backlog name` is refused: an earlier batch had the name. Reused, the morning's
    `wb backlog` listed both nights' tasks and added their savings, and on WSL2 the second
    night's first task found the first's and never said nothing keeps Windows awake (#880,
    Claude's audit of 1.90.24)."""
    ts = [t for t in store.all_tasks(archived=True) if t.spec.get("backlog") == name]
    if not ts or any(t.status.get("phase") not in store.CLOSED for t in ts) or time.time() - max(
            t.spec.get("created_at") or 0 for t in ts) < BACKLOG_GAP:
        return None
    fresh = f"{name[:37].rstrip('-')}-{time.strftime('%Y-%m-%d')}"
    return (f"backlog {name!r} was an earlier batch ({len(ts)} task(s), all closed): give this "
            f"one a fresh name, as --backlog {fresh}")


def cmd_start(a):
    if not store.NAME_RE.match(a.name):
        die("a task name is lowercase letters, digits and hyphens, at most 48")
    if a.backlog is not None and not store.NAME_RE.match(a.backlog):
        die("a backlog name is lowercase letters, digits and hyphens, at most 48")
    if a.backlog and (why := _backlog_done(a.backlog)):
        die(why)
    task = store.Task(a.name)
    if task.exists:  # discarding never frees a name, so the refusal doesn't suggest it (the audit)
        die(f"task {a.name!r} exists ({task.status.get('phase')}): task names are never reused, "
            "pick a new one")
    try:
        repo = gitops.toplevel(Path(a.repo).resolve())
    except gitops.GitError as e:  # git's own reason when it isn't "not a repo": dubious ownership
        if not Path(a.repo).is_dir():  # would otherwise send Claude to git init a repo (the audit)
            die(f"{a.repo} is not a directory")
        if not isinstance(e, gitops.NotARepo):
            die(f"{a.repo}: {str(e).split(': ', 1)[-1]}")
        die(f"{a.repo} is not inside a git repository: wb init {shlex.quote(a.repo)} sets the "
            "project up")
    tasks = store.tasks_dir().resolve()
    if repo.resolve().is_relative_to(tasks):  # gone at that task's accept, wedging this one (the audit)
        owner = store.Task(repo.resolve().relative_to(tasks).parts[0])
        die(f"{repo} is task {owner.name}'s worktree, not a project: start from its repo "
            f"(--repo {owner.spec.get('repo', '<the project>')})")
    _lane_fits(repo, a.test, off="*" in (a.allow_path or []))
    spec_text = read_text(a.spec, "the spec")
    if not spec_text.strip():
        die("the spec is empty")
    handed = _skill_names(a.skill)
    # the repo's own directories (context.repo_dirs reads only the spec's repo: task.json is to come)
    guard = context.repo_dirs(SimpleNamespace(spec={"repo": str(repo)}))
    lane_dirs = [_lane_dir(p, guard) for p in a.allow_path or []]
    if not shutil.which(exe := runner.opencode_bin()[0]):  # else the runner emptied the GPU, then
        # the round died as "opencode exited 1" (the 2026-11-16 audit)
        die(f"{exe} isn't on PATH: install OpenCode 2.x ({runner.OPENCODE_GET}), or put it on the "
            "PATH Claude Code runs wb with; wb doctor checks the setup")
    # before anything is written: 1.x has no `run --standalone --auto` nor the layer's config
    # shape, so every round died as "opencode exited 1" after the GPU was emptied (#654)
    if (have := runner.opencode_version()) and have < (2, 0):
        die(f"OpenCode {have[0]}.{have[1]} can't run tasks: workbench needs OpenCode 2.x: "
            f"{runner.OPENCODE_GET}", 3)
    if store.noexec():  # every git call the agent makes would exit 126 (#851)
        die(noexec_line())
    # the package first: its stack is the task's, not the whole monorepo's (#820). Read again
    # below, after the base is checked; a base that names no commit finds none here
    stack = gitops.stack(repo, _package(repo, Path(a.repo).resolve(), a.base))
    m, state, why = pick_model(a.size, a.model, stack, a.name)
    if not state["available"] and not a.force:
        fix = models.remedy(m, state)
        die(f"{m.id} can't run: {state['why']}" + (f": {fix}" if fix else "")
            + (" (--force queues it anyway, to wait for it)" if models.may_come_up(state) else ""), 3)
    dirty = gitops.git(repo, "status", "--porcelain").strip()
    if not gitops.base_commit(repo, a.base):  # first: a typo read as a missing CLAUDE.md (the audit)
        if not gitops.base_commit(repo, "HEAD") and gitops.current_branch(repo):  # unborn (#476)
            die(f"{repo} has no commits yet: commit, or wb init {shlex.quote(str(repo))} (it "
                "commits the project as it is)")
        die(f"no commit {a.base} in {repo}: a typo, or a ref not fetched yet (git fetch)")
    if not _identity(repo):
        die("git has no user.name/user.email here: the user's identity signs the commits "
            "(git config --global user.name/user.email)")
    sub = _package(repo, Path(a.repo).resolve(), a.base)
    _need_claude_md(repo, a.base, a, sub)
    if sub:
        print(f"package: {sub} (its own CLAUDE.md): the agent, the setup and the tests run there")
    if not a.no_sign:  # said now, not after the whole task at wb accept (#374)
        _say(gitops.sign_problem(repo, a.base))
    setup = _worktree_setup(repo, a, sub)
    checkout_bytes = _disk_room(repo, a.base, setup)
    # Two projects, one GPU: a task that can't run beside the GPU's holders used to queue in
    # silence behind them, maybe for hours (the 2026-11-16 audit). Say so before any worktree.
    if not getattr(a, "bench", None):
        _say(_preempt_bench(m, a.name))
    held, waits = _gpu_wait(m, a.name)
    if waits and not a.queue:
        die(models.busy(held, f"{m.id} can't run beside {'it' if len(held) == 1 else 'them'}. "
                        "--queue starts it anyway, to wait behind; or do this step yourself"), 4)

    try:
        task.dir.mkdir(parents=True)
    except FileExistsError:  # a start under way, or one that died before task.json
        if (half := _dead_start(task)) is None:
            die(f"{task.dir} exists without a task.json: another wb start {a.name} is under way; "
                "pick a new name")
        _drop_start(task, half)  # killed (Claude's Bash limit): its name was refused for good (#376)
        task.dir.mkdir(parents=True)
    # The checkout is the runner's (runner.checkout): made here, a big repo, one on /mnt/c or with
    # Git LFS data passed Claude's two-minute Bash limit, and each start was killed the same way
    # (#529). What it would refuse is checked here first, the branch, a commit's own submodules.
    wt = context.tree(task.dir, repo, setup.get("siblings"), "worktree")  # #261
    base = gitops.base_commit(repo, a.base)
    if why := gitops.branch_clash(repo, a.name):  # a branch `delegate` too (#792)
        shutil.rmtree(task.dir, ignore_errors=True)
        die(why)
    if base and (why := gitops.case_clash(repo, base, task.dir, a.base)):
        shutil.rmtree(task.dir, ignore_errors=True)
        die(why)  # #797: the checkout would have two paths in one file
    store.write_json(task.dir / STARTING, {"repo": str(repo), "worktree": str(wt),
                                           "pid": os.getpid(), "at": store.now(),
                                           "start": models._started(os.getpid()),
                                           "machine": store.machine()})  # whose pid (#876)
    subs = gitops.fill_submodules(repo, base, wt, dry=True)
    budget = a.ask_budget
    # round 1's prompt before task.json: a write that fails leaves a dead start for gc, not a
    # task with no status (#873)
    prompt = spec_text.rstrip() + PROTOCOL.format(branch=gitops.branch_name(a.name),
                                                  test_line=test_line(a.test), budget=budget)
    task.round_dir(1).mkdir(parents=True)
    task.round_dir(1).joinpath("prompt.md").write_text(prompt, encoding="utf-8")
    # from the model's measured speed on this machine, else defaults; its identity (cached:
    # weights_id below) finds the speed it had under an id it was renamed from (#905)
    limits = router.budgets(m, models.identity(m))
    store.write_json(task.dir / "task.json", {
        "name": a.name, "repo": str(repo), "cwd": os.getcwd(), "base": base, "base_ref": a.base,
        # the repository's own git dir: where its branch is once `repo` is removed (#498)
        **({"git_common": str(common)} if (common := gitops.common_dir(repo)) else {}),
        # the Claude Code session whose Bash ran this (_scope, the mod's `mine`); none by hand.
        # And its process: once that is gone, the directory rule may hand the task to a new one
        **({"session": sid} if (sid := os.environ.get("CLAUDE_CODE_SESSION_ID")) else {}),
        # and its machine: on a state directory two machines share, the other's pid means
        # nothing there, and each machine's mod adopted the other's live session's tasks (#922)
        **({"claude_pid": int(pid), "claude_start": models._started(int(pid)),
            "claude_machine": store.machine()}
           if (pid := os.environ.get("CLAUDE_PID", "")).isdigit() else {}),
        "base_branch": gitops.start_branch(repo, a.base),  # where wb accept --merge lands
        # the weights behind the id: a record on other weights under it isn't this model's (#726)
        **({"weights_id": w} if (w := models.identity(m)) else {}),
        "branch": gitops.branch_name(a.name), "model": m.id, "model_label": m.label,
        "opencode_model": m.id, "route": why, "size": a.size, "stack": stack,
        **({"trial": True} if a.trial else {}), "test_cmd": a.test, "test_timeout": a.test_timeout,
        **setup,  # setup, copy, siblings: runner.prepare, before the base check (#201)
        **({"worktree": str(wt.relative_to(task.dir))} if wt != task.dir / "worktree" else {}),
        "checkout": "runner",  # the runner makes the worktree, before its setup (#529)
        # the next start counts it as taken until the runner has made it (#676)
        **({"checkout_bytes": checkout_bytes} if checkout_bytes else {}),
        **({"backlog": a.backlog} if a.backlog else {}),  # a batch left to run: wb backlog
        # a replay of the bench driver's (bench.replay): no notices, no results row, not listed
        **({"bench": b} if (b := getattr(a, "bench", None)) else {}),
        **({"no_base_check": True} if a.no_base_check else {}),
        **({"unload_for_tests": True} if getattr(a, "unload_for_tests", False) else {}),
        **({"sign": False} if a.no_sign else {}),
        **({"subdir": sub} if sub else {}),
        "auto_fix": a.auto_fix, "ask_budget": budget, "ask_timeout": a.ask_timeout,
        # periodic check-ins are opt-in: each wakes Claude, re-reading its whole context, and they
        # were 500K of one task's 1.2M (2026-11-17); the pane shows progress, and the warnings
        # (a nudge, a full window, handovers, a cut base check) still wake
        "checkin": a.checkin or 0, "self_review": a.self_review,
        "experiments": context.task_experiments(),  # what this task's agent has: wb experiment
        "round_timeout": a.round_timeout or limits["round"],
        "silence_timeout": a.silence_timeout or limits["silence"],
        "think_timeout": a.think_timeout if a.think_timeout is not None else limits["think"],
        # the rest stretch when a round measures the model slow (runner.stretch_limits, #814)
        "timeouts_given": [k for k, v in (("round", a.round_timeout), ("silence", a.silence_timeout))
                           if v] + (["think"] if a.think_timeout is not None else []),
        "created_at": store.now(), "wb_version": __version__})
    (task.dir / STARTING).unlink(missing_ok=True)  # a task now: wb discard drops it from here on
    task.set_status(phase="queued", round=1, reviews=0, auto_fixes=0, tools=0,
                    tok_in=0, tok_out=0, session=None, last="starting",
                    opencode=f"{have[0]}.{have[1]}" if have else None,  # runner.opencode_moved
                    skills=handed, skills_ever=handed, skills_rev=skills.revs(handed),
                    # each step's acceptance command, as data: bench add read it back from the
                    # prompt alone, whose one-line pattern missed a command of several lines
                    # (#941, the v1.90.24 review); task.json's test_cmd is only the latest
                    step_tests={"1": a.test})
    exact, tools = context.test_allowances(a.test)
    context.grant(task, "allow", [p.strip() for p in a.allow or [] if p.strip()] + exact)
    context.grant(task, "test_tools", tools)
    context.grant(task, "paths", lane_dirs)
    fixed = _fixed_line(task, m)  # before the runner, which writes the same rules files
    spawn_runner(task)
    print(f"started {a.name} on {m.label} · branch {gitops.branch_name(a.name)} · "
          f"base {base[:8]}" + (f" · tests `{a.test}`, auto-fix {a.auto_fix}" if a.test else ""))
    if a.test and not a.no_base_check:
        print("base check: the runner runs the acceptance command once on the base first; what "
              "it saw comes with the first report (a check-in at once if --test-timeout cuts it "
              "short)")  # a base that passes is a note in that report, no wake (#881)
    if dirty:
        print("note: the repo has uncommitted changes; the agent's worktree starts from "
              f"{a.base}, without them")
    if subs:
        print(f"note: submodules ({', '.join(subs[:5])}) are empty in the agent's worktree (your "
              "checkout lacks them at the base's commit): a build or test that needs them fails there")
    if setup:
        does = [*(["links " + ", ".join(n if n.startswith("../") else f"../{n}" for n in setup["siblings"])]
                  if setup.get("siblings") else []),
                *([f"copies {', '.join(setup['copy'])}"] if setup.get("copy") else []),
                *([f"runs `{setup['setup']}`"] if setup.get("setup") else [])]
        print(f"setup: the runner sets the worktree up first ({'; '.join(does)}); a failure stops "
              "the task before any round")
    elif "repos" not in context.commands_conf() or not context.repo_conf(repo, sub):
        if lack := _missing_dirs(repo, sub):
            print(f"note: the worktree has only committed files, not the checkout's ignored "
                  f"{', '.join(lack[:4])}: --setup '<install command>' sets a task up (--copy "
                  "<path> copies one in); commands.json \"repos\" for every task")
    if context.lane_on() and (gap := context.home_gap()):
        print(f"note: {gap}")
    if proxies := runner.dropped_proxies():  # #380 (the audit of 1.6)
        print(f"note: {runner.proxy_line(proxies)}")
    if venvs := context.venv_line(task, bool(setup and setup.get("setup"))):  # #490
        print(f"note: {venvs}")
    if context.mise_trusted(task) is False:  # #674
        print(f"note: mise doesn't trust {repo}'s config (mise trust --show), so it trusts no "
              "copy of it either: every mise shim fails in the agent's worktree, its setup and its "
              f"tests; `mise trust` in {repo} first, if the task needs its tools")
    if a.backlog and hardware.system() == "wsl" and awake_how() != "windows" and not any(  # #516, #777
            t.spec.get("backlog") == a.backlog for t in store.all_tasks() if t.name != a.name):
        print(f"note: {WSL_SLEEPS}")
    if context.on_windows(str(repo), context.windows_drives()):  # finding 30 (the 2026-11-19 audit)
        print("note: the repo is on a Windows drive, where git is many times slower and wb checks "
              "the worktree at every step: a clone in WSL's own filesystem (~/...) runs faster")
    if fixed:
        print(f"note: {fixed}")
    if drift := runner.untested(have):
        print(f"note: {drift}")
    print(f"model: {why}" if why != "asked for" else f"model: {m.id} (asked for)")
    print(f"slice: {router.slice(m).line()}")
    if gaps := results.spec_gap_line():
        print(gaps)
    if handed:
        print("skills handed: " + ", ".join(handed))
    elif fits := skills.suggest(spec_text):
        use = skills.usage()
        print(f"library skills that may fit: {', '.join(_elsewhere(n, use.get(n), repo, stack) for n in fits)}"
              f" (wb skill hand {a.name} <name>)")
    holding = ", ".join(sorted({h["task"] for h in held.values()}))
    if not state["available"]:
        print(f"note: queued although {state['why']}")
    elif waits:
        print(f"note: the GPU is busy with {holding}; this task waits as queued until it's free")
    elif held:
        print(f"note: it runs beside {holding} on the GPU (their models fit together)")
    elif not state["resident"]:
        print("note: the runner loads it onto the GPU first, unloading what is there")
    if state["available"] and (others := models.box_others(m)):  # another machine's task on the same box (#812)
        print(f"note: {urlparse(m.root).hostname} has {', '.join(others)} loaded, which no task here "
              f"runs: the runner loads {m.name} once it has gone {models.BOX_QUIET} s without a "
              f"request (up to {models.BOX_WAIT // 60} min); {models.BOX_SHARED}")
    measured = (optimize.state().get("models") or {}).get(m.id)
    if measured and (fit := optimize.advice(m.id, measured)):
        print(f"note: {fit} (ask the user first: it adds to their OpenCode config)")
    if gap := runner.handover_warning(m.config):  # #595
        print(f"note: {m.id}: {gap}")
    print(f"next: wb wait {a.name}   (the workbench mod wakes Claude by itself when loaded)")


def _elsewhere(name: str, u: dict | None, repo: Path, stack: list[str]) -> str:
    """A suggested skill, and where it has worked so far when that was only other projects: one
    project's knowledge in the library shouldn't spread unnoticed."""
    seen = {r for r in (u or {}).get("repos") or () if r}
    if not seen or str(repo) in seen:
        return name
    kinds = {k for r in seen for k in router.row_stack({"repo": r})}
    other = f", {'/'.join(sorted(kinds))} work" if kinds and not kinds & set(stack) else ""
    return f"{name} (loaded so far only in {', '.join(sorted(Path(r).name for r in seen))}{other})"


def _spec_gaps(task: store.Task, gaps: list[str] | None) -> None:
    """What the spec missed, by Claude's own account (--spec-gap): a review round the spec cost,
    not the agent. Kept with the task, counted in results, and gathered as lessons."""
    if not gaps:
        return
    rnd = task.status.get("round", 1)
    task.set_status(spec_gaps=(task.status.get("spec_gaps") or [])
                    + [{"round": rnd, "text": g.strip()} for g in gaps])
    for g in gaps:
        task.event({"ts": store.now(), "round": rnd, "kind": "spec_gap", "text": g.strip()})


@one_at_a_time
def cmd_feedback(a):
    task = need(a.name)
    reap(task)
    st = task.status
    if st.get("phase") not in ("review", "stuck", "failed"):
        die(f"{a.name} is {st.get('phase')}; feedback goes to a task waiting for review")
    if why := _accepting(task):  # (#878)
        die(why)
    if runner_alive(task):
        die(f"{a.name}'s runner is still running")
    _need_worktree(task)
    _opencode_again(task)
    text = a.text if a.text is not None else \
        read_text(a.message, "the feedback")
    if not text.strip():  # before anything is written: an empty one cost a round (the audit)
        die("the feedback is empty")
    _spec_gaps(task, a.spec_gap)
    dropped = _stale_notes(task)
    n = st.get("round", 1) + 1
    task.round_dir(n).mkdir(parents=True, exist_ok=True)
    rerun = " re-run the acceptance command and" if task.spec.get("test_cmd") else ""
    task.round_dir(n).joinpath("prompt.md").write_text(
        f"{lessons.FEEDBACK_HEAD} Make exactly these changes, then{rerun} finish with a short "
        "summary:\n\n" + text.strip(), encoding="utf-8")
    reviews = st.get("reviews", 0) + 1
    handled = store.now()  # everything before the new round; what its runner raises stays news
    task.set_status(context="fresh" if a.fresh else "keep" if a.keep_context else None)
    gpu = _gpu_note(task)  # before the task looks live (REAP_GRACE): it may probe model servers
    task.set_status(round=n, reviews=reviews, phase="queued",
                    auto_fixes_total=st.get("auto_fixes_total", 0) + st.get("auto_fixes", 0),
                    auto_fixes=0)
    spawn_runner(task)
    _ack_all(task, upto=handled)
    print(f"feedback round {reviews} sent to {a.name} (round {n})"
          + ("  — that is past the usual 3 review rounds" if reviews > 3 else ""))
    _say(gpu)
    _say_dropped(dropped)
    _say(lessons.nudge(task))


@contextmanager
def _settle_proposals(task: store.Task, take: bool):
    """The agent's proposed instruction files (runner.proposals) are never committed as they are:
    --take-claude-md puts each over its file, else it is dropped. Around the commit, and undone
    when it fails: wb next dropped the proposal, then died on its commit, so a retry with
    --take-claude-md had nothing to take (#507, Claude's audit of 1.90). Said once it stands."""
    done, local = [], {}
    if take and (problem := runner.link_problem(task.worktree)):  # never over a link (#871)
        raise gitops.GitError(problem)
    if take:  # a file git ignores is in no commit: the checkout's own copy takes it (#506)
        for real, prop in runner.proposals(task.worktree):
            rel = real.relative_to(task.worktree)
            if not gitops.ignored(task.worktree, str(rel)):
                continue
            mine = Path(task.spec["repo"]) / rel
            if mine.is_symlink() or not mine.parent.is_dir() or not gitops.ignored(
                    mine.parent, mine.name):
                raise gitops.GitError(
                    f"git ignores {rel}, so no commit would hold the agent's proposal, and "
                    f"{mine} can't take it ({'a link' if mine.is_symlink() else 'not a local file'}"
                    f"): apply {prop} by hand, then accept without --take-claude-md")
            local[real] = mine
    try:
        for real, prop in runner.proposals(task.worktree):
            was = (("link", os.readlink(real)) if real.is_symlink() else
                   ("file", real.read_bytes()) if real.is_file() else None)
            done.append((real, prop, prop.read_bytes(), was))
            if take and real not in local:
                prop.replace(real)
            else:
                prop.unlink()
        yield
    except BaseException:
        for real, prop, data, was in reversed(done):
            prop.write_bytes(data)
            if take and real not in local:
                real.unlink(missing_ok=True)
                if was and was[0] == "link":
                    os.symlink(was[1], real)
                elif was:
                    real.write_bytes(was[1])
        raise
    for real, _, data, _ in done:
        rel = real.relative_to(task.worktree)
        if real in local:  # the commit stands: now the checkout's copy, which no commit holds
            tmp = local[real].with_name(f".{local[real].name}.wb-{os.getpid()}")
            tmp.write_bytes(data)
            if local[real].exists():
                shutil.copymode(local[real], tmp)
            tmp.replace(local[real])
            print(f"took the agent's proposed {rel}: written over {local[real]} (gitignored, "
                  "so in no commit)")
        else:
            print(f"took the agent's proposed {rel}" if take else
                  f"dropped the agent's proposed {rel} (--take-claude-md takes it)")


@one_at_a_time
def cmd_next(a):
    """Commit the approved step on the task's branch and give the same agent the next one: same
    worktree, same session (so it keeps what it has read), unless it is full or --fresh."""
    task = need(a.name)
    reap(task)
    spec, st = task.spec, task.status
    if st.get("phase") != "review":
        die(f"{a.name} is {st.get('phase')}; wb next follows an approved step under review")
    if why := _accepting(task):  # (#878)
        die(why)
    handed = _skill_names(a.skill) if a.skill else None
    if runner_alive(task):
        die(f"{a.name}'s runner is still running")
    _need_worktree(task)
    _opencode_again(task)
    step = st.get("steps", 1)
    try:  # read before anything is committed: a bad path must leave the step as it was
        nxt = read_text(a.spec, "the next step's spec")
    except OSError as e:
        die(f"can't read the next step's spec: {e}")
    if not nxt.strip():
        die("the next step's spec is empty")
    commit = _step_landed(task, step)
    measured = results.step(task, landed=True, since="HEAD~1" if commit else "HEAD", gaps=a.spec_gap)
    if not commit:
        try:
            with _settle_proposals(task, a.take_claude_md):
                # a step that changed nothing advances with no commit: it died on "nothing to
                # commit" and the task stayed on the step (#507, Claude's audit of 1.90)
                if gitops.changed(task.worktree):
                    commit = gitops.commit_all(
                        task.worktree, f"{a.message}\n\nWorkbench-Task: {a.name} (step {step})"
                        f"\nOpenCode-Session: {st.get('session')}", a.include, _signed(spec, a))
        except gitops.GitError as e:
            die(str(e))
    _spec_gaps(task, a.spec_gap)  # after the commit: a retry after a failed one counts them once
    dropped = _stale_notes(task)
    if a.allow or a.test:
        exact, tools = context.test_allowances(a.test)
        context.grant(task, "allow", [p.strip() for p in a.allow or [] if p.strip()] + exact)
        context.grant(task, "test_tools", tools)
    if a.test is not None:  # the one change to task.json after start
        store.write_json(task.dir / "task.json", {**spec, "test_cmd": a.test})
    test = a.test if a.test is not None else spec.get("test_cmd")
    used = ask_mcp.used(task) if "asks" in st else sum(  # the budget is the task's: what's left
        1 for p in (task.dir / "ask").glob("*.json") if not ask_mcp._permission(store.read_json(p, {})))
    budget = max(0, spec.get("ask_budget", 0) - used)
    n = st.get("round", 1) + 1
    task.round_dir(n).mkdir(parents=True, exist_ok=True)
    task.round_dir(n).joinpath("prompt.md").write_text(
        f"Step {step} of this task is done and committed ({commit or 'no changes to commit'}). "
        "The next step:\n\n"
        + nxt.rstrip()
        + PROTOCOL.format(branch=spec["branch"], test_line=test_line(test), budget=budget),
        encoding="utf-8")
    handled = store.now()
    # the next step's comparison base, whether this step committed or not: found by its trailer
    # alone, a step with no changes left the following one with none, and wb verify and wb shot
    # refused it (#652, Claude's and Codex's audits)
    approved = gitops.git(task.worktree, "rev-parse", "HEAD").strip()
    # the step's own active work and progress checks start here: set against a step's typical
    # length, the chain's total put step 2 past it in its first minutes (#815)
    advance = dict(round=n, steps=step + 1, step_round=n, reviews=0, step_base=approved,
                   step_active_s=st.get("active_s") or 0, progress_checks=0,
                   step_sizes=(st.get("step_sizes") or []) + [measured],
                   step_tests={**(st.get("step_tests") or {}), str(step + 1): test},  # #941
                   context="fresh" if a.fresh else None,
                   auto_fixes_total=st.get("auto_fixes_total", 0) + st.get("auto_fixes", 0),
                   auto_fixes=0, phase="queued", last=f"step {step} " + (
                       "committed" if commit else "had no changes") + "; next step queued",
                   **({} if handed is None else dict(
                       skills=handed, skills_ever=_union(st.get("skills_ever"), handed),
                       skills_rev={**(st.get("skills_rev") or {}), **skills.revs(handed)})))
    # The slow part first, the step's whole advance then in one status write right before the
    # runner: fresh_reason exports the session (up to 30 s), and a task queued with no runner
    # that long was reaped as dead (the 0.90 review); written before it, the counters moved
    # while the phase stayed review, and an interrupt there left step 2 sent to no runner, a
    # retry dying on "nothing to commit" and accept closing the task on step 1 (#191, the
    # 2026-11-19 audit). Interrupted before the write, a retry advances from the step's commit.
    why = runner.fresh_reason(task, {**task.status, **advance})
    gpu = _gpu_note(task)
    task.set_status(**advance)
    task.event({"ts": store.now(), "round": n, "kind": "next_step",
                "text": f"step {step} " + (f"committed as {commit}" if commit else
                                           "had no changes") + "; next step sent"})
    spawn_runner(task)
    _ack_all(task, upto=handled)
    print(f"step {step} of {a.name} " + (f"committed as {commit}" if commit else "had no changes")
          + f"; step {step + 1} sent "
          + (f"to a fresh session ({why})" if why else "to the same session"))
    _say(gpu)
    _say_dropped(dropped)
    _say(lessons.nudge(task))


def _accept_landed(task: store.Task) -> bool:
    """Whether the worktree's tip is an earlier wb accept's own commit (`Workbench-Task: <task>`,
    no step) with nothing changed since, as _step_landed for wb next (#879)."""
    try:
        body = gitops.git(task.worktree, "log", "-1", "--format=%B", "HEAD")
        return (f"Workbench-Task: {task.name}" in body.splitlines()
                and not gitops.changed(task.worktree))
    except gitops.GitError:
        return False


def _step_landed(task: store.Task, step: int) -> str | None:
    """The commit an interrupted wb next made for this step before it recorded the next one: the
    worktree's tip carries the step's trailer and nothing has changed since. A retry then
    advances from it once; it died on "nothing to commit" (the 2026-11-18 audit, #85)."""
    try:
        body = gitops.git(task.worktree, "log", "-1", "--format=%B", "HEAD")
        if (f"Workbench-Task: {task.name} (step {step})" not in body.splitlines()
                or gitops.changed(task.worktree)):
            return None
        return gitops.git(task.worktree, "rev-parse", "--short", "HEAD").strip()
    except gitops.GitError:
        return None


def cmd_answer(a):
    task = need(a.name)
    qid = a.id or task.status.get("asking")
    if not qid:
        die(f"{a.name} has no open question")
    if not ask_mcp.QID.match(qid) or not (task.dir / "ask" / f"{qid}.json").exists():
        die(f"no question {qid} in {a.name}")
    if not ask_mcp.is_open(task, qid):  # an answer to it would say "answered" to nobody (the 0.90 review)
        die(f"{qid} is closed: answered, or the agent stopped waiting for it")
    text = a.text if a.text is not None else Path(a.file).read_text(encoding="utf-8")
    if not text.strip():  # the question stays open: an empty answer unblocked the agent (the audit)
        die("the answer is empty")
    if why := ask_mcp.too_long(text):  # the server would never read it (#605)
        die(f"{why} ({task.worktree})")
    handled = store.now()  # the question; a newer notice, raised after the answer, stays news
    # whole, never through a link in the lane, and only while still open: another answer or the
    # runner's NO_ANSWER may have landed since the check above (#938)
    if not ask_mcp.answer_once(task, qid, text):
        die(f"{qid} was already answered (or closed with NO_ANSWER)")
    if (task.status.get("asks") or {}).get(qid) == "q":  # what the Stats tab may call answered:
        # here, outside the lane (an answer file the agent could write itself), never a NO_ANSWER (#562)
        task.set_status(answered=sorted({*(task.status.get("answered") or []), qid}))
    _ack_all(task, upto=handled)
    print(f"answered {a.name}/{qid}")


def _ack_file(task):
    return task.dir / "acked"


_write_ack = store.write_ack  # the runner writes one too (a shutdown's batch, #544)


def _acked(task):
    try:
        return float(_ack_file(task).read_text() or 0)
    except (OSError, ValueError):  # none yet, or garbled: nothing acknowledged
        return 0.0


def _ack_all(task, upto: float | None = None):
    """Claude acted on the task: whatever it was notified about so far is handled, except news
    still true now. A note or a diff run seconds after the task failed must not swallow the
    failure notice Claude hasn't seen: the mark stops just short of it. A command that handles
    the news itself (answer, feedback, next, resume) passes `upto`, the moment it acted: all
    before it is handled, even news still true then (an answered question once came back from
    wb wait, the 2026-11-16 audit), and what its runner raises after it isn't; but the mark still
    stops short of another question still open (answer and allow write their answer first, so
    theirs isn't): answering the first of two acknowledged the second's notice before anything
    delivered it, and the agent waited out the ask timeout (the 0.90 review). Read and written
    under the ack lock claim_ack takes, and never lowered: unlocked, a claim made between the
    read and the write (the mod's `wb ack` of a question) was written over with a lower mark,
    and the same notice was delivered again (#786)."""
    with store.locked(store.task_lock(task.name, "ack")):
        acked = _acked(task)
        phase = task.status.get("phase")
        if upto is None:
            news = "question" if phase == "asking" else "checkin" if phase in LIVE else phase
            pending = [r["ts"] for r in store.notices()
                       if r["task"] == task.name and r["kind"] == news and r["ts"] > acked]
            upto = min(pending) - 0.001 if pending else store.now()
        elif phase == "asking":  # not in review: a question from an older round is closed by then
            still = [r["ts"] for r in store.notices()
                     if r["task"] == task.name and r["kind"] == "question" and r["ts"] > acked
                     and ask_mcp.is_open(task, str(r.get("id") or ""))]
            upto = min([upto, *(ts - 0.001 for ts in still)])
        _write_ack(task, max(acked, upto))  # acked as read under the lock: never lower


def release_ack(task, back: float, mine: float) -> bool:
    """The mod's rollback of a wake the engine dropped or refused (`wb ack <task> <back> --if
    <mine>`): the mark goes back to ``back`` only while it is still ``mine``, the value that
    session set, under the ack lock. Its unconditional write put the old mark back over a notice
    another session or wb wait had claimed since, which was then delivered twice (#786)."""
    with store.locked(store.task_lock(task.name, "ack")):
        if _acked(task) != mine:
            return False
        _write_ack(task, back)
        return True


def claim_ack(task, ts: float) -> bool:
    """Move task's `acked` mark up to ts, unless it is there already: a compare-and-set under the
    task's ack lock, shared by wb wait and the mod (`wb ack`), so one notice is taken once. Each
    read `acked`, then wrote it, and two sessions woken by one `wb events` line both delivered it
    (#687, #696). False: someone took it first."""
    with store.locked(store.task_lock(task.name, "ack")):
        if _acked(task) >= ts:
            return False
        _write_ack(task, ts)
        return True


def cmd_ack(a):
    """The mod's acknowledgement before a wake (claim_ack): exit 3 when another session or a
    wb wait took this notice first."""
    task = need(a.name)
    if a.if_ts is not None:  # a rollback: only over this session's own mark (#786)
        if not release_ack(task, a.ts, a.if_ts):
            die(f"{a.name}: acknowledged since", 3)
        print(f"released {a.name}")
        return
    if not claim_ack(task, a.ts):
        die(f"{a.name}: already acknowledged", 3)
    print(f"acknowledged {a.name}")


def cmd_adopt(a):
    """The mod's claim of a task whose Claude Code process is gone (#687): under the task's command
    lock, task.json's `session`, `claude_pid`, `claude_start` and `claude_machine` (#922) become
    the claimer's, so the first
    session to claim it owns it and the others drop it. Nothing recorded it: once the process that
    ran `wb start` ended, every live session near the task, and the one resumed with `claude
    --resume`, owned it for good, and both woke for its review. The resumed session (its id is the
    task's `session`) stamps its new process the same way. Refused (exit 1) while the recorded
    process lives and isn't the claimer."""
    task = need(a.name)
    pid = a.pid or (int(p) if (p := os.environ.get("CLAUDE_PID", "")).isdigit() else os.getppid())
    start = models._started(pid)
    if pid <= 1 or not models._alive(pid, start):
        die(f"pid {pid} is no running process to give {a.name} to")
    with store.locked(runner.lock_file(a.name, "cmd")):
        spec = dict(task.spec)
        old = spec.get("claude_pid")
        if old == pid and spec.get("claude_start") == start and spec.get("session") in a.session:
            print(f"{a.name} is this session's already")
            return
        if not spec.get("session"):
            die(f"{a.name} records no session: it goes by directory")
        if not _gone(old, spec.get("claude_start"), spec.get("claude_machine")):
            die(f"{a.name} belongs to a live Claude Code session (pid {old}"
                + (" on another machine" if store.elsewhere({"machine": spec.get("claude_machine")})
                   else "") + ")")
        if spec.get("session") not in a.session:
            spec["session"] = a.session[0]
        spec.update(claude_pid=pid, claude_start=start, claude_machine=store.machine())
        store.write_json(task.dir / "task.json", spec)
    print(f"adopted {a.name}")


def _oldest_open(task: store.Task, rows: list[dict]) -> str | None:
    """The id of the task's oldest question still open, by its notice: the one a wait delivers
    next. status.asking lags an answer until the runner's next tick (the 0.90 review)."""
    asked = [r for r in rows if r["task"] == task.name and r["kind"] == "question" and r.get("id")
             and ask_mcp.is_open(task, str(r["id"]))]
    return min(asked, key=lambda r: r["ts"])["id"] if asked else None


def _stale(row, st: dict, oldest: str | None = None) -> bool:
    """A notice no longer true, as the mod judges it: a review, stuck or failed notice for a task
    since sent back, resumed or closed, a question no longer asked, a check-in for a task no
    longer running. Of the questions, only the oldest still open (`oldest`, _oldest_open) is
    news: oldest first, as the runner's status.asking orders them, but judged by the answer
    files, so the second of two is delivered once the first is answered, not the first again
    (the 0.90 review). An old notice without an id stands for whatever is asked."""
    phase = st.get("phase")
    if row["kind"] in ("review", "stuck", "failed"):
        return phase != row["kind"]
    if row["kind"] == "question":
        return phase != "asking" or ("id" in row and row["id"] != oldest)
    if row["kind"] == "checkin":
        return phase not in ("queued", "running", "testing")
    return False


def cmd_wait(a):
    """Block until a task (or any task) raises a notification nobody has acknowledged yet."""
    deadline = time.time() + a.timeout if a.timeout else None
    path = store.home() / "notify.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch()
    watcher = Watcher(store.home(), *([need(a.name).dir] if a.name else []))
    if a.name and (a.repo or a.session or a.all_sessions):
        die("--repo, --session and --all-sessions go with a bare wb wait")
    where, sessions = (None, None) if a.name else _caller(a)
    while True:
        for t in [need(a.name)] if a.name else store.all_tasks():
            if t.status.get("phase") in LIVE:
                reap(t)  # a dead runner's task becomes failed, with the notice this wait delivers
        rows = store.notices()
        # a bare wait takes only the caller's tasks (_caller): one in another session's terminal
        # acknowledged a notice its owner's mod then never woke for (#696)
        theirs = set() if a.name or not (where or sessions) else {
            t.name for t in _scope(store.all_tasks(), where, sessions)[1]}
        for row in reversed(rows):
            if a.name and row["task"] != a.name or row["task"] in theirs:
                continue
            task = store.Task(row["task"])
            if not task.exists or _stale(row, task.status, _oldest_open(task, rows)
                                         if row["kind"] == "question" else None):
                continue  # its directory removed by hand, or no longer true
            # taken under the ack lock: two waits (or a wait and the mod) both printed it (#696)
            if row["ts"] > _acked(task) and claim_ack(task, row["ts"]):
                print(f"[{row['kind']}] {row['task']}\n{row.get('text', '')}")
                return
        if a.name:
            task = need(a.name)
            st = task.status
            phase = st.get("phase")
            if phase in store.CLOSED:
                die(f"{a.name} is closed", 2)
            # Already waiting on Claude, its notice taken by the mod or another waiter: say so
            # now rather than block until a notice that will never come. A task stopped or taken
            # over by hand has none at all (the 2026-11-16 audit: a wait on it blocked forever).
            if phase in store.NEEDS_CLAUDE and (phase == "asking" or not runner_alive(task)):
                want = "question" if phase == "asking" else phase
                mine = [r for r in rows if r["task"] == a.name and r["kind"] == want
                        and not _stale(r, st, _oldest_open(task, rows))
                        and r.get("round", st.get("round")) == st.get("round")]
                if mine:
                    print(f"[{want}] {a.name} (already delivered once)\n{mine[-1].get('text', '')}")
                    return
                if phase == "failed" and st.get("last") == RUNNER_DIED \
                        and time.time() - (st.get("updated_at") or 0) < 10 \
                        and not (deadline and time.time() > deadline):
                    # another wb is reaping it (reap writes the phase, then sweeps, then the
                    # notice): said "no notice", and the notice came again on the next wait (the
                    # 0.90 review). Bounded: a reaper killed meanwhile ends in "no notice".
                    watcher.wait(1.0)
                    continue
                if phase != "asking":  # a question always has its notice, which carries its id
                    print(f"[{phase}] {a.name} (no notice: {st.get('last') or phase})")
                    return
        elif not any(t.status.get("phase") not in store.CLOSED and t.name not in theirs
                     for t in store.all_tasks()):
            die("no open tasks to wait for (wb status --all)"
                + (" in this session (--all-sessions waits on every session's)" if theirs else ""), 2)
        if deadline and time.time() > deadline:
            die("timed out waiting", 2)
        # woken by the change itself; the minute bound re-checks the runner is alive
        watcher.wait(min(60.0, deadline - time.time()) if deadline else 60.0)


def cmd_watch(a):
    """The live conversation between Claude and the agent: for a person, in a terminal."""
    if a.name:
        task = need(a.name)
    else:
        # not a wb bench replay, as wb status leaves them out: a bare watch followed one (#555)
        tasks = sorted((t for t in store.all_tasks() if not t.spec.get("bench")),
                       key=lambda t: t.status.get("updated_at") or 0)
        live = [t for t in tasks if t.status.get("phase") not in store.CLOSED]
        if not tasks:
            die("no tasks yet")
        task = (live or tasks)[-1]
    try:
        transcript.follow(task, verbose=a.verbose, once=a.once or a.json, as_json=a.json,
                          color=False if a.no_color else None, last=a.last if a.json else 0,
                          reap=reap)
    except KeyboardInterrupt:
        print()
    except BrokenPipeError:  # piped into head/less and the reader quit
        sys.stdout = open(os.devnull, "w")


def _gone(pid, start=None, machine=None) -> bool:
    """Whether the Claude Code process a task recorded (task.json `claude_pid`) has exited. One we
    can't signal isn't it either: it ran as this user. Nor is one that started at another time
    than `claude_start` says: the pid was recycled, and a new `claude` in the project never
    adopted the task (#532). Unknown (no pid) is not gone, nor is one of another machine
    (`claude_machine`): its pid means nothing here, and on a shared state directory each
    machine's session adopted the other's tasks, back and forth (#922, as store.elsewhere, #849)."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if isinstance(machine, str) and machine and machine != store.machine():
        return False
    return not models._alive(pid, start if isinstance(start, str) else None)


def _scope(tasks, where, sessions=None):
    """The tasks of one Claude Code session, as the mod names it: `sessions` (`--session`, every
    id its process has had: /clear starts another) and `where` (`--repo`, its directory). A task
    `wb start` recorded a session for (task.json `session`) is that session's, wherever it ran;
    once the Claude Code process it ran in is gone (`claude_pid`, `_gone`), the directory rule
    claims it too, so a new process in the project adopts the old one's tasks (the 0.90 review:
    after a crash or an update, plain `claude` in the same repo was woken for none of them, and
    its quit left them running for nobody). One without a session (started by hand, or before
    0.90), or with no `sessions` given (by hand), goes by directory: its `repo` is `where`
    or inside it, or `where` is inside the task's spot (its package, repo/subdir; else its `cwd`
    inside the repo; else the repo, #695), or its `cwd` (where wb start ran) is `where` or inside it. A session
    in the home directory or / claims none by directory. A task with neither key is everyone's.
    The others belong to another session, which its mod wakes and its quit commands stop (the
    2026-11-16 audit: two projects at once, one session's /workbench-quit stopped the other's
    agents; the 0.90 review: a task started from ~ belonged to every session under it, and one
    started after a `cd` elsewhere to none). Returns (mine, others)."""
    if not where and not sessions:
        return list(tasks), []
    # real paths on both sides, in lower case where the file system ignores case (macOS): a
    # symlinked project, /tmp against /private/tmp, or ~/Repos typed for ~/repos once missed
    # (the 2026-11-19 audit)
    fold = bool(where) and _folds_case(where)
    real = lambda p: Path(os.path.realpath(p).lower() if fold else os.path.realpath(p))  # noqa: E731
    here = real(where) if where else None
    broad = here in (real(Path.home()), Path("/"))
    mine, others = [], []
    for t in tasks:
        sid, cwd, repo = (t.spec.get(k) for k in ("session", "cwd", "repo"))
        cwd, repo = cwd and real(cwd), repo and real(repo)
        # a session inside the task's own spot: its package (repo/subdir), else where wb start ran
        # when that is inside the repo, else the repo. Inside the repo alone, a session in a
        # monorepo's sibling package claimed the task and was woken for its review (#695)
        sub = t.spec.get("subdir")
        spot = repo and (real(repo / sub) if sub else cwd if cwd and cwd.is_relative_to(repo) else repo)
        # Path.is_relative_to compares whole components: /x/ab isn't inside /x/a
        near = here is not None and not broad and bool(
            cwd and cwd.is_relative_to(here)
            or repo and (repo.is_relative_to(here) or here.is_relative_to(spot)))
        if sessions and sid:
            ok = sid in sessions or near and _gone(t.spec.get("claude_pid"), t.spec.get("claude_start"),
                                                   t.spec.get("claude_machine"))
        elif here is None or (not cwd and not repo):
            ok = True
        else:
            ok = near
        (mine if ok else others).append(t)
    return mine, others


def _caller(a) -> tuple:
    """The scope (`where`, `sessions`) a command without `--repo`/`--session` takes: run from
    Claude Code's Bash (CLAUDE_CODE_SESSION_ID set), the calling session's, as the mod passes it:
    every id its process has had (`claude-sessions/<CLAUDE_PID>`, store.claude_sessions) and the
    directory it runs in; `--all-sessions`, or a terminal, every session's. Plain `wb status`,
    which the skill and the compaction note send Claude to, listed every session's open tasks
    as one, so one session could review, accept or discard another's (#693)."""
    repo, sessions = getattr(a, "repo", None), getattr(a, "session", None)
    if repo or sessions or getattr(a, "all_sessions", False):
        return repo, sessions
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    if not sid:
        return None, None
    pid = os.environ.get("CLAUDE_PID", "")
    # this process's ids only: a dead one's under the same pid were taken for its own (#787)
    ids = list(dict.fromkeys([*(store.claude_sessions(pid, start=models._started(int(pid)))
                                if pid.isdigit() else []), sid]))
    return os.getcwd(), ids


def _folds_case(path) -> bool:
    """Whether the file system holding ``path`` ignores case: the path with every letter's case
    swapped is the same directory (APFS and HFS+ as macOS formats them; not ext4)."""
    p = os.path.realpath(path)
    try:
        return p.swapcase() != p and os.path.samefile(p, p.swapcase())
    except OSError:
        return False


def _others_line(others, what):
    if others:  # by name: all_tasks' order follows the file system's (flaky in CI on 0.90's merge)
        return (f"{what} (other sessions'): "
                + ", ".join(f"{t.name} ({t.spec.get('repo')})"
                            for t in sorted(others, key=lambda t: t.name)))
    return ""


def cmd_status(a):
    tasks = [need(a.name)] if a.name else [t for t in store.all_tasks()  # replays: wb bench report
                                           if a.all or (t.status.get("phase") not in store.CLOSED
                                                        and not t.spec.get("bench"))]
    tasks, others = (tasks, []) if a.name else _scope(tasks, *_caller(a))
    parked = [] if a.name or a.all else [t for t in tasks if store.parked(t.status)]
    tasks = [t for t in tasks if t not in parked]
    others = [t for t in others if a.all or not store.parked(t.status)]
    parked_line = (f"parked by wb stop --all (/workbench-quit): {', '.join(t.name for t in parked)}; "
                   "leave them unless the user asks (wb status --all lists them)") if parked else None
    if not tasks:
        print("no open tasks" + ("" if a.all else " (wb status --all shows closed ones)"))
        _say(parked_line)
        _say(_others_line(others, "open elsewhere"))
        return
    print(f"{'task':22} {'phase':9} {'rnd':>3} {'model':16} {'age':>5} {'idle':>5}  last")
    for t in tasks:
        if t.status.get("phase") in LIVE:
            reap(t)
        st, sp = t.status, t.spec
        phase = "parked" if store.parked(st) else st.get("phase", "?")
        if phase in store.ACTIVE and not runner_alive(t) and phase != "asking":
            phase += "?"  # the runner died seconds ago (reap waits REAP_GRACE)
        short = sp.get("model", "").split("/")[-1][:16]
        on = f"on {where}: " if st.get("pid") and (where := store.elsewhere(st)) else ""  # #849
        print(f"{t.name:22} {phase:9} {st.get('round', 1):>3} {short:16} "
              f"{ago(sp.get('created_at')):>5} {ago(st.get('updated_at')):>5}  "
              f"{(on + (st.get('last') or ''))[:70]}")
    if a.name and tasks[0].worktree.is_dir():
        print(f"worktree: {tasks[0].worktree}")
    _say(parked_line)
    _say(_others_line(others, "open elsewhere"))


def cmd_log(a):
    task = need(a.name)
    off = 0
    rows, off = store.read_jsonl(task.dir / "events.jsonl", off)
    # the agent's words and output, on a terminal: no raw escape sequences (transcript.plain)
    shown = transcript.plain if sys.stdout.isatty() else str

    # the agent's text, its tool calls, and every kind wb watch shows (transcript.EVENT_KINDS):
    # a fixed nine once left out the runner's own rows, a gpu or handover among them (#861)
    kinds = {"text", "tool"} | transcript.EVENT_KINDS

    def show(r):
        t = time.strftime("%H:%M:%S", time.localtime(r.get("ts") or 0))
        k = r.get("kind")
        if k == "tool":
            mark = "" if r.get("ok") else "  ✗ " + r.get("error", "")[:100]
            # flushed: piped or redirected, a follow printed nothing for minutes (#545)
            print(shown(f"{t} r{r.get('round')} {r.get('tool', ''):8} {r.get('brief', '')}{mark}"), flush=True)
        elif k in kinds:
            body = str(r.get("text") or "")
            if k == "text" and not a.verbose:
                body = body.strip().splitlines()[0][:110] if body.strip() else ""
            print(shown(f"{t} r{r.get('round')} {k:8} {body}"), flush=True)

    # -n counts the lines printed: the last N rows, cut before the filter, held step rows (one
    # per model request) that never print, and `-n 30` showed a dozen lines (#861)
    rows = [r for r in rows if r.get("kind") in kinds]
    for r in rows[-a.n:] if a.n else rows:
        show(r)
    watcher = Watcher(task.dir) if a.follow else None
    while a.follow:
        # the phase before the wait, then the events after it: a finished task's follow waited 30 s
        # before it looked (the 2026-11-18 audit, #90), and the last events still print. A runner
        # that died without a word is reaped first, as wb wait does: its task was followed for
        # ever, still "running" (#545); reap's error event then prints and the follow ends
        if task.status.get("phase") in LIVE:
            reap(task)
        done = task.status.get("phase") in store.NEEDS_CLAUDE | store.CLOSED
        if not done:
            watcher.wait(30)
        more, off = store.read_jsonl(task.dir / "events.jsonl", off)
        for r in more:
            show(r)
        if done:
            break


def cmd_report(a):
    task = need(a.name)
    n = a.round or task.status.get("round", 1)
    p = task.round_dir(n) / "summary.md"
    text = p.read_text() if p.exists() else (f"round {n} has no report yet "
                                             f"({task.status.get('phase')}: {task.status.get('last')})")
    print(transcript.plain(text) if sys.stdout.isatty() else text)  # it quotes the agent's words
    if (r := verify.last(task)) and not a.round:  # the live comparison, at review (#97)
        print("\n" + "\n".join(verify.lines(r)) + (
            "\n  (stale: the worktree has changed since; run wb verify again)" if r["stale"] else ""))


def cmd_diff(a):
    """The work under review: the whole task, or after `wb next` the current step (--all: all)."""
    task = need(a.name)
    # the accepted commit, not the branch: --merge deletes the branch (#477, the audit of 1.8)
    tip = (task.status.get("tip") or "")[:12] or task.spec["branch"]
    repo = shlex.quote(str(gitops.repo_of(task.spec)))
    if not task.worktree.is_dir():
        die(f"{a.name} is {task.status.get('phase')} and its worktree is gone: "
            f"git -C {repo} diff {task.spec['base'][:12]} {tip}")
    base = "HEAD" if task.status.get("steps", 1) > 1 and not a.all else task.spec["base"]
    try:
        print(gitops.diff(task.worktree, base, stat=a.stat, paths=a.paths) or "(no changes)")
    except gitops.GitError as e:
        die(f"{e}\nthe branch's commits: git -C {repo} diff {task.spec['base'][:12]} {tip}")


def _stop_runner(task):
    pid = task.status.get("pid")
    if pid and (where := store.elsewhere(task.status)):  # #849: its pid here is another process
        if runner_alive(task):
            die(f"{task.name} runs on {where}, which shares this state directory: stop it there "
                f"(once its runner stops beating for {BEAT_DEAD // 60} min, here too)")
        return  # dead there (#872): nothing to signal, and nothing of it runs here to sweep
    if pid and runner_alive(task):
        task.set_status(stopping=True)  # wb's stop, not a shutdown's (runner.SIGNAL_STOP)
        try:
            os.kill(pid, signal.SIGTERM)  # the runner stops its agent's process group itself
        except ProcessLookupError:
            pass
        else:
            if not wait_exit(pid, 15):  # it stops its agent first; past that, end it all
                for group in (pid, task.status.get("agent_pid")):  # the agent has a session of its own
                    try:
                        if group:
                            os.killpg(group, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
    runner.sweep(task)  # whatever the agent left running, the runner dead or alive


LIVE = ("queued", "running", "testing", "asking")


def _open_tasks():
    return [t for t in store.all_tasks()
            if t.status.get("phase") not in store.CLOSED
            and (runner_alive(t) or t.status.get("phase") in LIVE)]




def stop_everything(tasks=None) -> list[str]:
    """`wb stop --all`: every agent (or those of `tasks`). Nothing is finished or thrown away:
    tasks keep their worktrees (stopped, for wb feedback or wb discard later)."""
    stopped = []
    for t in _open_tasks() if tasks is None else tasks:
        # each task under its command lock, as one_at_a_time (which --all skips): an accept or
        # discard that closed it after the listing was set back to stuck (the 0.90 review)
        with store.locked(runner.lock_file(t.name, "cmd")):
            if t.status.get("phase") in store.CLOSED or (t.status.get("pid") and store.elsewhere(
                    t.status) and runner_alive(t)):
                continue  # another machine's live runner (#849): that machine's wb stops it
            _stop_runner(t)
            t.event({"ts": store.now(), "round": t.status.get("round"), "kind": "stopped",
                     "by": "user", "text": "bail out: stopped by the user"})
            t.set_status(phase="stuck", last="bail out: stopped", pid=None,
                         parked=store.now())  # out of the status line and new sessions (#541)
            _ack_all(t)
            stopped.append(f"{t.name} (worktree kept: {t.worktree})")
    return stopped


def _park_waiting(a) -> str:
    """`wb stop --all --park-waiting` (the mod's /workbench-quit): the scope's tasks waiting on
    Claude (review, stuck, failed, no runner) parked as they stand, their news acknowledged, so
    the status line, the pick-up block and the jobs' gate leave them until the user asks. Only the
    running ones were parked, and a review left at the quit stayed "awaiting review" and was handed
    to every new conversation, against the quit (#698)."""
    waiting, _ = _scope([t for t in store.all_tasks() if t.status.get("phase") in store.PARKS
                         and not store.parked(t.status) and not runner_alive(t)], *_caller(a))
    parked = []
    for t in waiting:
        with store.locked(runner.lock_file(t.name, "cmd")):
            if t.status.get("phase") not in store.PARKS or runner_alive(t):
                continue  # picked up meanwhile
            t.set_status(parked=store.now())
            _ack_all(t, upto=store.now())  # its news too, still true: the mod would wake for it
            parked.append(t.name)
    return f"parked as they stand (waiting on Claude): {', '.join(parked)}" if parked else ""


@one_at_a_time
def cmd_stop(a):
    if a.all:
        # everything, without --repo/--session: the bench's driver too, first, so it starts nothing
        driver, far = None, ""
        if not (a.repo or a.session):
            try:
                driver = bench.stop_driver()
            except RuntimeError as e:  # another machine's run: that one's to stop there, and the
                far = str(e)           # bail-out died before stopping any task here (#876 review)
        mine, others = _scope(_open_tasks(), *_caller(a))
        stopped = ([f"wb bench (pid {driver})"] if driver else []) + stop_everything(mine)
        print("stopped: " + ("; ".join(stopped) if stopped else "nothing was running"))
        _say(_others_line(others, "left running"))
        _say(far and f"left running: {far}")
        if a.park_waiting:
            _say(_park_waiting(a))
        return
    if a.repo or a.session or a.park_waiting:
        die("--repo, --session and --park-waiting go with --all")
    if not a.name:
        die("name a task, or --all")
    task = need(a.name)
    if task.status.get("phase") not in LIVE and not runner_alive(task):
        die(f"{a.name} is {task.status.get('phase')}, not running")
    _stop_runner(task)
    task.set_status(phase="stuck", last="stopped by the reviewer", pid=None)
    _ack_all(task)  # else the mod's safety net wakes Claude about the stop it just made
    print(f"stopped {a.name}; wb resume continues it in a fresh session, wb feedback with "
          "corrections, wb discard drops it")


ALL_SESSIONS = ("every Claude Code session's tasks (from Claude Code's Bash, the default is the "
                "calling session's: _caller)")


# What `wb update --stop` leaves in status `last` (#694): resumed like a restart's
UPDATE_STOP = "stopped for a workbench update (wb update --stop), not by Claude"
# What `wb resume --all` continues: tasks interrupted from outside, not those stopped for a
# reason of their own (a guard, a crash, a failed load), which want Claude's look first (#544)
INTERRUPTED = (RESTARTED, RUNNER_DIED, runner.SIGNAL_STOP, UPDATE_STOP)


def _interrupted(last) -> bool:
    """Whether status `last` says the task was interrupted from outside: one of INTERRUPTED, or
    runner._updated's (runner.UPDATED, then the task's own `wb resume <name>`), which no exact
    match could ever hit: after a pull under running tasks, wb resume --all resumed none (#788).
    And runner.opencode_moved's, OpenCode changed under it (#866)."""
    return last in INTERRUPTED or isinstance(last, str) and last.startswith(
        (runner.UPDATED + ":", runner.OPENCODE_MOVED + " ("))


@one_at_a_time
def cmd_resume(a):
    """Continue a task Claude stopped (wb stop) where the work stands: a fresh session, handed
    the task, the work so far and what the step's rounds asked. Not a review round. --all: every
    task in scope a restart, a kill or a signal interrupted, in the order they were started."""
    if a.name and a.all:
        die("give a task or --all, not both")
    if (a.repo or a.session or a.backlog) and not a.all:
        die("--repo, --session and --backlog go with --all")
    if a.more:  # a restart's or a signal's batch, as its notice names it (#692)
        names = list(dict.fromkeys([a.name, *a.more]))
        tasks = sorted((need(n) for n in names), key=lambda t: t.spec.get("created_at", 0))
        failed = []
        for t in tasks:  # the order they were started, which the GPU queue follows
            with store.locked(runner.lock_file(t.name, "cmd")):  # as one_at_a_time, task by task
                try:
                    _resume(t)
                except SystemExit:  # said on stderr, as a lone resume would; the rest go on
                    failed.append(t.name)
        if failed:
            die(f"not resumed: {', '.join(failed)}")
        return
    if not a.all:
        if not a.name:
            die("name a task, or --all")
        return _resume(need(a.name))
    tasks = [t for t in store.all_tasks() if t.status.get("phase") in LIVE + ("stuck", "failed")]
    for t in tasks:
        reap(t)
    tasks = [t for t in tasks if t.status.get("phase") in ("stuck", "failed")
             and _interrupted(t.status.get("last")) and not runner_alive(t)
             and (not a.backlog or t.spec.get("backlog") == a.backlog)]
    tasks, _ = _scope(tasks, *_caller(a))
    if not tasks:
        print("nothing to resume: no task in scope was interrupted (a restart, a kill, a signal or an "
              "update)")
        return
    for t in tasks:  # all_tasks' order: the order they were started, which the GPU queue follows
        if not _rechecks_out(t) and (why := _worktree_problem(t)):
            print(why)  # as _resume would say it, without ending the batch
            continue
        with store.locked(runner.lock_file(t.name, "cmd")):  # as one_at_a_time, task by task
            _resume(t)


def _first_round(st: dict) -> bool:
    """It never ran a round: queued behind the GPU, its model, its checkout or the base check."""
    return st.get("round", 1) == 1 and not st.get("round_started_at") and not st.get("session")


def _rechecks_out(task: store.Task) -> bool:
    """A task interrupted from outside before its checkout finished: its runner makes the
    checkout again from nothing (runner.checkout), so it resumes at round 1 (#529, #544). One
    whose checkout failed still goes through wb discard."""
    st = task.status
    return _first_round(st) and not runner.checked_out(task) and _interrupted(st.get("last"))


def _resume(task: store.Task) -> None:
    reap(task)
    st, name = task.status, task.name
    if st.get("phase") not in ("stuck", "failed"):
        die(f"{name} is {st.get('phase')}; wb resume continues a stopped task")
    if why := _accepting(task):  # (#878)
        die(why)
    if runner_alive(task):
        die(f"{name}'s runner is still running")
    if not _rechecks_out(task):
        _need_worktree(task)
    _opencode_again(task)
    n = st.get("round", 1)
    if _first_round(st):
        # it never ran a round (queued behind the GPU, its model or the base check): round 1
        # again, its prompt as wb start wrote it, not "Claude stopped your last session…"
        handled = store.now()
        gpu = _gpu_note(task)
        task.set_status(phase="queued", last="resumed by the reviewer")
        task.event({"ts": store.now(), "round": 1, "kind": "resumed",
                    "text": "Claude resumed the task: it starts its first round again"})
        spawn_runner(task)
        _ack_all(task, upto=handled)
        print(f"resumed {name}: its first round, which it never ran")
        _say(gpu)
        return
    asks = runner.round_asks(task, n)
    notes = _stale_notes(task)  # resume means carry on: a note never delivered still applies
    task.round_dir(n + 1).mkdir(parents=True, exist_ok=True)
    task.round_dir(n + 1).joinpath("prompt.md").write_text(runner.RESUME.format(
        asked=runner.ASKED.format("\n\n".join(asks)).rstrip() if asks else "")
        + (f"\n\n{runner.folded_notes(task, n + 1, notes)}" if notes else ""))
    handled = store.now()
    gpu = _gpu_note(task)  # before the task looks live (REAP_GRACE): it may probe model servers
    task.set_status(round=n + 1, context="fresh", phase="queued", last="resumed by the reviewer")
    task.event({"ts": store.now(), "round": n + 1, "kind": "resumed",
                "text": "Claude resumed the task in a fresh session"})
    spawn_runner(task)
    _ack_all(task, upto=handled)  # the stuck or failed notice is handled: wb wait must not hand it out again
    print(f"resumed {name} in a fresh session (round {n + 1})")
    _say(gpu)
    _say(lessons.nudge(task))


def _lane_dir(raw: str, guard: set[str] = frozenset()) -> str:
    """A directory Claude adds to an agent's lane, made if it isn't there yet (the kernel's rule
    is on a real directory). Not through a link: the agent can plant one in its lane (/tmp/out ->
    another project), and the grant went to the link's target (the 2026-11-16 audit), so Claude
    names the real directory itself; nor a place the lane hides (context.lane_refusal); nor a
    place in the task's repo or its git directory (`guard`, context.repo_dirs), which
    context.writable leaves out of every lane: the grant was said "allowed", the agent restarted,
    and its retry was refused again (the 0.90 review). One that holds the repo is split around it."""
    if raw == "*":
        return raw  # the lane off for this task
    given = os.path.abspath(os.path.expanduser(raw))
    real = os.path.realpath(given)
    if real != given:
        die(f"{raw} is a link to {real}: allow {real} itself if that is what the task needs")
    if why := context.lane_refusal(real) or context.kept_out(real):
        die(why)  # kept_out: writable() would split the grant away, the retry refused (#912)
    if any(real == g or context._under(real, g) for g in guard):
        die(f"{raw}: inside the task's own repo or its git directory, which no lane may write (wb's "
            "git runs there, and a hook planted in it would run outside the lane); take what the "
            "task needs there yourself")
    path = Path(real)
    # a file not made yet (debug.keystore, a lockfile) is no directory: made as one, it broke the
    # next round's keytool or Gradle with 'Is a directory' and stayed (#670)
    if not path.exists() and path.suffix:
        die(f"{raw} doesn't exist and its name looks like a file's: allow the directory it goes "
            f"in ({path.parent}), or make {raw} first if it is a directory")
    if not path.exists():
        path.mkdir(parents=True)
    return str(path)


def _permission_asked(task: store.Task) -> str | None:
    """The oldest permission request still open. status.asking is the oldest question of any
    kind, and `wb allow` answered a plain question asked before the request with its leave,
    the request left open (the 0.90 review)."""
    def made(qid):
        try:
            return (task.dir / "ask" / f"{qid}.json").stat().st_mtime
        except OSError:  # the agent can delete its ask files
            return float("inf")
    perms = [q for q, k in (task.status.get("asks") or {}).items()
             if k == "p" and ask_mcp.is_open(task, q)]
    return min(perms, key=lambda q: (made(q), q), default=None)


def cmd_allow(a):
    """Let a task's agent run commands outside the everyday list (context.ALLOWED_COMMANDS), or
    use a directory outside its lane (--path, context.writable): for this task, or --always for
    every task. A pending request is answered, and a running agent is restarted on its session at
    once so the new rule applies (OpenCode reads it at start, the lane is drawn at start)."""
    task = need(a.name)
    pats = [p.strip() for p in a.pattern if p.strip()]
    dirs = [_lane_dir(p, context.repo_dirs(task)) for p in a.path or [] if p.strip()]
    if not pats and not dirs:
        die("nothing to allow")
    context.commands_conf()  # refused unless it parses, before any grant: rewriting it would lose it
    said = ", ".join([f"`{p}`" for p in pats] + [f"the directory {d}" for d in dirs])
    text = (f"Claude allowed {said}" + (" from now on" if a.always else " for this task")
            + ". Run it again now and carry on." + (f" {a.text.strip()}" if a.text else ""))
    # the answer as written, before any grant (#605): a guess at the words around --text let
    # many patterns past it, the grants were saved and write_answer's refusal was a traceback
    if why := ask_mcp.too_long(text):
        die(f"--text: {why} ({task.worktree})")
    for key, new in (("allow", pats), ("paths", dirs)):
        if not new:
            continue
        context.grant(task, key, new)
        if a.always:
            context.allow_always(key, new)
    task.event({"ts": store.now(), "round": task.status.get("round"), "kind": "allow",
                "text": f"allowed {said}" + (" always" if a.always else "")})
    qid = _permission_asked(task) or task.status.get("asking")
    handled = None
    if qid and ask_mcp.is_open(task, qid):
        handled = store.now()  # the request is answered: handled, as wb answer does
        if not ask_mcp.answer_once(task, qid, text):  # answered or closed meanwhile (#938)
            handled = None
    if (phase := task.status.get("phase")) in LIVE and runner_alive(task):
        store.append_jsonl(task.dir / "steer.jsonl", {"ts": store.now(), "text": text, "now": True})
        print(f"allowed {said} on {a.name}" + (" (always)" if a.always else "") + ": "
              + _when_delivered(task, phase, "the agent restarts on its session with it"))
    else:
        print(f"allowed {said} on {a.name}" + (" (always)" if a.always else "")
              + ": it applies from the next round")
    _ack_all(task, upto=handled)


def cmd_steer(a):
    """A note to a running agent: delivered when its current run ends, or at once with --now."""
    task = need(a.name)
    reap(task)
    phase = task.status.get("phase")
    if phase not in ("queued", "running", "testing", "asking") or not runner_alive(task):
        die(f"{a.name} is {phase}, not running: use wb feedback (or wb answer for a question)")
    text = (Path(a.message).read_text() if a.message else a.text).strip()
    if not text:
        die("empty note")
    if a.step:  # a smaller step: the agent finishes this part and stops (#95)
        text = STEP_NOTE + text
    store.append_jsonl(task.dir / "steer.jsonl", {"ts": store.now(), "text": text, "now": a.now})
    task.event({"ts": store.now(), "round": task.status.get("round"), "kind": "steer",
                "now": a.now, "text": text})
    if progress.record(task, "smaller" if a.step else "hint"):
        print("recorded as the answer to the progress check: whether it helped is learned at "
              "accept or discard")
    if phase in ("testing", "queued"):
        print(f"note queued for {a.name}: " + _when_delivered(task, phase, ""))
    elif a.now:
        print(f"interrupting {a.name}: it stops within a few seconds and continues with your note")
    else:
        print(f"note queued for {a.name}: delivered when its current run ends, before the tests")


STEP_NOTE = ("A smaller step: do only this now, then stop and report; the rest of the task waits "
             "for the next step.\n\n")  # what a smaller step's note says first (#95)


def cmd_progress(a):
    """The user's opt-in to progress checks (#95): on, off, or what it is. --after alone moves
    the threshold of checks already on (it was ignored, and "on: …" printed as if saved: #602)."""
    if a.after is not None and a.state == "off":
        die("--after goes with on: wb progress on --after MIN")
    if a.after is not None and not a.state:
        if not progress.settings().get("on"):
            die("progress checks are off: wb progress on --after MIN")
        a.state = "on"
    if a.state:
        progress.set_enabled(a.state == "on", a.after)  # --after kept unless given (0 clears it, #578)
    s = progress.settings()
    print("progress checks: " + (f"on: a task past {s['after']:g} min of active work" if s.get("after")
                                  else "on: a task past its typical length of active work (until a model "
                                  f"and size have {progress.TYPICAL_MIN} timed tasks: "
                                  + ", ".join(f"{m} min {k}" for k, m in progress.DEFAULT_MIN.items()) + ")")
          + " gets a check and a recommendation, again at 2x and 4x it" if s.get("on") else
          "progress checks: off (the default): check-ins only as --checkin sets them")


def _when_delivered(task: store.Task, phase: str, running: str) -> str:
    """When a note reaches the agent: --now promised "within a few seconds" while the tests ran
    (up to the test timeout) or the task waited for the GPU (the 2026-11-16 audit), and the
    GPU's wait before a round's tests (--unload-for-tests) read as `running` (#943's review)."""
    if phase == "testing":
        return (f"its tests are running (up to {int(task.spec.get('test_timeout') or 900)}s); "
                "the agent gets it when they end")
    if phase == "queued":
        return ("it is waiting for the GPU or its model, before a round or a round's tests; the "
                "agent gets it when the round starts, or once the tests end")
    return running


def cmd_note(a):
    """Claude's own words in the task's transcript: a captain's log entry the user sees."""
    task = need(a.name)
    task.event({"ts": store.now(), "round": task.status.get("round"), "kind": "captain",
                "text": a.text.strip()})
    _ack_all(task)
    print(f"noted on {a.name}")


def _coding_gate(task: store.Task, user: bool) -> None:
    """Claude coding (#92): taking a task over is writing its code, so outside "Let Claude decide"
    it needs the user: their yes recorded for this task (wb coding allow), or their own command
    (the hand-back, which passes --user)."""
    mode = coding_mode()
    if mode == "decide" or user or coding_allowed(task):
        return
    if mode == "ask":
        die(f"Claude coding is {CODING['ask'][0]}: ask the user, naming the exact edit; on their "
            f"yes, wb coding allow {task.name} --edit \"…\" --said \"<their words>\", then take it "
            "over. Unanswered, the work stays with the agent", 3)
    die(f"Claude coding is {CODING['only'][0]}: report the blocker to the user and keep the work "
        f"with the agent (wb feedback, a smaller step); they say when Claude writes code "
        f"(then wb coding allow {task.name} --edit \"…\" --said \"<their words>\")", 3)


def experiment_lines() -> list[str]:
    """One line per experiment: its setting and whether it can work here (probe installed)."""
    on = context.experiments()
    out = []
    for name in context.EXPERIMENTS:
        if not on[name]:
            out.append(f"{name}: off (wb experiment {name} on)")
        elif name == "probe" and not (path := context.probe_bin()):
            out.append(f"{name}: on, but not set up: no probe with `symbols` is on PATH, so it "
                       f"changes nothing yet (probe, a code-search tool: {context.PROBE_HOME}; "
                       f"its release binary from {context.PROBE_RELEASES}, not crates.io's "
                       "probe-code 0.6.0)")
        else:
            found = _tool_version([path])[1] if name == "probe" else ""
            out.append(f"{name}: on" + (f" and working ({found})" if found else ""))
    return out


def cmd_experiment(a):
    """List the experiments, or turn one on or off for the tasks started from now on."""
    if a.name is None:
        for name, what in context.EXPERIMENTS.items():
            print(f"{name}: {what}")
        print("\n".join(experiment_lines()))
        return
    if a.name not in context.EXPERIMENTS:
        die(f"no experiment {a.name} (wb experiment lists them)")
    if a.state is not None:
        context.set_experiment(a.name, a.state == "on")
    print(next(r for r in experiment_lines() if r.startswith(f"{a.name}:"))
          + ("; tasks already started keep theirs" if a.state is not None else ""))


def cmd_coding(a):
    """Show or set when Claude may write code for a delegated task, or record the user's yes
    for one task (#92)."""
    if a.what == "used":
        if not a.task or not a.did:
            die("wb coding used <task> --did \"<what Claude changed>\"")
        task = need(a.task)
        rows = _allowances(task)
        i = next((i for i, x in enumerate(rows) if not x.get("used")), None)
        if i is None:
            die(f"{a.task} has no allowance to use: the user's yes comes first (wb coding allow)")
        rows[i] = {**rows[i], "used": store.now(), "did": a.did}
        store.write_json(task.dir / "coding.json", {"allowed": rows})
        task.event({"ts": store.now(), "round": task.status.get("round"), "kind": "coding",
                    "text": f"Claude used the user's allowance: {a.did}"})
        print(f"{a.task}: recorded. Hand the testing back to the agent: wb feedback {a.task} "
              "--message <file> (what you changed, and what it checks next)")
        return
    if a.what == "allow":
        if not a.task or not a.edit or not a.said:
            die("wb coding allow <task> --edit \"<the exact edit>\" --said \"<the user's words>\" "
                "[--when \"<the condition>\"]")
        task = need(a.task)
        if task.status.get("phase") in store.CLOSED:
            die(f"{a.task} is {task.status.get('phase')}")
        _allow(task, a.edit, a.said, a.when)
        print(f"{a.task}: Claude may make this edit " + (f"once, if {a.when}" if a.when else
              "until it hands the task back") + f": {a.edit}")
        return
    if a.task or a.edit or a.said or a.when or a.did:
        die("a task, --edit, --said and --when go with wb coding allow; --did with wb coding used")
    if a.what:
        store.write_json(store.home() / "coding.json", {"mode": a.what, "ts": store.now()})
    label, why = CODING[coding_mode()]
    print(f"Claude coding: {label}. {why}")
    for t in store.all_tasks():
        if t.status.get("phase") not in store.CLOSED and (x := coding_allowed(t)):
            print(f"  {t.name}: " + (f"allowed once, if {x['when']}: " if x.get("when") else
                  "allowed until handed back: ") + f"{x['edit']} (the user: \"{x['said']}\")")


@one_at_a_time
def cmd_takeover(a):
    """Stop the agent and hand the worktree to Claude, to finish by hand or hand back."""
    if a.all:  # "just get it done claude"
        tasks, others = _scope([t for t in store.all_tasks()
                                if t.status.get("phase") not in store.CLOSED], *_caller(a))
        if not tasks:
            print("no open delegated tasks to take over")
        refused = 0
        for t in tasks:  # each refusal said (die's line) and the rest still taken: one refused
            # first left every other runner going (#601, the audit of v1.90). Not ready is skipped,
            # not refused: a task still checking out, or failed at checkout, made every hand-back
            # exit 1, and the mod queued no turn for the tasks it had taken over (#918)
            if not runner.checked_out(t):
                print(f"not ready: {t.name} (its checkout hasn't finished): wait for it, "
                      f"or wb discard {t.name}")
                continue
            try:
                cmd_takeover(argparse.Namespace(name=t.name, all=False, repo=None, session=None,
                                                user=a.user))
            except SystemExit as e:
                refused = max(refused, e.code if isinstance(e.code, int) else 1)
        _say(_others_line(others, "left alone"))
        if refused:
            sys.exit(refused)
        return
    if getattr(a, "repo", None) or getattr(a, "session", None):
        die("--repo and --session go with --all")
    if not a.name:
        die("name a task, or --all")
    task = need(a.name)
    if task.status.get("phase") in store.CLOSED:
        die(f"{a.name} is {task.status.get('phase')}")
    if why := _accepting(task):  # (#878)
        die(why)
    if not runner.checked_out(task):  # the runner's checkout, running or failed: a hand-back made
        # it again from nothing, and Claude's edits went with the old worktree (#655)
        die(f"{a.name}: its worktree isn't ready yet: wait for it, or wb discard {a.name}")
    _coding_gate(task, getattr(a, "user", False))
    if getattr(a, "user", False) and coding_mode() != "decide":  # the user's hand-back: Claude
        _allow(task, "the whole task: the user handed it to Claude",  # finishes it (the mod's
               "/workbench-quit-and-hand-back-claude")               # gate reads this)
    _stop_runner(task)
    task.event({"ts": store.now(), "round": task.status.get("round"), "kind": "takeover",
                "text": "Claude took over"})
    task.set_status(phase="review", last="Claude took over", pid=None, taken_over=True,
                    parked=None)  # Claude's now (#698)
    _ack_all(task)
    print(f"took over {a.name}: the agent is stopped. Edit in {task.worktree} and leave it "
          f"uncommitted, then wb accept {a.name} -m \"…\" (it commits), or hand it back with "
          f"wb feedback {a.name} --message <file>")


@contextmanager
def _ends_cleanly():
    """SIGTERM and SIGHUP end the command as an error would, so its cleanups run: the tests' group
    killed and swept (run_in_lane's finally), the scratch clone removed. Killed by Claude's Bash at
    its 2 minutes, wb verify left a clone and a test still running (#372, the audit of 1.6)."""
    def end(signum, _frame):
        raise SystemExit(128 + signum)
    old = {s: signal.signal(s, end) for s in (signal.SIGTERM, signal.SIGHUP)}
    try:
        yield
    finally:
        for s, h in old.items():
            signal.signal(s, h)


def cmd_verify(a):
    """A regression test on the base and on the candidate, each in a scratch checkout under the
    task's lane (#96): whether the test shows the bug the change fixes."""
    task = need(a.name)
    reap(task)
    if task.status.get("phase") in store.CLOSED:
        die(f"{a.name} is {task.status.get('phase')}")
    if task.status.get("phase") in store.ACTIVE:
        die(f"{a.name} is {task.status.get('phase')}: verify it at review, once the agent has stopped")
    cmd = a.test or task.spec.get("test_cmd")
    if not cmd:
        die("name the regression test's command: --test '<cmd>'")
    try:
        with _ends_cleanly():
            r = verify.run(task, cmd, a.files, a.timeout, a.expect or "", a.setup)
    except (RuntimeError, gitops.GitError) as e:
        die(str(e))
    print("\n".join(verify.lines(r)))


def cmd_shot(a):
    """The same interaction captured on the base and on the candidate, for a visual task (#98)."""
    task = need(a.name)
    reap(task)
    if task.status.get("phase") in store.CLOSED | store.ACTIVE:
        die(f"{a.name} is {task.status.get('phase')}: capture it at review")
    try:
        with _ends_cleanly():
            m = verify.shot(task, a.capture, a.files, a.viewport, a.timeout, a.setup)
    except (RuntimeError, gitops.GitError) as e:
        die(str(e))
    print("\n".join(verify.shot_lines(m)))
    if a.chat:  # to the web chat, for a review from the phone (#99)
        n = int(Path(m["dir"]).name)
        left = f" {verify.LEFT_OUT.format(', '.join(m['left_out']))}." if m.get("left_out") else ""  # #836
        chat.send(" ".join(verify.shot_lines(m)[:1]) + left + " Reply here to send feedback on it.",
                  "claude", shots=chat.shots(task.name, n))
        print("sent to the web chat")


@one_at_a_time
def cmd_accept(a):
    a.merge = a.merge or bool(a.merge_as)  # --merge-as says how, so it merges (#352)
    task = need(a.name)
    # a repo kept to linear history says so once, in commands.json `repos` (#352)
    a.merge_as = a.merge_as or (a.merge and context.repo_conf(
        gitops.repo_of(task.spec), task.spec.get("subdir")).get("merge")) or None  # its package's (#778)
    reap(task)
    spec, st = task.spec, task.status
    if st.get("phase") in store.CLOSED:
        if _finish_record(task):
            if reason := (st["unrecorded"].get("extra") or {}).get("merge_refused"):
                print(f"wb: not merged: {reason}", file=sys.stderr)
                sys.exit(NOT_MERGED)
            return
        die(f"{a.name} is already {st.get('phase')}")
    if st.get("phase") != "review" and not a.force:
        die(f"{a.name} is {st.get('phase')}, not waiting for review (--force accepts anyway)")
    repo = _repo(task)  # moved: said before anything is stopped or changed (#498)
    # A doomed accept once stopped the runner first, then died on "nothing to commit", leaving
    # the task running with no runner (the 2026-11-16 audit): check before stopping anything,
    # and a stopped task whose commit fails is stuck, for wb resume, feedback or discard.
    was_live = st.get("phase") in LIVE
    # an earlier accept that got past its commit: its record, not the branch's name, says what
    # is left. A retry recorded merged=false for a merge git had made and named a branch it had
    # deleted, and a last step with no new edits stayed in review once its worktree was gone
    # (#246, the audit of 1.2)
    close = st.get("closing")
    if (not close and was_live and st.get("steps", 1) == 1 and task.worktree.is_dir()
            and not gitops.changed(task.worktree)):
        die(f"{a.name} has no changes to accept yet: wait for it, or wb stop {a.name} first")
    _stop_runner(task)  # under --force it may still be running, and would set its phase back
    checked = None if close else verify.note(task)  # before the commit: what Claude accepts it on (#97)
    rounds, autofix = st.get("round", 1), st.get("auto_fixes_total", 0) + st.get("auto_fixes", 0)
    msg = (f"{a.message}\n\nDelegated to {spec['model_label']} via OpenCode: {rounds} round(s), "
           f"{autofix} automatic test-fix, {st.get('reviews', 0)} review round(s)."
           f"\n\nWorkbench-Task: {a.name}\nOpenCode-Session: {st.get('session')}")
    if close:
        commit, measured = close["commit"], close.get("step")
        if _gained_work(task, repo, commit):
            # the forced worktree removal below would delete what changed, and the merge leave
            # it out (#878)
            die(f"{a.name}'s worktree changed after an earlier wb accept committed {commit}: "
                f"put it back to that commit (git -C {shlex.quote(str(task.worktree))} status), "
                f"or keep the changes elsewhere, then wb accept {a.name} again")
    else:
        # a retry after an accept killed between its commit and `closing` (ENOSPC, a kill):
        # measured since HEAD, its own commit, the step read as 0 files and 0 lines and the
        # savings card priced the task at nothing (#879, Claude's audit of 1.90.24)
        measured = results.step(task, landed=True, gaps=a.spec_gap,  # recorded below (#904)
                                since="HEAD~1" if _accept_landed(task) else "HEAD")
        try:
            commit = _landed(task)
            if not commit:
                head = gitops.git(task.worktree, "rev-parse", "HEAD").strip()
                with _settle_proposals(task, a.take_claude_md):  # kept if the commit fails (#507)
                    if gitops.changed(task.worktree) or head == spec["base"]:
                        commit = gitops.commit_all(task.worktree, msg, a.include, _signed(spec, a))
                    else:  # nothing new: the branch's commits past the base are the work (the
                        # steps wb next committed, or Claude's own after a takeover: the audit)
                        commit = gitops.git(task.worktree, "rev-parse", "--short", "HEAD").strip()
            # the branch must hold it before the worktree goes: on a detached HEAD the commit was
            # left in no branch at all (#417, the audit of 1.8)
            gitops.put_on_branch(repo, spec["branch"], commit, task.worktree)
            # inside: the commit is made, and a retry finds it (#498: outside, it died every time)
            tip = gitops.git(repo, "rev-parse", "--verify", f"{commit}^{{commit}}").strip()
        except gitops.GitError as e:  # nothing removed: the uncommitted work is still in the worktree
            if was_live:
                task.set_status(phase="stuck", last=f"accept failed: {e}"[:200], pid=None)
                die(f"{e}\n{a.name} is stopped: fix the cause and wb accept again, or wb resume, "
                    "wb feedback or wb discard it")
            die(str(e))
        into = _merge_into(spec, repo) if a.merge else None
        if a.merge and into in (None, "HEAD"):
            into = gitops.current_branch(repo)
        close = {"commit": commit, "step": measured, "merge": bool(a.merge), "merge_into": into,
                 "merge_as": a.merge_as or "merge", "sign": _signed(spec, a)}
        task.set_status(closing=close, tip=tip,  # before anything is removed
                        last=f"being accepted: wb accept {a.name} finishes it if this stops")  # #878
        _spec_gaps(task, a.spec_gap)
    tip = task.status["tip"]
    # before the branch can go: wb bench add reads the steps (#649), from a bundle in the task's
    # own state, not a ref in the user's repo (#799); the ref only if the bundle can't be made
    if gitops.bundle_steps(repo, spec["base"], tip, task.dir / gitops.STEPS_BUNDLE):
        gitops.drop_accepted(repo, a.name, tip)  # a retry's, made when an earlier try's failed
        task.set_status(accepted_ref_gone=True)
    else:
        gitops.keep_accepted(repo, a.name, tip)
    if warn := gitops.remove_worktree(repo, task.worktree):  # committed: the rest is cleanup
        print(f"wb: {warn}", file=sys.stderr)
    context.drop_runtime_dir(task)
    merged, refused = close.get("merged_head"), None
    if close.get("merge") and not merged:
        into = close.get("merge_into")
        if into and into != "HEAD" and gitops.contains(repo, f"refs/heads/{into}", tip):
            merged = gitops.git(repo, "rev-parse", "--short", f"refs/heads/{into}").strip()  # made already
        elif into and into != "HEAD" and (merged := gitops.squashed(
                repo, into, close.get("merge_from"), tip)):
            pass  # a squash made already: it never holds the tip, so the retry squashed again (#432)
        else:
            try:
                if not into:
                    raise gitops.GitError(gitops.detached(repo, spec["branch"], had=True))
                # one merge into the checkout at a time, another task's or profile's too: one
                # backed out over another's landed merge rewound it (#639)
                with _ends_cleanly(), gitops.merge_lock(
                        repo, say=lambda m: print(f"wb: {m}", file=sys.stderr)):
                    # where the target stood before: a squash interrupted before merged_head was
                    # saved is found from it on the retry (#432, the audit of 1.8)
                    close = {**close, "merge_from": gitops.git(
                        repo, "rev-parse", "--verify", "-q", f"refs/heads/{into}",
                        check=False).strip()}
                    task.set_status(closing=close)
                    # every target is held to the base, a named branch too: reset or rebased
                    # since the start, the merge brought back what was withdrawn from it (#418)
                    # signed as the task's commit was, and a kill backs the checkout out: SIGTERM
                    # left MERGE_HEAD and the staged merge in the user's checkout (#420)
                    merged = gitops.merge(repo, a.name, into, spec["base"], tip=tip,
                                          how=close.get("merge_as", "merge"),
                                          sign=close.get("sign", True) and _signed(spec, a))
            except gitops.GitError as e:
                refused = str(e)
                print(f"wb: not merged: {e}", file=sys.stderr)
        if merged:
            task.set_status(closing={**close, "merged_head": merged})
    # landed by a merge or a fast-forward, the target keeps the steps alive; a squash doesn't.
    # Only a ref kept because the steps bundle couldn't be made (#799)
    into = close.get("merge_into")
    if merged and into and into != "HEAD" and not task.status.get("accepted_ref_gone") and \
            gitops.contains(repo, f"refs/heads/{into}", tip):
        if gitops.drop_accepted(repo, a.name, tip):  # (#799)
            task.set_status(accepted_ref_gone=True)
    if merged and gitops.git(repo, "rev-parse", "--verify", "-q", f"refs/heads/{spec['branch']}",
                             check=False).strip() == tip:
        if close.get("merge_as") == "squash":  # never an ancestor of the squash: -d would keep it
            gitops.git(repo, "branch", "-D", spec["branch"], check=False)
        else:
            gitops.drop_merged_branch(repo, spec["branch"])
    extra = {"commit": commit, "merged": bool(merged)}
    if refused:  # asked and refused: the row says so, and the exit status (#247)
        extra["merge_refused"] = refused[:300]
    task.set_status(phase="accepted", last=f"accepted as {commit}" +
                    (f", merged {merged}" if merged else ", not merged" if refused else ""),
                    unrecorded={"outcome": "accepted", "step": measured, "extra": extra}, closing=None)
    row = results.record(task, "accepted", measured, **extra)
    task.set_status(unrecorded=None)
    _ack_all(task)
    _closed(task)
    try:  # a reminder: it once turned a finished accept into exit 1 (the 2026-11-16 audit)
        # the task's own commit counts: by its recorded object, as --merge deleted the branch,
        # and every merged accept then said the repo had no CLAUDE.md (#269, the audit of 1.2)
        note = claude_md_status(repo, gitops.git(repo, "rev-parse", "--short", tip).strip(),
                                spec.get("subdir") or "")  # the package's own (#783)
    except (gitops.GitError, OSError, ValueError):
        note = None
    if note:
        print("the repo has no CLAUDE.md: write one (wb init)" if note == "no CLAUDE.md" else
              f"{note}: keep it current (update it if this change alters what it says)"
              if note == LOCAL_CLAUDE_MD else
              f"{note}: keep it current (update and commit it if this change alters what it says)")
    print(f"accepted {a.name}: commit {commit} on {spec['branch']}" +
          (f", merged into {close['merge_into']} as {merged}" if merged else
           f"\nmerge with: {gitops.jj_merge(repo, spec['branch'])}" if gitops.jj_colocated(repo) else
           f"\nmerge with: " + gitops.merge_by_hand(
               repo, spec["branch"], close.get("merge_as") if close.get("merge") else
               context.repo_conf(spec["repo"], spec.get("subdir")).get("merge") or "merge",
               close.get("sign", True) and _signed(spec, a))))
    _say(savings.line(row) or spend.line(row.get("claude")))
    _say(checked)
    _say(lessons.nudge(task, "accepted"))
    if refused:  # accepted, not merged: a script or Claude reading 0 went on as if main had it
        sys.exit(NOT_MERGED)  # (#247, the audit of 1.2)


def _gained_work(task: store.Task, repo: Path, commit: str) -> bool:
    """Whether a retried accept's worktree holds work its commit doesn't: an intact worktree with
    a change other than a deleted file, or moved off the commit. One the earlier try's removal
    left half-deleted is not: its files gone read as deletions, its `.git` gone as a GitError,
    and every retry refused it while discard, feedback and the rest pointed back at wb accept
    (the review of #878). Nothing a deletion drops is lost: the commit has it."""
    if not task.worktree.is_dir():
        return False
    try:
        left = [ln for ln in gitops.changed(task.worktree).splitlines() if ln[:2].strip() != "D"]
        head = gitops.git(task.worktree, "rev-parse", "HEAD", check=False).strip()
    except gitops.GitError:  # its .git removed (or not what it said): being removed
        return False
    return bool(left) or head != gitops.git(
        repo, "rev-parse", "--verify", "-q", f"{commit}^{{commit}}", check=False).strip()


NOT_MERGED = 5  # wb accept --merge's exit status when the accept stands and the merge was refused


def _merge_into(spec: dict, repo: Path) -> str | None:
    """The branch wb accept --merge lands on: the one the task started from, or None (a tag or a
    commit: any checked-out branch holding the base). The tag itself was passed for a branch
    name, and every merge of a task started from one was refused (the 2026-11-18 audit, #87)."""
    if "base_branch" in spec:
        return spec["base_branch"]
    ref = spec.get("base_ref") or "HEAD"  # a task from before base_branch was recorded
    return ref if ref == "HEAD" else gitops.start_branch(repo, ref)


def _finish_record(task: store.Task) -> bool:
    """A closed task whose results row an interrupted accept or discard never wrote (status
    `unrecorded`, set with the phase): write it now, from what that run measured. The
    task was missing from stats and the router's evidence for good, and a retry said only "already
    accepted" (the 2026-11-18 audit, #88)."""
    todo = task.status.get("unrecorded")
    if not todo:
        return False
    if not any(r.get("task") == task.name for r in store.results(trials=True)):  # once
        results.record(task, todo["outcome"], todo.get("step"), **(todo.get("extra") or {}))
    task.set_status(unrecorded=None)
    _ack_all(task)
    commit = (todo.get("extra") or {}).get("commit")
    print(f"{task.name} was {todo['outcome']}" + (f" as {commit}" if commit else "")
          + "; its result is recorded now")
    return True


GC_EVERY = 86400  # a close runs gc at most once a day (gc.json): a task closed is a moment's work
RULES_GRACE = 3600  # a rules directory with no task yet may be a start in progress
STARTING = "starting.json"  # a start's repo, worktree and pid, until its task.json is written (#376)


def _dead_start(task: store.Task) -> dict | None:
    """A half-made start of ``task`` whose wb start is gone: its starting.json ({} when it died
    before writing one and RULES_GRACE has passed), or None while it may still be under way."""
    if task.exists or not task.dir.is_dir():
        return None
    info = store.read_json(task.dir / STARTING)
    if isinstance(info, dict) and info.get("machine") not in (None, store.machine()):
        # another machine's start, on a shared state directory: its pid means nothing here, and
        # gc took a start under way there for a dead one (#876); none outlives RULES_GRACE
        at = info.get("at")
        return None if not isinstance(at, (int, float)) or time.time() - at < RULES_GRACE else info
    if isinstance(info, dict) and isinstance(info.get("pid"), int):
        # with its start: a recycled pid refused a retry and kept the worktree from gc (#532)
        return None if models._alive(info["pid"], info.get("start")) else info
    try:
        young = time.time() - task.dir.stat().st_mtime < RULES_GRACE
    except OSError:
        return None
    return None if young else {}


def _drop_start(task: store.Task, info: dict) -> None:
    """Undo a half-made start: its worktree and registration, its branch (it holds no work: the
    agent never ran), its directory and its rules. The branch only when starting.json says this
    start made it, and only while it still points at the commit it was made at: an earlier
    task's branch, or one moved since, stays (#416)."""
    repo = Path(info.get("repo") or "/nonexistent")
    if repo.is_dir():
        if info.get("worktree"):  # unlocked first when git left it "initializing" (#376, #529)
            gitops.remove_worktree(repo, Path(info["worktree"]))  # its registration only (#641)
        if info.get("branch") == gitops.branch_name(task.name) and info.get("branch_at"):
            gitops.delete_branch(repo, task.name, at=info["branch_at"])
    gitops._rmtree(task.dir)
    shutil.rmtree(context.rules_dir(task), ignore_errors=True)


# Another machine's scratch directory (its name's machine tag, store.scratch) is left to that
# machine's gc this long: gc here removed a live one, its pid not in this process table (#876)
FAR_SCRATCH_AGE = 86400


def _maker_alive(pid: str, tag: str) -> bool:
    """Whether a scratch directory's maker (its name's <pid>.<start tag>[.<machine tag>],
    store.scratch) still runs: a pid recycled since is another process, and its clone was kept
    for ever (#532). An untagged name (made before the tag, or where no start could be read) goes
    by the pid alone; another machine's, by its age (FAR_SCRATCH_AGE, #876)."""
    tag, _, mach = tag.partition(".")
    if mach and mach != store.machine_tag():
        return True  # _drop_scratches judges it by its age
    if not (pid.isdigit() and models._alive(int(pid))):
        return False
    return not tag or models.same_tag(int(pid), tag)


def _scratch_pid(name: str) -> str | None:
    """The maker in a scratch directory's name, `<pid>` or `<pid>.<start tag>` (store.scratch,
    or wb bench add's `.<case>.<pid>.tmp`), or None when it is no scratch directory."""
    if pre := next((p for p in store.SCRATCH_PREFIXES if name.startswith(p)), None):
        return name[len(pre):].split("-")[0]
    if name.startswith(".") and name.endswith(".tmp") and name.count(".") >= 3:
        return name[:-4].rsplit(".", 1)[1]
    return None


def _scratch_homes() -> list[Path]:
    """Where scratch directories are made: the home; the bench's, its cases; and each default
    output directory of wb image and wb audio (`.wb-image-`, `.wb-audio-`). A command killed at
    Claude's Bash limit left them all (#589, the audit of 1.90)."""
    home = store.home()
    outs = [d for kind in ("images", "audio") if (home / kind).is_dir()
            for d in sorted((home / kind).iterdir()) if d.is_dir() and not d.is_symlink()]
    return [home, home / "bench", home / "bench" / "cases", *outs]


def _drop_scratches() -> int:
    """The scratch directories (_scratch_pid) SCRATCH_AGE old whose maker is gone (#376, #439,
    #589): the home's, bench/'s, where a killed `wb bench add` leaves its clones, and the rest."""
    n = 0
    for d in [d for h in _scratch_homes() if h.is_dir() for d in sorted(h.iterdir())]:
        maker = _scratch_pid(d.name)
        if maker is None or not d.is_dir() or d.is_symlink():
            continue
        pid, _, tag = maker.partition(".")
        far = tag.partition(".")[2] not in ("", store.machine_tag())  # #876
        try:
            age = time.time() - d.stat().st_mtime
        except OSError:
            continue
        if far and age > FAR_SCRATCH_AGE or age > store.SCRATCH_AGE and not _maker_alive(pid, tag):
            gitops._rmtree(d)
            n += 1
    return n


def _keep_grants(task: store.Task) -> None:
    """The task's grants into its status (`grants_kept`) before its rules go: wb bench add,
    later, replays a case with them, and found them empty once the close had deleted the rules
    (#250, the audit of 1.2)."""
    kept = store.read_json(store.home() / "rules" / task.name / "grants.json", {}) or {}
    if kept and task.exists and not task.status.get("grants_kept"):
        task.set_status(grants_kept=kept)


def _closed(task: store.Task) -> None:
    """A task just closed: its rules go (55 were left over here, the 2026-11-19 audit), and once
    a day the rest of gc. Never an accept's or discard's failure."""
    _keep_grants(task)
    shutil.rmtree(store.home() / "rules" / task.name, ignore_errors=True)
    if time.time() - ((store.read_json(store.home() / "gc.json", {}) or {}).get("at") or 0) > GC_EVERY:
        try:
            gc()
        except (OSError, gitops.GitError, RuntimeError) as e:
            print(f"wb: gc: {e}", file=sys.stderr)


def gc(days: float = store.ARCHIVE_DAYS, branches: bool = False) -> dict:
    """What history leaves behind (the 2026-11-19 audit, finding 18): closed tasks archived after
    ``days`` (store.archive), handled notices older than that moved to notify.old.jsonl, the
    rules of closed or vanished tasks, stale runtime directories, and with ``branches`` the
    delegate branches of tasks accepted and merged (wb gc), and the web chat's uploads past
    ``days`` once their message is read. The counts of each."""
    out = {"archived": len(store.archive(days)), "notices": _rotate_notices(days)}
    rules = store.home() / "rules"
    out["rules"] = 0
    for d in sorted(rules.iterdir()) if rules.is_dir() else []:
        t = store.Task(d.name)
        if t.status.get("phase") in store.CLOSED or (
                not t.exists and time.time() - d.stat().st_mtime > RULES_GRACE):
            _keep_grants(t)
            shutil.rmtree(d, ignore_errors=True)
            out["rules"] += 1
    out["runtime"] = context.drop_stale_runtime_dirs(store.all_tasks())
    out["scratch"] = _drop_scratches()
    out["starts"] = 0
    for d in sorted(store.tasks_dir().iterdir()) if store.tasks_dir().is_dir() else []:
        t = store.Task(d.name)
        if store.NAME_RE.match(d.name) and (half := _dead_start(t)) is not None:
            _drop_start(t, half)
            out["starts"] += 1
    out["uploads"] = chat.drop_old_uploads(days)  # the web chat's attachments, once delivered (#623)
    out["slimmed"] = store.slim_archive()  # the old archive's logs and test outputs (#740)
    out["old_notices"] = _cap_old_notices()
    out["leftovers"] = _drop_leftovers(days)
    out["branches"] = _merged_branches() if branches else 0
    out["refs"] = _released_refs() if branches else 0
    store.write_json(store.home() / "gc.json", {"at": store.now(), **out})
    return out


NOTIFY_OLD_MAX = 8 << 20  # notify.old.jsonl past this keeps its newest half: no code reads it


def _cap_old_notices() -> int:
    """notify.old.jsonl cut to its newest half once past NOTIFY_OLD_MAX: each review notice there
    carries up to 32,000 characters of diff, and it only grew (#740, the 2026-11-21 audit). The
    bytes dropped."""
    path = store.home() / "notify.old.jsonl"
    with store.locked(store.home() / "notify.jsonl.lock"):  # as _rotate_notices appends to it
        try:
            size = path.stat().st_size
            if size <= NOTIFY_OLD_MAX:
                return 0
            with open(path, "rb") as fh:
                fh.seek(size - NOTIFY_OLD_MAX // 2)
                tail = fh.read()
        except OSError:
            return 0
        tail = tail[tail.find(b"\n") + 1:]  # from a whole line
        store.replace_bytes(path, tail)
        return size - len(tail)


def _drop_leftovers(days: float) -> int:
    """What other commands leave in the state directory and nothing removed (#740): a skill
    import's copy (imports/, read once by Claude before its own version is added) older than
    ``days``, and claude-sessions/<pid> of a Claude Code process gone ``days`` ago that no open
    task records. How many went."""
    cutoff, gone = time.time() - days * 86400, 0
    imports = store.home() / "imports"
    for d in sorted(imports.iterdir()) if imports.is_dir() else ():
        try:
            if d.lstat().st_mtime < cutoff:
                shutil.rmtree(d) if d.is_dir() and not d.is_symlink() else d.unlink()
                gone += 1
        except OSError:
            continue
    sessions = store.home() / "claude-sessions"
    held = {str(t.spec.get("claude_pid")) for t in store.all_tasks()
            if t.status.get("phase") not in store.CLOSED}
    for f in sorted(sessions.iterdir()) if sessions.is_dir() else ():
        try:
            if not f.name.isdigit() or f.name in held or f.stat().st_mtime >= cutoff:
                continue
            try:
                os.kill(int(f.name), 0)
                continue  # alive, or a process by that number: kept
            except ProcessLookupError:
                pass
            except OSError:  # alive and someone else's
                continue
            f.unlink()
            gone += 1
        except OSError:
            continue
    return gone


def _rotate_notices(days: float) -> int:
    """Move notify.jsonl's notices older than ``days`` that are handled (acknowledged, or their
    task closed or gone) to notify.old.jsonl: each carries up to 32K of report, and every wb wait
    wake and acknowledgement parsed the whole file, 529 KB for 158 notices (the 2026-11-19
    audit). Under the file's own lock, so no notice appended meanwhile is lost."""
    path = store.home() / "notify.jsonl"
    cutoff = time.time() - days * 86400

    def handled(r) -> bool:
        if not isinstance(r, dict) or not isinstance(r.get("ts"), (int, float)):
            return True  # no notice at all (store.notices skips it)
        if r["ts"] > cutoff:
            return False
        if not (isinstance(r.get("task"), str) and store.NAME_RE.match(r["task"])):
            return True
        t = store.Task(r["task"])
        return not t.exists or t.status.get("phase") in store.CLOSED or r["ts"] <= _acked(t)

    with store.locked(path.with_name(path.name + ".lock")):
        rows = store.read_jsonl(path)[0]
        line = lambda r: json.dumps(r, ensure_ascii=False).encode() + b"\n"  # noqa: E731
        old, kept = [], []
        for r in rows:
            (old if handled(r) else kept).append(r)
        if old:
            with open(path.with_name("notify.old.jsonl"), "ab") as fh:
                fh.write(b"".join(map(line, old)))
                store._synced(fh)  # on the disk before they leave notify.jsonl
            store.replace_bytes(path, b"".join(map(line, kept)))  # synced (#734)
    return len(old)


def _merged_branches() -> int:
    """Delete the delegate branches of accepted tasks that have landed: merged by wb accept
    --merge before it deleted them itself, or by hand after a plain accept (the skill's default,
    whose `git merge` line left delegate/<task> for good). Each tip is recorded first (status
    `tip`), which wb bench finds the task's commits from; a branch moved past that tip since is
    the user's and stays (#930); then `branch -d` (merged into the checkout's HEAD or its
    upstream), else a compare-and-delete when the task's base branch holds the tip, never while a
    worktree has the branch out (#930: its HEAD was left naming no ref). A branch gone, or deleted here, is recorded (status `branch_gone`) and never looked
    at again: every merged task ever recorded cost a git call on every run, 2,828 of them in
    1.8 s on tmpfs, minutes on /mnt/c (#686). Each repo's delegate refs are listed once. A branch
    squash-merged (a PR) holds commits its target lacks, so it stays."""
    by_repo: dict[Path, list] = {}
    for name in sorted({r["task"] for r in store.results(trials=True) if r.get("outcome") == "accepted"}):
        t = store.Task(name)
        if not t.exists or t.status.get("branch_gone") or not (branch := t.spec.get("branch")):
            continue
        if (repo := gitops.repo_of(t.spec)).is_dir():
            by_repo.setdefault(repo, []).append((t, branch))
    n = 0
    for repo, tasks in by_repo.items():
        refs = dict(line.split(" ", 1)[::-1] for line in gitops.git(
            repo, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/delegate/",
            check=False).splitlines() if " " in line)
        for t, branch in tasks:
            if not (tip := refs.get(f"refs/heads/{branch}")):
                t.set_status(branch_gone=True)
                continue
            if not (accepted := t.status.get("tip")):  # accepted before accept recorded it
                accepted = tip
                t.set_status(tip=tip)
            if tip != accepted:  # moved since accept (more work on it): the user's now, it stays
                continue  # (#930: the tip compared was the one read here, so it went if merged)
            if gitops.drop_landed_branch(repo, branch, tip, t.spec.get("base_branch")):
                n += 1
                t.set_status(branch_gone=True)
    return n


def _released_refs() -> int:
    """Delete each accepted task's refs/workbench/accepted/<task>, the ref wb accept kept in the
    user's repo before #799 (or when it couldn't write the task's steps bundle): kept for good, each
    task's steps showed in `git log --all`, mirrors copied them and git's gc never pruned them (the
    second 2026-11-21 audit). wb bench add reads the steps from gitops.STEPS_BUNDLE now, so the ref
    is moved into that bundle first; one whose tip landed in the task's base branch (which keeps
    every step alive) just goes, and so does one whose bundle can't be made once each step has its
    case (#649). The bundle stays as long as the task: removed once every step had its case, a
    case removed with wb bench rm (#740) could never be made again after a squash accept, once
    git's gc pruned the steps (#940, the v1.90.24 review); it holds base..tip alone. A ref gone,
    or deleted here, is recorded (status `accepted_ref_gone`) and never looked at again, and each
    repo's refs are listed once, with one `for-each-ref --merged` per base branch: not a call per
    task on every run (#686)."""
    cased: dict[str, set] = {}
    for c in bench.cases().values():
        cased.setdefault(c.get("task"), set()).add(c.get("step"))
    by_repo: dict[Path, list] = {}
    done: dict[str, bool] = {}
    for name in sorted({r["task"] for r in store.results(trials=True) if r.get("outcome") == "accepted"}):
        t = store.Task(name)
        if not t.exists:
            continue
        done[name] = set(range(1, int(t.status.get("steps") or 1) + 1)) <= cased.get(name, set())
        if not t.status.get("accepted_ref_gone") and (repo := gitops.repo_of(t.spec)).is_dir():
            by_repo.setdefault(repo, []).append(t)
    n = 0
    for repo, tasks in by_repo.items():
        refs = dict(line.split(" ", 1)[::-1] for line in gitops.git(
            repo, "for-each-ref", "--format=%(objectname) %(refname)", "refs/workbench/accepted/",
            check=False).splitlines() if " " in line)
        landed: dict[str, set] = {}
        for t in tasks:
            base = t.spec.get("base_branch")
            if refs and base and base not in landed:
                landed[base] = set(gitops.git(
                    repo, "for-each-ref", f"--merged=refs/heads/{base}", "--format=%(refname)",
                    "refs/workbench/accepted/", check=False).split())
        for t in tasks:
            ref = gitops.ACCEPTED_REF.format(t.name)
            if not (tip := refs.get(ref)):  # one from before #649, or deleted by hand
                t.set_status(accepted_ref_gone=True)
                continue
            # into the bundle even when each step has its case: a case removed could be made
            # again only from it (#940); dropped outright then only when it can't be made
            if (ref in landed.get(t.spec.get("base_branch"), ()) or
                    gitops.bundle_steps(repo, t.spec["base"], tip, t.dir / gitops.STEPS_BUNDLE)
                    or done[t.name]) and gitops.drop_accepted(repo, t.name, tip):
                t.set_status(accepted_ref_gone=True)
                n += 1
    return n


def cmd_gc(a):
    """Tidy what history leaves behind (gc); wb accept and discard run it once a day too."""
    out = gc(a.days, branches=True)
    print(f"archived {out['archived']} task(s) closed over {a.days:g} days ago; moved "
          f"{out['notices']} old notice(s) to notify.old.jsonl; removed {out['rules']} rules "
          f"dir(s), {out['runtime']} runtime dir(s), {out['scratch']} scratch dir(s), "
          f"{out['starts']} half-made start(s), {out['uploads']} web chat upload(s), "
          f"{out['branches']} merged branch(es), {out['refs']} accepted ref(s) no longer needed, "
          f"{out['leftovers']} old import(s) and session "
          f"record(s); freed {store.gb(out['slimmed'] + out['old_notices'])} of old logs and "
          "test outputs")
    if left := bench.sweep():  # not in gc(): a discard runs that, and this discards (#511)
        print(f"closed {len(left)} bench replay(s) whose driver died, with their clones: "
              + ", ".join(left[:5]))


def _landed(task: store.Task) -> str | None:
    """The commit an earlier wb accept made before its cleanup failed: the worktree is gone or
    broken and the branch's tip carries accept's own trailer (a step's says "(step N)"). A retry
    then finishes the job; it once died on "nothing to commit" for good (the 2026-11-16 audit)."""
    try:
        gitops.git(task.worktree, "rev-parse", "HEAD")
        return None  # a working worktree: commit from it
    except gitops.GitError:
        pass
    repo = gitops.repo_of(task.spec)
    branch = task.status.get("tip") or task.spec["branch"]  # merged and deleted: its recorded tip
    if f"Workbench-Task: {task.name}" in gitops.git(repo, "log", "-1", "--format=%B", branch,
                                                    check=False).splitlines():
        return gitops.git(repo, "rev-parse", "--short", branch).strip()
    return None


def _repo(task: store.Task) -> Path:
    """gitops.repo_of, or a stop when the repo is nowhere: it moved (#498)."""
    repo = gitops.repo_of(task.spec)
    if not repo.is_dir():
        die(f"{task.spec['repo']} moved or was deleted: wb relocate {task.name} --repo <its new "
            "path>, then try again")
    return repo


@one_at_a_time
def cmd_relocate(a):
    """Tell a task where its repository is now: moved or renamed (`mv proj proj2`), or the
    checkout it started from removed. Repairs its worktree's link (gitops.relocate) and rewrites
    task.json `repo`, `git_common` and a `cwd` that was inside it, and the filled submodules'
    checkouts (submodules.json `src`). Without it the task could only
    be discarded: every git call on its worktree failed, and `git worktree repair` was refused
    by the pinning (#498, the audit of 1.90)."""
    task = need(a.name)
    spec = task.spec
    try:
        repo = gitops.toplevel(Path(a.repo).resolve())
    except gitops.GitError:
        die(f"{a.repo} is not inside a git repository")
    if not gitops.base_commit(repo, spec["base"]):
        die(f"{repo} is not {a.name}'s repository: it has no commit {spec['base'][:12]}, the "
            "task's base")
    if task.worktree.is_dir():
        try:
            gitops.relocate(repo, task.worktree)
        except (gitops.GitError, OSError) as e:
            die(str(e))
    old = Path(spec["repo"])
    cwd = Path(spec.get("cwd") or old)
    if cwd == old or cwd.is_relative_to(old):
        spec["cwd"] = str(repo / cwd.relative_to(old))
    # the filled submodules' checkouts, which submodule_edits checks an edit against: left at the
    # old path, every check failed and was skipped, and an edit there vanished at accept (#682)
    subs = context.rules_dir(task) / gitops.SUBMODULES
    if isinstance(rows := store.read_json(subs, None), list):
        for row in rows:
            if isinstance(row, dict) and Path(src := row.get("src") or "").is_relative_to(old):
                row["src"] = str(repo / Path(src).relative_to(old))
        store.write_json(subs, rows)
    spec.update(repo=str(repo), git_common=str(gitops.common_dir(repo)))
    store.write_json(task.dir / "task.json", spec)
    print(f"relocated {a.name}: {repo} (was {old})")


def _held(repo: Path, branch: str) -> str:
    """Why discard kept ``branch``: a worktree has it out, which update-ref would have left
    naming no ref (#930); else it moved under the compare-and-delete."""
    if at := gitops.checked_out_in(repo, branch):
        return f"; branch {branch} kept: it is checked out in {at}"
    return f"; branch {branch} kept: it moved while being deleted"


@one_at_a_time
def cmd_discard(a):
    task = need(a.name)
    spec = task.spec
    if task.status.get("phase") in store.CLOSED:
        if _finish_record(task):
            return
        die(f"{a.name} is already {task.status.get('phase')}")
    if why := _accepting(task):  # its commit exists, perhaps merged: not a discard (#878)
        die(why)
    _stop_runner(task)
    _spec_gaps(task, a.spec_gap)
    repo = gitops.repo_of(spec)  # a removed linked worktree: the repository's main one (#498)
    measured = results.step(task, landed=False)
    if warn := gitops.remove_worktree(repo, task.worktree):  # never stops a discard (the audit)
        print(f"wb: {warn}", file=sys.stderr)
    context.drop_runtime_dir(task)
    branch, said = spec["branch"], ""
    if a.keep_branch:
        pass
    elif not repo.is_dir():  # moved: its branch is still in it, wherever it is now (#498)
        said = (f"; {spec['repo']} moved or was deleted: branch {branch} wasn't deleted (git "
                f"branch -D {branch} where it is now)")
    elif not runner.checked_out(task):
        # a checkout cut short (#529): the branch is this task's only where its runner recorded
        # making it, and only while it still points there; an earlier task's, or one moved
        # since, stays (#416)
        made = task.status.get("branch_made")
        tip = gitops.git(repo, "rev-parse", "--verify", "-q", f"refs/heads/{branch}",
                         check=False).strip()
        if tip and made and tip == made:
            said = f"; branch {branch} deleted" if gitops.delete_branch(repo, a.name, at=made) \
                else _held(repo, branch)
        elif tip:
            said = (f"; branch {branch} kept: this task's checkout "
                    + ("made it, but it has moved since" if made else "didn't make it"))
    elif tip := gitops.git(repo, "rev-parse", "--verify", "-q", f"refs/heads/{branch}",
                           check=False).strip():
        task.set_status(tip=tip)  # before any delete: the commits stay findable (#494)
        # the steps wb next committed (or Claude's own, after a takeover) were approved: force-
        # deleted with the step that stuck, they were reachable from no ref (#494, the audit)
        past = gitops.git(repo, "rev-list", "--count", f"{spec['base']}..{tip}", check=False).strip()
        if past.isdigit() and int(past) and not a.drop_steps:
            git_c = f"git -C {shlex.quote(str(repo))}"
            said = (f"; branch {branch} kept: its {past} commit(s) past the base are approved "
                    f"steps. {git_c} merge {branch} lands them; {git_c} branch -D {branch} "
                    "drops them (wb discard --drop-steps deletes it at once)")
        elif gitops.delete_branch(repo, a.name, at=tip):
            said = f"; branch {branch} deleted (was {tip[:8]})"
        else:
            said = _held(repo, branch)
    # --drop-steps deleted the approved steps with the branch: no longer kept work (#722)
    dropped = {"steps_dropped": True} if getattr(a, "drop_steps", False) else {}  # bench's own call lacks it
    task.set_status(phase="discarded", last=a.reason or "discarded", pid=None,
                    unrecorded={"outcome": "discarded", "step": measured,
                                "extra": {"reason": a.reason, **dropped}})
    row = results.record(task, "discarded", measured, reason=a.reason, **dropped)
    task.set_status(unrecorded=None)
    _ack_all(task)
    _closed(task)
    print(f"discarded {a.name}{said}")
    _say(savings.line(row) or spend.line(row.get("claude")))
    _say(lessons.nudge(task, "discarded"))


def cmd_models(a):
    """What OpenCode offers, whether each can run, and who the router would pick per size."""
    found = models.discover()
    if not found:
        die(f"no local models: {models.why_none()}")
    # one pass's answers for every status and ranking below: a server asleep is asked once,
    # not per model and again per size (31 s for a wb remote box of 4 models, #705)
    down, catalog = set(), {}
    for m in found.values():
        st = models.status(m, down, catalog)
        print(f"{m.id:34} {('on GPU' if st['resident'] else 'ready' if st['available'] else 'no'):6}"
              f"  {m.label}" + ("" if st["available"] else f"  ({st['why']})"))
        print(f"{'':36}slice: {router.slice(m).line()}")
        if router.weights_changed(m):  # #726
            print(f"{'':36}weights changed since its record: starting fresh")
        if sp := router.speed_line(m.id):
            print(f"{'':36}speed: {sp} on this machine")
        if b := bench.model_line(m.id):
            print(f"{'':36}bench: {b} (wb bench report)")
        if st["available"] and not models.weights(m):  # the router can't rank it by size (#704)
            guess = models.guessed_weights(m)
            print(f"{'':36}size: " + (f"~{guess / 1e9:.0f} GB guessed from its name" if guess else "unknown")
                  + " (the server says none; models.json weights_gb sets it)")
    for size in router.SIZES:
        print(f"\n{size}:")
        ranked = router.rank(size, down=down, catalog=catalog)
        few = {sc.model.id for sc in router.unproven(ranked)}
        for i, sc in enumerate(ranked):
            mark = "→" if i == 0 and sc.state["available"] else " "
            print(f" {mark} {sc.model.id:34} {sc.line()}" + (
                f" · out of the band on {sc.tries} task(s): one task in {router.EXPLORE_ONE_IN} "
                "explores it" if sc.model.id in few else ""))
        for m in found.values():
            if not router.allowed(m, size):
                print(f"   {m.id:34} not for {size} tasks (wb model sizes)")
    if a.set_default:
        top, why = router.choose("significant", down=down, catalog=catalog)
        if top is None:
            die(why)
        try:
            old = models.set_default(top.model.id)
        except RuntimeError as e:
            die(str(e))
        print(f"\nOpenCode's default model: {old} → {top.model.id} ({why})")


def cmd_stats(a):
    """Results by model and size; `wb stats set KEY VALUE` changes what the Stats tab records
    and shows (stats.py)."""
    if a.action == "set":
        if not (a.key and a.value):
            die("wb stats set recording|live on|off, or wb stats set every 1|2|5")
        try:
            stats.set_setting(a.key, a.value)
        except ValueError as e:
            die(str(e))
        print(stats.line())
        return
    if a.json:  # the Stats tab's history (#405)
        print(json.dumps(stats.feed()))
        return
    f = stats.feed(only=(*stats.SUMMARY, "model_lines"))  # the headline: none of the rest (#565)
    head, shown = stats.summary(f), f.get("model_lines") or {}
    # the models OpenCode has now, as the Stats tab shows them; --all every one that ran (#638)
    only = None if a.all or not shown else {v for x in shown.get("lines", []) for v in x["variants"]}
    # the newest stats.STATS_MODEL_LINES of them, the rest counted on one line (2026-11-21)
    more, old = (shown.get("more"), shown.get("older")) if only is not None else (None, None)
    rest = "; ".join(([f"{more['models']} more model(s) used in the last {stats.OLD_DAYS} days: "
                       f"{more['tasks']} task(s)"] if more else [])
                     + ([f"{old['models']} older model(s), retired or idle {stats.OLD_DAYS}+ days: "
                         f"{old['tasks']} task(s)"] if old else []))
    print("\n".join(head + [""] if head else []) + results.table(only)
          + (f"\n{rest} (wb stats --all)" if rest else ""))


def cmd_savings(a):
    """What the delegated tasks saved Claude over a period, against the estimate of writing them
    (savings.py). `--price` sets the electricity price the energy is costed at."""
    if a.price is not None:  # "off" clears it: nothing else could, once set (#609)
        try:
            kwh = None if a.price.strip().lower() == "off" else float(a.price)
        except ValueError:
            kwh = 0.0
        if kwh is not None and not (kwh > 0 and math.isfinite(kwh)):
            die("--price is the electricity price per kWh: a positive number, or off to clear it")
        savings.set_price(kwh)
    period = "month" if a.month else "all" if a.all else "week"
    span = savings.PERIODS[period]
    since = store.now() - span if span else 0
    if a.share:  # to paste into a discussion: sizes, never names (#119)
        found = models.discover()
        rows = store.results()
        print(savings.share(rows, period, since, hardware.gpus(windows=False),
                            {m: models.weights(found[m]) for m in {r.get("model") for r in rows}
                             if m in found}, hardware.system()))
        return
    t = savings.totals(store.results(), since=since)
    if a.card:  # made here, from the totals alone: the user decides where it goes (#101)
        Path(a.card).write_text(savings.card(t, period), encoding="utf-8")
        s = savings.score(t)
        print(f"wrote {a.card}: " + (f"{s['score']}/100. {s['sentence']}" if s else savings.NO_SCORE))
    elif a.json:
        print(json.dumps({"period": period, **t, "score": savings.score(t), "price": savings.price()}))
    else:
        print(savings.summary(t, period))


def cmd_backlog(a):
    """A batch of tasks started with `--backlog`: each one's phase, rounds, minutes, branch and
    saving, and the batch's saving (the morning summary). Without a name, the batches."""
    tasks = [t for t in store.all_tasks(archived=True) if t.spec.get("backlog")]  # #270
    if not a.name:
        names = {}
        for t in tasks:
            names.setdefault(t.spec["backlog"], []).append(t)
        if a.json:  # it printed the text (#602)
            print(json.dumps([{"backlog": name, "tasks": len(ts),
                               "open": sum(1 for t in ts if t.status.get("phase") not in store.CLOSED)}
                              for name, ts in names.items()]))
            return
        if not names:
            print("no backlogs (wb start --backlog NAME starts one)")
        for name, ts in names.items():
            left = sum(1 for t in ts if t.status.get("phase") not in store.CLOSED)
            print(f"{name}: {len(ts)} task(s), {left} open")
        return
    tasks = [t for t in tasks if t.spec["backlog"] == a.name]
    if not tasks:
        die(f"no backlog {a.name!r} (wb backlog lists them)")
    rows = {r.get("task"): r for r in store.results(trials=True)}
    out = []
    for t in tasks:
        if t.status.get("phase") in LIVE:
            reap(t)
        st, row = t.status, rows.get(t.name) or {}
        since = t.spec.get("created_at") or store.now()
        out.append({"task": t.name, "phase": st.get("phase", "?"), "rounds": st.get("round", 1),
                    "minutes": row.get("minutes") or round((store.now() - since) / 60, 1),
                    "branch": t.spec.get("branch") if st.get("phase") == "accepted" else None,
                    "saving": savings.line(row) if row else None})
    batch = savings.totals([r for t in tasks if (r := rows.get(t.name)) and not r.get("trial")])
    if a.json:
        print(json.dumps({"backlog": a.name, "tasks": out, "totals": batch}))
        return
    phases = {}
    for o in out:
        phases[o["phase"]] = phases.get(o["phase"], 0) + 1
    print(f"backlog {a.name}: {len(out)} task(s) · "
          + " · ".join(f"{n} {p}" for p, n in phases.items()))
    for o in out:
        tail = " · ".join(x for x in (o["branch"], o["saving"]) if x)
        print(f"{o['task']:22} {o['phase']:9} {o['rounds']:>3} {o['minutes']:>5.0f}m  {tail}".rstrip())
    print(savings.summary(batch, "the batch"))


def cmd_tune(a):
    print(tuning.table())


def cmd_trial(a):
    """Closed tasks that were checks of workbench itself, not work: their results stop counting.
    An open task is refused: it has no results row yet, so it was marked as nothing while its
    lessons were dropped, and its accept later counted (the 2026-11-16 audit)."""
    live = [n for n in a.names if store.Task(n).exists
            and store.Task(n).status.get("phase") not in store.CLOSED]
    if live:
        die(f"{', '.join(live)} still open: wb trial marks closed tasks (wb start --trial marks "
            "one up front)")
    hit = store.mark_trials(set(a.names))
    open_ = [i for i, x in lessons._all()[0].items() if x["task"] in a.names]
    shut = lessons.close(open_, "dropped", "a trial run: a check of workbench, not work")
    print(f"trial runs now, left out of the record: {', '.join(hit)}" if hit
          else "no unmarked results for those tasks")
    if shut:
        print(f"lessons dropped with them: {len(shut)}")


def cmd_bench(a):
    """Replays of accepted tasks, graded by their hidden checks (bench.py)."""
    if a.bench_cmd == "add":
        with _ends_cleanly():  # a kill at Claude's Bash limit: the clones and the tests go (#589)
            print("\n".join(bench.add(a.task, a.step, a.hidden, a.check, a.name)))
    elif a.bench_cmd == "list":
        print("\n".join(bench.list_lines()))
    elif a.bench_cmd == "rm":
        print(f"removed case(s) {', '.join(bench.remove(a.case))}; their results stay in the report")
    elif a.bench_cmd == "run":
        if a.repeat < 1:
            die("--repeat is at least 1")
        _, lines = bench.start(a.model or [], a.case or [], _skill_names(a.skill), a.label or "",
                               a.repeat)
        print("\n".join(lines))
    elif a.bench_cmd == "self":  # spends Claude's tokens: the user's yes, every time (#118)
        if not a.yes:
            die("wb bench self runs Claude Code on the case and spends Claude tokens: add --yes")
        try:
            with _ends_cleanly():  # claude -p and the checkout go with it, and a row says so (#589)
                row = bench.self_run(a.case, a.turns)
        except RuntimeError as e:
            die(str(e))
        store.append_jsonl(bench.runs_file(), row)
        print("\n".join(bench.self_lines([row])[1:]) if row.get("outcome") != "error" else
              f"{a.case}: didn't run: {row['why']}")
    elif a.bench_cmd == "stop":
        pid = bench.stop_driver()
        print(f"stopped the bench run (pid {pid})" if pid else "no bench run is running")
    else:
        print(bench.report(a.run, a.label))


def cmd_optimize(a):
    """On request only: measure each Ollama model's window fit here (optimize.py)."""
    try:
        if a.action == "estimate":
            ms = optimize.candidates()
            if not ms:
                die("no Ollama model here to measure (wb models)")
            mins = optimize.estimate(ms) / 60
            print(f"wb optimize would load {len(ms)} model(s) at a few windows each: about "
                  f"{max(1, round(mins))} min, holding the GPU alone (a task that wants it stops it). "
                  "Nothing wakes Claude.")
            cases = bench.cases()
            if a.bench and cases:
                hours = sum(((c.get("original") or {}).get("minutes") or 30)
                            for c in cases.values()) * len(ms) / 60
                print(f"--bench then replays the bench's {len(cases)} case(s) on each model: about "
                      f"{hours:.1f} h more, best overnight")
        elif a.action == "start":
            if lines := optimize.start(a.bench, a.if_due):
                print("\n".join(lines))
        elif a.action == "stop":
            pid = optimize.stop()
            print(f"stopped wb optimize (pid {pid}); what it measured is kept" if pid
                  else "wb optimize is not running")
        elif a.action == "apply":
            if not a.ids:
                die("name the model(s): wb optimize apply <id>…")
            for i in a.ids:
                print(optimize.apply(models.resolve(i)))
        else:
            print("\n".join(optimize.report()))
    except (KeyError, RuntimeError, OSError) as e:
        die(e.args[0] if e.args else str(e))


SCOUT_EVERY_DAYS = 7


def scout_state() -> dict:
    return store.read_json(store.home() / "scout.json", {}) or {}


def cmd_scout(a):
    """The weekly model check's facts: this machine, what is installed, how each model does.
    Claude reads it, looks up what is newest and best for this hardware, and recommends."""
    path = store.home() / "scout.json"
    st = scout_state()
    if a.notes is not None and not a.done:  # saved nothing, and printed the report (#602)
        die("--notes goes with --done: wb scout --done --notes \"…\"")
    if a.done:
        store.write_json(path, {**st, "done_at": store.now(), "notes": a.notes or ""})
        print(f"model check recorded; the next one is due in {SCOUT_EVERY_DAYS} days")
        return
    watch = store.home() / "watch.json"
    items = store.read_json(watch, []) or []
    if a.watch:
        store.write_json(watch, items + [{"ts": store.now(), "text": a.watch}])
        print("added to the watch list")
        return
    if a.unwatch is not None:  # 0 printed the weekly report as if it had done something (#602)
        if not 1 <= a.unwatch <= len(items):
            die(f"the watch list has {len(items)} item(s)")
        store.write_json(watch, items[:a.unwatch - 1] + items[a.unwatch:])
        print("removed from the watch list")
        return
    if a.due:
        due = store.now() - st.get("done_at", 0) > SCOUT_EVERY_DAYS * 86400
        print("due" if due else "not due")
        sys.exit(0 if due else 1)
    when = st.get("done_at")
    print("last model check: " + (f"{time.strftime('%Y-%m-%d', time.localtime(when))}, "
                                  f"{(store.now() - when) / 86400:.0f} days ago"
                                  + (f": {st['notes']}" if st.get("notes") else "") if when else "never"))
    if items:
        print("\nwatch list: what would reopen a past decision; check each against what is new")
        for i, r in enumerate(items, 1):
            print(f"  {i}. ({time.strftime('%Y-%m-%d', time.localtime(r['ts']))}) {r['text']}")
    have = skills.available()
    use = skills.usage(skills.revs(list(have)))
    flagged = [(n, skills.advice(use.get(n), store.now())) for n in have]
    flagged = [(n, w) for n, w in flagged if w and w != "never offered yet"]
    print(f"\nskill library: {len(have)} skill(s)" + (", all pulling their weight" if have and not flagged else ""))
    for n, w in flagged:
        print(f"  {n}: {w}")
    pending = lessons.survey()
    if pending:
        print(f"lessons waiting: {len(pending)}, {sum(bool(x['again']) for x in pending)} seen in "
              "more than one task (wb lessons)")
    print("\nhardware")
    print("\n".join(hardware.report()))
    print("  " + gpu_line())
    if said := ollama_line():
        print("  " + said)
    print("\nimage engines (wb image)")
    print("\n".join(image_lines()) or f"  none: describe one in {images.config_path()}")
    if said := image_server_lines():
        print("\n".join(said))  # #753: one already running, before any install
    print("\naudio engines (wb audio)")
    print("\n".join(audio.lines()) or f"  none: describe one in {audio.config_path()}")
    if said := audio.coverage():
        print(said)
    provs = models.providers()
    registered = models.discover()
    print("\nmodel servers here (work with what the user runs)")
    print("\n".join(server_lines(provs)))
    print("\nmodels OpenCode can use (opencode.json)")
    real = defaultdict(list)
    for r in store.results():
        if tuning.judged(r):  # a discard Claude put down to its own spec says nothing of the model
            real[r.get("model")].append(r)
    for pid, prov in provs.items():
        # an Ollama that doesn't answer is asked once, not for every model (the 2026-11-16 audit)
        up = prov["engine"] == "ollama" and (models._fake() or models.ollama_answers(prov["root"]))
        if prov["engine"] == "ollama" and not up:
            print(f"  {pid}: Ollama isn't answering at {prov['root']}, so what it has and serves is unknown")
        installed = {x["name"]: x for x in models.ollama_installed(prov["root"])} if up else {}
        other = prov["engine"] != "ollama" and not models._fake() and \
            models._ask(f"{models.openai_base(prov['url'])}/models", prov["key"], timeout=1) is not None
        for name, e in prov["models"].items():
            m = registered.get(f"{pid}/{name}")
            asked = served_name(name, e)  # the server's name for it: an alias's id (#588)
            disk = installed.get(asked) or installed.get(f"{asked}:latest") or {}
            said = models.server_facts(prov["root"], asked, prov["key"]) if other else {}
            if said.get("weights"):
                disk = {"size": said["weights"]}
            served = models.ollama_served_context(prov["root"], asked) if up else said.get("context")
            ctx = ((m.config.get("limit") or {}).get("context") or 0) if m else 0
            facts = " · ".join(x for x in (
                f"{hardware.size(disk.get('size'))} on disk" if disk.get("size") else "",
                disk.get("params") or "", disk.get("quant") or "",
                f"{ctx // 1024}K context" if ctx else "no limit.context" if m else "",
                f"{'Ollama' if up else 'the server'} serves {served // 1024}K" if served else "") if x)
            rs = real.get(f"{pid}/{name}", [])
            used = (f"{len(rs)} real task(s), {sum(r['outcome'] == 'accepted' for r in rs)} accepted, "
                    f"last {time.strftime('%Y-%m-%d', time.localtime(max(r['ts'] for r in rs)))}"
                    if rs else "no real tasks yet")
            replayed = bench.model_line(f"{pid}/{name}")
            print(f"  {pid}/{name}: {facts or prov['engine']} · {used}"
                  + (f" · bench: {replayed}" if replayed else "")
                  + (f"\n    slice: {router.slice(m).line()}" if m else ""))
        names = {served_name(n, e).removesuffix(":latest") for n, e in prov["models"].items()}
        extra = [x for x in installed if x.removesuffix(":latest") not in names]
        local = [x for x in extra if not installed[x]["cloud"]]
        if local:
            print(f"  installed in {pid} but not registered: " + ", ".join(
                f"{x} ({hardware.size(installed[x]['size'])})" for x in local))
        if cloud := [x for x in extra if installed[x]["cloud"]]:  # stubs: ollama.com runs them
            print(f"  Ollama cloud models in {pid} (off this machine, not candidates): " + ", ".join(cloud))
    if not provs:
        print("  none: " + models.why_none())
        if models.ollama_answers(root := models.ollama_root_here()):
            print(f"  Ollama answers at {root} but OpenCode has no provider for it (wb model add "
                  "ollama/<model> adds one); it has: " + (", ".join(
                      x["name"] for x in models.ollama_installed(root)) or "nothing pulled"))
    cfg = models.read_config()
    print(f"  OpenCode's default: {cfg.get('model') or '(none)'}")
    print("\nreal results (wb stats)")
    print(results.table())
    print("\nnext: compare with what is newest and best for this hardware, recommend to the user, "
          "and when done: wb scout --done --notes \"…\"")


def served_name(key: str, entry) -> str:
    """The name the server knows a config entry by: its `id` (an alias, #203), else its key."""
    return str((entry.get("id") if isinstance(entry, dict) else None) or key)


def server_lines(provs: dict) -> list[str]:
    """wb scout's view of the model servers on this machine, whichever they are: the commands on
    PATH, and each default port that answers, with whether OpenCode has a provider for it."""
    on_path, answering = models.servers_here()
    keys = {models.server_key(p.get("url") or p["root"]) for p in provs.values()}  # ::1, a LAN IP (#588)
    lines = [f"  on PATH: {', '.join(on_path)}"] if on_path else []
    for x in answering:
        listed = ", ".join(x["models"][:8]) + (", ..." if len(x["models"]) > 8 else "") or (
            "it wants an API key (its provider's options.apiKey)" if x.get("key") else "no models")
        known = models.server_key(x["root"]) in keys
        if x.get("windows"):  # WSL2's Windows host, beyond this machine (#663)
            lines.append(f"  {x['root']} answers on Windows (usually {x['usually']}): {listed}"
                         + ("" if known else f"; it needs local: true (wb remote {x['windows']} "
                            f"for an Ollama; else wb model add <provider>/<model> --url "
                            f"{x['root']}/v1 --context N, then local: true for its provider in "
                            f"{models.overrides_path()})"))
            continue
        lines.append(f"  {x['root']} answers (usually {x['usually']}): {listed}" + (
            "" if known else f"; OpenCode has no provider for it (wb model add <provider>/<model> "
                             f"--url {x['root']}/v1 --context N)"))
    if not answering and models.windows_host():  # whatever is on PATH here (#663)
        lines.append(f"  none answering here: {models.WSL_NAT}")
    return lines or ["  none found on PATH or answering on the usual ports"]


def _skill_names(names) -> list[str]:
    """Library skills named on the command line (repeatable, or comma-separated), checked."""
    out = [x for n in names or [] for x in n.split(",") if x]
    try:
        skills.resolve(out)
    except KeyError as e:
        die(f"no skill {e.args[0]} in the library (wb skill list)")
    return list(dict.fromkeys(out))


def _union(a, b) -> list[str]:
    return list(dict.fromkeys([*(a or []), *(b or [])]))


def _say(line: str | None) -> None:
    if line:
        print(line)


def _one_project(ids, name: str) -> list[str]:
    """A warning when every lesson behind a new skill came from one repo: the library is for
    every project, and a rule only that one needs belongs in it."""
    from_ = lessons.repos([x for i in ids or [] for x in i.split(",") if x])
    if len(from_) != 1 or None in from_:
        return []
    repo = next(iter(from_))
    return [f"every lesson behind it came from {Path(repo).name}: if only that project needs it, "
            f"move it to {repo}/.claude/skills/{name}/ (committed there) and wb skill retire {name}"]


def _closed_by(ids, name: str) -> str:
    """Close the lessons a skill change took in; the line saying so."""
    done = lessons.close([x for i in ids or [] for x in i.split(",") if x], f"skill:{name}")
    return f"\nlessons closed: {', '.join(done)}" if done else ""


def cmd_skill(a):
    """Claude's skill library for the agents: write, hand out, take back, retire."""
    if a.action == "list":
        have, now = skills.available(), store.now()
        use = skills.usage(skills.revs(list(have)))
        if not have:
            print(f"the skill library is empty ({skills.library()}); "
                  "wb skill add <name> --from <file> -m \"why\" starts it")
            return
        personal = set(context.denied_skills()) - {"workbench"}
        for name, info in have.items():
            note = skills.advice(use.get(name), now)
            print(f"{name}: {info['description']}\n  {skills.record_line(use.get(name))}"
                  + (f" · {note}" if note else "")
                  # handed, the library's loads (#515); unhanded, the agent sees neither
                  + (" · one of the user's own skills has this name too: a task it is handed "
                     "to gets this one" if name in personal else ""))
        return
    if a.action == "show":
        have = skills.available()
        if a.name not in have:
            die(f"no skill {a.name} in the library")
        print((have[a.name]["path"] / "SKILL.md").read_text().rstrip())
        print("\nhistory:\n" + "\n".join("  " + h for h in skills.history(a.name)))
        return
    if a.action == "add":
        personal = set(context.denied_skills())
        if a.name in personal:
            die(f"{a.name} is the name of one of the user's own skills; pick another")
        try:
            verb, warns = skills.add(Path(a.source), a.name, a.message, a.origin or "",
                                     tuple(a.reviewed or ()))
        except (ValueError, OSError, RuntimeError) as e:  # a copy or git failure too (#604)
            die(f"not added: {_skill_failure(e)}")
        print(f"{verb} {a.name}" + "".join(f"\nwarning: {w}" for w in warns + _one_project(a.lesson, a.name))
              + _closed_by(a.lesson, a.name))
        return
    if a.action == "patch":
        old = Path(a.old_file).read_text() if a.old_file else a.old
        new = Path(a.new_file).read_text() if a.new_file else a.new
        if not old or new is None:
            die("say what to replace: --old and --new (or --old-file and --new-file)")
        try:
            warns = skills.patch(a.name, old, new, a.message)
        except KeyError:
            die(f"no skill {a.name} in the library")
        except (ValueError, OSError, RuntimeError) as e:
            die(f"not patched: {_skill_failure(e)}")
        print(f"patched {a.name} ({skills.rev(a.name)}); tasks from now on are judged on this version"
              + "".join(f"\nwarning: {w}" for w in warns) + _closed_by(a.lesson, a.name))
        return
    if a.action == "scan":
        target = skills.available().get(a.name, {}).get("path") or Path(a.name)
        if not target.exists():
            die(f"no skill or path {a.name}")
        found = scan.scan(target)
        print(f"{scan.verdict(found)}: {target}" + "".join(f"\n  {x}" for x in scan.lines(found)))
        return
    if a.action == "import":
        cmd_skill_import(a)
        return
    if a.action == "retire":
        try:
            skills.retire(a.name, a.message)
        except KeyError:
            die(f"no skill {a.name} in the library")
        except (OSError, RuntimeError) as e:
            die(f"not retired: {_skill_failure(e)}")
        print(f"retired {a.name} (wb skill restore {a.name} brings it back)")
        return
    if a.action == "restore":
        try:
            skills.restore(a.name)
        except KeyError:
            die(f"no retired skill {a.name}")
        except ValueError as e:
            die(str(e))
        except (OSError, RuntimeError) as e:
            die(f"not restored: {_skill_failure(e)}")
        print(f"restored {a.name}")
        return
    # hand / take: change what one task's agent holds, from its next run on
    task = need(a.task)
    names = _skill_names(a.names) if a.action == "hand" else \
        [x for n in a.names for x in n.split(",") if x]
    st = task.status
    held = st.get("skills") or []
    if a.action == "hand":
        held = _union(held, names)
        task.set_status(skills=held, skills_ever=_union(st.get("skills_ever"), names),
                        skills_rev={**(st.get("skills_rev") or {}), **skills.revs(names)})
    else:
        held = [x for x in held if x not in names]
        task.set_status(skills=held)
    when = "from its next run" + (" (`wb steer --now` starts that run now)" if runner_alive(task)
                                  else "")
    print(f"{task.name} holds: {', '.join(held) or 'no skills'}; the agent is told {when}")


def _skill_failure(e: Exception) -> str:
    """One line for a skill command's failure: shutil.Error carries a list of (src, dst, why), one
    per file it couldn't copy (#604)."""
    if isinstance(e, shutil.Error) and e.args and isinstance(e.args[0], list) and e.args[0]:
        rows = e.args[0]
        first = rows[0]
        said = (f"{first[0]}: {first[2]}" if isinstance(first, tuple) and len(first) == 3
                else str(first))
        return f"couldn't copy {said}" + (f" (and {len(rows) - 1} more)" if len(rows) > 1 else "")
    return str(e).splitlines()[0] if str(e) else type(e).__name__


def cmd_skill_import(a):
    """Fetch a skill from outside (a git URL, owner/repo on GitHub, or a path) for Claude to read.
    Nothing enters the library here: a dangerous one is refused and removed; anything else
    waits in the state directory until Claude has read it, made it ours and added it."""
    try:
        root, meta, found = skills.fetch(a.src, a.path)
    except (RuntimeError, subprocess.TimeoutExpired) as e:
        die(str(e))
    if not found:
        die(f"no SKILL.md {'at ' + a.path if a.path else 'anywhere'} in {meta['source']}")
    if len(found) > 1:
        print(f"{len(found)} skills in {meta['source']}; pick one with --path:")
        for d in found[:40]:
            print(f"  {d.relative_to(root)}: {skills.parse(d / 'SKILL.md')['description'][:120]}")
        return
    d = found[0]
    findings = scan.scan(d)
    verdict = scan.verdict(findings)
    origin = f"{meta['source']}" + (f"@{meta['rev'][:12]}" if meta["rev"] else "") + \
        (f" {d.relative_to(root)}" if d != root else "")
    print(f"{d.relative_to(root) if d != root else d.name} from {origin}\n"
          f"license: {skills.license_of(d, root)}\nsha256: {scan.content_hash(d)}\nscan: {verdict}"
          + "".join(f"\n  {x}" for x in scan.lines(findings)))
    if verdict == "dangerous":
        if root.is_relative_to(store.home() / "imports"):
            shutil.rmtree(root, ignore_errors=True)
        die("refused: don't take anything from this skill")
    problems, warns = skills.check(d / "SKILL.md", a.name or d.name)
    for w in problems + warns:
        print(f"  lint: {w}")
    print(f"\nread it all: {d}\nthen make it ours (our format, our voice, only what fits the "
          "agents' work), write it to the scratchpad, and:\n"
          f"  wb skill add {a.name or d.name} --from <dir> -m \"why\" --source \"{origin}, "
          f"{skills.license_of(d, root)}\"")


NOTES_MAX, NOTE_CHARS = 20, 300  # the mod puts them in every workbench-mode prompt: keep them few


def _notes() -> list[str]:
    try:
        text = (store.home() / "notes.md").read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    notes = []
    for line in text.splitlines():  # a hand-wrapped line belongs to the note above it
        if line.startswith("- ") or not notes:
            notes.append(line.removeprefix("- ").strip())
        elif line.strip():
            notes[-1] += " " + line.strip()
    return [n for n in notes if n]


def cmd_notes(a):
    """What Claude has learned about how the user wants delegation run, in any project: the mod
    hands them to every workbench-mode session, so they follow the user from repo to repo."""
    path = store.home() / "notes.md"
    with store.locked(store.home() / "notes.lock"):
        notes = _notes()
        if a.action == "add":
            text = " ".join(" ".join(a.args).split())
            if not text:
                die('wb notes add "<what the user wants, in any project>"')
            if len(text) > NOTE_CHARS:
                die(f"{len(text)} chars (max {NOTE_CHARS}): one preference, in a sentence")
            if len(notes) >= NOTES_MAX:
                die(f"{NOTES_MAX} notes already: drop or merge one first (wb notes drop N)")
            notes.append(text)
        elif a.action == "drop":
            try:
                gone = sorted({int(n) for n in a.args}, reverse=True)
                for n in gone:
                    if not 1 <= n <= len(notes):
                        raise ValueError
            except ValueError:
                die(f"wb notes drop N: a number from 1 to {len(notes)}" if notes else "no notes yet")
            for n in gone:
                del notes[n - 1]
        if a.action:
            store.replace_bytes(path, "".join(f"- {n}\n" for n in notes).encode("utf-8"))  # #734
    if not notes:
        print("no notes yet: wb notes add \"<what the user wants, in any project>\"")
    for i, n in enumerate(notes, 1):
        print(f"{i}. {n}")


def cmd_lessons(a):
    """What tasks taught, waiting for Claude: write or patch a skill, or close it with why."""
    if a.action == "close":
        done = lessons.close([x for i in a.ids for x in i.split(",") if x], "dropped", a.message)
        print(f"closed: {', '.join(done)}" if done else "none of those is open")
        return
    pending = [x for x in lessons.survey() if not a.task or x["task"] == a.task]
    if not pending:
        print("no open lessons")
        return
    shown = pending if a.all else pending[:12]
    again = sum(bool(x["again"]) for x in pending)
    print(f"open lessons: {len(pending)}" + (f", {again} seen in more than one task" if again else ""))
    for x in shown:
        print("  " + lessons.line(x))
    if len(shown) < len(pending):
        print(f"  … and {len(pending) - len(shown)} more (--all)")
    print("next: a lesson in a skill: wb skill patch|add … --lesson <id>; not one (a one-task "
          "detail, the environment, a dead end): wb lessons close <id> -m why")


def image_lines() -> list[str]:
    out = []
    for name, e in images.engines().items():
        why = images.ready(e)
        out.append(f"  {name}{'' if media.on_gpu(e) else ' (off the GPU)'}: "
                   f"{str(e.get('label') or e.get('command') or e.get('url') or '')[:60]}"
                   f" · {'ready' if not why else why}"
                   + (" · a server: it holds its GPU memory while it runs"
                      + ("" if e.get("unload") else " (no unload URL)")  # #749, as audio's
                      if e.get("url") and not e.get("command") and media.on_gpu(e) else "")
                   + (f"\n    {e['notes']}" if e.get("notes") else ""))
    return out


IMAGE_SERVERS = {
    "comfyui": ("ComfyUI", '{{"url": "{root}", "workflow": "<a workflow saved with Export (API)>"}}'),
    "a1111": ("AUTOMATIC1111's API (A1111, Forge, SD.Next)",
              '{{"url": "{root}/sdapi/v1/txt2img", "unload": "{root}/sdapi/v1/unload-checkpoint"}}'),
}


def image_server_lines() -> list[str]:
    """An image server answering on its default port here that no engine names, with the entry
    that would use it: the skill proposed an 11 GB install to a user already running ComfyUI or
    Forge (#753)."""
    named = set()  # (host, port): the host as the url has it, and "" for this machine's
    for e in images.engines().values():
        try:
            u = urlparse(str(e.get("url") or ""))
            if u.port:
                named.add(((u.hostname or "").lower(), u.port))
                if models._this_host(u.hostname):
                    named.add(("", u.port))
        except ValueError:  # a url that doesn't parse: listed as not usable (#748)
            pass
    out = []
    for s in images.servers_here():
        port = urlparse(s["root"]).port
        if ((s.get("windows") or "").lower(), port) in named:
            continue
        # one on Windows (WSL2's NAT, #923) answers at the host's address: it listens beyond
        # Windows' own localhost (ComfyUI's --listen), which it has to keep for this to reach it
        where = " on Windows (keep it started with --listen)" if s.get("windows") else ""
        if s["api"] in IMAGE_SERVERS:
            what, entry = IMAGE_SERVERS[s["api"]]
            out.append(f"  {what} answers at {s['root']}{where}, and no engine uses it: "
                       + entry.format(root=s["root"]))
        else:
            usual = next(IMAGE_SERVERS[k][0] for p, k, _ in images.PORTS if p == port)
            out.append(f"  something answers at {s['root']}{where} ({usual}'s port), but not its API"
                       + (" (AUTOMATIC1111 needs --api)" if port == 7860 else ""))
    return out


def cmd_image(a):
    """Local image generation: Claude writes the prompt, looks at the candidates, keeps one."""
    # `wb image list`, like `wb skill list`, used to draw four pictures of "list" (the 2026-11-16 audit)
    if a.list or not a.prompt or a.prompt.strip().lower() in ("list", "ls"):
        print("\n".join(image_lines()) or f"no image engine: describe one in {images.config_path()}")
        return
    try:
        w, h = (int(x) for x in a.size.lower().split("x"))
    except ValueError:
        die(f"--size {a.size!r}: WIDTHxHEIGHT, e.g. 1024x1024")
    out = Path(a.out) if a.out else store.home() / "images" / time.strftime("%Y%m%d-%H%M%S")
    try:
        # a kill at Claude's Bash limit ends it as an error would: the engine's group killed, the
        # GPU lease and the temp directory let go (#589, the audit of 1.90)
        with _ends_cleanly():
            made = images.generate(a.prompt, out, n=a.n, size=(w, h), seed=a.seed, name=a.engine,
                                   refs=a.ref or [], say=lambda m: print(m, flush=True), wait=a.wait)
    except (KeyError, RuntimeError, OSError, subprocess.TimeoutExpired) as e:
        die(str(e).strip("'\""))
    print(f"{len(made)} image(s) in {out}: look at each before choosing; the .json beside each "
          "holds its prompt and seed")


def cmd_audio(a):
    """Local audio: Claude writes the brief, reads each candidate's checks (it can't hear them),
    keeps one or asks the user to listen."""
    if a.list or not a.text or a.text.strip().lower() in ("list", "ls"):
        print("\n".join(audio.lines()) or f"no audio engine: describe one in {audio.config_path()}")
        return
    lyrics = ""
    if a.lyrics:
        try:
            lyrics = sys.stdin.read() if a.lyrics == "-" else Path(a.lyrics).read_text()
        except OSError as e:
            die(f"--lyrics {a.lyrics}: {e.strerror or e}")
    out = Path(a.out) if a.out else store.home() / "audio" / time.strftime("%Y%m%d-%H%M%S")
    try:
        with _ends_cleanly():  # as wb image: the engine, the lease, the unload, the temp (#589)
            made = audio.generate(a.text, out, kind=a.kind, n=a.n, seconds=a.seconds, voice=a.voice,
                                  lyrics=lyrics.strip(), refs=a.ref or [], seed=a.seed, name=a.engine,
                                  check=not a.no_check, say=lambda m: print(m, flush=True), wait=a.wait)
    except (KeyError, RuntimeError, OSError, subprocess.TimeoutExpired) as e:
        die(str(e).strip("'\""))
    print(f"{len(made)} clip(s) in {out}: you can't hear them, so read each check line and look at "
          "each spectrogram; for music or a voice's character, ask the user to listen")


def _model_rename(old: str, rest: list) -> None:
    """wb model rename OLD NEW: NEW carries on OLD's record (models.json `renamed_from`, #818)."""
    if len(rest or []) != 1:
        die("wb model rename <old id> <new id>")
    try:
        m = models.resolve(rest[0])
    except KeyError as e:
        die(e.args[0] if e.args else f"no model {rest[0]}")
    if old == m.id:
        die(f"{old} is already its id")
    if old in models.discover():  # two configured ids on one record would count its tasks twice
        die(f"{old} is still in OpenCode's config: retire it first (wb model retire {old}), or "
            "leave the two apart")
    if not (any(r.get("model") == old for r in store.results(trials=True))
            or (store.read_json(router._speed_path(), {}) or {}).get(old)):
        die(f"nothing is recorded under {old}: no task or speed to carry over")
    models.set_override(m.id, "renamed_from", old)
    print(f"{m.id} carries on {old}'s record: its routing, slice, tuned settings, speed and "
          "Stats line")


def cmd_model(a):
    """Add a model to OpenCode's config (pulling it first with --pull), or retire one."""
    # before sizes, which returned first: a flag for another action was accepted and ignored (#602)
    if a.action != "add" and (a.url or a.start or a.stop or a.label or a.context or a.pull):
        die("--url, --start, --stop, --label, --context and --pull go with wb model add")
    if a.action != "retire" and a.delete:
        die("--delete goes with wb model retire")
    if a.action == "rename":
        return _model_rename(a.id, a.sizes)
    if a.action != "sizes" and a.sizes:
        die(f"sizes ({' '.join(a.sizes)}) go with wb model sizes <id>")
    if a.action == "sizes":
        try:
            m = models.resolve(a.id)
        except KeyError as e:
            die(e.args[0] if e.args else f"no model {a.id}")
        bad = set(a.sizes or ()) - set(router.SIZES)
        if bad:
            die(f"sizes are {', '.join(router.SIZES)}")
        models.set_override(m.id, "sizes", sorted(set(a.sizes)) if a.sizes else None)
        print(f"{m.id}: routed " + (" and ".join(sorted(set(a.sizes))) + " tasks only"
                                    if a.sizes else "tasks of every size"))
        return
    provider, _, name = a.id.partition("/")
    if a.action == "add" and name and a.url:
        try:  # any OpenAI-compatible server, not only Ollama (the server is the user's choice)
            if models.add_server_provider(provider, a.url):
                print(f"added provider {provider} to {models.opencode_config_path()}: {a.url}")
        except RuntimeError as e:
            die(str(e))
    if a.action == "add" and name:  # how wb starts and stops a server that runs one model each
        for key, cmd in (("start", a.start), ("stop", a.stop)):
            if cmd:
                models.set_override(a.id, key, cmd)
    provs = models.providers()
    if a.action == "add" and name and provider == "ollama" and provider not in provs:
        try:  # the first run: Ollama answers, OpenCode has no provider for it
            root = models.add_ollama_provider(provider)
        except RuntimeError as e:
            die(str(e))
        if root:
            print(f"added provider {provider} to {models.opencode_config_path()}: the Ollama at {root}")
            provs = models.providers()
    if provider not in provs or not name:
        skipped = dict(models.skipped_providers())
        die(f"provider {provider}: {skipped[provider]}" if provider in skipped else
            f"name it provider/model, with one of OpenCode's local providers: {', '.join(provs)}"
            if provs else f"no local provider: {models.why_none()}")
    prov = provs[provider]
    if a.action == "add":
        # the server's name for it: an existing alias's id, not its key (#588, the audit of 1.90)
        asked = served_name(name, prov["models"].get(name))
        if prov["problem"]:
            die(f"provider {provider}: {prov['problem']}")
        _say(prov.get("engine_note"))  # an Ollama emulator, driven as a server (#580)
        own = models._overrides().get(a.id) or {}
        if not prov["engine_known"] and not prov["start"] and not own.get("start"):
            # a guess would write an Ollama entry without its output cap, or the reverse
            # (the 2026-11-16 audit)
            die(f"{prov['root']} is not answering, so wb can't tell whether {provider} is Ollama: "
                f"start it, or pass --start (the command that starts it), or set \"engine\" for "
                f"{provider} in {models.overrides_path()}, and retry")
        if prov["engine"] == "ollama" and not models._fake() and not models.ollama_answers(prov["root"]):
            # a pull then died with a urllib traceback, and a describe blamed a missing pull
            # (the 2026-11-16 audit)
            die(f"Ollama isn't answering at {prov['root']}: start it (ollama serve, or its "
                "service or app), then retry")
        if prov["engine"] == "ollama" and models.ollama_cloud(prov["root"], asked) \
                and not models.cloud_allowed(a.id):
            die(f"{a.id} is an Ollama cloud model: it runs on ollama.com, off this machine. To hand "
                f"it work anyway, give it \"local\": true in {models.overrides_path()} first")
        if a.pull:
            if prov["engine"] != "ollama":
                die(f"{provider} is not an Ollama provider; install the model the server's own way")
            try:
                models.ollama_pull(prov["root"], asked, say=lambda m: print(m, flush=True))
            except (OSError, RuntimeError, ValueError) as e:  # URLError and HTTPError are OSErrors
                die(f"pulling {asked} failed: {getattr(e, 'reason', e)}")
        try:
            facts = models.ollama_show(prov["root"], asked) if prov["engine"] == "ollama" else {}
        except Exception as e:
            die(f"{provider} can't describe {asked} ({e}): is it pulled? (--pull downloads it)")
        caps = facts.get("capabilities") or []
        # the context the server actually serves: what it says it gives this model, else what
        # this provider's other models are set to. Never Ollama's trained length: it serves its
        # own small default then, and the prompt was cut off silently (the 2026-11-16 audit)
        other = {} if prov["engine"] == "ollama" or models._fake() else \
            models.server_facts(prov["root"], asked, prov["key"])
        served = models.ollama_served_context(prov["root"], asked) if prov["engine"] == "ollama" \
            else other.get("context")
        # never a sibling's window for Ollama: it serves each model its own (a `wb optimize`
        # variant's 64K is its Modelfile's), and llama3.1:8b beside qwen3:8b-64k was registered
        # 64K while Ollama served its default (#464, the audit of 1.8)
        siblings = [] if prov["engine"] == "ollama" else \
            [(e.get("limit") or {}).get("context") for e in prov["models"].values()]
        ctx = a.context or served or next((c for c in siblings if c), None)
        if prov["engine"] == "ollama":
            if not ctx:
                die(f"Ollama would serve {name} its own default context (often 4K-8K, too small for "
                    "OpenCode's ~10K-token prompt): set OLLAMA_CONTEXT_LENGTH (e.g. 32768) in the "
                    f"Ollama service and restart it, then wb model add {a.id} again; or pass "
                    "--context N if you know what it serves")
            ctx = min(ctx, facts.get("context_length") or ctx)  # never past what it was trained on
        elif not ctx and not ((prov["models"].get(name) or {}).get("limit") or {}).get("context"):
            # an entry with no window: no handovers, no compaction, and the server cut the
            # session off mid-task (the 2026-11-16 audit)
            die(f"{provider} doesn't say what window it serves {name} (LM Studio: not loaded yet): "
                "pass --context N, the context the server was started with (llama.cpp -c, LM "
                "Studio's context length, vLLM --max-model-len)")
        if ctx and ctx < models.MIN_WINDOW:
            die(f"{a.id}: {models.small_window_why(ctx)}")
        if a.context and other.get("context") and a.context > other["context"]:
            print(f"--  {provider} serves {name} a {other['context'] // 1024}K window, below --context "
                  f"{a.context}: it would cut prompts off until the server is started with more")
        tools = "tools" in caps if caps else other.get("tools") is not False  # LM Studio says
        entry = {"name": a.label or name,
                 "tool_call": tools,
                 "reasoning": "thinking" in caps if caps else True}
        if ctx:
            out = ctx // 8  # 4K on a 32K window; a bigger window writes bigger files in one call
            entry["limit"] = {"context": ctx, "input": ctx - out, "output": out}
        if prov["engine"] == "ollama":
            entry["options"] = {"max_tokens": models.ollama_cap(entry)}
        try:
            models.write_entry(provider, name, entry)
        except RuntimeError as e:
            die(str(e))
        ctx = ctx or prov["models"][name]["limit"]["context"]  # kept from the entry as it was
        print(f"registered {a.id}: "
              f"{'tools' if entry['tool_call'] else 'NO tool calls, so wb will not route tasks to it'}, "
              f"{'reasoning' if entry['reasoning'] else 'no reasoning'}, "
              f"{ctx // 1024}K context\nnext: wb model sizes {a.id} … if it should only "
              "take some task sizes; the router guesses from its size until real tasks show more")
        return
    # retire
    cfg = models.read_config()
    if cfg.get("model") == a.id:
        die(f"{a.id} is OpenCode's default model; wb models --set-default picks another first")
    if cfg.get("small_model") == a.id:  # left naming it, other OpenCode sessions broke (#708)
        die(f"{a.id} is OpenCode's small_model; set small_model in {models.opencode_config_path()} "
            "to another model (or remove it) first")
    if name not in prov["models"]:
        die(f"{a.id} is not registered")
    if a.delete and prov["engine"] == "ollama":
        # Two aliases of one Ollama model share its weights: retiring one with --delete left the
        # default "not pulled", since only the entry names were compared (#333, the audit of 1.4)
        def weights(n, e):
            w = str((e or {}).get("id") or n)
            return w if ":" in w else w + ":latest"  # Ollama's own name for an untagged model
        mine = weights(name, prov["models"][name])
        here = models.server_key(prov["url"])  # localhost and 127.0.0.1 are one Ollama (#368)
        # every provider the config has, disabled ones too: one left out of disabled_providers
        # again would have to pull the weights again (#458, the audit of 1.8)
        sharing = [f"{pid}/{n}" for pid, p, url, _, _ in models.configured_providers()
                   if models.server_key(url) == here for n, e in (p.get("models") or {}).items()
                   if (pid, n) != (provider, name) and weights(n, e) == mine]
        if sharing:
            die(f"--delete would delete the weights {', '.join(sharing)} also use ({mine}): "
                f"wb model retire {a.id} without --delete keeps them")
    try:
        models.write_entry(provider, name, None)
    except RuntimeError as e:
        die(str(e))
    for key in list(models._overrides().get(a.id) or {}):  # its sizes, labels, start/stop
        if key not in ("variant_of", "replaces"):  # its rows stay in its source's record (#723)
            models.set_override(a.id, key, None)
    done = f"retired {a.id}: removed from OpenCode's config (its measurements stay in the history)"
    if a.delete:
        if prov["engine"] != "ollama":
            done += f"; {provider} is not Ollama, so delete its weights the server's own way"
        else:  # the entry is gone already: say what's left rather than crash (the 2026-11-16 audit)
            try:  # an alias's weights are its id's (the 2026-11-19 audit)
                name = str((prov["models"].get(name) or {}).get("id") or name)
                models.ollama_delete(prov["root"], name)
                done += "; its weights were deleted from Ollama"
            except OSError as e:  # URLError and HTTPError are OSErrors
                done += ("; Ollama had no weights for it" if getattr(e, "code", None) == 404 else
                         f"; its weights were NOT deleted ({getattr(e, 'reason', e)}): ollama rm {name}")
    print(done)


LOCAL_CLAUDE_MD = "CLAUDE.md is gitignored: agents get the checkout's copy"


def claude_md_status(repo: Path, ref: str = "HEAD", under: str = "") -> str:
    """One line on the repo's CLAUDE.md at ref: missing, local, or how far behind the code it
    may be. With ``under`` (a monorepo package, task.json `subdir`) the package's own file first,
    measured against the package's commits only: accept said a repo whose packages each have
    one had none, sending Claude to write a root CLAUDE.md nobody needed (#783)."""
    if under and not _claude_md_at(repo, ref, under) and _local_package_md(repo, under):
        return LOCAL_CLAUDE_MD  # the package's, kept out of git (#785)
    if under and (md := _claude_md_at(repo, ref, under)):
        md = f"{under}/{md}"
        last = gitops.git(repo, "log", "-1", "--format=%h", ref, "--", md).strip()
        since = int(gitops.git(repo, "rev-list", "--count", f"{last}..{ref}", "--", under,
                               f":!{md}", f":!{under}/AGENTS.md").strip() or 0)
        return (f"{md} is current with {ref}" if not since else
                f"{md} last changed {since} commit(s) before {ref} ({last})")
    md = _claude_md_at(repo, ref)  # CLAUDE.md before .claude/CLAUDE.md: AGENTS.md links to it
    if not md:
        return LOCAL_CLAUDE_MD if _local_claude_md(repo) else "no CLAUDE.md"
    last = gitops.git(repo, "log", "-1", "--format=%h", ref, "--", md).strip()
    since = int(gitops.git(repo, "rev-list", "--count", f"{last}..{ref}", "--", ".",
                           f":!{md}", ":!AGENTS.md").strip() or 0)  # commits that changed code
    return (f"{md} is current with {ref}" if not since else
            f"{md} last changed {since} commit(s) before {ref} ({last})")


# What wb init won't put in a project's first commit (the 2026-11-16 audit: an .env with an API
# key, node_modules and .venv all went in). Matched on a file's name, and on a path's directories.
SECRET_FILES = (".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa", "id_ed25519",
                "id_ecdsa", "id_dsa", "credentials.json", ".npmrc", ".pypirc", ".netrc")
NOT_SECRET = (".env.example", ".env.sample", ".env.template")
VENDORED = ("node_modules", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache")


def _unfit_for_commit(d: Path) -> tuple[list[str], list[str]]:
    """(likely secrets, vendored or generated directories) among the files the first commit
    would take: the untracked ones `git add -A` adds, and what is already staged (a staged .env
    went in, whatever .gitignore said: #80, the 2026-11-18 audit); `target/` counts only beside
    a Cargo.toml."""
    secrets, vendored = [], set()
    files = gitops.git(d, "ls-files", "--others", "--exclude-standard", "-z").split("\0")
    files += gitops.git(d, "ls-files", "--cached", "-z").split("\0")
    for n in dict.fromkeys(files):
        if not n:
            continue
        parts = n.rstrip("/").split("/")
        if parts[-1] not in NOT_SECRET and any(fnmatch.fnmatch(parts[-1], p) for p in SECRET_FILES):
            secrets.append(n)
        for i, c in enumerate(parts[:-1] if not n.endswith("/") else parts):
            if c in VENDORED or c == "target" and (d.joinpath(*parts[:i]) / "Cargo.toml").is_file():
                vendored.add("/".join(parts[:i + 1]) + "/")
                break
    return secrets, sorted(vendored)


def cmd_init(a):
    """Set a project up as Claude keeps every project: a git repo (on git's init.defaultBranch)
    with an initial commit, AGENTS.md a symlink to CLAUDE.md. Safe to run again; no remote is ever added."""
    d = Path(a.dir).expanduser().resolve()
    if Path.home().resolve().is_relative_to(d):  # the home directory, or above it (/ included)
        die(f"wb init takes a project's own directory, not {d}: make one (e.g. ~/projects/<name>)")
    d.mkdir(parents=True, exist_ok=True)
    try:
        inside = str(gitops.toplevel(d))
    except gitops.NotARepo:
        inside = ""
    except gitops.GitError as e:  # a repo git refuses (dubious ownership) is no place to git init
        die(f"{d}: {str(e).split(': ', 1)[-1]}")
    if inside and Path(inside) != d and Path.home().resolve().is_relative_to(inside):
        # a home kept as a git repo (dotfiles, `git init` in ~) is no project: a repo of its own
        # nested in it is. Refused, wb try could never run there and the advice didn't apply (#684)
        inside = ""
    if inside and Path(inside) != d:
        die(f"{d} is inside the git repo {inside}; init the project in a directory of its own, "
            "outside that repo")
    if not _identity(d):
        die("git has no user.name/user.email: the user's identity signs the commits "
            "(git config --global user.name/user.email)")
    did = []
    if not inside:
        gitops.git(d, "init", "-q")  # on the user's init.defaultBranch
        did.append("git repo on " + (gitops.git(d, "symbolic-ref", "--short", "HEAD",
                                                check=False).strip() or "its default branch"))
    has_commits = bool(gitops.git(d, "rev-parse", "--verify", "-q", "HEAD", check=False).strip())
    # HEAD's and the index's CLAUDE.md and AGENTS.md before anything changes: the commit below
    # holds only what wb init made, built from these (#931)
    head, index = (_md_entries(d, "ls-tree", "HEAD"), _md_entries(d, "ls-files", "-s")) \
        if has_commits else ({}, {})
    moved = False  # AGENTS.md's file became CLAUDE.md
    if not has_commits:  # before anything is changed: a run after the fix starts clean
        secrets, vendored = _unfit_for_commit(d)
        if secrets or vendored:
            die(f"not committing {d} as it is: "
                + (f"these look like secrets, which never go in git: {', '.join(secrets[:10])}"
                   + (f" (+{len(secrets) - 10})" if len(secrets) > 10 else "") + "; " if secrets else "")
                + (f"these are installed or generated: {', '.join(vendored[:10])}; " if vendored else "")
                + f"add them to {d / '.gitignore'} (or remove them) and run wb init again")
    claude, agents = d / "CLAUDE.md", d / "AGENTS.md"
    if claude.is_symlink() and agents.is_file() and not agents.is_symlink() \
            and claude.resolve() == agents.resolve():
        # CLAUDE.md -> AGENTS.md, the reverse convention: swap them. Comparing the two names'
        # text once deleted AGENTS.md, the only copy (the audit)
        claude.unlink()
        agents.rename(claude)
        agents.symlink_to("CLAUDE.md")
        did.append("AGENTS.md moved to CLAUDE.md, which it now links to")
        moved = True
    if agents.is_file() and not agents.is_symlink() and not claude.exists():
        agents.rename(claude)  # the project's instructions live in CLAUDE.md, AGENTS.md points at it
        did.append("AGENTS.md moved to CLAUDE.md")
        moved = True
    if claude.is_file() and agents.is_file() and not agents.is_symlink():
        if not os.path.samefile(claude, agents) and agents.read_bytes() == claude.read_bytes():
            agents.unlink()
        else:
            print("AGENTS.md and CLAUDE.md differ: merge them into CLAUDE.md, delete AGENTS.md, "
                  "and run wb init again")
    local = _local_claude_md(d)  # kept out of git: a link to it would dangle in every clone
    if claude.is_file() and not local and not agents.exists() and not agents.is_symlink():
        agents.symlink_to("CLAUDE.md")
        did.append("AGENTS.md → CLAUDE.md")
    if not has_commits:
        gitops.git(d, "add", "-A")  # the agents work from commits: the project as it is now
        n = len(gitops.git(d, "diff", "--cached", "--name-only", "-z").split("\0")) - 1
        gitops.git(d, "commit", "-q", "--allow-empty", "-m", "Initial commit")
        did.append(f"initial commit of the {n} file(s) here (git show --stat to check)" if n
                   else "initial commit")
    elif any("AGENTS.md" in x for x in did):
        did.append(_commit_link(d, head, index, moved))
    status = claude_md_status(d)
    print(f"{d}: " + (", ".join(did) if did else "already set up") + f"; {status}"
          + (" (AGENTS.md not linked)" if local else "")
          + ("\nnote: CLAUDE.md is a link to a missing file" if claude.is_symlink() and not claude.exists() else "")
          + ("\nnext: write CLAUDE.md (what the project is, how to build and test it, its "
             "conventions), commit it, then wb init again to link AGENTS.md"
             if status == "no CLAUDE.md" else ""))


def _md_entries(d: Path, *ls) -> dict:
    """{path: (mode, blob)} for CLAUDE.md and AGENTS.md from ``git ls-tree HEAD`` or ``git
    ls-files -s`` (the index): the two lines differ only in what sits between mode and hash."""
    out = {}
    for line in gitops.git(d, *ls, "-z", "--", "CLAUDE.md", "AGENTS.md").split("\0"):
        if "\t" in line:
            meta, path = line.split("\t", 1)
            f = meta.split()
            out[path] = (f[0], f[1] if ls[0] == "ls-files" else f[2])
    return out


def _commit_link(d: Path, head: dict, index: dict, moved: bool) -> str:
    """Commit what wb init made in a repo with commits, and nothing of the user's: the AGENTS.md
    link and, when AGENTS.md's file moved to CLAUDE.md, the committed text under its new name.
    `git add -A -- CLAUDE.md AGENTS.md` and a path-limited commit took CLAUDE.md's working copy
    into "chore: AGENTS.md links to CLAUDE.md" and dropped whatever of it was staged (#931, the
    outside review of 1.90.24), so the commit is built in a scratch index from HEAD and the
    user's index and working tree keep their bytes. A path whose index already differed from
    HEAD (a staged change of theirs), or a link whose CLAUDE.md isn't committed, is left to them."""
    import tempfile
    if moved and _local_claude_md(d):
        # a committed AGENTS.md moved to a gitignored CLAUDE.md, which gets no link: the commit
        # held a link the worktree lacked and force-tracked the CLAUDE.md that is never to be
        # committed (the review of #931). Git sees AGENTS.md deleted: the user's call
        return ("not committed: CLAUDE.md is gitignored, so AGENTS.md's move to it is yours to "
                "commit" if "AGENTS.md" in head else "nothing to commit: CLAUDE.md is gitignored")
    with tempfile.TemporaryDirectory(prefix="wb-init-") as tmp:
        (link := Path(tmp, "link")).write_text("CLAUDE.md")
        agents = d / "AGENTS.md"
        new = {"AGENTS.md": ("120000", gitops.git(d, "hash-object", "-w", "--no-filters",
                                                  str(link)).strip())} \
            if agents.is_symlink() and os.readlink(agents) == "CLAUDE.md" else {}  # only what is there
        if moved and head.get("AGENTS.md", ("",))[0].startswith("100"):
            new["CLAUDE.md"] = head["AGENTS.md"]  # its committed text: unstaged edits stay unstaged
        changed = {p: e for p, e in new.items() if head.get(p) != e}
        if not changed:
            return "already committed"
        if what := gitops.under_way(d):  # its commit is the user's (the review of #931)
            return (f"not committed: {what} is under way here, so commit "
                    + " and ".join(sorted(changed)) + " yourself once it is done")
        if (moved and "CLAUDE.md" not in new) or any(index.get(p) != head.get(p) for p in changed) \
                or not {**head, **changed}.get("CLAUDE.md", ("",))[0].startswith("100"):
            return ("not committed: CLAUDE.md or AGENTS.md has changes of yours (staged, or not "
                    "committed yet), so commit them yourself")
        env = {"GIT_INDEX_FILE": str(Path(tmp, "index"))}
        gitops.git(d, "read-tree", "HEAD", env=env)
        for p, (mode, blob) in changed.items():
            gitops.git(d, "update-index", "--add", "--cacheinfo", f"{mode},{blob},{p}", env=env)
        # no hooks: one with a scratch GIT_INDEX_FILE (lint-staged's stash) could rewrite the tree
        gitops.git(d, *gitops.NO_HOOKS, "commit", "-q", "-m", "chore: AGENTS.md links to CLAUDE.md",
                   env=env)
    for p, (mode, blob) in changed.items():  # their index matched HEAD here: now the new HEAD
        gitops.git(d, "update-index", "--add", "--cacheinfo", f"{mode},{blob},{p}")
    return "committed"


# What `wb events` reports: the state, not the work (worktrees) or the noise. rules/ (the agents'
# config layers and shims) is nothing the mod reads; each closed task is skipped too (cmd_events):
# a thousand finished tasks were 4,000 inotify watches per Claude session, or a rescan of them
# four times a second without inotify (the 2026-11-16 audit).
EVENT_SKIP = ("tasks/*/worktree", "tasks/*/tree", "tasks/*/rounds", "rules", "imports", "images", "audio",
              "archive", "chat/audio",  # chat/audio: the takes copied for the page (#397)  # clones (tree/: one nested for a sibling further up, #261), outputs
              # and the scratch clones and indexes (the base check, verify, shot, bench, a
              # submodule fill, a merge): one with a copied node_modules took a wb events from 2
              # watched directories to 605, and each write there woke the mod (#373, the audit
              # of 1.6); and the bench's (`wb bench add`'s .base-/.check- clones, a run's
              # replays): 1,209 of 1,211 watches were there (#439)
              "bench/.?*", "bench/runs",
              # the web chat's uploads (one directory each, kept ARCHIVE_DAYS) and each bench case's
              # hidden tests: nothing the mod acts on is written there, and each upload's rename
              # woke it for nothing (#842)
              "chat/uploads", "bench/cases",
              *(SCRATCH := (".?*", "wb-index-*", "wb-merge-*")))  # .?*: not "." (the home itself)
QUIET = (".lock", ".tmp", "runner.log")


def _scratch(rel: str) -> bool:
    """Whether a path under the state directory is in a scratch clone or index (SCRATCH)."""
    top = rel.split("/")[0]
    return any(fnmatch.fnmatch(top, pat) for pat in SCRATCH)


def cmd_events(a):
    """One JSON line the moment workbench's state changes: what the mod listens to instead of
    polling. The first line is {"hello": pid}; it ends when the process that started it does."""
    home = store.home()
    (home / "tasks").mkdir(parents=True, exist_ok=True)
    chat.chat_dir()
    parent = os.getppid()
    # its start too: the mod records both in chat/listener.json, so a recycled pid isn't a listener (#532)
    # and its parent's, the Claude Code process: the mod claims tasks for it (wb adopt, #687)
    # and this machine, which the mod records beside its pids: on a shared state directory a pid
    # of another machine's is never read as gone here (#922)
    print(json.dumps({"hello": os.getpid(), "start": models._started(os.getpid()),
                      "parent": parent, "parent_start": models._started(parent),
                      "machine": store.machine()}), flush=True)
    # accepted and discarded are final and names aren't reused; tasks/ itself stays watched, so a
    # new task is picked up, and one that closes while this runs simply stays watched
    closed = tuple(f"tasks/{t.name}" for t in store.all_tasks() if t.status.get("phase") in store.CLOSED)
    reaped = time.time()
    with Watcher(home, recursive=True, skip=EVENT_SKIP + closed) as w:
        while os.getppid() == parent:
            changed = {rel for p in w.wait(10)
                       if not p.name.endswith(QUIET) and not p.name.startswith(".")
                       and not _scratch(rel := str(p.relative_to(home)))}
            if time.time() - reaped > 60:  # a runner that died silently: its failed notice
                reaped = time.time()       # wakes the mod like any other (reap)
                for t in store.all_tasks():
                    if t.status.get("phase") in LIVE:
                        reap(t)
            if changed:
                try:
                    print(json.dumps({"changed": sorted(changed)}), flush=True)
                except BrokenPipeError:
                    return


def cmd_top(a):
    """A live feed of the machine: GPUs, running tasks, the rack of models, the GPU's queue."""
    from . import top
    # a finite, sane interval: inf printed `"every": Infinity` (not JSON) and then overflowed
    # time.sleep, and 1e-6 spun a core re-reading every task's files (#611)
    if a.every is not None and not TOP_EVERY[0] <= a.every <= TOP_EVERY[1]:
        die(f"--every takes seconds from {TOP_EVERY[0]:g} to {TOP_EVERY[1]:g}")
    top.main(every=a.every, as_json=a.json)


TOP_EVERY = (0.2, 3600)  # wb top --every's range, in seconds (NaN and inf fail the comparison)


def cmd_chat(a):
    """The web chat: the user's side door to Claude while away from the terminal."""
    if a.more and a.action != "listen":
        die(f"wb chat {a.action}: too many arguments")
    named = a.port is not None
    if a.port is None:  # named: that port; else the running server's, else the default (#349)
        a.port = chat.PORT if a.action == "serve" else chat.port()
    if a.action == "serve":
        try:
            chat.serve(a.port, a.bind or None, a.host or None, say=lambda m: print(m, flush=True))
        except chat.ConfigError as e:  # 78 (EX_CONFIG): wb-chat.service stops, no retry fixes it
            die(str(e), 78)
    elif a.action == "url":  # silent but for the link: the mod reads it whole
        back = chat.revive()  # a chat wb chat on started, gone after a reboot or a crash (#449)
        print(chat.url(a.port if named or not back else back))  # the token is the key: keep it private
    elif a.action == "on":  # the pane's switch, kept: the link shows and a session listens
        # the switch goes on only with a server of ours answering: turned on first and left on
        # when this died, the pane's row read On and pinned a link that gave a 401 or nothing,
        # its reason never shown (#690)
        who = chat.who_answers(a.port)
        if who == "workbench":
            chat.set_on(True)
            print(f"web chat on: {chat.url(a.port)}")
        elif who == "other":  # its link would open someone else's page (#200), or 401 (#554)
            chat.set_on(False)
            die(f"web chat left off: another account's chat (or another program, or a server still "
                f"on a replaced token) answers on port {a.port}: wb chat on --port <free port> (and "
                "the same --port in chat.json's service, if any)")
        else:
            pid = chat.start(a.port)
            log = chat.chat_dir() / "serve.log"
            if not chat.wait_up(a.port, pid):
                chat.set_on(False)
                tail = (log.read_text(errors="replace").strip().splitlines() or ["(nothing)"])[-1]
                die(f"web chat left off: its server didn't start: {tail} ({log})")
            chat.set_on(True)
            print(f"web chat on: started its server (pid {pid}, {log}): {chat.url(a.port)}")
        for why in logout_stops():  # its unit is a user service: a logout stops it (#351)
            print(f"--  {why}")
    elif a.action == "off":
        chat.set_on(False)
        if chat.stop_started():
            print("web chat off: stopped the server it started")
        elif chat.running(a.port):
            print("web chat off: no link in the pane and no session listens; a server still runs "
                  f"({chat.service_name()}: {chat.service_hint('stop')} stops it)")  # #756
        else:
            print("web chat off")
    elif a.action == "reply":
        text = (a.text if a.text is not None else
                Path(a.message).read_text() if a.message and a.message != "-" else sys.stdin.read()).strip()
        if not text:
            die("the reply is empty")
        chat.send(text, "claude")
        print("sent to the web chat")
    elif a.action == "listen":  # the takes the user picks from by ear (#397)
        clips = [c for c in (a.id, a.verdict, *a.more) if c]
        try:
            m = chat.listen(clips, (a.text or "").strip())
        except (ValueError, OSError) as e:
            die(f"wb chat listen: {e}")
        print(f"sent {len(m['audio']['clips'])} take(s) to the web chat: the user's pick comes back "
              "as a chat message")
    elif a.action == "ack":
        chat.ack(a.id, a.by or "claude", a.how)
    elif a.action == "claim":  # the mod, before it submits a message: exit 1 if another has it
        if a.id and chat.expired(a.id):  # one threshold, wb's: the page shows it unsent (#536)
            die(f"{a.id} expired: over {chat.MESSAGE_EXPIRE // 3600} hours unread, so not passed to "
                "Claude; the page offers to send it again")
        if not a.id or not chat.claim(a.id, a.by or "claude"):
            die(f"{a.id} is another session's to submit")
    elif a.action == "pending":
        for r in chat.pending():
            print(json.dumps(r))
    elif a.action == "ask":  # the mod: a dialog for the away user; prints its id and its state
        if not a.tool or a.kind not in chat.KINDS:
            die("wb chat ask needs --tool, and --kind permission|plan|question")
        try:
            detail = json.loads(a.detail) if a.detail else None
        except ValueError:
            die("--detail is JSON")
        unknown = False
        if a.kind == "plan" and not (detail or {}).get("plan"):  # the input may hold only its file
            detail = {"plan": chat.session_plan(a.session, (detail or {}).get("plan_file"))}
            if unknown := not detail["plan"]:  # not another project's newest plan (#253)
                detail["project"] = Path(a.repo).name if a.repo else ""
        if not (a.text or a.kind != "permission"):
            die("wb chat ask --kind permission needs --text")
        try:
            row = chat.ask(a.tool, a.text or "", a.kind, detail, pid=a.pid)
            if unknown:  # nothing to answer on the page: the dialog comes up in its terminal
                row = chat.answer(row["id"], "expired", "terminal")
        except ValueError as e:
            die(f"wb chat ask: {e}")
        print(row["id"], row["answer"] or "open")
    elif a.action == "wait":  # the mod: the answer once there is one; open at the timeout
        if not a.id:
            die("wb chat wait <ask id>")
        try:
            got = chat.wait_answer(a.id, a.timeout)
        except KeyError:
            die(f"no permission prompt {a.id}")
        print(json.dumps(chat.find_ask(a.id)) if a.json else got or "open")
    elif a.action == "answer":
        if not a.id or a.verdict not in chat.ANSWERS:
            die("wb chat answer <ask id> allow|deny|expired")
        try:
            cur = chat.answer(a.id, a.verdict, a.by or "cli", note=a.note)
        except ValueError:
            die("a question is answered on the page, with its choices")
        if cur is None:
            die(f"no permission prompt {a.id}")
        print(cur["answer"])
    else:  # log
        for r in chat.thread()[-a.n:]:
            who = "you" if r["from"] == "user" else "Claude"
            files = "".join(f" [attached: {f.get('path')}]" for f in r.get("files") or [] if isinstance(f, dict))
            print(f"{time.strftime('%H:%M', time.localtime(r['ts']))} {who}: {r['text']}{files}")
        lst = chat.listener()
        print(f"listening: {lst['cwd']}" if lst else "no session is listening")


def chat_gap() -> str | None:
    """With the switch on, what keeps the chat from answering: the pane shows its link whatever
    runs, and a chat gone after a reboot or a crash went unnoticed (#449)."""
    if not chat.is_on():
        return None
    port = chat.port()
    try:
        who = chat.who_answers(port)
    except RuntimeError as e:  # chat.json it can't follow
        return f"the web chat is on, but {e}"
    if who == "workbench":
        return None
    if who == "other":
        return (f"the web chat is on, but something else answers on port {port} (another account's "
                "chat, or another program): wb chat on --port <free port>")
    return f"the web chat is on, but no server answers on port {port}: wb chat on starts one"


def logout_stops() -> list[str]:
    """What a logout would stop, from logind: the user manager (so wb-chat.service, and every
    scope `detach` made) unless the user lingers, and every process in the login session, under
    KillUserProcesses=yes, all that `detach` started too (runners, wb bench and wb optimize runs,
    the chat `wb chat on` started: #531) when it can't give them a scope.
    A headless box reached by SSH, or a desktop logged out overnight, lost the chat and the night's
    backlog without a word (#351, the audit of 1.4). Empty when logind can't say (macOS, WSL
    without systemd, a container): unknown isn't a warning."""
    if not shutil.which("loginctl"):
        return []
    out = []
    user = os.environ.get("USER") or str(os.getuid())
    lingers = _loginctl("show-user", user, "-p", "Linger", "--value")
    scoped = runner_scope()
    if lingers == "no":
        out.append(f"logind stops your user services at logout, the web chat's wb-chat.service "
                   f"{'and the runners, bench and optimize runs going then ' if scoped else ''}too: "
                   f"loginctl enable-linger {user} keeps them up")
    if kills_sessions() and not scoped:
        out.append("logind kills every process of a login session at logout (KillUserProcesses=yes),"
                   " running tasks, wb bench and wb optimize runs and a chat wb chat on started too,"
                   " and systemd-run --user can't give them a scope of their own: start wb from a"
                   " session that stays, or set KillUserProcesses=no in /etc/systemd/logind.conf")
    return out


def path_advice() -> str:
    """How to put ~/.local/bin on PATH for the user's own shell, then restart Claude Code. "Add
    it" was all wb setup said, and on macOS, or in a Claude Code started from the Dock or an IDE,
    PATH comes from places users don't know (#274, the audit of 1.2)."""
    shell = Path(os.environ.get("SHELL") or "sh").name
    if shell == "fish":
        how = "run: fish_add_path ~/.local/bin"
    else:
        rc = {"zsh": "~/.zshrc", "bash": "~/.bash_profile" if sys.platform == "darwin" else "~/.bashrc"}
        how = (f"run: echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> {rc.get(shell, '~/.profile')}")
    return (f"For {shell}, {how}; then quit Claude Code and start it again from a new terminal "
            "(the desktop app or an IDE too: each reads PATH only when it starts)")


def cmd_setup(a):
    """Link `wb` onto PATH and /workbench into Claude Code's skills, from wherever this copy lives:
    the marketplace's clone (~/.claude/plugins/marketplaces/workbench) for users, a git clone for
    development (2026-11-16: the plugin install copies only mod/, so these two come from here)."""
    links = [(Path.home() / ".local/bin/wb", PKG_ROOT / "bin/wb"),
             (context.claude_home() / "skills/workbench", PKG_ROOT / "skill/workbench")]
    bad = False
    for at, to in links:
        if at.is_symlink() and at.resolve() == to.resolve():
            print(f"ok  {at} → {to}")
            continue
        if at.is_symlink() and a.force:
            at.unlink()
        elif at.is_symlink() or at.exists():
            bad = True
            print(f"BAD {at} is already {'a link to ' + os.readlink(at) if at.is_symlink() else 'there'}: "
                  f"left as it is{' (--force replaces a link)' if at.is_symlink() else ''}")
            continue
        at.parent.mkdir(parents=True, exist_ok=True)
        at.symlink_to(to)
        print(f"ok  {at} → {to} (made)")
    old = context.claude_home() / "skills/delegate"  # /delegate became /workbench (2026-11-17)
    if old.is_symlink() and not old.exists() and os.readlink(old).rstrip("/").endswith("skill/delegate"):
        old.unlink()
        print(f"ok  {old} removed: /delegate is now /workbench")
    bindir = str(Path.home() / ".local/bin")
    if bindir not in os.environ.get("PATH", "").split(os.pathsep):
        print(f"--  {bindir} isn't on PATH: Claude and the mod run wb by name (WB_BIN moves only "
              f"the mod's calls). {path_advice()}")
    try:  # a minute or two, said up front; a task started meanwhile goes first
        for line in optimize.start(if_due=True):
            print(f"--  {line}")
    except (RuntimeError, OSError):
        pass
    print("first run:")  # what a working setup still needs, each with its fix (#111)
    for line in first_run():
        print(line)
    print("next: wb doctor")
    sys.exit(1 if bad else 0)


def _tool_version(argv: list[str]) -> tuple[bool, str]:
    try:
        r = subprocess.run([*argv, "--version"], capture_output=True, text=True, timeout=30)
        return r.returncode == 0, r.stdout.strip() or r.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, f"not found ({e})"


def first_run() -> list[str]:
    """wb setup's checklist, one line each: OpenCode 2.x, a model server answering, a registered
    model, Landlock; a missing one says how to get it. It names no model: Claude picks one for this
    machine (wb scout), so a newer one slots in without a code change."""
    out = []
    good, said = _tool_version(runner.opencode_bin())
    major = re.search(r"(\d+)\.\d+", said) if good else None
    if not good:
        out.append(f"--  OpenCode isn't installed: install OpenCode 2.x: {runner.OPENCODE_GET}")
    elif major and int(major[1]) < 2:
        out.append(f"--  opencode {said}: workbench needs OpenCode 2.x: {runner.OPENCODE_GET}")
    else:
        out.append(f"ok  {said if said.lower().startswith('opencode') else 'opencode ' + said}")
    try:
        found = models.discover()
    except RuntimeError:  # an OpenCode config that doesn't parse: wb doctor says which
        found = {}
    on_windows = []
    if models._fake():
        answering = bool(found)
    else:
        answering = any(models.ollama_answers(p["root"]) or
                        isinstance(models._get(f"{p['root']}/v1/models", timeout=1), dict)
                        for p in models.providers().values())
        answering = answering or models.ollama_answers(models.ollama_root_here())
        if not answering:
            here = models.servers_here()[1]
            on_windows = [x for x in here if x.get("windows")]
            answering = len(here) > len(on_windows)
    if not answering and on_windows:  # WSL2: answering at the Windows host only (#663)
        out.append(f"--  a model server answers on Windows at {on_windows[0]['root']} (usually "
                   f"{on_windows[0]['usually']}): it needs local: true (wb remote "
                   f"{on_windows[0]['windows']} for an Ollama; else wb model add <p>/<m> --url "
                   f"{on_windows[0]['root']}/v1, then local: true for its provider in "
                   f"{models.overrides_path()})")
    else:
        out.append("ok  a model server answers" if answering else
                   "--  no model server answers here: start yours, or run /workbench and Claude "
                   "lays out the ones that fit this machine; any OpenAI-compatible server works "
                   "(wb model add <p>/<m> --url <baseURL>)"
                   + (f"; {models.WSL_NAT}" if models.windows_host() else ""))
    out.append(f"ok  {len(found)} local model(s) registered" if found else
               "--  no local model registered yet: run /workbench in Claude Code, and Claude picks one "
               "for this machine (wb scout)")
    v = lane.abi()
    out.append(f"ok  Landlock ABI {v}: each agent writes only inside its task" if v else
               "--  no Landlock here: agents run unconfined (on Linux, a 5.13+ kernel with Landlock "
               "on; none on macOS)")
    return out


TRY = PKG_ROOT / "workbench" / "try"  # wb try's sample: project/, spec.md, check.py (the hidden check)


def try_dir() -> Path:
    """Where wb try's samples go: beside the skill library, never in the state directory, which
    the lane hides from agents: the first real run's agent had no git there, its worktree's git
    directory being the sample's (#164)."""
    return skills.library().parent / "try"


def cmd_try(a):
    """A sample task that proves the setup: a tiny project copied into try_dir()/<n>, set up
    as wb init sets any project up, its spec started as a trivial trial (never the router's
    evidence), and the hidden check printed for Claude to run at review (#112)."""
    base = try_dir()
    n = 1 + max((int(p.name) for p in base.glob("*") if p.name.isdigit()), default=0)
    while store.Task(f"try-{n}").exists:  # task names are never reused
        n += 1
    d = base / str(n)
    name = f"try-{n}"
    # the Python wb runs on, not PATH's python3: on RHEL 8 that is 3.6, and the untouched base
    # failed its tests (#530)
    py = shlex.quote(sys.executable)
    argv = ["start", name, "--spec", str(TRY / "spec.md"), "--repo", str(d), "--size", "trivial",
            "--trial", "--test", f"{py} -m unittest", *(["--model", a.model] if a.model else [])]
    try:
        # the copy and its init inside: wb init refusing (no git identity, a home that is a
        # git repo) left try/<n> behind, one more at each retry (#530)
        # without Python's caches: one left in the clone's sample (its tests run in place) made
        # wb init refuse the copy as generated files (2026-11-21)
        shutil.copytree(TRY / "project", d, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        with redirect_stdout(io.StringIO()):
            cmd_init(argparse.Namespace(dir=str(d)))
        s = parser().parse_args(argv)
        s.f(s)
    except BaseException:  # refused (the GPU busy, no model): no sample left behind without a task
        if not store.Task(name).exists:
            shutil.rmtree(d, ignore_errors=True)
        raise
    print(f"the sample project: {d}")
    print(f"hidden check, at review: {py} {shlex.quote(str(TRY / 'check.py'))} "
          f"{shlex.quote(str(store.Task(name).worktree))}")


def cmd_remote(a):
    """Another machine's Ollama as this one's models: its provider, marked local, and each
    tool-capable model it has pulled registered as wb model add would (#114); --remove undoes it."""
    if a.remove:
        try:
            pid, names = models.remove_remote(a.host)
        except RuntimeError as e:
            die(str(e))
        print(f"removed {pid} from OpenCode's config" + (f", with {', '.join(names)}" if names else ""))
        return
    try:
        pid, root, names = models.add_remote(a.host, a.port)
    except RuntimeError as e:
        die(str(e))
    print(f"{pid}: the Ollama at {root}, marked local in {models.overrides_path()}")
    if not names:
        print(f"--  it has no model with tool calls pulled: pull one there, then wb remote {a.host} again")
        return
    for name in names:
        out, err = io.StringIO(), io.StringIO()
        try:
            with redirect_stdout(out), redirect_stderr(err):
                cmd_model(argparse.Namespace(action="add", id=f"{pid}/{name}", sizes=[], pull=False,
                                             url=None, start=None, stop=None, label=None,
                                             context=a.context, delete=False))
            print(out.getvalue().splitlines()[0])
        except SystemExit:  # die: why this one wasn't registered, and the rest go on
            print(f"--  {pid}/{name}: {err.getvalue().strip().removeprefix('wb: ')}")
    print("next: wb models (where each one ranks); wb optimize start measures them")


UPDATE_EVERY = 7 * 24 * 3600  # the mod's weekly check (wb update --check --if-due)


def _fetch_origin() -> None:
    """The update check's fetch: never prompts and never hangs. The user's own ssh command
    (GIT_SSH_COMMAND, GIT_SSH, core.sshCommand) is kept, as replacing it picked the wrong key for
    good; with none, ssh runs in BatchMode. No terminal, so nothing can ask, and a time limit
    inside the mod's (the 2026-11-16 audit). From the remote the branch's upstream is on
    (`branch.<name>.remote`), origin only when there is none: a fork's clone tracking
    `upstream/main` read "already up to date" against a stale ref, and a clone with no origin
    couldn't check at all (#875, Claude's audit of 1.90.24)."""
    branch = gitops.git(PKG_ROOT, "symbolic-ref", "-q", "--short", "HEAD", check=False).strip()
    remote = branch and gitops.git(PKG_ROOT, "config", f"branch.{branch}.remote",
                                   check=False).strip() or "origin"
    if remote == ".":  # its upstream is a local branch: nothing to fetch
        return
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "SSH_ASKPASS_REQUIRE": "never"}
    if not (env.get("GIT_SSH_COMMAND") or env.get("GIT_SSH")
            or gitops.git(PKG_ROOT, "config", "core.sshCommand", check=False).strip()):
        env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes -o ConnectTimeout=15"
    try:
        r = subprocess.run(["git", "-C", str(PKG_ROOT), "fetch", "-q", "--", remote], env=env,
                           capture_output=True, stdin=subprocess.DEVNULL, start_new_session=True,
                           timeout=FETCH_SECS)
    except subprocess.TimeoutExpired:
        raise gitops.GitError(f"{remote} didn't answer in {FETCH_SECS}s") from None
    if r.returncode:
        raise gitops.GitError(r.stderr.decode("utf-8", "replace").strip() or "git fetch failed")


FETCH_SECS = 60  # under the mod's 120 s for a wb command


def cmd_update(a):
    """Bring this copy up to date with its origin: the marketplace's clone through Claude Code
    (which also refreshes the mod's cached copy), a developer's clone with a fast-forward pull.
    --check only says whether there is news; --if-due asks the network at most weekly."""
    marketplace = context.claude_home() / "plugins" / "marketplaces"
    kind = "marketplace" if PKG_ROOT.resolve().is_relative_to(marketplace.resolve()) else "clone"
    path = store.home() / "update.json"
    last = store.read_json(path, {})
    if a.if_due and not a.check:  # it pulled and updated at once, weekly or not (#602)
        die("--if-due goes with --check: wb update --check --if-due")
    if a.check:
        quiet = os.environ.get("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC")
        if a.if_due and (quiet or time.time() - last.get("checked_at", 0) < UPDATE_EVERY):
            try:  # no network: the last fetch's upstream against HEAD as it is now, which a hand
                # pull or Claude Code's own update moved (a stale count toasted for a week: the audit)
                behind = int(gitops.git(PKG_ROOT, "rev-list", "--count", "HEAD..@{u}"))
            except (gitops.GitError, ValueError):
                behind = last.get("behind", 0)
        else:
            store.write_json(path, {**last, "checked_at": time.time()})  # a killed check waits too
            try:
                _fetch_origin()
                behind = int(gitops.git(PKG_ROOT, "rev-list", "--count", "HEAD..@{u}"))
            except gitops.GitError as e:
                die(f"couldn't check for an update: {e}")
            store.write_json(path, {"checked_at": time.time(), "behind": behind, "kind": kind})
        print(f"update available: {behind} new commit(s); /workbench-update (or wb update) installs it"
              if behind else "up to date")
        return
    # every check that can refuse comes before any task is stopped: --stop stopped every
    # session's tasks, then died on a dirty clone, a missing claude, a failed fetch, or found
    # nothing new, each task resumed in a fresh session on the same code (#775)
    steps = [["claude", "plugin", "marketplace", "update", "workbench"],
             ["claude", "plugin", "update", "workbench@workbench"]]
    behind = None  # a marketplace copy is one commit deep: its news can't be counted beforehand
    if kind == "clone":  # a clone is its own marketplace: pull, then let Claude Code re-read it
        if gitops.git(PKG_ROOT, "status", "--porcelain", "--untracked-files=no").strip():
            die(f"{PKG_ROOT} has uncommitted changes: commit or stash them, then wb update")
    if not shutil.which("claude"):  # before the pull: a clone once pulled, then died (the audit)
        die("claude isn't on PATH: wb update refreshes the plugin through it (run /workbench-update "
            "in Claude Code, or put claude on PATH)")
    if kind == "clone":
        try:
            _fetch_origin()
            behind = int(gitops.git(PKG_ROOT, "rev-list", "--count", "HEAD..@{u}"))
        except (gitops.GitError, ValueError) as e:
            die(f"couldn't check for an update: {e}")
        # only a clone behind and diverged: one only ahead (a local patch) has nothing to pull,
        # and died here, skipping the plugin steps too (#875)
        if behind and subprocess.run(["git", "-C", str(PKG_ROOT), "merge-base", "--is-ancestor",
                                      "HEAD", "@{u}"], capture_output=True,
                                     stdin=subprocess.DEVNULL).returncode:
            die(f"{PKG_ROOT} has commits its upstream hasn't: a fast-forward pull can't update it "
                "(push or rebase them, then wb update)")
        if behind:  # nothing to pull: no task needs stopping, the plugin steps still run
            steps.insert(0, ["git", "-C", str(PKG_ROOT), "pull", "-q", "--ff-only"])
    live = [t for t in store.all_tasks() if runner_alive(t)] if behind != 0 else []
    if live and not a.stop:  # a pull would change the git shim, the lane and the ask server under them
        # whose each is: the advice was an unscoped `wb stop --all`, which parked other live
        # sessions' agents and acknowledged their news, so no wake ever came there (#694)
        mine = {t.name for t in _scope(live, *_caller(a))[0]} if _caller(a)[1] else set()
        die("tasks are running (" + ", ".join(
            t.name + (" (this session's)" if t.name in mine else f" ({_whose(t)})") for t in live)
            + "): update when they finish, or wb update --stop (stops them; each one's session is "
            "told to wb resume it)")
    stopped = ""
    if live:
        print(_stop_for_update(live))
        names = [t.name for t in live if t.status.get("last") == UPDATE_STOP]
        if names:  # a step failing after the stop says what was stopped and how to go on (#775)
            stopped = f"; the tasks were stopped for it: wb resume {' '.join(names)} continues them"
    before = gitops.git(PKG_ROOT, "rev-parse", "HEAD").strip()
    pulled = ""
    for step in steps:
        try:
            r = subprocess.run(step, capture_output=True, text=True, timeout=300)
            err = (r.stderr or r.stdout).strip()[-300:] if r.returncode else None
        except (OSError, subprocess.TimeoutExpired) as e:
            err = str(e)
        if err is not None:
            die(f"{' '.join(step[:4])} failed: {err}" + pulled + stopped)
        if step[0] == "git":  # landed: the count is 0 whatever the claude steps do next
            store.write_json(path, {"checked_at": time.time(), "behind": 0, "kind": kind})
            pulled = ("; the pull is done: finish with claude plugin marketplace update workbench "
                      "&& claude plugin update workbench@workbench, then /reload-plugins")
    after = gitops.git(PKG_ROOT, "rev-parse", "HEAD").strip()
    store.write_json(path, {"checked_at": time.time(), "behind": 0, "kind": kind})
    if before == after:
        print("already up to date")
    else:
        try:  # Claude Code keeps its marketplace's clone shallow, one commit, and its update
            # replaces it: the old HEAD is gone, and counting from it failed a good update (a
            # user's 0.94 to 1.4, 2026-11-20)
            n = f" ({int(gitops.git(PKG_ROOT, 'rev-list', '--count', f'{before}..{after}'))} commit(s))"
        except (gitops.GitError, ValueError):
            n = ""
        print(f"updated {kind} {before[:7]}..{after[:7]}{n}; /reload-plugins or a restart picks up "
              "the pane")


def _card_example(names: list[str]) -> str:
    """A card with memory of its own of the vendor ``names`` name, for gpu_line's hint: it said
    "an Intel Arc" of a Radeon seen from WSL (#522)."""
    text = " ".join(names).lower()
    for words, example in ((("radeon", "amd"), "a Radeon card"), (("intel", "arc"), "an Intel Arc"),
                           (("nvidia", "geforce", "rtx", "quadro"), "a GeForce card")):
        if any(w in text for w in words):
            return f" ({example})"
    return ""


def gpu_line() -> str:
    """What the GPU budget counts (wb doctor, wb scout): sharing and the router's fit rest on it."""
    budget, _, why = models.budget_devices()
    gs = [] if models._fake() or why == "models.json gpu_gb" else hardware.gpus()
    # a GPU that publishes no memory size (Intel's i915 and xe) is left out of the budget: with
    # none, tasks never share and the user's other Ollama models are unloaded every round; the
    # fix was gpu_gb, and nothing said how to set it (#272, the audit of 1.2)
    unknown = sorted({g["name"] for g in gs if g.get("vram") is None and not g.get("unified")
                      and (g.get("driver") or "").split(" ")[0] in hardware.COMPUTE})  # #710
    hand = (f'set its memory in {models.overrides_path()}: {{"gpu_gb": <the card\'s memory in '
            'decimal GB: 12.9 for a 12 GiB card>}'
            if unknown else "models.json gpu_gb sets it by hand")
    if budget:
        return (f"GPU budget {budget / 1e9:.0f} GB, from {why or 'the GPU'}: tasks share the GPU when "
                "their Ollama models fit in it together" +
                (f"; {', '.join(unknown)} publishes no memory size: if models run on it, {hand}"
                 if unknown else " (models.json gpu_gb sets it by hand)"))
    if gs:
        return (f"GPU memory unknown here ({', '.join(sorted({g['driver'] for g in gs}))}): tasks take "
                "turns on the GPU, and the router can't hold back a model too big for it; "
                + (f"if {', '.join(unknown)} has memory of its own{_card_example(unknown)}, {hand}"
                   if unknown else hand))
    return ("no GPU memory found: local models run on the CPU, slowly; "
            "wb model sizes <id> trivial keeps a big one off small tasks")


def ollama_line() -> str:
    """Where the Ollama here had its settings read (wb doctor, wb scout), or that nothing could
    say: sharing and the GPU budget rest on them (#379, the audit of 1.6). "" without a local
    Ollama model."""
    if models._fake() or not any(m.engine == "ollama" and not m.remote for m in models.discover().values()):
        return ""
    env, source = hardware.ollama_settings()
    if source:
        knobs = ", ".join(f"{k}={env[k]}" for k in hardware.OLLAMA_KNOBS if env.get(k))
        return f"ollama's settings: from {source}" + (
            f" ({knobs})" if knobs else "" if hardware.UNREAD in source else " (Ollama's defaults)")
    return ("ollama's settings unknown: no ollama process here wb may read, no systemd unit, no "
            "ollama container (Ollama for Windows, another user's, a container docker won't show), so "
            "OLLAMA_NUM_PARALLEL, OLLAMA_MAX_LOADED_MODELS and the GPU masks are guessed from wb's own "
            "environment: tasks may share where Ollama swaps, or take turns where they'd fit; "
            f"{models.overrides_path().name}'s gpu_gb sets the GPU budget and each model's vram_gb its size")


# A task waiting on Claude this long was left (a quit, a reboot, a project put down): nothing
# else ever named it, and one such gated the weekly check for good (#541). wb doctor does.
IDLE_DAYS = 3


def idle_line() -> str | None:
    """The tasks waiting on Claude (review, stuck, failed, asking) untouched for IDLE_DAYS+."""
    cutoff = time.time() - IDLE_DAYS * 86400
    old = [t for t in store.all_tasks() if t.status.get("phase") in store.NEEDS_CLAUDE
           and not t.spec.get("bench") and (t.status.get("updated_at") or 0) < cutoff]
    if not old:
        return None
    said = ", ".join(f"{t.name} ({t.status['phase']} {int((time.time() - (t.status.get('updated_at') or 0)) // 86400)}d"
                     + (", parked" if store.parked(t.status) else "") + ")" for t in old)
    return (f"waiting on Claude for {IDLE_DAYS}+ days: {said}: wb resume <name> continues a stuck "
            "or failed one, wb report <name> shows where one stands, wb discard <name> drops one")


def cmd_doctor(a):
    ok = True

    def line(good, what):
        nonlocal ok
        ok &= good
        print(f"{'ok ' if good else 'BAD'} {what}")

    def elsewhere(what, at, mine):
        """Another copy's (a clone and a marketplace install both linked once): it runs, not this
        one, which doctor was checking (the 2026-11-16 audit)."""
        if at and Path(at).exists() and Path(at).resolve() != mine.resolve():
            print(f"--  {what} comes from {Path(at).resolve().parent.parent}, not this copy ({PKG_ROOT}): "
                  "wb setup --force from the copy you want" if Path(at).is_symlink() or what == "wb" else
                  f"--  {at} is a directory of its own, not a link to this copy's {mine}")

    version = _tool_version
    good, said = version(runner.opencode_bin())
    major = re.search(r"(\d+)\.\d+", said) if good else None
    if good and not major:  # an odd build string: say it, don't fail on it
        print(f"--  opencode {said}: its version doesn't parse; workbench needs OpenCode 2.x")
    else:  # the config layer and `run --standalone --auto` are 2.x only (the 2026-11-16 audit)
        old = bool(major) and int(major[1]) < 2
        line(good and not old, f"opencode {said}"
             + (f": workbench needs OpenCode 2.x (checked against 2.3): {runner.OPENCODE_GET}"
                if old else "")
             + ("" if good else f": install OpenCode 2.x: {runner.OPENCODE_GET}"))
        if good and not old and (drift := runner.untested(runner.opencode_version())):
            print(f"--  {drift}")
    files = models.opencode_config_files()
    try:
        models.read_config()
        line(bool(files), "OpenCode config " + (" + ".join(map(str, files)) or
                                                f"{models.opencode_config_path()} (none)")
             + (" (OpenCode layers them; wb won't rewrite either)" if len(files) > 1 else ""))
    except RuntimeError as e:  # "<file> doesn't parse (…)"
        line(False, str(e))
        sys.exit(1)  # nothing below can read the models
    if os.environ.get("OPENCODE_CONFIG_CONTENT"):  # loaded after the files (#347, the audit of 1.4)
        print("--  OPENCODE_CONFIG_CONTENT is set: OpenCode loads it last, wb and the agents too"
              + ("" if models.users_config_content() or os.environ.get("WB_OPENCODE_CONFIG")
                 else "; it doesn't parse as a JSON object, so wb ignores it"))
    # the Python wb runs on, and when the launcher handed over from an older python3 (#259)
    handed = "wb-python" in sys._xoptions
    print(f"ok  python {sys.version.split()[0]} ({sys.executable})"
          + ("; python3 on PATH is older, so the launcher found this one" if handed else ""))
    good, said = version(["git"])
    have = gitops.version() if good else None
    old = bool(have) and have < gitops.GIT_FLOOR  # #527: init -b and the rest, unchecked
    line(good and not old, said + (f": workbench needs git {'.'.join(map(str, gitops.GIT_FLOOR))} "
                                   "or newer; upgrade it" if old else ""))
    # Claude's Bash runs `wb` by name whatever WB_BIN says: WB_BIN only moves the mod's own calls
    # (the 2026-11-16 audit: doctor said ok beside "the mod can't run it")
    on_path, wb_bin = shutil.which("wb"), os.environ.get("WB_BIN")
    if on_path:
        line(True, f"wb on PATH: {on_path}" + (f" (the mod runs WB_BIN={wb_bin})" if wb_bin else ""))
    else:
        linked = (Path.home() / ".local/bin/wb").exists()  # wb setup's link, not on PATH (#274)
        line(False, "wb isn't on PATH: Claude runs it by name in Bash, and the mod too; " +
             (path_advice() if linked else "link bin/wb into a PATH directory (wb setup)")
             + (f"; WB_BIN={wb_bin} covers only the mod's calls" if wb_bin else ""))
    elsewhere("wb", wb_bin or on_path, PKG_ROOT / "bin/wb")
    # a warning, not BAD: a desktop that never logs out is fine (#351). The chat's line only
    # with the chat on: nearly every desktop lingers off, and most never turn the chat on
    for why in logout_stops():
        if chat.is_on() or "wb-chat" not in why or "runners" in why:
            print(f"--  {why}")
    if gap := chat_gap():
        print(f"--  {gap}")
    # #516: a warning, not BAD: a server or a desktop that never sleeps is fine. Its own name: once
    # it reassigned `ok`, forgetting every BAD above it and failing a healthy WSL2 install (#653)
    awake, said = awake_line()
    if awake:
        line(True, said)
    else:
        print(f"--  {said}")
    if webpush.subscriptions() and not webpush.has_cas():  # every push failed, unsaid (#539)
        line(False, "web chat notifications: this Python has no CA certificates, so no push reaches "
             "its service: on macOS run Install Certificates.command (in your Python's Applications "
             "folder); elsewhere install ca-certificates, or set SSL_CERT_FILE")
    found = models.discover()
    line(bool(found), f"{len(found)} local model(s)")
    for pid, why in models.skipped_providers():  # once dropped without a word (the 2026-11-16 audit)
        print(f"--  provider {pid}: {why}")
    provs = models.providers()
    if not provs and models.ollama_answers(root := models.ollama_root_here()):
        print(f"--  Ollama answers at {root} but OpenCode has no provider for it "
              "(wb model add ollama/<model> adds one)")
    # each Ollama is asked once whether it answers: a sleeping LAN box cost 35 s a model, and
    # doctor ran past Claude's 2-minute Bash limit (the 2026-11-16 audit)
    down = set() if models._fake() else {
        p["root"] for p in provs.values() if p["engine"] == "ollama" and not models.ollama_answers(p["root"])}
    for pid, prov in provs.items():
        if prov["root"] in down:
            print(f"--  provider {pid}: Ollama isn't answering at {prov['root']}; its context checks are skipped")
    states = {mid: models.status(m, down) for mid, m in found.items()}
    for mid, st in states.items():
        print(f"{'ok ' if st['available'] else '-- '} model {mid}: {st['why']}")
    if found and not any(st["available"] for st in states.values()):  # doctor said all was well
        mid = next(iter(found))                                         # (the 2026-11-16 audit)
        fix = models.remedy(found[mid], states[mid])
        line(False, "no model can run now" + (f" ({mid}: {fix})" if fix else ""))
    for pid, prov in provs.items():
        if prov["problem"]:
            line(False, f"provider {pid}: {prov['problem']}")
        if prov.get("engine_note"):  # an Ollama emulator, or a server on Ollama's port (#580)
            print(f"--  provider {pid}: {prov['engine_note']}")
        ollama = prov["engine"] == "ollama"
        for name, e in prov["models"].items():
            said = (e.get("limit") or {}).get("context")
            asked = served_name(name, e)  # the server's name for it: an alias's id (#588)
            if not said and f"{pid}/{name}" in found:  # it passed, and the runner never handed
                # over (the 2026-11-16 audit)
                line(False, f"{pid}/{name} has no limit.context, so its tasks never hand over and "
                     "nothing compacts before the server cuts them off: wb model add "
                     f"{pid}/{name}" + ("" if ollama else " --context N (the window it serves)"))
            if said and (gap := runner.handover_warning(e)):  # any server (#595)
                print(f"--  {pid}/{name}: {gap}")
            if not ollama:
                # only a server running this model is asked: a down one cost seconds a model
                served = models.server_facts(prov["root"], asked, prov["key"])["context"] \
                    if (states.get(f"{pid}/{name}") or {}).get("resident") else None
                if said and served and said > served:
                    line(False, f"{pid}/{name} says a {said // 1024}K context but the server serves "
                         f"{served // 1024}K: it would cut prompts off (start it with a bigger "
                         f"window, or wb model add {pid}/{name} --context {served})")
                elif said and served and served > said:
                    print(f"--  {pid}/{name}: the server serves {served // 1024}K, the entry says "
                          f"{said // 1024}K; wb model add {pid}/{name} --context {served} lets its tasks grow")
                if (sized := found.get(f"{pid}/{name}")) and states[sized.id]["available"] \
                        and not models.weights(sized):
                    # vLLM, SGLang, llama-swap say no size: routing went by config order (#704)
                    print(f"--  {pid}/{name}: its size is unknown (the server says none), so routing "
                          "ranks it by the size in its name, else the config's order: models.json "
                          "weights_gb sets it")
                continue
            capped = "max_tokens" in (e.get("options") or {})
            line(capped, f"{pid}/{name} caps its output on Ollama (options.max_tokens; Ollama ignores "
                 "the max_completion_tokens OpenCode sends)" + ("" if capped else f": wb model add {pid}/{name}"))
            if stall := router.thinking_stall(f"{pid}/{name}", e):
                print(f"--  {stall}")
            measured = (optimize.state().get("models") or {}).get(f"{pid}/{name}")
            if measured and (fit := optimize.advice(f"{pid}/{name}", measured)):
                print(f"--  {fit}")
            if prov["root"] in down:
                continue
            served = models.ollama_served_context(prov["root"], asked)
            if said and not served:  # a stock Ollama serves 4K-8K (the 2026-11-16 audit)
                print(f"--  {pid}/{name}: Ollama's served context is unknown (not loaded, no num_ctx, "
                      f"no OLLAMA_CONTEXT_LENGTH); its default may be below the entry's "
                      f"{said // 1024}K and cut prompts off: set OLLAMA_CONTEXT_LENGTH")
            if said and served and said > served:
                line(False, f"{pid}/{name} says a {said // 1024}K context but Ollama serves "
                     f"{served // 1024}K: it would cut prompts off silently (raise OLLAMA_CONTEXT_LENGTH"
                     + (f", or wb model add {pid}/{name} --context {served})" if served >= models.MIN_WINDOW
                        else f": tasks need {models.MIN_WINDOW // 1024}K+)"))
            elif said and said < models.MIN_WINDOW:
                line(False, f"{pid}/{name}: {models.small_window_why(said)}")
            elif said and served and served > said:
                print(f"--  {pid}/{name}: Ollama serves {served // 1024}K, the entry says {said // 1024}K; "
                      f"wb model add {pid}/{name} --context {served} lets its tasks grow")
    try:  # every wb command makes it: a fresh home has no ~/.local/state yet (the 2026-11-16 audit)
        store.home().mkdir(parents=True, exist_ok=True)
        why = "" if os.access(store.home(), os.W_OK | os.X_OK) else "not writable"
    except OSError as e:
        why = f"can't make it: {e.strerror or e}"
    line(not why, f"state dir {store.home()}" + (f": {why}" if why else ""))
    if not why and store.noexec():  # os.access passes a noexec directory: search is allowed (#851)
        line(False, noexec_line())
    if not why and (fs := store.network_fs(os.path.realpath(store.home()))):  # #849
        print(f"--  the state dir is on {fs}: every machine sharing it lists its tasks; each one "
              "runs, reaps and stops only its own, and takes the GPU under its own lease")
    if not why:  # what it holds and what is left: nothing watched the disk (#342)
        held, whole = store.dir_size(store.home(), budget=3)
        free = store.free_bytes()
        if free is not None:
            line(free >= DISK_SPARE, f"the state dir holds {'' if whole else 'at least '}"
                 f"{store.gb(held)}, with {store.gb(free)} free"
                 + ("" if free >= DISK_SPARE else ": a task's writes fail on a full disk; wb "
                    "discard an open task, or free some")
                 + (f"; history: {kept}" if (kept := history_held()) else ""))
        if hardware.system() == "wsl" and not context.on_windows(str(store.home()), context.windows_drives()):
            drive = store.host_drive(store.home())  # the virtual disk's free space alone hid a full C: (#897)
            print(f"--  free space is at most {drive}'s, the Windows drive WSL's virtual disk is on "
                  "unless it was moved (a moved one's drive isn't seen)" if drive else
                  "--  no Windows drive is mounted: the free space is the virtual disk's, and a "
                  "full Windows drive behind it isn't seen")
        if gitops._modes_hold(str(store.home())) is False:  # exFAT, NTFS, CIFS, drvfs (#683)
            print("--  the state dir's file system keeps no file modes: a task's git ignores them, "
                  "so a script the agent makes executable lands as the repo had it")
    if idle := idle_line():
        print("--  " + idle)
    print("--  " + gpu_line())  # informs only: a CPU-only machine isn't broken
    if said := ollama_line():
        print("--  " + said)
    if unheld := models.unheld_loaded(skip=down):  # a shared Ollama: another user's, a tool's (#378)
        print(f"--  ollama has {', '.join(unheld)} loaded, which no task here holds: a task that "
              "needs the room unloads it (after it goes idle). If others use this Ollama, "
              f"{models.overrides_path().name}'s keep_loaded lists models wb never unloads, and "
              "gpu_gb (when the GPU budget is unknown) lets a model that fits beside them leave them loaded")
        if not models.lease_shared():
            print("--  if another account on this machine runs wb on this Ollama, one GPU lease for "
                  f"all of them: sudo install -d -m 2775 -g <their group> {models.SHARED_GPU} (#393)")
    if models.lease_shared():
        print(f"--  the GPU lease is shared at {models.lease_dir()}: every account using it takes turns")
        if closed := models.unshared_lease_files():  # made under a umask 077 before #802
            line(False, f"the GPU lease's {', '.join(p.name for p in closed)} can't be read by the "
                 "other accounts, whose tasks then fail to take the GPU: "
                 f"chmod g+r {' '.join(shlex.quote(str(p)) for p in closed)} (as their owner, or sudo)")
    elif os.path.isdir(models.SHARED_GPU) and not os.environ.get("WB_GPU_DIR"):  # #850
        line(False, f"{models.SHARED_GPU} is the machine's shared GPU lease, and this account can't "
             "write it: add it to the directory's group, then log in again")
    v = lane.abi()
    if v:  # draw a real lane and try a write outside it: the check is the refusal itself
        import tempfile
        with tempfile.TemporaryDirectory() as inside, tempfile.TemporaryDirectory(dir=Path.home()) as out:
            probe = [sys.executable, "-c", f"open({str(Path(out) / 'x')!r}, 'w')"]
            r = subprocess.run(lane.wrap([inside], probe), capture_output=True, text=True, timeout=30)
            # refused by the lane, not by the kernel refusing the lane (exit 126, "workbench
            # lane: …") and not some other failure; a home named "delaney" holds "lane" in the
            # PermissionError's path (the 2026-11-16 audit)
            held = (r.returncode not in (0, 126) and "PermissionError" in r.stderr
                    and not (Path(out) / "x").exists())
        line(held, f"agents write only in their lane (Landlock ABI {v})" if held else
             f"the lane didn't hold a write outside it: {r.stderr.strip()[-200:] or 'the write went through'}")
        for gap in lane.gaps(v):  # what this kernel's Landlock can't confine (the 2026-11-16 audit)
            print(f"--  Landlock ABI {v}: {gap}")
        if gap := context.interop_gap():  # WSL: a Windows program escapes it (the 0.90 review)
            print(f"--  {gap}")
        if gap := context.home_gap():
            print(f"--  {gap}")
    else:
        print("--  agents' writes outside their lane and reads of credentials aren't refused here "
              "(no Landlock): only OpenCode's file tools keep to it; " +
              ("sudo still is (no-new-privileges)" if sys.platform.startswith("linux")
               else "nor is sudo"))
    try:
        context.commands_conf()
        line(True, f"commands.json {context.commands_path()}"
             + ("" if context.commands_path().exists() else " (none: no standing allowances)"))
    except RuntimeError as e:
        line(False, str(e))
        sys.exit(1)  # every task reads it: nothing runs until it is fixed
    snapped = context.snaps(context.TOOLCHAINS) if context.lane_on() else []
    if snapped and sys.platform.startswith("linux"):
        print(f"--  {', '.join(snapped)}: snaps, which can't run in the agent's lane "
              "(no-new-privileges stops snap-confine): install them another way, or turn the lane "
              'off with commands.json "paths": ["*"]')
    skill = context.claude_home() / "skills/workbench/SKILL.md"
    line(skill.exists(), f"/workbench skill at {skill.parent}" if skill.exists() else
         f"/workbench isn't in {skill.parent.parent}: wb setup links it")
    elsewhere("/workbench", skill.parent, PKG_ROOT / "skill/workbench")
    try:  # information only: a mod loaded another way (--plugin-dir, a dev mod) isn't listed here
        listed = any(k.startswith("workbench@") for k in json.loads(
            (context.claude_home() / "plugins/installed_plugins.json").read_text()).get("plugins", {}))
    except (OSError, ValueError, AttributeError):
        listed = False
    print("ok  the Claude Code mod is installed (workbench@workbench)" if listed else
          "--  the Claude Code mod (the pane, the wake-ups) isn't among Claude Code's installed "
          "plugins: claude plugin install workbench@workbench, unless it loads another way")
    for row in experiment_lines():
        print(f"--  experiment {row}")
    sys.exit(0 if ok else 1)


def main(argv=None):
    store.absolute_env()  # before anything reads a path from the environment or a child inherits it
    gitops.drop_repo_env()  # a git hook's GIT_INDEX_FILE, a vcsh shell's GIT_DIR: never ours (#798)
    a = parser().parse_args(argv)
    try:
        store.note_claude_session()  # which sessions a /clear gave this process (spend.usage)
        store.note_task_session(getattr(a, "name", None) or getattr(a, "task", None))  # (#719)
    except OSError:
        pass  # a measurement's record never stops a command
    try:
        a.f(a)
    except RuntimeError as e:  # wb's own failures (git, a config that doesn't parse): a message
        die(str(e))
    except UnicodeError as e:  # text no encoding takes: a line, not a traceback (#873)
        die(str(e))
    except OSError as e:  # a --spec, --message or --file that isn't there: a line, not a traceback
        if store.disk_full(e):  # (#342)
            kept = history_held(budget=1)
            die(f"the disk is full ({e.filename or store.home()}: {e.strerror}): free some, or wb "
                "discard an open task (wb status lists them)" + (f"; history: {kept}" if kept else ""))
        die(f"{e.filename}: {e.strerror}" if e.filename else str(e))  # (the 2026-11-16 audit)


def _candidates(v: str) -> int:
    """--n for wb image and wb audio: 0 or below exited 0 having made nothing, a GPU engine's
    lease taken all the same (#592)."""
    try:
        n = int(v)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{v!r} is not a whole number") from None
    if n < 1:
        raise argparse.ArgumentTypeError(f"{n}: at least 1")
    return n


def parser() -> argparse.ArgumentParser:
    """wb's commands and flags (main; the bench driver starts its replays through it)."""
    ap = argparse.ArgumentParser(prog="wb", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", action="version", version=f"wb {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("start", help="hand a task to a local agent")
    s.add_argument("name")
    s.add_argument("--spec", required=True, help="spec file, or - for stdin")
    s.add_argument("--repo", default=".")
    s.add_argument("--size", choices=["trivial", "significant"], default="significant")
    s.add_argument("--model", help="an OpenCode model id or a fragment of one; default: the "
                   "router's choice for --size: its guess from model size, corrected by past results")
    s.add_argument("--test", help="acceptance command, run in the worktree after every round")
    s.add_argument("--checkin", type=float, metavar="MIN",
                   help="wake Claude every MIN minutes while it runs, with a digest of progress "
                   "(default off: each wake costs Claude its whole context)")
    s.add_argument("--self-review", action=argparse.BooleanOptionalAction, default=None,
                   help="once the tests pass, one more automatic round in which the agent "
                   "reviews its own change against Claude's checks, before Claude is woken "
                   "(default: learned per model, on until its record says otherwise)")
    s.add_argument("--auto-fix", type=int, default=2,
                   help="rounds that send failing tests back without waking Claude (default 2)")
    s.add_argument("--ask-budget", type=int, default=2)
    s.add_argument("--ask-timeout", type=int, default=1200)
    s.add_argument("--round-timeout", type=int, help="seconds a round may run (default 2400, "
                   "longer for a model measured slow on this machine)")
    s.add_argument("--silence-timeout", type=int, help="seconds with no output before the round "
                   "is stopped (default 900, longer for a model measured slow)")
    s.add_argument("--think-timeout", type=int, help="seconds of generating with no tool call or "
                   "word before the runner nudges the agent to act (default 420, or what the "
                   "model's measured speed gives; 0 turns it off)")
    s.add_argument("--test-timeout", type=int, default=900, metavar="SECS",
                   help="seconds the acceptance command may run (default 900)")
    s.add_argument("--unload-for-tests", action="store_true",
                   help="free this GPU of every model (keep_loaded aside) before each test run, "
                        "for tests that need the GPU")
    s.add_argument("--no-sign", action="store_true",
                   help="commit this task's work unsigned, whatever commit.gpgsign says")
    s.add_argument("--no-base-check", action="store_true",
                   help="don't run the acceptance command once on the base before the agent starts")
    s.add_argument("--base", default="HEAD")
    s.add_argument("--force", action="store_true", help="queue the --model asked for even if it "
                   "can't run now")
    s.add_argument("--queue", action="store_true", help="start even when the GPU's holders leave "
                   "no room for its model: it waits behind them (else exit 4)")
    s.add_argument("--trial", action="store_true", help="a check of workbench itself (a scratch "
                   "repo): its result and lessons don't count as evidence")
    s.add_argument("--backlog", metavar="NAME", help="one of a batch left to run (overnight): "
                   "wb backlog NAME reports on the batch")
    s.add_argument("--no-claude-md", action="store_true",
                   help="start even though the repo has no CLAUDE.md (or .claude/CLAUDE.md)")
    s.add_argument("--allow", action="append", metavar="PATTERN",
                   help="let the agent run a command outside the everyday list, e.g. \"curl *\"")
    s.add_argument("--allow-path", action="append", metavar="DIR",
                   help="let the agent read and write this directory outside its lane")
    s.add_argument("--skill", action="append", metavar="NAME",
                   help="hand the agent this library skill (repeatable; wb skill list)")
    s.add_argument("--setup", metavar="CMD",
                   help="run this in the agent's lane to set the worktree up before the base check "
                   "(e.g. 'npm ci'); a failure stops the task before any round (default: "
                   "commands.json \"repos\")")
    s.add_argument("--setup-timeout", type=int, metavar="SECS",
                   help="seconds the setup may run, in the worktree and in each scratch checkout "
                   "(default 1800, or commands.json \"repos\" \"setup_timeout\")")
    s.add_argument("--copy", action="append", metavar="PATH",
                   help="copy this ignored path from your checkout into the worktree (repeatable; "
                   "never a secret)")
    s.add_argument("--sibling", action="append", metavar="PATH",
                   help="let the agent read a directory around the repo at the same relative "
                   "path: NAME or ../NAME beside it, ../../shared/lib further up (repeatable)")
    s.set_defaults(f=cmd_start)

    s = sub.add_parser("feedback", help="send review feedback for another round")
    s.add_argument("name")
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("--text"); g.add_argument("--message", help="a file, or - for stdin")
    g = s.add_mutually_exclusive_group()
    g.add_argument("--fresh", action="store_true",
                   help="start the agent on a fresh session, handed the task and the work so far")
    g.add_argument("--keep-context", action="store_true",
                   help="continue the session even if it is getting full")
    s.add_argument("--spec-gap", action="append", metavar="WHAT",
                   help="this round is the spec's fault: what it missed (repeatable)")
    s.set_defaults(f=cmd_feedback)
    s = sub.add_parser("next", help="commit the approved step and send the same agent the next one")
    s.add_argument("name"); s.add_argument("--spec", required=True, help="the next step's spec file, or - for stdin")
    s.add_argument("--message", "-m", required=True, help="commit subject for the approved step")
    s.add_argument("--test", help="the next step's acceptance command (default: unchanged)")
    s.add_argument("--include", action="store_true", help="commit it even with more than "
                   f"{gitops.NEW_FILES_MAX} new files or a large new binary (build output?)")
    s.add_argument("--no-sign", action="store_true",
                   help="commit it unsigned, whatever commit.gpgsign says (a key that needs unlocking)")
    s.add_argument("--fresh", action="store_true", help="a fresh session instead of the same one")
    s.add_argument("--take-claude-md", action="store_true",
                   help="put the agent's proposed CLAUDE.md/AGENTS.md (<name>.proposed) over the "
                   "file before committing; without it they are dropped")
    s.add_argument("--spec-gap", action="append", metavar="WHAT",
                   help="a round this step took was the spec's fault: what it missed (repeatable)")
    s.add_argument("--allow", action="append", metavar="PATTERN",
                   help="let the agent run a command outside the everyday list, e.g. \"curl *\"")
    s.add_argument("--skill", action="append", metavar="NAME",
                   help="the skills for the next step (repeatable; replaces the set; default: unchanged)")
    s.set_defaults(f=cmd_next)

    s = sub.add_parser("skill", help="Claude's skill library for the agents: list, show, add, "
                       "patch, scan, import, retire, restore; hand a task a skill or take it back")
    ss = s.add_subparsers(dest="action", required=True)
    ss.add_parser("list", help="every skill, how often it was offered, loaded and helped")
    x = ss.add_parser("show"); x.add_argument("name")
    x = ss.add_parser("add", help="add or update a skill: a SKILL.md, or a directory holding one")
    x.add_argument("name"); x.add_argument("--from", dest="source", required=True)
    x.add_argument("--message", "-m", required=True, help="why: what review taught")
    x.add_argument("--source", dest="origin", help="where an imported skill came from (url@commit, license)")
    x.add_argument("--lesson", action="append", metavar="ID", help="the lessons this takes in (wb lessons)")
    x.add_argument("--reviewed", action="append", metavar="RULE", help="a scan rule whose critical "
                   "findings you have read and judged safe: they pass, recorded in the commit (repeatable)")
    x = ss.add_parser("patch", help="fix one passage of a skill in place")
    x.add_argument("name")
    x.add_argument("--old", help="the passage to replace (it must occur exactly once)")
    x.add_argument("--new", help="what replaces it")
    x.add_argument("--old-file"); x.add_argument("--new-file")
    x.add_argument("--message", "-m", required=True, help="why: what review taught")
    x.add_argument("--lesson", action="append", metavar="ID", help="the lessons this takes in (wb lessons)")
    x = ss.add_parser("import", help="fetch a skill from outside for Claude to read: scanned, never added by itself")
    x.add_argument("src", help="a git URL, owner/repo (GitHub), or a local path")
    x.add_argument("--path", help="the skill's directory inside it")
    x.add_argument("--as", dest="name", help="the name it would take here")
    x = ss.add_parser("scan", help="the security scan, for a library skill or any path")
    x.add_argument("name")
    x = ss.add_parser("retire"); x.add_argument("name")
    x.add_argument("--message", "-m", required=True, help="why it is no longer needed")
    x = ss.add_parser("restore"); x.add_argument("name")
    for verb, what in (("hand", "give a task's agent skills"), ("take", "take skills back")):
        x = ss.add_parser(verb, help=what + ", from its next run")
        x.add_argument("task"); x.add_argument("names", nargs="+")
    s.set_defaults(f=cmd_skill)
    s = sub.add_parser("lessons", help="what tasks taught, waiting to become skills")
    s.add_argument("action", nargs="?", choices=["close"])
    s.add_argument("ids", nargs="*")
    s.add_argument("--task", help="only this task's")
    s.add_argument("--all", action="store_true")
    s.add_argument("--message", "-m", default="", help="why it isn't a skill")
    s.set_defaults(f=cmd_lessons)
    s = sub.add_parser("notes", help="what Claude learned about how the user wants delegation "
                       "run, carried into every project")
    s.add_argument("action", nargs="?", choices=["add", "drop"])
    s.add_argument("args", nargs="*", help="the note (add), or its numbers (drop)")
    s.set_defaults(f=cmd_notes)
    s = sub.add_parser("image", help="generate images with a local image model, for Claude to "
                       "look at and choose from")
    s.add_argument("prompt", nargs="?")
    s.add_argument("--n", type=_candidates, default=4, help="candidates (seeds SEED, SEED+1, ...)")
    s.add_argument("--size", default="1024x1024")
    s.add_argument("--seed", type=int)
    s.add_argument("--out", help="directory (default: a new one under $WB_HOME/images)")
    s.add_argument("--engine", help="an engine from images.json (default: the first)")
    s.add_argument("--ref", action="append", help="a reference image (repeatable), for engines "
                   "that take them")
    s.add_argument("--list", action="store_true", help="the configured engines")
    s.add_argument("--wait", action="store_true", help="wait for the tasks holding the GPU instead "
                   "of refusing (long: run it in the background)")
    s.set_defaults(f=cmd_image)
    s = sub.add_parser("audio", help="generate speech, sound effects or music with a local audio "
                       "model, each candidate checked for Claude, who can't hear it")
    s.add_argument("text", nargs="?", help="the script (speech) or the description (sfx, music)")
    s.add_argument("--kind", choices=audio.KINDS, help="the first engine of this kind (default: "
                   "the first engine)")
    s.add_argument("--n", type=_candidates, default=3, help="candidates (seeds SEED, SEED+1, ...)")
    s.add_argument("--seconds", type=float, help="the length, for engines that take one")
    s.add_argument("--voice", help="one of the engine's voices")
    s.add_argument("--ref", action="append", help="a reference clip (repeatable): a voice the "
                   "user has the right to, for engines that take them")
    s.add_argument("--lyrics", metavar="FILE", help="lyrics for a song (- reads stdin)")
    s.add_argument("--seed", type=int)
    s.add_argument("--engine", help="an engine from audio.json")
    s.add_argument("--out", help="directory (default: a new one under $WB_HOME/audio)")
    s.add_argument("--no-check", action="store_true", help="skip the listener and the spectrograms")
    s.add_argument("--list", action="store_true", help="the configured engines")
    s.add_argument("--wait", action="store_true", help="wait for the tasks holding the GPU instead "
                   "of refusing (long: run it in the background)")
    s.set_defaults(f=cmd_audio)
    s = sub.add_parser("answer", help="answer the agent's ask_reviewer question")
    s.add_argument("name"); s.add_argument("--id")
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("--text"); g.add_argument("--file")
    s.set_defaults(f=cmd_answer)
    s = sub.add_parser("wait", help="block until a task needs Claude; prints its report")
    s.add_argument("name", nargs="?"); s.add_argument("--timeout", type=int, default=0)
    s.add_argument("--repo", metavar="DIR", help="unnamed: only the tasks of a session started in DIR")
    s.add_argument("--session", action="append", metavar="ID",
                   help="unnamed: only the tasks of Claude Code session ID (repeatable)")
    s.add_argument("--all-sessions", action="store_true", help=ALL_SESSIONS)
    s.set_defaults(f=cmd_wait)
    s = sub.add_parser("watch", help="follow a task live: the conversation between Claude and "
                       "the agent, every tool call and test")
    s.add_argument("name", nargs="?", help="default: the most recently active task")
    s.add_argument("-v", "--verbose", action="store_true",
                   help="everything in full: reasoning, outputs, the protocol")
    s.add_argument("--once", action="store_true", help="print what happened so far and exit")
    s.add_argument("--no-color", action="store_true")
    s.add_argument("--json", action="store_true", help=argparse.SUPPRESS)  # the mod's pane
    s.add_argument("--last", type=int, default=0, help=argparse.SUPPRESS)  # with --json: the newest N lines
    s.set_defaults(f=cmd_watch)

    s = sub.add_parser("status", help="open tasks at a glance")
    s.add_argument("name", nargs="?"); s.add_argument("--all", action="store_true")
    s.add_argument("--repo", metavar="DIR", help="only the tasks of a session started in DIR")
    s.add_argument("--session", action="append", metavar="ID",
                   help="only the tasks of Claude Code session ID (repeatable; the mod passes its ids)")
    s.add_argument("--all-sessions", action="store_true", help=ALL_SESSIONS)
    s.set_defaults(f=cmd_status)
    s = sub.add_parser("log", help="the agent's events")
    s.add_argument("name"); s.add_argument("-n", type=int, default=0)
    s.add_argument("-f", "--follow", action="store_true")
    s.add_argument("-v", "--verbose", action="store_true")
    s.set_defaults(f=cmd_log)
    s = sub.add_parser("report", help="a round's compact report")
    s.add_argument("name"); s.add_argument("--round", type=int)
    s.set_defaults(f=cmd_report)
    s = sub.add_parser("diff", help="the agent's changes against the task's base")
    s.add_argument("name"); s.add_argument("--stat", action="store_true")
    s.add_argument("--all", action="store_true", help="every step, not just the current one")
    s.add_argument("paths", nargs="*")
    s.set_defaults(f=cmd_diff)
    s = sub.add_parser("allow", help="let a task's agent run a command outside the everyday list "
                       "(a shell pattern, e.g. \"curl *\"); answers its request")
    s.add_argument("name"); s.add_argument("pattern", nargs="*")
    s.add_argument("--path", action="append", metavar="DIR",
                   help="let it read and write this directory outside its lane (repeatable)")
    s.add_argument("--always", action="store_true", help="for every task from now on (commands.json)")
    s.add_argument("--text", help="a word for the agent with it")
    s.set_defaults(f=cmd_allow)
    s = sub.add_parser("steer", help="a note to a running agent: at the end of its current run, "
                       "or --now to interrupt it")
    s.add_argument("name")
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("--text"); g.add_argument("--message", help="a file")
    s.add_argument("--now", action="store_true",
                   help="interrupt the agent mid-step; the note goes first, marked high priority")
    s.add_argument("--step", action="store_true", help="a smaller step: the agent does only this, "
                   "then stops and reports")
    s.set_defaults(f=cmd_steer)
    s = sub.add_parser("progress", help="the user's opt-in to progress checks: a task past its "
                       "typical length of active work gets a check and a recommendation")
    s.add_argument("state", nargs="?", choices=["on", "off"])
    s.add_argument("--after", type=float, metavar="MIN", help="check after this many minutes of "
                   "active work (default: the task's typical length on its model); kept until "
                   "given again, 0 clears it")
    s.set_defaults(f=cmd_progress)
    s = sub.add_parser("note", help="Claude's captain's-log line in the task's transcript")
    s.add_argument("name"); s.add_argument("--text", required=True); s.set_defaults(f=cmd_note)
    s = sub.add_parser("verify", help="run a regression test on the base and on the candidate, "
                       "each in a scratch checkout under the task's lane: does it show the bug?")
    s.add_argument("name")
    s.add_argument("--test", metavar="CMD", help="the regression test's command (default: the "
                   "task's --test)")
    s.add_argument("--files", nargs="+", metavar="PATH", help="the test's files, copied from the "
                   "candidate onto the base (default: the changed files that look like tests)")
    s.add_argument("--expect", metavar="TEXT", help="the failure the base must print to be "
                   "proven (an assertion's message); without it, any assertion line")
    s.add_argument("--timeout", type=int, default=verify.LIMIT, help="seconds for each run (300)")
    s.add_argument("--setup", action="store_true", help="run the task's setup in each scratch "
                   "checkout (default: copy what it made in the task's worktree)")
    s.set_defaults(f=cmd_verify)
    s = sub.add_parser("shot", help="capture the same interaction on the base and the candidate "
                       "(the project's own capture command), for a visual task's review")
    s.add_argument("name")
    s.add_argument("--capture", metavar="CMD", required=True, help="writes a PNG to $WB_SHOT_OUT, "
                   "at the size in $WB_SHOT_VIEWPORT")
    s.add_argument("--viewport", default="1280x800", help="WIDTHxHEIGHT (1280x800)")
    s.add_argument("--files", nargs="+", metavar="PATH", help="the candidate's files the capture "
                   "needs on the base too (a new fixture or script)")
    s.add_argument("--timeout", type=int, default=verify.LIMIT, help="seconds for each capture (300)")
    s.add_argument("--setup", action="store_true", help="run the task's setup in each scratch "
                   "checkout (default: copy what it made in the task's worktree)")
    s.add_argument("--chat", action="store_true", help="post the pair to the web chat, where a "
                   "reply is tied to this task and step")
    s.set_defaults(f=cmd_shot)
    s = sub.add_parser("takeover", help="stop the agent and finish the task by hand")
    s.add_argument("name", nargs="?")
    s.add_argument("--all", action="store_true", help="every open delegated task")
    s.add_argument("--repo", metavar="DIR", help="with --all: only those of a session started in DIR")
    s.add_argument("--session", action="append", metavar="ID",
                   help="with --all: only those of Claude Code session ID (repeatable)")
    s.add_argument("--all-sessions", action="store_true", help=ALL_SESSIONS)
    s.add_argument("--user", action="store_true", help="the user's own command asked for it (the "
                   "mod's hand-back): past the Claude coding choice")
    s.set_defaults(f=cmd_takeover)
    s = sub.add_parser("coding", help="when Claude may write code for a delegated task: show, "
                       "set (only, ask, decide), or allow one task's edit on the user's yes")
    s.add_argument("what", nargs="?", choices=[*CODING, "allow", "used"])
    s.add_argument("task", nargs="?", help="allow, used: the task")
    s.add_argument("--edit", help="allow: the exact edit the user agreed to")
    s.add_argument("--said", help="allow: the user's words")
    s.add_argument("--when", help="allow: a one-task exception granted ahead, for when this holds "
                   "(e.g. the next try still gets the units wrong)")
    s.add_argument("--did", help="used: what Claude changed under the allowance")
    s.set_defaults(f=cmd_coding)
    s = sub.add_parser("experiment", help="the experiments (changes measured before they are "
                       "supported): list them, or turn one on or off for the tasks started from now")
    s.add_argument("name", nargs="?")
    s.add_argument("state", nargs="?", choices=["on", "off"])
    s.set_defaults(f=cmd_experiment)
    s = sub.add_parser("stop", help="stop a running task (wb resume or wb feedback continues it)")
    s.add_argument("name", nargs="?")
    s.add_argument("--all", action="store_true", help="every running agent")
    s.add_argument("--repo", metavar="DIR", help="with --all: only those of a session started in DIR")
    s.add_argument("--session", action="append", metavar="ID",
                   help="with --all: only those of Claude Code session ID (repeatable)")
    s.add_argument("--all-sessions", action="store_true", help=ALL_SESSIONS)
    s.add_argument("--park-waiting", action="store_true", help="with --all: also park the tasks "
                   "waiting on Claude (review, stuck, failed) as they stand (/workbench-quit)")
    s.set_defaults(f=cmd_stop)
    s = sub.add_parser("resume", help="continue a stopped task in a fresh session (not a review round)")
    s.add_argument("name", nargs="?")
    s.add_argument("more", nargs="*", metavar="name", help="more tasks, resumed in the order they "
                   "were started (a restart's or a signal's batch)")
    s.add_argument("--all", action="store_true", help="every task a restart, a kill or a signal "
                   "interrupted, in the order they were started")
    s.add_argument("--repo", metavar="DIR", help="with --all: only those of a session started in DIR")
    s.add_argument("--session", action="append", metavar="ID",
                   help="with --all: only those of Claude Code session ID (repeatable)")
    s.add_argument("--all-sessions", action="store_true", help=ALL_SESSIONS)
    s.add_argument("--backlog", metavar="NAME", help="with --all: only that backlog's")
    s.set_defaults(f=cmd_resume)
    s = sub.add_parser("accept", help="commit the work on its branch and close the task")
    s.add_argument("name"); s.add_argument("--message", "-m", required=True)
    s.add_argument("--merge", action="store_true"); s.add_argument("--force", action="store_true")
    s.add_argument("--merge-as", choices=context.MERGE_AS, help="how --merge lands (implies "
                   "it): a merge commit (the default, or commands.json repos' merge), fast-forward "
                   "only, or one squashed commit, for a repo kept to linear history")
    s.add_argument("--include", action="store_true", help="commit it even with more than "
                   f"{gitops.NEW_FILES_MAX} new files or a large new binary (build output?)")
    s.add_argument("--no-sign", action="store_true",
                   help="commit it unsigned, whatever commit.gpgsign says (a key that needs unlocking)")
    s.add_argument("--take-claude-md", action="store_true",
                   help="put the agent's proposed CLAUDE.md/AGENTS.md (<name>.proposed) over the "
                   "file before committing; without it they are dropped")
    s.add_argument("--spec-gap", action="append", metavar="WHAT",
                   help="a round this task took was the spec's fault: what it missed (repeatable)")
    s.set_defaults(f=cmd_accept)
    s = sub.add_parser("discard", help="drop the work and close the task")
    s.add_argument("name"); s.add_argument("--reason")
    s.add_argument("--spec-gap", action="append", metavar="WHAT",
                   help="the spec's part in it: what it missed (repeatable)")
    s.add_argument("--keep-branch", action="store_true")
    s.add_argument("--drop-steps", action="store_true",
                   help="delete the branch even when it holds steps wb next committed")
    s.set_defaults(f=cmd_discard)
    s = sub.add_parser("relocate", help="where a task's repo is now: moved, renamed, or the "
                                        "checkout it started from removed")
    s.add_argument("name"); s.add_argument("--repo", required=True)
    s.set_defaults(f=cmd_relocate)
    s = sub.add_parser("models", help="the local models, and which the router picks per task size")
    s.add_argument("--set-default", action="store_true",
                   help="make the router's pick for significant tasks OpenCode's default model")
    s.set_defaults(f=cmd_models)
    s = sub.add_parser("model", help="add a model to OpenCode (--pull downloads it), retire one, "
                                     "limit the task sizes it is routed, or carry a renamed one's record")
    s.add_argument("action", choices=["add", "retire", "sizes", "rename"])
    s.add_argument("id", help="provider/model (rename: the id it had before)")
    s.add_argument("sizes", nargs="*", help="sizes: the only task sizes it gets (none: all); "
                   "rename: the id it has now")
    s.add_argument("--pull", action="store_true", help="add: download it into Ollama first")
    s.add_argument("--url", help="add: the baseURL of the OpenAI-compatible server it runs on "
                   "(e.g. http://127.0.0.1:8080/v1), when OpenCode has no provider for it yet")
    s.add_argument("--start", metavar="CMD", help="add: the shell command that starts its server "
                   "(models.json start), for a server that runs one model at a time")
    s.add_argument("--stop", metavar="CMD", help="add: the shell command that stops it (models.json stop)")
    s.add_argument("--label", help="add: the name OpenCode shows")
    s.add_argument("--context", type=int, help="add: context tokens (default: what Ollama serves "
                   "it, else what the provider's other models use; another server needs it)")
    s.add_argument("--delete", action="store_true", help="retire: also delete its weights")
    s.set_defaults(f=cmd_model)
    s = sub.add_parser("scout", help="the weekly model check: hardware, installed models, results")
    s.add_argument("--done", action="store_true", help="record that the check was done")
    s.add_argument("--notes", help="with --done: what was recommended or changed")
    s.add_argument("--due", action="store_true", help="exit 0 if a check is due, else 1")
    s.add_argument("--watch", metavar="TEXT", help="add what would reopen a decision (a model "
                                                   "set aside, and what it needs to return)")
    s.add_argument("--unwatch", type=int, metavar="N", help="drop watch-list item N, once settled")
    s.set_defaults(f=cmd_scout)
    s = sub.add_parser("events", help="print a line whenever workbench's state changes (the mod's ears)")
    s.set_defaults(f=cmd_events)
    s = sub.add_parser("adopt", help="the mod's: make a task whose Claude Code process is gone "
                       "this session's")
    s.add_argument("name")
    s.add_argument("--session", action="append", required=True, metavar="ID",
                   help="this process's session ids, the current one first")
    s.add_argument("--pid", type=int, help="the claiming Claude Code process (default: "
                   "$CLAUDE_PID, else wb's parent)")
    s.set_defaults(f=cmd_adopt)
    s = sub.add_parser("ack", help="the mod's: take a task's notice before waking Claude "
                       "(exit 3 when taken already)")
    s.add_argument("name"); s.add_argument("ts", type=float)
    s.add_argument("--if", dest="if_ts", type=float, metavar="TS",
                   help="move the mark back to ts, only while it is still TS (a dropped wake's rollback)")
    s.set_defaults(f=cmd_ack)
    s = sub.add_parser("top", help="a live view of the GPUs, the running tasks, the models and the "
                       "GPU's queue (q quits)")
    s.add_argument("--json", action="store_true", help="one JSON object per tick, until the parent exits")
    s.add_argument("--every", type=float, metavar="S",
                   help="seconds between ticks, 0.2 to 3600 (default: stats.json every, else 2)")
    s.set_defaults(f=cmd_top)
    s = sub.add_parser("chat", help="the web chat: turn it on or off (on starts a server; kept as "
                       "left), serve it, its link, reply to the user there, takes for the user "
                       "to pick by ear (listen), "
                       "the thread (log), receipts (ack, claim), what waits (pending), permission "
                       "prompts for the away user (ask, wait, answer: the mod's)")
    s.add_argument("action", choices=["serve", "url", "on", "off", "reply", "listen", "log", "ack",
                                      "claim", "pending", "ask", "wait", "answer"], nargs="?",
                   default="log")
    s.add_argument("id", nargs="?", help="ack, claim: the message id; wait, answer: the prompt's "
                   "id; listen: the clips (wb audio's takes, up to 8)")
    s.add_argument("verdict", nargs="?", help="answer: allow, deny or expired")
    s.add_argument("more", nargs="*", help=argparse.SUPPRESS)  # listen's further clips
    s.add_argument("--tool", help="ask: the tool asking")
    s.add_argument("--kind", default="permission", help="ask: permission, plan or question")
    s.add_argument("--detail", help="ask: JSON, a question's {questions} or a plan's {plan} "
                   "or {plan_file}")
    s.add_argument("--session", help="ask: the Claude Code session asking (its plan file)")
    s.add_argument("--repo", help="ask: the session's directory (named when its plan is unknown)")
    s.add_argument("--pid", type=int, help="ask: the asking session's `wb events` process: once it "
                   "is gone, the ask expires")
    s.add_argument("--note", help="answer: words to pass on with it")
    s.add_argument("--timeout", type=float, default=30, help="wait: seconds")
    s.add_argument("--json", action="store_true", help="wait: the whole ask, answered or not")
    s.add_argument("--port", type=int, help=f"default: the running server's (chat/port.json), "
                   f"else {chat.PORT}")
    s.add_argument("--bind", action="append", help="serve: an address to listen on, `tailscale` "
                   "or 0.0.0.0 (default: chat.json's `bind`, else localhost)")
    s.add_argument("--host", action="append", help="serve: another host name to answer to (* any)")
    s.add_argument("--text", help="reply, ask, listen: the text"); s.add_argument("--message", help="reply: file, or -")
    s.add_argument("--by", help=argparse.SUPPRESS); s.add_argument("-n", type=int, default=10)
    s.add_argument("--how", choices=["now", "queued"], default="now", help=argparse.SUPPRESS)
    s.set_defaults(f=cmd_chat)
    s = sub.add_parser("optimize", help="measure this machine for its models when the user asks: "
                       "the largest window each Ollama model keeps all on the GPU (detached; real "
                       "work stops it), then apply one")
    s.add_argument("action", choices=["start", "estimate", "report", "stop", "apply"], nargs="?",
                   default="report")
    s.add_argument("ids", nargs="*", help="apply: the models whose measured window to add")
    s.add_argument("--bench", action="store_true",
                   help="start: then replay the bench's cases on every model (wb bench run)")
    s.add_argument("--if-due", action="store_true",
                   help="start: only when due (never measured, the GPU changed, a new model), "
                   "and quietly when not or when a task holds the GPU (wb setup and the mod)")
    s.set_defaults(f=cmd_optimize)
    s = sub.add_parser("try", help="a sample task that proves the setup: a tiny project, its spec "
                       "started as a trivial trial, and the hidden check to run at review")
    s.add_argument("--model", help="a model id or fragment (default: the router's pick)")
    s.set_defaults(f=cmd_try)
    s = sub.add_parser("remote", help="use the Ollama on another machine (LAN, tailnet): its "
                       "provider, marked local, and its tool-capable models registered")
    s.add_argument("host", help="its host name or address")
    s.add_argument("--port", type=int, default=models.OLLAMA_PORT, help="Ollama's port (11434)")
    s.add_argument("--context", type=int, help="context tokens for each model, when its Ollama "
                   "doesn't say (its OLLAMA_CONTEXT_LENGTH)")
    s.add_argument("--remove", action="store_true", help="retire its models and drop the provider")
    s.set_defaults(f=cmd_remote)
    s = sub.add_parser("init", help="set a project up: git with an initial commit, "
                                    "AGENTS.md → CLAUDE.md")
    s.add_argument("dir"); s.set_defaults(f=cmd_init)
    s = sub.add_parser("bench", help="replay accepted tasks on any model, graded by the tests they "
                                     "were accepted with")
    bs = s.add_subparsers(dest="bench_cmd", required=True)
    x = bs.add_parser("add", help="make a case of one step of an accepted task")
    x.add_argument("task")
    x.add_argument("--step", type=int, help="which step of a wb next task (default: the last)")
    x.add_argument("--hidden", nargs="+", metavar="PATH",
                   help="the files graded with (default: the test files the step changed)")
    x.add_argument("--check", help="a command run after the acceptance command, to pass too")
    x.add_argument("--name", help="the case's name (default: the task's)")
    bs.add_parser("list", help="the cases")
    x = bs.add_parser("rm", help="remove cases, with their bundles (their results stay)")
    x.add_argument("case", nargs="+")
    x = bs.add_parser("run", help="replay the cases in the background, one at a time")
    x.add_argument("--model", nargs="+", help="default: every model that can run and takes the case's size")
    x.add_argument("--case", nargs="+", help="default: every case")
    x.add_argument("--skill", nargs="+", help="hand these library skills to every replay")
    x.add_argument("--label", help="a name for this variant (a workbench branch, a skill), to compare by")
    x.add_argument("--repeat", type=int, default=1, help="replay each N times")
    x = bs.add_parser("self", help="the case written by Claude (claude -p), graded alike: what "
                      "writing it cost Claude, against the handoff")
    x.add_argument("case")
    x.add_argument("--yes", action="store_true", help="spend Claude tokens on it (required)")
    x.add_argument("--turns", type=int, default=bench.SELF_TURNS, help="claude -p's turn cap (40)")
    bs.add_parser("stop", help="stop the run, closing its replay")
    x = bs.add_parser("report", help="pass rates by model and label, and each case")
    x.add_argument("--run")
    x.add_argument("--label")
    s.set_defaults(f=cmd_bench)
    s = sub.add_parser("stats", help="results by model; `set` changes the Stats tab's settings")
    s.add_argument("action", nargs="?", choices=["set"])
    s.add_argument("key", nargs="?", metavar="KEY", help="recording, live or every")
    s.add_argument("value", nargs="?", metavar="VALUE", help="on|off, or 1|2|5 (seconds) for every")
    s.add_argument("--json", action="store_true", help="everything learned, as one object (the Stats tab's feed)")
    s.add_argument("--all", action="store_true",
                   help="every model that ran a task, retired and idle ones too")
    s.set_defaults(f=cmd_stats)
    s = sub.add_parser("backlog", help="a batch started with --backlog: each task and the batch's saving")
    s.add_argument("name", nargs="?")
    s.add_argument("--json", action="store_true")
    s.set_defaults(f=cmd_backlog)
    s = sub.add_parser("savings", help="what delegating saved Claude: the week, by default")
    g = s.add_mutually_exclusive_group()
    g.add_argument("--week", action="store_true", help="the last 7 days (the default)")
    g.add_argument("--month", action="store_true", help="the last 30 days")
    g.add_argument("--all", action="store_true", help="every task recorded")
    s.add_argument("--json", action="store_true")
    s.add_argument("--share", action="store_true", help="a plain summary to paste into a "
                   "discussion: the machine, model sizes (no names), tasks, ratios, energy")
    s.add_argument("--card", metavar="FILE.svg", help="write the savings badge as an image to keep "
                   "or post: the score out of 100, the period, the counts (made here; nothing sent)")
    s.add_argument("--price", metavar="X|off", help="set the electricity price per kWh (off "
                   "clears it), then report")
    s.set_defaults(f=cmd_savings)
    sub.add_parser("tune", help="the settings tuned from results, per model and window").set_defaults(f=cmd_tune)
    s = sub.add_parser("gc", help="archive old closed tasks, rotate old notices, remove leftover "
                                  "rules, runtime dirs and merged branches")
    s.add_argument("--days", type=float, default=store.ARCHIVE_DAYS,
                   help=f"how long a closed task or a handled notice stays (default {store.ARCHIVE_DAYS})")
    s.set_defaults(f=cmd_gc)
    s = sub.add_parser("trial", help="mark closed tasks as trial runs: their results stop counting")
    s.add_argument("names", nargs="+")
    s.set_defaults(f=cmd_trial)
    s = sub.add_parser("setup", help="link wb onto PATH and /workbench into Claude Code's skills, "
                                     "from this copy")
    s.add_argument("--force", action="store_true", help="replace links that point elsewhere")
    s.set_defaults(f=cmd_setup)
    s = sub.add_parser("update", help="update workbench (wb, the skill and the mod) from its origin")
    s.add_argument("--check", action="store_true", help="only say whether there is an update")
    s.add_argument("--if-due", action="store_true", help="with --check: ask origin at most weekly")
    s.add_argument("--stop", action="store_true", help="stop the running tasks first; each one's "
                   "session is told to wb resume it")
    s.set_defaults(f=cmd_update)
    sub.add_parser("doctor", help="check the setup").set_defaults(f=cmd_doctor)
    return ap


if __name__ == "__main__":
    main()
