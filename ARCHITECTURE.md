# How Claude's Workbench works

The full account, for agents and contributors: every piece, what it does, how and why.
[README.md](README.md) is for people (the pitch and a quickstart); [CLAUDE.md](CLAUDE.md) is the
compact reference loaded into every session that changes the code, and points here for detail.
A change that alters what this file says (a command, a flag, a default, a guard, a file, a format)
updates it in the same commit.

"The user" is the person running Claude Code; "Claude" is the Claude Code session driving the
work; "the agent" is the local model running in OpenCode on one task.

Contents: [The pieces](#the-pieces) · [Why it's built this way](#why-its-built-this-way) ·
[A task, start to finish](#a-task-start-to-finish) · [The runner, inside](#the-runner-inside) ·
[What the agent knows](#what-the-agent-knows) · [Talking to a running agent](#talking-to-a-running-agent) ·
[Context, on both sides](#context-on-both-sides) · [Waking Claude, exactly once](#waking-claude-exactly-once) ·
[Seeing what the agent does](#seeing-what-the-agent-does) · [Models](#models-found-loaded-chosen) ·
[Bench](#bench-real-tasks-replayed) · [The skill library](#the-skill-library) · [Images](#images) · [Audio](#audio) · [Git, commits and projects](#git-commits-and-projects) ·
[The web chat](#the-web-chat) · [Stopping everything](#stopping-everything) · [The mod, inside](#the-mod-inside) ·
[Waiting without polling](#waiting-without-polling) · [Every `wb` command](#every-wb-command) ·
[Files and formats](#files-and-formats) · [The tests](#the-tests) · [Couplings](#couplings-change-one-change-the-other)

## The pieces

```
 user ─▶ Claude Code ────────────────────────────────────────────────────────────┐
          │ /workbench skill: plan, spec, review          workbench mod: pane,     │
          │ (skill/workbench/SKILL.md)                    status line, wake-ups,   │
          ▼                                              web chat, compaction     │
         wb ──────── writes ────▶  $WB_HOME (~/.local/state/workbench) ◀── wb events (inotify)
          │ spawns                   tasks/<name>/…  rules/<name>/  notify.jsonl  results.jsonl  chat/
          ▼                                 ▲
       runner (detached, one per task) ─────┤ writes status, events, reports, notices
          │ GPU lease, loads the model      │
          ▼                                 │
       lane.py (Landlock) ─▶ opencode run  in tasks/<name>/worktree (branch delegate/<name>)
          │      └─ ask_reviewer (MCP server, wb-ask-mcp) ─ writes the question, blocks for the answer
          ▼
       local model server (Ollama, or any OpenAI-compatible server on this machine)
```

- **`/workbench`** (`skill/workbench/SKILL.md`, linked to `~/.claude/skills/workbench`) turns
  workbench mode on for the session and is Claude's procedure in it: size the work, write the
  spec, dispatch, drive, review, accept. SKILL.md holds what every session needs; what only some
  do (model servers and the weekly check, the agents' skill library, images, audio, steering and
  check-ins, handovers, permissions, the web and the web chat, the checks for a spec Claude
  wrote) is in `reference/*.md` beside it, read when it comes up: every line of SKILL.md rides
  along on each of Claude's calls (it was 46KB; the 2026-11-17 measurement; 34KB to 30KB on
  2026-11-18). The review is in
  proportion to the task's size. The user types it once, then asks for things as usual;
  the mod keeps the mode (and reminds Claude of it after a compaction or `/clear`) until a quit
  command. Only the user starts it; Claude never delegates on its own (the mod also counts a
  delegating `wb` command as the mode, keeps the mode by session id in its `$.store` so a
  session resumed in a new process comes back in it, and turns it on when it adopts a task still
  delegated: #689; not one a quit parked or Claude took over, #834).
- **`wb`** (`bin/wb` → `workbench/cli.py`) is the CLI Claude drives. Every command does one thing
  and prints a short, plain report, because Claude reads it and Claude's tokens are the scarce
  resource.
- **The runner** (`workbench/runner.py`) is a detached process per task. It drives the agent
  round after round until the task needs Claude, then exits. Nothing has to stay open for a task
  to run.
- **OpenCode** runs the local model as a coding agent, headless, in the task's own git worktree,
  inside the task's lane (`workbench/lane.py`) and with a read-only `git` (`workbench/gitguard.py`).
- **The workbench mod** (`mod/`) is a Claude Code plugin. It draws the pane, keeps a status line,
  and starts a turn for Claude the moment a task needs it, so Claude never polls.
- **The web chat** (`workbench/chat.py`, `workbench/chat_static/`) is a small page and server for
  reaching the same Claude session from a phone; it installs as an app and notifies
  (`workbench/webpush.py`).

Everything talks through plain files in one state directory (`$WB_HOME`, `workbench/store.py`).
The runner, the agent's `ask_reviewer` server and the chat server never call each other or the
mod; they read and write the same files, and anything that waits sleeps in the kernel (inotify on
directories, pidfd on processes, `workbench/watch.py`) until one of them changes. The mod's only
calls are `wb` subcommands (`wb events`, `wb watch --json`, `wb status`, `wb chat ack|claim|url|log|ask|wait|answer|on|off`,
`wb stop|takeover --all --repo … --session …`, `wb update` and its weekly `wb update --check --if-due`,
`wb optimize start --if-due` once per session (*Optimize*)), plus
`kill -0` where there is no `/proc` (macOS) to see whether a pid lives and `tail -c` to read a long file's end. A
crashed piece loses nothing, and every piece can be inspected with `cat`.

workbench is Python's standard library only (3.11+), plus the TypeScript mod. There is no
packaging: it runs from its clone. `bin/wb` and `bin/wb-ask-mcp` check the interpreter before they
import the package. On Python older than 3.11 they first exec the newest `python3.N` (N 11 or
more) on PATH that runs, with `-X wb-python`, which stops a second hand-over: Ubuntu 22.04's `python3` is
3.10 and RHEL 9's 3.9, their users install `python3.11` or newer beside it, and wb refused anyway,
the mod's `wb events` too (#259, the audit of 1.2). Each candidate, newest first (PATH order
among equals), is probed first with `-c "import sys, ctypes; sys.exit(sys.version_info < (3,
11))"`: a pyenv or asdf shim for a version it lacks exits 127, a partial build may lack the
ctypes the lane imports, and the working 3.11 behind such a shim was never tried (#526). With
none, they exit 78 (EX_CONFIG) with one line (`wb: needs Python 3.11 or newer; <python> is
<version>, and no python3.11 or newer is on PATH. Install one.`, or, when some were found and
none ran, `… and none of the python3.N on PATH runs with ctypes (tried <each>). Install one.`); so they do on native
Windows (`wb: native Windows is not supported …; run Claude Code and wb inside WSL2`), not with a
traceback from deep inside it (the 2026-11-16 audit). The chat's unit stops on 78 instead of
retrying a broken install (*The web chat*). Under a locale whose encoding isn't UTF-8 (ISO-8859-1,
or C with Python's coercion off) they re-exec themselves with `-X utf8`, so every text file is
read and written as UTF-8 (the 2026-11-19 audit: a note with an accent was a traceback). Everything else starts from their `sys.executable`. No model is named anywhere in the code: models come from
OpenCode's config and the router decides, so a new model is one config entry away.

**Where Python processes start.** Five places, and each finds the package by path, not by an
installed module:

| Process | Started by | How it finds `workbench` |
|---|---|---|
| `wb` | the user, Claude, the mod | `bin/wb` puts its real path's repo root on `sys.path` (so the `~/.local/bin/wb` symlink works) |
| the runner | `cli.spawn_runner` | `python -X utf8 -m workbench.runner <task>`, cwd and `PYTHONPATH` = the repo root (the caller's own kept in `WB_USER_PYTHONPATH` for the agent: `context.detached_env`, as for the bench driver and `wb optimize`), own session (and its own systemd scope where logind kills sessions at logout: `cli.detach`, `cli.runner_scope`, #351), output to `runner.log` |
| the ask server | OpenCode, from the config layer's `mcp.servers.workbench` | `[sys.executable, <root>/bin/wb-ask-mcp]`, like `bin/wb` |
| the git shim | the agent's shell (`<rules>/bin/git`) | a `/bin/sh` wrapper that execs `<python> -I -c` (quoted: a shebang splits at a space) with an explicit `sys.path.insert` |
| the lane | the runner, before OpenCode | `python -I lane.py …`, a standard-library-only script |

`-I` drops `PYTHONPATH`, so it is used only where the path is inserted in code; never rely on
`PYTHONPATH` under `-I`.

## Why it's built this way

- **Claude's tokens are the scarce resource; local tokens are free.** So the local model does the
  typing, Claude writes the spec and reviews, and every `wb` report is short. Raw logs stay in
  files.
- **Small local models lose the thread.** They repeat a call, plan for minutes without acting,
  fill their window reading, and summarise their own context lossily. So tasks are sized to what
  the model actually finishes (its slice, learned), guards stop runs going nowhere, the runner
  hands a full session to a fresh one with exactly what it needs, and OpenCode's own compaction
  is only a backstop.
- **The summary is a claim, not evidence.** Claude reads every diff; acceptance tests gate every
  round; nothing the agent does leaves its worktree until Claude commits it.
- **The agent is a teammate with limits, not a prisoner.** The everyday tools of software work
  run without asking; what's outside (a new dependency, another directory, a network tool) is
  asked for and granted in seconds (`wb allow`). The limits that matter (git writes, credentials,
  Claude's own files, writes outside the lane) are enforced by the kernel where it can (Linux
  with Landlock; file contents, not their permission bits), and the acceptance tests run under
  the same limits.
- **Learned, not configured.** Which model takes which size, how big a task can be, how fast a
  model is, when to hand over: each starts as a guess and is corrected by real results on this
  machine (`results.jsonl`), so a new model or a new machine needs no code change.
- **Files, not services.** A task survives Claude restarting, a crash, or the user closing the
  terminal; any piece can be read with `cat` and fixed by hand.
- **What running local models on one ordinary GPU taught** (the reasoning behind the router's
  defaults and the weekly check):
  - A model that fits entirely in GPU memory beats a bigger one that spills into system RAM:
    those were slower, crashed more, and did no better. So the router puts models that fit first.
  - Quantization matters (higher is better), but at the same memory a larger model at about 4
    bits beats a smaller one at 8.
  - Thinking mode off works best for agent work: the model writes code instead of planning it at
    length (hence the think budget).
  - Models change fast, so once a week Claude checks what's new for the hardware and recommends
    changes; nothing is downloaded without the user's yes.

### What a handoff costs Claude, measured
The README's "about half the tokens of writing the code itself" on bigger tasks, once the
session is open, comes from paired runs on
2026-11-18: the same request done by Claude alone and handed off, in Claude Code subagents on
the same model, each result graded by hidden tests it never saw (all passed), Claude's tokens
weighted by price (input 1, cache write 2 at the main session's 1-hour cache, cache read 0.1,
output 5). One 16 GB card, a 27B model at the 40K window `wb optimize` found all on the GPU,
self-review on, the request pasted as the spec and a one-call sign-off:

| Task | Claude writes it | Handed off |
|---|---|---|
| Save and load replay files (C, significant) | 166K | 150K (−10%) |
| Score combos (C, significant) | 176K | 145K (−18%) |
| A date range for a report (Python, trivial) | 50K | 67K (+34%) |
| Rank a high score (C, trivial) | 54K | 83K (+54%: one round sent back) |

The significant pairs start from a fresh session, so the handoff includes reading the skill
(about 29K) and both pay the session's base context (about 50K). Without those, the clean
replay-files handoff was about 48K (dispatch 9K, the review wake 31K, accept 8K) against about
116K for writing it: the "roughly half". The trivial pairs are warm (a task before them in the
session); about 10K of each handed-off figure is the harness waiting on `wb wait`, which the mod's
wake replaces. A run varies by about 0.2× from the next, and one round sent back costs about
25K: replay files measured 1.18×, 1.40×, 1.38× and 0.90× as the self-review learned what the
review rounds had been about.

## A task, start to finish

```
 wb start ─▶ queued ─▶ running ──▶ testing ─┬─pass, or fail with auto-fix spent, or no --test─▶ review
              (GPU,      │  ▲  ▲            └─fail: auto-fix round (up to --auto-fix) ─▶ running
               load)     │  │  └─ a note, an interrupt, a nudge, a handover: the next round, straight away
                         │  └──── asking: ask_reviewer blocks until wb answer / wb allow
                         ├─▶ stuck  (a guard, wb stop, a SIGTERM not from wb)            ─┐
                         └─▶ failed (opencode died, a crash, the runner died without a word) ─┤
 review ─▶ wb accept ─▶ accepted                               ├─▶ wb feedback ─▶ queued (a review round)
        ├─ wb next ─▶ queued (the next step, same agent)       ├─▶ wb resume ─▶ queued (a fresh session)
        ├─ wb feedback ─▶ queued                               └─▶ wb discard ─▶ discarded
        └─ wb discard ─▶ discarded            wb takeover (any open task) ─▶ review, Claude finishes it
```

**Phases** (`store.py`): `ACTIVE` = queued, running, testing, asking; `NEEDS_CLAUDE` = review,
stuck, failed, asking (`asking` is in both); `CLOSED` = accepted, discarded. Who sets each:

| Phase | Set by |
|---|---|
| `queued` | `wb start`, `feedback`, `next`, `resume`; the runner on every start ("waiting for the GPU") |
| `running` | the runner at each round's start, and once no question is open (`ask_mcp.relay`) |
| `testing` | the runner while the acceptance command runs |
| `asking` | the runner while a question of the round is open (`ask_mcp.relay`) |
| `review` | the runner (tests pass; tests fail with auto-fix spent; no `--test`); `wb takeover` |
| `stuck` | the runner (a guard stop; a SIGTERM that wasn't wb's: `runner.SIGNAL_STOP`; workbench updated under it: `runner.UPDATED`, #603); `wb stop`; `wb accept` when a live task's commit fails ("accept failed: …", the work kept in the worktree) |
| `failed` | the runner (opencode exited non-zero, whatever it printed: `runner.died`; the setup failed; the model couldn't load; a crash or a full disk); `cli.reap` (the runner died without a report). All but the first set status `infra`: the machine's doing, which `wb bench` doesn't grade (#508) |
| `accepted` / `discarded` | `wb accept` / `wb discard` |

Inside one runner, rounds follow each other with no `queued` in between: a steer, a handover, an
auto-fix and a note arriving during the tests all go straight back to `running`. The runner exits
only on review, stuck or failed, a SIGTERM, or a crash.

**A runner that dies without a word** (SIGKILL, out of memory, a reboot) can't report, and its
task would sit in a live phase forever: `wb wait` blocked on it, feedback and resume refused it
(the 2026-11-16 audit). `cli.reap(task)` ends that: a task in a live phase (queued, running,
testing, asking) whose runner isn't alive and whose status hasn't changed for `REAP_GRACE` (15 s,
since feedback, resume and next set `queued` a moment before `spawn_runner` writes the new pid;
their slow work, `wb next`'s session export and the GPU note, comes before it: a `wb next` was
reaped as dead while it read the session)
becomes `failed`, `last` "the runner died (see runner.log)", with an `error` event and one
`failed` notice ("wb resume continues it"). A runner whose status `boot` isn't this boot
(`store.boot_id`) was ended by a restart (a WSL2 VM shut down, a battery that died, an update):
`last` is `RESTARTED` ("interrupted by a restart…"), and the first reaper reaps the session's
other tasks the same restart left (same task.json `session` and `cwd`) quietly and raises one
notice on the first started, naming them all (`tasks`) and `wb resume <a> <b> …` (by name, #692:
`--all --repo <cwd>` resumed nothing for a session in `~`, which claims no task by directory, and
in a repo two sessions share it resumed the other's tasks too, whose own notice then went stale); the
others are acknowledged with it (`_restart_notice`), so the mod wakes Claude once, not once a task
with a guess at why (#544). A runner of another machine (status `machine` isn't `store.machine()`:
`/etc/machine-id`, macOS's hardware UUID, else the host name) is alive to `runner_alive` and never
reaped: on a state directory several machines share (a network home), each one's wb read the
other's live runners as dead, its pid not in this process table, failed them as restarted and
would signal its pid here (#849). `wb stop` and `discard` (`_stop_runner`) refuse it ("<task> runs on
<host>…: stop it there"), `wb stop --all` and `wb update --stop` leave it out, and `wb status` shows
"on <host>:" before its `last`. Alive means beating: the runner touches its lock file
(`locks/<task>.runner.lock`) every `runner.BEAT_SECS` (60 s, a daemon thread, `runner._beat`;
`.lock` is `QUIET`, so no `wb events` wakes) and says so (status `beat`), and another machine's
runner whose lock file is older than `cli.BEAT_DEAD` (30 min, generous for clock skew and a
machine asleep, whose runner then finds its task failed when it wakes) is dead here
(`cli._beats`): reaped ("the runner on <host> died without a report (no heartbeat for 30 min:
…"), not as a restart, its `agent_pid` left alone (another machine's pid), and `wb stop`,
`discard`, `stop --all` and `update --stop` clear it without signalling. A runner killed with its
machine (power loss, a container recreated with a new host name, `store.machine()` falling back
to it, a reimaged machine) kept its task live for good, no command able to clear it (#872); one
recorded before the beat (no `beat`) is trusted, as before. `wb doctor` says when the state directory is on a network file system
(`store.network_fs`, by the type of the longest mount point holding it, of several there the
last listed: an automounted home lists its `autofs` trigger first and the NFS mount stacked on it
after, and read as local, #896). There each machine keeps its own state in
`$WB_HOME/machines/<store.machine()>/` (`store.machine_dir`, else `$WB_HOME`): the GPU lease
(#849), optimize.json and optimize.log, boxes.json and wsl-gpus.json (#894: shared, each machine's
`wb optimize` found the other's GPU in the fingerprint and emptied its own to measure again, and
another machine's loads on a wb remote box counted as this one's), and speed.json (#901). A new file of one machine's
goes there too. The agent's group (`agent_pid`, read before it is
cleared) is killed when `models.runs` shows it still runs `run --standalone` (off Linux the kernel leaves it running when its parent dies, as the
2026-11-19 audit observed), and `runner.sweep` kills what its agent left. The
check-and-set is `Task.set_status_if`, under the task's status lock (`locks/<task>.status.lock`), so of two reapers one notifies. `wb status`, `wait`,
`feedback`, `resume`, `next`, `steer` and `accept` call it, `wb events` once a minute, so the
mod wakes Claude, `wb top` every `PROBE_EVERY` (#571) and `wb log -f` each pass (#545). On Linux the agent dies with its runner anyway: `lane.py` sets
`PR_SET_PDEATHSIG` (SIGKILL) before it execs OpenCode or the tests.

**A noexec state directory** (#851): the agent's git shim (`rules/<task>/bin/git`, first on its
PATH), the worktree and the scratch checkouts all live under `$WB_HOME`, so on a mount with
`noexec` every git call the agent made exited 126 and the project's own programs (`./gradlew`,
`node_modules/.bin`, `.venv/bin`, built test binaries) failed as if the lane or the project were at
fault. `store.noexec()` reads statvfs's `ST_NOEXEC` (Linux; macOS's statvfs has no such flag):
`wb start` refuses before writing anything and `wb doctor` is BAD, both with `cli.noexec_line()`
(move `WB_HOME` to an exec mount, or remount it exec). The doctor's `os.access(W_OK|X_OK)` passes
such a directory: `X_OK` on a directory is search, which noexec allows.

**A full disk** (#342, the audit of 1.4) failed every status write: the runner's crash handler
failed on its own, the task stayed live, and `reap`'s write raised, so `wb status`, `wb wait` and
the mod's poll ended in a traceback until space was freed. Now `wb start` refuses a task the disk
has no room for (`cli._disk_room`: under the base's tracked size (`gitops.checkout_size`: a Git
LFS pointer at the size of the file it stands for, #382; in a sparse checkout only what it checks
out: in cone mode the top's files, each cone directory's parents' and everything under a cone
directory, with patterns the checkout's own index entries without skip-worktree; in a partial
clone, `gitops.partial_clone` (a promisor remote), only the blobs it holds, asked through
`cat-file --batch-check` with `GIT_NO_LAZY_FETCH=1` (git 2.44+; an older git's all count as
unknown), the rest unknown and said: a 30 GB monorepo's whole tree was counted for a 1 GB cone,
and a blobless clone fetched every blob, one at a time, to be sized, #436; and each submodule
`fill_submodules` can fill, its whole tree at the recorded commit and its own submodules,
`_submodules_size`: a gitlink is no blob, so a 6 GB submodule counted nothing and the base check's
fill hit ENOSPC, #886) plus its `--copy` paths
(a file at its own size: `store.dir_size` counted one as nothing, #436), times
`DISK_COPIES` (3: the worktree, the base check's and `wb verify`'s scratch checkouts, full copies
on ext4; the setup's build output, not made yet, is checked before each scratch copy instead:
`runner._no_room_for`, #860) plus `DISK_SPARE` (2 GB), free where the state directory is, less what the open tasks'
runners haven't checked out yet (`runner.pending_checkouts`: each one's task.json
`checkout_bytes`, the size this check measured, until its status has `checked_out`; a failed one's
never counts): since the runner makes the checkout, a batch of starts each saw the disk as the
first did and four 8 GB checkouts ran at once on 40 GB (#676). It names the open tasks and
their sizes; unknown free space refuses nothing). The runner checks again before its checkout:
less free than `checkout_bytes` plus `runner.CHECKOUT_SPARE` (2 GB, `DISK_SPARE` is it) fails the
task before any round ("… free where the state directory is, and its checkout needs …"). The runner's crash handler on ENOSPC or EDQUOT
(`store.disk_full`) sets `failed` with "the disk is full … wb resume", and with no room even for
that, exits without raising. `reap` that can't write says so once per command on stderr and
leaves the task for the first call that can; its notice names the free space when it is under
`DISK_SPARE`. Any other command that meets a full disk prints one line naming it (`cli.main`).
`wb doctor` prints what the state directory holds and what is free (BAD under `DISK_SPARE`).
Free is `store.free_bytes`: statvfs's `f_bavail`, and on macOS the larger of that and the volume's
capacity for important usage (`store._important_free`, CoreFoundation's
`kCFURLVolumeAvailableCapacityForImportantUsageKey` through ctypes, what Finder calls Available):
on APFS statvfs leaves out purgeable space (local Time Machine snapshots, iCloud Drive's optimized
files), which macOS frees when asked, and a Mac with 1.5 GB by statvfs and 30 GB in Finder refused
every start (#852). On WSL, for a path in the distro's own file system, at most the free space of
the Windows drive behind its virtual disk (`store.host_drive`: the system drive's mount, `/mnt/c`,
where WSL keeps `ext4.vhdx` unless it was moved, else the first drive's, from
`context.windows_drives`): statvfs there reads the virtual disk's ceiling, up to 1 TB, so on a
full C: the checkout grew the disk until Windows refused, which WSL shows as EIO and a read-only
remount, never ENOSPC (#897). `wb doctor` says which drive that is, or that none is mounted; a
virtual disk moved to another drive isn't seen.
The refusal, `wb doctor` when space is short and `cli.main`'s full-disk line also name what
history holds past 100 MB, with what frees it (`cli.history_held`: the archive, "wb gc trims its
old logs"; wb bench's cases, "wb bench rm <case>"; its runs, "a new run trims old ones"): the
advice named only open tasks, never the space history kept for good (#740).

**1. Claude writes a spec.** The skill tells Claude to size every task to what the model that
takes it actually finishes: one concern, no bigger than that model's slice, with the files named,
the code to imitate pointed at, exact names for anything other code relies on, and an acceptance
command that proves it's done (an existing test, or a new one the agent writes first). Bigger work
is split into steps run one after another. Planning, in Claude Code's plan mode or not, works the
same way: in workbench mode the plan the user approves is already that list of steps, each with
its size, files, exact interfaces and acceptance command, and what stays Claude's (git,
CLAUDE.md, the user's decisions, the review checks) marked apart.

**2. `wb start` sets it up** and returns at once (`cli.cmd_start`):
- It checks the task name (`store.NAME_RE`, `^[a-z0-9][a-z0-9-]{0,47}\Z`: `\Z`, as `$` let a
  name ending in a newline pass, #782; not used before by any task, open or
  closed: the refusal says names are never reused; every other command naming a task, through
  `cli.need`, refuses a name that isn't one, such as `foo/`, `./foo` or `Foo`, naming the task it
  meant: pathlib opened `tasks/foo` for each, but the runner's command line says `foo`, so its
  live runner read as dead, reap failed the task under a notice no reader takes, and discard
  removed the worktree under the agent, #782), that the repo is a git repo (a repo git
  refuses, such as dubious ownership, is reported with git's own reason, not as "not a git
  repository"; `gitops.toplevel` raises `NotARepo` when a rerun under `C_LOCALE` says "not a git
  repository", so a French git's message is classified too, the 2026-11-19 audit, and the user
  still reads git's own words), the spec (a file or `-` for stdin), the `--skill` names, that `--base` names a
  commit (`gitops.base_commit`: `rev-parse --verify <base>^{commit}`, before the CLAUDE.md check, which
  a typo once posed as), that git has an identity for the commits (`cli._identity`: `git var
  GIT_AUTHOR_IDENT` and `GIT_COMMITTER_IDENT`, as `git commit` resolves them; without one a task
  ran to review and only accept failed: the 2026-11-16 audit), and that `CLAUDE.md` or
  `.claude/CLAUDE.md` (`cli.PROJECT_MEMORY`, as Claude Code reads them) is committed at the base
  (an agent without one starts blind; `--no-claude-md` is for throwaway repos). A `CLAUDE.md` the
  repo gitignores passes with a note: the agent gets the checkout's copy
  (`context.instruction_files`), and it's never to be committed. All of this comes before the task
  directory is made, so a refusal leaves nothing behind.
- It picks the model: the router's choice for the task's size (`--size trivial|significant`,
  default significant) and the repo's stack (its main languages, from its tracked files; a
  monorepo package's own, from the package's files: a Go service in a TypeScript monorepo was
  routed and recorded as TypeScript work, #820), or
  `--model` (an id, or a fragment that names one model). First it refuses when the first word of
  `runner.opencode_bin()` isn't on PATH (the runner would empty the GPU, then the round die as
  "opencode exited 1"). No model can run: exit 3, each model's reason with its next step
  (`models.remedy`: `wb model add <id> --pull`, start Ollama at its root, load it in the server,
  give it a `start`; the router's message names models the size policy holds back as such). A
  `--model` that can't run right now is refused the same way, with "(--force queues it anyway,
  to wait for it)" only when its server is just down (`models.may_come_up`); `--force` queues it
  regardless. The runner waits for a server that is just down (*Waiting for a server that is
  down*), and its load (`make_resident`) fails it before freeing the GPU if it still can't run.
- Two projects, one GPU: when another task holds the GPU (or waits for it, or `wb image` or a
  GPU engine of `wb audio` does)
  and the new task's model couldn't run beside it (`models.admits`: the same rule the lease
  uses), it refuses before making anything, exit 4, with one line naming each holder's task,
  repo and model and the two ways out: `--queue` (start anyway and wait behind it) or doing the
  step yourself. Before this, the second session's task queued in silence, maybe for hours
  (the 2026-11-16 audit). The holders are gpu.json's live entries plus any task whose live runner
  hasn't reached the lease yet (`cli._gpu_holders`; status `leased`, the runner's pid, says it
  has: one that stepped aside for its tests or a server's wait was counted, and a task the lease
  would have let in was refused with exit 4 for the length of the other's test suite, #805), not
  another machine's task (`store.elsewhere`) while the lease is this machine's own: on a network
  home its checkout or base check refused this machine's idle GPU (#895). A remote model is checked against the
  holders of its own server's pool (`models.pool`; this machine's for one on this GPU, #750). A known limit, left by choice (the 0.90 review): the check takes no lock, and a task
  is visible to it only once its runner's pid is in its status, after task.json is written, so
  two `wb start`s at the same moment (from two sessions) can both pass it. Nothing hangs
  silently then: the second runner waits for the GPU, and its status (`last`, the pane, `wb
  status`) says "waiting for the GPU (held by <task>)" (`GpuLease._take_alone`); `wb stop` it,
  or let it queue. `wb feedback`, `next` and `resume` continue a task and always queue, but print a note
  naming the holders it will wait for (`cli._gpu_note`).
- It works out the limits: `--round-timeout` and `--silence-timeout` unset (or 0) take the
  model's measured budgets (`router.budgets`), as does `--think-timeout` unset (0 turns the
  think nudge off); `--checkin` defaults to 0 (off). The ones no flag gave (task.json
  `timeouts_given` lists those a flag did) stretch before each round when the model has since
  been measured slower (`runner.stretch_limits`, *Budgets and speed*, #814).
- It doesn't make the worktree: the runner does, first of all (`runner.checkout`, task.json
  `checkout: "runner"`, status `checked_out` and `checkout_secs`), branch `delegate/<task>` in a
  fresh worktree under the task directory from `--base` (default `HEAD`). Made here, a big repo,
  one on `/mnt/c`, with Git LFS data or large submodules passed Claude's two-minute Bash limit, and
  the next start made the same checkout and was killed again (#529, the audit of v1.90). `wb start`
  checks what that would refuse first: the branch exists (`branch delegate/<task> already exists`),
  or a branch named `delegate` or one under `delegate/<task>/` holds its place (`gitops.branch_clash`,
  which `create_worktree` asks too: `branch --list` missed them, and every task's checkout failed, #792),
  a base tracking paths that differ only by case while the state directory's file system folds case
  (`gitops.case_clash`, in `create_worktree` too: one file was written for each pair, the review showed
  the other as the agent's change and an edit to one was committed to the other, #797),
  and the submodules it couldn't fill (`fill_submodules(dry=True)`), said now. A checkout that
  fails, or a `--copy` path the base doesn't ignore (#322), fails the task before any round, with a
  `failed` notice; a checkout cut short (a runner killed, a reboot) is made again from nothing on
  the next run, and `wb discard` of one removes it whole (`gitops.remove_worktree` lifts git's
  "initializing" lock, `_unlock_cut_short`, which remove and the registration's drop skip: the one unlock, which
  `_drop_start` goes through too). The branch is this task's only where the runner recorded making
  it: status `branch_made`, the base it makes the branch at, written before `worktree add` and only
  when no `delegate/<task>` exists (one that does, an earlier task's, fails the checkout and is left
  alone); a rerun and `wb discard` delete it only through `delete_branch(at=branch_made)`, so one
  moved since stays, as does one a worktree has checked out (`checked_out_in`, #930), and `wb discard` says why it kept one (#416). `wb feedback`, `next`
  and `resume` on a task that never got its worktree say to discard it and start again
  (`cli._need_worktree`, `runner.checked_out`), except a `resume` of one interrupted from outside
  (status `last` in `cli.INTERRUPTED`: a restart, a runner that died, a signal, `wb update --stop`; or `runner.UPDATED`'s, workbench updated under it: `cli._interrupted`, #788) before its first
  round: it starts round 1 again and its runner makes the checkout again (`cli._rechecks_out`,
  so `wb resume --all` after a reboot takes a task that was still checking out). The user's own checkout is never touched, and
  uncommitted changes in it stay out of the agent's copy (it says so). The worktree's real git dir
  is recorded in `rules/<task>/gitdir.json` before any agent runs there (*Git, commits and
  projects*). Submodules are not checked out there, and it says so: populated, each one's `.git`
  would be a file the agent could point at a git dir of its own, whose config git obeys outside
  the lane. Before the worktree exists, `context.instruction_files` (for the fixed-prompt note)
  reads the user's checkout instead.
- It doesn't run the acceptance command: the runner does that first (*The base check*, in *The
  runner, inside*), so `wb start` returns at once whatever the suite costs. It once ran here, and a
  slow suite pushed `wb start` past Claude's two-minute Bash limit, leaving a task queued with no
  runner (the 2026-11-16 audit). With `--test` it prints that the base check comes with the first
  report.
- Nor does it set the worktree up: the runner runs the setup (`--setup 'npm ci'`, `--copy`,
  `--sibling`, or commands.json `repos` for every task) before the base check (*Setting the
  worktree up*), and `wb start` says so; with none, it names the checkout's ignored directories
  the worktree lacks.
- It writes `task.json`, round 1's prompt (the spec plus the working protocol, `cli.PROTOCOL`:
  git is read-only, the acceptance command (`cli.test_line`: run it, never weaken a test, and not
  the whole suite unless the spec asks: agents spent half an hour on it after theirs passed, #127),
  the `ask_reviewer` budget,
  stay in scope, where it can write and how to ask for a directory, finish with a summary and any
  `Lesson:` lines), the initial status (with `--skill`), the grants (`--allow`, `--allow-path`, in
  `rules/<task>/grants.json`), and spawns the runner.
- It prints the model and why, the slice, Claude's spec record, the handed or suggested skills,
  any notes, and `next: wb wait <task>`.

**Waiting for a server that is down.** A task's model whose server is only down
(`models.may_come_up`: Ollama not answering, a server with no `start` command not running) is
waited for, not failed (`runner._wait_up`): it looks again after 2 s, then 4, 8, … up to a minute
apart (`DOWN_PAUSES`), for up to `DOWN_WAIT` (`models.START_TIMEOUT`, 20 min), with status `last`
"waiting for <id>: <why> (up to N min more; wb stop gives up)" and one `load` event; past that,
the task fails ("<id> can't run: <why>, for 20 min"). It waits before taking the GPU lease, so
it holds no GPU from other tasks meanwhile; a load under the lease that fails while the server
is down (an Ollama restart, an out-of-memory kill between rounds) waits the same way, then loads
once more (`runner._load`). A configuration error (not pulled, a refused key, a window too small)
still fails at once. `wb stop` ends the runner, and the wait with it. Failing at once, a task `wb
start --force` queued "to wait for it" failed on its first check (the 2026-11-19 audit).

**3. The runner takes the GPU** (`models.GpuLease`; *Sharing the GPU* below). Tasks run side by
side when their models fit the GPU together; otherwise a task waits as `queued` for the GPU to
itself, first come first served, with status `last` "waiting for the GPU (held by <task>…)" (the
pane shows it). No round guard counts the wait: the round, its clock and its guards start once
the model is loaded. Then it makes the task's model resident: it unloads every other
model Ollama holds (the user's or another tool's) except those of tasks running beside it, stops
other model servers that have a stop command, and loads or starts the one it needs. The lease is
held for every round and every test run until the runner exits, and the model is made resident
again before every round after the first (one look at the server when it is still loaded).
After each load the runner reads the window the server now serves (`models.served_window`:
Ollama's `/api/ps` `context_length`, else `server_facts`) and, when it is less than
`limit.context`, fails the task before the round with the fix (`short_window`, raised in
`runner._load`): only doctor, scout and `wb model add` compared them, and an Ollama restarted
without its `OLLAMA_CONTEXT_LENGTH` trimmed every prompt silently while OpenCode, thinking there
was room, never compacted (#248, the audit of 1.2). A server that doesn't say isn't refused.

**4. The agent works a round.** The runner runs `opencode run --standalone -m <model> --auto
--format json --title "wb: <task>" [--session <id>] -- <prompt>` in the worktree, inside the lane,
with `$PWD` set to the worktree (OpenCode finds the project from `$PWD`) and the task's config
layer (`OPENCODE_CONFIG`). Rounds after the first continue the same OpenCode session, so the agent
keeps what it has read, until the session is handed over. Every event streams into
`events.jsonl` and `status.json` keeps the live summary.

**5. Guards stop a run that's going nowhere.** Small models that lose the thread repeat
themselves, so the runner stops the agent:

| Guard | Default | Set by |
|---|---|---|
| the same tool call (its whole input: a hash of the JSON; cut to 400 characters, four new files opening with one licence header were one call, #497) in a row | 4 | `events.StuckDetector` |
| failing tool calls in a row | 6 | |
| tool calls since the last successful edit to the task's files (an edit through the shell counts; a file written outside the worktree doesn't: an agent sure the compiler was broken wrote 20 minutes of test programs in /tmp, each resetting the count, 2026-11-18) | 40 | |
| no output at all (not counted while it waits on Claude; while a background job runs, the test timeout if longer) | 15 min | `--silence-timeout` |
| one round running too long (not counting waits on Claude) | 40 min | `--round-timeout` |
| more than `HANDOVER_MAX` (5) mid-round handovers in one review round | | `runner.drive` |
| OpenCode still running after it closed its output (a shutdown that hangs held the task and the GPU lease for good, #83): SIGTERM, then SIGKILL, a line in runner.log; the round ends as its events say | the silence limit, at most `EXIT_GRACE` (30 s) | `runner.run_round` |

A model generating for minutes with no tool call is usually planning instead of doing. Past the
think budget (7 minutes, `--think-timeout`; 0 turns it off) the runner interrupts it with a nudge
(`runner.NUDGE`: act now, the smallest edit first, one file per call, run the tests soon) and
raises a check-in for Claude. The think budget counts from the round's first output, so a model
still reading its prompt (minutes, on the CPU) isn't nudged for it; and not while OpenCode waits
on a command it moved to the background (*The runner, inside*). The round after a nudge that
stalls past the budget again is stopped as stuck, whatever it did first. The guards run on the
monotonic clock, so a suspend isn't silence.

These limits were set on a 27B model that writes ~36 tokens a second. A slower machine gets
longer ones, learned per model (*Budgets and speed* below); none goes below its default.

**6. The tests gate the round.** After a round that ended cleanly (not stuck, not failed, not
interrupted, not handed over) the runner runs the acceptance command (`--test`) in the worktree,
through the shell, with a 15-minute limit (`--test-timeout`); the output is saved per round (`tests.txt`). If it
fails and auto-fix rounds remain (`--auto-fix`, default 2, counted since the last review round or
step), the failure goes straight back to the agent as the next round's prompt (`auto_fix_prompt`: fix
the code, don't weaken the tests; a failing check it wrote this task, work its expected value out
by hand first and correct the test if that was wrong; never blame the compiler or system: an
agent whose change compared the wrong way round spent 40 minutes sure gcc was broken,
2026-11-18), and Claude isn't woken. Not a failure that says nothing about the change
(`not_the_code`, #496, the audit of 1.90): a run past `--test-timeout` (the agent edited code that
may well have been right, nothing ever naming the limit) or one the lane refused a device
(`lane_refused`, #331: rounds 2 and 3 ran on the same refusal) is no auto-fix round. Not a run
past the limit whose command passed the base check in `HANG_SHARE` (a quarter) of it or less
(`hang`; tests `hang {base, limit}`): that is the change's hang, an infinite loop, a blocking
read, a server never shut down, and goes back to the agent, its prompt saying, after its opening
sentence, that the tests now run past the limit where they finished in so many seconds on the
base, and what to look for (#779: each one cost a full-length run and a wake). A base check that
timed out, failed, ran another command or never ran keeps the skip; the round
goes to review, status `last` the cause ("the acceptance command ran past --test-timeout (900s):
Claude reviews next", "the lane refused /dev/kvm: …") and the report led by `auto-fix skipped:
<cause>` with what to do (run it in the worktree, narrow it, a larger `--test-timeout`; `wb allow
<task> --path <grant>`, the grant `lane_grant` gives each path as the report's own line does,
once each and every path `shlex.quote`d, then `wb feedback`: the raw path of a file not made yet
sent Claude's `wb allow` to make a directory of that name, #670). A dropped proxy (`proxy_gap`, #380) may be either: the
auto-fix round runs, its prompt saying first, after its opening sentence, that the output shows a
failed connection with the proxy left out, and not to change code for one. With either key set
(`proxy`, `lane`) the prompt doesn't say the system works and the bug is in this change. A note
that arrives during the tests goes to the agent first; that test result is dropped. With self-review on (the `self_review` knob,
*Self-tuning*: on by default, learned per model; `--self-review`/`--no-self-review`, task.json
`self_review`, set it for one task), the first time the tests pass in a review round (status `self_reviewed`, the `[steps, reviews]` it
ran at) the agent gets one more round, `runner.SELF_REVIEW`: Claude's own review checks (each
rule has a test that fails when that rule alone breaks, each rejection checked by commenting
out its check and watching a test fail, the file copied aside first and copied back after; each test the task names checking what it says, exact output whole against a literal
written by hand; expected values worked out by hand, every error path handled and each error
message tested for every input that can cause it; the project's CLAUDE.md rules kept, and docs it
wrote saying what the code does; nothing extra), from what Claude's reviews kept catching on
2026-11-17 and 2026-11-18. It costs local time only; Claude is woken
after it, with its tests. On by default because a feedback round costs Claude a whole wake: on
2026-11-18 a trivial handoff came in under Claude writing it only when the first change Claude
saw was right. A model whose own reviews don't spare Claude's rounds scores worse for the time
it spent and learns it off.

**7. Claude is woken with a report** (`runner.summary_text`, *The round report* below). When the
round passes (or auto-fix runs out, or there is no test), the runner writes the report and a
notice and exits. Stuck and failed rounds get the same report, with why it stopped.

**8. Claude reviews.** The skill is strict about this: the summary is a claim, not evidence.
Claude reads the whole diff (`wb diff`), checks correctness, the spec, that the tests would catch
a bug, the repo's conventions, hygiene and safety, and runs things in the worktree when in doubt.
Then one of:

| Command | What happens |
|---|---|
| `wb accept <task> -m "…"` | commits the work on its branch, removes the worktree, the agent's runtime directory and its rules, optionally `--merge`s (then deletes the merged branch) |
| `wb feedback <task> --message <file>` / `--text "…"` | a numbered list of exact changes becomes the next round's prompt; the runner starts again. The skill allows three review rounds before Claude fixes it itself or discards it |
| `wb next <task> --spec <file> -m "…"` | commits the approved step on the branch and gives the next step to the same agent, in the same worktree (and session, while it has room) |
| `wb discard <task> --reason "…"` | stops it, removes the worktree, the agent's runtime directory and the branch (`--keep-branch` keeps it) |
| `wb relocate <task> --repo <dir>` | after the repo moved or was renamed: repairs the worktree's link and points the task there |

Every accepted or discarded task leaves a row in `results.jsonl` (*Files and formats*). The
router, the slice, the tuning and the skill records learn from those rows. A check of workbench
itself on a scratch repo isn't evidence of how a model does real work: `wb start --trial` marks
it (its row is kept but left out by `store.results()`, and its lessons aren't gathered), and
`wb trial <task>…` marks a closed one after the fact.

**What a task cost Claude** (`workbench/spend.py`). The pitch is that Claude's tokens are the
scarce resource, so each row also records what the task cost the Claude Code session that ran it
(task.json `session`), read from that session's transcript at accept or discard:
`${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/<session>.jsonl`, plus its subagents' files under
`<session>/subagents/`, and those of each later session its process had (`spend.sessions`): a
/clear continues the process under a new id and transcript, whose review turns once went
uncounted (#451). Every `wb` call records its session under its process
(`store.note_claude_session`: `claude-sessions/<CLAUDE_PID>`, a `<ts> <id>` line once per id,
under a `start <its start>` line, `models._started` as one word, `store.claude_word`, for each
process the pid has had); the ones task.json's `claude_pid` recorded from its `created_at` on
are read too, only those under its `claude_start` (`store.claude_sessions(pid, since, start)`;
lines written before the start lines count when written after that process started,
`store._start_epoch`: keyed by pid alone, a new Claude Code process given a dead one's pid, in a
container or after a WSL restart, took its sessions and with them its tasks, #787), each turn
counted per session. So are the sessions recorded in the task's own `claude-sessions` (a `<ts>
<id>` line once per id, `store.note_task_session`), written by every `wb` call that names the task
(its `name` or `task` argument): a task another process adopted after a crash, an update or a
restart (`cli._scope`, its start process gone) was reviewed and accepted under another pid, and
those reviews went uncounted (#719). Usage is per API call (an assistant message: one row per
content block, the same `usage` on each, so counted once by `message.id`, across the sessions too:
a resumed or forked session's transcript can copy the history it came from), and a call is charged
to tasks of that session only:
- a call whose Bash runs `wb … <task>` (each `wb` in the command, split with `shlex`) is that
  task's, and so are the turn's calls after it, until a `wb` names other tasks, `wb
  accept|discard` closes it (`CLOSING`), or a call edits (`EDITS`) a file outside the task's
  worktree that is not a file handed to `wb` (`HANDED`: `--spec`, `--message`, `--file`): that
  is other work;
- a turn's calls just before its first such `wb` are that call's tasks' (the reading and the
  spec before `wb start`), back to the last call that ran any `wb` or edited a file other than
  one the naming call hands over or one in the task's worktree: a long turn of other work that ended
  in `wb start` once put all of it on the task (82K output, 2026-11-17); a turn a wake opened
  (`` [workbench] Task `<name>` ``, the mod's opening, `WAKE`, matched only at the prompt's start,
  after Claude Code's "The workbench plugin sent a message:" line) is that task's from its start;
  a turn that names none is no task's (planning, other work). A turn starts at a user row that is
  no tool result, not `isMeta` (an image a Read showed, a skill's body) and not
  `isCompactSummary`: those, taken for new turns, ended a review's charge mid-turn, and a summary
  quoting a wake was charged as one (#557);
- a call naming several tasks is split evenly;
- each subagent's transcript is a thread of its own, charged by the same rules (its prompt starts
  its turn, its `wb … <task>` calls name tasks, `CLOSING` and the reading before a `wb` apply),
  in the turn of the session's call before it; a subagent call that names no task is charged as
  that session call. Charged only that way, a task a subagent started, reviewed and accepted, in a
  turn whose one session call was the Agent tool's, cost Claude nothing (#718). The session's call
  before a time is the latest in the transcript of those made at or before it, found by bisection
  over them sorted by time (a prefix max: times are almost, not quite, in order); a scan of every
  session call per subagent row took 6.6 s at 8,000 calls and 30,000 rows, on every close (#728).

Charging whole turns was the first design and was wrong: one long autonomous turn that also ran a
task put 5.5M cached tokens of other work on it (2026-11-17). What is missed: the accept's own
turn after the `wb accept` call is written, and planning turns that name no task. The row keeps
the raw counts (`input`, `cache_write_5m`, `cache_write_1h`, `cache_read`, `output`, `turns`,
and `calls`, the task's share of the calls charged, split like the tokens);
`spend.weighted` makes one number of them in input-equivalent tokens, from the API's price
multipliers on input (`WEIGHTS`: output 5, a cache write 1.25 for 5 minutes or 2 for an hour, a
cache read 0.1, which errs high for the models whose reads cost less: no model is named in code).
`wb accept` and `wb discard` print it beside the estimate of writing it (`savings.line`, *What a
task saved*), or alone when there is no estimate (`claude: ~N K input-equivalent tokens over T
turn(s)`), and
`wb stats` averages it per model and size. A task with no session (started by hand, or before
0.90), whose transcript Claude Code has cleaned up, or whose transcript no call charges to it
records none (`usage_by_step` gives None, and the row has no `claude`): written as a measured
zero, it pulled the model's mean cost down in `_cheaper` and the stats (#718). The router reads it
(`_cheaper`, *Choosing a model*).

**Each step's share** (`spend.usage_by_step`, #558). A task of several steps (`wb next`) also
records each step's cost, in its row's `steps[i].claude`, so a bench case of one step is set
against that step's handoff, not the whole task's (Claude's audit of 1.90: a 3-step task's 240K
read handoff/self 2.67 against Claude writing step 3 for 90K, when step 3's own share was about
80K). The split is by time: the task's `next_step` events (written by `wb next`) mark where each
step began, and a charged call is the step under way when it was made, except that a call
running `wb next <task>` and the calls charged with it as its spec (the reading back to the spec's
edit, as for `wb start`; `calls` marks them `ahead`) are the step it hands over. So a step's cost
is its spec, its reviews and its feedback; step 1's also has the planning before `wb start`, and
the last step's the accept. A review read before the next spec was written stays with the step
reviewed; a spec written in an earlier turn, not just before `wb next`, stays where it was charged.
A `wb next` that failed hands nothing over (clamped to the last step). No split is written when a
charged call has no timestamp, or the steps counted don't match the row's.

### What a task saved: an estimate of Claude writing it
`workbench/savings.py` sets a task's cost beside an estimate of what Claude would have spent
writing the same change itself (the user, 2026-11-18: nothing in the product showed the saving).
The estimate comes from 8 paired runs on 2026-11-17 (Claude writing a task, graded by hidden
tests): it made about `SELF_CALLS` 4.9 + lines changed / `SELF_LINES_PER_CALL` 69 calls, and wrote
about `SELF_OUT_PER_LINE` 36 output tokens per line changed. Each of those calls is priced at what
this task's own calls cost per call less their output (`per_call`: the session's context, as it
stood), so a big session's handoff is compared with writing it in the same big session.
Checked on 2026-11-19 against five new runs, one per bench case (`wb bench self`, fresh
`claude -p` sessions; lines changed from each run's `diff.patch`, calls counted by message): mean
error 19% again, −32% to +21%, low on four of the five, so it understates the saving. A refit of
the three constants on those five fit them better (15%) but missed each one left out by 32% on
average, so the constants stand until there are more runs to fit (#120).
`estimate_self(lines, per_call)` is that sum, weighted; `of_row(row)` needs the results row's
`claude` (with `calls`) and `diff`, and gives `{claude, self_est, saved, wh}`. It prices the lines
Claude would type: a tool's files (lockfiles, files marked `linguist-generated` or `-diff`) are
left out of `diff`'s `added` and `removed` (`gitops.footprint`, kept apart in `diff.generated`),
and the lines of files deleted whole (`diff.deleted`) are priced as one more call, not as lines:
deleting a 2,400-line module read "saved ~725K", a 4,000-line lockfile "saved ~1.28M", far
outside the fit, which came from ordinary edits (#725; rows from before keep their old price).
`--share` says so (`savings.COUNTS`); `line(row)` reads
`claude: 56K · writing it yourself: ~59K (estimate) · saved ~3K · GPU 41 Wh` (a negative saving
reads `cost ~3K more`); `totals(rows, since)` adds them up, with the energy's `cost` at the
user's electricity price (`price()`, from `$WB_SAVINGS`, else `~/.config/workbench/savings.json`
`{"kwh_price": …}`; `set_price` sets it, or with None removes it, keeping any other key, through `store.edit_config`), and `of`, every closed task of the period, compared
or not (the coverage).

**The badge** (`savings.score`, #101) is one number from 1 to 100 over those totals. B is the
estimate of Claude writing the tasks alone (`self_est`), A what delegating them cost Claude
(`claude`), both summed before dividing, so a big task weighs as its baseline does. The percent
saved is 100·(B−A)/B, and the score is that rounded, held between 1 and 100. Its bands
(`BANDS`): 1–9 red, 10–24 orange, 25–49 yellow, 50–100 green. Its sentence is the signed
result: "I used about 62% less Claude than if Claude had done this work alone", "about the same
amount", or "about 20% more" (a score of 1 for both of those). With no comparable task or a zero
baseline there is no score (`NO_SCORE`). GPU energy, its price and the acceptance rate stay out
of it. `wb savings` ends its line with `score N/100`, `--json` carries `score`
(`{score, color, pct, sentence}`), and the web chat's gear shows the badge.
`wb savings --card FILE.svg` (`savings.card`) writes it as a 360-wide SVG to keep or post. The
card has the question "How much Claude did my GPU save me?", the number on its band's color
(`CARD_COLORS`, each pair past 4.5:1), the sentence, both totals, the period and "N of M tasks
counted · estimated". Every line is wrapped by hand (`_wrapped`). It is made here, fetches
nothing, and holds no name, path, host or account; the user decides where it goes. The fit's mean error is 19%, single tasks −36% to
+48%, so it is always called an estimate. A discarded task saved nothing: its row (with
`claude`, no `diff` needed) gives `self_est` 0 and `saved` −claude, and reads `claude: 21K ·
discarded, nothing saved · GPU 12 Wh`; `totals` counts it too. `wb savings` prints `summary`
over a period (the last 7 days by default; `PERIODS`): `the last 7 days: 3 task(s) · claude 160K ·
writing it yourself ~390K (estimate) · saved ~230K (59%) · GPU 1.2 kWh, cost 0.36`. The percentage
is the saving's share of the estimate, the number the savings badge scores (#101).

The inputs come from the task. The energy: while OpenCode runs a round, the runner's `_Power`
thread samples `hardware.gpu_power_w()` every `POWER_EVERY` (10) s and adds the watt-hours to
status `gpu_wh` (not for a remote model: `CURRENT["remote"]`, set in `drive`, which marks status
`remote_gpu` instead, so its savings line ends `GPU energy not measured (another machine's)` and
`savings.summary` counts such tasks, #117; nor for the suite's
fake models, `WB_FAKE_MODELS`, which would read this machine's GPU; a None reading adds
nothing; the tests after the round aren't counted). Its intervals are on the monotonic clock,
and one past `FROZEN_SECS` (60 s: a suspend that clock still counted, as WSL2's may) or
backwards adds nothing (`_Power.step`): on the wall clock an 8-hour suspend mid-round added
1.2 kWh of a 150 W GPU to `gpu_wh`, the results row and `wb savings`' cost (#559). A reading is
the whole GPU's draw, so each one adds this task's share: the draw over `runner.sharers()`, the
tasks holding the lease and not waiting (`models.holders`, a task's GPU tests one task with it):
two tasks sharing a 300 W GPU for an hour each counted 300 Wh, and the period's energy and cost
doubled (#706). The mean and peak (`gpu_w_*`) stay the GPU's own draw. The size: `gitops.footprint` gives `files`, `lines` (added) and
`removed` (a renamed file under its new name), leaving out the files a tool writes
(`gitops.generated`: a package manager's lockfile by name, `gitops.LOCKFILES`, or one the repo's
.gitattributes marks `linguist-generated` or `-diff`), which it counts apart as `generated`
(`{files, lines, removed}`, only when there are any, #720), and the files deleted whole again in
`deleted` (`{files, removed}`, when any, #725); each step records them
(`results.step`), and an accepted task's row sums them as `diff`.

**Sharing it** (`wb savings --share`, `savings.share`, #119) prints a plain summary for the user
to paste into a discussion, where users pool their evidence. Nothing is sent anywhere. It covers
the period's rows with both sides to compare:
- the machine: `hardware.system()`, each GPU's name and VRAM (`hardware.gpus(windows=False)`);
- the local models used: their count and weights (`models.weights`), never a name;
- the tasks: Claude's tokens, the estimate, handoff/self overall and by task size, and what the
  estimate counts (`COUNTS`, #725);
- the badge's score and sentence (*The badge*), or `NO_SCORE`;
- the GPU energy, saying when some ran on another machine's GPU.

No model name, repo, task name or price appears in it.

### Kept awake

An overnight backlog, `wb optimize` or `wb bench` froze when the machine idle-slept: the runner,
its lease, the model server and Claude Code alike, until morning, and the monotonic guards
counted none of the gap, so nothing reported it (#516). So everything `cli.detach` starts for the
night (each runner, a queued one too, the bench driver, `wb optimize`; not the chat server) holds
an idle-sleep inhibitor tied to its pid (`detach(…, awake=<why>)`, `cli.keep_awake`), a process
of its own that ends when the run does:

- **macOS**: `caffeinate -i -w <pid>` (idle sleep; a closed lid on battery still sleeps).
- **Linux booted with systemd**: `systemd-inhibit --what=idle:sleep --who=workbench --why='task
  <name>' --mode=block` around a wait for the pid (`AWAIT_PID`: a pidfd, else `kill -0` every
  15 s); `systemd-inhibit --list` shows it. logind's polkit grants a sleep lock to a local active
  session only, so where it refuses (SSH, a scope outside any session) an idle lock is held
  instead (`--what=idle`: it holds logind's `IdleAction`, not a desktop's suspend). It starts in
  the caller's session, not `runner_scope`'s scope, for that grant: under
  `KillUserProcesses=yes` it ends at logout while the runner goes on.
- **WSL2**: Windows sleeps whatever Linux inside it holds, so the request is made on Windows'
  side (`awake_how` "windows", with interop on, `context.interop_on`, and `hardware.powershell`
  finding powershell.exe; #777): `sh -c '<python> -c AWAIT_PID <pid> | powershell.exe
  -NoProfile -NonInteractive -Command WINDOWS_AWAKE'`, which calls
  `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` (2147483649, in decimal: Windows
  PowerShell reads `0x80000001` as a negative Int32) and blocks on `[Console]::In.ReadLine()`;
  once the pid is gone the pipe closes, the read returns and the request ends with the process.
  Idle sleep only: closing the lid or choosing sleep still sleeps it; `wb doctor` says so
  (`WINDOWS_AWAKE_SAID`). Without interop or powershell.exe nothing can: `wb start --backlog`
  says so on a batch's first task, and `wb doctor` too (`WSL_SLEEPS`: set Windows' sleep to
  Never while plugged in for the night).
- Anywhere else (no tool, no systemd): nothing, and no failure; `wb doctor` says so.

## The runner, inside

`workbench/runner.py`, started as `python -X utf8 -m workbench.runner <task>` by `cli.spawn_runner` (cwd
and `PYTHONPATH` the repo root, the caller's in `WB_USER_PYTHONPATH`, `WB_HOME` set, its own session, stdout and stderr appended to the
task's `runner.log`). `main` installs a SIGTERM handler that ignores any further SIGTERM, stops
the process group in flight (the agent's, or the tests') and raises `Stopped` (a `BaseException`,
so no `except Exception` on the way swallows a stop). wb's own stops mark status `stopping` first
(`cli._stop_runner`): that stop logs a `stopped` event (`by: reviewer`, "stopped by the
reviewer"), and the command sets the phase. A SIGTERM without the mark (a shutdown, a logout, a
`kill`) while the phase is live logs `stopped` `by: signal`, sets `stuck` with `SIGNAL_STOP` ("the
runner was stopped by a signal … not by Claude", status `signalled`: when the signal came) and
raises a `stuck` notice, so the task is resumable rather than live forever (past the first step, with `steps_line`). A shutdown or a
logout signals every runner at once, and each raised a notice of its own, one wake a task (#544):
`_signal_notice` waits, up to `SIGNAL_SETTLE` (12 s, past `_stop`'s 10 s wait on an agent) after
its signal, while another task of its session (`store.owner`: task.json `session` and `cwd`, else
`repo`) still runs a live runner; then, under `locks/signal-stop.lock`, one notice names every
task of the session the signal stopped within that span (`tasks`), raised on the first started
with `wb resume <a> <b> …` (by name, #692; and each one's `steps_line`; `cause` `signal`), the others
acknowledged with it (`store.ack_batch`); a runner a notice already named raises none. One
stopped alone keeps its own notice, with `wb resume <n>`. Any other exception writes the traceback to `runner.log`, sets
`failed` and raises a `failed` notice with the traceback's tail. On the way out `_end_agent` runs
once more and `pid` and `stopping` are cleared.

**An update under a running task** (#603, the audit of v1.90). The runner's code is loaded once,
at its start, but each round's children load theirs from the clone afresh: the lane (`lane.py`,
run as a file), the git shim (written by the runner, importing `gitguard`) and the ask server
(`bin/wb-ask-mcp`: `ask_mcp`, `store`, `watch`). A `git pull`, or Claude Code's plugin update,
mid-task paired old and new, and a changed interface between them (lane flags, `gitguard.main`'s
parameters, the ask file format) ended the task stuck or failed with the cause only in
`runner.log`. So `main` records `code_print()` (a sha256 of `runner.CHILD_CODE`, those files) in
`CURRENT["code"]` and imports `router`, `transcript` and `verify` up front (they were imported
lazily, mid-task, from whatever the clone then held); before each round `_updated` compares, and
on a change sets `stuck` ("workbench was updated under this task: wb resume <task> continues it
on the new code") with a `stuck` notice (`cause` `updated`: not held against the step's size,
#660), before anything of the round runs. `wb update` refuses
while any runner is live; a manual pull is the case this catches. OpenCode the same way
(`opencode_moved`, before the GPU lease and before each round after the first): status `opencode`
(its `M.m`, set by `wb start`, `wb feedback`, `wb next` and `wb resume`, `cli._opencode_again`)
against `opencode --version` now; changed, `stuck` ("OpenCode was changed under this task (2.3,
now 2.5): wb resume <task> continues it on 2.5", `runner.OPENCODE_MOVED`, which `wb resume --all`
takes as an interruption), and before 2.0, `stuck` with `OPENCODE_GET`, both `cause` `opencode`.
Only `wb start` looked: reinstalled from npm (1.x) mid-task, the next round failed as "opencode
exited 1", charged to the model's slice, and every resume repeated it (#866). Feedback, next and
resume refuse 1.x as `wb start` does (exit 3, before anything is written) and note a version
outside `OPENCODE_TESTED`.

**`drive(task)`**, the loop:
1. Phase `queued`, `pid`, `boot`, `machine`, `host`, `beat` (its lock file touched every `BEAT_SECS` from `main` on, #872); resolve the model (unknown: `failed`). With a `setup`, `copy` or
   `siblings` and no `prepared` in status: the worktree set up (`_prepare`; a failure: `failed`,
   before any round). With `--test`, while no round has reported (`needs_base_check`: no
   `base_check` in status, step one, no review round, no `rounds/<n>/summary.md`; not
   `no_base_check`): the base check, before the GPU. Gated on round 1, a task that failed or was
   stopped before its first round (its server down at start, `wb stop` during the setup) and was
   then resumed into round 2 ran without one, and its report didn't say so (#510, the audit of
   1.90). The setup and the base check each take a turn machine-wide, setups and base checks
   in queues of their own (`runner.prep_turn(task, kind)`, `PREP_KINDS`: `PREP_SLOTS` 1 at a
   time each, in queue order by task.json `created_at`; the queues in `locks/prepare.json` and
   `locks/prepare-check.json`, the slots `locks/prepare-<n>.lock` and `prepare-check-<n>.lock`,
   flocks the kernel drops with a dead holder, whose entry is passed over once its pid is gone),
   status `last` "waiting for <task>'s setup" (or "base check") "(one at a time on this
   machine)" meanwhile. One queue for both held a 5-second base check, capped at 120 s, behind
   another task's 25-minute build with the GPU idle (#868); two base checks (two test suites, a
   fixed port) still never run together. Run before the GPU lease, a
   batch of N queued tasks ran N installs and N test suites at once beside the running agent,
   which swapped a small machine, timed base checks out, and failed a test server on a fixed port
   in all but one clone (#590). A base check that needs the GPU (`--unload-for-tests`,
   `verify.gpu`) takes the GPU first and its turn only around the run itself (`verify.on_base`'s
   `turn`): taken first, the turn was held through the whole wait for the GPU, behind another
   task's rounds, and every queued task's setup waited with it (#679). A round's own tests don't
   take a turn: the GPU lease already orders the rounds.
2. Hold one `GpuLease` for everything that follows, except where it steps aside
   (`lease.step_aside`: out of `gpu.json`, `gpu.lock` unlocked) because the task needs no GPU: the
   tests, and a wait for a server that is down. All of `drive` ran under it, so queued tasks waited
   through every test run (up to `--test-timeout`, each round) and a 20-minute wait, and a
   project's own GPU tests ran beside the resident model, their out-of-memory failures sent back
   to the agent as its bug (#257, the audit of 1.2). `wb start --unload-for-tests` (task.json
   `unload_for_tests`) also unloads an Ollama model there, unless another holder runs it or
   models.json keeps it loaded, decided and sent before the lease is let go, under the
   `gpu.admit` lock every admission takes: decided after, from the holders seen before, it
   unloaded the model the next task had just been let in with and loaded (#327, the audit of
   1.4). And its tests, which use the GPU, keep the lease: its `gpu.json` entry becomes one with
   no model and `tests: true`, `gpu.lock` still held, so nobody joins it (`admits`: a holder whose
   model isn't known), `wb start` refuses (exit 4, naming the task, phase `testing`, or `queued`
   while it waits for the GPU as below) and a queued task waits until the tests end: let go, a queued task was let in and ran a whole model round
   while the tests still ran, both allocating VRAM at once (#428, the audit of 1.8). Without the
   flag (tests on the CPU), and on a remote model's server, it lets go as above. Holders already
   sharing the GPU are waited out: the tests hold their entry, status phase `queued` (from before
   `step_aside` to `run_tests`'s `testing`, the remote case's wait below too: left `running`, `wb
   steer --now` promised an interrupt within seconds and the wait counted as active work, #943's
   review) and `last` "waiting for the GPU (held by …): the tests use it alone", until every other holder has stepped aside or ended
   (`GpuLease._alone_for_tests`; another task's GPU tests only when they came first, by `since`,
   so two never run together nor wait on each other), and then `runner._tests_gpu` frees every
   model left on this GPU, the other holders' and the task's own alike (`free_gpu` with no `keep`,
   so within `keep_loaded` only, then `media.settle`): Ollama's and LM Studio's unloaded, a
   server engine's (vLLM, llama-server, any with a models.json `stop`) stopped, and the next
   round's load starts it again (up to `START_TIMEOUT`), so with the flag a server model pays its
   start every round; before, a task admitted
   beside this one kept its model there and its rounds running while the tests allocated VRAM
   beside it (#943). With a model on a wb remote box the tests still run here: `_tests_gpu`
   takes this machine's pool for them alone (`verify.gpu`), as the base check does. Before the next round `_rejoin` (phase `queued`, "waiting for the
   GPU") takes it back: beside the holders when it fits, else alone, in first-come order by the
   task's start, so it keeps its place ahead of later tasks; a round that ends in review leaves
   without rejoining. The checks in scratch checkouts (the base check, `wb verify`, `wb shot`)
   take no part of this lease; with `--unload-for-tests` each takes this machine's GPU
   alone for its runs, whatever the model's pool (a wb remote box's model took none, yet the
   checks run here: #943) (`verify.gpu`: `media.gpu`, a `GpuLease` with no model, queued first come
   by the task's start, then `free_gpu` within `keep_loaded` and the memory let go), since they
   ran the project's GPU tests beside other tasks' resident models and an out-of-memory failure
   read as the base's or the change's (#502, the audit of 1.90). Waiting is said (status `last`
   for the base check; a line before the report for `wb verify` and `wb shot`). `lease.load()` (the seconds are added to
   `status.load_secs`, after what the task's earlier runners loaded: set, a `wb feedback` runner
   finding the model resident wrote 0 over a 40 s cold load, #567), the window (`limit.context`) into `status.window`, and `tuning.tune` picks
   the task's knob values once (`status.tuned`). A load error: `failed`, with a notice.
3. Each round n: after the first, the lease rejoined and `lease.load()` again, since each request resets Ollama's
   keep-alive to its own 5 minutes and a longer test run once left the auto-fix round paying for
   the reload inside its think budget (a reload adds to `load_secs` and `loads` and logs a `load` event;
   resident already, it is one look at the server). Notes still pending (they came in while the
   task was queued, the model loaded or the auto-fix prompt was written) are added to the round's
   `prompt.md` with `NOTE_HEAD` and counted taken (`_early_notes`): they once waited for the round
   to end and came a round late (#452). For n > 1, `fresh_reason` decides whether a fresh session takes over
   (`_start_fresh`); a one-round `keep` is cleared and passed to `run_round`, so that round never
   hands over. Phase `running`, `round_started_at`, a `round` event, then `run_round`, then
   `_end_agent` (however the round ended, and while the lease is still held, so the GPU's next
   task never meets this agent), then `measure_speed`.
4. After the round, in this order: full → `_full_round` (a handover; the successor's prompt
   carries any pending notes), unless this runner has already handed over `HANDOVER_MAX` (5)
   times: then the round is stuck ("handed over to a fresh session 5 times in this round without
   finishing: the step is too big for this model's window…"). Interrupted, or a note pending and the round not stuck →
   `_steer_round` (the next round carries the notes). Opencode exited non-zero, or the silence
   guard stopped the round (OpenCode retrying), while the model's server is down (it went away
   under the round), whatever the model had said first (an out-of-memory kill comes late in a
   round, after its first words, and it once had to be silent: #657) → a `load` event, the wait
   for the server (*Waiting for a server that is down*), and the round runs again, once a round.
   A server wb starts itself (models.json `start`) that is no longer running (`runner._stopped`:
   an out-of-memory kill, a CUDA assert) isn't waited for: the loop's load starts it again, and
   the round runs again, once a round; a start that fails fails the task as a load failure (#579).
   The rerun continues the session. The server gone again after that one revive fails (or
   sticks) the task with `infra` `model` and notice `cause` `server` (#657).
   Stuck, or opencode exited non-zero (`died`: whatever it printed, since a child that said "I
   will inspect the files" and exited 7 went on to an already-green test and to review as "tests
   passed", #427; not the runner's own stop of a shutdown that hung, `lingered`) → the report
   without tests (plus "NOTE: not delivered, the round stopped first: …" for Claude's notes still
   pending, `_undelivered`), phase `stuck`/`failed`, a notice, exit; the edits so far stay in the
   worktree. Otherwise `run_tests`; a note that arrived meanwhile, or while
   the report was being written → `_steer_round`. The report
   goes to `rounds/<n>/summary.md`. Failing tests with auto-fix left, unless `not_the_code` (a timeout, a lane refusal) → an
   auto-fix round (round n+1's prompt is the failure). Otherwise phase `review`, a `review` notice (the report, then
   `review_diff`: the whole diff under review when it is at most `REVIEW_DIFF_MAX` = 32,000
   characters (~8K tokens), else its stat (the diff read as it streams, `gitops.diff(limit=)`,
   git stopped past the limit: a 19 MB generated file's patch was held whole, a 55 MiB peak, for a
   182-character notice, #348); each call Claude makes to fetch it re-reads its session,
   2026-11-17, and at 12,000 both significant tasks of 2026-11-18 (13K and 15K) cost that call;
   after a review of the same step, only the diff since that review notice (`gitops.snapshot`,
   a tree object recorded as status `reviewed`), with a proposed instruction file shown again only
   when it changed: the wake after a feedback round carried the whole 14K-character diff again,
   2026-11-18 (that tree reachable from nothing, git gc prunes it in time: then the whole diff
   again, saying "the last review's snapshot is gone (git gc pruned it)", `gitops.has_tree`;
   the diff against it failed and the notice dropped every diff without a word, #795); the snapshot leaves bulky new files out, named in the notice ("left out of the
   review snapshot, too big to store each round: …"; the next review's diff shows them again):
   `gitops.snapshot_left`, chosen from `ls-files --others` and their sizes before anything is
   hashed, so a file of `BINARY_MAX` or more, while more than `NEW_FILES_MAX` new files remain
   the top-level directories holding the most, then the biggest files while the rest pass
   `SNAPSHOT_MAX` (32 MiB); the tree then gets the tracked files' changes (`add -u`) and the new
   files kept by name, where `add -A` had written every new file into the user's object store
   each round, a refused accept of 400 × 100 KB `build/` files taking `.git/objects` from 28K to
   41M (#431; `wb verify` takes the tree accept would land instead, `landing=True`: *Verifying a
   fix against the base*, #642);
   then the agent's proposed instruction files as diffs, *Claude's files*), exit.

Round reports and check-ins list the first 40 changed paths (`gitops.CHANGED_SHOWN`).
They count remaining files by top-level directory, showing up to 40 directory totals.
The stat in a review notice also shows at most 40 paths, followed by Git's total.
A report flags a new top-level directory with at least 50 untracked files (`BUILD_FILES`).
Before committing, `wb accept` and `wb next` check the worktree for more than 300 new
files (`NEW_FILES_MAX`) or a new binary of at least 1 MiB (`BINARY_MAX`). The check
(`gitops._bulk`) reads `ls-files --others` (and new files already staged) and their sizes, a big
file's `diff` and `filter` attributes and, if they don't say, its first 8000 bytes for a NUL, as
git's own test; a filtered file (Git LFS) is stored as its filter makes it, so passes. Nothing is
hashed until it passes: run on a snapshot, every file it refused was already in the object store
(#431). A refusal preserves the working files and staging area. Use `--include` to approve those
files after review.

**`run_round(task, n)`.** Writes the config layer and the agent's environment (*What the agent
knows*), prepends the skills note (`skills_note`) to the prompt argument (not to `prompt.md`),
wraps the command in the lane, and starts it in its own process group (so a stop takes the MCP
server too), stdin `/dev/null`, stderr to `runner.log`. A reader thread (`_reader`) queues stdout
lines, decoded as UTF-8 with a byte that isn't shown as U+FFFD, and its end marker however it
ends: one Latin-1 byte (a plugin's print) once killed it, and the finished agent went unseen
until the silence timeout stopped the round as "no first output" (#440); a
steer bell (`_steer_bell`, a `Watcher` on the task directory and `ask/`) queues a wake when
`steer.jsonl` or an ask file changes; each tick relays the agent's questions (`ask_mcp.relay`). The loop wakes on a line or every 5 s. Per line: `events.normalize` (dropping the rest),
the session id from the first `sessionID`, the tool tally and `status.last`, every text kept, and
for each `step` the context in use (input + cache read + cache write + output + reasoning, which OpenCode counts too) against the handover point.
Then, every pass, in this order: asking (phase `asking`) or not, and time spent asking is
neither the round's nor silence; the round's wall clock; silence; the think nudge; a guard stop (`stopped` event; before a no-edit stop it checks
`gitops.mark`, so an edit made through the shell, `sed -i` or `cat >`, resets that guard); a handover; a check-in; a
pending `--now` note (an `interrupted` event). Any stop goes through `_stop`: SIGTERM to the
process group, 10 s for the leader, then SIGKILL. The agent's pid is kept in `status.agent_pid`
while it runs, so `wb stop` can end it if the runner can't. A round that ends mid-question
clears `asking`. A stdout line that is JSON but not an object is skipped, not a crash, and
`events.normalize` reads an event whose parts have the wrong shape as empty ones, and stamps
one without a `timestamp` with the time it was read (it was 0.0, sorting the row first in `wb
watch` and the check-in digests, #481). A line is
parsed by `store.loads`, which makes a lone surrogate (half an emoji, escaped: valid JSON) U+FFFD,
as `transcript.export` does with the session export: no UTF-8 file can hold one, and one in a
model's tool arguments failed the next status write and the task (#438).

The prompt goes after `--`: OpenCode 2.3 reads a message that starts with `-` (a spec opening with
a bullet or front matter) as a flag, prints its usage and exits (the 2026-11-16 audit).
OpenCode's own `--worktree` (which takes `=name`) isn't used: the runner makes its own worktrees.

Every pass of the round's loop runs the clocks, the guards and the steer check, whatever the
line was: only the event handling is skipped for a line that isn't an event (`_event`: stray
output, a number or list) or one `normalize` drops. Those once `continue`d past them, and a
stream of a newer OpenCode's unknown progress events ran past `--round-timeout`, ignored `wb
steer --now` and held the GPU lease (#195, the 2026-11-19 audit).

The guards' clocks (`_Clock`) run on `time.monotonic()`, which a suspend doesn't advance and NTP
never steps (on the wall clock a laptop shut for 20 minutes woke to a round stopped for silence:
the 2026-11-16 audit); a loop pass longer than `FROZEN_SECS` (60 s, against its 5 s wait) means
the process was frozen, and that time counts as neither the round's nor silence. A question's
wait (`ask_mcp.Waited`, its own `FROZEN_SECS`: keep the two alike) leaves a suspend out the same way. Check-ins stay
on the wall clock, which the files' timestamps use. Silence and the think budget:
- The think budget starts at the round's first output line: OpenCode prints nothing while the
  model reads its prompt, which on the CPU or a model spilled into RAM takes many minutes, and a
  round nudged for that was then stopped "even after a nudge". Silence before the first line
  says so: "no first output in N minutes: the model may be reading its prompt slowly…;
  --silence-timeout gives a new task longer", and the round's read speed bound (*Speed*,
  below) adds what this task's next round and a new task on the model now wait.
- A `retry` line is not output (#491, the audit of 1.90). OpenCode 2.3 waits `headerTimeout` (300
  s unless the provider sets it) for a response's headers and `chunkTimeout` (900 s) between
  streamed chunks, then aborts the request and prints `retry {attempt, nextRetryAt, error:
  {type, message}}`; after four attempts `error` ("Timed out waiting for response headers") and
  exit 1. A server that sends its headers with the first token (Ollama reading a 10-20K-token
  prompt on the CPU or partly in RAM: 8-30 minutes) failed every such round, and each retry line
  reset the silence clock, so the no-first-output stop couldn't fire. Its `step_start` comes with
  the response's headers, or just before a retry: so a retry line neither counts as heard nor
  resets silence, and takes back the clocks its `step_start` moved. `events.normalize` keeps it
  (`retry {text, attempt}`), status `last` says so, and the report adds `OpenCode resent N
  request(s) to the model's server: <error>[; it cut the request at the provider's timeout]`.
  The config layer lifts both waits for the task's provider (*What the agent knows*).
- A `background_wait` line (OpenCode moved a shell command past 2 minutes to the background and
  the turn waits on it, printing nothing until it ends) pauses the think budget, and silence runs
  to the longer of `--silence-timeout` and `--test-timeout`, until the next event; the round's
  limit still holds. A long test suite was nudged and killed every 7 minutes, then rerun.
  But when the agent's turn is over (the last `step_finish` had reason `stop`) and nothing new
  comes for `BG_GRACE` (120 s, or `--silence-timeout` when shorter), the round is done: a dev
  server or watcher the agent left running never ends, so the round sat out the long wait and
  the finished work was reported stuck with no tests run (#658). The runner stops OpenCode (the
  job goes with it, `_end_agent`), records `left_bg` (the jobs' titles from the event's
  `jobs[]`; not a crash for `died`), writes a `left_bg {text}` event, and goes on to the tests;
  the report says `the agent left `<job>` running in the background when its turn ended;
  stopped`.

**Nothing a round starts outlives it** (`_end_agent`, after every round however it ended, and
in `main`'s `finally`): the agent if it still runs (`_stop`), a SIGKILL to its process group (a
`cmd &` left in it), then `sweep(task)`: every process of the user's whose environment carries
the task's `WB_TASK` and `WB_HOME` (`agent_env` sets both; the runner's own environment drops
`WB_TASK`, `spawn_runner`), since OpenCode's shell starts each command in a group of its own and
`setsid` leaves any group; of those, only the ones carrying the round's own `WB_RUN` (a fresh id
each round, and each test, setup or verify run: `agent_env(task, run)`), so a `wb verify`
finishing beside a round that `wb feedback` had just started no longer killed its agent, nor
two verifies each other's checks (#324, the audit of 1.4). With no round's id known (`main`'s
backstop, a crash before it), `_end_agent` sweeps the runs this runner issued and hasn't swept
(`ISSUED`, `_issue`; `sweep(task, runs=…)`), not the whole task: the backstop runs on every exit,
and it killed a `wb verify` or `wb shot` run in the background beside a feedback round, whose
candidate then read as failing (#504, the audit of 1.90). A whole-task sweep (`sweep(task)`, no
run) is for `wb stop`, takeover, accept, discard and `reap`. `agent_pid` is cleared. `sweep` reads `/proc/<pid>/environ`, else
on macOS `_sweep_macos` lists the user's PIDs with `ps` and reads the environment entries from
Darwin's `KERN_PROCARGS2` after skipping the argument vector. The tests get the same after each run, and
`wb stop`, `takeover`, `accept`, `discard` and `reap` sweep too. Seen in the audit: a writer left
running could change the worktree after Claude had read the diff, and a crashed runner's agent
went on working beside the next task.

A prompt (with its skills note) over `PROMPT_ARG_MAX` (100K bytes) is sent as a pointer to its
`prompt.md` instead, since Linux takes at most 128 KiB in one argument.

**The handover point** (`fresh_at`, a tuned knob: *Self-tuning*). Two checks:
- *Mid-round*, at each `step_finish`: once the context in use reaches `fresh_at × window`, the
  runner stops the agent and a fresh session takes over (`_full_round`), but only when the
  session has changed a file (`gitops.mark`, a hash of the diff and the untracked files, differs
  from when the session began) and a successor would have room to work: the context the session
  had read when it first changed something (`status.session_floor`) must sit at least
  `HANDOVER_ROOM` (a quarter of the window) below the handover point. Otherwise it carries on
  (OpenCode compacts it if it must), and a `reading_full` event says the step needs more reading
  than the window holds (`_reading_full`, once a round). It wakes no one: the round's report
  carries it as a `reading:` line, since the advice is for the next spec, and as a check-in it
  woke Claude mid-round with nothing to do, every round of a step (2026-11-17). Seen: twenty handovers in twelve minutes
  with no edit made; and a 16K floor under a 19K handover point handing over three times in four
  minutes, 3K of work each. A runner (one review round) hands over at most `HANDOVER_MAX` (5)
  times; the next one is a stuck round, since a session that changed something early and then
  filled up reading handed over for hours with Claude told nothing (the 2026-11-16 audit). The
  handover before the last raises a `checkin` (the fill, the count, the files changed), so Claude
  can steer or stop it; one for each from the second on woke Claude to read "on course" and wait
  again (2026-11-17). OpenCode compacting between two steps is caught too (`compacted_between`):
  `run --format json` prints no compaction, and one tool result bigger than the margin before it
  (a long file, a test log) compacted a session whose next step then sat under the handover
  point, so the agent worked on from OpenCode's summary for the rest of the round (#774). A step
  in the same session carrying under half of the last one's context, when that one was within
  `fresh_ceiling`'s margin of the handover point, is a compaction: with a change made and room
  for a successor (the floor as above; the last step's context when nothing had changed before
  it) a fresh session takes over (status `full_compacted`, so the next round's reason is
  `COMPACTED` and the tuning sees it); otherwise it carries on and a `compacted` event says so.
- *Between rounds* (`fresh_reason`, for n > 1, also used by `wb next` to say what will happen):
  Claude asked (`--fresh`, `wb resume`) → fresh, even with no session yet; no session → continue
  on the step's first round, else fresh ("the last session ended before it began", so a session
  that never started still hands the next round the task); `keep` → continue; the last round handed over (`context: full`) → fresh
  (`COMPACTED` when OpenCode had compacted it first, `full_compacted`); OpenCode compacted the
  session (`session export` lists a completed compaction) → fresh; the session's last assistant
  message that counted any tokens (`context_state`: one whose counts are all 0, an aborted step,
  is passed over, #481) carried `fresh_at` or more of the window (input + cache read + cache write + output + reasoning) →
  fresh, unless the mid-round rule says a successor has no room (`no_room`, #781: the session
  changed nothing, `session_floor` unset, or its floor sits less than `HANDOVER_ROOM` below the
  handover point; not on a step's first round, whose reading is its own): then it carries on,
  OpenCode's compaction the backstop, and the round report's context line says "the next round
  carries on in this session" (judged as the step's next round, `full_session`). Ignored between
  rounds, every auto-fix and feedback round on a small window re-read the same files and filled
  up again. When the export fails (a 30 s
  timeout, a busy store: `transcript.export(sid, strict=True)` is None), the round's last
  `step_finish` count stands in (status `live_used`, when it is this session's), compactions are
  taken as none, and an `export` event says so: an empty export once read as an empty session, so
  a full or compacted one carried on (#262, the audit of 1.2).

**A fresh session's prompt** (`_start_fresh`, `handoff_prompt`). The raw prompt is kept as
`rounds/<n>/instructions.md` (once a round: a round that began fresh and runs again, revived
before its first event, makes the handoff again from the kept one, for the work as it stands,
with the first reason (`_fresh_said`, from its `fresh` event) and no second event, and
`_early_notes` folds notes into both files; taken as the round's own prompt, the handoff went
over instructions.md and was wrapped in a second one, #780), and `prompt.md` becomes: "You are picking this task up in a fresh
session (why)…", `## The task` (the current step's prompt, `current_task_prompt`: `rounds/<step_round>/`
`instructions.md` when the step began in a fresh session, else its `prompt.md`, `store.round_prompt`,
which `round_asks`, the lessons and `wb bench add` read too; the spec plus the protocol), `## The work so far` (the committed steps, `git log --oneline
base..HEAD`, and the uncommitted diff, `git diff HEAD` with new files; a diff over
`HANDOFF_DIFF_SHARE` (9%) of the window at 4 characters a token, about 12K characters on 32K, and never
over `HANDOFF_DIFF_MAX` (60K characters), is replaced by its `--stat` and "read the changed files";
the diff is read only that far, `gitops.diff(…, limit=)`: read whole and then cut, a 300 MB
generated file not ignored was hundreds of MB in the runner at each handover, #474, the audit of
1.8; the stat capped at `gitops.CHANGED_SHOWN` files, as the review's, and each new directory of
build output the repo doesn't ignore named, `gitops.build_dirs`, "don't read them": uncapped, a
venv not ignored put 3,000 stat lines ahead of `## Now`, #863), then, when Claude answered any of the step's questions, `## Claude's answers to your
questions` ("An earlier session asked, and Claude answered; follow these, and don't ask them
again:", then `Q: …`/`A: …` pairs: `runner.answered`, from the runner's own `ask` and `answer`
events since `step_round`, plain questions only, never `NO_ANSWER`, the latest kept first within
`ANSWERS_MAX`, 4000 characters; an answer once reached only the session that asked, so a
successor after a handover or `wb resume` asked again, or past the budget assumed: #659), and
`## Now`: "Start on the task above"
on a step's first round; a `CARRY_ON` or `RESUME` round's own text (it carries the asks); else
the round's instructions, after what the step's earlier rounds asked since the last review
feedback (`round_asks`, under `ASKED`'s "What you were asked to do…", then "Now:"). An auto-fix
or steer round after a feedback round, starting fresh between rounds, once carried only its own
prompt, and the fresh agent reported done with the feedback never made (the 2026-11-16 audit). Status: the old session id moves to
`sessions`, `session` and `skills_told` are cleared, a `fresh` event is logged. After a mid-round
handover the instructions are `CARRY_ON` ("Your last session filled up… re-read the files you are
changing, then finish them and run the tests"), plus what the step's rounds asked since the last
review feedback (`round_asks`, so a feedback round survives handovers), the agent's last words
(the last two texts, 1200 characters) and any notes that came in as it filled. `wb resume` writes `RESUME` the same way. `status.handovers`
counts mid-round handovers. A note folded into a round's prompt after its opening (a carry-on's,
a resume's, or one that came before the round began, `_early_notes`) is also written to
`rounds/<n>/notes.md` (`runner.folded_notes`, `FOLDED`): `round_asks` skips a carry-on or resume
whole but keeps its notes from there, so the session after the next handover still gets them (it
once got only the first: the note was skipped with the carry-on and `steer_taken` already
counted it, #677).

**OpenCode's own compaction** is a small model's summary of its session, which drops details and
can lose the task itself (seen: an agent that built CLAUDE.md's "next step" after one). The config
layer sets `compaction: {auto: true, buffer, background: false}` with `buffer = max(usable + reply − window, 0) +
STEP_GROWTH` (usable: OpenCode 2.3's own figure, `runner.usable_input`: the smaller of
`limit.input` and the window, else the window, since OpenCode compacts at usable − buffer; reply:
`options.max_tokens`, else `limit.output`; `STEP_GROWTH` 4096), so OpenCode compacts only past the
handover point, leaving room for one reply at the output cap and one step's growth
(`compaction_buffer`). Taking an unset `limit.input` as context − output (OpenCode 1.x) wrote a 4K
buffer for a hand-written `{context 32K, output 16K}`: OpenCode compacted at 87.5% while the
handovers were planned against 37.5% (#675). OpenCode shrinks each request's `maxTokens` to fit, so
a request never overflows; the buffer is what keeps a full reply possible.

`compaction_point` is that point as a share of the window: 62.5% on a 32K window with a 4K output
limit and an 8K cap. `fresh_ceiling` sits one step's growth before it (`STEP_GROWTH`, or
`tuning.CEILING_MARGIN` of the window when that is more): 50% there; the tuner never tries a
handover point past it. The runner checks at each step's end, OpenCode before the next request
with that step's tool results in, so a ceiling at the compaction point itself (819 tokens of room
at 32K) let one 3K read compact the session first (#644). Both count a step's reasoning tokens
(the step row's `reasoning`, the export's `tokens.reasoning`), as OpenCode's check does. A model without `limit.context` gets no
mid-round handover, no `auto`/`buffer` and no ceiling. Every layer sets `compaction.background:
false` (`RESTATED` repeats it after a project's config): OpenCode 2.3.2 writes the summary ahead
by default (`SessionCompaction.precompute`, before each step once the context passes threshold −
min(60000, (threshold − first request)/2), about 43% of the 32K `wb model add` entry), a
full-context request on the agent's own server, below the handover point: a one-slot server
queued the agent's step behind it, its prefix evicted the agent's KV cache, the wait read as
thinking, and the handover threw the summary away (#661; `RealOpenCodeRun` checks no summary
request comes at 55%). 2.3.0, CI's pin, has no such key (it precomputes only behind an
experimental flag, off) and ignores it. Below `models.MIN_WINDOW` (16K) a
window can't hold a task (OpenCode's prompt and tools, PROTOCOL and the handbook take ~5K tokens,
and compaction would come before the earliest handover point, at 4K before the first request), so
`models.status` says the model can't run ("a 8K window; tasks need 16K+ …"): the router skips it,
`wb start --model` refuses it (exit 3), `wb model add` refuses to register it and `wb doctor`
marks it. At 16K, the entry `wb model add` writes puts the compaction at 50% and the ceiling at
25%, so no handover fits there and `runner.handover_warning` says so; an entry whose ceiling falls
below every candidate gets the ceiling itself (`tuning.allowed`).

**Notes, nudges and interrupts.** `steer.jsonl` holds every note (`{ts, text, now}`), written by
`wb steer`, by `wb allow` (to restart a running agent with its new rule) and by the runner's own
nudge (`by: workbench`); `status.steer_taken` counts the delivered ones. A round carrying notes (`_steer_round`)
starts with `INTERRUPT_HEAD` ("Claude, your reviewer, interrupted you. Stop what you were doing
and do this first; it overrides anything earlier…") when it interrupted, else `NOTE_HEAD` ("A
note from Claude, your reviewer, before you go on…"). The nudge is a `now` note, sent at most once a
round, so it ends the round like an interrupt (an `interrupted` event `by: workbench`) and the
next round starts with it; `status.nudges` counts them, and each raises a `checkin` ("the runner
nudged it: N min of thinking with no tool call"). A round right after a nudge that again passes
the think budget is stopped as stuck ("… even after a nudge"), whatever it did first: a command
that prints nothing for longer than the budget was otherwise nudged, killed and rerun forever.
Only in the session that was nudged (`runner.renudged`: status `nudged_round` the last round and a
session carried on): a round that starts fresh gets a nudge of its own, where it was stopped at its
first long think (#681). A nudge round is marked `rounds/<n>/nudged` (`runner.NUDGED`), which
`round_asks` skips (Claude's notes sent beside the nudge kept through `notes.md`): the nudge went
to every later fresh session in the step as "What you were asked to do", put down to Claude (#681).
A nudge round that itself starts fresh hands over every earlier ask, and the nudge under "Now":
`_start_fresh` drops the last of `round_asks` as the round's own only when the round gave one
(not nudged, or with Claude's notes), where it once dropped the feedback before the nudge (#859).

A note still pending when the runner exits (sent as the round stopped, or before a stuck stop)
is never delivered by it: the stuck report lists Claude's ("NOTE: not delivered…"), and the next
command marks them taken (`cli._stale_notes`), so none interrupts or adds a round to the next
runner (a stale `--now` note once cut a feedback round short). `wb resume` carries Claude's into
its prompt (a `NOTE_HEAD` note after the asks); `wb feedback` and `wb next` drop them and print
each ("not delivered, dropped …"), for Claude to fold into the feedback. The runner's own nudges
are dropped silently.

**Check-ins** (`checkin_text`), every `checkin` minutes of a round (not while asking): `task X ·
label · round n · running <time> · ~Xm left (typically Nm)` (the typical length and the time so
far both the step's active work, *Progress checks*), then since the last check-in: tools
used and failed, tokens read and written, `now:` the last action, the agent's latest words (400
characters), the files changed so far, and a NOTE naming changed files the spec never mentions
(`outside_spec`: a changed path or its basename that the step's prompt doesn't contain; silent
when the spec names none of them).

**Tests** (`run_tests`, through `run_in_lane`): `<shell> -c` in the worktree, inside the agent's
lane with the agent's environment (`agent_env`: the git shim, credentials dropped), its own process
group, timeout `test_timeout` (`wb start --test-timeout`, 900 s). While it runs it is the runner's
`CURRENT` process, so a stop takes its group down too. Its output is read as it comes
(`_Capture`), never waiting for the pipe's end (a server started with `setsid` may hold it open
for good): the run ends when the shell exits, past the timeout (exit `timeout`) or past
`TEST_OUTPUT_CAP` (20 MB, exit `output limit`), and then its group is killed and `sweep` runs.
Only its first `KEEP_HEAD` (64 KB) and last `KEEP_TAIL` (256 KB) are kept, with a `[... N bytes of
output cut ...]` line between, decoded. `status.tests` is `{ok, exit, tail, round}`, the tail
`clip_tail(output, 40)`: the last 40 lines, each cut to 300 characters, the whole to 4000 (one
multi-megabyte line once went whole into status.json and the notice). `rounds/<n>/tests.txt`
holds `$ cmd`, `exit: N`, `shell: <path>` and the kept output. The shell (`test_shell`) is the
agent's: OpenCode 2.3 runs each command as `$SHELL -c`, or bash's when SHELL is unset (checked
by hand against 2.3; a `$SHELL` that isn't a `-c` shell, `NOT_POSIX` (fish, nu, …), or isn't an
executable absolute path gives bash, else `/bin/sh`). It was `/bin/sh`, dash on Debian and
Ubuntu: `source .venv/bin/activate && pytest` passed for the agent and failed for the runner,
each false failure an auto-fix round (#196, the 2026-11-19 audit).

**Setting the worktree up** (`prepare`, `_prepare`, before the base check and the GPU; #201, the
2026-11-19 audit). A worktree holds only committed files, under the state directory: no
node_modules, .venv or target/, no ignored local file, and `../lib` is not the user's `../lib`. A
check that needed them failed on the base and in every round for that, not for the step. So
`prepare(task)` makes `task.worktree` the project as the user has it, in this order:
- a link where the worktree reaches it by the project's own path, for each of task.json
  `siblings` (`--sibling`): `lib` (or `../lib`) is `../lib` → the real `<repo's parent>/lib`,
  for Cargo's `path = "../lib"`, Go's `replace ../lib`, npm's `file:../lib`; `../../shared/lib`
  is two levels up (`context.sibling_parts`, `sibling_link`, `sibling_real`). Only `../<name>`
  was linked, so Cargo's `../../shared/lib`, a workspace two up and Go's `replace ../../x` broke
  (#261, the audit of 1.2). With one more than one level up the worktree nests deeper,
  `tasks/<task>/tree/<the names of the repo's own parents>/worktree` (`context.tree`; task.json
  `worktree`, which `Task.worktree` reads), so that every link lands in the task's directory and
  `../../apps/x` and `../x` from `apps/repo` are one place; the scratch checkouts (`wb verify`,
  the base check, `wb bench`'s) nest the same way. `wb start` refuses a path with `.` or `..`
  inside it, one above `/`, one whose link would be inside another's (it would be made through
  that link, in the real directory) or the worktree's, and one beside a flat worktree named as
  one of the task's files (`TASK_FILES`). The read lane holds each one (`context.siblings`, also
  in `external_rules`), the write lane doesn't.
- each of `copy` (`--copy`) from the user's checkout as it is now (`_copy`: `cp -a
  --reflink=auto`, macOS's `cp -cRp`, else a plain copy, replacing what is there, which is
  why `wb start` refuses a path with anything under it tracked at the base: #244), and only one
  ignored in the task's own worktree too, checked once the runner has made it (a directory as
  `dir/`): at a tag older than the ignore rule, the copy was a new file there and accept committed
  it (#322, the audit of 1.4; the task fails before any round, and `wb discard` removes it, #529). Nor a Python
  virtualenv (a `pyvenv.cfg` in the path or one level inside, `runner.venv_in`): its `activate`
  and its scripts' shebangs name the checkout, so a copied `.venv` ran the developer's
  environment and its writes left the lane (#260, the audit of 1.2); the refusal says to
  recreate it with `--setup` (`python3 -m venv .venv && .venv/bin/pip install -r …`, `uv sync`).
- `setup` (`--setup`), in the lane and the agent's shell, as the tests run (`run_in_lane`), for
  at most `setup_limit(spec)`: task.json `setup_timeout` (`--setup-timeout S`, else its repo's
  commands.json `setup_timeout`), else `SETUP_SECS` (1800 s). The same limit holds in every
  scratch checkout that runs it. A fixed 1800 s failed a big first build (a Rust workspace,
  torch over a slow link) before round 1, and starting again hit the same limit (#520).
  A venv it makes in the worktree (`.venv`, `venv`) is first on
  the agent's and the tests' PATH from then on (`context.own_venv`, *Its environment*).

Its output goes to `setup.txt` (as tests.txt, with the seconds it took). Done, status `prepared`
is set and it isn't run again, with `setup_secs`, and the task's `prepared.json` holds `paths`
(the worktree's ignored paths it left, `_ignored_paths`), `marks` and `bytes` (below;
`runner.prepared_record`, which reads status `prepared_paths`, `prepared_marks` and
`prepared_bytes` for a task prepared before the file): in status.json, an in-tree C build's one
entry per object file was megabytes, rewritten on every status write (#867). Status gets
`setup_secs`, which the first report shows (`setup: Ns, once`); failing, the task is `failed` before any round, with a `failed` notice holding the exit
and the output's tail ("the setup command failed (exit N)", "setting up the worktree failed
(copy failed)" for a link or copy, or "setting up the worktree failed (timed out after Ns; wb
start --setup-timeout SECS, or "setup_timeout" in the repo's commands.json "repos" entry, raises
it)": `setup_timed_out`, which a scratch checkout's output says too), and, when it failed on a connection, the proxy the agent's
environment left out (`runner.proxy_gap`, #380), and each path the lane refused with its grant,
as a test run's report names them ("the lane refused <path>: wb allow <task> --path <grant>, if
the setup needs it": `lane_refused`, `lane_grant`; a first `npm ci` refused a `~/.npm` not made
yet, and the notice named none, #824); it ends "fix it, then wb resume <task>: it sets
the worktree up again (the agent never ran)", and sets status `failed_before` `setup`. A load
failure before the agent ran (`runner._load_failed`, `results.ran` false) sets it `load` and its
notice adds "the agent never ran: once the model can, wb resume <task> starts it". Either way the
results row says `ran: false`, which the router and the tuning leave out (#581). Each scratch checkout (the base check, `wb verify`, `wb shot`:
`verify._run`) gets the same links beside it and a copy of the task's prepared paths from its
worktree (`prepare(at, prepared)`, as a reflink where the filesystem has them; `_copy_all`, one GNU
`cp -a --parents` per `COPY_BATCH` (500) paths, path by path where that fails or on macOS: one cp
per path forked tens of thousands of times for an in-tree build, #867). Before copying,
their size (prepared.json `bytes`, `store.dir_size` at setup, 10 s a path at most) must fit in
the free space with `CHECKOUT_SPARE` (2 GB) left, unless one small file clones there
(`runner._reflinks`: btrfs, XFS, APFS); else "copy failed", naming both sizes, how much to free
and where from (`_no_room_for`): wb start counts only the checkout, measured before any setup ran,
and a 12 GB `target/` copied on ext4 filled the disk and failed every open task's writes (#860).
It offers no `--setup`: a fresh setup in the scratch writes about as much, with no check, and the
line once sent Claude there (the review of #860). A file already present in the scratch checkout takes precedence. A missing prepared input or a changed parent link requires fresh setup: each input's parent must resolve to the same path under the two worktrees' resolved roots, so a link inside a worktree refuses the copy while a symlinked state directory (`WB_HOME` a link to another volume) doesn't (#345). The setup
isn't run there: each ran it from nothing, up to the setup limit, and a first build compiled three
to five times a task (#249, the audit of 1.2). `wb verify --setup` and `wb shot --setup` run it in
each checkout as before; so does a task prepared before the paths were recorded, and one whose
prepared paths hold a virtualenv (`venv_in`): its `activate` and scripts name the worktree it
was made in, so the copy ran the task's interpreter and code, and the base check and `wb verify`
failed where the task passed (#325, the audit of 1.4); and one whose prepared paths hold a build
tree configured for the worktree (`build_source`: CMake's `CMakeCache.txt` `CMAKE_HOME_DIRECTORY`,
Meson's `meson-info/meson-info.json`, in the path or one level inside): copied, its targets ran the
candidate's code on the base, and `wb verify` said the regression already passed there (#424, the
audit of 1.8); and one whose prepared paths the rounds rebuilt since the setup
(prepared.json `marks`, a fingerprint per path from lstat, `prepared_mark`: the count, size and each
file's name, size and mtime, leaving out what a test run rewrites, `PREP_CACHES` such as
`__pycache__`, `.pytest_cache`, `.vite`, `*.pyc`, and any directory holding `CACHEDIR.TAG`, as
cargo's `target/`, whose own staleness check makes a copy safe): the agent rebuilt a monorepo's
`packages/lib/dist` (or a C extension in place), the base got the candidate's build, its tests
imported it and passed, and `wb verify` said `base-passes` for a valid fix (#732, the 2026-11-21
audit); a task prepared before the marks were recorded copies as before. A scratch checkout whose copied build tree (from the worktree or `--copy`) was
configured for another checkout's tracked sources, the user's or the worktree's, with nothing to
make it afresh, is refused (`_foreign_builds`: "copy failed", "<path> is a build tree configured
for <dir>…", naming `--setup`); a dependency's build whose source is ignored is the same in every
checkout and passes. Failing there, the run's exit is `"setup failed"`. A checkout that isn't
the task's bytes, a file under one of the repo's own filters checked out otherwise than in the
worktree (`verify.filter_gap`) or a `required` filter's failure (`_filter_failed`), makes the
run's exit `"filtered"`, naming the file and `filter.<driver>`: no run on other bytes is evidence
(#932; *Checkout settings*).

**The base check** (`_base_check`, `base_check`, before round 1 and the GPU): the acceptance
command once on the untouched base, the same way but in a scratch checkout of the base
(`verify.on_base`: a `--shared` clone under the state directory, `gitops.scratch_clone`, in the
task's lane), at most
`min(BASE_CHECK_SECS (120 s), --test-timeout)`. It ran in the task's worktree, and what it wrote
there (a build stamp, a fixture, an updated snapshot) stayed for the agent, could make a later
test pass, and showed in the review diff (#192, the 2026-11-19 audit). The output goes to
`base-tests.txt` (as tests.txt, with its shell), the result to status `base_check` `{ok,
exit, tail (clip_tail: 8 lines, 1500 characters), limit, secs, cmd}` (`secs`: its scratch
checkout and run, not the waits for the GPU or its turn; `cmd`: the command it ran, #779), and `base_check_line` words it for the
report (*The round report*, below): a note when it already passes (the usual case when the agent
writes the step's tests: only those can fail it, so Claude checks the diff adds tests that fail
without the change), a warning when `--test-timeout` cut it short (every round's tests will time
out too), a note when it ran past 120 s (not checked; with a larger `--test-timeout`, that a round's run
may pass it too, #496), a note when setting the scratch checkout
up failed (not checked), one when its checkout isn't the task's bytes (exit `"filtered"`: not
checked, naming the filter, #932), else its exit and tail, for Claude to check it fails only for what the
step changes. The warning also raises a `checkin` at once, so Claude
can discard before round 1 lands. A passing base once did too, telling Claude to discard and start
again: that cost a whole restart in one task of two (the 2026-11-17 measurement), so it is a note.
`wb start --no-base-check` (task.json `no_base_check`) skips it.

**The round report** (`summary_text`), line by line:
1. `task X · label · round n · M.m min · local tokens IN in / OUT out` (this round; input
   excludes cache reads). Ahead of it in the review notice and `summary.md`, `auto-fix skipped:
   <cause>` when `not_the_code` kept the failure from the agent.
2. `agent context: U.UK of WK (P%)[, compacted Nx][; the next round starts a fresh session | ; the next round carries on in this session: …]` (#781).
3. `STOPPED: why` or `opencode exited N (see …/runner.log)`, when either; then, past the first
   step, `steps 1-N committed on delegate/<task> (wb next): wb discard <task> drops this step and
   keeps that branch; to land them instead, …` (`steps_line`: reset the worktree, `wb accept
   --force`; #494). The `SIGNAL_STOP` notice carries the same line. After a crash with the
   worktree changed, `opencode exited N: the round didn't finish; what it changed so far stays in
   the worktree (see …)`. `OpenCode resent N
   request(s) to the model's server: …` when it retried any (#491).

4. `tests: PASS|FAIL (`cmd`, exit N)`, the last 25 lines on a failure; `base check: …`
   (`base_check_line`) while the task is on its first step with no review round yet;
   `auto-fix rounds used: a/b`.
5. `tools: name×n …`, then up to four `tool error:` lines.
6. `agent's summary:` and the agent's last text (2500 characters).
7. `files changed:` (`git status --porcelain`), a NOTE for files outside the spec, a NOTE when the
   agent changed Claude's files (`claude_files_changed`: CLAUDE.md, CLAUDE.local.md, AGENTS.md,
   `.claude/`), a NOTE per filled submodule whose tracked files no longer match its commit (`NOTE:
   edits in submodule <path> can't land: …`, `gitops.submodule_edits`, #419) and one per filled
   submodule with new files it doesn't ignore (`NOTE: new files in submodule <path> won't be
   committed: …`, `gitops.submodule_check`, #889), and the diffstat's last
   line against the task's base.

**Speed** (`measure_speed`): after every round, the session export's messages created since the
round began give write speed and read speed samples (`router.record_speed`). A request cut short
(a nudge, a stop) still gives a read sample when it had its first token: on a slow machine the
first request is often the one interrupted. A round that ended before the model's first output
(nothing but OpenCode's own lines, `NOT_THE_MODEL`: `step_start`, `retry`, `error`,
`background_wait`) after `BOUND_MIN_S` (120 s) or more, stopped by the silence or round limit or
by OpenCode giving up (not a nudge or an interruption: a model thinking silently behind a server
that sent its headers at once would read as a slow reader), gives a bound instead (`read_bound`,
`router.record_read_bound`):
the prompt it was sent (the round's `prompt.md` and `instructions.md` and the layer's
instruction files at 4 characters a token, plus `OPENCODE_PROMPT_TOKENS`, 3000, for OpenCode's own
system prompt and tools) over the seconds it waited, the most it can have read per second, guessed
low so the budgets come out long. Without it a first request that never finished left no
`firstToken`, speed.json stayed empty, and the next task got the same 900 s (#491). No bound when
the model's server is down or stopped as the round ends (`_down`, `_stopped`), or when a retry
OpenCode logged was anything but a timeout (a refused connection, a 503 while loading): a server
that died before the first token read as ~12 tokens/s, and the model's later rounds and tasks
waited an hour of silence for the next crash (#862).

**Prompt text other code depends on.** Each prompt opens with a head that something else matches
by prefix; rewording one silently changes those:

| Text | Written by | Read by |
|---|---|---|
| `\n---\nHow to work` (`cli.PROTOCOL`) | `wb start`, `wb next` | `transcript` folds it away |
| `Lesson:` lines in the agent's summary | the protocol asks for them | `lessons` |
| `Review feedback from the senior reviewer` (`lessons.FEEDBACK_HEAD`) | `wb feedback` | `lessons` (feedback items), `round_asks` (stops there), `transcript` (label) |
| `The acceptance tests fail` | the auto-fix round | `transcript` |
| `Before Claude reviews this` (`SELF_REVIEW`) | the self-review round | `transcript` |
| `You are picking this task up in a fresh session` | `handoff_prompt` | `transcript`, the fake OpenCode (`fill`) |
| `Step N of this task is done and committed` | `wb next` | `transcript` |
| `INTERRUPT_HEAD`, `NOTE_HEAD` | `_steer_round` | `transcript` |
| `NUDGE` (`without a tool call. Stop planning`) | the think nudge | `transcript` (labelled the workbench's, not Claude's) |
| `Claude picked these skills`, `Claude handed you more skills`, `Claude took back:` | `skills_note` | `transcript.SKILLS_HEADS` (skips the note to label what follows) |
| `CARRY_ON`, `RESUME` (first 60 characters) | `_full_round`, `wb resume` | `round_asks` skips them (but their `notes.md`) |
| `agent's summary:` | `summary_text` | `lessons` |
| `--title "wb: <task>"` | `run_round` | `transcript.find_session` |

The skills note is prepended to the prompt argument; the transcript skips past it (to its first
blank line) before matching the label, so the prompt keeps its own.

## What the agent knows

An agent should start a task knowing what Claude would know in the same repo, and nothing that
would distract it. The per-task OpenCode config layer (`<state>/rules/<task>/opencode.json`,
written before every round by `runner.write_config_layer` from `context.layer`) gives it
`instructions`, `permissions`, `skills`, the `compaction` setting, the `ask_reviewer` server, and
the providers OpenCode wouldn't load by itself (`models.agent_providers`, *Found, loaded, chosen*).
For the task's provider it also sets `options.headerTimeout: false` and `options.chunkTimeout` at
the larger of 900 s and `--silence-timeout` + 60 s (`runner.provider_timeouts`, `PROVIDER_TIMEOUTS`):
OpenCode 2.3's 300 s wait for the headers cut every request a slow reader hadn't answered in 5
minutes (*The runner, inside*: a `retry` line); the runner's own silence and round limits decide
how long a round waits (#491, the audit of 1.90). OpenCode merges provider options, so the user's
entry keeps the rest, and their files stay as they are.
Everything in `rules/<task>/` (the config, the instruction copies, the git shim) lives outside the
agent's lane, so it can't rewrite its own rules for its next round.

**Instructions** (`context.instruction_files`), as absolute paths OpenCode loads into the system
prompt, in this order:
- the workbench handbook (`agent/HANDBOOK.md`), copied fresh into `rules/<task>/HANDBOOK.md`
  every round, so its path never points the agent at the workbench repo (a path there once led an
  agent to go looking for plans): unattended work, read before editing, imitate the codebase,
  smallest diff, never guess an API, never weaken a test, change approach after two failures,
  stay in the working directory, leave every git write and deploy to Claude, an honest final
  summary. Every agent prompt carries it, so it stays short (about 1.3K tokens);
- the user's `~/.claude/CLAUDE.md` (`$CLAUDE_CONFIG_DIR` moves it), as a copy in `rules/<task>/`,
  because the agent can't read Claude's directory;
- the user's personal rules, Claude's directory's `rules/**/*.md` (which Claude Code loads for
  every project; `user_rules`), copied to `rules/<task>/user-rules/<path>` each time the
  instructions are written, in path order, as the user's own (their imports followed as the
  user's CLAUDE.md's are); a dotted name or a link into a secret left out, the copy of a rule
  removed since deleted, and each counted in `fixed_prompt` as `~/.claude/rules/<path>`. Only
  `~/.claude/CLAUDE.md` was handed over, so Claude reviewed against rules the agent was never
  told (#673). The walk follows directory links (`_md_under`: each real directory once, so a
  loop ends, and no dotted name, a shared checkout's `.git`): `Path.rglob` follows none, and a
  rules directory shared with `ln -s ~/team-rules ~/.claude/rules/team`, as Claude Code
  documents, never reached the agent (#828, the second 2026-11-21 audit). A rule's `paths:`
  frontmatter isn't read: every rule loads;
- the repo's `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md`: the worktree's copy when
  it exists there (committed), else the user's checkout's (local or uncommitted), so an
  uncommitted edit to a committed file isn't seen;
- in a monorepo package (task.json `subdir`), the package's own three, the same way: `wb start
  --repo packages/app` (or any directory inside it: the nearest one up to, not including, the
  repo's top with a committed `CLAUDE.md` or `.claude/CLAUDE.md`, or one in the checkout that
  git ignores (`cli._local_package_md`, as `_local_claude_md` at the root: `wb start` notes
  `<package>'s CLAUDE.md is gitignored: the agent gets your checkout's copy`, and accept's
  reminder says it is gitignored; only committed ones counted, so the task ran at the root
  without the package's instructions, #785), as Claude Code finds it, `cli._package`; a `.claude` directory is never one, its CLAUDE.md being its parent's; from `packages/app/src` the repo was refused, or the task ran at the root,
  #606), passes the CLAUDE.md check on it, and the agent, the setup, the tests (the
  base check's and `wb verify`'s too) and the session export run there (`Task.workdir`); the diff
  and the commits stay the whole repo's, and a plain subdirectory still means the repo's top.
  From packages/app the repo was refused for its root, and with `--no-claude-md` the agent ran
  `npm test` at the workspace root (#375, the audit of 1.6). With no CLAUDE.md found, the
  refusal says a package with its own takes `--repo <the package's directory>`. OpenCode 2.3, started there, loads
  the root's and the package's AGENTS.md (both count for the duplicate check below);
- the tracked `.claude/rules/**/*.md` from the worktree (`project_rules`), and the `.md` files
  under a tracked link to a directory there (`_md_under`): one whose real path is outside the
  worktree and the repo, through a file or a directory link (`.claude/rules/shared ->
  ~/company-standards`), is copied to `rules/<task>/project-rules/<path>`, which the lane reads,
  unless it is a secret or workbench's own, its imports reaching what a project's do, the copy
  of one gone since deleted, and counted in `fixed_prompt` as `.claude/rules/<path>`: loaded by
  its worktree path the lane refused it, and a directory link's files weren't listed at all
  (#828);
- `context.md` in the task directory: a map of nested `CLAUDE.md`/`AGENTS.md` files in
  subdirectories (tracked, not under `.claude/`), "Before you change files under one of these
  directories, read its file and follow it", instead of loading them all.

Each of these but the handbook is followed by what it `@` imports (`import_files`, depth first,
as Claude Code loads them): OpenCode 2.3 reads an instruction file as a raw string, so a CLAUDE.md
of `See @README.md` and `@docs/testing.md` reached the agent as those lines, and a user's
`@~/.claude/rules/python.md` was unreadable in the lane besides (#513, the audit of 1.90). As in
Claude Code (`imports_in`, `IMPORT`): an `@` at a line's start or after a space, then the path to
the next unescaped space (`\ ` is one), less a `#` fragment; relative to the importing file's real
directory, `~` expanded, at most `IMPORT_HOPS` (5) deep, each file once; not in a code span, a
fenced block (`FENCE`) or an HTML comment; a missing or non-text target (`_text_file`: a NUL, or
not UTF-8) is ignored. A target in the worktree or the repo is loaded from the worktree (the
repo's when only it has the file); one elsewhere is copied to `rules/<task>/imports/<n>/<name>`,
which the lane reads, replaced whole each round (OpenCode may be reading the last copy). Claude
Code asks before a project's file imports from outside the project; wb can't ask, so a project's
imports (and theirs) reach only the repo and the Markdown in Claude's directory with no dot-named
part (never `.credentials.json`), and the user's own CLAUDE.md's reach anywhere but a secret or
workbench's own files (`secret_paths`, `private_paths`). `fixed_prompt` counts each import as a
part of its own. Not covered: an indented code block (read as text).

OpenCode reads `AGENTS.md` itself but never `CLAUDE.md`. Files are deduplicated by content
(SHA-256), seeded with the worktree's `AGENTS.md`, so a `CLAUDE.md` identical
to `AGENTS.md` (or to an earlier file) isn't loaded twice.

**Denied tools** (`DENIED_TOOLS`), which also leave the prompt (it shrinks from about 9K to 3.5K
tokens, which a local model reads on every request): `question` (nobody answers it headless),
code mode (`execute`) and the `opencode_*` tools (they can move the session or remove worktrees;
denying `execute` turns the `opencode_*` tools into direct tools, so they are denied too), `subagent`
(a second agent inside the task, beside the GPU accounting), `*worktree*`, web search, web fetch and
image generation.

**Commands, an allowlist** (`context.shell_rules`). OpenCode's `shell` permission rules are
checked against each simple command of a line (pipes, `&&`, loops, `$(…)`), its raw text as the
resource. OpenCode anchors each pattern, lets `*` match anything (spaces and `/` too) and `?` any
one character (a space too), treats a trailing ` *` as optional (`npm install *` also matches `npm install`), and the last matching rule
wins; no match means ask, which `--auto` allows. The rules, in order:
1. deny `*`;
2. allow `c *` (a bare `c` too) and `*=* c *` (`ASSIGN`: a variable set before it,
   `PYTHONPATH=. pytest`) for each of `ALLOWED_COMMANDS` (about 320: the shell's builtins and
   everyday tools, files and text, archivers, builds and compilers, test runners, interpreters,
   package managers, `bash`/`sh`, `sqlite3`, `git` (the shim), and since #514 (the audit of 1.90)
   the toolchains the lane makes room for and the common runners and linters: `python3.*`,
   `pip3.*`, `pypy3`, `pdm`, `pipenv`, `hatch`, `nox`, `pixi`, `conda`, `mamba`, `micromamba`,
   `pre-commit`, `pyright`, `flutter`, `dart`, `bazel`, `bazelisk`, `just`, `task`, `pio`,
   `platformio`, `conan`, `xcodebuild`, `xcrun`, `rubocop`, `golangci-lint`, `shellcheck`; and
   since #672 (each first use cost a question and a wake) more ecosystems' drivers, `dune`, `opam
   exec`, `lein`, `clojure`, `clj`, `rebar3`, `nimble`, `shards`, `gleam`, `elm`, `mill`,
   `scala-cli`, `pod`, `ant`, `crystal`, `nim`, `erlc`, `escript`, and the builtins `pushd`,
   `popd`, `printenv`, `:`, `ulimit`, `local`, `declare`, `shift`, `trap`, with `pgrep`; and
   since #830 (the second 2026-11-21 audit) macOS's `shasum`, `md5`, `sysctl`, `sw_vers`, the
   wrappers `stdbuf` and `setsid`, `pkill`, `killall`, `expr`, `bc`, `truncate`, `dd`, `shuf`,
   `cksum`, `sha512sum`, `flock`, native builds' `ldd`, `readelf`, `addr2line`, `size`, `gcov`,
   `ccache`, `sccache`, `gfortran`, `nvcc`, `mpirun` and versioned compilers (`gcc-*`, `g++-*`,
   `clang-*`, `clang++-*`, written like `python3.*`), and `scons`, `protoc`, `ocaml`, `iex`,
   `ghci`, `runghc`, `irb`, `gem` (`gem install *` still asks), `luarocks` (`luarocks install
   *` asks), `busted`, `lua5.*`, `cython`, `maturin`, `virtualenv`, `sphinx-build`, `mkdocs`,
   `terraform`, `corepack`);
   not on it: `nix` (its builds go through the daemon's socket, outside the lane), `curl`, `wget`, `ssh`,
   `rsync`, `docker`, `systemctl`, `opencode`. OpenCode matches each simple command's raw text,
   so `FOO=1 ls` was refused while `ls` and `env FOO=1 ls` ran, and a small model copying the
   project's own `CI=1 npm test` spent a Claude wake asking or stopped running the tests (#258, the
   audit of 1.2). `*` matches spaces, so the prefix form also passes a line with an `=` anywhere
   before an allowed command's name: no more than `env *` already runs. Steps 4 to 6 get the
   prefix form too (step 8 no longer does: #442);
3. allow `./*`, `../*`, and `<dir>/*` for every directory of the lane but those under `/dev` and `/proc` (a program the agent built
   runs by its path anywhere it can write: a debug binary in the temp directory was refused
   though `bash` could run it);
4. allow `PROJECT_BINS` (and `./*`, `../*`, each also behind `*=*`), what a project builds or
   installs for itself, by its path:
   `.venv/bin/*`, `venv/bin/*`, `node_modules/.bin/*`, `build/*`, `target/debug/*`,
   `target/release/*`, `bin/*`, `out/*`, `dist/*`, `zig-out/bin/*`, `vendor/bin/*` (Composer's),
   `scripts/*`, `tools/*`; then the tools of the acceptance command `wb start|next --test`
   names (`grants.json` `test_tools`, from `context.test_allowances`: each of its simple commands
   with more arguments, `npm test *`, and its tool, `<tool> *` and `*=* <tool> *`), so the agent
   can run the tool's other work (`npm run lint` under `npm test`, `earthly +lint` under
   `earthly +test`) but steps 5 and 6 still hold: granted in step 7, `--test 'npm test'` allowed
   `npm install left-pad`, `--test 'uv run pytest'` `uv add requests`, `--test 'npx vitest run'`
   `npx -y cowsay` (#646, the audit of main), and `--test 'npm install && npm test'`
   `npm install left-pad` through `npm install *`, `--test 'pip install -e . && pytest'`
   `pip install -e . requests` (#915, the third 2026-11-21 audit);
5. deny `ASK_FIRST`: adding a dependency (`pip install *`, `npm install *`, `npm add *`,
   `pnpm i *`, `yarn global add *`, `bun i *`, `deno add *`, `deno install *`, `cargo add *`,
   `go get *`, `dotnet add * package *`, `python3.* -m pip install *`, `pdm add *`,
   `pipenv install *`, `pixi add *`, `conda install *`, `flutter pub add *`, `dart pub add *`,
   `pio pkg install *`, `conan install *--requires*`, `opam install *`, `nimble install *`
   (`nimble install -d` and `--depsOnly` allowed again), `gleam add *`, `elm install *`,
   `clojure -Ttools *`, `clj -Ttools *`, `luarocks install *`, …) and fetching a package to run it (`npx -y *`,
   `npx --yes *`, `npm exec *`, `npm x *`, `npx -p *`, `npx --package *`, `pnpm dlx *`,
   `yarn dlx *`, `bunx *`, `bun x *`, `uvx *`, `uv tool run *`, `uv tool install *`,
   `uv run --with *`, `deno run *npm:*`, `deno run *jsr:*`). A plain `npx <pkg>` stays allowed
   (`npx tsc`), but OpenCode runs with `npm_config_yes=false` (`runner.OPENCODE_ENV`), so it runs
   only what the project installed instead of fetching one (npm says yes by itself without a
   terminal); `npx --yes <pkg>` is the form to ask for;
6. allow `INSTALL_LISTED`, installing what the project already lists, because with the optional
   trailing ` *` the rules above also refuse the bare forms: `npm install`, `npm i`, `npm ci`,
   `pnpm install`, `pnpm i`, `bun install`, `bun i`, `yarn`, `yarn install`, `pip install -r *`,
   `pip install -e .` (and `pip3`, `pip3.*`, `python -m pip`, `python3 -m pip`,
   `python3.* -m pip`, `uv pip` forms), `pipenv install`, `pipenv install --dev`, `pipenv sync`,
   `pio pkg install`, `platformio pkg install`, `nimble install -d`, `nimble install
   --depsOnly`; the npm, pnpm and bun ones with one of
   `INSTALL_FLAGS` (`--frozen-lockfile`, `--immutable`, `--prefer-offline`, `--offline`,
   `--legacy-peer-deps`, `--no-audit`, `--ignore-scripts`, `--prod`, `--production`,
   `--no-fund`), or with one of `INSTALL_FLAG_PAIRS`, the common CI lines with two, by the
   managers that spell them (`npm install`, `npm i`: `--no-audit --no-fund`, `--prefer-offline
   --no-audit` and each reversed; `pnpm install`, `bun install`: `--frozen-lockfile` with
   `--prefer-offline` either side, `--ignore-scripts` or `--production`; #916, the third
   2026-11-21 audit: `pnpm install --frozen-lockfile --prefer-offline` and `npm install
   --no-fund` asked; a short list, as every ordered pair with its `*=*` copy would take the rules
   past `CONFIG_CONTENT_MAX`, whose fallback drops AGENTS.md and the project's skills, and no flag
   with `=*`, whose `*` would pass a package name), and the
   pip ones as `-e .[*]`, `-e ".[*]"`, `-e '.[*]'`, the project's own extras (#671: refused, an
   agent copying the project's `pnpm install --frozen-lockfile` spent a question; other flag
   combinations still ask, and `*` would also pass a second requirement with extras after it). The pip
   forms only where pip installs into the worktree's own venv, or with no Python environment
   active (the user's checkout's are left out: *Its environment*, below) while Landlock bounds
   what pip writes (`context.python_installs`); otherwise they ask first, since pip would write
   the user's own conda env or tools venv, or their Python with no lane. While a venv of the
   user's stays active in the agent's shell (one that isn't the checkout's), `ENV_INSTALLS`
   (`poetry install *`, `poetry sync *`, `poetry remove *`, `uv sync --active *`, `uv pip sync
   *`, the `pip uninstall` forms), which change the active venv, ask first too (#490, the audit
   of 1.90: the agent's `pip install -e .` repointed the user's venv at the worktree, which
   accept or discard then deleted);

7. allow the user's standing patterns (`commands.json` `allow`) and the task's grants
   (`rules/<task>/grants.json` `allow`: `wb allow`, `wb start|next --allow`, and the acceptance
   command `wb start|next --test` names: `context.test_allowances`, each of its simple commands
   as written, `npm test`, so the agent can run what the protocol tells it to (#514), even a
   command steps 5 and 6 would refuse; the command with more arguments and its tools are step
   4's, #915); a `*` there lifts everything above;
8. deny the hard limits (`context.denied_shell()`): `DENIED_SHELL`, built from `_HARD` (`sudo`,
   `doas`, `pkexec`, `su`, `gh`), and the real git by its path (each `git` on the runner's PATH
   but the shim, its real path, and `GIT_PATHS`: `/usr/bin/git`, `/bin/git`,
   `/usr/local/bin/git`, `/opt/homebrew/bin/git`), each as `c *` (which matches a bare `c` too:
   one rule each, as the rules travel in one environment string, `runner.CONFIG_CONTENT_MAX`), and
   each again behind the `_WRAPPERS`, a wrapper's own option shapes: `env`, `env -i`, `env --`;
   `xargs` bare, `-0`, `-r`, `-0r`, `-r0`, `--null`, `--no-run-if-empty`, `-??`, `-???`, `-? ?`,
   `-I {}`, `-I{}`; `nohup`, `nohup --`; `nice` bare, `-?`, `-??`, `-???`, `-n ?`, `-n ??`,
   `-n ???`; `time`, `time -p`, `time --`; `command`, `command -p`, `command --`; `exec`;
   `timeout ?`, `timeout ??`, `timeout ???`; `stdbuf -??` once to three times; `setsid`. So
   `env gh …`, `time -p sudo …`, `timeout 5 sudo …`, `nice -n 10 sudo …`, `xargs -n 1 gh …` are
   refused. Never a `*` before the hard word: `*` matches spaces, so the earlier `env *`,
   `xargs *`, `nice *`, `timeout *`, `stdbuf *` and `*=*` forms refused `env CI=1 rg gh src`,
   `xargs grep -l gh`, `timeout 300 pytest -k gh` and `pytest --tb=short -k gh`, and being last,
   no `wb allow` nor `"allow": ["*"]` could lift them (#442, the audit of 1.8). Each shape starts
   with the wrapper's word or a `-` and spans at most three characters with `?` (a count, a
   duration, a niceness, a buffering mode), so it can't reach over a command's name; a longer
   value (`timeout 3600 sudo`, `timeout -s KILL 5 sudo`) and a variable set before the command
   (`FOO=1 sudo`, `env CI=1 gh`), whose value no pattern can bound, pass the patterns like
   `bash -c` does, and the kernel stands behind them (below).
   Not `*/git`, which also refused `go test ./internal/git` whatever Claude allowed, and not
   `time *`, which would refuse `time pytest -k gh` (the 2026-11-16 audit).

A refused command comes back to the agent as "Permission denied"; the handbook and the
`ask_reviewer` tool tell it to ask with `command` set, which raises a PERMISSION question naming
the `wb allow` that grants it. These patterns are a guardrail on the agent's own choices, not a
sandbox: they match the command as written, so `bash -c '…'`, make or any interpreter can still
run something the list refuses. What must hold is held below the patterns, on Linux with Landlock:
no sudo (the lane sets no-new-privileges, on any Linux), git read-only (the shim, and the repo's git
directory is outside the lane), no push or `gh` with the user's keys (credentials are unreadable and
dropped from the environment, so gh finds no login). Without Landlock (macOS, old kernels, other
architectures) only the patterns, the git shim and the dropped environment (`SECRET_ENV`) remain,
so `bash -c` can still write the repo's `.git` and read `~/.ssh`; on macOS nothing refuses sudo.

**Paths, a lane** (`context.writable`, `context.readable`, `context.external_rules`, `lane.py`).
The lane keeps an agent's mistakes and its use of the user's credentials in; it is not a jail for a
deliberately hostile process (the 2026-11-16 audit's list of what it can't stop is below).
- *Writes.* The lane is the task's worktree and its `ask/` directory (where the ask server writes
  its questions), not the rest of the task directory: `task.json`, `status.json`, `steer.jsonl`,
  the rounds and `runner.log` steer the runner and wb outside the lane, so an agent that could
  write them could lift its own guards, and the runner would write through a link it planted
  there (the 2026-11-16 audit). Then the temp directories (`gettempdir()`, `TEMP_ROOTS`: `/tmp`, `/var/tmp`), the device nodes builds
  use (`DEV_NODES`: `/dev/null`, `/dev/zero`, `/dev/full`, `/dev/random`, `/dev/urandom`,
  `/dev/tty`, `/dev/ptmx`, `/dev/shm`; not the rest of `/dev`, the user's terminals and input
  devices, and not `/dev/pts`: a task that needs it or a GPU asks; `/dev/ptmx` alone opens no
  pty, since Landlock checks the `/dev/pts/N` it hands out ("out of pty devices"), and is kept
  so that a `/dev/pts` grant is all a pty-driven test needs, which the skill and the handbook
  say, and the report too: `lane_grant` gives `/dev/pts` for anything under it, and a test
  output line matching `PTY_REFUSED` ("out of pty devices", "failed to create pseudo-terminal",
  "forkpty(3) failed"), which names no path, counts as a refusal of `/dev/pts`: the report said
  `--path /dev/pts/7`, an index the next run didn't get, or nothing, #829), with `--unload-for-tests` the GPU's nodes that exist (`GPU_NODES` through `gpu_nodes`:
  `/dev/dri/renderD*`, `/dev/kfd`, `/dev/nvidia[0-9]*`, `/dev/nvidiactl`, `/dev/nvidia-uvm`,
  `/dev/nvidia-uvm-tools`, `/dev/dxg`; without them CUDA, ROCm and Vulkan found no device and
  said nothing of permission, #331, the audit of 1.4; any other node a failed test run names
  with "Permission denied" or "Operation not permitted" (`REFUSAL`; and since #832 Bundler's
  "error while trying to write to" and RubyGems' "write permissions for", which say neither)
  outside the lane, `/dev/kvm` say, goes in
  status `tests.lane` and the report names `wb allow <task> --path <node>` for it:
  `runner.lane_refused`; since #437, the audit of 1.8, any absolute path on a refusal's line
  (`refused_paths`: a quoted one, `QUOTED_PATH`, or one running up to the refusal itself,
  `MARKED_PATH`, spaces and all but not across ` /`, then `ABS_PATH`'s outside those: cut at a
  space, `/mnt/c/Users/John Smith/…` granted the whole Users folder, #670),
  matched in any case, that lies outside the lane and that a grant can reach (`lane_grant`: the
  path when it exists or is under `/dev`, else its nearest existing directory; the toolchain home
  it falls in when that isn't made yet, or the one below it (`context.tool_home_of`: `TOOL_HOMES`
  and the `TOOL_HOME_VARS` targets, `tool_var_homes`; `~/go` gives `~/go/pkg`), which
  `wb allow --path` then makes: on a machine that never ran npm or Go the walk reached the home
  directory and nothing was named, #824, the second 2026-11-21 audit; else the RubyGems home
  it is in, whole (`context.gem_home_of`: `GEM_HOME`, or the nearest directory up with both
  `gems/` and `specifications/`, an rbenv, rvm, asdf or mise Ruby's: `bundle install` writes its
  `cache/`, `gems/`, `specifications/` and `extensions/`, and a grant of the one Bundler named
  was refused at the next, #832; the skill says to run the install in the user's checkout
  rather than grant it, as its gems run later outside the lane); then, while that place
  holds something the lane is split around (`context.split_points`: the secrets, workbench's
  own files, the user's active Python environments, #825, and `NOT_WRITABLE`'s places, made or
  not: `not_writable`), the next directory down
  towards the path, so a grant is never split again and never holds `~/.cargo/bin`; never `/`,
  the home directory, a secret, or the task's repo), so a refused keystore, lockfile or cache is
  named too, not a URL's path; and only a refusal the lane made, #773: none without Landlock
  (`lane.abi()` 0, macOS), nor a path the runner, outside the lane, may not read or write either
  (`runner_may`: the nearest existing directory for one not made yet), the user's own
  permissions, which go back to the agent like any failure), `/proc`, the build caches and
  toolchain homes under `$HOME` (`TOOL_HOMES`: `.cache`, `.cargo`, `.rustup`, `go/pkg`, `.npm`,
  `.bun/install/cache`, `.yarn`, `.pnpm-store`, `.local/share/pnpm/store`,
  `.gradle`, `.m2`, `.nuget`, `.dotnet`, `.gem`, `.julia`, `.cabal`, `.stack`, `.ghcup`,
  `.platformio`, `.conan2`, `.hex`, `.mix`, `.sbt`, `.ivy2`, `.pub-cache`, `.konan`,
  `.local/share/hatch`, `.local/share/virtualenvs`, and since #437 `.local/share/NuGet`, NuGet's
  http and plugins caches, `.local/state/cabal`, Cabal 3.10's store without `~/.cabal`, and
  `.android`, the debug keystore, split around `adbkey`; since #911, the third 2026-11-21 audit,
  `.nimble`, `.elm` and `.gitlibs`, the homes of nimble, elm and Clojure's git deps, which #672
  allowed but whose installs and builds the lane refused; the `.local/share/` and `.local/state/`
  entries under `$XDG_DATA_HOME` and `$XDG_STATE_HOME` instead when those are set, `tool_homes`,
  as `secret_paths` follows them), Flutter's `bin/cache` for
  `$FLUTTER_ROOT` and each `flutter` on PATH (`flutter_caches`: every flutter command opens
  `bin/cache/lockfile` for writing; kept whole, like `.dotnet`, though the Dart SDK the user's
  flutter runs lives there) and wherever the environment moved them
  (`TOOL_HOME_VARS`, each that is set: `CARGO_HOME`, `RUSTUP_HOME`, `GOPATH`'s first entry,
  `GOMODCACHE`, `GOCACHE`, `npm_config_cache`, `PIP_CACHE_DIR`, `UV_CACHE_DIR`,
  `GRADLE_USER_HOME`, `BUN_INSTALL`, `DENO_DIR`, `MIX_HOME`, `HEX_HOME`, `PUB_CACHE`,
  `KONAN_DATA_DIR`, `HATCH_DATA_DIR`, `WORKON_HOME`, `CARGO_TARGET_DIR`, `NPM_CONFIG_CACHE`,
  `NUGET_PACKAGES`, and since #911 `CCACHE_DIR`, `SCCACHE_DIR`, `YARN_CACHE_FOLDER`,
  `PRE_COMMIT_HOME`, `STACK_ROOT`, `CABAL_DIR`, `JULIA_DEPOT_PATH` (every entry, `ALL_ENTRIES`),
  `CONAN_HOME`, `PLATFORMIO_CORE_DIR`, `HF_HOME` (which `ENV_KEEP` passes to the agent),
  `TORCH_HOME`, `ELM_HOME` and `NIMBLE_DIR`, each only when absolute; of `GOPATH` and
  `BUN_INSTALL` only their caches, `VAR_CACHES`: `pkg`, `install/cache`), OpenCode's own data (`.local/share/opencode`,
  `.local/state/opencode`, and `opencode` under `$XDG_DATA_HOME` and `$XDG_STATE_HOME` when set),
  `$XDG_CACHE_HOME`, and the extra paths (`commands.json` `paths`, the task's grants `paths`), each with its real path
  too, keeping only those that exist. OpenCode's data, state, cache and config directories
  (`opencode` under each XDG directory, or its default under the home) are made first, so a
  first task in a fresh profile can open OpenCode's log (#340); one that can't be made is named
  in `runner.log`. Left out, where a planted file runs later outside the
  lane: what's on the user's PATH or sourced by their shell, and the toolchains those run.
  `~/.local/lib` (user site-packages, whose `.pth` files every python runs) is out; `go`, `.bun`,
  `.deno` and pnpm's home give only their caches; `.local/share/uv` is out (`uv tool` programs and
  the Pythons every uv venv links to; uv's cache is `~/.cache/uv`, the 0.90 review), so a Python
  uv must download first, like `uv tool install`, asks; and `NOT_WRITABLE` (`.cargo/bin`,
  `.cargo/env`, `.dotnet/tools`, `.cabal/bin`, `.ghcup/bin`, `.rustup/toolchains`,
  `.nimble/bin`, and `VAR_NOT_WRITABLE`: `$CARGO_HOME`'s `bin` and `env`, `$RUSTUP_HOME`'s
  `toolchains`, `$NIMBLE_DIR`'s and `$CABAL_DIR`'s `bin`; all made or not: `not_writable_paths`)
  are left out of their homes;
  so are the user's active Python environments (`context.python_envs`: `VIRTUAL_ENV`,
  `CONDA_PREFIX`, each PATH `bin` beside a `pyvenv.cfg` or `conda-meta`), which poetry's,
  pipenv's and virtualenvwrapper's homes put inside the lane (#490). Landlock only allows, so a
  home split around one is granted its existing entries alone and refuses every new one: with a
  poetry venv active, uv's, Go's and pre-commit's first cache in `~/.cache` and a setup's
  `poetry install` were refused (#825, the second 2026-11-21 audit). So a cache home holding an
  active environment gets `CACHE_MADE` (`uv`, `pip`, `go-build`, `pre-commit`) made first, the
  agent's poetry and pipenv make their venv in the worktree (`POETRY_VIRTUALENVS_IN_PROJECT=true`,
  `PIPENV_VENV_IN_PROJECT=1`, in its environment unless the user set them: the `.venv` that
  `own_venv` puts first on PATH, ignored by its own `.gitignore`), and `lane_grant` names the
  directory below a split one (above);
  `cargo install`, `rustup toolchain install` (or a `rust-toolchain.toml` naming one not
  installed yet), a pip install into the user's active environment and the like are Claude's to
  do: no grant reaches them (`wb allow --path` refuses one, `context.kept_out`, #912). A rustup home gets `toolchains/` made first,
  and a nimble home its `bin/` (`MADE_FIRST`), so the split keeps it out even before the tool
  made it. What stays in the lane is a documented
  trade, like `/tmp`, for letting builds and package managers work without asking: a home kept
  whole can hold a program the user's own tools run later outside the lane: `.dotnet` (the
  `dotnet` host and SDKs when installed there), `.ghcup`'s toolchains, `.julia` (juliaup),
  `~/.cache` (pre-commit's hook repos, which the user's `git commit` runs; poetry's virtualenvs;
  corepack's package managers), `.local/share/virtualenvs` (pipenv), cargo's registry sources
  (built into the user's next build), `~/.m2` and the like. Splitting them would refuse the first
  new entry a build makes there. A place holding one of those, an existing secret or workbench's own files
  (`private_paths`, below) is split: its other
  entries are granted one by one (Landlock only allows), so a new top-level file there is refused.
  So before the split, a cargo home (`~/.cargo`, `$CARGO_HOME`) holding `bin` or `env` gets what
  cargo makes at its top made for it (`CARGO_MADE`: `registry/`, `git/`, `.package-cache`,
  `.package-cache-mutate`, `.global-cache`): the 0.90 review found a fresh rustup install
  refusing every build with a dependency, and any git dependency where `git/` didn't exist yet.
  A nimble home (`~/.nimble`, `$NIMBLE_DIR`), split around its `bin/` whenever it exists, gets
  `NIMBLE_MADE` the same way (`pkgs2/`, `pkgcache/`, `buildtemp/`, `packages_temp.json`, which
  every `nimble refresh` writes before copying it over `packages_official.json`, and
  `nimbledata2.json` holding nimble's own empty data, `MADE_TEXT`: nimble parses the file it
  finds, so an empty one would fail every command; `_make_first` never replaces an entry):
  #911's review found an empty home granting nothing, refusing the first install, every
  package build and every refresh. A package list can't be made ahead (an empty one reads as a
  broken list), so in a home without one the first `nimble refresh` is Claude's to run.
  No entry may resolve to `/` or the home directory, nor contain the task's repo or its git
  directory (`repo_dirs`, the main worktree's for a removed linked one, #776: with `GOPATH=~/src` or the repo in `~/go/src`, the agent could write a
  hook or `core.fsmonitor` that wb's own git runs outside the lane): a place holding them is split
  around them like a secret holder (a grant of `~/work` beside the repo `~/work/api` grants
  `~/work/web`; until the 0.90 review it was dropped whole while `wb allow` said it was granted),
  and one naming the repo or a place inside it grants nothing (`wb allow --path` and `wb start
  --allow-path` refuse it: the 0.90 review); the temp directories are
  kept whole even so (a repo kept in `/tmp` stays in reach: splitting `/tmp` would refuse every
  new file there). `$XDG_RUNTIME_DIR` isn't in the lane (the user's bus, SSH and GPG agent
  sockets and runtime systemd units live there): the agent gets its own (`runtime_dir`,
  `/tmp/wb-run-<uid>-<hash>`, 0700, short for socket paths). The temp directories are a
  documented trade-off: Java's temp files, Xvfb's `/tmp/.X11-unix` and many test suites write
  there directly, so other programs' files in `/tmp` stay writable; the review diff's scratch
  index lives in `$WB_HOME`, not there. A `$WB_HOME` in `/tmp` (the tests') is in the lane whole.
- *Reads.* Everything is readable except where credentials and the user's own records live:
  `context.SECRETS` under `$HOME` (`.ssh`, `.gnupg`, `.password-store`, `.netrc`,
  `.git-credentials`, `.config/git/credentials`, `.gcm`, `.config/gh`, keyrings, `.aws`, `.azure`,
  `.config/gcloud`, `.kube`, `.docker`, `.android/adbkey` (adb's key to the user's devices),
  `.pypirc`, `.pgpass`, `.my.cnf`, `.vault-token`, cargo and
  gem credentials, OpenCode's service password (`.config/opencode/service.json`,
  `.local/state/opencode/service.json`: its background service runs outside the lane), password
  managers, cloud CLIs, browser and mail profiles (Flatpak's `.var/app` too), shell history,
  `.claude`, `.claude.json` and its backups, and the like), the same under `$XDG_CONFIG_HOME`,
  `$XDG_DATA_HOME` and `$XDG_STATE_HOME`, wherever `SECRET_VARS` moved them (`GNUPGHOME`,
  `PASSWORD_STORE_DIR`, `GH_CONFIG_DIR`, `DOCKER_CONFIG`, `KUBECONFIG`, `AWS_SHARED_CREDENTIALS_FILE`,
  `AWS_CONFIG_FILE`, `CLOUDSDK_CONFIG`, `AZURE_CONFIG_DIR`, `HISTFILE`, `$CARGO_HOME`'s
  credentials) and Claude's directory (`secret_paths`); and workbench's own files
  (`private_paths`): `$WB_HOME` (notify.jsonl, the chat log, the rules, other tasks) and its
  config (`~/.config/workbench` and wherever `WB_COMMANDS`, `WB_CHAT_TOKEN`, `WB_CHAT_CONFIG`,
  `WB_MODELS`, `WB_IMAGES`, `WB_AUDIO` moved its files): the audit read the chat token from a lane, which
  would let an agent post to Claude as the user. Of `$WB_HOME`, the task's own directory and
  `rules/<task>/` stay readable (its prompts and spec; its OpenCode config, instructions and git
  shim), and so does the task's repo with its git directory when it lies there (`repo_dirs`): a
  bench replay's is a clone in `bench/runs/<run>/<task>/repo`, and with it hidden the agent's git
  failed in every replay, "gitfile does not point to a valid repository" (#858). Left readable on purpose: `.npmrc` and
  `.yarnrc.yml` (the package managers read them to install) and OpenCode's `auth.json` and
  session database in `.local/share/opencode` (OpenCode runs in the lane and needs them: keep
  cloud keys out of it). Of the home directory's own entries only the dotfiles and
  `HOME_READABLE` (`bin`, `go`, `R`, `perl5`) are readable, and of `ONLY_KEPT` (`/dev`, `/mnt`,
  the Windows drives on WSL2, `/media`, `/run/media`, `/run/user`, `/home`, the other users'
  homes) nothing; beyond those, OpenCode's global directory where `OPENCODE_CONFIG_DIR` moved
  it (the agent's OpenCode loads it itself: #370, the audit of 1.6), the task's repo (its secrets left out even when it holds some: a
  repo at `~/.config`), its `siblings` (read-only: *Setting the worktree up*) and its git common directory (`repo_dirs`: outside the repo when it is a
  linked worktree, where git failed in the lane before the 0.90 review; read-only), workbench itself (even inside Claude's directory, the marketplace
  install), the lane, and the programs the agent runs (`tool_roots`: each PATH directory, the
  prefix of one under the home (its parent when it is a `bin` or conda's `condabin`, so
  `~/miniconda3` or `~/flutter`)
  or under an `ONLY_KEPT` root short of a user's home or a whole drive (Linuxbrew's
  `/home/linuxbrew/.linuxbrew`; not `/home/<x>`, `/mnt/<drive>`, `/mnt/c/Users/<x>` or
  `/media/<user>/<drive>`, which give the PATH directory alone: the 0.90 review found Linuxbrew's
  `../Cellar` hidden), the install a link in the home's PATH directories or in a `bin` one points
  into (only those are listed, each directory once: an lstat per entry, and the 0.90 review found
  every PATH directory under an `ONLY_KEPT` root listed on each lane drawn, WSL2's System32
  among them), the Python running workbench, and conda's and mamba's installs by their
  variables (`CONDA_VARS`: the prefix of `CONDA_EXE`, `CONDA_PYTHON_EXE` and `MAMBA_EXE`, and
  `MAMBA_ROOT_PREFIX` itself: with the base env not activated only `condabin` was on PATH, and
  `conda run -n proj pytest` couldn't read the interpreter or `envs/`, #827, the second
  2026-11-21 audit); never `/`, the home directory or a parent of a
  secret), the SDKs a build finds by variable rather than PATH (`sdk_roots`: `SDK_VARS`,
  `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `JAVA_HOME`, `FLUTTER_ROOT`, `DOTNET_ROOT`, and
  `SDK_DEFAULTS`, Android Studio's `~/Android/Sdk` and macOS's `~/Library/Android/sdk`: with only
  `platform-tools` on PATH, Gradle couldn't open `platforms/*/android.jar` and every Android build
  failed, #437, the audit of 1.8), the directories the user's search paths name
  (`search_roots`: `SEARCH_PATH_VARS`, `PYTHONPATH` (the user's, `WB_USER_PYTHONPATH` in a detached
  runner), `LD_LIBRARY_PATH`, `AMENT_PREFIX_PATH`, `CMAKE_PREFIX_PATH`, `PKG_CONFIG_PATH`; never
  `/`, the home directory or one holding or inside a secret: a ROS 2 overlay in
  `~/ros2_ws/install` was hidden, so `import my_msgs` raised PermissionError, #667), not the
  user's documents or other projects. On WSL (`hardware.system()`), never the
  Windows drives either (`windows_drives`: the DrvFs mounts in `/proc/self/mounts`, and any
  `/mnt/<letter>`): a Windows program runs through interop as a Windows process, as the user,
  outside Landlock and no-new-privileges, and the 0.90 review found the Windows PATH (System32,
  Git for Windows, a Windows-only Node, whose `npm` the allowed `npm` resolved to) on the agent's
  PATH and in its read lane. With the lane on, their directories are dropped from the agent's
  `PATH` (`context.agent_path`, in `runner.agent_env`, which also drops `WSL_INTEROP`) and from
  `tool_roots`, and `readable` treats each drive as an `ONLY_KEPT` root wherever it is mounted
  (wsl.conf's `[automount] root = /` puts them at `/c`, `/d`, which `/` had read whole, so the
  agent could run `/c/Windows/System32/cmd.exe` by its path: #914, the third 2026-11-21 audit),
  so a drive stays unreadable beyond the repo and grants; a Windows program
  there can't be run even by full path, since `execve` opens it for reading and the read lane
  refuses that (the Lane test runs a program outside the read lane and gets `Permission denied`).
  A Windows program inside the lane (one the agent writes, or in a repo on a Windows drive) still
  runs outside it: `wb doctor` says so while interop is on (`interop_gap`), and `[interop]
  enabled=false` in `/etc/wsl.conf` closes it (and stops wb reading Windows' GPUs, so the advice
  points to `gpu_gb`, #702). Running a program reads it, so a program the walk leaves out can't start (in
  the agent's shell a plain `Permission denied`; OpenCode itself gets `workbench lane: can't run
  <cmd> (Permission denied)`, exit 126; not found, 127): add its
  directory to `commands.json` `paths`. Landlock only allows, so `readable()` walks down from `/`
  listing the entries beside each excluded one. Found by trying: `python3` running gh inside the
  lane was logged in, and the SSH keys that push were readable.
- *The kernel's side* (`lane.py`, Linux Landlock, no root): the runner starts OpenCode as
  `python -I lane.py --write P… [--reads --read P…] [--unix P…] -- opencode …`; it restricts
  itself and execs, so OpenCode, its shell and everything they run inherit the limit. Handled
  rights: file writes, removes and every make, plus refer (ABI 2: moves inside the lane work)
  and truncate (ABI 3), file reads when `--reads` is given, and from ABI 9 connecting to a UNIX
  socket made outside the lane, granted only beneath `--unix` (`context.unix_paths`: the
  `SYSTEM_SOCKETS` that exist, the socket files alone, which hold nothing of the user's: the log
  (`/dev/log`, `/run/systemd/journal/socket` and `stdout`) and name and user lookups (resolved's
  `io.systemd.Resolve`, userdb's `io.systemd.Multiplexer`, `/run/nscd/socket`, sssd's
  `pipes/nss`, and since #913, the third 2026-11-21 audit, avahi's `/run/avahi-daemon/socket`,
  `/run/nslcd/socket` and winbind's `pipe` under `/run/samba/winbindd` or
  `/var/run/samba/winbindd`: without them a `.local` model server, which nsswitch resolves only
  through avahi, passed the runner's probes and failed every request in the lane, and LDAP or AD
  users had no `getpwuid()`), so `logger` and `resolvectl` work, not the system bus; and the
  `commands.json` and grant `paths`, split around secrets and workbench's own files as the reads
  and writes are, so `wb allow --path /run/postgresql` reaches a test database; and a granted
  `SECRET_SOCKETS` file, Docker Desktop's `~/.docker/desktop/docker.sock` (macOS's
  `~/.docker/run/docker.sock`), which `lane_refusal` lets a grant name although `.docker` is a
  secret: it is connected to only, `config.json` and the rest of `~/.docker` stay hidden (before
  #441, the audit of 1.8, only turning the lane off let Testcontainers reach it). A refused
  connection is named in the report like any refused path (`runner.lane_refused`: Docker's
  `dial unix /var/run/docker.sock: connect: permission denied`, psql's socket under
  `/run/postgresql`, the Nix daemon's), and from ABI 9 so is a socket inside a writable place
  that isn't granted (`is_socket`, not in `unix_paths`): the writable entries carry no socket
  right, so a Postgres or MySQL socket the user's server made in `/tmp` was refused, and
  `lane_refused` dropped it as in the lane (#826, the second 2026-11-21 audit); a `--unix` rule
  carries the socket right alone, since the 0.90 review found its read right made a granted
  `~/.config`'s gh token readable again), so the session bus (and through it `systemd-run`), the keyring and the SSH and GPG
  agents are out of reach; sockets the lane's own processes make stay theirs. From ABI 6 it also
  scopes signals and abstract UNIX sockets: the agent can signal only what it started, not its
  runner, other tasks, the chat or Claude Code, while the runner can still stop it. Directories
  get every right; files only write, read, truncate and the socket right. No-new-privileges,
  which disables setuid programs (sudo, su, and snap-confine, so a snap can't run in the lane:
  `wb start` refuses a `--test` that is one, `wb doctor` names those on PATH), is set on every
  Linux machine, Landlock or not, before the lane. Directory listing and the network stay free;
  so does metadata: Landlock doesn't cover chmod, chown, utimes or xattrs, so those still succeed
  on a file outside the lane (only the shell patterns stand in their way). It fails closed: when
  Landlock is there but the lane can't be drawn, it prints `workbench lane: the kernel refused
  the lane (<error>); not running <cmd>` to `runner.log` and exits 126. A command it can't exec
  gets `workbench lane: can't run <cmd> (<reason>)` and exit 127 (not found) or 126, not a
  traceback. Without Landlock (macOS,
  an old kernel, or an architecture whose syscall numbers differ: `lane.UNIFIED` lists the ones
  it runs on, x86_64, i386/i686, aarch64, armv7l/armv6l, riscv64, ppc64/ppc64le, s390x,
  loongarch64) it execs unrestricted but for no-new-privileges on Linux. Older ABIs hold less
  (`lane.gaps`): before ABI 3 (Linux 6.2) truncating a file outside the lane isn't refused; on
  ABI 1 (Linux < 5.19) moving or hard-linking a file between directories fails even inside it
  (EXDEV, "Invalid cross-device link"; most tools fall back to a copy); before ABI 6 signals and
  before ABI 9 the user's sockets aren't scoped. `wb doctor` draws a real lane and tries a write
  outside it: `ok agents write only in their lane (Landlock ABI N)`, `BAD the lane didn't hold a
  write outside it: …`, or a `--` line without Landlock; then a `--  Landlock ABI N: …` line for
  each gap, and on WSL with interop on (`/proc/sys/fs/binfmt_misc/WSLInterop` or
  `WSLInterop-late` reading `enabled`) a `--  WSL interop is on: …` line: a Windows program in
  the lane or the repo runs outside it; `[interop] enabled=false` in `/etc/wsl.conf` closes it,
  and stops wb reading Windows' GPUs (set `gpu_gb` then, #702).
- *OpenCode's side* (`external_rules`): its `external_directory` permission, checked for its file
  tools' paths and the shell's working directory and `cd` targets (not other arguments), is deny
  `*`, then allow `<dir>/*` for the lane, `READABLE` (`/usr`, `/etc`, `/opt`, `/lib*`, `/bin`,
  `/sbin`, `/proc`, `/sys`, `/nix`, `/run/current-system`, and macOS's `/Library`,
  `/System`, `/Applications`), the installs the lane already lets the agent read (`read_only`:
  `tool_roots`, the programs it runs, such as a conda, pyenv or mise env's site-packages, and the
  toolchains split out of the write lane, `NOT_WRITABLE` and `$RUSTUP_HOME/toolchains`, rustup's
  std sources; and `sdk_roots`; never one inside a lane entry), the task's `rounds/` (a prompt
  too long for one argument is read from there) and the handed skills' directories; with the
  lane off, allow `*` (said outright: the layer's rule for other MCP servers' tools, `*_*`, would
  match it). The `read_only` places also get an `edit` deny (`read_only_rules`): read, never
  edited, but a lane entry inside one (a Flutter SDK's `bin/cache`) gets its `edit` allow back. Before #521 (the audit of 1.90) `read` on an env's `pandas/core/frame.py` was refused,
  each refusal counting toward the six-errors guard, and the only remedy, `wb allow --path`, made
  the install writable, though the user's own shell runs it outside the lane later. This is all
  that applies without Landlock.
- *Asking for more.* A refused write is "Permission denied" (the protocol says so, and not to
  probe it); the agent calls `ask_reviewer` with `path`, which raises a PERMISSION question naming
  `wb allow <task> --path <dir>`. That grants read and write (`--always` keeps it in
  `commands.json`; `wb start --allow-path` grants it up front). `_lane_dir` refuses a path through
  a link, naming its target (the agent can plant `/tmp/out` -> another project and ask for
  `/tmp/out`; Claude names the real directory itself), and `context.lane_refusal` refuses `/`, the
  home directory and a place in a secret, workbench's own files or the skill library; a place
  that holds one is granted around it. It refuses a place in the task's repo or its git directory
  too (`repo_dirs`, which no lane may write: it said "allowed" and the retry was refused again,
  the 0.90 review), and one that doesn't exist with a suffix to its name (`debug.keystore`: made
  as a directory, it broke the next round's keytool with 'Is a directory', #670), naming the
  directory it goes in. It refuses a place `writable` always splits out, an active Python
  environment or a `NOT_WRITABLE` place, made or not (`context.kept_out`): the grant was saved,
  the agent told to run it again, and its retry refused the same way (#912, the third 2026-11-21
  audit); the PERMISSION notice for such a `path` says no grant reaches it, instead of naming
  `wb allow`. Then it creates the directory. `lane_paths` leaves out a
  `commands.json` or grant path the same check refuses. `*` turns the lane off for the task, as
  `"paths": ["*"]` in `commands.json` does for every task.

**Its environment** (`runner.agent_env`) is that of the `wb` command that last started its runner
(`start`, `feedback`, `next`, `resume`) less OpenCode's switches that drop the project's skills
(`CLAUDE_CODE_OFF`, *Skills* below), the runner's own `PYTHONPATH` (the user's replaces it:
`python_path`, below) and credentials (`SECRET_ENV`: names containing `TOKEN`, `SECRET`, `PASSW`, `CREDENTIAL`, `API_KEY`, `ACCESS_KEY`,
`PRIVATE_KEY`, `WEBHOOK`; ending `_PASS`, `_PASSPHRASE`, `_PWD`, `_DSN`, `_JWT`, `_PAT`, `_KEY`, or
holding `PASS_`; `PASS`, `PASSPHRASE`, `KEY`, `BW_SESSION`, `OP_SESSION_*`, `KRB5CCNAME`; the
`ANTHROPIC_`, `CLAUDE_`, `GH_`, `GITHUB_`, `GITLAB_`, `AWS_`, `AZURE_`, `GOOGLE_`, `OPENAI_`, `HF_`
prefixes; `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `GPG_AGENT_INFO`, `DBUS_SESSION_BUS_ADDRESS`,
`DBUS_SYSTEM_BUS_ADDRESS`; and any variable whose value is a URL with a password, `USERINFO`:
`DATABASE_URL=postgres://u:p@h/db`), but for `ENV_KEEP`, configuration under those prefixes
(`HF_HOME`, `HF_HUB_CACHE`, `HF_HUB_OFFLINE`, `HF_DATASETS_OFFLINE`, `HF_ENDPOINT`,
`HF_HUB_DISABLE_TELEMETRY`, `TRANSFORMERS_OFFLINE`, `TOKENIZERS_PARALLELISM`, `AWS_REGION`,
`AWS_DEFAULT_REGION`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_REGION`); plus `PWD` (the worktree),
`OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT` (the rules again, below), `WB_TASK`, `WB_HOME`, `WB_RUN` (the run's id, for `sweep`), its
own `XDG_RUNTIME_DIR` (`context.runtime_dir`, with the lane on) and in it, unless the user set
one, `JUPYTER_RUNTIME_DIR` (`<runtime dir>/jupyter`: Jupyter's default,
`~/.local/share/jupyter/runtime`, is outside the lane, and every notebook test, nbmake, nbval,
papermill, failed with PermissionError writing its kernel connection file, #668),
`POETRY_VIRTUALENVS_IN_PROJECT=true` and `PIPENV_VENV_IN_PROJECT=1` unless the user set them
(with the lane on: their venv in the worktree, #825, *Paths, a lane*), build
daemons of its own (`daemon_env`, with the lane on: `GRADLE_OPTS` gets
`-Dorg.gradle.daemon.registry.base=<runtime dir>/gradle` and
`-Dkotlin.compiler.execution.strategy=in-process` after the user's own options;
`SCCACHE_SERVER_PORT` a loopback port of the task's, `free_port`, picked from the runtime dir's
name in `SCCACHE_PORTS` (20000 to 40000), the next free one when that is held; and `DAEMONS_OFF`:
`MSBUILDDISABLENODEREUSE=1`, `DOTNET_CLI_USE_MSBUILD_SERVER=0`, `UseSharedCompilation=false`.
Gradle reuses any idle compatible daemon whatever its environment, so the user's `./gradlew
build` ran in the agent's daemon under Landlock, failed writing its `build/`, and lost the daemon
to `sweep`, while the agent's builds could run in the user's daemon outside the lane; sccache's
server on 127.0.0.1:4226 and MSBuild's nodes are shared alike: #669, not yet run against a real
Gradle), `MISE_TRUSTED_CONFIG_PATHS` with the state directory added after the user's own,
when the checkout has a mise config (`MISE_CONFIGS`: `mise.toml`, `.mise.toml`,
`mise.local.toml`, `.config/mise.toml`, `.config/mise/config.toml`, `.mise/config.toml` and the
like; `.tool-versions` needs no trust) and `mise trust --show`, run by the runner in the user's
checkout outside the lane, says it is trusted (`context.mise_trusted`: mise keeps trust per path,
so in the worktree and the scratch checkouts, all under the state directory, every mise shim
failed with 'Config files in …/mise.toml are not trusted', and `mise trust` writes outside the
lane: #674, checked with mise 2026.11.11; `wb start` notes a config the user hasn't trusted),
`PYTHONDONTWRITEBYTECODE=1` (no
`__pycache__` in the diff), signing off for its git (`NO_SIGNING`: `commit.gpgsign=false` and
`tag.gpgsign=false` as `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`, after any the
user set, `git_config_env`: with `commit.gpgsign` in `~/.gitconfig`, every test that committed in
a scratch repo failed in the lane, the keys and agents out of reach, and the base check blamed
the project, #666; the agent commits to no repo of the user's anyway) and the shim's `PATH` (on WSL with the lane on, without the Windows
drives' directories, and without `WSL_INTEROP`: `context.agent_path`). The caller's repository variables never reach it,
nor wb or the runner (`gitops.REPO_ENV`: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and the like, dropped by
`gitops.drop_repo_env` at `cli.main` and `runner.main`, and left out of each of wb's git calls, `gitops._env`,
wb's own scratch `GIT_INDEX_FILE` layered on per call: started from a commit hook, the runner's `worktree add`
failed on its `GIT_INDEX_FILE`, or the review diff and accept used the user's own index; from a vcsh shell,
`GIT_DIR` sent the calls to another repo, #798). A provider that needs a key from the
environment, or tests that need `DATABASE_URL` and the like, name it in `commands.json` `"env":
[names]`, which passes it through. A proxy that holds a password (`https_proxy=http://user:pass@proxy:3128`)
is a URL with a password too, and stays out unless named (#380, the audit of 1.6: the setup's `npm ci`
and the tests failed with network errors that read as the project's, and nothing said why): `wb
start` notes each such `*_proxy` variable (`runner.dropped_proxies`, `env_kept`), and a setup or
a test run that fails with a connection error (`NET_FAILED`: `ECONNREFUSED`, `Could not resolve
host`, `ProxyError` and the like) says it again (`proxy_gap`: the setup's `failed` notice, and
status `tests.proxy`, which the report names), each with the `"env": [...]` line that passes it.
OpenCode's own environment adds `OPENCODE_ENV`
(`npm_config_yes=false`); the tests' doesn't.

*The user's Python environment* (`context.python_env`, in `agent_env`, so the agent, the setup,
the tests, the base check and `wb verify` alike). An activated venv or conda env (`source
.venv/bin/activate`, direnv's `layout python`, `poetry shell`, `conda activate`) reached the agent
on its PATH, and when it was the checkout's own, `import mypkg` in the worktree loaded the user's
checkout: a test the agent added failed in every auto-fix round, or a review said the tests passed
on code they never imported, and a setup that made `worktree/.venv` didn't help unless `--test`
named `.venv/bin/pytest` (#490, the audit of 1.90). An active environment (`python_envs`) is the
checkout's (`checkout_env`, `checkout_envs`) when it lies inside the repo (not when the repo holds
the home directory), in a per-project venv home (`VENV_HOMES`: poetry's, pipenv's,
virtualenvwrapper's `~/.virtualenvs` and hatch's, or where `VENV_HOME_VARS` move them:
`WORKON_HOME`, `POETRY_VIRTUALENVS_PATH`, `POETRY_CACHE_DIR`, `HATCH_DATA_DIR`), or when a file in
its site-packages (`EDITABLE_FILES`: `.pth` lines, setuptools' `__editable__` finders, egg-links,
`direct_url.json`) names a path in the repo. Such an environment leaves the agent's: its
variables (`VENV_VARS`: `VIRTUAL_ENV`, `VIRTUAL_ENV_PROMPT`; `CONDA_PREFIX`, `CONDA_DEFAULT_ENV`,
`CONDA_PROMPT_MODIFIER`), a `PYTHONHOME` in it or the repo, and its `bin` on PATH. Other PATH
directories inside the repo become the worktree's (`node_modules/.bin`, a direnv `PATH_add`), and
the worktree's own venv (`own_venv`: `.venv` or `venv` in the package or at the top, made by the
setup) comes first, as `VIRTUAL_ENV`, so a plain `pytest` or `python3` runs it. The git shim's
real git is looked up without those worktree directories (the runner runs it outside the lane),
and OpenCode is found by the runner's own PATH (`opencode_bin`). Any other active environment (a
conda env holding the project's dependencies, a tools venv) stays, written by nothing in the lane
and installed into only when asked (*Commands*, step 6). `wb start` names each one it leaves out
(`venv_line`) and, without `--setup`, how to give the worktree its own: `--setup 'uv sync' --test
'uv run pytest'`, or the project's own install. Not covered: a user site-packages
(`~/.local/lib`) `.pth` pointing at the checkout, from `pip install --user -e .`.

*The user's `PYTHONPATH`* (`context.python_path`, from `python_env`). ROS's `setup.bash`, a src
layout exported from a shell profile, Blender, Spack: the runner's `PYTHONPATH` is the package
root, so the agent, the setup and the tests got none, failing on `ModuleNotFoundError` round after
round, and naming `PYTHONPATH` in `commands.json` `env` passed workbench's own path, which put
`python3 -m workbench.cli` in reach (#512, the audit of 1.90). `context.detached_env`, which
`spawn_runner`, `bench.start` and `optimize.start` use, keeps the caller's value in
`WB_USER_PYTHONPATH` (`USER_PYTHONPATH`; one already set is kept, so a bench replay's runner gets
the user's, not the driver's). `agent_env` gives it back by default, whatever `env` names, less
workbench's package root and the directories of a Python environment `python_env` left out, with
each directory inside the repo as the worktree's (as on PATH: `PYTHONPATH=~/proj/src` imports the
worktree's `src`); none left, no `PYTHONPATH`. The carrier itself never reaches the agent.

**Project config can't lift the rules.** OpenCode loads a project's `opencode.json` (the
worktree's, `.opencode/`, and one in any directory above it) after `OPENCODE_CONFIG`, and appends
its permissions after the layer's, so an allow-all there won (the 2026-11-16 audit: an agent
could write one for its next round). `rules_env` passes the layer's permissions again as
`OPENCODE_CONFIG_CONTENT`, which loads after every file; a list past `CONFIG_CONTENT_MAX`
(120,000 bytes; one environment string holds 128 KiB) sets `OPENCODE_DISABLE_PROJECT_CONFIG=1`
instead, which also drops AGENTS.md and the project's skills. The user's own
`OPENCODE_CONFIG_CONTENT` (`models.users_config_content`) goes under the rules, not away (#347,
the audit of 1.4): its keys are kept but `mcp` (the user's MCP servers stay off) and any the
layer sets itself (loaded last, the user's `compaction` would undo the handover's backstop), but
`provider`, which the layer always sets now: the user's providers stay, with the layer's provider
timeouts merged on top, so neither their content nor a project's `opencode.json` puts the 300 s
header wait back (#491). Its `permissions` come before the layer's (the last match wins), and
`share` is `disabled`; past the limit it goes alone, without its permissions.
What else the layer sets is said there again
too, so a project config can't change it either (#519, checked on OpenCode 2.3.2: the project's
document won each): `RESTATED` (`small_model`, `autoupdate`, `compaction`: a project's
`compaction.auto: false` left a session past the handover point with no backstop, its
`small_model` got the titles, its `autoupdate` moved OpenCode past `OPENCODE_TESTED`), and the
task model's `limit` and `options.max_tokens` from wb's own reading of the entry (`model_pins`:
a `provider` overlay, merged over the user's providers and the layer's timeouts, never a `baseURL` or key; a
wider window there moved OpenCode's compaction off the one wb planned the handover against).
The layer's `small_model` is the task's model, which is how `rules_env` finds it. A project
config can still change what the layer doesn't set: another provider's entries, the task model's
other options (`temperature`) and its provider's `baseURL`. The layer's `edit` rule also denies
`OPENCODE_FILES` (`*opencode.json`, `*opencode.jsonc`, `.opencode/*`, `*/.opencode/*`), and the
round report flags them with Claude's files.

**The user's MCP servers stay out.** OpenCode merges the user's global config, MCP servers
included, into every agent's: a GitHub or database server with the user's token would reach
every agent, and a remote one runs in OpenCode's own process where neither the lane nor
`SECRET_ENV` applies. The layer replaces each server in the global `mcp.servers` with one that
can't run (`runner.users_servers_off`: `{"type": "local", "command": ["false"], "enabled":
false}`; OpenCode 2.3 starts a server whose own entry says `"enabled": false` all the same), and
its permissions start with `MCP_RULES`: deny `*_*` (every MCP tool, named `<server>_<tool>`, a
project's too), allow `workbench_*`, allow `doom_loop` (what `--auto` gave it). The layer also
sets `"share": "disabled"`, against a user's `share: "auto"`, `small_model` to the task's own
model (a user's could be a cloud one, sent the task's text for titles and summaries) and
`"autoupdate": false` (an update mid-task could move OpenCode past `OPENCODE_TESTED`), both
accepted by OpenCode 2.3 in the real-OpenCode tests (#353, the audit of 1.4). The user's plugins
still load: theirs to choose, and not the agent's to change.

**What the agent writes is not trusted.** Of the task directory, the lane writes only the
worktree and `ask/`; the grants, the rules and the config live in `rules/<task>/`, and the ask
server's questions are checked and raised by the runner (*Talking to a running agent*). What wb
writes into `ask/` goes through `ask_mcp.write_answer` (a new temporary name, then a rename that
replaces a link instead of following it), and the runner reads ask files without following links
or FIFOs, up to `FILE_MAX`. The acceptance command runs in the same lane and environment as the
agent, so code the agent wrote gets no more rights when the runner tests it.

**Claude's files.** The `edit` permission denies `*CLAUDE.md`, `*CLAUDE.local.md`, `*AGENTS.md`,
`.claude/*` and `*/.claude/*`, and the skill library (`<library>/*`), so OpenCode's file tools
can't change them; a change made from the
shell shows in the round report. When a task asks for a change to CLAUDE.md or AGENTS.md, the
protocol has the agent write the whole new file beside it as `<name>.proposed`
(`runner.PROPOSABLE`, `runner.proposals`: a new file, untracked at the step's start (HEAD),
listed by `git ls-files --others --exclude-standard`, so ignored directories aren't walked;
never a link). A `<name>.proposed` the project already tracks is its own file, shown and
committed like any other: settled as the agent's, accept deleted a team's committed draft that
the review never showed (#321, the audit of 1.4). The review notice shows each as a diff
against the file (`proposal_diff`; `review_diff` leaves exactly those proposals out of the main
diff, by literal path: an ordinary `schema.proposed` is code, shown and committed like any file,
#79), and `wb accept`/`wb next` settle them around their commit (`cli._settle_proposals`):
`--take-claude-md` puts each over its file, else it is dropped, so one is never committed as it
is. A commit that fails puts every proposal (and the file it replaced) back, and the
"took"/"dropped" lines come only once the commit stands: wb next dropped a proposal, then died
on its commit, leaving a retry with `--take-claude-md` nothing to take (#507). A proposal for a
file git ignores (a local CLAUDE.md, the agents reading the checkout's copy) is diffed against
the checkout's copy and taken over it once the commit stands ("written over <path> (gitignored,
so in no commit)"); where that copy can't take it (a link, or not ignored there) `--take-claude-md`
is refused before anything changes, naming the proposal to apply by hand: `add -A` skipped the
ignored file, accept said "took", and the change went with the worktree (#506, Claude's audit of
1.90). A file that is a link inside the worktree (wb init's `AGENTS.md` -> `CLAUDE.md`) pairs its
proposal with the link's target, so `AGENTS.md.proposed` is diffed against and taken into
`CLAUDE.md` and the link stays a link (the notice says "(as AGENTS.md.proposed, through the
link)"); `runner.link_problem` refuses `--take-claude-md` when two proposals name one file or a
file is a link out of the worktree, and the notice says so: paired with the link, the proposal
was diffed against nothing and taken as a plain `AGENTS.md` over the link, CLAUDE.md unchanged
(#871, Claude's audit of 1.90.24). Claude making each change itself was a call over its whole context on most tasks
(2026-11-18).

**Git, read-only** (`gitguard.py`; *Git, commits and projects*). `runner.agent_env` writes a `git`
of its own into `rules/<task>/bin/` and puts it first on `PATH`.

**Skills**: the repo's own `.claude/skills` and `.agents/skills`, plus the library skills Claude
handed this task (one directory each in the config's `skills` list). The user's personal
`~/.claude/skills` (including synced Claude app skills, `synced/*/*/SKILL.md`) and
`~/.agents/skills` (the cross-tool place OpenCode 2.3 also reads, which reached every agent: #371,
the audit of 1.6) are denied by name (`denied_skills`): an agent once read a personal skill as a
"newer task" and went off into the user's files. A name the worktree's own `.claude/skills` or
`.agents/skills` also has stays allowed (the project's skill wins); `workbench` and
task.json's `deny_skills` are always denied. `wb skill add` refuses the personal names. A
library skill handed to the task keeps its name though a personal skill has it too (one synced by
the app after the library's): denied by name, every load of it failed while the agent was told to
load it, and `wb skill list` then advised rewriting a good skill (#515, the audit of v1.90).
OpenCode 2.3 loads the handed one, by its library path, in and out of the lane (the
RealOpenCode test), and `wb skill list` says when a personal skill shares a library skill's name.
`OPENCODE_DISABLE_CLAUDE_CODE` or `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` (`1` or `true`) makes
OpenCode 2.3 skip every `.claude` directory, the project's own skills with them, without a word
(#384, the audit of 1.6), so the agent's environment leaves both out (`runner.CLAUDE_CODE_OFF`):
the rules above are made for OpenCode's default. Claude's
own skills and plugins (under `~/.claude`, outside the lane) never reach the agent either: the
skill has Claude apply the ones that fit a task itself and carry the result into the spec as
decisions and concrete rules, review against them, and turn a correction that recurs into a
short library skill (*The skill library*). Workbench names no plugin and no field: which skills
the user has is Claude Code's, and only the driver sees them.

**`ask_reviewer`**, an MCP tool for one blocking question to Claude (*Talking to a running agent*).
OpenCode lists it as `workbench_ask_reviewer`.

**Browsers and the web.** Workbench brings no browser, for Claude or the agent. Claude's are the
ones Claude Code gives its session (WebFetch and WebSearch, a browser extension or pane, an MCP
server the user added), the user's stated preference first: `~/.claude/CLAUDE.md`, which every
session reads, so the skill has Claude offer to write one there, then `wb notes` (workbench mode
only) and the repo's CLAUDE.md; not Claude's memory, which stays in one project. The skill's rule
makes a blocked fetch (a 403, a CAPTCHA, a login wall, a page empty without JavaScript) "not
checked", never a finding, and when that cost an answer in a session with no browser tool, Claude
says so and that one would reach it (Claude in Chrome, the desktop app's browser, a browser MCP
server), the choice left to the user. Research is Claude's: the agent's web search and fetch
are denied (*Denied tools*), `curl` and `wget` aren't on the list, and what it needs to know comes
in the spec or as an answer to `ask_reviewer`. Those are rules on its tools, not the network: the
lane leaves the network open (a dev server on localhost, a test that calls one), so an interpreter
or a program it built can reach any host; what keeps that cheap is that credentials stay out
(`SECRET_ENV`, `SECRETS`). A browser MCP server the user set up for OpenCode stays out with the
rest (above). A browser as a test tool runs in the lane: `playwright` is on the list and a
project's `node_modules/.bin` runs freely, Playwright's browsers live in `~/.cache` (a build
cache), `/dev/shm` is in `DEV_NODES` for them, and Chrome's own sandbox (namespaces and
seccomp-BPF) works inside the lane (checked 2026-11-17 on Landlock ABI 10, with Playwright's
Chromium and the system's). A bare `chromium --headless` can't make its default profile
(`~/.config`, outside the lane: "Failed to create a unique user data directory for headless"), so
the handbook says `--user-data-dir=$(mktemp -d)`. A bare browser (`chromium`, `google-chrome`, a
global `lighthouse`) is not on the list: it fetches any URL, like `curl`, so it asks, and `wb allow <task>
"chromium *" --always` is how a user hands every task the browser they prefer (`commands.json`
`paths` for one installed outside the lane). A snap browser can't run (no-new-privileges). The
skill has Claude make a browser check part of `--test`, its console and page errors printed as
text; screenshots are Claude's to look at.


## Talking to a running agent

Claude is the driver, not a spectator, and the agent is a teammate it can reach at any time.

**Questions** (`workbench/ask_mcp.py`, launched as `bin/wb-ask-mcp`). A stdio JSON-RPC MCP server
OpenCode starts with each `opencode run` (so once a round), configured as
`mcp.servers.workbench` (`type: local`, `codemode: false` so it's a plain tool, `timeout.startup`
15 s, `timeout.execution` the ask timeout plus a minute, `environment` `WB_TASK` and `WB_HOME`).
It answers `initialize` (echoing the client's protocol version, else `2025-06-18`), `ping`,
`tools/list` and `tools/call`; one tool, `ask_reviewer {question, context?, command?, path?}`.
`tools/list` also touches `ask/.listed` (`LISTED`): a round that ends cleanly without it gets a
report line, `NOTE: the agent's OpenCode never listed workbench_ask_reviewer, so it can't ask you
anything`, with the `opencode mcp list` command that says why (the 2026-11-19 audit: an OpenCode
that stopped loading the server would have left the agent mute, and nothing said so).
`run_round` removes the mark before each OpenCode starts, so each round's report judges its own
round: kept from round 1, the note could fire only there (#481).
The server runs inside the agent's lane, so it writes only `ask/`. A call first checks `command`
and `path` (`bad_request`: one line of at most `LINE_MAX`, 4096, characters; a path absolute) and
an empty `question` (`NO_QUESTION`, "Ask with a `question`, and ask again.", as the runner's
`_judge` says it), and replies with what to fix instead of asking; past a budget (a courtesy:
the runner's count is the one that holds; counted as the runner counts, from status `asks`,
which the lane reads, its `q` and `p` entries, and each ask file not judged yet by what it
holds: counting every file charged the ones the runner refused, `x`, an empty question or
`close_all`'s strays, so a question the runner would have relayed got the budget's refusal,
#831, the second 2026-11-21 audit) it returns the refusal. Otherwise it writes
`ask/<id>.json` (`{id, ts, round, question, context, command?, path?}`) and blocks (a `Watcher`
on `ask/`) until `ask/<id>.answer` appears or the ask timeout passes (`--ask-timeout`, 20
minutes), returning the answer or "No answer arrived in time. Make the most reasonable
assumption…". Both that wait and the runner's (below) count on `ask_mcp.Waited`: the monotonic
clock, less any step longer than `ask_mcp.FROZEN_SECS` (60 s, as the round's `_Clock`; the server
looks at least every `STEP_SECS`, 30 s), so a suspend doesn't expire the question; on the wall
clock a laptop woken past the ask timeout found it answered and closed (#453).
A call that raises (a full disk, an unwritable `ask/`) returns `isError: true` and
`ask_reviewer failed: <why>; carry on without an answer and say so in your summary.`; any other
request that raises gets a `-32603` error with the request's own id (`null` only for a line that
isn't a request). OpenCode's MCP client dropped a reply with id `null`, so the call waited out
its execution timeout and the silence guard stopped the round (#525). Requests are parsed with
`store.loads`, and the runner reads ask files with it too, so half an emoji (a lone surrogate)
in a question is U+FFFD rather than a write that fails: in the server, or in the runner's event
for an ask file the agent wrote itself.

The runner relays it (`ask_mcp.relay`, each tick of the round's loop, woken by the steer bell
when `ask/` changes). Outside the lane, it reads each new ask file (no links, at most
`FILE_MAX`, 256 KiB; `NEW_MAX` a tick, `ASKS_MAX` in all), checks it again and counts it in
status `asks` (`{id: "q" | "p" | "x"}`, which the agent can't write: deleting ask files gives it
no budget back). Plain questions go up to `--ask-budget` (2) across all steps, command or path
requests together up to `PERMISSION_BUDGET` (8), apart from the questions; a refused one ("x")
is answered with why, and Claude isn't woken. Otherwise it logs an `ask` event and raises a
`question` notice (`notice`): `Q: …`, or `PERMISSION to run: `cmd`` / `PERMISSION to use the
directory D (outside its lane)` with the `wb allow` that grants it, the path shell-quoted. The
question is clipped at `QUESTION_CHARS` (2,000) and the context at `CONTEXT_CHARS` (4,000), each
pointing at the ask file for the rest, and every line after a part's first is marked `> `, the
agent's, so none can pass for workbench's own; `command` and `path` are never clipped (Claude
copies them). The phase is `asking` while any question of the round is open, `status.asking`
the oldest; an answer (logged as an `answer` event) or the ask timeout closes one, and with none
open the phase is `running` again, so two questions at once keep the task asking until both are
answered. The phase is set before the notice is raised, so a reader that sees the notice sees
the task asking, and each open question's notice gets a mark of its own (two asked in one tick
shared one, and acknowledging the first acknowledged both). A round that ends mid-question clears
it. A question the runner drops, timed out or its round over, is closed (`ask_mcp.close`): it
writes `NO_ANSWER` as its answer, so nothing takes it for open (Claude was woken for one nobody
waited on); lessons skip that answer. However the round ended (a `wb stop`, a signal, a crash),
`_end_agent` closes every question in status `asks` still open (`ask_mcp.close_all`) and clears
`asking` (and an `asking` phase), as `cli.reap` does for a runner that died: a stop once unwound
past the round's close, and `wb answer` said "answered" to nobody (the 0.90 review). It closes
the ask files never relayed too (written in the tick before the round ended, or by an agent that
outlived its runner off Linux), recorded in `asks` as refused (`x`, no budget): left, the next
round's first relay raised one as live, woke Claude and held the phase `asking`, pausing every
guard, for a question nobody waited on (#680). The prompt `wb next` writes names the
questions left (`ask_mcp.used`), not the whole budget. A `tools/call` runs on its own thread
(replies written under a lock), so `ping` and the rest are answered while a question waits. The
silence guard doesn't count the wait. `wb answer <task> --text|--file` answers, and refuses a
closed question (`ask_mcp.is_open`: answered, or dropped); `wb allow` answers the oldest open
permission request (`_permission_asked`), else the pending question; both write through
`ask_mcp.answer_once`, as do the runner's `NO_ANSWER` (`close`), its refusals and the bench's: the
open check and `write_answer` as one step under `locks/<task>.ask.lock`, so of two answers only one
is written and the other refused, "<id> was already answered (or closed with NO_ANSWER)" (exit 1,
status `answered` untouched): apart, both said "answered", the second replaced the first, and one
racing the runner's close overwrote `NO_ANSWER` and was counted answered (#938).

**Granting.** `wb allow <task> "<pattern>"… [--path DIR…] [--always]` adds to the task's grants
(`rules/<task>/grants.json`, through `context.grant`; and to `commands.json` with `--always`,
`context.allow_always`, a read-modify-write under the file's lock, through a symlink, its mode kept
(`store.edit_config`: unlocked, two sessions' grants close together lost one, and a dotfiles link
became a plain 0644 file, #495); it refuses a `commands.json` that doesn't parse or has the wrong
shape), answers any pending question with
"Claude allowed … Run it again now and carry on.", and when the agent is running, also queues that
as a `--now` note so the agent restarts on its session with the new rule (the rules are read when
OpenCode starts).

**Notes.** `wb steer <task> --text "…"` (queued, running, testing or asking, with a live runner)
queues a note the agent gets when its current run ends, before the tests. `--now` interrupts it:
the runner is woken by the note itself (`_steer_bell`), stops the agent within seconds and
starts the next round with the note first, marked as overriding anything earlier. The next round
continues the session unless the between-rounds check hands it to a fresh one; during the tests
there is nothing to interrupt, so the note waits for them, and while the task waits for the GPU it
goes with the round's prompt when the round starts (`runner._early_notes`), or, waiting for the
GPU before its tests (`--unload-for-tests`, phase `queued` too), once the tests end: `wb steer` and `wb allow` say which (`cli._when_delivered`), not
"within a few seconds". A note the runner never delivered (it stopped first) goes to the stuck
report, and the next `wb resume` carries it, `wb feedback` and `wb next` drop it and say so.

**Check-ins.** With `--checkin MIN` a task raises a `checkin` notice every MIN minutes of a round
while it runs, with a digest of what changed since the last one (*The runner, inside*). Claude
tells the user how it's going in two or three lines, logs anything worth finding later with
`wb note` (a `captain` event: a "captain's log" line in the transcript), and steers if it's
drifting. They are off by default: each one wakes Claude, re-reading its whole context, and the
10-minute default of significant tasks was 500K of one task's 1.2M input-equivalent tokens (the
2026-11-17 measurement); the pane shows the same progress to the user. Nudges, repeated
handovers and a base check cut short raise check-ins whatever the setting; a session that fills up
reading is a `reading:` line in the round's report instead.

**Progress checks** (`workbench/progress.py`, #95) are the user's opt-in: `wb progress on
[--after MIN]`, `wb progress off`, kept in `$WB_HOME/progress.json` `{on, after?, ts}`. A stored
`after` stays through a bare `on` or `off` (`set_enabled`: the pane's row runs them bare, and
each dropped a `--after 30`, #578) until `--after` is given again; `--after 0` clears it. Off, the
default, nothing below runs and the timing is the check-ins'.
- **Active work.** Each round adds its time, less Claude's answers and a frozen machine
  (`_Clock.ran`), to status `active_s`, on or off. Waiting for the GPU happens before a round,
  so it never counts. The results row carries `active_minutes`. All of it is per step: `wb next`
  records the active work so far as status `step_active_s` and sets `progress_checks` back to 0,
  so the checks and the ETA count the current step's work alone (`runner.active_so_far`), against
  a typical step's (#815: set against a chain's total, step 2 read "past its typical 12m" two
  minutes in, and woke Claude for a step going normally).
- **The check.** It fires when active work passes the threshold, then twice it, four times it
  and so on, once each (`progress.due`, `progress.passed`, status `progress_checks`: the points
  passed), and never while asking. The threshold is `--after`, else the typical length for the
  task's size and model (`progress.typical`, `progress.threshold`): the median of their
  `active_minutes` a step (`active_minutes` / `steps`, `tuning._step_minutes`; `router.expected`,
  active against active, #543, #815) once `TYPICAL_MIN` (3) of them
  are timed, at least `FLOOR_MIN` (10) minutes; until then the size's `DEFAULT_MIN` (20 minutes
  trivial, 45 significant), which the check's text calls the default. With no history the checks
  never came though `wb progress on` said they would, and one 1.5-minute task made every whole
  1.5 minutes a check, each waking Claude (#724). `wb progress on` and the pane's row name the
  defaults (the pane's sentence repeats `DEFAULT_MIN` and `TYPICAL_MIN`: change them together). The check
  is a `checkin` notice (`progress: true`): the check-in digest, then `progress.text`. That is
  the active minutes against the threshold, the evidence (files changed, whether any changed
  since the last check: status `progress_mark`, a `gitops.mark`), the round's failed tool calls
  and the last tests, and one recommendation with its command. The recommendation is a targeted
  hint (`wb steer --text`) or a smaller step (`wb steer --now --step --text`: the note opens with
  `STEP_NOTE`, do only this, then stop and report).
- **The recommendation.** Once both kinds were tried `MIN_TRIES` (2) times on the model, it is
  whichever helped more there (`progress.recommend`). Before that, it is a smaller step when no
  file changed since the last check, else a hint.
- **What it never does.** It never authorizes an edit: the check says the coding choice stays
  as the user set it, and nothing in it reads or writes `coding.json`. Only `wb coding` changes
  it.
- **Learning.** The first `wb steer` after a check (status `progress_open`) is recorded in status
  `interventions` `[{kind: hint|smaller, ts, round, step}]`, and from there in the results row.
  `progress.helped(model)` (`helped_by_model(rows)`, every model in one pass; over the rows
  `tuning.judged` keeps, as the Stats feed's are, #647) counts, per kind, the tasks it was tried on and those accepted without
  a takeover (`tuning.agent_landed`); the next check cites them ("on this model before: a hint helped 3 of 4").

**Stats recording** (`workbench/stats.py`, #404) keeps what only the pane's Stats tab reads, so
its history has begun before anything draws it. The user's rule (2026-11-20): a measurement that
costs nothing is on by default, and every one can be turned off. It is on unless stats.json says
`recording: false` (`wb stats set recording off`), and costs a few bytes a task: no process, no
model call, nothing that wakes Claude. With it on:
- each round's end is an event, `round_end {secs, how, guard?}`: `how` is `done`, `stuck`,
  `handover` (the window filled, a fresh session goes on), `interrupted` or `failed`
  (`runner._round_end`). No reader shows the kind, so the transcript, the pane and `wb log`
  are unchanged;
- the guard that stopped a round is named (`repeat`, `errors`, `no_edit` from the stuck
  detector's `guard`; `round`, `silence`, `think` (after a nudge) and `handovers` from the
  runner) and counted in status `guards`;
- `measure_speed` keeps the task's own speed samples beside speed.json's, with each request's
  time to first token (`router.speed_samples`), in status `speeds`;
- the results row gets `results.for_stats`: `started_at`, `load_secs`, `setup_secs`, `nudges`,
  `asks` by kind (and `answered`: status `answered`), `guards`, the median `speed` and `gpu_w` `{mean, peak}`, each only when
  measured. `_Power` keeps its readings' sum, count and peak for it (status `gpu_w_*`), on or
  off: it reads them anyway.
Off, none of these are written. What the router, tuning, savings and progress read is not
part of the setting. `live` and `every` are the Stats tab's live view (`wb top`).

**The Stats feed** (`stats.feed`, `wb stats --json`, #405): everything workbench has learned, as
one object for the Stats tab's history, built from what already computes it. Rows are
`store.results()` that `tuning.judged` keeps (no trials, no spec-gap discards, no task whose
agent never ran), except where Claude's cost is counted (the periods' savings, the saved
milestones): there every row but trials. A section with
nothing in it is left out, never zeros, so a new install's feed is `{ts, until, settings, tasks:
0}`; `until` is the next local midnight (`_midnight`): the streak, days and periods are counted
from today, so the pane reads the feed again once it passes.
Keys: `periods` (`week`, `month`, `all`, `savings.PERIODS`: tasks, landed, `accepted_pct`,
`active_minutes`, and `savings` (`savings.totals`, over every row: a spec-gap discard cost Claude
too) with its `score` once a task can be compared, and `spec_gaps`, the spec-gap discards its
saving counts and its task count doesn't, said beside it, #569; and `energy`, `{wh, cost?}`: the
GPU watt-hours of every row in it that measured them, `gpu_wh`, compared by the saving or not,
another machine's GPU left out, with the cost once a price is set: the saving's `wh` counts only
the rows it compares, and the tab drew that as the period's, 12 Wh of 287, #568),
`streak` (`{current, best, days}`: local days in a row with a task landed; the current run ends
today or yesterday, else 0, and `wb stats` then names only the best: a run that ended is never
mentioned), `bests` (`largest_first_try`: the most lines landed with no review round the agent caused,
`tuning.agent_reviews`, as skills.py counts first try, whatever rounds the runner added
(self-review, a handover, a steer: the round counter kept every default `--test` task out, #550);
`fastest`; neither counts a task with a step Claude took over, `took_over`: Claude's lines were
the agent's best, #566), `milestones` (`[{kind: landed|saved, n, day}]`: 1, 10, 25… tasks landed; 100K, 1M…
Claude tokens saved by the estimate, over every row as the periods' saving is: over the judged
rows alone a milestone showed that the all-time saving never reached, #569), `absorbed` (what never reached Claude: `auto_fixes` (the
rounds, whatever came of them), `auto_fixed_tasks` (their tests then passed), `handovers_landed`),
`questions` (`{asked, answered}`: a question's notice wakes Claude, so it isn't absorbed;
`answered` counts only what `wb answer` answered, never a NO_ANSWER: a timed-out question was
"answered mid-task", #562),
`models` (per model: the `wb stats` columns as numbers, `claude` (weighted, mean), `speed`
(`router.speed`), `write_trend` (`[[ts, tok/s]…]`, the newest 30 rows' own `speed.write`) and,
from `TREND_MIN` 6 rows, `write_change_pct`: the newest third's median against the oldest
third's), `model_lines` (what the tab draws, #638: `{lines: [{model, variants, windows, last,
…the same}], older: {models, tasks}}`: the models OpenCode has now (`models.discover`), a `wb
optimize` variant folded under its source (models.json `variant_of`, a retired variant's too),
an id the model had before folded under the one it has now (`renamed_from`, or an id gone from
the config on the Ollama digest a configured one's rows ran on: #818),
the most recently used first, its speeds the newest variant's; a model no longer configured or
with no task in `stats.OLD_DAYS` 90 days is counted in `older`; `models` keeps every one
split), `sizes`, `stacks` (`{tasks, accepted_pct}`), `days` (the last 30 local days: `{day,
tasks, landed}`; the streak's and the days' arithmetic is on local dates, never `now - 86400`, which
skipped or repeated a date across a daylight-saving change, #563), `guards` (summed), `helps` (`progress.helped`, per model tried), `bench` (each
model's newest finished run: `{run, day, passed, of}`, the cases passed of those graded; a newer
run still going or stopped is `partial`, `{…, planned, running}`, beside it, never in its place:
its first graded case read as the model's "1/1", #570. A run is finished for a model once each
replay its plan.json gives it, times `repeat`, has been graded or failed to start; a run with no
plan counts as finished) and `optimized` (optimize.json's `{window, fits,
spill, ts}` per model). It reads results.jsonl once and passes that snapshot down (each period's
savings and each model's helps read it again: 16 reads of a 4,800-row history, 3 s at 20,000 rows,
#565; `helps` is `progress.helped_by_model`, one pass over the judged rows); about 0.4 s at 10,000
rows here. `feed(only=...)` builds just those sections: plain `wb stats` asks for `stats.SUMMARY`,
what `summary` shows.

**Taking over.** `wb takeover <task>` stops the agent and sets `review` ("Claude took over"):
Claude finishes in the worktree, leaving it uncommitted (accept commits it with the provenance
trailers), and accepts, or hands back with `wb feedback`. A commit Claude made there by hand is
accepted as it stands (no trailers). `wb stop <task>`
just stops it (`stuck`, "stopped by the reviewer"; the worktree is kept), and `wb resume <task>`
continues a stuck or failed task in a fresh session with `RESUME` and what the step's rounds asked,
not counted as a review round.

## Context, on both sides

Local models work in a small context window, and so, in its own way, does Claude.

**The agent's.** Rounds continue one OpenCode session. The runner reads the context every step
reports and hands a full session to a fresh one with exactly what it needs (*The runner, inside*:
the handover point, the two checks, the handoff prompt). OpenCode's compaction is set as a backstop
at least a step's growth past the handover point (#644). Reports show the fill (`agent context: 19.4K of 32K (60%)`) so
Claude sees it coming. `wb feedback --fresh` (or `wb next --fresh`) forces a fresh session (a
confused agent); `--keep-context` asks to keep it at the next round's start. A session stays
bound to the directory it was made in (continued or forked from another worktree, the model is
still told the first one), so context carries over only within a task (rounds, `wb next`), never
to a new one.

**The slice.** How much one task should hold on a model is learned like the router's choice
(`router.slice`). The first guess scales with the window it is served: three files and about 150
new lines on 32K (what was measured), proportionally more on a bigger window, up to four times
that (`GUESS_MAX`). Each step that closes (`wb next`, `accept`, `discard`) records its files and
added lines (`results.step`) and how it went: badly when its session was compacted or filled up
reading before any change, the agent got stuck, or it needed two review rounds the agent caused
(`BAD_REVIEWS`; a round marked `--spec-gap` is Claude's, not the agent's); well when it landed
short of that. A handover is counted but not held against the step: it is how the runner gets
through a big one, and its cost shows in the task's time. The latest steps say how the model
does now: the smallest of them that went badly lowers the slice below its size, and the size most
of the good ones reached raises it past the guess, unless the steps that big mostly went badly
(#720: the biggest good step ever once set it for good, a lockfile bump or a rename across 30
files at that). `wb models`,
`wb start` and `wb scout` show it (`slice: ~3 files, ~150 new lines per task (32K window; 4 of 5
measured steps went well, 1 badly)`). Check-ins and reports name changed files the spec never
mentions (`NOTE: the spec doesn't name src/util.c`; a brace form like `src/io.{h,c}` names each
file), where an agent's drift shows first.

The window itself comes from what the server serves the model (*Managing the set*): `wb model add`
writes it, with an output budget of an eighth, and `wb doctor` flags an entry that claims more
than the server serves (prompts would be cut off) or less (tasks could be bigger), or has none.

**Claude's record as a spec writer.** Most review rounds trace back to the spec: a rule with no
test, two rules that conflict, a name taken from memory. The skill has a checklist to go through
before `wb start`. When a round was the spec's fault anyway, Claude says so with `--spec-gap
"what it missed"` (on `feedback`, `next`, `accept`, `discard`; stored in `status.spec_gaps` as
`{round, text}` and counted in the results row). That becomes a `spec` lesson for Claude's own
checklist, not an agent skill, and `wb start` shows the record as the next task goes out
(`results.spec_gap_line`: `your specs: 2 of the last 10 task(s) needed a round for a spec gap;
last: …`).

**Self-tuning** (`workbench/tuning.py`). A setting whose best value depends on the model is
learned per model and window on this machine, not fixed. `KNOBS` holds them; the first is
`fresh_at`, the handover point (default 0.6, candidates 0.4 to 0.8). Earlier means more fresh
sessions, each re-reading files; later means working in a crowded context, where a model gets
sloppier. The second is `self_review` (default 1, on; candidates 0 and 1): the agent's own review
round (*4. Tests*), which costs time and pays when it spares Claude a review round. A flag Claude
sets for one task (`--self-review`/`--no-self-review`) wins over the record and a pin (`tune`'s
`fixed`), and that task is evidence for the value it ran. `tune(task, ceilings)` picks each knob once per task (`status.tuned`, with
`status.explored` and `status.tuned_max`): usually the best value so far, while one task in five
(`EXPLORE`) tries the value next to it. When a task closes, its value scores the result (`reward`),
per step so a chain is set against single tasks fairly: 1 for accepted (`agent_landed`: a takeover's accept is Claude's and scores 0, #647), divided by one plus the
review rounds the agent caused a step (every step's, over the steps), less
`COMPACT_PENALTY` 0.25 if OpenCode still had to compact, and up to ± `SPEED_WEIGHT` 0.15 for being
faster or slower a step than that model's usual step of the same size, both in active minutes (the
median; the wall clock counted the wait for Claude's review as the agent being slow, #543; pooled
over sizes, every trivial task beat the median, #721). Discarded scores 0; a discard Claude marks
`--spec-gap` is its own miss and counts for nothing, here or in the router's and the skills'
records (`judged`). A knob that acts only on a filling session (`Knob.fills`: `fresh_at`) counts
a task only when one of its sessions reached the smallest allowed value (`tuning.acted`, from the
row's `peak_share`; a row from before it was recorded counts): most tasks never fill 40% of the
window, and one fast trivial task at 0.5 flipped the pick, one discard flipped it back (#721).
A knob that acts only after a round whose tests passed (`Knob.passed`: `self_review`) counts a
task only when one did (the row's `self_review_due`, set by the runner whether or not
self-review then ran; a row from before it, only when its last tests passed, `tests_ok`): a task
without `--test`, or whose tests failed through every auto-fix, ran alike under 0 and 1, and its
noise could turn self-review off for the tasks it exists for (#816).
Each value's mean is smoothed toward the others' (`PRIOR`, two tasks' worth), and a value other
than the default can be the pick only once `TRY_MIN` (3) tasks ran at it (an untried value sits at
the pooled mean, so any one task above it won), so one lucky task moves nothing, and the pick
walks one step at a time toward whatever scores best. Values past the model's ceiling (`runner.fresh_ceiling`: one step's growth, at least
`tuning.CEILING_MARGIN` 0.05 of the window, before OpenCode's compaction, #644) are never tried (a
window under `models.MIN_WINDOW`, 16K, which would leave none, is refused instead). An output cap
that is a large share of the window can put the ceiling under every value: then the ceiling
itself is the only one, and the smallest value when that isn't positive (the smallest stood
before, past the compaction, so every long step compacted: a 16K cap on 32K compacts at 0.375,
#595, the audit of 1.90); `runner.handover_warning` says so, a `note:` in `wb start` and a `--`
line in `wb doctor` ("its output cap … puts OpenCode's compaction at N% of the window, under a
step's growth past the earliest handover point"; at `HANDOVER_ROOM` or under, "no handover
fits"), and
`optimize.budget` cuts such a cap to a quarter of the window. Trial
runs aren't evidence. `wb tune` shows each model's record and pick; `$WB_HOME/tuning.json` pins a
value (`{"fresh_at": 0.6}`, used as given, ceiling or not). A new knob: add it to `KNOBS`, read it
with `tuning.value(task, name)`.

**Claude's.** `wb` holds the delegation state, so Claude's context doesn't have to. Whoever
compacts Claude's conversation while this session's tasks are open in a session that delegated
(the engine, `/compact`, the mod), the mod tells the summary to
keep the user's goals and decisions, the tasks and what each needs next, and to drop finished
tasks' diffs and reports. At a task boundary in workbench mode (one of this session's just closed,
none waiting for Claude) the mod
compacts early once Claude is halfway to the engine's own compaction (`WB_COMPACT_AT`, a
percentage; 0 turns it off), so a long session sheds detail at a clean point instead of
mid-review. A session that never delegated is never compacted for a task (the 2026-11-16 audit:
a task closing compacted every session). After a compaction or `/clear`, a context block lists
this session's open tasks from `wb status --repo <its directory> --session <id>…`.

**What Claude learns about the user** (`wb notes`). Claude Code keeps its own memory per project,
so what Claude learned about how the user likes delegation run in one repo would be gone in the
next. When the user says something that holds anywhere (their review bar, whether to merge, how
much to ask them), Claude keeps it with `wb notes add "…"` (one sentence, at most 300
characters; at most 20 notes) in `$WB_HOME/notes.md` (`- ` lines, under `notes.lock`). Every
session in workbench mode, in any project, is handed them in a `user-notes` block (or, when the
mode came on after the first message, with /workbench's text or a row of their own: #540). `wb notes`
lists them and `wb notes drop N…` removes ones that have stopped holding. A fact about one repo
goes in its CLAUDE.md instead.

## Waking Claude, exactly once

The runner appends notices to `$WB_HOME/notify.jsonl` (`Task.notify`: `{ts,
task, kind, text, round?, id?, cause?, tasks?}`; `cause` on a `stuck` or `failed` notice with a round:
`guard` (a guard stopped it), `agent` (OpenCode exited non-zero), `server` (the model's server gone again after the round's revive, #657), `updated` (workbench updated under the task, `runner._updated`: #660), `opencode` (OpenCode changed under it or 1.x, `runner.opencode_moved`: #866), `signal` (a
SIGTERM from outside wb, `SIGNAL_STOP`), `died` (`reap`, a restart's batch notice too) or `update`
(`wb update --stop`, `cli._stop_for_update`: one `stuck` notice per owner, #694); `tasks`:
a restart's, a shutdown's or `wb update --stop`'s batch, below and in *The runner, inside*). Kinds: `review` (the round report and `review_diff`), `stuck`, `failed` (the round report as text;
a load failure or crash without a round), `question` (with the question's `id`), `checkin`
(periodic, a nudge, the mid-round handover before the last a round allows, a
base check whose `--test-timeout` cut it short). `wb` itself writes only
these: `reap`'s `failed` for a runner that died without a report (or one for a restart's batch),
and `wb update --stop`'s `stuck`, one per owner with `tasks` and `cause` `update`
(`cli._stop_for_update`, #694); the runner raises a shutdown's. The agent never writes one: the
file is out of its lane (the 2026-11-16 audit: it could forge any task's wake, or wipe them
all). Readers take its rows through `store.notices()`, which keeps only whole ones (a dict with a
`NAME_RE` task, a kind, a numeric ts): one row without a task once made every acknowledging
command raise. Each task's `acked` file holds the time up to which Claude has had its news, and
its `noticed` file the ts of its newest notice (`Task.notify`, for each task a batch names too:
the mod's idle net knew it from notify.jsonl's last 1 MiB only, and after a reload woke Claude a
second time for a review whose notice had left that tail, #844).
A notice's `ts` is the clock's, but later than every notice before it and than its task's
`acked` mark, under the file's lock (`append_jsonl(…, after=)`, `store.newest_ts`): a clock
corrected backwards (a dual boot with a local-time RTC) put a notice raised after a mark at or
before it, and `wb wait`, the mod's wake and its idle net skipped it as handled (#473, the audit
of 1.8). `Task.notify` returns the row as written, and a batch's other tasks are acknowledged up
to that stamp, never below their own mark (`store.ack_batch`, for a restart's, a shutdown's and
`wb update --stop`'s batch): acked at the stamp asked for, a batch whose stamp was moved (a notice
in the same millisecond, or one dated ahead after a backward clock step) left each below its
`noticed`, and rewake woke Claude once a task (#874, Claude's audit of 1.90.24).

- **Ears.** The mod runs `wb events`, which prints a line the moment anything in the state
  directory changes (*Waiting without polling*). Each line makes the mod re-read the tasks.
- **Still true.** For each task, the newest notice under an hour old and past its `acked` mark
  (and every question past it: two asked at once are both open) is delivered only while it's
  still true: a check-in while the task is queued, running or testing; a question while the
  phase is `asking` and its `ask/<id>.json` has no `<id>.answer`; otherwise while the phase matches the kind. A stale one (a
  review for a task since discarded or sent back) is acknowledged and dropped.
- **Held mid-turn.** While Claude's main loop is mid-turn (`mem.busy`, set by `turn.start` or the
  model's own `tool.call`) the wake is held (a prompt submitted then would queue and arrive stale)
  and checked again on every poll, and after the turn even if notify.jsonl hasn't changed. A
  question (a PERMISSION request too) doesn't wait: its agent is blocked, and after the ask timeout
  (`--ask-timeout`, 1200 s) it guesses, so it goes into the running turn (`session.send`, as a web
  message does, with MIDTURN_NOTE saying whose it is); only if that is refused is it held, and one
  held that the runner then answered with `NO_ANSWER` (timed out unseen) wakes Claude after the
  turn with the question and that the agent assumed (MISSED_NOTE), not a silent ack (#542). Otherwise
  the mod writes `acked` first, shows a toast, and submits
  a prompt: `[workbench] Task <n> <headline>.`, the notice's text, and the next commands to run
  (`NEXT[kind]` in `register.tsx`; a question names its `wb answer <n> --id <id>`, a PERMISSION
  question the `wb allow` that answers it). A batch's notice (a `tasks` list: a restart's or a
  shutdown's) wakes as `[workbench] Tasks <a>, <b> were interrupted.` (one: `Task <n> was
  interrupted.`) and ends with `BATCH_NEXT`, the resume, not the failure's `wb log`, feedback or
  discard (#544). A prompt the engine drops (a settings hook's block, a
  Stop, a host limit) puts `acked` back (unless something acted on the task since), toasts, and
  the safety net tries again a minute later.
- **Acting acknowledges.** `feedback`, `next`, `answer`, `allow`, `note`, `resume`, `takeover`,
  `accept`, `discard` and `stop` (one task or `--all`) acknowledge the task (`cli._ack_all`), but
  the mark stops just short of news still true: when an unacked notice of the kind the phase
  stands for exists (`question` while asking, `checkin` while queued, running or testing, else the
  phase's name), the mark stops before the oldest one, else it moves to now; it never moves back.
  A note written seconds after a failure once swallowed the failure notice for an hour. The
  commands that handle the news themselves (`answer`, `allow` answering a request, `feedback`,
  `next`, `resume`) move it to the moment they acted instead: everything before is handled (an
  answered question once came back from `wb wait`), and what the new round raises isn't; while
  the task is asking, it still stops just before the notice of another question still open
  (answering the first of two acknowledged the second before anything delivered it).
- **The safety net** (`rewake`). A task that has waited on Claude (review, asking, stuck, failed)
  for a minute after its last status change with its newest notice not acknowledged (any notice in
  notify.jsonl's tail counts, however old, so one delivered before a reload isn't "lost", and the
  task's `noticed` mark for one past the tail: #844) wakes Claude
  anyway, once, with `wb report <n>` and the next commands.
- **Without the mod.** `wb wait [task]` blocks until there's news past a task's `acked`, prints
  `[kind] task` and the text, and acks it. It skips what the mod would (`_stale`: a review, stuck
  or failed notice whose phase has moved on, a question no longer asked, a check-in for a task no
  longer running; of a task's questions only the oldest still open (`_oldest_open`, judged by the
  answer files, since status.asking names an answered one until the runner's next tick: the 0.90
  review, when the second of two was skipped and the answered first given "again") is news, so
  they come oldest first), rows that aren't whole, and rows for a task whose directory is gone. It reaps
  dead runners first (`reap`), so their `failed` notice is what it delivers. A named wait on a
  closed task exits 2; on a task already waiting whose notice was taken elsewhere it prints it
  again "(already delivered once)" rather than block forever, and one stopped or taken over by
  hand, which has no notice, prints `[<phase>] <task> (no notice: <last>)`; a task failed as dead
  under 10 s ago without its notice yet is another `wb` reaping it, and the wait waits for the
  notice (it said "no notice", and the notice came again on the next wait). A bare wait with no
  open task exits 2. `--timeout` exits 2 when it passes.
- **Off switch.** The plugin's `wake` setting (`on`/`off`) stops the prompts and keeps the pane
  and the toasts; a `workbench-wake` context block (or the same note said later, #540) tells
  Claude no wake will come, so it doesn't end its turn waiting for one.

The mod runs in every Claude Code session with the plugin and the state directory is global, so
a session wakes, rewakes and compacts only for its own tasks (`mine`). `wb start` records the
Claude Code session whose Bash ran it (`CLAUDE_CODE_SESSION_ID`, task.json `session`), and the
mod keeps every id its process has had (`$.session.id()` at the start and at each poll, since
/clear and a resume go on under another; the `sessions` atom): a task with a `session` is the
session's whose ids hold it, wherever it ran. `wb start` also records that session's Claude Code
process (`CLAUDE_PID`, task.json `claude_pid`) and its start (`claude_start`, `models._started`);
once it is gone (no `/proc/<pid>` where there is `/proc`, else `kill -0` fails: a container without
procps has no `kill`, and no gone process was ever seen, #700; or the pid now runs a process that started at another time:
a recycled pid, #532; the mod's `noteClaude`, a live one asked at most every 30 s, a gone one
final; `cli._gone`, `models._alive`; never one recorded on another machine, task.json
`claude_machine`: its pid means nothing here, #922), the task is
also claimed by directory, so a new process in the project adopts the earlier one's tasks (the
0.90 review: after a crash or an update, plain `claude` in the same repo got a new session id
and was woken for none of them, and its quit left them running for nobody). The claim is
recorded, and the first claimer wins (#687): the mod knows its own Claude Code process from
`wb events`'s hello (`parent`, `parent_start`: the events child's parent; `machine`,
`store.machine`) and, for an open task
whose recorded process is gone and that it would own (near it, or its own session id stamped by
an earlier process of the session, as after `claude --resume`), runs `wb adopt <task> --pid <its
process> --session <ids…>` (the mod's `claim`), which, under the task's command lock, rewrites
task.json's `session` (kept when it is one of the given ids), `claude_pid`, `claude_start` and
`claude_machine`,
and refuses (exit 1) while the recorded process lives; the mod re-reads task.json either way, so
every other session sees a live process and drops the task (before, once the starting process
ended, every nearby session and the resumed one owned it for good, and both woke for its
review). The wake itself is a compare-and-set too: before a wake the mod runs `wb ack <task>
<ts>`, which moves `acked` under the task's `ack` lock only if it is below `ts` (`cli.claim_ack`,
shared with `wb wait`), and exit 3, taken already, wakes no one; a `wb` that can't run leaves the
mod's own write to decide, which only ever raises the mark (`raiseAck`: written plainly after a
take, it lowered a mark claimed since, #786). A wake taken but not delivered (the engine dropped
the prompt, or the running turn refused a question) goes back through `wb ack <task> <prev> --if
<ts>` (`cli.release_ack`, the mod's `release`): under the same lock, only while the mark is still
the `ts` this session set, exit 3 otherwise; the unconditional write put the old mark back over a
notice claimed meanwhile, delivered twice then (#786). A `wb` that can't run leaves the
check-then-write. Two live sessions
in one repo keep their own; a task with a `session` but no `claude_pid` stays its session's. One
without a `session` (started by hand, or before 0.90) goes by directory: its `repo` is the session's directory or inside it, or the session's
directory is inside the task's own spot (its package, `repo`/`subdir`; else its `cwd` when that is
inside the repo; else the repo: `spotOf`, the same in `_scope`; inside the repo alone, a session in
a monorepo's sibling package was woken for another package's review, #695), or its `cwd` (where
`wb start` ran) is the session's directory or inside it, compared by whole path components of
real paths (wb records `cwd` from getcwd and `repo` from git's toplevel; the mod resolves its own
directory, `_scope` both sides), in lower case where the file system ignores case (the session's
directory found again with every letter's case swapped: the mod's `mem.fold`, `cli._folds_case`;
the 2026-11-19 audit: a symlinked project, `/tmp` against `/private/tmp`, or `~/Repos` typed for
`~/repos` on macOS missed); a session in the home directory or `/` claims none by directory; a task with neither key is
everyone's. (The 0.90 review: by directory alone, a task started from `~` for one repo was
every session's under `~`, and one started after a `cd` elsewhere was no session's, so nothing
woke Claude for it.) Another session's notice is toasted at most
and left unacknowledged for its own session or `wb wait`. `wb status`, a bare `wait`, `stop --all`,
`takeover --all` and `resume --all` run from Claude Code's Bash without `--repo`/`--session` take
the calling session's scope the same way (`cli._caller`: `CLAUDE_CODE_SESSION_ID`, the ids in
`claude-sessions/<CLAUDE_PID>` under this process's own start, not a dead one's with the same
pid, #787, the directory it runs in; `--all-sessions` for everyone's, as a
terminal gets): plain `wb status`, which the skill and the compaction note send Claude to, listed
every session's tasks as one (#693). Among sessions a task belongs to, the
first to deliver a notice wins. A session with no person at it (`claude -p`, the SDK) does
nothing until a surface attaches.

## Seeing what the agent does

- **The pane** (opened by `/workbench`, or once per load when a task runs, and closed by a quit command;
  `/workbench` run again brings it back) has three tabs, **Tasks**, **Stats** and **Settings** (Buttons on its
  last line, keys `1`, `2` and `3`: Stats in the middle, looked at more often than Settings; last, since the pane follows its end and a row at the top scrolled
  away under a long transcript). Closed by the user (its mark, Esc), it is minimized, as
  backseat-driver's is (2026-11-19): a strip above the prompt stands in for it while workbench mode
  is on or the session has tasks, `▸ Workbench`, `Tasks`, `Stats`, `Settings` (each a way back, to that tab)
  and the status line's summary; a press there or `/workbench` brings it back; a quit command
  clears it, and a module reload doesn't reopen a minimized pane. The Tasks tab lists every task: phase, round, model, test result, age and
  its last few events. Under the list it follows one task as a live transcript: the one it
  follows while that one is queued, running, testing or asking, else the newest started that is
  running, testing or asking, then queued, else the newest waiting for Claude (choosing by the
  latest status write swapped between two running tasks on every tool call), scrolling with the
  newest lines unless the user scrolls up. At its foot stands the apprentice, the local agent
  drawn as a small robot in a hard hat: it swings a wrench while it works and raises its arms when
  a task is ready for review; its chest lamp is the phase's colour, and its speech bubble says
  what it is doing now and how long the task has left, or at a handoff who acts next ("Local tests
  passed on <task>." / "Claude reviews next.", "Claude answers next.": #103, where "done" read as
  tests passed, accepted or landed alike). The transcript's last line says the same once
  (`■ done: Claude reviews next`), and status `last` (`tests passed: Claude reviews next`). A short pane gets its face on one line
  instead. Then the week's saving (`savedLine` of `wb savings --json`, read every 10 minutes
  and again when a task closes: `this week: saved ~1.2M Claude tokens (46%, estimate) · 0.9 kWh`, with `, cost 0.27` once a
  price is set, labelled as on the Stats tab and in `wb savings`, with no currency sign since the
  price is the user's (#609: the cost never showed here, was a bare `(0.27)` on Stats and `($0.27)`
  in `wb savings`); nothing until a task can be compared). The web chat's link is the Settings tab's alone, under
  its rows while the chat is on (never under the tasks: the user, 2026-11-19).
  The Settings tab (`settingRow`, after backseat-driver's: a Select there opened on a click and
  could pick nothing, and its sentence followed only the saved choice, the user 2026-11-19) has
  one row per setting, a Button naming its value (`▸ Claude coding: Let Claude decide (default)`, key
  `coding`; `▸ Web chat: Off (default)`, key `chat`; the default option says so, to show how it was at
  the start, the user 2026-11-19); a press opens its options under it as Buttons (keys
  `coding:only|ask|decide`, `chat:off|on`, `probe:off|on`, the chosen one marked `❯`), picked by a click or Enter
  on the ring, and a pick folds the row again; the option already chosen only folds it, running
  nothing (#578: picking On again ran a bare `wb progress on`). Under them, the sentence of the option the ring is
  on (the `ui.focus` hook keeps it in the `pane` atom), else the chosen one's; the pointer on an
  option lays its own sentence over it (a hover reveal: `display: "none"` Boxes, absolute, under
  the option's hover scope, since no hook runs on hover). **Claude coding** (#93, *Claude coding*):
  `Only when I say`, `Ask me first`, `Let Claude decide (default)` (`CODING_STOPS`); a pick runs `wb coding
  <mode>`, and each draw reads `coding.json` again. **Web chat** (`CHAT_STOPS`, both saying what it
  is: `A localhost web server to interact with Claude.`): `Off (default)` and `On`; a pick runs `wb chat on|off` and reads the switch and the link back at once.
  **Agent code navigation** (`PROBE_STOPS`, key `probe`, options `probe:off|on`,
  *Experiments*): `Off (default)` and `On`; a pick runs `wb experiment probe off|on` (`setProbe`), and each
  draw reads `experiments.json` again (`probeMode`; no file or no `probe` key: off). The row says
  whether it works, since it read `On` while nothing changed (the user, 2026-11-20): while it's on,
  the Settings tab asks `wb experiment probe` (`probeStatus`, at most every `PROBE_RECHECK_MS`, 30 s,
  and again after each pick, so a probe installed meanwhile shows) and the option reads `On, working`
  (its sentence naming probe's version) or `On, not set up` (`probeStops`; wb's answer unreadable:
  plain `On`). Turned on, a toast says how it came out: on and working, or on but not set up, which
  also queues `PROBE_SETUP_NOTE` for Claude (once while it waits): wb's line, then offer to set
  probe up with the user's yes, from its release page, and check with `wb experiment probe`. A
  failed `wb` call is a toast of its last line.
  The Stats tab's (#406), each a `wb` command, the mod writing no setting itself:
  **Stats recording** (`RECORD_STOPS`, `On (default)` / `Off`: `wb stats set recording`,
  *Stats recording*), **Live view** (`LIVE_STOPS`: `wb stats set live`), **Live refresh**
  (`EVERY_STOPS`, `1 s`, `2 s (default)`, `5 s`: `wb stats set every`), each read back from
  stats.json (`statsSettings`, a mistyped value its default); **Progress checks**
  (`PROGRESS_STOPS`, `Off (default)` / `On`: `wb progress on|off`, read from progress.json
  (`progressSettings`); off by default because each check wakes Claude; with a threshold kept
  there (`wb progress on --after N`, `after` a number other than 0) On reads `On, after N min`
  and its sentence names it (`progressStops`), where it said "its typical length", #578); and **Electricity price per kWh**, an Input (key
  `price`) that runs `wb savings --price X --json` (`setPrice`, through `parsePrice`: one comma or
  point as the decimal separator, a currency sign or code of up to three characters before or
  after, decimal digits only; anything else, `0x10` and `1e3` among them, is refused with a toast
  before wb is asked; an empty submit runs `--price off`, clearing it: #609, where `0,30` and
  `€0.30` were refused with no hint why and a price could never be removed), shown from `wb
  savings --json`'s `price` (`priceOf`, `mem.price`). The ring's sentence follows any of these rows
  (`SETTING_ROWS`).
  The rows go Claude coding, the Stats tab's, the price, then apart, under the heading
  `Experimental · may change or go away`, Web chat and Agent code navigation: the two that may
  change or go away, kept off the settings here to stay (the user, 2026-11-21; the probe row's
  title said `(experimental, may go away)` until then).
- **The Stats tab** opens with **Now**, the live view (#408): `wb top --json` drawn by `liveLines`,
  a line per GPU (memory and busy % as bars, `bar`, in eighths; watts; busy's sparkline since the
  tab opened, the last `BUSY_KEEP` 60 samples, in memory only), a line per running task (phase,
  round, its time, tok/s, said `(last call)` when not live, context %), the rack (one line per
  model: resident, split, cpu, idle or can't run, where its memory is, its speeds and load time, the
  tasks on it) and the queue. A line longer than the pane wraps at spaces, the rest indented
  (`wrapParts`, colours kept): cut at the edge, a long GPU name took its busy bar, watts and
  sparkline. One child (`runTop`, read by `pumpTop`), started by `syncTop` only
  while the tab is shown, the pane not minimized and Live view on, checked at each poll, a tab's
  press, a minimize, a bring-back and a Stats pick; it ends (`stopTop`, `return()` on the stream) the
  moment any of those stops holding, and its own loop checks again at each line, so a pane put
  away by the engine ends it within a tick. `syncTop` does its awaits first and then checks and
  spawns with none between (`runTop` claims `mem.top` synchronously), and gives up when
  `mem.topGen` (bumped by each start and stop) moved meanwhile; `stopTop` ends every child in
  `mem.topKids`, not only the newest: a poll and a tab press at once started two, and a close
  ended only the second (#546). One that ended by itself (an exit, a stream error, nothing
  printed) is tried again after `TOP_RETRY_MS` 30 s, doubling to `RETRY_MAX_MS` 10 min until a
  tick comes; from its second run in a row with no tick, **Now** says why (the last line of its
  stderr: "This machine can't be read: …"), where "Reading this machine…" was all it ever said
  (#553). One its own loop ended because the tab was no longer wanted is not backed off (#552: a
  pane the engine hid and showed again 5 s later got no child for 30 s). `stopTop` and that break
  also clear the `top` atom, so a return says "Reading this machine…", never the old tick under
  **Now**. The Stats tab drawn with no child calls `syncTop` (the engine showing the pane again
  says so no other way), and `showPane` (`/workbench` again) and `restorePane` call
  `refreshStats` and `syncTop` once their open resolves (`paneBack`), not before, when the pane
  could still read as hidden. 
Live view off: no child, no **Now**. The newest tick is the `top` atom
  (`top-1`). Below it is the history (#406): `wb stats --json` (*The Stats feed*) drawn as one line a
  section by `statsLines`, `Label: text` with the label bold: this week and all time (the score,
  the saving or the cost (estimate), tasks, landed, the spec-gap discards in the saving, the
  period's `energy` and, with a price, its cost), the
  streak (only the best once a run ended), what the agents absorbed without waking Claude (the
  auto-fix rounds as attempts, "then green" only for the tasks whose tests passed), the
  questions (asked, and answered only as `wb answer` did), one
  line per model of `model_lines`, newest first, its windows beside the name when a variant
  folded in (`ollama/q (32K, 40K, 64K)`; tasks, landed, rounds, minutes, write speed with its trend as a sparkline,
  `spark`, and the change, Claude's cost a task), then "Older models: N older models: M tasks (wb
  stats --all)" (a feed without `model_lines`, an older wb's: a line per `models` entry), by size, the last 30 days as a sparkline, bests,
  the newest milestone, what stopped agents (`GUARD_WORDS`), what helps, bench (the last finished run, and "newer run k of N so far" beside it), the optimized
  windows. A section with no data is left out; a feed with no section at all (a new install's)
  says to delegate one with /workbench, while one with no judged task but an optimized window,
  a bench result or a period still shows them (#549). It is read (`refreshStats`) only while the tab is shown (`pane.tab` and `$.ui.panes()`
  `isShown`): on each press of the tab, then at each poll when the size or mtime of a file the
  feed is made from changed (`$.fs.stat`, the key kept with the feed: results.jsonl, stats.json,
  optimize.json, bench/runs.jsonl, speed.json and the price's savings.json, `mem.savingsFile`:
  with the first two alone, `wb optimize`, a bench run or a price left the tab stale for good,
  #549; and each `machines/<id>/`'s optimize.json and speed.json, a network home's, #894), when the feed's `until` (its next local
  midnight) has passed, and after a Stats setting is picked; and once in each load
  (`mem.statsLoaded`), since the atom outlives a reload. A read that fails or times out keeps the
  last feed and is tried again after `STATS_RETRY_MS` 60 s, doubling to `RETRY_MAX_MS` 10 min
  (a press of the tab tries at once), and the tab says why (`statsLines`' `why`: "History
  unavailable: …" with no feed, "Not updated: …" above one): each 1.5 s poll ran it again, a full
  history read that kept a core busy on the hosts too slow for it (#553). Without the clock, an ended streak, last
  week's numbers and a 30-day chart ending days ago stayed until a task closed (#575).
  No timer: hidden, it costs nothing; shown, a stat per poll. The feed is the `stats` atom
  (`stats-1`).
- **The status line** reads like `⚒ wb · add-scores running r2 · fix-typo asks · 1 awaiting
  review`, or `⚒ wb · workbench mode` with nothing open. Outside workbench mode it counts only
  the session's own tasks (`mine`), and shows nothing without one: another session's running task
  filled it, and opened the pane, in a session the user kept off workbench (2026-11-17).
- **`wb watch [task]`** (`workbench/transcript.py`) is the same transcript in a terminal. It
  exports the session again only when the task directory changed (the watcher's wake) or status
  `session`/`updated_at` did, or `EXPORT_EVERY` (30 s) passed while the task is live; between
  them the clock is redrawn from the last export, every 1.5 s while live and every 30 s once it
  isn't (review, stuck, failed). It calls `cli.reap` every `REAP_EVERY` (60 s) while the task
  looks live. Left open over a review it ran an export every 1.5 s (#555).
- **`wb status`**, **`wb log [-f]`**, **`wb report [--round N]`** and **`wb diff [--stat] [--all]
  [paths]`** are the compact views Claude itself uses. `wb status` reaps a task whose runner died
  without saying so (`failed`), and marks one that died within the last `REAP_GRACE` with a `?`.

**The transcript** (`transcript.follow`). It merges, every loop, the OpenCode session export of
the current session and every earlier one (`status.sessions`) with the task's events, sorted by
time, each entry printed once (keyed by message and part; a part's `start` and `end` print
separately). `opencode session export <id> --standalone` runs from `/` (30 s); with no session
id yet, `opencode session list --standalone` in the worktree finds the one titled `wb: <task>`.
Both run standalone, like `opencode run`, so they never depend on the background service's fixed
port (another user's service there, or one with other XDG dirs, failed every export: the
2026-11-16 audit); a failure is said once per process on stderr (`opencode session export failed:
…`, in runner.log under the runner). Earlier sessions are finished, so `follow` exports each once.
The same export feeds the runner's between-rounds check and its speed samples
(`transcript.export`). Everything printed for a person passes `transcript.plain` first: control
characters other than newline and tab (C1 included) become `\xNN`, so an escape sequence in what
the agent read or wrote (OSC 52 sets the clipboard) never reaches the terminal raw; `--json`
needs nothing, JSON escapes them. `wb log` and `wb report` do the same on a terminal.

Drawn in Claude Code's own grammar, results under `  ⎿  `:
- prompts: a label (`Claude → agent · spec`, `· review feedback`, `· next step`, `· INTERRUPT,
  high priority`, `· note`; `workbench → agent · tests failed, sent back automatically`, `· fresh
  session: the task, the work so far, what's next`), matched by the prompt's first words, and the
  body under `  │ ` (40 lines, 10,000 with `-v`), with the protocol folded to `(+ the workbench
  protocol; -v shows it)`;
- `✻ Thought for Xs` and six lines of reasoning; `⏺` and each finished text in full;
- tools: `⏺ Bash(cmd)` with the output's tail (8 lines), `⏺ Update(path)` with `N line(s) added,
  M removed` and the diff (14 lines), `⏺ Write(path)` with its line count and content,
  `⏺ Read(path, from line N)`, `⏺ Search("pat", in p)` / `⏺ Find(…)` with the count and the first
  hit, `⏺ Skill(id)`, anything else as `⏺ name(input)`; errors in red; paths relative to the
  worktree; `ask_reviewer` calls are left out (its `ask`/`answer` events show instead);
- `⟲ OpenCode compacted the agent's context…`; `■ the model call failed: …`;
- after each model call, a step line: `⏱ N tokens in (M cached), read in Xs · K out in Ys · R tok/s`;
- the task's events: round headers, `■ tests PASS/FAIL (cmd)` with the tail, auto-fixes,
  questions and answers, `Claude (captain):` notes, steers, skills handed, allow, interruptions,
  fresh sessions and handovers, next steps, takeovers, stops, errors;
- a phase line on every phase change.

`-v` raises the caps (400 lines of output, diffs and reasoning) but still caps. Under the
transcript (on a terminal, one row rewritten in place): what's happening now (`activity`) and a
clock line:
- *Now:* queued: `Waiting for the GPU…`, or `status.last` itself while it checks the
  acceptance command on the base, waits for a named holder, sets the worktree up (`Setting up the
  worktree: npm ci…`: it read "Waiting for the GPU…" through a half-hour setup, #869), loads,
  reloads, starts, stops, unloads or shares a model (`Waiting for the GPU (held by t)…`,
  `Loading …`); testing:
  ``Running the acceptance tests… `cmd` ``; asking: `Waiting for Claude's answer…`; running: from
  the model server's `GET <root>/metrics` when it returns a `live` object (`{state, phase,
  prompt_tokens, generated, tok_s}`): `Reading the prompt… t · N tokens`, `Thinking|Writing… t · ↓
  N tokens · R tok/s`, `Model server <state>… t`; without one (Ollama), a rotating verb (`Thinking`,
  `Pondering`, `Tinkering`…) and the time since the newest message. `models._server_idle` reads
  the same `live.state`.
- *Clock:* `⏲ task T · round N t · model load t`, then while it runs (queued, running, testing, asking) the ETA (`~X left (typically
  Nm)`, `X past its typical Nm`, or no ETA yet; typical is `router.expected_minutes`, the median
  active minutes a step of this model's judged results of this size (rows without `active_minutes`
  skipped; a chain's divided by its steps, #815; those on the task's own weights, task.json
  `weights_id`, when it has one; read from the files alone, never the model's server: a whole
  `router.score` asked a sleeping LAN box for weights it never used, ~5 s each time the pane ran
  `wb watch --json`, #819), against the step's active work so far
  (`runner.active_so_far`: status `active_s` less `step_active_s`, plus the round under way): a mean of wall minutes held queues, reviews and nights before an accept,
  108 minutes for a 12-minute task, #543), `context U of WK (P%)` and tokens written.

A header first: the model line (label, reasoning effort, variant, context), repo, branch, test
command, and why it was routed there. Options: `--once` prints one pass and exits (as for a
closed task); `--no-color`; colour only on a terminal; with no task named, the newest-updated open
task, else the newest.

**`wb watch <task> --json`** (hidden) is the mod's feed: one pass, one JSON object per line,
`{"s": style, "t": text}` (UTF-8 unescaped), in this order: `meta` (the header's model line), the transcript
lines (styles `claude`, `agent`, `think`, `tool`, `out`, `ok`, `bad`, `sys`, `add`, `del`, `head`,
or `""` for prompt bodies), `activity` if any, `clock` (always), then the phase line. Each line's
text is cut to 2000 characters (`JSON_LINE_CHARS`), and `--last N` (hidden too) prints only the
newest N transcript lines (meta, activity, clock and the phase line always): the engine keeps a
command's first 4 MiB, so a long task's newest lines were the ones lost. One OpenCode export of
the current session per run (the first pass reuses the header's); each earlier session (status
`sessions`, before a handover) is exported once ever and kept as `tasks/<t>/.export-<sid>.json`
(`transcript.finished_export`: it never changes, and each run exported every one again, #691). The
mod runs it with `--last 2000` while the pane is shown: every 5 s while the followed task is
active, a status write in between kept for the next poll after that (each tool call writes one,
and each ran another watch back to back, #691), at once when another task is followed or the
followed one stops; cut at 4 MiB anyway, it keeps the lines it had and adds `transcript too long for the
pane`. It cuts each line to 2000 characters (`LINE_CHARS`), shows the newest 60,000 characters of history, puts `meta` under the
rule and `clock` under the speech, and uses `activity` as the apprentice's speech (the pose is
`work` when it starts `Writing` or `Running`, else `think`). A new style needs an
entry in the mod's `LINE_STYLE`; changing the shape needs a new `live-1` tag.

### wb top

`workbench/top.py` (#407): what this machine is doing, for anyone without the mod's pane, and a
feed for whatever draws one (`--json`). One long-lived process, like `wb events`, cheap enough to
tick every 2 s (`--every S`, from 0.2 to 3600, `cli.TOP_EVERY`: inf printed `"every": Infinity`, not
JSON, then overflowed `time.sleep`, and 1e-6 spun a core, #611; default stats.json `every`, else
`EVERY` 2), and nothing runs when
nobody looks: it exits when its parent process goes (checked each tick), and quietly (exit 0) on
SIGTERM, SIGHUP, a closed pipe, `q` or Ctrl-C, killing its nvidia-smi child. Never a model call,
a load or an `opencode session export`.

Each tick reads, cheapest first:
- **GPUs**: sysfs per card (`hardware.drm_cards`, connectors skipped, one entry per PCI slot):
  `gpu_busy_percent`, `mem_info_vram_used`/`_total` (an amdgpu APU, by `hardware.apu`, the rule
  `gpus` uses, adds its GTT, `unified`), the card's hwmon watts (`hardware.card_watts`, the readers `gpu_power_w`
  uses); the card's name from lspci once at start (`card_name`), never per tick. NVIDIA: one
  `nvidia-smi --query-gpu=index,memory.used,memory.total,utilization.gpu,power.draw
  --format=csv,noheader,nounits -lms <ms>` for the life of the command (`SmiStream`, found by
  `hardware.smi_path`: PATH, else WSL's), read line by line as it prints; a row older than three
  intervals drops out. Every card the `--query-gpu=index,name` asked at start named stays a row,
  its readings left out and `stale` set while it has none, and the first tick (and the one pass)
  waits up to one interval for the stream's first line (`SmiStream.wait`); a stream that ended is
  started again, after an interval, doubling to `SMI_RETRY_MAX` 60 s, back to one interval once it
  reads. Before the first line and after an exit (a driver reset, an Xid), an NVIDIA machine said
  "RAM (no GPU)" (#547). NVIDIA's sysfs cards are left out only when nvidia-smi named its cards.
  A card nvidia-smi gives no memory (`[N/A]`) on ARM (`hardware.shares_ram`, `gpus`' rule: a DGX
  Spark, GB10, a Jetson) shows the RAM it shares: `total` `MemTotal`, `used` `MemTotal` less
  `MemAvailable` (`hardware.memory`, one read a tick), `unified`; it showed load and watts but no
  memory (#572). An x86 card's `[N/A]` stays unknown. macOS: the GPUs from system_profiler once (no busy %); an Apple GPU's `total` is
  all of the RAM and its `used` the RAM in use (`hw.memsize` less vm_stat's free, inactive and
  speculative pages, `hardware.mac_free`; the sysctls read once, vm_stat every `PROBE_EVERY`),
  and its `limit` the budget's ceiling (`wired_limit`, else `models.unified_default`), said beside
  the bar as "GPU may wire N GB"; with no GPU listed the RAM row shows there too: it showed "use
  not said", and nothing when system_profiler failed (#574), then the RAM in use against the
  limit, so an idle 16 GB Mac read 104% in red with no model loaded (#701); WSL
  where nvidia-smi named no card (none, or one that fails): Windows' adapters once (names, and memory as `total` where the registry says).
  A sysfs card that reports nothing (no memory, busy % or watts: an iGPU on i915, a BMC's `ast`, a
  VM's virtio-gpu) is no row. When no row says a memory size (`total`) and none is `stale`, a RAM
  row follows, from /proc/meminfo (`RAM (no GPU)` alone, else `RAM`): shown only when there were
  no rows at all, any display adapter hid it on the CPU-only machines it was written for (#551).
- **Tasks**: every task's task.json and status.json, re-read only when one changes (`_Files`, by
  mtime and size), and a running task's newest `step` events (the last 64 KiB of events.jsonl).
- **The lease**: gpu.json and each remote pool's `gpu-<host>.json` through `models.holders` (dead
  pids dropped); `speed.json` through `router.speed`.
- **Every `PROBE_EVERY` (5 s), not every tick**: `models.discover()`, one `/api/tags` and one
  `/api/ps` per local Ollama, `models.status` for the other servers (their `/v1/models`, asked
  once a probe per base URL and key, `status(catalog=)`, `models._catalog`: 8 aliases on one
  llama-swap were 8 requests in a row, #561), and the `/metrics` `live` object of each running
  task's server other than Ollama (which has none). A model on another machine is not asked: no
  telemetry. Probes to this machine skip HTTP proxies (`models._open`). The loop (`--json`, the
  terminal) probes on a thread (`Top._probe_bg`, one at a time; the first waited for up to an
  interval, `PROBE_EVERY` at most), so a server that accepts and then stalls never holds the tick, `q` or the GPU rows;
  the one pass probes inline.
- **Typical load**: the median of the tasks' single loads per model (`models.single_loads`:
  status `loads`, else, for a task from before it, its `load_secs`), recomputed every
  `LOAD_EVERY` (300 s). Not the tasks' totals: a task that reloaded its 40 s model for each of
  four rounds read "loads ~2m40s" (#577).
- **Every `PROBE_EVERY` too, the dead runners**: each live task goes through `cli.reap` (as `wb
  events` does each minute), so a task whose runner died without a word (an OOM kill, a reboot)
  turns `failed` past `REAP_GRACE` instead of staying `running`, its round clock counting, while
  the lease view had already dropped its pid (#571).

`--json` prints one object per tick (sizes in bytes; a field the platform can't give is left out,
never 0):
- `ts`, `every`;
- `gpus`: `[{index, name, driver, used, total, busy (%), watts, unified?, limit?, stale?}]` (`limit`: an
  Apple GPU's wired limit, its `total` and `used` the RAM's; `stale`: a
  card nvidia-smi named with no fresh reading; the terminal and the pane say "no reading"), then `{name: "RAM (no
  GPU)" (or "RAM" beside GPU rows), ram: true, used, total}` when no GPU row says its memory;
- `running` (queued, running, testing, asking): `[{task, model, label, phase, round, round_s,
  tok_s, tok_s_from, read_tok_s, read_from, context_used, context_window, context_pct, last,
  remote?, server?}]`. `tok_s_from` is `live` (the server's `live.tok_s`, given only to a task in
  phase `running` that is the one running task on that server: a queued, testing or asking task,
  one of two running there, or an idle task while someone outside workbench used the server
  claimed its rate, #548) or `last call`: the
  newest step's output over the time since the step before it (or the round's start), a floor,
  since that time holds the prompt's reading and the tools' runs; `read_tok_s` is the model's
  median here (`read_from: "median"`); `server` is the `live` object as the server gave it.
  There is no first-token time: OpenCode's events carry none, and the session export that has
  one is not run.
- `rack` (every discovered model): `[{model, label, state, why?, gpu_bytes?, cpu_bytes?,
  write_tok_s?, read_tok_s?, load_s?, tasks?, server?}]`, `state` one of `resident` (all on the GPU),
  `split` (Ollama's `size_vram` under its `size`: part on the CPU), `cpu` (`size_vram` 0 where no
  GPU row says a memory size: all in RAM, `cpu_bytes`, the normal state of a CPU-only machine,
  shown as `split 0.0 GB GPU` in the warning colour before #551), `idle`, `can't run` (with
  status's `why`), `remote` (another machine: no telemetry); `tasks` the lease holders on it;
  `server`, a busy server's `live` object no task row claimed (two running there, or a request
  from outside), on one of its models' rows, the resident one first (the terminal: `server N
  tok/s live`; the pane doesn't draw it).
- `queue`: the lease's waiters, in line by `since` (the task's start): `[{task, model, since,
  waited_s, pool?}]`; `waited_s` is how long this wait has lasted (gpu.json `waiting_since`), not
  the task's age, which a task sent back for another round showed as hours ten seconds in (#573);
  `pool` for a remote server's.

On a terminal (without `--json`) the same view fills the alternate screen and is redrawn in place
each tick: bars in eighths (`▏▎▍▌▋▊▉█`) for VRAM and busy, models by their `label`, the card's
short name (`top.short`, the pane's `cardName` alike: lspci's last bracket when the name ends with
one, else what follows the last bracket, the vendor tag's, so a Phoenix1 or a "Device 1586" newer
than hwdata isn't shown as "AMD/ATI", #576; `(rev …)` dropped), sizes in decimal GB, colour only there; stdin in cbreak mode for `q`, restored on
exit. Ctrl-Z (SIGTSTP) puts the cursor, the main screen and the saved termios back before it
stops, and SIGCONT takes them again (cbreak, the alternate screen) and redraws at once (a wake
pipe in the `select`): it stopped with the shell's prompt over the frozen view and no cursor,
and after `fg` `q` needed Enter (#607). Taller than the terminal, the view folds the rack's
idle, `can't run` and `remote` models no task holds into one `+N idle, can't run or remote`
line (`top.FOLD`), and if it still doesn't fit cuts the middle (the GPUs, RUNNING, RACK) with
a `… N more lines` line, the QUEUE kept (`top.lines(snap, rows)`): it cut the bottom, so the
queue went first, with nothing said (#608). Not on a terminal: one plain pass, then exit (as `wb watch --once`).

## Models: found, loaded, chosen

Code: `workbench/models.py` (discovery, status, residency, the GPU lease, adding and retiring),
`workbench/router.py` (choice, slice, budgets, speeds), `workbench/hardware.py` (the machine),
`cli.cmd_models`, `cmd_model`, `cmd_scout`.

### Running your own server
For people who run a model server already, or set one up themselves (moved here from the
README's FAQ, #102). Everyone else can leave it to Claude, which suggests a server and models
that fit the hardware and sets up the ones the user picks.

#### Which server
For the most hands-off setup, Ollama. It's where Workbench automates the most: Claude downloads
and removes models, reads each model's context window from it, and lets two tasks share the GPU
when both fit. For a desktop app to manage models, LM Studio comes next. Any server that speaks
the OpenAI API works, and Workbench reads each model's size and window from llama.cpp's
`llama-server`, LM Studio and vLLM too. On those, models are downloaded the server's own way, and
tasks take turns on the GPU. A server OpenCode has no provider for: `wb model add <provider>/<model>
--url <baseURL>` (`--context N` when it doesn't say its window).

#### A server on Windows, from WSL2
WSL2's default NAT networking forwards Windows to WSL's `localhost` but not the reverse, so Ollama
for Windows or LM Studio listening on Windows' own 127.0.0.1 never answers from WSL. Either set
`networkingMode=mirrored` under `[wsl2]` in `%UserProfile%\.wslconfig` (then `wsl --shutdown`):
WSL then reaches it on 127.0.0.1 and it is this machine's server; or have it listen on 0.0.0.0
(Ollama: `OLLAMA_HOST=0.0.0.0`) with a Windows firewall rule, then `wb remote <Windows' address>`
for an Ollama, or `wb model add --url` with `local: true` for its provider. When nothing answers
on 127.0.0.1, `models.servers_here` (wb setup's first run, wb scout) also probes the usual ports
at the Windows host (`models.windows_host`: the default gateway in `/proc/net/route`, else the
generated `/etc/resolv.conf`'s nameserver; all ports at once, a second each) and says a hit is
"on Windows" and needs `local: true`; when nothing answers there either, both say
`models.WSL_NAT`'s two ways. Seen: first run said no server answers, and Claude proposed a
second server inside WSL (#663). A provider at the Windows host is `remote` but on the same GPU
(`models.same_gpu`, models.json `same_gpu` to say otherwise): its tasks share this machine's
lease pool with WSL's own tasks and image or audio engines, and `free_gpu` unloads it. Before,
its tasks took pool `gpu-<winhost>` and a command engine in WSL pool `gpu`: neither waited for
the other, nothing was unloaded, and both ran on the one card (#750).

#### The context window
16K tokens at the least; 32K or more is recommended (the README says so). OpenCode's own
prompt, its instructions and tools, takes about 10K of it, and the window sets how much of a task one agent can take on. `wb doctor` flags a
window that's too small or doesn't match the model's entry. Most servers start small:
- Ollama: `OLLAMA_CONTEXT_LENGTH` in the service's environment. Its default is small and cuts
  the prompt off without a word.
- llama.cpp: `-c` on `llama-server`. With `--parallel N` set, each slot gets an Nth of it (unless
  `--kv-unified`), and one agent uses one slot.
- LM Studio: the context length when the model is loaded (`lms load <model> --context-length
  32768`). Load it before registering it, so LM Studio can say what it gave it. A task loads an
  unloaded one itself with the entry's `limit.context`, loads one loaded with less again, and
  unloads the LM Studio models it isn't using (*Residency*).
- vLLM: `--max-model-len`.

Bigger is better while it fits on the GPU. A window too big for the card pushes part of the model
into system memory, and it runs about half as fast. With Ollama, `wb optimize` measures the
largest window that stays on the GPU. On another server, raise the window until part of the model
lands on the CPU, then step back: llama.cpp's log says how many layers it put on the GPU, LM
Studio shows its GPU offload, and vLLM won't start when the window doesn't fit.

#### Tool calls
The agent says it can't call tools, or its tool calls come out as plain text: the server has to
turn the model's tool calls into the API's form. vLLM does that only with
`--enable-auto-tool-choice --tool-call-parser <the model's parser>`. llama.cpp uses the model's
chat template, which a few models need replaced with `--chat-template-file`. A model LM Studio
says wasn't trained for tool use is registered without tools and gets no tasks.

#### A model on another machine
A gaming PC can do the work for a laptop.
1. On the PC, run Ollama listening on the network: set `OLLAMA_HOST=0.0.0.0` for its service,
   restart it, and pull a model. Ollama has no login, so let only the laptop reach its port
   (11434): a firewall rule, or Tailscale, which also encrypts it (plain `http://` carries the
   code in the clear).
2. On the laptop: `wb remote <pc>`, with the PC's Tailscale name or LAN address. It registers the
   PC's models that can call tools (`--context N` when its Ollama doesn't say what window it
   serves); `wb remote <pc> --remove` undoes it.

Tasks on the PC take turns on its GPU, apart from the laptop's, and `wb optimize` measures its
models too. The lease is this client's only: each client's remote lease (`gpu-<host>.json`) sits
in its own lease directory, so two machines (or two users) on one box, or the box's own wb tasks,
hold no lease in common, and when their models don't fit the box together Ollama swaps them.
A shared lease would need state kept on the box, and nothing of workbench runs there: Ollama's
API is all a client can see of it, and it has no lock, no owner per model and no request count,
only `/api/ps` (what is loaded, and each model's `expires_at`, which a finished request moves and
a running one lets pass). So the clients coordinate through that (`models.box_others`,
`box_quiet`, `BOX_SHARED`, #812): before loading its model on the box, a client waits while a
model loaded there that its task doesn't run (keep_loaded's aside, and any this machine loaded
there itself in the last week: `box_mine`, `boxes.json` `{root: {name: ts}}` in `store.machine_dir()`, written by
each load, so one user with one box never waits on their own last task's model; such a model is
still watched for `INFLIGHT_WATCH`, since this machine runs one task at a time on the box and a
request on it now is another client's: then its mark is dropped, `_forget_mine`, and it is waited
for like another's, #893) has had a request in the last
`BOX_QUIET` (150 s, watched from then on: `/api/ps` says when a model expires, not when it was
last used; a stamp stands still while a request runs, so one whose last move, its `expires_at`
less `BOX_KEEP_ALIVE`, Ollama's default 300 s, is over `BOX_QUIET` ago may be a request still
running and is waited for until it moves or the model goes (so `make_resident` loads a box's
model for `BOX_KEEP_ALIVE`, not 30 min: a 30 min load's stamp stood 25 min ahead while the round's
first request, the full prefill, ran, and read as quiet; it loads again before every round anyway,
reviewing #899): an idle one goes within
`BOX_KEEP_ALIVE` − `BOX_QUIET` of that, sooner on a box keeping models longer, and a long
request, a reasoning model's or a slow prefill, was loaded over, #899; a box's stamp is past by
more than `BOX_SKEW` 10 s, this machine's own sleep no excuse, `_past(remote=True)`, #899), up to `BOX_WAIT` (40 min, a round's default limit); within a round the agent's
requests are seldom further apart, since OpenCode sends a shell command past 2 minutes to the
background. Every client doing the same, they take the box a round at a time rather than a
request at a time, and the waiting task's status says what it waits for (a `gpu` event when the
model was answering). A load then waits a `BOX_QUIET` once for an idle model another client left loaded there
(the load is skipped altogether while the task's own model is still on the box). What it can't
stop: a round that begins while the other's model is quiet (its tool running past `BOX_QUIET`),
a long request on a box that keeps models longer than `BOX_KEEP_ALIVE`, or on a model loaded
for longer (an older wb's 30 min load; its stamp then reads as recent), a wait cut off by `BOX_WAIT`, or a client of an older wb, Open WebUI or anything else that loads
without looking, still swap their models on each request. A model the load evicted anyway is
named in a `gpu` event, and so is the task's own model found gone from the box at its next round
while another client's is loaded there (`GpuLease.load`, counting the models this machine once
loaded there too: `box_others(own=True)`, #893); `wb start` notes the models the box has
loaded for someone else, and that the runner waits for them. Run such tasks at different times,
or on models that fit the box together. Their energy isn't measured, and the savings lines say so. A second machine adds a
model beside this one's; it doesn't make one model faster. Another server there (llama.cpp, LM
Studio, vLLM): give its provider `"local": true` in `~/.config/workbench/models.json`, then `wb
model add <provider>/<model> --url <baseURL>`. Ollama's cloud models (`:cloud`) run on ollama.com
and aren't counted as local unless marked the same way.

#### A server that wants an API key
Put it in the provider's `options.apiKey` in OpenCode's config. If it reads `{env:NAME}`, add
`NAME` to `env` in `~/.config/workbench/commands.json`: the agents get none of the environment's
secrets by default. A key the server refuses makes its models unavailable (`wb models` says so).
A key kept with `opencode auth login` (OpenCode's `auth.json`) works too, when the config has no
`options.apiKey`.

### Found, loaded, chosen
**OpenCode's config.** `models.opencode_config_files()`: `$WB_OPENCODE_CONFIG` alone, else
whichever exist of the system directory's `opencode.json` and `opencode.jsonc` (`_system_dir`:
`/etc/opencode`, on macOS `/Library/Application Support/opencode`; an admin's or a managed
install's, layered first, never written: `config_target` passes it by), then the global
directory's (`_config_dir`: `$OPENCODE_CONFIG_DIR` as OpenCode 2.3 takes it, else
`$XDG_CONFIG_HOME/opencode/`, default `~/.config/opencode/`; a user keeping it in a dotfiles
directory had "no local models", and `wb model add` wrote a file OpenCode ignored: #370, the
audit of 1.6; the real-OpenCode test compares the list with `opencode debug config`), in that
order, then the user's own `$OPENCODE_CONFIG` (`_users_config`;
never a path under the state directory, which is a task's layer): OpenCode 2.3 layers them, the
later winning, and `read_config` merges them the same way (dicts recursively), each parsed
through `_strip_jsonc` (comments and trailing commas removed), then the user's
`OPENCODE_CONFIG_CONTENT` last, as OpenCode loads it (`users_config_content`; ignored beside
`$WB_OPENCODE_CONFIG` or when it isn't a JSON object, which `wb doctor` says: it says when the
variable is set, never its keys; #347). A provider's relative
`{file:path}` starts in the directory of the file that defines it (`_provider_dirs`).
`opencode_config_path()` is the global file wb names: `opencode.json` if it exists, else
`opencode.jsonc` if it exists, else `opencode.json`; `own_config` writes the one file there is,
else that one.
A file that doesn't parse is a `RuntimeError` naming it (every command prints it as a message;
`wb doctor` prints it as BAD and stops). Every write (`write_entry`, `_add_provider`,
`remove_remote`, `set_default`) changes that one file's own parsed contents, `own_config(change)`
yielding (the file, its contents) and writing them back when the change ends, under the file's
lock (`store.edit_config`); `read_config`'s merge is for lookups only. Writing the merge back
copied an admin's system file and a session's `OPENCODE_CONFIG_CONTENT` (an `apiKey` with it)
into the user's file, where the admin's later changes stopped taking effect (#421, the audit of
1.8). What another layer sets is that layer's (`set_elsewhere(target, *keys, later)`, naming each
file, or `OPENCODE_CONFIG_CONTENT`): removing a model or a `wb remote` provider another layer also
sets is refused, since it would stay in effect, and so is changing a model, or `--set-default`'s
`model`, that a layer loaded after the file sets, which would win ("… is set in <layer>, which wb
doesn't write: make this change there by hand: …"). A model for a provider only the system file
defines goes into the user's file as an overlay (`{"provider": {"<id>": {"models": {…}}}}`, which
OpenCode merges over the admin's); one for a provider only `OPENCODE_CONFIG_CONTENT` defines is
refused (it would leave a provider with no baseURL on disk once the session ends). `own_config` refuses while two files are
layered (one merged file would undo the layering), unless the file is strict JSON (no comments,
no trailing commas), and when the file (or a symlink's target) isn't writable (a Nix store), and
then prints only `change`, what to do by hand (the keys wb sets, or the key to delete or set),
never the config, which can hold a provider's `apiKey` (the 2026-11-16 audit). A write reformats
the file (atomic, indent 2), through a symlink to its target (dotfiles stay linked), keeping the
file's mode (0600 for a new file; the temporary file is never readable by others):
`store.write_through`, which models.json, commands.json and savings.json share (#495).

The agent's OpenCode loads the global files itself, but its `OPENCODE_CONFIG` is the task's layer
(`runner.agent_env`), so a provider defined only in `$WB_OPENCODE_CONFIG` or the user's
`$OPENCODE_CONFIG` was "Model unavailable" to it while wb called the model ready (the 2026-11-19
audit). `models.agent_providers()` copies those files' `provider`, `enabled_providers` and
`disabled_providers` (`PROVIDER_KEYS`) into the layer, templates kept as templates and a relative
`{file:}` made absolute; the layer is written 0600, since a copied provider may carry its key.

**Discovery** (`discover`, `_scan`). A model is a candidate when it is an entry under a provider
(`provider` or `providers`; `options`/`settings` with a `baseURL`) that OpenCode loads (not in
`disabled_providers`; in `enabled_providers` when that is set) and whose host is this machine:
`localhost`, `0.0.0.0`, `host.docker.internal`, any loopback IP, the host name, its first label,
or `<label>.local`, or any of the machine's own addresses (`_own_addresses`: the host name's
`getaddrinfo` and `ip -o addr`, else `ifconfig -a` where there is no `ip` (macOS: the Mac's own
LAN address counted as remote, the 2026-11-19 audit), so a LAN or Tailscale IP counts; read again
after `ADDR_SECS` 60 s), or a
name that is this machine's by another spelling (`_named_here`: its FQDN or that's first label,
or a name resolving to a loopback or own address, within `RESOLVE_WAIT` 1 s, once per process;
`box.lan` or a tailnet name was another host, its own GPU pool with no sharing, residency or fit
check, #807; a lookup that failed or timed out is asked again after `DOWN_SECS`, and the addresses
a name resolved to are checked against the current own addresses: kept for good, a slow DNS or a
tailnet reconnecting after a wake made a long-lived runner or the chat server take this machine's
server for another host's, #900) (`_this_host`). A
provider elsewhere counts when models.json gives it `"local": true`; it is then `remote`: it
takes no lease on this machine's GPU, but one on its server's (tasks there take turns: *Sharing the GPU*),
unless its server is on this GPU after all (`same_gpu`: WSL2's Windows host), when it takes this
machine's.
OpenCode talks to it directly at the baseURL (plain `http://` is unencrypted and the prompts carry
the code: *A model on another machine* above suggests a firewall and Tailscale); nothing of workbench runs there, and no
model is split across machines. `wb remote HOST` sets one up for an Ollama there (#114,
`models.add_remote`): it checks `/api/version`, writes provider `ollama-<host>` (`remote_pid`:
the host in id characters; baseURL `http://HOST:PORT/v1`, `remote_root`: an IPv6 literal
bracketed, its zone as `%25`, read back as discovery reads it before anything is written, and
`::1` or `[::1]` one provider (`remote_host`): written bare, the probe reached it and discovery
couldn't parse it, #707), its `local: true` and `remote: <root>`
(the mark that wb made it), then registers
each model `/api/tags` lists that `/api/show` gives `tools`, cloud rows left out, through `wb
model add`'s own path (a model it refuses gets a `--` line with why, and the rest go on). Ollama
there says nothing of the window it serves until a model is loaded (this machine's
`OLLAMA_CONTEXT_LENGTH` isn't that host's), so `--context N` gives it. A provider of that id
already in the config for another baseURL (the user's own, or one for another port) is refused,
never reused: its models were reported as the new endpoint's (#197, the 2026-11-19 audit).
`--remove` (`remove_remote`) drops the provider and every models.json entry under it, only when
wb made it (the `remote` mark, the Ollama root wb remote added, while the provider's baseURL is
still that root's `/v1`; or, made before the mark, its name `Ollama on <host>` and its baseURL's
host): it once deleted a hand-written provider of that id with its models, and one the user had
repointed at another server since, the mark left behind (#242, the audit of 1.2). The baseURL's `{env:NAME}` and `{file:path}` are resolved first, as OpenCode does (`_expand`: unset or
unreadable is empty, a relative path is the config directory's, and a name the agent's
environment drops, `runner.SECRET_ENV` unless commands.json `env` passes it, is empty too, since
the agent's OpenCode won't see it). A provider with a baseURL that is skipped (disabled, not
enabled, no host after resolving, another host) is named with the reason by
`skipped_providers()`; `why_none()` puts those reasons (or, with none, how to make a provider) into
`wb models`, `wb doctor`, `wb model add`, `resolve` and the router's "no local models". A
provider with no baseURL is one of OpenCode's own cloud providers and is passed over silently.
The id is `provider/name`; `root` is the baseURL without `/v1`; `server` is the server's identity
(host, port, path), with every spelling of this machine (loopback, `localhost`, its own names and
addresses) as one host, so two providers reaching one Ollama as `localhost` and `127.0.0.1` are
one server everywhere roots are compared (`free_gpu`, `_others_resident`, `can_share`); before,
free_gpu unloaded the models it was told to keep (the 2026-11-16 audit). The engine (`_engine`):
models.json `engine`, else a cached probe of `GET <root>/api/version` (a JSON `version` →
`ollama`, an HTTP error → `server`), else a guess: Ollama's port 11434 or a provider id containing
`ollama` → ollama (`engine_known` says whether it was said or probed rather than guessed). The
probe sends the provider's `apiKey` (`_KEYS` is filled before it), so an Ollama that wants a key
isn't classed a server; a probe that gets no answer is remembered for `DOWN_SECS` (60 s, `_DOWN`), so a
server that is down costs one 1.5 s timeout a minute, not one per `discover()`, and a runner or the
chat server, which live for hours, learn the engine once it is back (#337). That covers only
the engine probe: `status` asked an Ollama's `/api/tags` per model, so `router.rank` and `wb
models` paid a 2.5 s timeout per model on a `wb remote` box asleep (`wb models` 31 s, each `wb
start` 10 s, #705). A pass now keeps a `down` set and a `catalog` dict: `status(m, down,
catalog)` adds a root it finds not answering to a `down` that is a set, and `rank`/`choose`
(their `down=`, `catalog=`) and `cmd_models` share one through all their calls, as `wb doctor`
and `wb top` pass theirs. A server that
answers `/api/version` but only emulates Ollama is a `server` (`models.emulator`, cached per root
in `_EMULATORS`; `ollama_answers` says no to it too): KoboldCpp, whose own `/api/extra/version`
answers, or whose `/api/tags` row has `details.family` `koboldcpp`. Driven as Ollama, its
`/api/show` (capabilities `completion` only) made `wb model add` write `tool_call: false`, its
hard-coded 0.39 GB row ranked it smallest and fitting beside anything, and unloads started a
generation (#580). When the probe and the port or name disagree (an emulator, or a provider on
Ollama's port or named for it that doesn't answer as Ollama), `providers()`'s `engine_note`
says so and names the models.json `engine` override; `wb doctor` (`--  provider <pid>: …`) and `wb
model add` print it.
`resolve()` takes an exact id, an exact model or provider name (the entry's key or its server
name), or a unique case-insensitive substring.

A model's `name` is its name at the server: the entry's `"id"` when it has one (an alias, which
OpenCode sends in its place), else the entry's key. Every probe, load, unload and placement uses
it; the model's id (`<provider>/<key>`) routes and selects. Read as the key, an alias OpenCode ran
was "the server lists N models, not friendly" (the 2026-11-19 audit). `wb doctor`, `wb scout`
(its sizes, windows and "installed but not registered" match too) and `wb model add` ask the
server by the same name (`cli.served_name`): by the key, an aliased Ollama entry read 404,
doctor said BAD on `OLLAMA_CONTEXT_LENGTH`'s window, and the add it advised died (#588, the
audit of 1.90).

Every request to a server on this machine (`_open`: probes, loads, pulls, the image engines) goes
direct, never through an `http_proxy` in the environment, which urllib would otherwise use for
loopback too (the 2026-11-16 audit: every model read "not answering" behind a proxy); a provider
on another host keeps the environment's proxy. A provider's `options.apiKey`, resolved as the
agent will see it (`_expand`: a `{env:}` name the agent's environment drops is empty), is sent as a
bearer token on every probe to its server's root (`_KEYS`, filled by `discover`, added in
`_open`): `/models`, and Ollama's own `/api/version`, `/api/tags`, `/api/ps`, loads and unloads,
which sent none, so an Ollama behind a key read as unavailable (#256, the audit of 1.2); it is
never printed or stored. With no `options.apiKey`, the provider's key from OpenCode's own
`$XDG_DATA_HOME/opencode/auth.json` (`opencode auth login`, a `{"type": "api", "key"}` row:
`auth_key`) is the one sent, as OpenCode's docs keep a custom provider's key there and the lane
leaves the file readable for the agent's OpenCode (#336, the audit of 1.4). A key whose `{env:NAME}`
is set for wb but dropped for the agent is a provider problem, so the model is unavailable: "its
apiKey reads {env:NAME}, which agents don't get: add NAME to commands.json env" (probed with wb's
own key it read running, and every request of the agent's was refused: the 0.90 review).

**Ollama cloud models** (`ollama/<name>:cloud`, `…-cloud`, or an `/api/tags` row with
`remote_host`/`remote_model`): Ollama forwards them to ollama.com, so they are not candidates:
`status` says "an Ollama cloud model: it runs on ollama.com, off this machine", `weights` is 0
(the stub's few hundred bytes once made one "the smallest", the 2026-11-16 audit), `wb model add`
refuses one, and `wb scout` lists them apart from what is installed. models.json `"local": true`
on the model's own id allows one; it is then `remote`, holding no GPU lease.

**models.json** (`$WB_MODELS`, default `~/.config/workbench/models.json`, strict JSON; a
malformed file breaks every command; `set_override` changes one key under its lock, through a
symlink, keeping its mode: `store.edit_config`, #495) holds only what OpenCode can't say, keyed by provider id or
model id; a model's entry is merged over its provider's (`{**provider, **model}`):
- `start` / `stop`: shell commands for a server (start detached, then status every 5 s up to 20
  min; stop with a 300 s limit);
- `skip`: leave the model (or every model of the provider) out;
- `sizes`: the task sizes it may take (`wb model sizes`; empty means both);
- `vram_gb`: the GPU memory it takes (decimal GB), for sharing and for `fits`;
- `gpu_gb` (top level, not under an id): this machine's GPU budget by hand, in decimal GB
  (*Sharing the GPU*);
- `weights_gb`: its size, which always overrides the server's figure (for one that can't report it);
- `label`: the display name (also in `wb accept`'s commit message);
- `engine` (`ollama`/`server`): per provider only;
- `local: true`: on a provider, counts it although it is on another host; on an Ollama cloud
  model's own id, allows that model.
- `same_gpu: true|false`: on a provider (or a model id) that is `remote`, whether its server runs
  on this machine's GPU after all (`models.same_gpu`). Unset, it does when its host is WSL2's
  Windows host (`models.windows_host`, NAT's gateway: Ollama for Windows uses the very GPU WSL's
  engines do); say `true` for another such setup (a container on its own address), `false` for a
  Windows host with a card of its own. Then it is this machine's GPU in every way that matters
  to sharing it: its tasks take this machine's pool (`gpu.*`, not `gpu-<host>.*`), take turns with
  the tasks and image or audio engines here, and `free_gpu` unloads its Ollama's models (#750).
- `remote: <root>`: on a provider, `wb remote` made it (for the Ollama at that root), so `wb
  remote --remove` may delete it (#197).
- `keep_loaded` (top level, a list): model ids or Ollama names wb never unloads or stops to make
  room (*Residency*), nor measures (`wb optimize`: each probe unloads its model, #254). An entry
  is an id only when it starts with a provider id the config has (`<provider>/<key>`: its entry's
  `id`, an alias, or its key); else it is an Ollama name, whole (`hf.co/<org>/<repo>:Q4_K_M`,
  `user/model:tag`), untagged read as `:latest` (`models._kept_name`; cut at its first `/`, a
  namespaced name never matched itself and `mannix/llama3:8b` kept `llama3:8b`, #461).
- `variant_of: <id>`: `wb optimize apply` made this model from that one (with a copy of its other
  keys here): the two share one record in the router (`router.lineage`), and the router puts the
  variant first (#584). A variant of a variant keeps the first source here and names the variant
  it was made from in `replaces: <id>` (#723). `wb model retire` keeps both keys, so a retired
  variant's tasks stay in its source's record.
- `renamed_from: <id>`: `wb model rename OLD NEW` wrote it on NEW: the id the model had before
  (a provider renamed, `ollama` to `local`; `name:latest` moved to its explicit tag; a llama-swap
  or LM Studio alias renamed), followed back through earlier renames (`router.earlier`). The
  model's record carries over: the router's score (`router.lineage`), its slice, its tuned knobs
  (`tuning._rows`), its speed when the new id has none measured (`router.speed`, so the budgets
  aren't the defaults again) and its Stats line. Without it, an id no longer discovered whose
  newest results row ran on the Ollama digest the model has now (`weights_id` against
  `models.identity`) is linked the same way, by the router only while the server answers, by the
  Stats line from the rows' own `weights_id`, and by `router.speed` only from an identity its
  caller already has (`wb start`'s, the runner's task.json `weights_id`): `wb top` and the Stats
  feed call it on their tick, where the server read stalled them 2.5 to 4 s a model on an
  unreachable box (#905); a `bytes:` size is too weak a match to link. Keyed
  by the id alone, each of these started the model fresh: behind the models with a record, on the
  window's guess, the default knobs and budgets (#818).

**Status** (`status` → {available, resident, why}). First what the config alone rules out, so the
fake models meet it too: an entry with `tool_call: false` ("OpenCode's config says it can't call
tools": the router never picks it, `wb start --model` refuses it; a missing key is OpenCode's
default and counts as capable), a provider problem (`url_problem`: an Ollama provider, plain
OpenAI-compatible, whose baseURL doesn't end in `/v1`, where Ollama's OpenAI API lives; OpenCode
would get 404 on every request after the model loaded; or an `apiKey` the agent won't get, above),
an Ollama cloud model not allowed. A server's root is its baseURL without a trailing `/v1` or `/api`
(`server_root`, behind `Model.root`, `server_key`, the engine probe and `providers()`): a native
Ollama SDK provider (`ollama-ai-provider`, `-v2`) has a `…/api` baseURL, and with only `/v1`
stripped it probed `/api/api/version` and read "not running", and one Ollama through both was two
servers (#585, the audit of 1.90); a server's own probe of such a base asks `<root>/v1/models`
(`openai_base`). Then Ollama: not answering / `<name>` is not pulled / a cloud
model by its tags row / pulled / loaded (`/api/tags`, `/api/ps`). A server (`GET <base>/models`):
running (a server listing several models must list this one: "the server lists N models, not …";
one listing none (`data: []`) is unavailable, "the server answers but lists no model" (it read as
running and resident, #256); a llama-server listing one (a row `owned_by: llamacpp` or with a
`meta` field) answers to any name; any other server listing one is strict, as vLLM, SGLang and TGI
are (a wrong `model` is a 404, and the round died at its first request as "opencode exited 1":
#256, the audit of 1.2), so an id that isn't exactly this model's name is unavailable, "the server
serves <id>, not <name>: set the entry's id to <id>" (the file's basename, `_serves`, is matched
only on a llama-server: a strict server listing `studio/coder` read as serving `personal/coder`,
#339, the audit of 1.4); except on a port that several models share,
each with its own `start` (`_contended`: one llama-server per model), where the listed id says which model it is
(`_owners`): the model whose name is the id or its file's basename without `.gguf` (`_serves`), or
whose start command names that file (`-m <path>`). The model it is reads running; another model on
the port, when the one served has a `stop`, reads available but not resident ("the port serves
<id>; wb stops it and starts <id>"), so `make_resident` switches them; an id no model (or more than
one) accounts for, or a served model with no `stop`, leaves it unavailable, "<root> is serving
<id>, not <name> …": the task would run on the other model, recorded under this one (names that
differ from the file once left every model on the port unavailable, the served one too: the 0.90
review); a 401 or 403 to the key the agent will send is unavailable ("the server refuses its API
key", or with no key "it wants an API key", each naming `options.apiKey` and `opencode auth login`,
#336): neither running, which
let a wrong key pass and the router pick that model over a working one (the 2026-11-19 audit), nor
stopped, which once started a second copy and waited 20 minutes for it (the 2026-11-16 audit);
stopped with a `start` ("wb starts it"); not running with no start command. `wb models` and `wb
doctor` print the reason. `status(m, down)` takes the Ollama roots a caller already found not
answering (doctor) and doesn't ask them again. `remedy(m, state)` is the next step for a reason
(none when the reason says it already), and `may_come_up(state)` whether the model may run by the
time a queued task gets the GPU (Ollama not answering, a server not running). `weights()`:
`weights_gb`, else Ollama's size (0 for a cloud model), else what another server says
(`server_facts`), else the file a models.json `start` command serves (`start_file`: `-m`/`--model
<file>`, llama-server's), else 0. vLLM, SGLang, KoboldCpp and MLX say no size, nor llama-swap or a
router-mode llama-server for a model not loaded: every weight 0, the router took the config's
order as "the largest model" (#704). For ordering only, `guessed_weights` reads a parameter count
in the name or label (`PARAMS`: `70b`, `8x7B` as 56, not an active `a3b`) at a byte a parameter;
`fits` never uses it. The router weighs only a model that can run (and `fits` only that one),
so a down server isn't asked again per model.

**What other servers say** (`server_facts(root, name, key)` → `{context, weights, tools}`, each
None when unsaid; cached `FACTS_TTL`, 30 s, misses too, since `weights()` runs on every routing).
Only Ollama's API was read, so on any other server the router ranked models without their sizes,
checked no fit, and every window had to be typed in (2026-11-17). Each server answers its own
call (the fields as each project's docs and source gave them, 2026-11-17): LM Studio 0.4+'s
`GET /api/v1/models` (`size_bytes`, a loaded instance's `config.context_length`, so a model it
hasn't loaded has no window yet, and `capabilities.trained_for_tool_use`); llama-server's
`/v1/models` card (`meta.size`) and `GET /props?model=<id>&autoload=false`
(`default_generation_settings.n_ctx`: one slot's window, `-c` split across an explicit
`--parallel` unless the KV cache is unified;
`autoload=false` so a router-mode server isn't made to load the model to answer); vLLM's and
SGLang's `max_model_len` on the `/v1/models` card. A server listing one model answers for any
name (`_serves` otherwise). Sharing the GPU stays Ollama's (`can_share`): the others can't say
what they hold.

**Residency** (`make_resident(m, keep, warn)`, called by the runner under the lease). A model
`status` says can't run raises `RuntimeError` (its reason and remedy) before anything is freed: a
`--force` task for an unpulled model once emptied the GPU and then failed its load. Nothing to do
when `m` is resident and nothing else is, or all of it is in VRAM with room beside the rest,
unless it is a local Ollama model partly on the CPU that would fit whole once the GPU is freed
around it (`_respread`: a known budget, its `/api/ps` size plus the kept models' within it, no
running server wb can't stop that holds memory, `_servers_hold`: an LM Studio counts only for the
instances `free_gpu` leaves loaded, #808): then, after `free_gpu`, it is unloaded (`_unload`) and loaded
again, since Ollama reuses a loaded runner as it was placed. Loaded while something else held
the VRAM, it crawled at CPU speed all task beside an empty GPU (#703). Each (root, name, size)
is reloaded so once (`_RESPREAD`): one that comes back split isn't reloaded every round.
An LM Studio model listed but with no loaded instance (`lmstudio_unloaded`: just-in-time loading
lists every downloaded model, so `status` says running) is loaded first, after `free_gpu` as
below, with `POST /api/v1/models/load` and `context_length` set to its `limit.context`; a refused
load raises, naming `lms load <key> --context-length N`. Left to OpenCode's first request, LM
Studio loaded it with its default window (often 4K), refused the prompt, and round 1 failed
(#335, the audit of 1.4). One loaded with a smaller window than `limit.context` (`_lmstudio_short`:
its instance's `config.context_length`, the UI's 4K, say) is unloaded (`POST
/api/v1/models/unload {instance_id}`) and loaded again the same way: kept, `short_window` failed
the task (#645). With just-in-time loading off, `/v1/models` lists only loaded
models: before `status` says the server lists no model, other models, or serves another one,
it asks `lmstudio_unloaded`, and a model LM Studio has is available, not resident ("in LM Studio,
not loaded (wb loads it)"); with A loaded, B was told to set its id to A (#462, the audit of
1.8). Nothing is freed when `m` fits beside every model resident now (`_room_beside`: Ollama only, a
known budget, no other server resident (`_servers_hold`: an LM Studio only with an instance
loaded, since its just-in-time list named every downloaded model and an idle one read as
resident, so every round emptied the GPU and #703's reload never fired, #808), `m` all in VRAM if loaded, Ollama's loaded-model limit not
reached, and the loaded sizes from `/api/ps` plus `need(m)` within `SHARE_AT` of the budget):
every round once unloaded the user's Open WebUI, autocomplete or embedding model, fits or not
(the 2026-11-19 audit). Else `free_gpu(keep={m, *keep}, of=m)` (an Ollama known to be on other
cards than `m`'s is left alone: `apart`, under **The machine** below): every other running
server with a `stop` command is stopped once per server, after waiting up to 10 minutes while it
answers someone (`_server_idle`: llama-server's `/slots` `is_processing`, else `/metrics` as a JSON
`live.state` or Prometheus text with a `BUSY_GAUGES` gauge above 0, `llamacpp:requests_processing`,
`vllm:num_requests_running`, SGLang's `sglang:num_running_reqs` and `sglang:num_queue_reqs`, or
TGI's `tgi_batch_current_size` and `tgi_queue_size`; read as JSON only, llama-server and vLLM were
stopped mid-reply, #465, the audit of 1.8, and SGLang and TGI, missing from the list, still were, #715;
a server that says none of these is idle) (a running server with no `stop` is left, with a warning
that it may hold GPU memory); after a stop that succeeded, free_gpu waits up to `STOP_SETTLE`
(30 s) in all, first until each stopped server stops answering (`status` not resident: a stop
like `pkill vllm` returns at once, and two equal reads a second apart, before the server had begun
to let go, read as released, #898), or, when it stopped one server, until the cards use less than
before that stop (`_vram_used`, by more than `FALLING` 64 MiB: a stop that unloads and leaves its
server answering, an unload endpoint or `lms unload`, paid all 30 s on every round; with two
stopped, the first one's release ended the wait while the second still held its memory, the
second review of #898); a server still answering when the 30 s end is in `_STOP_STAYS` and, for
the rest of the process, waited on only through its VRAM, so one stopped again with nothing loaded
costs 30 s once, then a second (one that broke off on the VRAM's fall isn't recorded: a pkill
server still answering as it let go was, and its later stops went unwaited, reviewing #898), then
`released` until the cards' used VRAM stops falling (`media.settle` waits the same way), since a stop returns before the memory is freed and Ollama
loading at once split the model (#703); every model loaded on each discovered Ollama server is unloaded
(`POST /api/generate {keep_alive: 0}`) except kept ones, and except models.json's `keep_loaded`
(`keep_loaded()`: ids or Ollama names; a server whose model is listed is never stopped), which
`_others_resident` doesn't count either. Before those unloads, `_wait_unused` watches `/api/ps`
for `INFLIGHT_WATCH` 10 s (`_in_use`): Ollama moves a model's `expires_at` each time a request
finishes and stops its clock while one runs, so a stamp that moves, or one already past
(`_past`: past by more than the machine has slept since boot, `slept()`, Linux's
`CLOCK_BOOTTIME` less `CLOCK_MONOTONIC`, macOS's `CLOCK_MONOTONIC_RAW` less `CLOCK_UPTIME_RAW`;
Ollama's unload timer stops in a suspend while its wall-clock stamp doesn't, and after a lid was
opened an idle model read as busy, #716. On a machine that has slept, a request running past its
keep-alive is seen once it ends and its stamp moves; a wb remote box's stamps are timed by the
box, so there only `BOX_SKEW` is allowed, #899), is a model answering someone this account's lease doesn't know (another account's
tasks on a shared system Ollama whose machine has no shared lease, below; Open WebUI; an editor). Then it
warns ("<names> on ollama is answering requests that aren't this account's tasks …: waiting up to
10 min for it to go idle before unloading it") and waits, up to `INFLIGHT_WAIT` 10 min, for a
quiet watch, looking at most once an `INFLIGHT_POLL` second (a stamp already past is busy at
once, and the wait asked `/api/ps` back to back: 1,137 requests in 0.25 s, #459, the audit of
1.8), then unloads it either way. Each account's runner once unloaded the other's model
before every round, mid-use, and both reloaded on every request (#378, the audit of 1.6). A
server whose `/api/ps` gives no `expires_at` has nothing to watch. The whole answer is one lease
for every account (#393): the lease's files live in `models.lease_dir()`, which is `$WB_GPU_DIR`,
else `SHARED_GPU` (`/var/lib/workbench/gpu`) when it is a directory this account may write, else
`$WB_HOME` as before, or on a network file system `$WB_HOME/machines/<store.machine()>/` (`_own_lease`, `store.machine_dir`:
machines sharing a state directory pruned each other's holders as dead and took turns on GPUs they
don't share, #849). An admin opts a machine in once (`sudo install -d -m 2775 -g <group>
/var/lib/workbench/gpu`, the accounts in that group): every account's tasks then take turns or
share there like one account's. Lock files are opened read-write where this account may write
them, else read-only (`_lease_lock`, `_lease_fd` through `store.lock_fd`: another account made
them, and flock needs no write; read-only alone failed on NFSv4, whose client refuses an exclusive
flock on a read-only fd with EBADF, so every task failed at the lease, #892); `gpu.json` is replaced by rename (the
directory's write). In a shared lease every file is the group's to read (`LEASE_MODE` 0664:
`_lease_fd` fchmods the lock files it owns, `GpuLease._set` writes `gpu.json` through
`store.write_json(…, mode=)`): under one account's umask 077 they were 0600, and every other
account's `holders()`, `wb start`, `wb optimize` and `GpuLease` failed with PermissionError (#802).
`wb doctor` names any the group still can't read (`unshared_lease_files`), with the chmod. Each entry carries `uid` and `user`: a holder of another uid can't be
signalled, so `_alive` takes it as alive when its start time matches, or can't be read (/proc
mounted hidepid: the refusal proves the pid exists, and taken as gone, the other account shared
the GPU beside its live runner and unloaded its model, #806); an entry of this uid, or
one without `uid` or `start`, refused a signal is still dead. Another account's model id is
usually not in this account's config, so `admits` doesn't share beside it: they take turns, and
nobody unloads a model under a round. A refusal names it as theirs (`busy`: "<user>'s task <t>"),
`wb top`'s queue adds the user. The directory is private to every lane (`private_paths`: an
agent's flock on `gpu.lock` would hold every account's GPU). Without it, `wb doctor` names the
models loaded that no task of this account holds (`unheld_loaded`: not in `gpu.json`, not
`keep_loaded`) with how `keep_loaded` and `gpu_gb` serve a shared Ollama, and how to make the
directory; with it, a `--` line names it; one that exists and this account can't write is BAD.
Still missed: one long request from outside wb that neither finishes during the watch nor runs
past its keep-alive (Ollama has no queue API).
Then Ollama loads the model (`POST
/api/generate {prompt: "", keep_alive: "30m"}`, on a wb remote box `BOX_KEEP_ALIVE` (`"300s"`,
for `box_quiet`, above), 20 min limit) or the server is started. An HTTP
error from Ollama raises with what Ollama said ("…answered HTTP 500: model requires more system
memory…", `_post`), not urllib's bare "HTTP Error 500". A start command that exits non-zero while
nothing answers fails after `START_GRACE` 10 s ("…'s start command exited N and nothing answers;
run it by hand to see why: <cmd>"), not after 20 min; exit 0 keeps waiting (a start that
daemonizes); a server that answers as another model fails after the same grace. Its probes are
paced on a monotonic clock, 5 s apart (1 s once the command failed), whether or not the command
has exited: a start that daemonized returned `p.wait` at once on every pass, and the loop probed
back to back (3,095 requests in 0.8 s: the 2026-11-19 audit). After an Ollama
load, `_placement` reads `/api/ps`: part of the model in RAM is a warning ("<name> is N% on the
CPU: expect it to be slow …"). Warnings (that one, a server wb can't stop, a stop command that
failed or ran past 5 min) go to `warn`: the lease's `warn` sets status `last` and appends a `gpu`
event, which the transcript shows as `■ GPU: …`, so it outlives the next status line. The seconds
it took go to `status.load_secs`. The runner calls it before every round, not once: each
OpenCode request resets Ollama's keep-alive to `OLLAMA_KEEP_ALIVE` (5 minutes by default), so a
model can be unloaded during a long test run. Inside a round too: while it waits on a background
job (`background_wait`) or on Claude's answer (`asking`), the runner renews it every
`runner.KEEP_WARM_S` (180 s), off the round's loop (`models.keep_warm`: the same empty generate,
`keep_alive: "30m"`, only while `/api/ps` lists the model, never loading one already gone, since
that load would skip `free_gpu`; not for a model on another machine's GPU). A long suite the agent
ran unloaded it mid-round, and its next request loaded it cold and read the whole session again (#864). A server that lists several models swaps them itself:
`free_gpu` treats a server as one, kept when a kept model is on it, unless the port is contended
and it serves another model, which is then stopped first. LM Studio (a server whose
`/api/v1/models` answers) is the exception: it evicts only what it loaded just in time, never what
`/api/v1/models/load` loaded, so each switch between two of its models stacked one more in VRAM,
spilling into RAM or refused by its guardrail (#645, the audit of main). `free_gpu` unloads each of
its loaded instances that isn't a kept model's (`keep`, `keep_loaded`: `_lmstudio_extra`), once
the server is idle, and never stops it; `_others_resident` counts those instances, so a resident
`m` beside one still frees it. `releasable(m)`: what `free_gpu` can
let go of (a local Ollama model, a local server with `stop`); `freed(m, keep)`: what
`free_gpu(keep)` does let go of, so neither `keep`, nor `keep_loaded`, nor a server a kept model is on.

**Sharing the GPU** (`GpuLease`, `admits`, `can_share`, `budget_devices`, `gpu_budget`, `need`).
The budget (`budget_devices`, which also returns the devices it counts and where the number
comes from, for `wb doctor` and `wb scout`'s `cli.gpu_line`) is models.json's top-level `gpu_gb`
when set (decimal GB, the escape hatch for hardware this can't read; not a number: an error, as a
malformed file; `gpu_line` names the file and the key whenever a GPU that can run models
(`hardware.COMPUTE`'s drivers, #710) publishes no memory size,
Intel's i915 and xe, whose sysfs has none: alone, as the fix for "GPU memory unknown here", and
beside a budget from another device, as the card that budget leaves out; its example card is of
the vendor it names, `_card_example`: it said "an Intel Arc" of a Radeon seen from WSL, #522. Nothing pointed there,
so tasks never shared and the user's other Ollama models were unloaded every round: #272, the
audit of 1.2), else it comes from one runtime's GPUs: the GPUs are grouped by driver (`nvidia`, `amdgpu`,
`metal`…) and the largest group's sum is taken, so several NVIDIA cards (which Ollama splits a
model across) add up but another vendor's GPU beside them doesn't; a discrete device under
`IGPU_UNDER` 1 GiB (an integrated GPU's carve-out, Ollama's own cutoff) is left out. Summing
every GPU counted a laptop's Radeon iGPU into its RTX card's 8 GB (the 2026-11-16 audit). amdgpu
reports an APU's carve-out of system RAM as VRAM too, so `hardware.gpus` marks a device
`discrete` only on evidence: nvidia-smi's, an amdgpu card that names its memory's vendor
(`mem_info_vram_vendor`, which an APU's system memory never has), and an amdgpu device whose
hwmon isn't an APU's (`hardware.apu` False: GCN cards, RX 470-590, Fury, R9 390, name no vendor,
#435); once any device with VRAM is
known discrete, only those count, so a carve-out never outranks or adds to a card (the 0.90
review: a 16 GiB Radeon 780M carve-out beside an 8 GiB RTX became the budget, and a 4 GiB one was
added to an RX 7600S's 8). With none known discrete (an APU alone, a card amdgpu gives no hwmon)
the groups decide as above. Only the devices Ollama may see count (`hardware.visible` over
`ollama_env()`): two 8 GiB cards with Ollama limited to one by `CUDA_VISIBLE_DEVICES` made a
16 GiB budget (the 2026-11-19 audit). An APU counts what `hardware.gpus` found (its carve-out plus GTT),
at most its carve-out (`carve`) plus `MemTotal` (`ram`) less `system_reserve`, the same rule as
below: the GTT is about half the RAM by default, but raised toward all of it (`amdgpu.gttsize`,
`ttm.pages_limit`, a 128 GB Strix Halo at 124 GiB) it kept nothing for the OS, and a share past
the RAM met the OOM killer (#712). An NVIDIA GPU that shares the RAM (a DGX Spark, a
Jetson: nvidia-smi gives it no memory) counts the RAM less `system_reserve`: what the system had
in use when `gpus` read it (`MemTotal` less `MemAvailable`, its `ram_free`), less what this
machine's Ollama has loaded (`/api/ps`, one ask, 1 s), never under `SYSTEM_FLOOR` 2 GiB; the
budget's why says "less N GB the system uses". All of `MemTotal` passed a 6.5 GB model as fitting
an 8 GB Orin Nano whose desktop held 2 GB (#524); another server's loaded model counts as the
system's, which only stops sharing. `gpu_gb` still overrides it. Apple Silicon: the raised wired limit when set (`hardware.wired_limit`, read once: `iogpu.wired_limit_mb`
from macOS 14, else Ventura's `debug.iogpu.wired_limit` in bytes, its key kept as `wired_key`
and named by `report` and the budget's why; read from Sonoma's alone, macOS 13's was ignored, #714), else macOS's default
(`unified_default`: two thirds of the RAM up to `UNIFIED_SMALL` 36 GiB, three quarters above,
Metal's recommendedMaxWorkingSetSize; it was 75% everywhere, too much on 8-32 GB Macs). On macOS
only an Apple GPU (`unified`) counts: an Intel Mac's Radeon or Intel adapter is no budget, as
Ollama's Intel Mac build runs on the CPU in RAM, and a 4 GB Radeon Pro beside 32 GB of RAM made
every model over 3.9 GB "too big" (#711; `gpu_gb` sets one by hand, for llama.cpp's Metal on AMD).
Unknown VRAM means no sharing. `gpus(windows=False)`: the budget asks WSL's PowerShell only when Linux sees no GPU, and then
at most hourly (`wsl-gpus.json`); each adapter named from Windows is a group of its own, since
the registry can't tell a laptop's Radeon iGPU from its Radeon card: the largest counts (#522). A model's
need: `vram_gb`, else Ollama's loaded size (weights and context), else weights × `KV_GUESS` 1.25.
`can_share(m)`: every running model and `m` are Ollama and local, and the needs of `m` and of the
running models that may share its cards (not `apart`: one Ollama per GPU, **The machine**) sum to at most
`SHARE_AT` 0.9 of the budget; the same model again (the same `server` and name) needs a slot of
`OLLAMA_NUM_PARALLEL` for each task on it (two already running it need 3: a value of 2 once
admitted any number, and a third task's requests queued inside Ollama while its silence budget
ran, the 2026-11-19 audit), and different models may not outnumber `OLLAMA_MAX_LOADED_MODELS`
on their server (`max_loaded`; unset or 0: `OLLAMA_MAX_LOADED` 3 per GPU the budget counts,
Ollama's `defaultModelsPerGPU * len(gpus)`; counted as 3 in all, a fourth task on a two-card box
was refused, #466, the audit of 1.8; with models.json's `gpu_gb` setting the bytes, the cards are
still counted, `models._read_devices`, the machine's devices without `gpu_gb`: #811), or Ollama swaps them on every
request. The keep_loaded models resident on `m`'s cards that no running task runs
(`_kept_beside`, from each such server's `/api/ps`, asked only when models.json lists any) count
in both the sum and, on `m`'s server, the loaded-model limit: free_gpu never unloads them, and
left out, a share was let in whose load made Ollama evict the user's protected model or the other
task's (#803). (The settings are read from the running Ollama's environment, `hardware.ollama_env_at`, which `wb
doctor` and `wb scout` say the source of, or that it is unknown). Admission
happens under the `gpu.admit` flock: holders are the `gpu.json` entries whose process is alive,
checked by identity (`_alive`: a pid of another user's is dead, unless the entry is that user's in a
shared lease (#393, above), and when available the process's start
time from `/proc/<pid>/stat` field 22 or `ps -o lstart=` must match the entry's `start`), so a pid recycled after a
reboot doesn't hold the GPU forever. ps runs with `TZ=UTC0` beside `LC_ALL=C` (`models._ps_start`): it prints
local time, and a Mac that changed zones, or a writer and a reader under different `TZ` (the launchd chat server
beside a shell's `export TZ`), read live holders, sessions and listeners as recycled pids (#848). A ps date that
doesn't match is compared once more in ps's inherited zone (`_same_start`, `same_tag` for the scratch
directories' tags), the format written before #848, so stamps from before the upgrade still match. `admits(m, held)`: no holder is waiting, every holder's
model still resolves, and there are no holders or `can_share` passes; then a runner joins with
`LOCK_SH|LOCK_NB` on `gpu.lock` (so a task alone holds the lock shared). Otherwise it marks
itself `waiting`, says "waiting for the GPU (held by <task>…)" and waits its turn: first come,
first served by the entry's `since` (when its task started, `task.json` `created_at`; a `wb image`
or `wb audio`, when it asked), then task name. A waiting lease holds no lock (`_take_alone` drops it first:
one let in sharing whose load then misfit kept its shared lock while second in line, so the first's
`LOCK_EX` never succeeded and every later task queued behind the two, #366). Only the first waiting
entry tries `LOCK_EX|LOCK_NB`; the others wait for gpu.json to change (`watch.Watcher`, at least every `QUEUE_POLL` 1 s). A blocking flock
promised no order among its waiters, and since a task sent back (`wb feedback`, `next`, `resume`)
keeps its start, its round goes ahead of tasks started after it instead of waiting out a night's
backlog while its review waits on it (#108). Once it holds the lock exclusively nobody joins it, and gpu.json is rewritten
to its own entry plus the waiting ones (any other is stale by construction). A lease that fails
or is stopped while queued removes its entry (a stale `waiting` entry used to make every later
task wait alone). `load()` serializes loads under `gpu.load`, reading the other holders' models
under `gpu.admit` only for that read (lock order: `gpu.load`, then `gpu.admit`), so an admission
or a finishing task's exit never waits for another task's load (a runner held there looked alive
after its review notice, and `wb feedback` refused it). After a shared load (other holders' models
kept) that loaded something (a load that took 0 s evicted nothing) `_fits_beside` reads
`/api/ps`: every kept model that was loaded before the load (`/api/ps` read under `gpu.load` just
before it) must still be loaded, as must every keep_loaded model listed then (`kept`: its
eviction passed unseen, #803), and all of `m` in VRAM, since need()'s guess can be short and
Ollama then evicts or splits a model, and two tasks reload theirs on every request. A kept model
already gone before the load was unloaded idle by Ollama's keep-alive (its task in a long test run
or waiting on a question), not evicted (the 0.90 review: the other task unloaded itself and waited
for that one to finish). If not, it warns "ollama could not fit … waiting for the GPU to itself",
unloads its own model (unless a holder runs the same model: it is theirs too), marks itself
waiting and takes its turn as above (its shared lock dropped first), then loads alone.
`gpu.json` is `{"<pid>": {model, task, since, start, uid, user, waiting?, waiting_since?, tests?, cards?}}` (`tests`: a task's
`--unload-for-tests` tests hold the GPU, `model` null; `cards`: an image or audio engine pinned to
those cards, `model` null). A lease with no model is alone unless it is pinned (`GpuLease(None, …,
cards=)`): `admits(None, held, cards)` lets it in, on a shared `gpu.lock`, when nobody waits and
every holder is a task on a local Ollama known to use none of its cards (`apart_cards`) or
another engine on other cards, and a task joins a `cards` holder when its own Ollama is apart
from them (then `can_share` decides beside the other tasks as before); refused without `--wait`
only when it couldn't join (#752). `wb image` takes `gpu.lock` through
`GpuLease(None, "wb image", wait=…)` (`wb audio`: `"wb audio"`, and the refusal names which): with `--wait` it queues in `gpu.json` like a task with no
model, waits for the running tasks to finish, then has the GPU to itself; while it holds or waits
for the GPU, `wb start` refuses a new task (exit 4, see *Two projects, one GPU*) unless `--queue`,
and `wb feedback`/`next`/`resume` queue behind it; without `--wait`, any live holder makes it
refuse at once (`models.busy` names them). A remote model (`local: true`) takes turns on its
server (#116): its lease uses that server's own files, `gpu-<host>-<port>.{lock,json,admit,load}`
(`models.pool`), in the same first-come order, one task at a time, since nothing here knows its
memory (before, tasks on one server ran at once and its Ollama swapped their models on every
request). It never waits on this machine's GPU, nor this machine's tasks on it; `wb start`'s
exit 4 and `--queue`, and the bench's preemption, apply per server alike. `free_gpu` never
unloads or stops a remote provider's models. **Which pool** (`models.pool`): `gpu` for a local
model, and for a remote one whose server is on this GPU (`models.same_gpu`: models.json
`same_gpu`, else WSL2's Windows host); `gpu-<host>-<port>` for any other remote one. A model on
the same GPU still never shares (nothing here measures its server's memory), but `free_gpu`
(`models.on_this_gpu`) unloads its Ollama's models, `make_resident` frees the GPU for it,
`releasable` and `media.settle` count it, its unloaded tests (`step_aside`, `verify`) hold this
GPU, and `wb optimize` probes it under its one lease (a second lease on `gpu` from the same
process waited on itself). An image or audio engine joins `gpu` when it is on this GPU
(`media.on_gpu`: a command, or a url here or on a host `media.shares_gpu` says is this GPU), the
pool of each remote box a url engine is on otherwise (`media.boxes`), or none (`"gpu": false`, a
host no task uses) (#750).

**Routing** (`router.rank`, `choose`). Rows: `store.results()` (no trials) that `tuning.judged`
keeps, for this model and size (and the models sharing its record, `lineage`: a `wb optimize
apply` variant and its source, #584). `judged` drops a discard marked `--spec-gap` and a task whose
agent never ran (row `ran` false: its setup or its model's load failed, `failed_before`; a row
from before `ran` was recorded: not accepted and `tok_out` 0): three discards of a lockfile
problem scored a model 0/3, and the router passed it by for good (#581). A row recorded on other weights than the model
has now is left out here, from the slice and from the tuning (`router.same_weights`, `weights_now`): each task
records `weights_id` (`models.identity`: Ollama's digest for the tag, else the bytes a server reports, asked
once per `FACTS_TTL`; a model whose server is down, or a row from before, still counts), since an id is an alias
and weights swapped under it (another GGUF behind llama-swap, a re-pulled moving tag) kept the old model's
record, slice and knobs (#726). Quality is the acceptance rate with a uniform prior, overall =
(accepted + 1) / (tried + 2), where 
accepted is the agent's kept share (`tuning.credit`): 1 when `tuning.agent_landed` (accepted
and no step `took_over`); a task Claude finished after `wb takeover` counts only the steps the agent
did, so a single taken-over step is a try, not a win (it counted as the agent's, so the model most
often taken over looked best, #647); a discard whose earlier steps `wb next` committed and the
branch kept counts their share (the row's `landed_steps` over its steps; `--drop-steps` writes
none): a chain of four approved steps whose fifth stuck counted as a whole failed try, for the
router, the tuning (`reward` is that share too) and the skills' records alike (#722); on the repo's stack (`gitops.stack`: up to two languages, each at
least 20% of the tracked source files, the package's alone when the task has one, #820; a
row's stack is the one recorded, else read from its repo, its `subdir` when the row has one)
quality = (like_accepted + `LIKE_PRIOR`·overall) / (like_tried + `LIKE_PRIOR`), `LIKE_PRIOR` = 2.
Each count in quality is weighed by recency (`_weight`: half for each `HALF_LIFE_DAYS` 60 of a
row's age, 1 without a `ts`; `Score.w`), so a record from a week a model was misconfigured
fades; `tries` and `wins`, shown in `Score.line`, stay plain counts (#648, the audit of main).
The available models within `QUALITY_MARGIN` 0.15 of the best are ordered by the guess
(`_guess`): those that fit the GPU before those that would spill (`fits`: Ollama says it's all in
VRAM, or `vram_gb`/weights within 90% of the budget; unknown is neither), then the largest by
weight bytes for `significant` work, the smallest for `trivial` (a size the server doesn't say is
guessed from the name, `Score.guessed`; a model of unknown size still ranks last), then
the one already resident. Then what Claude spends (`_cheaper`): once the guess's pick and another
model in the band each have `COST_MIN` 3 tasks of the size with a results `claude` (spend.py), the
one that costs Claude `COST_MARGIN` 15% less a landed step goes first ("costs Claude least on <size>
work"; a model that would spill never jumps one that fits). A landed step (`_per_step`): the rows'
weighted `claude` summed, over their `tuning.credit` times their steps, so a `wb next` chain's row,
which holds the whole chain's cost, is set against single tasks per step, and a discard adds what
Claude spent with no landed work; as a mean a task, a chain-heavy record looked dear and a model
discarded more often looked cheap (#903). Claude's tokens are what workbench
saves, and on 2026-11-18 the smaller model the guess sends trivial work to cost Claude more in
review and fixes than a larger one whose first change was right. With no spend recorded the guess
stands, so a new install routes as before. `Score.line` adds `~NK Claude tokens a landed step` once
it is evidence. The rest follow by quality, unavailable models last. `allowed()`:
models.json `sizes`; when it leaves no model, `choose` says "no local model takes <size> tasks
(…: limited by wb model sizes; …, or pass --model)", not that there are none. **Exploring** (`choose(size, stack, task_name)`, from `wb start`): one task in
`EXPLORE_ONE_IN` 10 (`explores`: a hash of the task's name, so the same name picks the same)
goes to the usable model outside the band with the fewest tasks of the size, while it has fewer
than `EXPLORE_TRIES` 3 (`unproven`; one that would spill only when the pick would too): one
discard on a model's first task, Claude's own wrong test, put it 0.17 below a model with no
record and it never ran again (#648). Without a name (`wb models --set-default`) nothing
explores. `choose` returns the pick and a reason ("the largest … that fits the GPU",
"the best record on significant C work", "exploring: its record on <size> work is N task(s), too
few to leave it out (one task in 10)", … "(vs …)"); "(its size guessed from its name)" after a
guessed pick, "(<ids>: size unknown, models.json weights_gb sets it)" when others are unknown, and
"sizes unknown: config order; …" when the pick's own is, not "the largest" (#704). `wb models` adds
a `size:` line for a model whose size the server doesn't say, and `wb doctor` a `--` line. `wb models` prints the ranking per size,
marking each unproven model ("out of the band on N task(s): one task in 10 explores it");
`--set-default` makes the pick OpenCode's default. A new model has no record, so Claude gives it
its first tasks by hand (`--model`).

**The slice** (`router.slice(m)`, printed by `wb start`, `wb models`, `wb scout`). The guess
scales with the window (`limit.context`; unknown → 32K): files = max(1, round(3s)), new lines =
max(50, round(15s)·10), s = min(window/32768, `GUESS_MAX` 4): 3 files/150 lines on 32K (measured
2026-11-16), 12/600 from 128K. Correction from the last `SLICE_RECENT` (20) closed steps on that model and window
(results rows' `steps`, with files ≥ 1, from rows `tuning.judged` keeps; files and lines without
the generated ones, `gitops.footprint`): `_went` is badly when the step compacted (in its last session, or in one a handover replaced: the `fresh` event's `compacted`), filled up
reading (`read_full`), got stuck (a `stuck` or `failed` notice of its rounds, but not one whose
`cause` is anything but `guard` or `agent` (`results.THE_STEP`, an allowlist: `signal`, `died`,
`server`, `updated`, `opencode`, `update` are outside the step), nor one from before `cause` with
`SIGNAL_STOP`'s, reap's or `UPDATED`'s text (an update mid-step had no cause and shrank the slice, #660): a shutdown mid-step shrank the slice for good, #582), or needed ≥ `BAD_REVIEWS` 2 agent-caused review rounds; well
when it landed and wasn't taken over; else no evidence. Files and lines are each learned alone:
the smallest bad step caps the slice below its size (files − 1, lines × 3/4); once `FIT_MIN` (2)
steps went well, the size `FIT_SHARE` (75%) of them reached (nearest rank) raises it, past the
cap only when that size is under the bad step's or the steps of the bad step's size or more went
well at least as often as badly. The biggest good step once raised it to its size and won over
the cap, with nothing decaying: one dependency bump (+2,400 lockfile lines) made a 128K model's
slice ~2,400 lines, and six later 900-line steps that all compacted left it there (#720). With
more steps than `SLICE_RECENT`, the line says `of the last 20 measured steps`. A handover is
counted, not held against a step.

**Budgets and speed** (`router.budgets`, `record_speed`, `speed`). After every round the runner
reads the session export (`measure_speed`) and `record_speed` keeps, per model, the write speed
((output + reasoning) / (completed − first token), samples of ≥ 100 tokens over > 1 s) and read
speed (input / (first token − created), ≥ 1000 tokens over > 0.5 s, also from a request cut
short before it completed), the last `SPEED_KEEP` 60 of
each, in `speed.json` (`{"<id>": {"write": [...], "read": [...]}}`, under `speed.lock`; this
machine's, in `store.machine_dir()`: on a network home a fast machine's samples outvoted a slow
one's, whose rounds then ran on the fast one's limits, #901); `speed()` takes the medians of
the first row it finds in this machine's `speed.json`, in order: the id; the ids it had before,
nearest first (`renamed_from`, #818, followed back; with the caller's `weights`, `earlier`'s,
which adds an id gone whose newest results row ran on the same Ollama digest); the variant a `wb
optimize apply` variant replaced (`replaces`); its source (`variant_of`): a variant's first round
got the default budgets and on a slow machine was stopped as stuck into the record it shares; the
source's speed, measured spilling, errs long (#906). Only when none of those has a row there, the
same chain in `$WB_HOME/speed.json` (every machine's, from before #901): so this machine's row for
a variant's source or a renamed model's old id wins over the shared file's row for the id itself.
It asks no server (#905).
At `wb start`, `budgets(m)` sets think = `THINK_TOKENS` 13,500 / write + window
/ read (either term alone when only one speed is measured: a read bound may be all there is,
#491), clamped to [420, `THINK_MAX` 1800] s, and scales silence (900) and round (2400) by
think / 420. No measured speed: the defaults. They are written into task.json at start, and
before each round `runner.stretch_limits` raises each one no flag gave (task.json
`timeouts_given`) to `budgets(m)` again where that is longer, into status `limits`, which the
round's guards and the layer's `chunkTimeout` read (`runner.limit`), with a `limits` event: a
first task whose round 1 measured the model slow kept 900 s of silence in every later round,
and a fresh session read its prompt again into the same wall (#814). A flag's value never
changes; a task from before the key keeps task.json's.

**Managing the set.** `wb model add <provider/model> [--pull] [--context N]` (Ollama): pulls
(`/api/pull`, progress every 5%), asks `/api/show` for capabilities and context, and writes the
whole opencode.json entry: `{name, tool_call, reasoning, limit: {context, input: ctx − ctx/8,
output: ctx/8}}` plus `options.max_tokens` = 2 × output (`ollama_cap`: Ollama ignores the
`max_completion_tokens` OpenCode sends and honours `max_tokens`; uncapped, a degenerate
generation runs until the context is full, seen as 20K-token turns with no edit). The context is
`--context`, else what Ollama serves (`ollama_served_context`: the loaded `context_length`, the
Modelfile's `num_ctx`, `OLLAMA_CONTEXT_LENGTH`), never the provider's other models' setting
(Ollama serves each model its own: beside a `wb optimize` variant whose 64K is its Modelfile's,
an add said 64K while Ollama served its default, #464, the audit of 1.8), and never the trained
length: with none of those, Ollama serves its own default (often 4K-8K, below
OpenCode's ~10K-token prompt), so add refuses and says to set `OLLAMA_CONTEXT_LENGTH` or pass
`--context` (the 2026-11-16 audit: a stock Ollama got a 256K entry and cut prompts off silently);
the trained length only caps the result. Another server's window is what it says
(`server_facts`), else `--context N` (the window it was started with), else a sibling's or the
entry's own; with none add refuses ("doesn't say what window it serves", LM Studio's case before
it loads the model): an entry with no window gets no handovers and no compaction (the 2026-11-16
audit). A `--context` past what the server says gets a `--` line (prompts would be cut off), and
LM Studio's `trained_for_tool_use: false` writes `tool_call: false`. An Ollama provider must answer first (`ollama_answers`), so a down Ollama is
named ("Ollama isn't answering at <root>: start it") rather than a pull's traceback or a describe
blamed on a missing pull; a failed pull is "pulling <name> failed: <reason>". It merges into an existing entry, so hand-added keys and options stay; a config with
`providers` instead of `provider` is read too. A model Ollama can't describe gets "is it pulled?
(--pull downloads it)". A model without tool calls is registered with "NO tool calls, so wb will
not route tasks to it". Add refuses a provider with a `url_problem`, an Ollama cloud model not
allowed in models.json, and a provider whose server is down with its engine only guessed and no
`start` (it can't tell whether to write Ollama's `max_tokens`). On a first run, `wb model add
ollama/<model>` with no provider `ollama` in the config and an Ollama answering at
`ollama_root_here()` (its service's `OLLAMA_HOST`, a bind address read as loopback, else
`127.0.0.1:11434`) first writes the provider (`add_ollama_provider`): `{"npm":
"@ai-sdk/openai-compatible", "name": "Ollama", "options": {"baseURL": "<root>/v1"}}` (under
`providers`, with `settings`, when the config uses that shape); a provider the user wrote is never
touched. Any other server gets the same in one command: `wb model add <provider>/<model> --url
<baseURL> --context N` writes `{"npm": "@ai-sdk/openai-compatible", "name": "<provider>",
"options": {"baseURL": "<baseURL>"}}` first (`add_server_provider`; refused for a URL that isn't
http(s), or that isn't on this machine unless models.json gives the provider `local: true`; a
provider of that id already there is kept as it is: the same baseURL, a trailing slash aside, goes
on to register the model, another is refused, naming both, so the model never lands on the old
endpoint while wb reports success (#334): give the server a provider id of its own), and
`--start CMD`/`--stop CMD` set the model's `start`/`stop` (a server that runs one model a process:
llama-server, vLLM; LM Studio's `lms load`/`lms unload`). Workbench isn't tied to Ollama: any
server OpenCode can reach works, its size and window read where it says them (`server_facts`),
with `--context` and `start`/`stop` saying what it can't (only Ollama was given a command for its
provider, and the skill steered every first run to it: 2026-11-17). Ollama keeps pulls, deletes
and sharing the GPU.
`wb model retire <id>
[--delete]` removes the entry (refusing OpenCode's default `model` or `small_model`, which was left naming it: #708) and with `--delete` the weights
(an Ollama that can't delete them is reported with `ollama rm <name>` after the entry is gone, a
404 as "had no weights", and `--delete` refused, naming them, while another entry on the same
Ollama still resolves to those weights: an alias's `id`, untagged read as `:latest`; #333, the
audit of 1.4. The same Ollama however its host is spelled, `localhost`, `127.0.0.1` or this
machine's name: `models.server_key`, which `Model.server` uses too; compared as strings, a retire
deleted the default's weights under another provider, #368, the audit of 1.6; and any provider
the config has, one in `disabled_providers` too: `models.configured_providers`, #458, the audit of
1.8); its results stay. `wb model sizes <id> trivial|significant|…` sets `sizes`. `wb doctor` asks each
Ollama provider once whether it answers (`ollama_answers`; a sleeping LAN box once cost 35 s a
model and ran doctor past Claude's 2-minute Bash limit): one that doesn't gets one `--` line, its
models read "ollama is not answering" without another probe, and their served-context checks are
skipped. It fails (BAD) when no model can run (with the first one's remedy), any discovered
entry of any engine with no `limit.context` (no handovers, no compaction: `wb model add <id>`,
with `--context N` for a server), an Ollama entry without `options.max_tokens` (`wb model add
<id>` writes it), and a provider with a `url_problem`; it compares `limit.context` with what
Ollama serves (more is BAD: prompts would be cut off silently; less is a note: tasks could be
bigger; unknown is a note), and the same for another server running the model (`server_facts`;
one not running isn't asked). `ollama_served_context` skips `/api/show` (10 s, not 30) when
`/api/ps` had no answer, and uses `OLLAMA_CONTEXT_LENGTH` only for an Ollama on this machine.
`wb scout` likewise asks each Ollama provider once and says when it isn't answering, and asks
another server once whether it answers before reading each model's size and window from it. It names each
config file it read, each skipped provider with its reason, and an
Ollama that answers while OpenCode has no provider at all.

**The machine** (`hardware.py`, read fresh on each call; it is also on the hot path:
`gpu_budget` runs in routing and in the lease). `system()`: `macos`, `wsl` (`/proc/version`
contains "microsoft"), `linux`. `gpus()`: `nvidia-smi` (`smi()`: from PATH, else WSL's `WSL_SMI`, `/usr/lib/wsl/lib/nvidia-smi`, which a systemd unit's PATH may lack; UUID, name, MiB total/used, driver; a name may hold commas) on Linux and
WSL (`[N/A]` reads as unknown, except on ARM (`aarch64`/`arm64`: a DGX Spark, a Jetson), where
the GPU shares the RAM (`shares_ram`): `unified` with `MemTotal`, and `ram_free` (`MemAvailable`) for the
budget's reserve, the 2026-11-19 audit and #524; with no row at all on ARM Linux, a Jetson
(`_tegra`: `/etc/nv_tegra_release`, or `nvidia,tegra` in `/proc/device-tree/compatible`, named
from its `model`) is that same entry, driver `nvidia (tegra)`: JetPack 5 has no nvidia-smi and
its GPU is a platform device the DRM scan skips, so it read as no GPU, no budget, no reserve
(#713); a line of fewer than
five fields is skipped); WSL adds Windows' adapters (`_windows_gpus`: one `powershell.exe
-EncodedCommand` of `WINDOWS_SCRIPT`, no quoting through the interop: `Win32_VideoController`'s
names, each one's memory from its driver's registry key, `HardwareInformation.qwMemorySize` under
the display class `{4d36e968-e325-11ce-bfc1-08002be10318}`, since `AdapterRAM` caps at 4 GB),
kept `WINDOWS_FOR` (an hour) in `wsl-gpus.json` (`store.machine_dir()`), as a PowerShell start takes seconds.

`powershell.exe` from PATH, else Windows' own under WSL's automount root (`hardware.powershell`,
through `hardware.windows_program`: `[automount] root` in `/etc/wsl.conf`, `/mnt/` by default, then
`WINDOWS_POWERSHELL`), since
`[interop] appendWindowsPath=false` takes it off PATH. A read that lists nothing (no PowerShell,
one past `_run`'s 10 s after a boot; Windows always lists an adapter) is no reading: the last good
one stays, its `tried` stamp waits `WINDOWS_RETRY` (60 s) before PowerShell is asked again.
Cached as an hour's "no GPU", a Radeon only Windows sees had no budget, and a read that only
sometimes worked flipped `wb optimize`'s fingerprint, so each flip emptied the GPU (#702).
The script first sets `[Console]::OutputEncoding` to UTF-8, and `hardware._run` decodes with
`errors="replace"`: PowerShell 5.1 writes a pipe in the console's OEM code page, and a localized
adapter name or error (`básico` in cp850) raised `UnicodeDecodeError` past `main` in doctor,
scout, top and GPU admission, again on every call since nothing was cached (#664). The same
decoding holds for the skill library's git, `models`' `ip`/`ifconfig`, stop commands and `ps`,
and the git shim's `--git-common-dir` (as `surrogateescape`: a path, kept whole).

A model served from Windows (Ollama for Windows) runs on any vendor's GPU, and inside WSL NVIDIA,
recent AMD (ROCm for WSL) and Intel (Level Zero) work: a 16 GB RX 7800 XT was "VRAM unknown", the
note said only NVIDIA is usable, and with no budget tasks took turns (#522). `gpus(windows=False)`,
which the budget and `wb image`'s settle use, leaves Windows' adapters out whenever Linux sees a
GPU (nvidia-smi), and takes them from the cache when it sees none; Linux scans `DRM`'s (`/sys/class/drm`) `card*/device` (amdgpu's
`mem_info_vram_total`/`_used`; an amdgpu device `apu` says is an APU, with a `mem_info_gtt_total`:
`unified`, its VRAM the carve-out plus the GTT, since that is where a Strix Halo with a
512 MiB carve-out keeps its models (the 2026-11-19 audit). `apu(dev)` is True when the card's
hwmon has `in1_label` `vddnb`, the northbridge voltage amdgpu shows only on APUs, False when it
has a hwmon without it, None without a hwmon (unknown: plain VRAM, not `discrete`). Taken from a
missing `mem_info_vram_vendor`, which the GCN cards' memory controllers never set, an 8 GiB
RX 580 with 24 GiB GTT was a 34.4 GB unified budget in `gpus` and in `wb top` alike (#435); KFD's
topology can't say, since a GPU node never carries the CPU's cores; `unique_id` as `uuid` `GPU-<id>`;
a unified device off macOS carries `memory`, what it counts, which `report` and the budget say;
names from `lspci`; a display-only driver (`DISPLAY_ONLY`: a BMC's `ast` or `mgag200`, a VM's
`bochs`, `cirrus`, `vmwgfx`, `qxl`, `virtio_gpu`, `vboxvideo`, `hyperv_drm`, `simpledrm`, USB
`udl`/`evdi`/`gud`) is no GPU, so neither the budget, the Vulkan mask nor `gpu_line` counts it: a
CPU-only rack server was told to set `gpu_gb` for its BMC (#710, as `wb top` already did, #551);
NVIDIA left to nvidia-smi when it answered,
else listed from sysfs, VRAM unknown); macOS reads `system_profiler SPDisplaysDataType -json`
(Apple Silicon: unified memory, `wired_limit`; an adapter with only shared memory, an Intel iGPU,
has VRAM unknown; `report` says of an Intel Mac's adapter that Ollama runs on the CPU there, and
`wb top` gives it no `total`, so its loaded models read `cpu`, not `split`: #711).
Every size `wb` prints is in decimal GB (`size`, `wb top`'s `_gb`, the progress of a pull `wb model add` starts), the
unit `gpu_gb` and `vram_gb` take and Ollama prints: scout showed a 16 GiB card as "16.0 GB VRAM"
beside "GPU budget 17 GB", and a 12 GiB card's owner who wrote `{"gpu_gb": 12}` got 7% less than
the card has (#523), so `gpu_line`'s hint says "the card's memory in decimal GB: 12.9 for a 12
GiB card". The pane's live view labels its sizes GiB, which they are. `size` prints `?` only
for None (unknown): 0 is "0.0 GB", since a models disk with nothing free and swap all in use read
as unknown in `wb scout` (#717).
`gpu_power_w()`: the cards' draw right now, in watts (None on macOS, or when nothing reads):
nvidia-smi's `power.draw` summed over the cards that report it, else each sysfs card's
`device/hwmon/hwmon*/power1_average`, else its `power1_input` (amdgpu generations with no
average), in microwatts, else the average since the last call from its `energy1_input` counter in
microjoules (Intel's i915 and xe publish only that; `_ENERGY` keeps each counter's last reading,
and a first reading or one that went back gives nothing for that interval). A connector,
`card0-DP-1`, is skipped. Read from `power1_average` alone, those cards' energy stayed 0 and the
savings said it wasn't measured (#271, the audit of 1.2). An APU's hwmon (`apu`) is its whole
package's, CPU cores too, so beside a card that isn't one it is left out; alone it is all there
is (#706). It is the GPU energy each task's
savings line shows.
`memory()`: `/proc/meminfo` or `vm_stat`/`vm.swapusage`. `cpu()`, `ollama_settings()` (the
environment of the Ollama that runs here and where it was read, `""` when nothing could say;
`ollama_env()` is its environment alone): `OLLAMA_KEYS` (`OLLAMA_MODELS`,
`OLLAMA_CONTEXT_LENGTH`, `OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_HOST`, `""`
when unset) and `SET_ONLY`, `VISIBLE`'s `CUDA_VISIBLE_DEVICES`, `ROCR_VISIBLE_DEVICES`,
`HIP_VISIBLE_DEVICES`, `GGML_VK_VISIBLE_DEVICES`, and `CUDA_DEVICE_ORDER` (only when set). The first source that answers
is the whole answer: an `ollama serve` whose `/proc/<pid>/environ` this user may read (one
started by hand in another terminal, a user unit's; under `PROC`; on macOS, which has no /proc,
`_ps_ollama`: each `ollama serve` in `ps -axo pid=,args=` and the environment `ps -wwE -o
command= -p <pid>` shows of this user's, a value cut at a space; unread, a hand-started or brew
Ollama's `OLLAMA_NUM_PARALLEL` was wb's guess, #804), lowest pid first; a systemd
`ollama` unit that is running (`systemctl show -p LoadState -p ActiveState -p Environment -p
EnvironmentFiles`, the system's then `--user`'s; `Environment` split as a shell would, since
systemd quotes a value with a space; each `EnvironmentFile=` read by `_environment_files`, over
`Environment` as systemd does: `KEY=VALUE`, `#`/`;` comments, a quoted value, a missing file
whose errors are ignored skipped; one it can't read is named in the source as `UNREAD`, "…
unreadable, so its settings may be missing", and `ollama_line` then doesn't say "Ollama's
defaults": unread, `/etc/default/ollama`'s `CUDA_VISIBLE_DEVICES` and `OLLAMA_NUM_PARALLEL` were
taken as unset, #804); a running container of an `ollama` image that
`docker ps` or `podman ps` lists (its `Config.Env`, from `inspect`, and the devices its
`HostConfig` gives it, `container_mask`: `DeviceRequests`' `DeviceIDs`, or a `Count` of the first
N, as `CUDA_VISIBLE_DEVICES` with `CUDA_DEVICE_ORDER=PCI_BUS_ID`, and `Devices`' `/dev/dri/renderD…`
as `ROCR_VISIBLE_DEVICES`, this host's numbering; unread, `--gpus device=0` was budgeted every
card, #463, the audit of 1.8; and within those, the container's own `CUDA_VISIBLE_DEVICES` and
`ROCR_VISIBLE_DEVICES` from its `Config.Env`, each ordinal an index into the granted list
(`hardware._within`: grants 2,3 and its `CUDA_VISIBLE_DEVICES=1` is this host's 3; a UUID as it
is; with every card granted, its mask and `CUDA_DEVICE_ORDER` as they are; its
`HIP_VISIBLE_DEVICES` passes through): dropped, two cards granted and one set were budgeted as
two, #651; the host-UUID mapping on a real two-card machine is unchecked); on macOS a brew
service's plist (`_launchd_ollama`: `launchctl print gui/<uid>/homebrew.mxcl.ollama`'s
`environment`, "launchd's homebrew.mxcl.ollama, not running"), else `launchctl getenv` (what the
app reads); a unit that isn't running. A process in another mount namespace than wb's, and a
container, give only `OLLAMA_KNOBS` (`OLLAMA_CONTEXT_LENGTH`, `OLLAMA_NUM_PARALLEL`,
`OLLAMA_MAX_LOADED_MODELS`), and a container its device masks mapped as above: their paths, bind address and device numbers are the container's.
A process in a container gives way to the container's own answer when `docker`/`podman` lists
one, since only its `HostConfig` says which cards it has (rootless docker or podman, whose
processes this user can read, and wb as root, were budgeted every card: the review of #463).
With none, wb's own environment is the guess and the source is unknown; `cli.ollama_line` (`wb
doctor`, `wb scout`, when a local Ollama model is configured) says so and points at models.json's
`gpu_gb` and `vram_gb`, or names the source and the knobs set. Read from systemd, launchctl or
wb's environment alone (which also filled in what a unit left unset), Ollama in Docker, one
started by hand, or Ollama for Windows from WSL had its sharing knobs read as unset (#379, the
audit of 1.6). A system unit's process runs as another user and can't be read: its unit says.
With several `ollama serve` readable here (one per GPU, each on its own port), `ollama_env_at(root)`
is the one whose `OLLAMA_HOST` listens on root's port (`_ollama_processes`; unset is `OLLAMA_PORT`
11434; a container's gives no `OLLAMA_HOST` and isn't matched), else `ollama_env()`; the GPU
budget (`budget_devices(root)`, `gpu_budget(root)`), the router's fit (`router.rank`, one
budget per server a pass: one for all held the 24 GB card's model back, #801), `can_share` and
`_room_beside` read the task's own server's devices, `OLLAMA_NUM_PARALLEL` and `OLLAMA_MAX_LOADED_MODELS`, the last
counting only the models on that server. The lowest pid's stood for both: two 24 GB cards were
budgeted as GPU 0 alone for the second server (#460, the audit of 1.8). Which cards each server
uses is `models.server_devices(root)`: its budget's devices (by UUID, else driver, name and size),
and only when `hardware.ollama_matched(root)` is sure of its process (several readable, exactly
one on that port); else None (one process readable, a container's, `gpu_gb` by hand, no card
named). `models.apart(a, b)`: both known and no card in common; unknown is never apart, which is
the behaviour from before. Servers apart don't touch each other's memory: `free_gpu(…, of=m)`
(as `make_resident` calls it) unloads only on the Ollama servers not apart from `m`'s, and
`_others_resident` asks only those; `_room_beside` and `can_share` count only the models on them
against `m`'s budget. Every server's models were unloaded, so a task on GPU 0's Ollama emptied
GPU 1's, and every running model was summed against one card, which refused sharing that fit.
`free_gpu()` with no `of` (`wb optimize`, an image or audio engine not pinned) still frees every
card; `free_gpu(…, cards=)` (an engine pinned with `devices` or `beside`, `media.cards`) unloads
only on the Ollama servers not known apart from those cards (`models.apart_cards`), and
`media.settle` waits only for those (#752: a generation on GPU 1 was refused while a task ran on
GPU 0, then emptied both).
`ollama_context()` (`OLLAMA_CONTEXT_LENGTH`
with spaces and quotes trimmed, as Ollama reads it, and the raw value: `report` says when it isn't
a number instead of crashing), `ollama_models_dir()` (`os.path.isdir`: a directory it can't read
is passed over), `visible(devs, env)` (the devices a runtime with that environment sees: by
number, counted per driver in sysfs's order or CUDA's, or by UUID or its unique start. CUDA's
order is nvidia-smi's (PCI) under `CUDA_DEVICE_ORDER=PCI_BUS_ID`; by default CUDA counts fastest
first, by a heuristic NVIDIA doesn't spell out, so when the NVIDIA cards differ (name or memory)
a number is read in that order as near as can be told, compute capability (`gpus`' `compute_cap`,
from a second `nvidia-smi --query-gpu=uuid,compute_cap`, asked only then, since a driver without
the field fails the whole query) then memory, and its note says it is a guess (`GUESSED`: set
`CUDA_DEVICE_ORDER=PCI_BUS_ID` or name the card by UUID). Read in PCI order, a 3090 beside a 1060
in a lower slot budgeted the 1060 for `CUDA_VISIBLE_DEVICES=0`, the 3090 to Ollama (#381, the
audit of 1.6); no such rig was at hand, so the guess at CUDA's heuristic is unmeasured. It
stops at the first entry naming no device, as CUDA does, so `-1` is none; unset is all, and so is
empty except `CUDA_VISIBLE_DEVICES` (`EMPTY_IS_NONE`: to CUDA an empty list is no device); each
mask counts within the order the one before left, so HIP's numbers index ROCR's list as ROCR
ordered it; a Vulkan-backed Ollama's `GGML_VK_VISIBLE_DEVICES` counts every card. Empty counted
every card, HIP picked by discovery order (the 4 GB card for the 24 GB one), and the Vulkan mask
was never read: #255, the audit of 1.2), `report()` (the lines `wb scout`
prints). Unknowns stay unknown; nothing about the machine is hard-coded.

**The weekly model check.** Models change fast. Once a week, in a quiet moment of a session that
delegates, with wakes on, the mod submits
SCOUT_NOTE (see *The mod, inside*); `/workbench-models` asks now, and `/workbench` runs one first when
no local model can run. `wb scout` prints the facts, read fresh: the machine (`hardware.report`),
Ollama's default context, every registered model (size, quantization, context, slice, real-task
record), installed models that aren't registered, the watch list (`watch.json`: models set aside
and what would bring each back; `--watch TEXT`, `--unwatch N`), flagged skills, waiting lessons,
image and audio engines (their licences change too: OmniVoice went non-commercial in 2026-07;
each engine with no `notes` says "licence: not noted", and `audio.coverage` adds a line of what
the audio engines cover: each kind's engines, the kinds with none, and speech with no listener,
#398). Claude researches what's newest from primary sources, recommends keep / add /
retire in a few lines and changes nothing without the user's yes; `wb scout --done --notes "…"`
records it (`scout.json` `done_at`, notes). `--due` says whether one is due.

## Bench: real tasks replayed

`wb bench` (`workbench/bench.py`) answers what the results rows can't: how two models, or
workbench before and after a change (the handbook, the protocol, a guard, a skill), do on the
same work. A case is one step of a task Claude accepted, replayed as it was handed out and graded
by the tests it was accepted with. It replaces a synthetic suite (removed 2026-11-16) whose toy
tasks every model passed in one round in a minute, so it told them apart by nothing. Shown only:
`wb models`, `wb scout` and `wb bench report` print it, and the router doesn't read it.

**A case** (`wb bench add <task> [--step N]`, by default a `wb next` task's last step) comes from
a closed, accepted task, not a trial. It keeps the task's setup, its setup's limit, copies,
siblings, grants, package (task.json `subdir`, kept as case.json `subdir`) and
`unload_for_tests`, and
its base check, its reference check, each replay (`wb start --setup/--setup-timeout/--copy/
--sibling/--allow/--unload-for-tests`: without the limit a replay's long build stopped at 1800 s,
failed as an `error` and was retried by every run, never graded, and without the flag its GPU
tests ran beside the resident model, #735; a case made before they were kept reads them from its
task, `bench._kept`),
the copies and siblings put beside the replay's checkout first, `bench._inputs`) and `wb bench
self` run with them; a setup that fails there refuses the case, saying it can't reproduce the
task's dependencies. A replay starts from the package (`--repo <checkout>/<subdir>`), so it
works, sets up and is graded there: without it a package's case ran from the root, and an
`answer.txt` written there passed a check of `app/answer.txt` (#425, the audit of 1.8). A case
made before `subdir` was kept reads it from its task (`bench.subdir`); with the task gone too, its
replays are `error` rows, never graded; a replay `wb start` didn't put in that package is an
`error` too. A task's `--setup` once made an ignored stamp its tests needed, and its
own commit was rejected, and its grants, deleted with its rules at the close, were empty
(#250, the audit of 1.2; `cli._keep_grants` keeps them in status `grants_kept`, which
`context.grants` reads once the rules are gone). The step's commit is found by its trailer
from the task's recorded tip (`gitops.step_commit`). Accepted with `--merge-as squash` after main
moved, the commits were in no branch once accept deleted `delegate/<task>`, a hash in status.json
kept no object alive, and once the reflogs expired and `git gc` pruned, no case could be made
(#649, Codex's audit of 1.90.6). So `wb accept` keeps the steps, base..tip, as a git bundle in the
task's own state, `tasks/<task>/steps.bundle` (`gitops.bundle_steps`, `STEPS_BUNDLE`: made in a
`--shared` scratch clone, so the user's repo gets no ref; named with `--git-dir`, since
`safe.bareRepository=explicit` refuses a bare repo git finds from the cwd, and every accept fell
back to the ref: #887), and `bench add` first puts them back
in the repo when git's gc has pruned them (`gitops.restore_steps`: `git bundle unbundle`, the
objects alone, no ref, no FETCH_HEAD, so git may prune them again). Until #799 (the second
2026-11-21 audit) accept kept a ref in the user's repo instead, `refs/workbench/accepted/<task>`
(`gitops.ACCEPTED_REF`, `keep_accepted`), which showed every task's steps in `git log --all`, went
out with each `clone --mirror` and kept whatever an agent once committed from git's gc; accept
still falls back to it when the bundle can't be made, and `wb gc` moves each such ref into the
task's bundle and deletes it (*Every `wb` command*, `wb gc`). The bundle stays with the task,
archived too, for as long as the task: `wb gc` once removed it when each step had its case, and
a case then removed with `wb bench rm` (to remake it with a case format's new fields) could
never be made again once git's gc pruned the steps (#940, the v1.90.24 review). A task accepted
before #649 has neither. It holds:
- its reference: the step's commit on `delegate/<task>` (trailer `Workbench-Task: <task> (step N)`
  from `wb next`, or `Workbench-Task: <task>` from `wb accept` for the last), and its base, the
  reference's parent;
- the base as `base.bundle`: branch `main` at one commit with the base's tree and message and
  no parent (`commit-tree`, a neutral identity, the base's date), made in a `--shared` scratch
  clone, so the user's repo gets no ref and nothing after the base (the answer) is in it. The
  base's whole history once went in, every reachable object of the repo for each case, about
  800 MB a case on a big repo, kept for good (#740, the 2026-11-21 audit); case.json `base` stays
  the original commit (submodules are filled by it). A shallow clone, whose cut-off history
  bundled but didn't clone ("remote did not send all necessary objects", #478, the audit of 1.8)
  and was refused since, has the tree and bundles; a
  bundle carries no Git LFS objects and no submodule, so every
  checkout of the case takes them from the case's repo (#509, the audit of 1.90: add refused a
  C/C++ task whose build needed `third_party/`, blaming the case): a clone of the bundle gets the
  repo's `filter.lfs.*` and LFS objects (`gitops.share_lfs`) before it checks anything out
  (`_clone_base`); add's scratch checkouts fill the submodules from the user's checkout of each
  (`gitops.fill_submodules`, as wb verify's are); a replay's or `bench self`'s checkout makes each
  submodule a repository of its own at the recorded commit, its objects borrowed from the user's
  checkout (alternates) and no ref but a detached HEAD (`_submodule_repos`), so `wb start` and the
  scratch checkouts fill the replay's worktree from it as from a user's checkout. When the repo is
  gone, or its checkout lacks a submodule, its commit or the LFS objects, add refuses and a replay
  is an `error` row, each naming the submodules or LFS (or a filter of the repo's own that can't
  make the task's bytes there: *Checkout settings*, #932);

- the spec (`spec.md`): the step's prompt (`rounds/<n>/prompt.md`, round 1's or the one opening
  `Step N-1 of this task is done`; `instructions.md` when the step began in a fresh session,
  `store.round_prompt`: read from prompt.md alone, every step sent with `wb next --fresh` was
  refused as gone, #503), cut at the protocol's fold (`FOLD`), and its acceptance
  command, the step's own (`wb next --test` can change it per step, and task.json's `test_cmd`
  keeps only the latest): status `step_tests`, which `wb start` and `wb next` record, or, for a
  task from before it, the protocol's `- The acceptance command is` line (`TEST_LINE`, across
  lines to the sentence's end: a one-line pattern read a command of several lines as none and
  refused the case, #941);
- the hidden checks: `--hidden` paths, by default the files the step added or changed that look
  like tests or the data a test reads (`verify.looks_like_test`, the one pattern `wb verify` uses
  too, *Verifying a fix against the base*: `tests/`, `fixtures/`, `test_*`, `*.test.*` and the
  like; #500, #731), listed NUL-separated as `wb verify` lists them (`gitops.name_status`: git
  C-quotes a name with a tab or a double quote even under `core.quotePath=false`, and such a test
  was missed or asked of git by its quoted name, #942), copied from the reference into `hidden/` with their Git mode (a
  100755 file stays executable: written at 0644, an executable `./test_check.sh` exited 126 on the
  right answer, #346), and overlaid with it on the base, the reference and every replay alike
  (`overlay`); and `--check`, a command that must pass too;
- the task's grants (`allow`, `paths`) and the original's model, rounds, reviews and minutes.

It is refused when the task isn't accepted or is a trial, the repo or the step's commit is gone,
the step had no acceptance command, there are neither hidden files nor `--check`, or the hidden
checks already pass on the base (a replay that changed nothing would pass), or its submodules or
Git LFS files can't be had (above): that is run once, in a
scratch clone of the bundle under `bench/`, in the original task's lane and environment as the
reference check below is (`runner.run_in_lane` on `_At`: a plain shell with the caller's
environment saw other files and variables, and left a hung check's children running, #81), for at
most `BASE_CHECK_SECS` = 120 s; past that, `base_check` says not checked. It is refused too when the
checks fail on the step's own commit run as a replay's grade is: the hidden checks overlaid on a scratch checkout under
`bench/` (in /tmp the git shim would allow writes), in the original task's lane and environment
(`runner.run_in_lane` on `_At`, the task with that worktree), up to the case's test timeout. A
suite that commits or writes outside the lane can never pass there: `clean-fixtures` (workbench's
own suite) failed every replay before this check (2026-11-17). A case is worth keeping when
the spec pinned what the hidden tests call: tests of names the spec left open fail a replay that
chose others.

**A run** (`wb bench run`) writes its plan (`bench/runs/<run>/plan.json`: each case paired with
each `--model`, by default every model that can run and takes the case's size) and detaches a
driver (`python -m workbench.bench <run>`, cwd its run directory, no Claude Code session in its
environment; `bench/driver.json` holds its pid and start time, which count only while that
process, started then, runs `-m workbench.bench`: `models._alive` and `models.runs`, below; and
its machine and host: on a state directory machines share, another machine's driver lives while
`bench/driver.lock`, which it touches every `runner.BEAT_SECS`, is younger than `cli.BEAT_DEAD`,
and `wb bench stop` here refuses it ("runs on <host>…: stop it there"; `wb stop --all` says so and stops the rest; #876: its pid was dead
here, so gc discarded its live replays and removed their clones, and `wb bench run` started a
second driver beside it); a run id taken in the same second gets `-2`, `-3`…). For each pair and `--repeat`, one at a time:
1. It waits while any real task is active (queued for the GPU too): real work comes first.
2. It clones the bundle into `bench/runs/<run>/<task>/repo` (an identity of its own: nothing
   commits; its LFS files and submodules from the case's repo, above) and starts a task there (in the case's package, `subdir`) through `cli.parser()` and
   `cmd_start`: `--trial`, task.json
   `bench` (`{case, run, label}`), the case's size, test, test timeout and grants, `--ask-budget
   0`, `--checkin 0`, `--queue`, `--no-claude-md`, and `--skill` for the run's. Everything else is
   as a real task runs: the same guards, nudges, auto-fix rounds and handovers.
3. It waits for review, stuck or failed (inotify on the task's directory, `reap` for a dead
   runner); a permission request is refused (`REFUSED`: no one is there to grant it).
4. At review it saves the diff (`diff.patch`), copies the hidden files over the worktree (a link
   the agent planted on the way is replaced, never written through: the driver runs outside the
   lane), and runs the acceptance command and `--check` in the agent's lane
   (`runner.run_in_lane`), output in `grade.txt`. Passed is both exiting 0; stuck or failed is
   failed, unless the machine failed it (status `infra`: the setup, a model that couldn't load or
   whose server slept past `DOWN_WAIT`, a crashed or reaped runner, a full disk): that is an
   `error` row with the reason, graded neither way and replayed by the next run. Counted failed,
   one asleep remote server marked a case lost for good (#508, the audit of 1.90).
5. It discards the task and the clone, and appends a row to `bench/runs.jsonl`.

A replay is kept out of real work: task.json `bench` makes `Task.notify` write nothing (no wake,
no notice), `results.record` write no row, `wb status` leave it out (unless `--all` or named), and
the mod skip it; `--trial` keeps its lessons out. Its speeds do go to speed.json: they are
measured on this machine. When `wb start`, feedback, next or resume would wait for the GPU behind a
replay (or `wb optimize`, *Optimize*), `cli._preempt_bench` stops it (phase stuck, `PREEMPTED`; never another machine's
replay, which `_stop_runner` refuses: wb start died before its `--queue` check, #895), says so in one line, and the
driver records `preempted` and replays it later. `wb bench stop` (or `wb stop --all` without
`--repo`/`--session`) ends the driver, which closes its replay. A driver killed without warning
(SIGKILL, the OOM killer, a hard reset) closes nothing: its replay stayed open for good, its clone
on disk, and its runner went on beside the next run's (#511, the audit of 1.90). So `wb gc` and
the next `wb bench run` call `bench.sweep`: each replay not closed whose run's driver is gone is
discarded (a live runner stopped first, `cmd_discard`) and that run's clones
(`bench/runs/<run>/<task>/repo` or `tree`) removed, but never another machine's replay whose
runner still beats, nor the clone of one whose discard was refused (#876); `wb bench run` then refuses while a replay's
runner still lives. `wb bench run` again skips each
(case, model, label, repeat) already passed or failed (`done_keys`; an `error` is replayed), so a
stopped run picks up where it was; when every one is done it starts no driver and says "all N
replay(s) already done (no --label): --label <name> runs them again" (or `under label X`).
Each row has `wb_commit` (the workbench clone's HEAD) and `label`: run a branch of workbench with
`--label` and compare it with main's rows in `wb bench report --label`.

**Claude writing it** (`wb bench self <case> --yes [--turns N]`, `bench.self_run`, #118) is the
other side of the handoff's cost. It runs Claude Code on the case: `claude -p --output-format
json --max-turns N` (40, `SELF_TURNS`) in a scratch checkout of the case's base, from its package
(`subdir`). The spec is
followed by `SELF_PROMPT` (the acceptance command, run before finishing).
- **What Claude may do.** Edits are allowed (`--permission-mode acceptEdits`), and of the shell
  only the acceptance command (`--allowedTools Bash(<cmd>:*)`, one rule per simple command of
  a compound line, which Claude Code checks part by part), since no one is there to ask.
- **Grading.** It is graded as a replay is: the hidden checks overlaid, then the acceptance and
  check commands in the original task's lane and environment (refused when that task is gone).
- **The cost.** claude -p's JSON `usage` becomes spend's shape (`_self_usage`: input, 5-minute
  and 1-hour cache writes, cache reads, output, turns, calls), so `spend.weighted` prices it as it
  prices a handoff. Claude Code 2.1.311 prints every event as a list ending in the result
  (`_self_result` takes either); from the list, `calls` is the assistant messages' distinct ids,
  as spend counts a session's, since `num_turns` counts one per tool call made in parallel.
- **The row.** It goes to runs.jsonl with `arm: "claude"`, `model: "claude"`, `label: "claude"`,
  `claude`, `turns`, `claude_model`. `wb bench report` keeps those rows out of the per-model
  table and lists each one under "Claude writing it": PASS or fail, its weighted tokens, and the
  handoff cost to Claude of the case's step (`handoff_cost`: its results row's `steps[step-1].claude`
  for a task of several steps, *Each step's share*; the row's `claude` for one step) with the
  ratio handoff/self. A task of several steps whose row has only the whole task's cost (written
  before #558) prints `handoff ~240K (all N steps; not comparable)` and no ratio.
- **The yes.** It refuses without `--yes`, because it spends Claude tokens, and nothing runs it
  on its own.

## Optimize: measuring this machine, when asked

`wb optimize` (`workbench/optimize.py`) is the one place workbench loads a model only to learn
about the machine. A run takes a minute or two (62 s for three models on the 2026-11-18 card), so
it runs on its own only where the user is told and expects a short wait, and only when it is due
(`due`: never measured, the GPU changed (`fingerprint`: each GPU's name and memory), a remote
server's models changed, a model came since (not one in `skipped` before its `retry_after`), a
model's fit is `stale` (the window its entry serves isn't the row's `window`, or its `/api/tags`
digest isn't the row's `digest`: a fit keyed to the GPUs alone stood after the entry went from
32K to 64K, or its tag was re-pulled as other weights, #709), or the last run was stopped): at the end of `wb setup`, and once per Claude Code session
opened, after its first turn while quiet (the mod's `measureIfDue`, gated like the weekly check:
`quietForJobs`, #541; `optimize.start` itself defers to a task holding the GPU; it toasts
"workbench: measuring the GPU for N local model(s) (<why>): about M min; a task you start goes
first" and wakes no one). `wb optimize start --if-due` is that check: quiet when nothing is due or
a task holds the GPU (the next session tries again). Due for a new or stale model only, it measures only
those (each other fit still holds) (`--all`, which a `start` without `--if-due` passes, measures every one).
A remote Ollama's models (`wb remote`) are measured too (#115), by the same `/api/ps` placement on
their own card, while this machine's lease is held and that server's too (`GpuLease(None, HOLDER,
wait=False, on=m)`, pool `gpu-<host>`): one whose server a task holds is skipped with a line ("a
task is using …"), since `probe` unloads the model it measures and the task may be using that very
model (#198, the 2026-11-19 audit); one whose server has another model loaded is skipped too
(`busy`: that card is in use, and its models aren't this machine's to unload), and so is one
whose box has the very model loaded for another client (not this machine's own load there,
`box_mine`, or one of those answering a request in `INFLIGHT_WATCH`): the box's lease is this
machine's alone, so `probe` unloaded and reloaded the model another client was running (#944).
Either is due again next time. A task that wants the server meanwhile stops the run, as on this machine. The fingerprint adds each remote server that answers, with the names and
sizes `/api/tags` gives (a re-pull can be another quantization); `changed` compares only the
servers both fingerprints know, so a gaming PC asleep, or new since, makes nothing due, and
`remembered` keeps what was known of one that didn't answer.
Anything heavier (`--bench`) waits for the user to ask, through Claude, in plain words ("optimize
my setup", "tune workbench overnight"): an unannounced long run could be cut short and alarm
people (the user, 2026-11-18). Everything else learns passively from real tasks (the router,
`tuning.py`, `speed.json`) and from estimates (`wb doctor`'s checks). Once a model has a better
window measured, `wb start` on it prints the advice as a `note:` (ask the user first: applying
it adds to their OpenCode config).

What it measures, per Ollama model that can run (`candidates`; not one in models.json's
`keep_loaded`, by id, name or an alias of the same model: a background run unloaded the user's
autocomplete model to measure it, #254, the audit of 1.2; nor this machine's when it has no GPU
Ollama could use, `no_gpu_here`: no GPU budget, `gpu_gb` unset, and no GPU listed, on macOS no
Apple Silicon one: a CPU-only box ran it by itself, loading each model into RAM twice, #809; a
remote model stays): the largest window that keeps the
model and its context all in VRAM, by Ollama's own placement after a load at each window tried
(`probe`: `/api/generate` with `options.num_ctx`, then `/api/ps` `size_vram` against `size`, then
unloaded). A load counts as whole only when `/api/ps` `context_length` (`served`) is at least the
window asked: a server that clamps every load (Ollama served 16K, all in VRAM, and a 64K fit was
recorded: #338, the audit of 1.4) records `clamped`, the largest window it did serve, and
`advice` says to fix the server's window or tell OpenCode that one. `fit` loads the served window first (`limit.context`); when it spills it searches down
from there to `models.MIN_WINDOW`, else up to twice it (never past what Ollama says the model was
trained on, nor `MAX_WINDOW` 128K, whose cache could fill system RAM), halving the gap in
multiples of `STEP` 4K: at most `loads(m)` loads, about six. Why it matters: on 2026-11-18 a 64K
window that put a tenth of a 27B model in system RAM wrote at ~17-21 tok/s where its 32K window,
all on the GPU, wrote at ~37, while the bigger window spared Claude review rounds (no
compactions). Where the line falls depends on the card, the model and the server, so it is
measured, and Claude and the user choose with both facts (`advice`): a spilling window and the
largest whole one, or a whole window with room for more. A fit with nothing in VRAM at any window
tried records `cpu: true` (Ollama runs it on the CPU here), and `advice` says nothing of it: "doesn't
fit the GPU whole even at 16K" was printed on every `wb start` and `wb doctor` of a machine with
no GPU (#809).

`wb optimize estimate` says how long (`estimate`: loads × the last run's measured seconds a load
(`secs_per_load`), else the median of the model's measured single loads (`models.single_loads`,
#577), else `LOAD_GUESS` 20 s; with `--bench`, the bench's cases × models × each
case's original minutes). `wb optimize start [--bench]` detaches the run (`python -m
workbench.optimize`, its output in `optimize.log`, its pid in `optimize.json`; it makes the state
directory first, which a fresh profile's `wb setup` hadn't, #198) so it outlives
Claude's session; it refuses while a task holds the GPU. The run holds the GPU alone (a
`GpuLease` with no model, named `HOLDER` "wb optimize"), and empties this machine's GPU
(`free_gpu`) only before its first local probe: a run due for a remote model alone unloaded the
user's local models for nothing (#583). A model it can't measure is recorded in optimize.json
`skipped` (`_skip`: `outcome` `busy`, its remote server leased or holding other models;
`failed`, its load refused, a `RuntimeError`; `unreachable`, an `OSError` such as a timeout),
with a `retry_after` `RETRY_SECS` later (6 h, 1 day, 7 days), which `due` honours: such a model
was "new" at every Claude Code session, whose run emptied the GPU and skipped it again, and one
model's HTTP 500 stopped the run, so the next measured every model again (#583). The run carries
on past it; a stop (`Stopped`) still ends the run. `--all` (an asked-for run) tries every model
again, and a measured row clears its `skipped` entry. `wb optimize report` lists each one with
its retry time. Real work stops it:
`cli._preempt_bench` sends it SIGTERM when a task would wait behind it and waits for it to exit
(`OPTIMIZE_EXIT`, 30 s at most) before the GPU's holders are read: `wb try` right after `wb
setup`'s run was refused by the entry it hadn't yet let go (#161). The fits measured so far stay
in `optimize.json`. With `--bench` it then starts `wb bench run` on every model, labelled
`optimize`. `wb optimize report` (the default) gives a line per model (never run: it names `estimate`, then
`start`, which is what measures; the refusals and `apply`'s name `start` too, #600); `wb doctor` adds the same
line (`--`) for each measured model with something to change. `wb optimize stop` ends it, only if
state.json's pid is still alive, started when it did, and runs `-m workbench.optimize`
(`optimize.running`). `models.runs(pid, *words)` is the one identity check behind every stop
(the runner's `cli.runner_alive` too): the words in a row in `/proc/<pid>/cmdline`, else in `ps
-ww -o command=` (macOS, where the bench and optimize stops trusted any live pid, so a pid a
reboot gave to another program got its SIGTERM: #82); with neither, the pid is trusted.

`wb optimize apply <id>…`, after the user says yes: makes the measured window an entry of its own
beside the model, never in place of it: an Ollama model named by `entry_name` (the source's
whole name, tag and quantization kept, the window as the tag's suffix: `family:32b-q4_K_M` →
`family:32b-q4_K_M-64k`, `m` → `m:64k`, an earlier suffix replaced; the family alone once named
`family:7b` and `family:32b` both `family-16k`, the second overwriting the first, the 2026-11-19
audit; a name already in OpenCode's config or Ollama is refused: retire it first) from it with
`num_ctx` N (`/api/create` `from`: no download, no GPU) and OpenCode's entry copied from the
model's (its options, such as `reasoningEffort: "none"`, kept; `limit.context` set to the new
window, and the caps recomputed together by `budget`: `limit.output` and `options.max_tokens`
kept while the output cap is at most half the window and leaves room for a handover before the
compaction (`runner.handover_warning`, #595), else cut to a quarter of it, `limit.input` the window less the
output cap, and an entry no request could fit refused before anything is made: a 16K fit of a
128K entry once wrote an input limit of -16384 and kept its 32K and 64K caps, #332, the audit of
1.4; an alias's `id` dropped, since it would name the old model). The variant gets a copy of the
source's models.json keys (`sizes`, `label`, `weights_gb`…) and `variant_of` the source's id (an
apply on a variant: the first source's, with `replaces` the variant's), whose speed it has until
its own is measured (`router.speed`, #906); the
router scores them on one record (`router.lineage`: `variant_of` followed to the first source,
then every model whose chain reaches it) and, when both can
run, puts the variant before the models it stands in for (`router.replaced`: its `variant_of` and
`replaces` chains, however far back), which stay for `--model`. An apply on a variant once wrote
`variant_of` the variant and lineage followed one level, so the first source's tasks left the
record, both the source and the first variant counted as replaced, and the router went back to
the spilling source (#723); `wb model retire` dropped a variant's `variant_of` with its other
keys, and its tasks with it. The source's optimize row gets
`applied` (the variant's id), so `advice` stays quiet while the variant is registered; a run
that measures the source again writes its row without it, so `optimize.applied` also knows the
variant by the name apply gives the measured window (it came back after a changed GPU or
`--all`, the review of #584), and the report says the variant is that window. Before,
the variant started with no record, ranked below the spilling source's one accepted task, every
start picked the source and repeated the advice, whose command then said "exists already", and a
source kept to trivial work got a variant that took significant work (#584). Retiring the
old one is the user's call (`wb model retire`). The config is checked first (`models.config_target`,
the checks `own_config` makes: one file, no comments, writable), before anything is made: the
variant was made, then a config with comments refused its entry, and once the config was plain
JSON the retry refused the variant as taken (#266, the audit of 1.2). A variant made and not yet
registered is kept in optimize.json `made` (`<provider>/<name>` → the source's id), so a retry
registers it without making it again; a model of that name nobody recorded there is the user's,
and refused as before.

## The skill library

The agents learn nothing between tasks; Claude does. When review teaches something that will come
up again (a library's quirk, a pitfall, a check to run), Claude writes a skill. Code:
`workbench/skills.py` (library, checks, record, suggestions), `workbench/scan.py` (security scan),
`workbench/lessons.py` (what tasks taught), `cli.cmd_skill*` and `cli.cmd_lessons`.

**Where and how it's stored.** The library is its own git repository: `$WB_SKILLS`, default
`~/.local/share/workbench/skills`, created on first use with `git init -q`, then `git
symbolic-ref HEAD refs/heads/master` (`skills._git`; git before 2.28 has no `init -b`, and the
library was never made, every skill command a traceback: #527). A skill is `<lib>/<name>/SKILL.md` plus any files beside it; a retired one is
`<lib>/retired/<name>/`. Only `<lib>/*/SKILL.md` is live (`available()`: name → {path,
description}; `resolve()` raises KeyError on an unknown name). Commits go under the user's git
identity, or `workbench <workbench@localhost>` when none is set (`_commit`), unsigned and without
hooks (`commit.gpgsign=false`, `core.hooksPath` = the null device, `--no-verify`): the library is
workbench's own record, and the user's signing prompt or a global hook failed `wb skill add` from
Claude's Bash (the 2026-11-16 audit); commits in the user's projects (`gitops.commit_all`) stay signed
as the user's git says. Signed, with no terminal or display (`NO_TERMINAL`), in a session of its
own with no controlling terminal (`gitops._run(detach=True)`: with one, as on WSL2, ssh-keygen
prompted on `/dev/tty` for a passphrase nobody typed, and accept waited all of `COMMIT_SECS`, start
`SIGN_SECS`, before refusing, #933) and `COMMIT_SECS` (90),
a refusal says how to unlock the key (`UNLOCK`: `ssh-add`, or one GPG signature in a terminal) or
`--no-sign`; `wb start` tries a dry `commit-tree -S` of the base's tree first (`sign_problem`,
`SIGN_SECS` 10) and prints the same line, since accept failed only at the end of the task with
"incorrect passphrase supplied" (#374, the audit of 1.6). A signer that asks the user each time
(`gitops.presence_signer`: an `sk-` SSH key, by `user.signingkey`'s literal or its file or `.pub`, no file looked for when it is unset and `gpg.ssh.defaultKeyCommand` picks the key: `Path("")` raised a ValueError, a traceback at every wb start, #662;
a `gpg.ssh.program` of its own, 1Password's op-ssh-sign; an SSH agent whose socket says it asks,
`ASKING_AGENTS`: Secretive, 1Password; an OpenPGP signing key on a card, whose `gpg
--list-secret-keys --with-colons` row has a token serial in field 15) gets no dry run, which made
the key blink on every start and on a timeout advised `ssh-add`, which can't make it sign (#528):
`wb start` says instead that accept waits `COMMIT_SECS` for a touch or an approval and that
`--no-sign` commits unattended (`touch_line`), and accept's and the merge's refusals name the
signer (`_unlock`, `unlock_how`) rather than `ssh-add`. `wb start --no-sign` (task.json `sign:
false`) or `wb accept`/`wb next --no-sign` commits unsigned. The merge or squash commit `wb
accept --merge` makes in the user's checkout gets the same (`gitops.merge`, `sign`; the closing
record's `sign` keeps a retry's merge as unsigned as the first run's): no terminal (detached when signed, #933), `COMMIT_SECS`,
unsigned after `--no-sign`, and a refusal that says how to unlock the key (`UNLOCK_HOW`) and merge
by hand; it signed after `--no-sign` and failed, and a pinentry nobody answered hung the accept
until Claude's Bash killed it, leaving `MERGE_HEAD` and the staged merge in the user's checkout
(#420, the audit of 1.8). They run no hooks either (`gitops.NO_HOOKS`, *No git hooks from the worktree*). Messages:
`<name>: <message>` (plus `\n\nSource: <source>` from `--source`), `<name>: retired: <message>`,
`<name>: restored`. `rev(name)` is the last commit touching the skill (`%h`), `revs()` maps
names to revs, `history()` the last five `%ad %s` lines over `<name>` and `retired/<name>`
(`wb skill show`). The library never lives in `~/.claude/skills` (the user's), and knowledge of
one project that only some of its tasks need belongs in that project's `.claude/skills` instead.

**Front matter** (`parse`): the file must open with `---\n…\n---`; only top-level `key: value`
lines count, indented lines fold into the previous key, block indicators (`|`, `>`) start empty,
quotes are stripped. Fields used: `name`, `description`, `license`.

**Checked on the way in** (`check` → problems that refuse, warnings Claude reads):
- Refused: no file; a name not matching `^[a-z0-9]+(-[a-z0-9]+)*$`; a front-matter name that
  differs; no description, or one over 300 characters (it's all an agent sees before loading);
  the whole file over 8000 UTF-8 bytes; a body path `references/…` that doesn't exist beside the
  source file, or one under `scripts/`, `templates/` or `assets/` when the skill has that
  directory but not the file. A single file (`--from <file>`) is copied alone, so its parent
  directory isn't the skill's: its paths are looked for only in the library's copy it updates
  (whose other files stay), and its parent isn't walked for clutter or counted; read from its
  parent, a scratch directory holding a `references/api.md` passed a skill that names a file the
  library's copy lacks (#907). A leading UTF-8 BOM (a Windows
  editor's) is read past (`parse`, `utf-8-sig`) and left out of the library's copy: before the
  `---` it hid the front matter, refused as "front matter name is ''" (#479, the audit of 1.8).
- Warned: a body over 120 lines; a home path (`/home/`, `/Users/`, `/root/`, `/var/home/`) or `~/` anywhere (agents go looking for those paths); a
  description without when/for/before/after/if; for a SKILL.md in a directory, clutter
  (README.md, CHANGELOG.md, .env, .gitignore, LICENSE.txt) or more than 10 other files; a body that
  reads like an incident log (3+ of `#NN`, `PR NN`, `issue NN`, `20YY-MM-DD`): a skill states the
  rule; a body path under `scripts/`, `templates/` or `assets/` the skill has no directory for
  ("if it is the skill's own file, add it; if it is a path in the project, ignore this"): those
  are ordinary project directories, and "run scripts/test.sh" was refused with no way in but
  rewording (#738, the 2026-11-21 audit).

**Scanned on the way in** (`scan.py`, adapted from Hermes Agent's `tools/skills_guard.py` at
081e8d9, MIT notice kept in its docstring; it keeps the critical and high rules, drops trust tiers
and the medium rules, and adds Unicode Cf and tag characters). 43 regex rules, 27 critical and 16
high, case-insensitive and multiline:
- exfiltration (critical: curl/wget sending a `$…KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL` variable
  to a non-loopback URL, `cat` reading .env/credentials/.netrc/.pgpass/.npmrc/.pypirc (not a heredoc writing one, not
  `.env.example`, not a line that warns against it: "Never `cat .env`"), staging in /tmp
  then sending it (curl, wget, nc, `python -c`; not a script of the skill's own); high: `~/.ssh`/`.aws`/`.gnupg`/`.kube`/`.docker`, `printenv`/`env |`, a
  markdown link carrying a variable, "send/post/upload … to http", webhook.site, requestbin,
  pipedream, hookbin, pastebin);
- prompt injection, each within one line and at most four words apart where the rule allows any
  (`S`, `W`: `\s+` and any number of words once read "## Ignore generated files", a blank
  line, "Follow all instructions" as one, #455) (critical: ignore previous instructions,
  disregard your rules, system prompt override, no restrictions, without filters, DAN; high: "you are now", "pretend to be", don't
  tell the user/reviewer, when no one is watching, output the system prompt, instructions in an
  HTML comment, a hidden `display:none` div);
- destructive (critical: recursive rm of the home directory itself (`~`, `~/`, `~/*`, `$HOME`,
  `${HOME}`, not a directory under it) or of `/`, `> /etc/` (high on a Dockerfile's `RUN` line or
  in a Dockerfile: it writes the image), mkfs, `dd of=/dev/`,
  sudoers/visudo);
- remote code (critical: curl|wget piped to a shell, `/bin/sh -i … >/dev/tcp`, a reverse shell
  (`reverse_shell`: nc/ncat/netcat with `-e` or `-c` of its own, not a later command's after
  `;`, `&` or `|`, socat to `exec:`/`system:`/`pty`),
  `python -c "import socket`; high: a listener (`listener`: `nc -l`, socat `tcp-listen:`), ngrok,
  localtunnel, serveo);
- obfuscation (critical: base64 decode or echo piped to an interpreter that runs
  what it reads (`| sh`, `| python3 -`; not `| python3 -m json.tool`); high: strings built from
  `chr()`);
- credentials (critical: PEM private keys, `ghp_`, `github_pat_`, `glpat-`, `sk-ant-`, `sk-`,
  `AKIA`);
- Claude's files (critical: a shell write to AGENTS.md, CLAUDE.md or `.claude/settings*` through
  `>`, `>>`, `sed -i` or `tee`, high when what comes before the `>` is itself one of them,
  `AGENTS.md > CLAUDE.md`; high: a line telling the agent to edit one).

The redirect rules (`REDIRECTS`: `> /etc/`, staging in /tmp, the write to Claude's files) match
the text with HTML tags blanked (`TAG`), so `Read <code>CLAUDE.md</code>` is no redirect;
`_softened` holds the other exceptions above (#455). Each finding's line names its rule
(`[pipe_to_shell]`).

File rules: what is scanned is what `skills.add` copies, which follows links. A symlink resolving
outside the skill, or into its `.git`, and binary extensions are critical; so are a link to
nothing (`symlink_dangling`) and a link to a directory holding it, the skill's own or one above
(`symlink_loop`): the copy, following links, failed on the first and recursed into
`self/self/…` on the second (#604, Claude's audit of 1.90); a link inside the skill is scanned as its target's bytes under the link's own name and
suffix (a link to a directory: its files are scanned under their own names), and a lone SKILL.md
given as a link as its target's text. Archives, NUL bytes and invalid UTF-8 are high. Media
files (.png .pdf .ttf …) are skipped only when they look binary (a NUL in the first 8 KB, or not
UTF-8); one that is text is scanned as prose (the 2026-11-16 audit: a link guide.md -> pic.png
holding an injection, and a linked SKILL.md, got in unscanned). Per line: invisible characters
(zero-width, bidi controls, tag characters, any other Cf except the soft hyphen) are critical when
a bidi or tag character is present, else high (a BOM at the very start is fine); 200+ blanks
followed by code is critical outside prose files (.md .txt .html .xml .tex .css; the pattern
uses a possessive quantifier, so Python 3.11+). `verdict` is dangerous (any critical) / caution /
clean. On an update only `new_findings` count: the same (file, rule, stripped line) is the same
finding whatever its line number. `content_hash` is a sha256 over each regular file's relative
path and bytes (display only). The rules are drawn to pass ordinary advice (`cat .env.example`, a heredoc
writing `.env`, `rm -rf ~/build`; `nc -l 8080` is only high); a skill still refused is reworded,
or, when the finding is safe as written (rustup's or bun's `curl … | sh` install line), added
with `--reviewed <rule>`: that rule's critical findings pass as warnings ("scan, reviewed: …")
and the commit records each under "Reviewed (the scan's critical findings, judged safe):". It
can't pass `scan.UNREVIEWABLE` (a symlink out, a binary, invisible characters, padded code, NUL
bytes: what reading the skill can't judge), and a rule with no finding is a warning. Before
#455 there was no way past a false positive.

**The flows.**
- `wb skill add <name> --from <file|dir> -m "<what review taught>" [--source …] [--lesson ID…]
  [--reviewed RULE…]` (`skills.add`): check, then scan (critical findings become problems, but
  those of a `--reviewed` rule, the rest warnings), then
  copy (`skills._put`): a directory source replaces the skill's directory, copied first into a
  scratch `.adding-<name>-…` in the library (`.git` ignored) and renamed into place, a file source
  only SKILL.md, written beside it and renamed over it, so a copy that fails leaves the old
  version as it was: copied straight in, a link it couldn't follow left the skill half there,
  live but uncommitted (#604). A failed copy or git call prints one `not added: …` line (`not
  patched`, `not retired`, `not restored`: `cli._skill_failure`). `git add -A -- <name>`, commit only if something changed
  (an identical re-add prints "updated" and commits nothing), and only that skill's paths
  (`commit -- <name>`; retire and restore `-- <name> retired/<name>`); a commit that fails puts
  the committed copy back (`skills._undo_put`: the old version, or none for a new skill). Add,
  patch (from reading the text it replaces), retire and restore each hold `locks/skills.lock`
  (`skills._library_lock`, reentrant) throughout: two sessions adding at once once committed
  both skills under one's message, the other's message, source and review record lost, or met
  each other's `index.lock` and left a skill live but uncommitted (#822). Refuses the names in
  `context.denied_skills()` (`workbench` and the user's personal skills), because skill denies
  are by name, and `retired` (the library's own directory, refused by `check`); refuses a source
  inside the library (it would be scanned against itself: use `patch`, or add a copy from
  elsewhere). `--lesson` closes those lessons as `skill:<name>`; when every given lesson came from
  one repo, `cli._one_project` warns the skill may belong in that repo's `.claude/skills`.
- `wb skill patch <name> --old … --new … -m why` (or `--old-file`/`--new-file`): the old text must
  occur exactly once in SKILL.md; the skill is copied to a temp draft, patched and re-added, so it
  is checked, scanned and committed like an add. Patch the passage that misled, in place, rather
  than appending a correction.
- `wb skill retire <name> -m why`: `git mv <name> retired/<name>` (an older retired copy is
  removed first, from the disk and from the index with `git rm --cached`, touching nothing else).
  `wb skill restore <name>`: the reverse; refused while a live skill has the name (retire it
  first).
- `wb skill scan <name|path>`: the scan alone; it exits 0 whatever the verdict.
- `wb skill show <name>`: the skill and its history (`wb skill list` has the record).
- `wb skill import <git-url|owner/repo|path> [--path <dir>] [--as <name>]` (`skills.fetch`): a
  local path is read in place; a URL (`://` or `git@`; `owner/repo` means GitHub) is shallow-cloned
  (`GIT_TERMINAL_PROMPT=0`, 300 s) into `$WB_HOME/imports/<slug>`, replacing an earlier clone.
  Several skills found and no `--path`: it lists up to 40 and stops. One: it prints the source
  and commit, the license (`license_of`: front matter, else the nearest `LICEN[CS]E*` file up
  the tree), the content hash and the scan, then the suggested `wb skill add … --source
  "<url>@<rev12> <subdir>, <license>"`. A dangerous one is refused, and a clone under `imports/`
  is deleted. Nothing enters the library by itself: Claude reads it, keeps what fits, rewrites it
  in the library's shape and adds it.
- `wb skill hand <task> <name…>` / `wb skill take <task> <name…>` change a task's skills from its
  next run (hand validates names; take doesn't). `wb start --skill` hands at start; `wb next
  --skill` replaces the set for the next step. Names may be repeated or comma-separated
  (`cli._skill_names`, which dies on an unknown name before anything is created).

**Handed to a task.** `status.skills` is the current set, `status.skills_ever` every skill the
task has held (what results call `skills_offered`; take never shrinks it), `status.skills_rev`
the library commit of each when handed, `status.skills_told` what the current session has been
told. `context.layer` puts each handed skill's directory (still in the library) into the config
layer's `skills` list, one directory each, so OpenCode lists exactly those, and allows the
directory for the file tools (`external_rules`). `runner.skills_note` prepends to the round's
prompt argument (not prompt.md): the whole set at a session's start ("Claude picked these
skills…"), afterwards only what was handed or taken back; it logs a `skills` event. A retired
skill drops out silently. `skills.loaded(task)` reads the `skill` tool calls from events.jsonl
(the event's brief is the skill id), so it also counts a repo's own `.claude/skills`.

**Judged on outcomes** (`skills.usage`, `record_line`, `advice`). Rows: `store.results()` (trials
left out) that `tuning.judged` keeps (a discard marked `--spec-gap` is dropped). Per skill:
offered (in `skills_offered`), loaded (in `skills_loaded`), and for loads: 
accepted (the agent's kept share, `tuning.credit`: none after a takeover, #647; a discard's
landed share, #722), first-try (`tuning.agent_landed` with no agent-caused review round: not
after a takeover, #647), review rounds a task; the same repos' tasks that
didn't load it; "since its last edit" (rows whose `skills_rev[name]` is the current rev); repos
loaded in. `advice`, first match wins: never offered; offered 3+ times and never loaded (its
description is wrong); 2+ tasks since its last edit and none accepted; 3+ loads under 50%
accepted (patch it with what review taught); 3+ loads and 3+ without, no better than without; not
offered in 60 days. `wb skill list` shows each skill's record and advice (and that a personal skill
shares its name, #515); `wb scout` lists the
flagged ones.

**Suggested for a spec** (`skills.suggest`, used by `wb start` when no `--skill` is given). Words
are `[a-z][a-z0-9]{3,}` minus 61 stopwords (`STOP`, grown after a spec matched an unrelated skill on "rows", "keep", "step"), stemmed by stripping the first of ing/ers/er/es/ed/s/e
that leaves 4+ characters. A skill is matched on its name and its trigger (the description up
to its first colon, else all of it). It's suggested when the spec shares at least `SUGGEST_MIN`
= 3 distinct words with them (one shared word is chance); the score counts name words twice; the
top 3 are shown. One loaded so far only in other repos says where, and on what stack when that
differs (`cli._elsewhere`; the other repo's stack is read from disk now), so one project's
knowledge doesn't spread unnoticed.

### Lessons

`workbench/lessons.py` gathers what each task taught into `$WB_HOME/lessons.jsonl`, for Claude
to turn into skills. `wb feedback`, `wb next`, `wb resume`, `wb accept` and `wb discard` call `harvest` and end
with one `nudge` line: `lessons: N from this task[, M seen in other tasks too] (wb lessons: write
or patch a skill now, while it's fresh)`. A task whose task.json has `trial` gathers nothing, and `wb trial` closes the open lessons of
the tasks it marks.

Sources, by `kind`:
- `feedback`: each round's prompt (`instructions.md` when a handover replaced `prompt.md`) starting with `FEEDBACK_HEAD` ("Review feedback from
  the senior reviewer."); one lesson per numbered item (`N.` or `N)`), else the whole body; capped
  at 600 characters, anything of 8 or fewer dropped.
- `agent`: the agent's `Lesson: …` lines in `summary.md` after "agent's summary:" (PROTOCOL asks
  for them; capped at 400). Skipped for a discarded task, and on a discard the task's open `agent`
  lessons are closed as dropped: a task that never found a working method has dead ends, not a
  recipe.
- `stopped`: every guard's `stopped` event, as "the guard stopped the agent: …"; a stop by the
  reviewer or the user (an event with `by`) is not a lesson.
- `question`: each answered `ask/*.json`, question and answer (permission requests answered by
  `wb allow` included).
- `spec`: each `status.spec_gaps` entry (`--spec-gap`), as "the spec missed: …": a lesson for
  Claude's spec checklist, not an agent skill.
- `skill`: at accept/discard only, when agent-caused review rounds > 0: one per loaded skill,
  "loaded X, yet needed N review round(s): does X say the right thing?".

A row is `{ts, task, repo, skills, id, kind, round, text}`. A lesson is known by (task, kind,
round, text), so re-gathering adds nothing; `id` is the shortest free prefix of sha1(task, kind,
round, text), `lessons.ID_LEN` (6) characters, two more at a time while it is taken (six alone
collided past a few thousand lessons, and the new lesson was never written: the 2026-11-16 audit). A close row is `{close: id, ts, how: "skill:<name>" |
"dropped", why}`. `survey` finds recurrence: a lesson recurs when one in another task (open or
closed, kind `skill` excepted) shares 3+ words with Jaccard ≥ 0.35; a closed match means it came
back after it was handled. Only lessons whose prefixes meet are compared (`lessons._pairs`,
prefix filtering, exact for that rule: each lesson's words rarest first, its first n − max(3,
⌈0.35 n⌉) + 1, `_prefix`; each pair once), the skills' descriptions are read into words once a
survey, and `nudge` (the line feedback, next, resume, accept and discard end with) surveys only
the task's new lessons (`survey(only=)`): every open lesson against all of lessons.jsonl, never
pruned, was 5 s at 3,000 lessons and 30 s at 5,000, on each of those commands (#556). A guard's
stop (kind `stopped`) is compared on what varies, its words less the guards' fixed wording
(`lessons.STOP_WORDS`): every stop shared it, so each was "again" of every other, those clusters
led every survey and boilerplate read as the lesson that recurs most (#733, the 2026-11-21
audit). Each
lesson is attributed to the first loaded skill still in the library, else the library skill
whose name and description share the most words (3+). `wb lessons`
lists the open ones, recurring first (by the other tasks where it is still open, then all of
them), at most 12 (`--all`, `--task`), each naming up to `AGAIN_SHOWN` (5) other tasks and
counting the rest ("also in N other tasks (t1, …, …)": listing them all made a line kilobytes
long, #733); `wb lessons close <id> -m
why` closes one (a one-task detail, an environment problem, a dead end); `wb skill add|patch
--lesson <id>` closes it as written into a skill. The weekly check counts what's waiting.

## Images

Claude can make images for a project (icons, illustrations, backgrounds, a README picture) with an
image model on the user's machine. Claude acts as art director: it writes the prompt, `wb image`
generates four candidates, and Claude looks at each one. Then it keeps one, rewrites the prompt
and tries again, or reuses a seed it liked. The image it keeps goes into the project and is
committed like any other change. Each image has a `.json` file beside it with the prompt, seed,
size and engine, so it can be made again. The coding agents can't make images; when one needs an
asset, it asks Claude.

**Setting it up is optional.** The first time a project needs an image, Claude offers to set it up.
It looks at the OS and GPU, then proposes a tool and a model whose licence allows the user's use,
and gives the download size. It installs nothing until the user says yes. To do it by hand instead,
here is what the development machine runs (Arch Linux, a 16 GB AMD card), about 11 GB of downloads:

```sh
sudo pacman -S --needed vulkan-headers spirv-headers shaderc cmake   # or the distro's packages
git clone --recursive https://github.com/leejet/stable-diffusion.cpp ~/.local/opt/stable-diffusion.cpp
cd ~/.local/opt/stable-diffusion.cpp && git submodule update --init --recursive
cmake -S . -B build -DSD_VULKAN=ON -DCMAKE_BUILD_TYPE=Release && cmake --build build -j
ln -s "$PWD/build/bin/sd-cli" ~/.local/bin/sd-cli
mkdir -p ~/models/image && cd ~/models/image
curl -LO https://huggingface.co/leejet/Z-Image-Turbo-GGUF/resolve/main/z_image_turbo-Q8_0.gguf
curl -LO https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q8_0.gguf
curl -LO https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors
```

Z-Image-Turbo is Apache-2.0, takes 8 steps and needs about 11 GB of VRAM at Q8 (smaller
quantizations fit smaller cards). On NVIDIA, build with `-DSD_CUDA=ON`; on a Mac, `-DSD_METAL=ON`.
Then describe the engine in `~/.config/workbench/images.json` (`$WB_IMAGES`). Two kinds work:

```json
{
  "z-image-turbo": {
    "command": "sd-cli --diffusion-model ~/models/image/z_image_turbo-Q8_0.gguf --vae ~/models/image/ae.safetensors --llm ~/models/image/Qwen3-4B-Instruct-2507-Q8_0.gguf -p {prompt} -o {out} -W {width} -H {height} --seed {seed} --cfg-scale 1.0 --steps 8",
    "label": "Z-Image-Turbo Q8 on stable-diffusion.cpp (Vulkan)",
    "notes": "licence: Apache-2.0; text to image only; 8 steps; ~11 GB VRAM"
  },
  "server": { "url": "http://127.0.0.1:30000/v1/images/generations", "model": "…" }
}
```

- A **command** is any command-line tool. `{prompt}`, `{out}`, `{width}`, `{height}` and
  `{seed}` are filled in, and the prompt is passed verbatim as a single argument, never through a
  shell.
  `ref_arg` (e.g. `"-r"`) adds `--ref` images, for models that edit or keep a character
  consistent.
- A **url** is any server with the OpenAI images API (SGLang, vLLM-Omni, LocalAI and others),
  or, with `"api": "a1111"` (a url with `/sdapi/` says so itself), AUTOMATIC1111's, Forge's or
  SD.Next's: `{"url": "http://127.0.0.1:7860/sdapi/v1/txt2img", "steps": 20, "unload":
  "http://127.0.0.1:7860/sdapi/v1/unload-checkpoint"}`, or, with `"api": "comfyui"` (a `workflow`
  says so itself), ComfyUI's: `{"url": "http://127.0.0.1:8188", "workflow": "flux.json"}`. The
  workflow is one saved with ComfyUI's **Export (API)** (not Save: that format has `nodes` and
  `links`, which `/prompt` refuses), a path from the engine file's directory or `~`, with
  `{prompt}` in its text node and `{seed}`, `{width}`, `{height}` wherever it wants them (a value
  that is only `{seed}`, `{width}` or `{height}` becomes the number). Its first SaveImage output
  is the image (a PreviewImage's if there is none).
  One started with an API key takes `"key"` (`{env:NAME}` and `{file:path}` work, as in
  OpenCode's config, a relative path from the engine file's directory), sent as a Bearer token.
- `notes` is shown to Claude. Put the model's licence there: some licences limit where and how
  their output may be used.
- `"gpu": false` marks an engine that isn't on this machine's GPU (a CPU build, another box): it
  takes no lease and frees nothing, so it runs beside a coding task. A url on another host is off
  this GPU by default (`"gpu": true` puts it back on), but when that host serves a model the
  coding tasks use (a `wb remote` box, WSL2's Windows host), it takes its turn there: it queues
  with that box's tasks (refused while one runs, unless `--wait`) and that box's Ollama models are
  unloaded first (`media.turns`, `media.boxes`: it took no turn and generated beside a task's model
  on that card, #750), but one another client of the box has loaded only once it has gone quiet
  (`box_quiet`, as a coding task's load waits; without `--wait` refused, naming it: the lease is
  this machine's alone, and the unload cut another client's round short, #944). WSL2's Windows host is this GPU (models.json `same_gpu`): an engine
  there, or a command engine in WSL, takes this machine's turn, which the tasks on Ollama for
  Windows take too, and their models are unloaded first.
- On a machine with several cards, pin an engine to the one it uses so it runs beside tasks on
  the others: `"devices": "1"` (the cards as the engine's own `CUDA_VISIBLE_DEVICES` names them:
  numbers in nvidia-smi's order, so give the engine `CUDA_DEVICE_ORDER=PCI_BUS_ID` too, or a
  card's UUID), or `"beside": "<provider/model>"` (the card that model's Ollama uses), e.g.
  `"command": "env CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=1 sd-cli …", "devices": "1"`.
  It then waits only for tasks on its card and unloads only the Ollama models there (#752).
  Unpinned, or where wb can't tell which cards each Ollama uses (one Ollama per GPU, each with its
  own `CUDA_VISIBLE_DEVICES`, *Sharing the GPU*), a generation waits for every task and empties
  every card.

A generation on this GPU takes the GPU lock and unloads the coding models first, just as a task does. While
a task holds the GPU, `wb image` refuses at once and names it; `--wait` queues behind it instead
(run that in the background: it can take as long as the task). A command engine exits when it's
done, so its memory is free for the next task. A url engine is a server you run: it keeps its
model in GPU memory for as long as it is up, so a coding model loaded beside it may spill into
RAM. Give it an `unload` URL, POSTed after each batch, and `unload_body` when it wants one
(a ComfyUI engine has one unless it says `"unload": ""`: its `/free` with `{"unload_models": true,
"free_memory": true}`; A1111/Forge: `/sdapi/v1/unload-checkpoint`; LocalAI: `/backend/shutdown`
with `{"model": …}`); without one, start it to make images and stop it afterwards (or give it a
GPU of its own). The listing marks such a server `(no unload URL)`. `wb scout` and `wb image --list` show each engine, whether it's ready, and which are
servers. `wb scout` also probes ComfyUI's and A1111's default ports here (8188, 7860) and names a
server answering there that no engine uses, with the entry that would.
Prefer weights in safetensors or GGUF from the model's own publisher or a well-known
quantizer. Prefer tools that load models without running code that comes with them (ComfyUI's
custom-node packs do run their own Python).

**How it works** (`workbench/images.py`, `cli.cmd_image`; what audio shares is in `workbench/media.py`).
- `images.json` (`$WB_IMAGES`, default `~/.config/workbench/images.json`) maps an engine name to an
  entry; the first entry is the default, non-object values are ignored. Keys: `command` or `url` (with `api`, `steps`, `workflow`),
  `ref_arg`, `model`, `label`, `notes` (shown to Claude: put the licence there), `timeout` (s,
  default 1800), `unload` and `unload_body` (a JSON object, else `{}`: `media.unload` POSTs it to
  `unload` when the batch ends, inside the lease, failed or not, `media.unloading`; it was checked
  but never called, and an image server kept 6-12 GB beside the next task's model, #749), `key` (a url engine's API key, `media.auth`: `models._expand`, no agent filter),
  `gpu` (`media.on_gpu`: false is off this GPU; unset, a url on another host is off
  it and anything else on; #587: a remote or CPU engine took the exclusive lease, unloaded the
  coding models and refused while any task ran), `devices` (a string or number, as
  `CUDA_VISIBLE_DEVICES` names cards: `models.named_cards` reads it through `hardware.visible`
  in nvidia-smi's order, `CUDA_DEVICE_ORDER=PCI_BUS_ID`, and for AMD cards as
  `ROCR_VISIBLE_DEVICES`) or `beside` (a discovered model id: its Ollama's
  `models.server_devices`): `media.cards`, the cards it is pinned to; one that names no card, a
  model not found or not a local Ollama, or `gpu_gb` set by hand is unknown, every card (#752).
- A command engine (`_argv`, through `media.fill`): `shlex.split(command)`, `~` expanded per token, then `{prompt}`,
  `{out}`, `{width}`, `{height}`, `{seed}` filled in (a whole float without its `.0`: `--seconds
  30` reached an audio engine as "30.0", #596), token by token, in one pass (a prompt that
  says `{seed}` reaches the engine as written; it used to get the seed and the out path), never
  through a shell; `--ref` images are appended as `[ref_arg, path]` pairs (both `command` and `ref_arg` are
  required for refs). stdin is /dev/null; stdout and stderr go to `<out_dir>/engine.log`; a
  nonzero exit or no file at `{out}` fails with the log's last lines.
- A url engine (`_server`, through `media.post`): POST `{prompt, n: 1, size: "WxH", response_format:
  "b64_json", seed[, model]}` with the `key` as `Authorization: Bearer` when there is one, decode
  `data[0].b64_json`, or fetch `data[0].url` for a server that ignores `response_format` (the key
  goes only to the engine's own server). An error status is a RuntimeError with the status and the
  first 300 characters of the body, and a 401 or 403 without a key says it wants one; a reply of
  another shape quotes it ("sent no image: …"), and a reply cut off mid-body or not HTTP
  (`http.client.HTTPException`, not an OSError: a server killed while sending) is `<url>: the
  reply was cut off (…)` (`media.cut_off`, in `media.post`, `images._get` and the url fetch; it was
  a traceback, #925). A 200 with a url gave "wb: b64_json", `{"data":
  []}` or a page that isn't JSON a traceback, a 400 only "Bad Request" (#597). An `a1111` engine
  (`images.api`, `_a1111`) POSTs `{prompt, width, height, seed, batch_size: 1, n_iter: 1, steps?}`
  and decodes `images[0]` (a `data:` prefix dropped); a Forge url got an OpenAI body and "sent no
  image" while listed ready (#753). A `comfyui` engine (`_comfyui`; its root is the url less a
  trailing `/prompt`, `images.comfy_root`) reads its workflow (`images.workflow`), fills it in
  (`images._fill`: a string that is only `{seed}`, `{width}` or `{height}` becomes the number,
  ComfyUI's KSampler refusing "3"; any other string gets the placeholders as text, in one pass),
  POSTs `{"prompt": <graph>}` to `/prompt`, polls `/history/<prompt_id>` every `COMFY_POLL` (0.5 s)
  until its entry appears or `timeout` passes, fails with the `execution_error`'s
  `exception_message` when its `status_str` is "error", and GETs `/view?filename&subfolder&type`
  for the first image with type "output" (else the first at all). Stopped before it finished (the
  timeout, a failed poll, wb ended) it POSTs `/queue {"delete": [id]}` and `/interrupt
  {"prompt_id": id}`: the prompt would otherwise draw on after the lease was released.
  `images.engines` gives a comfyui entry with no `unload` key `<root>/free`, `{"unload_models":
  true, "free_memory": true}` (`_defaults`): ComfyUI keeps every model it loaded. ComfyUI rejected
  the OpenAI body outright (#753). `ready` refuses an `api` outside `images.APIS`, a `steps` that
  isn't a whole number, and a comfyui engine whose workflow is missing, unreadable, not JSON, not
  the API format (every value an object with `class_type`), or without `{prompt}`.
- `wb scout` (`cli.image_server_lines`, `images.servers_here`): GETs `/system_stats` on
  127.0.0.1:8188 and :8000 (ComfyUI Desktop's, #923) and `/sdapi/v1/options` on 127.0.0.1:7860
  (`images.PORTS`; no proxy, 1 s each); a JSON object is that API, any other answer "something
  answers … but not its API" (an AUTOMATIC1111 started without `--api`), except on a port other
  servers use too (`images.SHARED_PORTS`: 8000 is vLLM's), where only a reply with ComfyUI's
  `system` and `devices` keys counts and anything else is skipped. On WSL2, when nothing answers
  here, the same ports at the Windows host (`models.windows_host`), all at once, tagged `windows`
  and said `on Windows (keep it started with --listen)`: in the default NAT networking a server
  on Windows isn't on 127.0.0.1 (#923). A port an engine's url already names on that host is
  left out; each other gets a line with the entry that would use it. None under
  `WB_FAKE_MODELS`. The skill proposed an 11 GB install to users already running one (#753).
- Ready (`ready`, shown by `wb image --list` and `wb scout`): an entry `media.problem` finds
  nothing wrong with (the string keys strings, a command `shlex.split` accepts, `timeout` and
  `seconds` positive numbers, `voices` a list of names, `gpu` true or false, `devices` a
  non-empty string or number, a known `kind` for
  audio; else "not usable: <why>", refused by `generate` before the lease: an open quote or
  `"timeout": "10m"` ended `wb scout` in a traceback or crashed a generation after the unloads,
  `"voices": "af_heart"` passed the voice "a", #596; a `url` or `unload` that isn't an http(s)
  URL with a host and a port in range, "url isn't a URL (<why>)": a `:port` placeholder ended the
  listings, `wb scout` and generation in http.client's InvalidURL, #748), then a command whose first token is on
  PATH or a file; a url whose server answers a GET within 2 s (any status but 401 and 403, "wants
  an API key" or "refused the key": #597, it was listed as ready and failed every generation).
- `generate`: its turns come from `media.turns`: an engine on a remote box the tasks use
  (`media.boxes`: a discovered remote model whose host is the url's and not on this GPU,
  `models.same_gpu`, one per lease pool) takes
  `GpuLease(None, "wb image", wait=…, on=<that model>)` on each such pool, as `wb optimize`
  does, and unloads that box's Ollama models (not `keep_loaded`), #750, another client's once it
  has gone `BOX_QUIET` without a request (`box_quiet(act=)`; refused without `wait`, #944), the
  pools always in one order, this machine's first, then the boxes' sorted by pool name (in engine
  order, two wb audio jobs with generator and listener on two boxes the other way round, two
  audio.json files on one shared lease directory, each held one box waiting for the other: #945); an engine off this GPU
  otherwise (`media.on_gpu`) runs with no lease and frees nothing; any
  other holds the GPU for the whole batch through `media.gpu`, that is `models.GpuLease(None, "wb image",
  wait=…)` (any live holder in gpu.json: a RuntimeError naming them, unless `--wait`; then it
  queues in gpu.json behind the running tasks; while it holds or waits, `wb start` refuses a new
  task (exit 4) unless `--queue`, and `wb feedback`/`next`/`resume` queue behind it), calls
  `models.free_gpu(keep=media.serving(engine))`, keeping only the discovered models on a url
  engine's own server (one LocalAI or vLLM serving coding and images was stopped just before the
  POST, #587), then `media.settle` (up to 90 s for what free_gpu lets
  go of, `models.freed`: local Ollama models and servers with a stop command, less what it keeps
  (`keep_loaded`), to go, and used VRAM
  to stop falling, after an engine started a second after the unload found 1.1 GB of 16 free; a
  server with no stop command, a remote model or a kept one used to cost every generation the
  whole 90 s (#467); skipped under `WB_FAKE_MODELS`). Seeds are seed … seed+n−1 (default seed `time() % 1_000_000`). Files are
  `<slug>-<seed>.png` (the slug is the prompt's first six words) in the output directory, made
  absolute first (on 3.11 `mkdtemp` kept a relative `--out` relative, so an engine that changed
  directory wrote its `{out}` elsewhere; `wb audio` too, #751), each with a `.json` sidecar
  `{prompt, seed, width, height, engine, refs, secs, ts, format}` (`width`/`height` measured from
  the file, not the size asked for). Each is made in a fresh temporary
  directory inside the output directory (`.wb-image-*`), refused when the engine wrote nothing
  there or what it wrote doesn't start like an image (`images.kind`: PNG, JPEG or WebP magic
  bytes; else "wrote no image (it starts '…')", `media.starts`: an HTML error page from an engine
  or an image url was published as a .png and reported as an image, #744), or starts like one but
  isn't whole ("wrote an incomplete image (…)": a PNG's IHDR size and its chunks walked to IEND,
  each within the file; a JPEG's SOFn size and an FFD9 after its first scan; a WebP no shorter than
  its RIFF size, with a VP8X/VP8/VP8L chunk giving its size; a zero width or height refused; bytes
  after a whole image pass, as decoders take them: a bare PNG signature, a JPEG cut before its end
  or a short WebP was published, its sidecar giving the size asked for, #946); a JPEG or WebP keeps
  its own suffix (`.jpg`, `.webp`; `format` in the sidecar says which), then published with its sidecar under the first of `<slug>-<seed>.png`,
  `<slug>-<seed>-2.png`, … that has neither (`media.free`): two prompts with the same first six
  words and seed wrote one PNG, the second over the first, and an engine that exited 0 without
  writing anything passed on the old PNG with its sidecar rewritten (#267, the audit of 1.2). An
  earlier candidate is never replaced. The name is claimed by creating its sidecar empty
  (`O_EXCL`; taken, the next `-k`) before the moves, so two runs at once never share one: two CPU
  `wb audio` runs (no lease) with one text and seed both reported one WAV, and one take was lost
  (#591). `--out` defaults to
  `$WB_HOME/images/<YYYYmmdd-HHMMSS>/`.

## Audio

Claude can make sounds for a project (a voice line or narration, a sound effect, a music loop)
with an audio model on the user's machine, the way it makes images (*Images*), with one
difference: **Claude can't hear.** So `wb audio` gives every candidate checks Claude can read,
and the skill says which judgements stay the user's:
- its length against the one asked for, its peak and clipping, its silences (lead, tail, and gaps
  of a second or more in the middle: a music model cut short, a sound effect that stops), and its
  loudness (LUFS, with ffmpeg);
- a spectrogram picture (`.png`, with ffmpeg), which Claude *can* look at: a dead track, a hard
  cut, noise where a footstep should be;
- for speech, a **listener**, a speech recognition engine that transcribes each candidate back,
  scored against the script as a word error rate: a skipped clause or a fumbled word shows.

Taste (a song, a voice's character) is the user's: Claude shortlists on the checks and asks the
user to listen. The keeper goes into the project, converted with ffmpeg as the project needs, and
is committed with what its `.json` sidecar says made it, like an image. The coding agents can't
make audio; one that needs a sound asks Claude. The weekly model check re-checks the audio picks
and their licences like the coding models (#398). With the web chat on, Claude sends its
shortlist there (`wb chat listen <clip>…`), and the user plays each take on the phone and taps
the keeper, which reaches Claude as a chat message (#397, *The web chat*, *Listening by ear*).

**Setting it up is optional.** Claude offers it the first time a project needs a sound and never
installs anything unasked (the skill's `reference/audio.md`). The recommended runtime is
[audio.cpp](https://github.com/0xShug0/audio.cpp): Apache-2.0, C++ on ggml with no Python at
inference, on Vulkan, CUDA, HIP, Metal or the CPU, and one CLI for speech, sound effects, music
and speech recognition, prebuilt for Linux and macOS. The models are picked by licence first:
some of the best liked aren't free for commercial use (OmniVoice since 2026-07, Breeze TTS 2,
YuE2, CrisperWhisper), and some are only below a revenue line (Stable Audio 3). What the plan
proposes, each checked at setup against its licence text:

| Kind | Model | Licence | Note |
|---|---|---|---|
| speech | Kokoro-82M | Apache-2.0 | small, real time on the CPU (`"gpu": false`), fixed voices |
| speech | Qwen3-TTS 1.7B VoiceDesign (0.6B Base to clone) | Apache-2.0 | a voice from a description |
| sfx | MOSS-SoundEffect v2 | Apache-2.0 | up to 30 s |
| music | ACE-Step 1.5 | MIT | lyrics optional; the 2B turbo fits 6 GB with offload |
| listen | Parakeet TDT 0.6B v3, or Qwen3-ASR 0.6B | CC-BY-4.0, Apache-2.0 | only checks transcripts |

```sh
sudo pacman -S --needed espeak-ng   # Kokoro's phonemizer (GPL-3.0), a shared library it loads; or the distro's package
git clone --depth 1 --branch v0.9.5 --recurse-submodules https://github.com/0xShug0/audio.cpp ~/.local/opt/audio.cpp
cd ~/.local/opt/audio.cpp && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DENGINE_ENABLE_VULKAN=ON
cmake --build build -j --target audiocpp_cli && ln -s "$PWD/build/bin/audiocpp_cli" ~/.local/bin/
mkdir -p ~/models/audio && cd ~/models/audio   # the Q8 GGUFs from audio-cpp/audio.cpp-gguf, 11 GB in all:
B=https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main
for f in Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf Parakeet-TDT-0.6B-v3-GGUF/parakeet-tdt-0.6b-v3-q8_0.gguf \
         MOSS-SoundEffect-v2-GGUF/moss-soundeffect-v2-q8_0.gguf ACE-Step1.5-GGUF/turbo/ace-step-1.5-turbo-q8_0.gguf
do mkdir -p "$(dirname $f)" && curl -fL -C - -o "$f" "$B/$f"; done
```

On NVIDIA, build with `-DENGINE_ENABLE_CUDA=ON`; on a Mac, Metal is on by default. Linux and macOS
release binaries are on its releases page too.

Then describe the engines in `~/.config/workbench/audio.json` (`$WB_AUDIO`). The flags below are
audio.cpp 0.9.5's, as run on the development machine (some families take `--seed`, others
`--request-option seed=`; a Kokoro voice needs its own `--language`: `af_`/`am_` voices
`en-us`, `bf_`/`bm_` `en-gb`, so one engine per language):

```json
{
  "kokoro": {"kind": "speech", "gpu": false, "voices": ["af_heart", "am_puck"],
             "command": "audiocpp_cli --task tts --family kokoro_tts --model ~/models/audio/Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf --backend cpu --language en-us --voice-id {voice} --seed {seed} --text {text} --out {out}",
             "notes": "licence: Apache-2.0; English best; no cloning"},
  "moss-sfx": {"kind": "sfx",
               "command": "audiocpp_cli --task gen --family moss_soundeffect --model ~/models/audio/MOSS-SoundEffect-v2-GGUF/moss-soundeffect-v2-q8_0.gguf --backend vulkan --text {text} --request-option duration_sec={seconds} --request-option seed={seed} --out {out}",
               "notes": "licence: Apache-2.0; 0.1-30 s"},
  "ace-step": {"kind": "music", "seconds": 30,
               "command": "audiocpp_cli --task gen --family ace_step --model ~/models/audio/ACE-Step1.5-GGUF/turbo/ace-step-1.5-turbo-q8_0.gguf --backend vulkan --task-route text2music --text {text} --lyrics {lyrics} --duration-seconds {seconds} --seed {seed} --out {out}",
               "notes": "licence: MIT; instrumental when no --lyrics"},
  "parakeet": {"kind": "listen", "gpu": false,
               "command": "audiocpp_cli --task asr --family parakeet_tdt --model ~/models/audio/Parakeet-TDT-0.6B-v3-GGUF/parakeet-tdt-0.6b-v3-q8_0.gguf --backend cpu --audio {in}",
               "notes": "licence: CC-BY-4.0"},
  "server": {"kind": "speech", "url": "http://127.0.0.1:8080/v1/audio/speech", "model": "qwen3-tts",
             "unload": "http://127.0.0.1:8080/v1/tasks/unload_all_models"}
}
```

**Measured on the development machine** (2026-11-20, #396: Arch Linux, a 16 GB AMD card on
Vulkan, audio.cpp 0.9.5, the Q8 GGUFs; each call loads its model afresh, which these times
include; VRAM is the peak above the desktop's own 1.5 GB). They describe this machine, not a
requirement:

| Engine | Clip | Time per clip | VRAM |
|---|---|---|---|
| Kokoro-82M, CPU | a 3.7 s line | 1.5 s | none |
| Parakeet TDT 0.6B v3, CPU (the listener) | a 6 s clip | 1.8 s | none |
| MOSS-SoundEffect v2, Vulkan | 4 s | 23 s | 5.1 GB |
| ACE-Step 1.5 turbo, Vulkan | 20 s, instrumental | 12 s | 10.6 GB |

What the runs taught: Kokoro needs eSpeak-ng installed, and a voice needs its language
(`bm_george` with `en-us` exits "voice/language mismatch"); its takes of one script differ only
slightly. A sound effect's hit came 0.8 to 1.45 s in (the line's lead), so the skill says to trim
it. ACE-Step's takes peaked at -0.2 dBFS, near clipping, before any `loudnorm`: read then on the
16 kHz mono copy (#586), so the stereo original's peak is at least that, and may clip.

- A **command** engine fills `{text}`, `{out}`, `{seed}`, `{seconds}`, `{voice}` and `{lyrics}`
  the way `wb image` fills its placeholders: one argument each, never through a shell. An option
  the engine has no placeholder for is refused, not dropped. `ref_arg` adds `--ref` clips; clone
  only a voice the user has the right to.
- A **url** engine is any OpenAI `/v1/audio/speech` server (audio.cpp's `audiocpp_server`,
  Kokoro-FastAPI, Speaches). It makes speech only, since sound effects and music have no common
  API. `unload` is POSTed after each batch so the server lets its GPU memory go (audio.cpp's
  `/v1/tasks/unload_all_models`), as a url image engine's is (`unload_body` too). A listener's `unload` is
  POSTed too, each URL once (only the maker's was, so a GPU listener kept its weights after the
  lease was let go: #594). `key` is sent as a Bearer
  token, as for images, to the speech, transcription and unload URLs alike; an error status
  says what the server said (`media.post`, #597), and a reply cut off mid-body says so in one
  line (`media.cut_off`, #925).
- A **listen** engine prints its transcript on stdout (`{in}` is the clip; JSON with `text`, and
  audio.cpp's `text_output=` line among its `key=value` lines, are read too), or is an OpenAI
  `/v1/audio/transcriptions` server. The first one in the file checks
  every speech batch.
- `"gpu": false` marks an engine that runs on the CPU. It takes no GPU lease and frees nothing,
  so it can run beside a coding task. A url engine on another host is off this GPU unless it
  says `"gpu": true` (`media.on_gpu`, as for images), or is on a remote box the coding tasks use,
  where it takes that box's turn (`media.turns`, as for images, #750). `devices` and `beside` pin
  an engine to its card, as for images (#752); the batch's lease is pinned only when the engine and
  the listener both are (their cards together). Any other engine has the GPU to itself,
  exactly as `wb image` does, and `free_gpu` keeps the models on the engine's or the listener's
  own server (`media.serving`).

**How it works** (`workbench/audio.py`, `cli.cmd_audio`; shared with images: `workbench/media.py`).
- `audio.json` keys: `command` or `url`, `kind` (`speech`, `sfx`, `music`, `listen`; default
  `speech`), `gpu`, `devices`, `beside`, `voices`, `seconds`, `unload`, `unload_body`, `key`, `ref_arg`, `model`, `label`, `notes`,
  `timeout` (s, default 1800; a listener's 600); `audio.ready` refuses a `kind` it doesn't know
  (it skipped the listener and took 10 s, #596). `engine(name, kind)` returns the named engine
  (refused when it's of another kind), else the first of `--kind`, else the first that isn't a
  listener.
- `generate` refuses, before anything runs, a voice not in `voices` and a `--voice`, `--lyrics`,
  `--seconds` or `--ref` the engine has no slot for. It runs under `media.turns("wb audio", …)`: `media.gpu`
  (the lease, `free_gpu`, `settle`) unless both the engine and the listener are off this GPU, and
  a turn on each remote box either is on (#750).
  Each clip is made in a temporary directory (`.wb-audio-*`), checked there (`inspect`), then
  published with its sidecar and spectrogram under the first free `<slug>-<seed>.wav`
  (`media.free`, #267). A url engine POSTs `{model, input, voice, seed, response_format: "wav"}`
  and saves the body. The `unload` URLs of the engine and the listener it used are POSTed
  (`_unload`, that is `media.unload`, each distinct URL once) when the batch ends, inside the lease, whether it failed or
  not.
- `inspect`: with ffmpeg, it makes a 16-bit PCM copy first at the clip's own rate and channels
  (the `wave` module reads only integer PCM; `_plain_tag` marks the copy plain PCM, since for
  more than two channels ffmpeg writes WAVE_FORMAT_EXTENSIBLE, which `wave` reads only from Python
  3.12), measures loudness with `ebur128` and draws the
  picture with `showspectrumpic`; the listener alone gets a 16 kHz mono copy. Without ffmpeg it
  uses the `wave` module alone and says "loudness: no ffmpeg". A file ffmpeg can't decode, or,
  without ffmpeg, one the `wave` module can't read that doesn't start like audio (`MAGIC`: RIFF,
  FLAC, Ogg, ID3, an MP3 frame…), is no clip: `generate` raises "audio engine <name> wrote no audio
  (it starts '…')" and publishes nothing; an engine's HTML error page was published as a `.wav`
  and counted as made, exit 0 (#592). Without ffmpeg, a float or 24-bit WAV is published with the
  note "unreadable: … no ffmpeg to convert it". Either way the levels come from
  each frame's loudest channel at the clip's own rate: measured on the 16 kHz mono copy, a stereo
  take clipped on one channel read clean, one with a channel inverted read SILENT (the downmix
  cancelled it), and clipping above 8 kHz was filtered out (#586). `_measure` reads the WAV 50 ms
  at a time into `_Meter`, which keeps running totals (the peak, the clipped count, one bool a
  block), so memory doesn't grow with the clip: every sample as a Python float took ~200 MiB for
  5 minutes, over 1 GiB at 48 kHz stereo (#599); `levels` is the same over a list of samples.
  The blocks: silence is below `SILENT_DB` (-50 dBFS), a gap is
  `GAP_SECS` (1 s) or more between sounds, and a sample at 0.999 of full scale or more counts as
  clipped. `_spans` aligns the script's words with the heard ones (`_align`: the fewest word
  edits, Levenshtein with a backtrace, lower case: the common start and end matched without a
  matrix, then two rows of costs and a byte a cell for the way back, over a band of diagonals:
  `ALIGN_BAND`, 32 edits either side, doubled (up to the whole matrix) until the alignment found
  costs no more edits than the band reaches: one that cheap never leaves the band, so it is the
  full matrix's, ties and all; past `ALIGN_CELLS`, 64M cells (script units times the band), a
  ValueError "too long to score: …" reported as the listener's failure. A full matrix of Python
  ints took 327 MiB and 3.5 s for a 3,000-character Japanese script, several GiB past 10,000,
  #947; a cap of 16M pairs between the common ends then refused 4,100 characters with a miss at
  each end, which had scored before. A take that follows its script costs a sliver: 20,000
  characters, 0.5 s and 11 MiB; one read as another text, the whole matrix, 14 s at 5,600) and
  keeps each stretch of edits as a span,
  except those that differ only in spacing or apostrophes ("boatswain's", "Boat Swain's"); `wer`
  is the substitutions, deletions and insertions over the script's words, not capped at 100%,
  `differences` the first four spans as `script → heard`, both from one alignment (`score`,
  which `inspect` calls once: it aligned each take twice, #947). `difflib` paired an insert with a
  delete among repeated words: one wrong word in "go go go go" scored 100%, its differences
  wrong too (#593). `words` NFC-normalizes the text first (`café` precomposed against one with a
  combining accent scored 1.0, #747), keeps letters, digits, apostrophes and their combining marks (`\w`
  split Hindi and Thai at each vowel sign), and splits a script written without spaces
  (`UNSPACED`: Thai, Lao, Myanmar, Khmer, kana, CJK ideographs; not Hangul) into characters, a
  mark kept with its base; `_join` writes such a span back without spaces; when most of the
  script is such characters (`by_characters`) the sidecar has `cer: true` and the line says CER.
  Counted as words, one wrong particle in a Japanese clause scored 100% (#598). The line shows both, because a WER alone misled on the first
  real run (#396): a perfect "Twenty twenty-six" read 30%, the listener having written "2026". A listener that fails is reported on the
  line, not raised. Its output, ffmpeg's, and the engine log's tail on a failure (`wb image` too)
  are decoded as UTF-8 with bad bytes replaced: a listener that split a CJK character, or a
  Windows program's code page through WSL, ended the run in a UnicodeDecodeError traceback (#743).
- The line reads `3.4 s (asked 3) · peak -1.2 dBFS · -16 LUFS · lead 0.1 s, tail 0.3 s · gaps … ·
  heard "…" WER 30% (twenty twenty six → 2026)`, then the spectrogram's path. Under 80% of the asked length it adds "cut
  short".
- `lines()` (`wb audio --list`, `wb scout`) shows each engine's kind, whether it's ready, its
  voices and its `notes`, or "licence: not noted" when it has none; `coverage()` is scout's line
  of what the engines cover (#398: the weekly check re-checks audio picks and their licences).
- **Listening by ear** (#397, `chat.listen`, `wb chat listen <clip>… [--text "…"]`): up to
  `LISTEN_MAX` (8) takes Claude has shortlisted, each a `.wav` (or `.mp3`, `.ogg`, `.opus`,
  `.flac`, `.m4a`: `AUDIO_TYPES`, what a browser plays) of at most `AUDIO_MAX` (64 MiB), is
  copied into `chat/audio/<batch>/` as `<n>.<ext>` with `audio.json` (each take's name, path,
  media type, and its check line, `audio.summary` of the `.json` sidecar beside it; engine,
  seed and voice from the sidecar too), and sent as a message from Claude carrying `audio`
  (`chat.audio_batch`: `{batch, clips: [{n, name, line}]}`). The page plays wb's own copy, so a
  clip changed or moved since still plays as it was sent. A link, a missing clip, a file the page
  can't play, too many or too big are refused before anything is copied or sent; a copy that
  fails mid-way removes the batch. Only the newest `LISTEN_KEPT` (20) batches are kept: an older
  take's player says "This take is no longer kept." The keeper comes back as the user's message
  `Keep take <n>: <name>` with `about: {audio, n, name, path}`, the name and path taken from the
  batch, not the page.
- The sidecar: `{text, kind, seed, seconds, voice, lyrics, refs, engine, secs, ts, duration,
  peak_db, clipped, lead, tail, gaps, silent?, lufs?, transcript?, wer?, differences?, listener?,
  listen_error?, unreadable?}`. `--out` defaults to `$WB_HOME/audio/<YYYYmmdd-HHMMSS>/`.

## Git, commits and projects

- **How workbench reads git** (`gitops.git`). Every call runs with `-c color.ui=never` (and
  `color.diff`, `color.status`, `color.branch`, which outrank it), `-c core.quotePath=false` and
  `-c log.showSignature=false` (with signed commits it put "No signature" ahead of the hash a `git
  log --format=%h` was read for, and a finished `wb accept` exited 1; the skill library's git
  runs with it too) and `-c submodule.recurse=false` (with it true, a sparse worktree's `read-tree
  -mu HEAD` tried to reset a submodule the new worktree has no git dir for, and no task could start:
  #888; `fill_submodules` fills them),
  diffs with `--no-ext-diff --no-color`, and the changed files come from `status --porcelain`: the
  user's `diff.external`, colours, `status.branch` or quoted non-ASCII names once turned the review
  diff and the changed-files list into something else (the 2026-11-16 audit). Output is decoded as
  UTF-8 with bytes that aren't UTF-8 shown as U+FFFD (a Latin-1 source file crashed the runner);
  `gitops.mark`, the runner's edit fingerprint, hashes git's raw bytes instead, streamed into the
  hash a chunk at a time (`git_hash`: captured whole, a replaced 12 MiB file held 50 MiB in the
  runner at every progress check, #678), so an edit from one such byte to another still counts. Its untracked files are taken with `lstat`: a
  symlink counts by its target, anything not a regular file by its type, a file past
  `MARK_READ_MAX` (1 MiB) by its size and time, so a link to `/dev/zero` or a FIFO, or a core dump,
  can't hang or swamp the runner.
- **Pinned to the task's git dir** (`gitops._pinned`). A worktree's `.git` is a file the agent can
  rewrite; pointed at a git dir it made under /tmp, that dir's config (`core.fsmonitor`,
  `diff.external`, its hooks) ran from the runner's `mark()` outside the lane (the 2026-11-16
  audit). So `create_worktree` records the real git dir (`rev-parse --absolute-git-dir`) and the
  `.git` file's text in `rules/<task>/gitdir.json`, outside the lane (rewritten only by `wb
  relocate`, from the repo's side, #498), and every `gitops.git` call
  on a task's worktree, the runner's and wb's, runs with `--git-dir` and `--work-tree` set from it
  (so git reads only the real repo's config), `core.hooksPath=/dev/null` and
  `core.fsmonitor=false`, and `core.filemode=true` where the task directory's file system keeps
  the execute bit (`gitops._modes_hold`, a probe file, once a process): with the repo's
  `core.filemode=false` (a checkout on a drive that distrusts modes, WSL's `/mnt/c`), a script
  the agent made 0755 ran in the task and was committed 100644 (#323, the audit of 1.4); now the
  review diff and the commit both carry the mode. Where it doesn't (exFAT, NTFS, CIFS, drvfs
  without metadata: every file reads 0755 or 0777), `core.filemode=false`: with the repo's
  `true`, every file showed as changed to 100755, `mark()` saw a change before the agent did
  anything, and accept committed the flip (#683); a probe that fails pins neither, and `wb doctor`
  notes a state dir that keeps no modes. Likewise `core.ignorecase` says whether that
  file system folds case (`gitops._case_folds`: a probe file, then its name in capitals; unpinned
  when it can't tell): with the repo's `core.ignorecase=true` (Git for Windows on `/mnt/c`, a repo
  from macOS) on a case-sensitive one, a case-only rename showed as a deletion alone and a new
  `OTHER.PY` beside `other.py` as nothing, and accept committed the deletion and removed the
  worktree with the new names (#492, the audit of 1.90). The agent's own git gets the same two (`gitops.fs_pins`, both measured, `differing=True`: only where the repo's config says otherwise, so mostly none), from the git shim, on a read in the task's repository only (`gitguard.main`'s `pins`, the call's common dir checked first; never forced on a test suite's scratch repos): its `git status` once listed every file as changed to 100755 on exFAT, or a case-only rename as a deletion alone (#796). Where it does fold case (macOS's default APFS, a case-folding mount), `ignorecase=true` matched `Helpers.py` in the index to the agent's `helpers.py` on disk, so `add -A` staged no rename: the review diff showed only the importing file and accept committed the old name (#656). `gitops.case_renames` reads each tracked path's components back from their directories (a missing exact name with one twin equal under casefold and NFC is the new name), and `record_case_renames` stages them (`rm --cached` the old, `add` the new) in the scratch index before the review diff and the snapshot, and in the worktree's own before `commit_all`; `mark` hashes them too. The agent can't `git mv` (the shim refuses it). A `.git` that isn't a regular file holding the recorded text stops the
  call with a `GitError` ("the worktree's .git was rewritten"): the runner fails the task, `wb
  accept` refuses. A task started before the record runs unpinned.
- **No git hooks from the worktree.** With a relative `core.hooksPath` (husky's gitignored
  `.husky/_`) the hooks live in the worktree, written by the agent and in no diff, and `wb accept`
  ran them as the user (the audit). The commits `wb accept` and `wb next` make
  (`gitops.commit_all`), `worktree add` and `worktree remove` (which runs `git status` in the
  worktree), run with `core.hooksPath=/dev/null` (`gitops.NO_HOOKS`): no checkout, pre-commit,
  commit-msg or post-commit hook runs, the user's own included. `wb accept --merge`'s merge,
  fast-forward and squash in the user's checkout run with it too (and `--no-verify`): a commit-msg hook
  (commitlint) refused the merge commit's message, which nobody could edit, and the merge was
  refused while the squash, already hook-free, landed; once staged, the merge holds the agent's
  files, a relative `core.hooksPath`'s among them (#499, Claude's audit of 1.90). Signing is kept (git-lfs's post-checkout hook fails
  without git-lfs on PATH, and wb start died on it). Checks belong in `--test`, which runs in the
  lane.
- **Git LFS** (#382, the audit of 1.6). The task's worktree shares the repo's config and LFS
  objects, so its checkout smudges as the user's does. A `--shared` scratch clone (the base
  check's, `wb verify`'s: `verify._run`) has none of the repo's local config: after `git lfs
  install --local` it checked out pointer files where the tests expected the data, and with a
  global install each clone fetched its own copy of every object. `gitops.share_lfs` gives the
  clone the repo's `filter.lfs.*` settings (`gitops.lfs_filter`) and points its `lfs.storage` at
  the repo's own LFS directory (the repo's `lfs.storage`, else `<common git dir>/lfs`), which
  git-lfs only reads there. `wb start`'s disk check counts each pointer (a blob of
  `LFS_POINTER_MIN` to `LFS_POINTER_MAX` bytes starting `LFS_POINTER`, read in one `cat-file
  --batch`) at the `size` it records, when the repo has `filter.lfs.*` settings
  (`gitops.checkout_size`). The suite's test runs under `git lfs install --local` alone (no
  global or system config) and skips without git-lfs; CI's `Git LFS` step installs it.
- **Checkout settings** (#426, the audit of 1.8). For the same reason a scratch clone checked out
  other bytes than the task's worktree: with the repo's own `core.autocrlf` (a Windows-born
  project, a WSL workspace) the task read CRLF and the base check and `wb verify` LF, and a test
  reading a file byte for byte failed there alone. `verify.checkout_settings` gives each clone,
  before its checkout, the repo's local `core.eol`, `core.autocrlf`, `core.safecrlf`,
  `core.symlinks`, `core.filemode`, `core.ignorecase` and `core.checkRoundtripEncoding`
  (`CHECKOUT_KEYS`), its own `filter.<driver>.*` but LFS's, which `share_lfs` gives
  (`verify.local_filters`: git-crypt, transcrypt, a hand-written clean/smudge; without them a
  filtered file checked out as the stored blob and the base check failed on an unchanged file,
  which read as evidence for the step, #932; the main checkout runs the same commands) and its
  `info/attributes`. A filter that keeps state in the git dir (git-crypt's keys) still can't work
  there: after the checkout, up to `FILTER_SAMPLE` (50) filtered files with the same blob as the
  task's worktree and unedited there are compared byte for byte (`verify.filter_gap`), and a
  difference, or a checkout a `required` filter failed, makes the run `"filtered"`: the base
  check's note says the base wasn't checked, `wb verify` is `inconclusive` with the reason
  (result.json `filtered`), `wb shot`'s side `exit filtered`. bench's clones get the settings
  too: `bench add`'s base and reference checks and each replay's checkout (`bench._clone_base`,
  from the case's repo while it lasts); without them the reference check read LF where the task
  read CRLF and refused the case, and replays were graded on other bytes (#736, the 2026-11-21
  audit). By then the task's worktree is gone, so bench compares each sampled filtered file with
  what the repo itself makes of its blob (`verify.smudge_gap`: `git --attr-source=<the clone's
  tree> cat-file --filters` run in the repo, with its git dir and keys; read-only there, a blob
  it lacks or a git before 2.40 skipped), and a difference or a `required` filter's failure
  (`_filter_failed`) is a `RuntimeError` naming the file and `filter.<driver>` (`bench._filtered`):
  `bench add` refuses, a replay is an `error` row saying why, never one graded on other bytes.
  They had the filters without this, and a git-crypt repo's add died on git's raw "smudge filter
  git-crypt failed" and each of its cases' replays was an error naming no setting (#932's review).
- **The split of roles.** The agent writes code and reads git freely (`status`, `diff`, `log`,
  `show`, `blame`). Everything that leaves its working tree is Claude's: commits, branches,
  merges, pushes, pull requests, CI/CD, deploys and infrastructure (`gh`, `wrangler` and the like),
  and the project's `CLAUDE.md` and `AGENTS.md`. The handbook and the working protocol tell the
  agent so, and to ask through `ask_reviewer` or say so in its summary when the task needs one of
  those.
- **Git is read-only for the agent, enforced** (`workbench/gitguard.py`). `install` writes
  `rules/<task>/bin/git` every round (a `/bin/sh` wrapper, `exec '<python>' -I -c '<code>' "$@"`,
  quoted, since a shebang line splits at a space and a Python under `/home/John Smith/` broke
  every git call; the code inserts the package path, then `gitguard.main(<real git>, <the task
  repo's common dir>, argv, <the temp roots>, [<the worktree>, <the lane's other writable directories>], <pins>`) and puts its directory first on the agent's `PATH`,
  so it's the git called from the shell, a script or `make`. `split` skips git's global options
  (and the values of `-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--super-prefix`,
  `--attr-source`) to find the subcommand; `reads` decides: no subcommand or one of `READ` (41:
  `status`, `diff`, `log`, `show`, `blame`, `grep`, `rev-parse`, `ls-files`, `archive`,
  `check-mailmap`, `interpret-trailers`, …) reads; `branch` and `tag` read only when listing (for
  `tag`, `TAG_LISTS`: `-l`, `--points-at`, `--contains`, `--merged` and their `--no-` forms, which
  version scripts in Makefiles, `setup.py` and `build.rs` run: #443); `apply` without
  `APPLY_INDEX` (`--index`, `--cached`, `--3way`/`-3`, `--intent-to-add`/`-N`,
  `--build-fake-ancestor`, abbreviations too), since it then writes only working-tree files
  (plain `git apply p` and `-R` were refused: #890); `hash-object` without `-w`;
  `fsck` without `--lost-found`; `config` only with a read option or one name (the values of
  `CONFIG_VALUED`, `-f`, `--blob`, `--type` and the like, not counted: `git config -f .gitmodules
  <key>` was refused, #794); `stash` only `list`
  and `show`; `worktree` only `list`; `remote` without arguments, `get-url`, `show` (with or without `-v`); `reflog`,
  `notes`, `submodule` and `symbolic-ref` in their read forms; anything else (aliases and `lfs`
  included) is a write. `git submodule update|init|sync` (any flags, any paths) in the task's
  worktree or a scratch checkout of it (`filled_submodules`) is neither run nor refused when each
  submodule it names is one workbench filled (files, no `.git`): it exits 0 with `FILLED`, a
  line saying so; one left empty gets `UNFILLED`, exit 1, naming it (the reviewer's checkout
  lacks it). A build that inits its own submodules (CMake's `GIT_SUBMODULE` snippet, a Makefile
  prerequisite) was refused in the worktree, and in the base check's clone git failed on the
  filled directories, so the base and every round went red (#885); a test command needs no
  submodule init. A read is exec'd with `GIT_OPTIONAL_LOCKS=0`, so the agent's `git status`
  never refreshes the index while Claude diffs, and in the task's repository with the pins
  (`gitops.fs_pins`, #796). A write is refused, with `REFUSAL` (leave the
  change uncommitted for Claude; to undo an edit, edit it back or `git show HEAD:<path>`; ask if
  the task needs a git write), when it lands in the task's repository (`protected`: the same
  common dir; a `config` write with `--global`, `--system` or `-f` is judged by the file it
  writes instead, `config_files`, refused only inside the task's git dir or on a `.git`: a
  fixture's `git config --global` with HOME at its temp directory was refused, #794) or in any repository outside the temp directories, the worktree and the lane's tool
  homes; outside any repository it passes, and throwaway repositories under the temp directories,
  nested in the worktree (a common dir below it that isn't the task's), which test suites create,
  or in the lane's other writable directories (`context.writable` less `/dev` and `/proc`: the
  tool homes and grants, split around the task's repo), where package managers keep theirs, stay
  writable (the temp roots and the lane are fixed when the shim is written, so an agent's `TMPDIR`
  can't make a project count as scratch; Rust's `CARGO_TARGET_TMPDIR` and fixtures in `tests/tmp`
  are in the worktree: #444; pre-commit's `git remote add` in `~/.cache/pre-commit`, uv's `git
  fetch` in `~/.cache/uv`, Go's direct fetches in `go/pkg` and Bazel's were refused, and `--setup
  'uv sync'` failed before round 1: #665). For `init` and `clone` it judges by where the new
  repository lands (`new_repo`, skipping options and their values): strictly below the worktree
  or one of those directories, and without `--separate-git-dir`, it passes (`nested`, so a
  dotfiles repo at `~` doesn't make pre-commit's `git init` its own); else by the repository its
  nearest existing directory is in (`destination`). The real git
  called by its full path is refused by OpenCode's rules (`context.denied_shell()`), and the task repo's refs are
  outside the lane. That also means an agent can't wipe its own unfinished work by mistake. The
  shim is standard library only: it's imported on every git call.
- **Claude's files.** OpenCode's `edit` rules refuse edits to `CLAUDE.md`, `CLAUDE.local.md`,
  `AGENTS.md` and `.claude/`. If the agent changes one anyway (from the shell), the round report
  says so (`runner.claude_files_changed`).
- **The agent never commits.** Everything it does stays uncommitted in its worktree, and
  `wb diff` shows it (new files included: `gitops.with_new_files` runs git with intent-to-add in a
  scratch index, so the worktree's own index, and a concurrent git command's lock, are left alone) against the task's
  base, or after `wb next` against the last committed step (`--all` for the whole branch). The
  scratch index starts as a copy of the worktree's (`read-tree HEAD` only when there is none), so
  sparse-checkout's skip-worktree entries aren't read as deletions: a monorepo's every file outside
  the cone once filled the diff, the stat and the router's footprint (the audit). Its `add -A`
  (and `commit_all`'s) is `gitops.add_all`: refused in a sparse checkout (a file the agent made
  outside the patterns, git 2.34+), it runs again with `--sparse`; that refusal crashed the round
  report and stopped `wb diff`, verify, next and accept (#493, the audit of 1.90). Only after the
  refusal: a git older than `--sparse` neither has it nor refuses. A git error in the report's
  diffstat costs that line (`(no diffstat: …)`), not the task.
- **Nested repositories** (`gitops.nested_repos`: the untracked `dir/` entries git lists, which
  are only ever directories holding a `.git`). A scaffolder's or a test fixture's repo in the
  worktree broke the review diff (no commit) or showed as one line and was committed as a gitlink
  to a commit nowhere else (the audit). The review diff leaves them out, the round report says
  `NOTE: <dir>: a git repository of its own, left out of the diff and never committed: …`
  (`gitops.nested_line`), and `commit_all` refuses them by name before `add -A`, so accept and
  next stop with the task still in review.
- **Edits in a filled submodule** (`gitops.submodule_edits`, `submodule_check`). `fill_submodules` makes the files
  read-only, but `sed -i` replaces a file through its directory: an edit the tests passed on was
  in no diff, and gone after `wb accept --merge` (#419, the audit of 1.8). In a task's worktree
  each submodule it fills, nested ones too, is recorded in `rules/<task>/submodules.json` with a
  copy of its index made right after the fill (stat info fresh, so a check reads only what
  changed). The check runs git with the user's checkout of the submodule as git dir, a scratch
  copy of that index and the filled directory as work tree. Both copies keep the index's own time
  (`shutil.copy2`): git trusts an entry's stat (whole seconds, inode, size) unless its file is as
  new as the index, so a fresh copy made every entry look older, and a same-size rewrite in the
  second of the fill, on an inode the filesystem reused, read as unchanged (CI on ext4, one run in
  ten, batch 7 of 2026-11-21). Then `diff-files` (changed or deleted) and
  `ls-files --others --exclude-standard` (new and not ignored), each nested one on its own. A
  changed or deleted file is an edit: the round report has a NOTE per submodule, and
  `commit_all` refuses ("not committed: edits in submodule <path> can't land: …"), so accept and
  next stop with the task in review. A new file is only noted ("new files in submodule <path>
  won't be committed: …") and left behind, as a real submodule checkout leaves it: counted as an
  edit, the objects a test command's `make -C vendor/lua` wrote refused every accept and came
  back with the next test run (#889, the third 2026-11-21 audit). A submodule it can't check (its checkout gone or
  unreadable) is said the same way ("edits in submodule <path> can't be checked: … wb relocate"),
  not skipped (#682). The directories stay writable: in-tree builds of a
  submodule write there, and the agent could make them writable again anyway.
- **Commits are the user's** (`gitops.commit_all`: `add -A`, refused when nothing is staged or a
  nested repository is there).
  `wb accept` commits under the user's git identity with no AI co-author line, only provenance:
  ```
  feat: CSV export for reports

  Delegated to <model> via OpenCode: 3 round(s), 1 automatic test-fix, 1 review round(s).

  Workbench-Task: csv-export
  OpenCode-Session: ses_…
  ```
  Rounds count every runner round (auto-fixes, notes and handovers included); review rounds count
  the last step's. `wb next` commits each step as `<message>` with `Workbench-Task: <task> (step
  N)` and `OpenCode-Session:`. A worktree with no new changes accepts the branch's commits past
  the base (the steps `wb next` committed, or Claude's own after a takeover); one with nothing past
  the base either is refused. An accept that committed and then died (its worktree gone or broken,
  the branch tip carrying its own `Workbench-Task: <task>` trailer) finishes on a retry with that
  commit (`cli._landed`). Before the worktree goes, the branch `delegate/<task>` is made that
  commit (`gitops.put_on_branch`): moved forward when it is an ancestor (the worktree on a detached
  HEAD or another branch), made when gone, and refused when it holds commits the accepted one
  lacks, naming them, with the worktree and the task's phase kept and the way out (`rebase
  delegate/<task>` in the worktree, or `branch -f` to drop them): with HEAD detached, accept
  committed there, said the branch had it and removed the only checkout holding it (#417, the
  audit of 1.8). `wb accept` merges only with `--merge` (`merge --no-ff --commit
  --no-squash --no-log -m "Merge branch 'delegate/<task>'…"` in the user's checkout (the message
  git's own `fmt-merge-msg` writes for the branch, `into <branch>`, `merge.log` and
  `merge.suppressDest` kept: `gitops.merge_message`; merging the tip's SHA made it "Merge commit
  '<sha>'", #471), no hooks in any mode (*No git hooks from the worktree*), which must be on a branch, the task's
  `base_branch` when it has one, else any, holding the task's base commit either way (a named
  branch reset or rebased since the start got back the commits withdrawn from it: the refusal
  names them and offers a `rebase --onto` of the task's commits or a merge by hand, #418, the
  audit of 1.8), with no changes to
  tracked files (named in the refusal; a submodule changed only in its own checkout, ahead of its
  gitlink or edited inside, doesn't count unless the merge changes its gitlink, refused then as
  "submodule <path> is at another commit" or "has local edits": `gitops._uncommitted`, from
  `status --porcelain=v2 --ignore-submodules=none`; such a checkout was refused as "uncommitted
  changes", naming nothing, where git merges it, #505, Claude's audit of 1.90) and no merge of the
  user's under way: a task started on `feature` once merged
  into the `main` checked out since, and one on a detached HEAD left its merge commit orphaned,
  the 2026-11-16 audit. It refuses when a file the merge would write is already in the checkout
  untracked, ignored or not, or has an untracked file where its directory goes
  (`gitops._overwritten`, naming each). A tracked file the merge turns into a directory
  (`pkg` to `pkg/init.py`) is the merge's to replace, and a directory it turns into a file is in
  the way only through what it holds untracked, ignored files included: a clean file-to-directory
  refactor was refused (#343, the audit of 1.4). An untracked link where the merge writes beneath
  it is in the way whatever it points at (named itself): `os.path.isdir` followed it, and git
  replaced a user's ignored link to a dataset with a plain directory (#367, the audit of 1.6).
  Under `core.ignorecase` (macOS, Windows) a path matching a tracked one but for case (and
  Unicode normalization) is that tracked file, not in the way, when the file system says so: the
  same inode (`gitops._same_file`). A case-only rename, `Readme.md` to `README.md`, was refused as
  "would overwrite README.md" on APFS (#470, the audit of 1.8); and the setting alone was
  trusted, so a copied repo carrying `core.ignorecase=true` onto a case-sensitive file system had
  its ignored personal `config`, beside the tracked `CONFIG`, replaced by the merge (#640,
  Codex's audit of 1.90.6).
  Git's merge silently replaced an ignored `settings.ini`
  the task had un-ignored and committed, and its `--no-overwrite-ignore` doesn't stop the ort
  merge (#189). The paths come from the merge itself, done first in memory (`git merge-tree
  --write-tree`, git 2.38+; an older git does the same merge with `--no-commit` in a scratch
  worktree of HEAD under the state directory, then removes it: `gitops._trial_merge`, whose
  failure refuses the merge. The worktree is made with `--no-checkout` and its index read from
  HEAD, so the merge writes only the files it changes, with LFS's smudge skipped (`NO_SMUDGE`),
  and the paths come from the index: a full checkout took gigabytes and minutes on a big repo
  and failed when LFS objects weren't local, #469, the audit of 1.8. The paths the branch adds, the old fallback, missed a modify/delete
  conflict on Git 2.34.1, Ubuntu 22.04's, and its abort deleted the ignored copy: #320, the audit
  of 1.4) and compared with HEAD as raw bytes, conflict or not: the branch's added paths, decoded, missed a modify/delete conflict
  (main stopped tracking `settings.ini`, the task edited it, and the merge's abort deleted the
  developer's ignored copy), a directory rename moving an added file onto an ignored one, and a
  name that isn't UTF-8 (#241, the audit of 1.2). `--commit --no-squash` outrank a `branch.<name>.mergeOptions`
  of `--no-commit` or `--squash` (the fast-forward passes `--no-squash` too: `--ff-only` under
  `mergeOptions=--squash` staged a squash and left HEAD, #430, the audit of 1.8), and success means
  the branch is in HEAD with no `MERGE_HEAD` left, else it is backed out (`gitops._back_out`,
  whenever HEAD or the index changed, `MERGE_HEAD` or not: wb said "backed out" over a staged
  squash, #430): such a merge was left pending while accept said merged (#190). The
  squash passes `--ff`, which a `merge.ff` of `only` or `false` can't refuse: `only` refused every
  squash once the branch had moved, `false` every one ("'--squash' and '--no-ff' cannot be used
  together", #429, the audit of 1.8). A
  conflict, a signature with no answer in `COMMIT_SECS` or a SIGTERM or SIGHUP mid-merge
  (`cli._ends_cleanly` raises it) is backed out, `merge --abort` and then `reset --merge` to the
  commit before (`gitops._back_out`: a kill left `MERGE_HEAD` and the staged merge, #420), and
  reported as not merged. The back-out undoes only its own merge: another merge's `MERGE_HEAD` is
  left, and a HEAD moved past the commit before by anything but this merge's own commit
  (`gitops._made_by`: the tip for a fast-forward, else a child of that commit whose second parent
  is the tip, or whose message is the tip's for a squash) is reset to, not from. Merges into one
  checkout take turns (`gitops.merge_lock`: a flock on `workbench-merge.lock` in its own git dir,
  shared by every profile and account merging there, held from `merge_from` through the merge;
  `wb: waiting for another merge into <repo>` once; past `MERGE_WAIT`, `COMMIT_SECS` + 15 s, the
  merge is refused, never made, since an agent can read the git dir and so hold the lock; the
  file is opened read-write where it may be, `store.lock_fd`, and a flock the file system refuses
  is a `GitError`, not a bare "Bad file descriptor": NFSv4, #892). The
  command lock is per task, so two tasks' accepts once interleaved: B read HEAD, A merged, B
  conflicted and reset to the HEAD it had read, rewinding A's merge while A's row said merged
  and its branch was gone (#639, Codex's audit of 1.90.6)); otherwise it prints the
  merge command (`merge with:`, `gitops.merge_by_hand`): in the repo's mode, the `--merge-as`
  given or commands.json's `merge`, and with `--no-gpg-sign` after `--no-sign` (it said `merge
  --no-ff` whatever the repo kept to, #471, the audit of 1.8). A colocated Jujutsu repo (`gitops.jj_colocated`: `.jj/` beside `.git`) has git's
  HEAD detached whenever jj has moved the working copy, so its tasks record no `base_branch` and
  `--merge` meets a detached HEAD: the refusal (`gitops.detached`) says so and names jj's merge,
  `jj -R <repo> new @- delegate/<task>` (`gitops.jj_merge`, a merge change on the working copy's
  parent), which the `merge with:` line gives too in place of git's: a git merge there lands on
  the detached HEAD (#385, the audit of 1.6; checked against jj 0.47.1). A task started from a tag or a commit has a null
  `base_branch`, so any branch holding its base takes it (`cli._merge_into`: the tag was taken for
  a branch name and every such merge refused, #87; a record from before `base_branch` resolves its
  `base_ref` the same way).
- **The worktree** (`gitops.create_worktree`): `worktree add -b delegate/<task> <task
  dir>/worktree <base sha>` (the base peeled to its commit, so an annotated tag's object id is
  never the base), refused when the branch exists. A sparse checkout (`core.sparseCheckout`,
  `gitops.sparse_of`) gets a sparse worktree: added with `--no-checkout`, its patterns and cone
  mode set (`apply_sparse`: `config --worktree` where the repo keeps per-worktree config), then
  `read-tree -mu HEAD`; newer git copies them itself, an older one checked out the whole tree. The
  scratch clones (the base check, `wb verify`, `wb shot`, `wb bench add`'s checks) are made sparse
  the same way before their checkout: the base check's clone held the whole monorepo (#263, the
  audit of 1.2). There `read-tree -u` writes nothing outside the patterns, so `wb verify`'s
  candidate checks out the files the candidate adds or changes with
  `--ignore-skip-worktree-bits`: a new package beside the cone was missing, and the candidate
  failed (#493). A failed add (a required smudge filter) removes
  the worktree and the branch it made, and `wb start` the task directory, so the name stays free
  (one once left all three behind for good, the 2026-11-16 audit). `remove_worktree` (always `--force`:
  after accept's commit only ignored files are left); when git can't remove it (a
  read-only directory, an embedded repo, the repo moved or deleted) a task's own worktree is
  deleted by hand and `wb` warns: accept and discard once wedged there for good (the audit).
  Its registration then goes by itself (`gitops.drop_registration`: the admin dir under
  `<common git dir>/worktrees/` whose `gitdir` names the gone directory, read against that admin
  dir as git does, so a relative one, `worktree.useRelativePaths`, matches too (#793); unless
  locked), as do a
  failed add's and the trial merge's scratch worktree's; nothing runs `git worktree prune`,
  which dropped an unrelated worktree on a drive unmounted for the moment, whose `git status`
  then exited 128 and whose staged index was gone (#641, Codex's audit of 1.90.6).
  A task outlives the checkout it started from (#498, Claude's audit of 1.90). Repo-level git
  (accept's tip, `_landed`, `step_commit`, discard's branch, `wb verify`'s clones, gc's merged
  branches, `wb diff`'s hint, `repo_conf`) runs where `gitops.repo_of` says: task.json `repo`
  while it is a checkout of the task's repository, else, once it is removed (a linked worktree
  removed: one per feature, the bare-repo layout, Claude Code's `--worktree` sessions), the
  repository's main worktree, the first of `git worktree list --porcelain` run in task.json
  `git_common` (or that git dir, when it is bare; a task from before the key has it from
  gitdir.json's `commondir`): `wb accept` died at the tip lookup on every retry, and discard
  said the branch had gone with the checkout. When the git dir is gone too, the repo moved
  (`mv proj proj2`): every git call on the worktree failed, and `git worktree repair` there was
  refused as a rewritten `.git`. Now `_pinned` says "the repo moved or was deleted (its git dir …
  is gone): wb relocate <task> --repo <its new path>", whether the `.git` is as recorded or
  repaired, and accept stops with "<repo> moved or was deleted: wb relocate …" before anything is
  stopped or changed (`cli._repo`; its tip lookup is inside its error handling too). So do `wb
  feedback`, `wb next` and `wb resume` (`cli._worktree_problem`), and a runner sent anyway fails
  with that line and `wb resume`, not a traceback (`runner._repo_gone`, before the checkout); the
  runner's git shim (`gitguard.install`) and the lane's guard (`context.repo_dirs`) take the
  main worktree once the linked one is removed: `git -C <removed>` crashed every round's runner
  with a CalledProcessError, and the guard held only the removed path (#776). So does `wb bench
  add` (its repo `gitops.repo_of`, refused naming `wb relocate` when that is nowhere, and each
  case's replays through `bench._repo`): it refused the task as "gone: the case is cut from its
  repo" (#909); a case's siblings still resolve from the removed checkout's own path (case.json
  `checkout`), not the main worktree's. `wb relocate`
  (`gitops.relocate`, under the task's command lock) checks the new repo holds the task's base
  commit, finds the git dir it keeps for the worktree (`worktrees/<id>`, whose `gitdir` links back
  to it, a relative link read against that directory; else the one named as gitdir.json's, whose
  link names no other worktree: with `worktree.useRelativePaths`, git 2.48+, both links are
  relative, and the admin dir's no longer reaches the worktree once the repo moved, so every
  relocate was refused, #682; the worktree's `.git` is read against the worktree), refuses a `.git` naming another git dir that exists (one the agent made: a newer git's
  repair would quietly take it back), runs `git worktree repair`, writes the `.git` itself when
  that couldn't (an older git can't infer the link), records gitdir.json afresh and rewrites
  task.json `repo`, `git_common` and a `cwd` inside the old place, and each `src` in
  `rules/<task>/submodules.json` under the old place (left there, `submodule_edits` failed on
  every filled submodule and skipped it, and an edit inside one vanished at accept, #682). commands.json `repos` entries
  match a linked worktree of the repo by git dir and the path inside it (`context.repo_conf`).
  `wb discard` records the branch's tip in status `tip`, then deletes the branch (`delete_branch`
  at that tip, printed as `(was <sha>)`) unless `--keep-branch`, the repo moved ("moved or was
  deleted: branch … wasn't deleted"), or the branch
  has commits past the base (the steps `wb next` committed, or Claude's own after a takeover:
  `rev-list --count`), which it keeps and says how to merge or delete, unless `--drop-steps`;
  force-deleted, approved steps were on no ref (#494, the audit of 1.90). `wb accept` records the
  branch's tip in status `tip` and, after a `--merge`, deletes the branch (`drop_merged_branch`:
  `branch -d`, which keeps one not merged into the checkout's HEAD): merged delegate branches
  piled up, 8 in one repo (the 2026-11-19 audit). `gitops.step_commit` and `cli._landed` read the
  tip once the branch is gone; `wb gc` does the same for branches merged before (`_merged_branches`).
- **One command per task at a time** (`cli.one_at_a_time`): accept, discard, next, feedback,
  resume, takeover and stop hold the task's `locks/<task>.cmd.lock` (`runner.lock_file`, `store.task_lock`, where no
  lane reads: an agent holding a lock with flock would wedge every command), so a
  second one waits and then sees what the first did (an accept racing a discard once deleted the
  accepted commit and wrote two results rows: the audit). `stop --all` takes each task's in turn
  and skips one closed since it listed them (it set a discarded task back to stuck). The runner
  never takes it.
- **The repo's stack** (`gitops.stack`): from `git ls-files -z`, the top two languages by file
  extension (`LANGUAGES`) that each hold at least 20% of the source files. A `.h` counts as the
  most common of `HEADERS` (C, C++, Objective-C) among the repo's sources, C when it has none:
  counted as C, a C++ repo with as many headers as sources was "c/c++", and the router took a
  model's plain-C record as C++ experience (#908). The router and the skill records use it.
- **`wb init <dir>`** sets a project up the way Claude keeps every project: a git repo on git's
  default branch (`init.defaultBranch`) with an initial commit, and `AGENTS.md` as a symlink to
  `CLAUDE.md` (an existing `AGENTS.md` becomes `CLAUDE.md`), so OpenCode's agents and Claude read
  the same file. A `CLAUDE.md` that links to `AGENTS.md` (the reverse convention) is swapped:
  the file becomes `CLAUDE.md`, `AGENTS.md` the link (comparing the two names' text once deleted
  the only copy: the 2026-11-16 audit). A gitignored `CLAUDE.md` gets no link (it would dangle in
  every clone); `claude_md_status` says "CLAUDE.md is gitignored". It refuses the home directory
  or one above it, a directory inside another repository or without a git identity, and never adds
  a remote. Before a first commit it refuses, naming them, files that look like secrets
  (`cli.SECRET_FILES`: `.env*` but `.env.example`, keys, `credentials.json`, `.npmrc`, …) and
  installed or generated directories (`cli.VENDORED`: `node_modules`, `.venv`, `__pycache__`, …,
  `target` beside a Cargo.toml) that no `.gitignore` covers, or that are already staged (a staged
  file is committed whatever `.gitignore` says, #80), before changing anything: add them to
  `.gitignore` (unstaging a staged one) and run it again (the audit: a first commit took an `.env`
  with an API key). In a repo with commits it commits only what it made, "chore: AGENTS.md links
  to CLAUDE.md" (`cli._commit_link`): the link and, after a move, `AGENTS.md`'s committed text as
  `CLAUDE.md`, built in a scratch index from HEAD (HEAD's and the index's two entries read first,
  `_md_entries`), committed without hooks, the user's index set to the new entries and nothing
  else touched; so edits of the user's to `CLAUDE.md`, staged or not, stay theirs to commit (a
  path-limited `git add -A`/`git commit` put the working copy in that commit and dropped what was
  staged, #931). A path it would commit that already had a staged change, or a link whose
  `CLAUDE.md` isn't committed, is left uncommitted: "not committed: … commit them yourself". So
  is everything while a merge, cherry-pick, revert or rebase waits for the user's commit
  (`gitops.under_way`, `UNDER_WAY`: MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, `rebase-merge`,
  `rebase-apply`, `sequencer` in the git dir): "not committed: a merge is under way here, so
  commit AGENTS.md yourself once it is done" (the review of #931: during `git merge --no-commit`
  the link's commit took MERGE_HEAD as its second parent with only HEAD's tree, so the merge's
  changes were lost and MERGE_HEAD consumed). An `AGENTS.md` moved to a gitignored `CLAUDE.md`
  (which gets no link) commits nothing either: "not committed: CLAUDE.md is gitignored, so
  AGENTS.md's move to it is yours to commit" when `AGENTS.md` was committed (git now sees it
  deleted), "nothing to commit: CLAUDE.md is gitignored" when it wasn't; the link goes in a
  commit only when it is in the worktree (the review of #931: the commit held a link the worktree
  lacked, ` D AGENTS.md` right after, and force-tracked the gitignored `CLAUDE.md`).
- **CLAUDE.md stays true.** It goes into every agent prompt, so `wb accept` prints how many code
  commits it's behind (`cli.claude_md_status`, at the accepted commit, the task's `tip`: read
  at the branch `--merge` had deleted, every merged accept said "the repo has no CLAUDE.md", a
  new user's first result, #269, the audit of 1.2; for a monorepo package's task, task.json
  `subdir`, the package's own CLAUDE.md first, counted against the package's commits only, the
  root's only when the package has none: #783, every package accept said the repo had none),
  and the skill has Claude update it after each accepted task that changes what it describes.

## Claude coding: when Claude writes a task's code

The user chooses when Claude may write code for a delegated task (#92, `wb coding`; the pane's
Settings row is #93). The local agent gets the first shot in all three, and Claude can always review and
advise. The choice is `$WB_HOME/coding.json` `{mode, ts}`, read fresh each time, so a restart
keeps it; without one it is `decide`:
- **Let Claude decide** (`decide`): as before there was a choice. Nothing is added to Claude's
  context and nothing is gated.
- **Ask me first** (`ask`): Claude helps the agent first, then may ask the user for one specific
  edit, naming the task and the change. Only the user's yes allows it, which Claude records with
  `wb coding allow <task> --edit "…" --said "<their words>"`; unanswered, the work stays local.
- **Only when I say** (`only`): Claude never writes a task's code; it guides the agent and, when the
  agent stays stuck, reports the blocker and keeps the work. The user says when; Claude records
  their words the same way.

An allowance (`tasks/<task>/coding.json` `{allowed: [{edit, said, ts, used, when?, started?,
did?}]}`, a `coding` event) lasts until the work goes back to the agent: `spawn_runner`
(feedback, next, resume) marks it `used`, so a retried or resumed task remembers it, and the next
edit needs the user again. A **one-task exception** (#94) is one the user grants ahead, with a
condition: `wb coding allow <task> --edit "…" --said "…" --when "<the next try still gets the
units wrong>"`. Claude shows the user the task, the condition and the exact edit first. A
hand-back doesn't spend it until Claude has started on it: the mod stamps `started` at Claude's
first edit under it, so it waits through the try it was granted for. Claude then records what it
changed (`wb coding used <task> --did "…"`) and hands the testing back with `wb feedback`. It is
the task's alone: the setting never moves, and the next task needs its own. The pane shows an
unspent allowance under its task's line, wrapped whole (`allowedLine`: `Claude may, once, if
<when>: <edit>`). Two
places hold Claude to it. `wb takeover` refuses (exit 3, saying what to do instead) without one
(`_coding_gate`), unless `--user`: the mod's hand-back command passes it, and records an allowance
for each task it hands over, since the user asked for exactly that. The mod denies Claude's own
Edit, MultiEdit, Write and NotebookEdit calls on a path under `$WB_HOME/tasks/<task>/worktree/`
without one (`codingRefusal`, in the one unmatched `tool.call` hook; the deny names the rule), and
outside `decide` adds a `claude-coding` context block with the rule (`CODING_RULES`) while
delegating or with a task open; a change mid-session (the pane, `wb coding`) reaches the
conversation as a row with the new rule (`sayRules`, #540). A shell edit isn't seen: the block says the rule covers it too.

## Experiments

An experiment is a change to what the agent may do that isn't measured enough to be supported:
it ships off, marked experimental, for the user to turn on, and the bench (`--label`) or the
results rows' `experiments` say whether it earns a place; one that doesn't is removed. `context.EXPERIMENTS` names each with its purpose. `wb experiment <name> on|off` (or the pane's Settings row) sets it in
`$WB_HOME/experiments.json`, and `wb start` records what the task's agent has in task.json
`experiments` (`context.task_experiments`: on only when set on and able to work), so a flip
changes only the tasks started after it, a replay's task records which arm it ran in, and a
results row lists the ones that were on. Off, or unable to work, the agent's prompt and rules are
exactly those without the experiment.

**probe** (`probe-code`, an outside program, like opencode, not a dependency): the agent reads
a file's outline (`probe symbols <file>`) and one function (`probe extract <file>#<name>`)
instead of the whole file, where its context fills (about half the measured steps compacted or
handed over, 2026-11-20). It needs probe on the agent's PATH (`context.probe_bin`, through
`agent_path`), installed by the user (nothing in workbench installs it; `wb experiment`, `wb doctor` and the
pane's row say when it's missing, naming what probe is, `context.PROBE_HOME`, and its release page,
`context.PROBE_RELEASES`; turned on in the pane without it, Claude is asked to offer the setup:
`PROBE_SETUP_NOTE`), one whose `--help` lists `symbols`: crates.io's probe-code 0.6.0 hasn't it and
reports the same version as the release that has, and `probe symbols main.c` then searched for
the word (the agent got no results and wrote a function named `symbols`, 2026-11-20). Off, it isn't
checked at all: `wb start` ran `probe --help` with it off, and a `probe` printing a non-UTF-8 byte
failed the start after its branch and worktree were made (#518); its output is read with
`errors="replace"`. On, the task's shell rules allow probe's read-only subcommands, `context.PROBE_READS`
(`symbols`, `extract`, `search`, `grep`, `query`; `shell_rules`, after `ALLOWED_COMMANDS`), and
refuse `--lsp` on any of them; its copy of the handbook ends with `EXPERIMENT_NOTES["probe"]`
(`instruction_files`; `agent/HANDBOOK.md` itself is unchanged). So it stays read-only: no index,
no daemon, no network. The rule was `probe *` until 2026-11-21, when testing the experiment found
that it let the agent run `probe lsp` (a daemon and language servers), `--lsp` on a read (the
same), `probe config set|reset` (probe's config) and `probe benchmark`.

## Verifying a fix against the base

`wb verify <task> [--test CMD] [--files PATH…] [--expect TEXT] [--timeout N]` (`workbench/verify.py`, #96) runs
one regression test twice, at review, each run in its own scratch checkout under the state
directory and in the task's own lane and environment (`runner.run_in_lane` on a `verify._At`):
- **The base**: a `--shared` clone (`gitops.scratch_clone`, every scratch checkout's and
  `bundle_steps`'s: in a shallow repo, where git ignores `--shared`, made by hand, `init` in the
  repo's own object format (`rev-parse --show-object-format`: a plain init took git's default,
  and a SHA-256 shallow repo, or a SHA-1 one under a SHA-256 default, refused every ref, #884's
  review) with the repo's objects as alternates, its `shallow` file, branches, tags and HEAD, since the clone
  copied only what refs reach and the review snapshot's tree, or a squashed task's earlier step,
  wasn't there: wb verify and shot died "failed to unpack tree object", bench add on step 2,
  #884; its Git LFS files smudged from the repo's own objects: `gitops.share_lfs`, #382) at the task's original base for step one or the previous approved step commit for later steps (#252; status `step_base`, so a step with no changes keeps the commit before it, #652), with the candidate's test files
  copied in (`--files`, else the files changed since that commit whose path looks like a test or
  a test's data, `TEST_PATH` through `looks_like_test`: under `tests/`, `test/`, `spec/`,
  `__tests__/`, `testdata/`, `fixture/`, `fixtures/`, `__fixtures__/`, `__snapshots__/` or
  `golden/` (each in any case, as SwiftPM's `Tests/`), or a .NET `*.Tests/` project, or named
  `test_*`, `*_test.*`, `*.test.*`, `*.spec.*`, `*.snap`, Django's `tests.py`, `*Test.java`,
  `*Tests.cs`, `*Spec.kt` and the like (`(Tests?|Spec).` with a .NET, Swift, JVM or PHP
  extension), Cypress's `*.cy.*`, Perl's `t/*.t`; Go's `testdata/` golden file left behind made
  the base fail for lack of it, which was called proven, #500; a Django `tests.py` edited beside a
  new fixture sent the fixture alone, and the base passed its old tests, #731; as
  they are in the candidate: a deleted one, such as a renamed test's old name, is left out, and
  each path goes to git `:(literal)`; the old name once stopped git on its pathspec before either
  run, #194). The test files the candidate deleted, a renamed test's old name among them, are
  deleted from the base too (`verify.removed_tests`, `result.json` `removed`; `wb shot`'s base
  likewise): kept, `unittest discover` ran a failing `test_old.py` on the base and only its
  passing replacement on the candidate, and verify said proven with no code changed (#643,
  Codex's audit of 1.90.6). That copy is what makes a test separable from the change; with no
  test file it refuses. A `--files` path that doesn't look like a test (a Rust file with inline
  tests) carries the candidate's code to the base too: `result.json` `code_copied` and the report's
  "the base got the candidate's code too" line say so, since a pass there may be the change's (#731).

- **The candidate**: the same clone at the worktree's HEAD, then `read-tree -u` of a snapshot of
  the worktree, new files included: the tree `wb accept` would commit (`gitops.snapshot(landing=True)`,
  also `wb shot`'s and the staleness check's), not the review snapshot (*The runner, inside*,
  #431). Only what accept refuses without `--include` is left out: a new binary of `BINARY_MAX`
  or more and the directories past `NEW_FILES_MAX`; a big text file, which accept commits, is in
  it (the review's `SNAPSHOT_MAX` left out a 1,100,000-byte text file the test read, verify said
  proven, and the test failed on main once accept had landed it: #642, Codex's audit of 1.90.6).
  `result.json` `left_out` and the report's "not in the candidate (accept refuses them without
  --include, and lands them with it)" line name what was left out, and a check that left
  anything out is never `proven`: it would be `inconclusive`.

Each is set up from the task's worktree (`runner.prepare`: its siblings, and the ignored paths
its preparation made, copied; `--setup` runs the setup command there instead) before the test runs.

Neither run touches the user's checkout or the worktree under review. The verdict (`verdict`):
`proven` (the base fails on an assertion and the candidate passes), `base-passes` (the test
doesn't show the bug), `candidate-fails`, or `inconclusive`: a run timed out, overran its
output or couldn't be set up, the base failed without an 
assertion the check recognises (the
report's wording names an error first and output it doesn't read, which `--expect` names, not a
setup error alone: #730), or the candidate left out files accept can land (#642). 
A missing module or a command not found says
nothing about the bug, so it can never count as proof. Proof is positive evidence only: with
`--expect TEXT`, that text in the base's output; else, unless a setup error (`SETUP`: a syntax,
import or module error, pytest's collection errors, a fixture not found, a failed build or
compile) says the tests never ran, or a line saying a file is missing (`MISSING`: "no such file
or directory", `FileNotFoundError`, `ENOENT`) names one the candidate adds and the base didn't get
(`missing`; the report says which, for `--files`: #500), an assertion line (`ASSERTION`: `AssertionError`, pytest's
`E assert`, a line opening `Expected`, an "expected … but/got/received/to be" phrase, jest's
`expect(`, a Go `panic:`, PHPUnit's and Pest's `Failed asserting`, XCTest's `XCTAssert… failed`,
swift-testing's `Expectation failed`) or a failed test's header (`FAILED_TEST`: `FAIL`, Go's `---
FAIL`, jest's `✕`, PHPUnit's `FAILURES!`, Catch2's `file.cpp:5: FAILED:`, TAP's and bats' `not ok
N`, swift-testing's `✘`; those runners were never proven without `--expect`, #730, the 2026-11-21
audit; ctest's own output rarely carries an assertion line, so `--expect` is the way there). A bare "expected" once matched Python's
`SyntaxError: expected ':'`, and a base that never ran an assertion was called proven (#193,
the 2026-11-19 audit); and the setup error is checked first, since a SyntaxError's traceback
quoting `assert 2 = 2` was proof too (#326, the audit of 1.4). Nor is an API the candidate adds
and the base lacks (`MISSING_API`: "has no attribute '", "is not a function", `NameError: name`,
`ReferenceError: … is not defined`, an unexpected keyword argument, a wrong count of positional
arguments, Ruby's undefined method or uninitialized constant, PHP's undefined function, a
command not found, as bats prints a script the candidate adds) proof, nor pytest output whose first
`E` line (`PYTEST_E`) isn't an assertion's (`assert`, `AssertionError`, `Failed: ` as in `DID NOT
RAISE`: `PYTEST_PROOF`): pytest's quoted `>` source line `assert mod.slugify(…)` matched
ASSERTION above `E AttributeError`, and jest's `is not a function` under a `✕` header was proof,
while the same test through an import was inconclusive (#729, the 2026-11-21 audit). `assertion`
picks the line the report shows: pytest's first `E` line, else the first assertion line (never a
`>` line), else a failed test's header. Each run is kept in `tasks/<task>/verify/<n>/`: `base.txt`,
`candidate.txt` and `result.json` `{cmd, files, tree, ts, base: {rev, exit, assertion}, candidate:
{rev, exit, assertion}, verdict, dir, expect (when given), uncopied (the candidate's added files
not copied to the base, when any), removed (the candidate's deleted tests, gone from the base too), missing (those the base's output said it couldn't find), code_copied (`--files` paths that
aren't tests), left_out (when any), filtered (when any: why a side's scratch checkout wasn't the
task's bytes, a repo filter's file or failure named, and the verdict then inconclusive, #932)}`. `verify.last` reads the newest, with `stale` once the worktree
or the comparison base has changed since. The verdict names the base commit and candidate tree.

The comparison reaches the review (#97): `wb report <task>` (the latest round's) ends with the
newest check's lines, marked stale when the worktree has changed since. `wb accept` prints
`verify.note`, read before its commit, when that check proves nothing about what is accepted:
not `proven`, or stale. A proven check adds nothing, and with none run the review is the ordinary
one.

### Screenshots of the base and the candidate

`wb shot <task> --capture CMD [--viewport WxH] [--files PATH…] [--timeout N]` (`verify.shot`,
#98) runs the project's own capture command (a headless browser script, a test that saves a
screenshot) once on the base and once on the candidate. Each run uses the same scratch checkouts,
lane and environment as `wb verify`, and the same base: the task's original base for step one, the
last approved step's commit after `wb next` (`_review_base`; the original base showed step one's
change as step two's, and a capture needing what step one added failed on the base, #501). The command writes a PNG to `$WB_SHOT_OUT` (the absolute path of
`.wb-shot-<random>.png` at its checkout's top, a fresh name each run: a PNG already at a fixed
`.wb-shot.png` passed a capture that wrote nothing, #344; absolute because the command runs in the
task's package, `subdir`, where a relative `./.wb-shot-….png` landed while the image was looked
for at the top, and both sides of a package-scoped task lost their screenshot, #433) at the size in
`$WB_SHOT_VIEWPORT` (1280x800 by default). Both are exported ahead of the command itself, which
runs in the agent's shell (`runner.test_shell`) as `--test` and `wb verify` run theirs: a nested
`sh -c` was dash on Debian and Ubuntu, and a `source .venv/bin/activate && …` capture failed on
both sides while the same command passed as `--test` (#517). The same command,
fixture and viewport on both sides make the two images comparable; `--files` copies the
candidate's new capture script or fixture onto the base. workbench ships no browser: the capture
is the project's.

Each pair is kept in `tasks/<task>/shots/<n>/`: `base.png`, `candidate.png`, each run's output
(`base.txt`, `candidate.txt`), and `shots.json` `{task, step, round, cmd, viewport, files, ts,
base: {rev, exit, ok, image, error?, pruned?}, candidate: {…the same}, left_out?}` (`pruned`: its PNG
dropped with its archived task, `store.slim_archive`, #821), where the
candidate's `rev` is the worktree snapshot's tree. That snapshot is what accept lands, as `wb verify`
takes it (`gitops.snapshot_left`): a new binary of 1 MiB or more, or a directory past
NEW_FILES_MAX, isn't in it, and `left_out` names them; the report and the `--chat` message add
`not in the candidate (accept lands them only with --include): <paths>; its picture may not show
them` (`verify.LEFT_OUT`; a new 2 MB photo showed as a broken image with nothing said, #836). A side is `ok` only when its run exits 0 and
leaves a PNG (checked by its signature, never through a link; `verify.shot_ok`, which reads a
shots.json from before `ok` by its image); one that isn't gets an `error` naming its exit and its
output file, even with a PNG, which is kept and named as "the PNG it wrote anyway". A capture
that wrote its image and exited 7 on both sides printed two normal-looking paths, the exits in
shots.json only (#268, the audit of 1.2). The report gives each side's exit, says a capture
failed and that the code review stands on its own: a failed capture never blocks or passes a
review.

`--chat` posts the pair to the web chat (#99): a message from Claude carrying `shots`
(`chat.shots`, *Files* under *The web chat*). The page draws the two images labelled Base and
Candidate, each with its revision, then the task, step, round and viewport. On a screen under
600 px they stack. A side without an image says the capture failed and the code review stands on
its own. "Reply about these" sets what the next message is about (shown above the composer,
cleared with ✕ or by sending, kept in `localStorage` `wb-chat-about`). The reply carries `about:
{task, n}`, and the server fills in the step and round from the pair itself. A reply therefore
stays with the task and step the images were of, even after another task becomes active or newer
pairs arrive. The mod gives it to Claude as `[web chat] (about <task>, step <s>, screenshots <n>)
<their words>`, and Claude turns it into `wb feedback <task>`.

**Audio takes** (#397) come to the page the same way (`wb chat listen`, *Audio*, *Listening by
ear*): under Claude's words, one card per take with "Take <n> · <name>", an `<audio>` player on
a blob fetched with the token from `/api/audio`, its check line, and "Keep this one", which sends
`Keep take <n>: <name>` at once with `about: {audio, n}` (through the outbox, leaving the composer
as it was). The server fills in the take's name and path from the batch; the user's message shows
"Kept take <n> · <name>", and the mod gives it to Claude as `[web chat] (keeps take <n> of the
shortlist: <path>) Keep take <n>: <name>`.

## The web chat

**For people** (moved here from the README, #102): the web chat is off until you turn it on, in
the pane's Settings tab or with `wb chat on` (`wb chat off` again; the choice is kept, the user
2026-11-19). On, it starts a server if none answers, and the pane shows its private link; keep
that link to yourself, it is the key. `wb chat serve` runs the server in the foreground, and `wb
chat url` prints the link. Claude's permission prompts and questions come to it too. Over https (`tailscale
serve --bg 1337` gives it an address on your tailnet) it installs as an app on your phone and
notifies you when Claude answers or needs you. It does less than Claude Code's own Remote
Control (`claude rc`) with the Claude app; what it adds is a lane to the session in your
terminal, the one the workbench mod runs, reachable over your own network.

<p align="center"><img src="docs/web-chat.png" alt="The web chat: Claude's report on which model takes which tasks, the user's reply, a receipt saying Claude has it and will read it after its current step, and 'Claude is on it'" width="420"></p>

`wb chat serve` (`workbench/chat.py`; kept up by `systemd/wb-chat.service`, a user unit running
`%h/.local/bin/wb chat serve` with `Restart=always` and no start limit) serves a small page on
port 1337 for reaching the Claude session in workbench mode while the user is away (one
`chat._Server` per bound address, which binds without the host-name lookup HTTPServer makes:
on macOS it stalled the start past `wb chat on`'s wait, #236). The unit
retries with a delay growing from 10 s to 5 min (`RestartSteps`, systemd 254+; every 10 s on
older ones), since retrying is what brings the chat up when a bound address arrives late (a user
manager has no network-online.target) or the port is briefly held: a start limit gave up for good
there (the 0.90 review). It stops only on exit 78 (`RestartPreventExitStatus`), which bin/wb's
Python-version and Windows guards use, and `wb chat serve` on a chat.json it can't follow (#534). Rebinding and a code reload re-exec in place (below), with
no exit for the unit to see; the exit 75 they once used is gone (#200).

**Keeping it up, and reaching it** (moved here from the README, 2026-11-17). On Linux, link the
unit from the copy `wb` runs from (`~/.claude/plugins/marketplaces/workbench` for a marketplace
install, else the clone): `systemctl --user link <that copy>/systemd/wb-chat.service &&
systemctl --user enable --now wb-chat`. An upgrade needs no restart: the server restarts itself with
new code (below); `systemctl --user daemon-reload` picks up a changed unit file.
A user unit stops with the user's last session unless the user lingers (a headless box
reached by SSH, a desktop logged out overnight): `loginctl enable-linger $USER` keeps it up.
`wb chat on` says so when logind reports `Linger=no`, and `wb doctor` too while the chat is on
(most desktops linger off, and the chat is off until turned on). Where logind's
`KillUserProcesses=yes` would kill the session's runners at logout (`cli.kills_sessions`, the
manager's property through `loginctl show-session`: systemd 262 has no `show` verb), everything
wb leaves running starts in a scope of its own under the user's manager (`cli.detach`, with
`cli.runner_scope`'s `systemd-run --user --scope --quiet --collect`, which execs it, so the pid
is the command's; probed once per `wb` call): each runner, the bench driver (`bench.start`), `wb
optimize` (`optimize.start`) and the chat server `wb chat on` starts (`chat.start`; the runners
alone had one, so a logout still killed the rest: #531). The linger line names the runners,
bench and optimize runs too, with or without the chat; `wb doctor` warns only when that scope
can't be had (`cli.logout_stops`, naming all four; quiet where `loginctl` is absent; #351, the
audit of 1.4).
The unit runs systemd's `python3`; a Python from pyenv, uv or conda goes in with `systemctl --user
edit wb-chat` (the unit's comment says how). On macOS, `launchd/workbench.chat.plist` does the
same (a user agent, `RunAtLoad` and `KeepAlive`, running `exec "$HOME/.local/bin/wb" chat serve`
through `/bin/sh`, since launchd expands no `~`, with Homebrew's `python3` first on `PATH`, Apple's
`/usr/bin/python3` being 3.9): copy it to `~/Library/LaunchAgents/` and `launchctl bootstrap
gui/$(id -u) ~/Library/LaunchAgents/workbench.chat.plist` (its comment says how to remove it; it
retries even a broken install's exit 78, which launchd can't exempt; not checked on a Mac yet,
#449). wb's messages name the service of the OS it runs on (`chat.service_name`, `service_hint`:
`launchctl bootout`/`print gui/$(id -u)/workbench.chat` on macOS, `systemctl --user
disable --now`/`status wb-chat` elsewhere), in `wb chat off` and the port-taken error; they gave
systemctl advice on a Mac (#756). WSL2 with systemd on (`[boot] systemd=true` in `/etc/wsl.conf`) uses the unit; without
it, and on any machine with neither, the revive below brings a chat `wb chat on` started back. `wb chat url` prints the link, `http://localhost:1337/#token=…` (the
port the running server recorded in `chat/port.json`, else the one `chat/serve.pid` says `wb chat
on` last started one on, else 1337; `--port` names one: `wb chat url`,
`on` and `off` without it, and the pane's link, find a server on another port, #349); from a phone, reach the PC the way you normally do and change the host in the link. It
serves only localhost until chat.json says otherwise (*Settings* below): `{"bind": ["localhost",
"tailscale"]}` adds the Tailscale address, `{"bind": ["0.0.0.0"]}` every interface (the LAN, a
VPN), `"hosts": ["chat.example.org"]` a name a tunnel or proxy sends.

- **The path of a message.** The page posts it; the server appends it to `chat/messages.jsonl`.
  The listening session's mod submits it to Claude as `[web chat] <the user's words>`, nothing
  more (a reply to screenshots adds `(about <task>, step <s>, screenshots <n>)`; a take kept from
  Claude's audio shortlist, `(keeps take <n> of the shortlist: <path>)`, #397; and each attached
  file a line `[attached: <path> (<size>, <type>)]`, `attachedLines`, so Claude can Read it, #623),
  so the terminal shows what the user wrote; how to answer is in the `/workbench` skill. It
  goes into the running turn if Claude is mid-turn (`session.send`, with one line saying it's from
  the user), else as the next prompt. The mod also writes a receipt (`wb chat ack`) that the page
  shows at once (Claude has it now, or will read it after its current step). Claude answers with
  `wb chat reply`, which the page shows. The page says whether a session is listening and whether
  Claude is working.
- **Attachments, each uploaded once** (#623; the owner, 2026-11-20, from the phone: simple, and
  never a file uploaded twice by a refresh). The attach button beside the box (or a paste, or a
  drop) puts each file in the tray above the box as a chip: a thumbnail for an image, else its
  kind (`PDF`), its name and size, and ✕. Each file gets its upload id on the page when it is
  picked (`crypto.randomUUID()`, else the page's fallback) and is uploaded at once by that id
  (`PUT /api/upload/<id>`), before Send. The server stores an id once (`chat.save_upload`): the
  same id again stores nothing and answers with the first upload, so a retry, a reload or a second
  tab can't make a second copy; the page also asks `GET /api/upload/<id>` before it sends a byte,
  so a file the computer has is never sent again. The body is read to its `Content-Length` into a
  `.part-<hex>` file in the upload's directory and becomes the file only whole (a body cut short,
  or a server stopped mid-body, leaves nothing the message can name). A message names its files by
  id (`/api/send` `files`); one naming an id with no upload is refused (400), and the server keeps
  one file per content (sha256) in a message, so the same photo picked twice is one file. The
  message row carries each file's `{id, name, size, type, path}`, and the mod gives Claude each
  path. Limits (chat.json, read on each request): `upload_mb` per file (25), `upload_message_mb`
  for a message's files together (50), `UPLOAD_FILES` 10 a message; the page refuses a file past
  them on its chip with the reason, and the server refuses it again (413) before reading the body,
  answering then reading on a moment (`_linger`) so the refusal reaches the page rather than a
  reset. Saved under `chat/uploads/<id>/<name>`, the directory 0700 and the file 0600, through
  directory fds opened `O_NOFOLLOW` and created `O_EXCL`, so nothing is written through a link: a
  link where the id's directory or the file goes is refused (409). A name that is a path (`/`,
  `\`, `.`, `..`) is refused; other names lose unprintable characters and leading dots and are cut
  to `UPLOAD_NAME` 140 bytes of UTF-8 (under eCryptfs's 143; ext4 and APFS take 255), keeping the
  extension (up to 16 bytes) and never splitting a character: cut by characters, a CJK name of 120
  was 360 bytes and failed `ENAMETOOLONG` (#742). A disk that refuses (`OSError`) answers 507 for
  `ENOSPC`/`EDQUOT`, else 500, `{error: "not saved: <reason>"}`, with `final: true` for an errno
  that another try can't fix (`FINAL_ERRNOS`: no space or quota, permission, a read-only disk, a
  name too long). The page calls a `final` answer, or the `SERVER_TRIES`-th (3) 5xx in a row for
  one file, a refusal and shows the server's reason on the chip; other failures wait and try again
  (`BACKOFF`). It re-sent the whole file forever, "waiting for the connection" (#742). `wb gc` removes uploads older than its
  `--days` whose message has a receipt (an expired message's too: it is retired, #741), or that no
  message still deliverable names (a draft never sent: `chat.drop_old_uploads`).
- **The switch.** `chat/switch.json` `{on}`, written by `wb chat on|off` (the pane's row runs
  them, `setWeb`, toasting wb's reason when it fails); absent is off. `wb chat on` turns it on only
  once a server of this account's answers, and leaves it off when it refuses or its server didn't
  start (`web chat left off: …`): turned on first, the row read On and pinned a link that gave a
  401 or nothing, the reason never shown (#690). Off, no session listens or sends the chat a dialog, the pane shows no link,
  the away state ends, and `wb chat off` removes `listener.json`, so the page says nobody listens.
  A server already running is left up (systemd's: `systemctl --user disable --now wb-chat` stops
  it), its messages waiting for the chat to be on again. `wb chat on` starts `bin/wb chat serve
  --port <port>` detached (`chat.start`: `chat/serve.log`, `chat/serve.pid` `{pid, port, start}`) when
  nothing answers on the port at an address the plan binds (a wildcard probed at its family's
  loopback, `chat._probe`: `::` at `::1`, since an IPv6-only socket, bindv6only=1, never answered
  the 127.0.0.1 it was probed at and a healthy chat looked down, #450) (`chat.who_answers`: a GET whose
  response carries `X-Workbench-Chat: <identity>`, `chat.MARK`, which every response of the server
  has, is this account's chat when the value is `chat.identity(token)`, an HMAC-SHA256 of a fixed
  string keyed by the token (32 hex characters, nothing of the token given away); anything else
  answering, another account's chat or a server still on a replaced token included, is "other",
  and `wb chat on` refuses with the port named, while `wb chat off` names no systemd unit. A bare
  `1` said only "a wb chat", so on a shared machine one account's `wb chat on` showed a link to
  another's server that its token got 401 on, #554), then waits up to `START_WAIT` 10 s for it to answer (`chat.wait_up`; one that exits,
  the port taken, fails at once with serve.log's last line). A bare connect counted any program
  on the port as the chat, and a fixed half second said started either way (#200, the
  2026-11-19 audit); `chat.running` is `who_answers == "workbench"`. `wb chat off` stops
  only that process (`chat.stop_started`, by its pid and command line), never one wb didn't start.
- **Coming back.** Nothing brought a server `wb chat on` started back after a reboot or a crash:
  the switch stayed on, the pane showed the link, and the phone said "Can't reach the computer"
  for good (#449). `wb chat url` now starts it again first (`chat.revive`, silently: the mod reads
  the output whole as the link) when the switch is on, `chat/serve.pid` names a server that is
  gone (its pid not a live `wb chat serve`), nothing answers on that port, and `wb-chat.service`
  isn't enabled (`chat._unit_keeps_it`: `systemctl --user is-enabled`, on macOS `launchctl print
  gui/<uid>/workbench.chat`, the agent loaded; it checked only systemd, #756: the service's to
  restart). The mod runs `wb chat url`
  as a session starts and every 10 minutes while the chat is on, so it comes back within that
  once any Claude session with the mod runs. `wb doctor` says when the switch is on and nothing,
  or something else, answers (`cli.chat_gap`). A server `chat.start` makes has no supervisor of
  its own: only that revive, the unit or the launchd agent starts it again.
- **One listener.** A session listens while workbench mode is on in it (from `/workbench`, or a
  delegating `wb` command, until a quit command) and the chat is on. With several sessions the first live claim on
  `chat/listener.json` listens; it is known by its `wb events` process's pid and start.
- **Claude knows where the user is.** A web message carries the same authority as one typed in
  the terminal, with a note: reply there, briefly; the web thread is all the user sees; a yes there
  answers only a question asked there; nothing hard to undo on an ambiguous OK. For six hours after
  a web message (until the user types in the terminal again) Claude also tells the user there
  when something they asked for finishes or needs them.
- **Claude Code's dialogs** (the user, 2026-11-18: the terminal's dialog waited for nobody). While
  the user is away (a web message within 6 h, or since then while one of this session's
  `--backlog` tasks is open: a night's batch outlasts six hours, #110; none typed in the terminal
  since: `chat/away.json`, the user's, not one session's, #688), every delegating
  session's mod puts them on the page as cards (`kind`):
  - `permission`: the tool and what it would run, with Deny and Allow, alike in weight (green made
    allowing look like the right answer, #103). When Claude said what the call is for (Bash's
    `description`, which the mod sends as `detail.purpose`), the card leads with the decision,
    "Allow Claude to <purpose>? (Bash)", the exact command under it. A deny tells Claude to ask
    the user in the chat what to do instead, with their words when they gave any.
  - `question` (AskUserQuestion): each question with its options as buttons (one, or several for
    a multi-select), a box for their own words, Skip and Answer; the picks reach Claude as the
    tool's `answers`.
  - `plan` (ExitPlanMode): the plan (folded past 900 characters or 14 lines), and Keep planning
    with an optional note, which Claude gets as the reason to revise. Approving stays in the
    terminal: Claude Code ignores a hook's allow on that dialog, with or without a `setMode`, though
    it takes a deny (checked in a live session, 2026-11-18); the card says so.

  A tap settles the dialog in the terminal; unanswered for 30 minutes, or the turn interrupted,
  the card says so and the dialog stays in the terminal as usual. The gear's *Tool permissions while you're away*
  setting (`prefs.json` `away`) can instead let Claude go ahead: a permission is allowed at once
  and listed in the thread ("allowed by your setting"); questions and plans still ask, and deny
  rules still hold (they never reach a dialog). How the mod does it: *The web chat listener*,
  under *The mod*.

**Files** (`$WB_HOME/chat/`):
- `messages.jsonl`: `{id: "<ms>-<6 hex>", ts, from: "user"|"claude", text (empty when a user's
  message is files alone), cid?, shots?, audio?, about?, files?}`. `files` (the user's attachments) is
  `[{id, name, size, type, path}]`, from each upload's meta. A post whose `cid` the thread already holds returns that row instead of adding one
  (`_by_cid`: the file read on from where the last post stopped, the newest `CIDS_KEPT` 5000 ids
  kept; only the last 500 rows were checked, and a tab offline longer than that sent its message
  twice, #199). A user's message so found that `open.json` lacks and that has no receipt is put
  back in it (`_reopen`, under `open.lock`): a send cut off between its append and the index (a
  restart mid-request) was retried, said sent, and never reached the listener (#446). `shots` (Claude's, from `wb shot --chat`) is `chat.shots`: `{task, n, step, round,
  viewport, base: {rev, image: bool, exit?}, candidate: {rev, image: bool, exit?}}` (`image` false
  for a failed capture, `exit` when it wasn't 0: #268). `about` (the user's reply
  to a pair) is `{task, n, step, round}`, taken from the pair's shots.json and not from the page.
  `audio` (Claude's, from `wb chat listen`, #397) is `chat.audio_batch`: `{batch: "<ms>-<6 hex>",
  clips: [{n, name, line}]}`; the user's pick has `about: {audio: <batch>, n, name, path}`, the
  name and path from the batch's audio.json.
- `audio/<batch>/`: `wb chat listen`'s copies, `<n>.<ext>`, and `audio.json` `{batch, ts, clips:
  [{n, name, path (the original), file, type (its media type), line (the check line), engine?,
  seed?, voice?}]}`; the newest `LISTEN_KEPT` (20) batches are kept. `wb events` skips it.
- `receipts.jsonl`: `{id, ts, by, how: "now"|"queued"}`, written by `wb chat ack` (the mod); the
  newest row per id stands (a queued one is acked `now` once its turn ends).
  `queued`: a mid-turn delivery didn't go through, so it was submitted as a prompt. `{id, ts, by:
  "wb", how: "expired"}`: the message was retired unread (below); `chat.thread` shows it expired,
  not read.
- `open.json`: `{messages: {<id>: row}, asks: {<id>: row}, answered: {<id>: ask}}`, the user's
  messages without a receipt and the asks without an answer (`chat.open_work`), under `open.lock`:
  `send` and `ack`, `ask` and `answer` keep it, and a state directory without it gets it built
  once from the whole files (`_open_rebuild`). The mod reads its messages to deliver them (#329).
  `answered` holds each ask with its first answer (`answer`, `answered`, `by`, `note?`,
  `answers?`) for `ANSWER_KEPT` (a day), and `chat.find_ask` looks there when the asks' tail no
  longer reaches the ask: answering an old open one took it out of `asks`, and its waiter (`wb chat
  wait`) then got "no such permission prompt" for the answer just given (#447).
- `claims.json`: `{<message id>: {by, ts}}` (a day's), under `claims.lock`: `wb chat claim` gives
  a message to the first session that asks and to it again, or to another once the claim is
  `CLAIM_STALE` (120 s) old (its session gone); exit 1 otherwise, and exit 1 with `<id> expired:
  over 6 hours unread, so not passed to Claude; the page offers to send it again` for an expired
  message (below).
- `away.json`: `{at, by}`, written by the mod: when the listening session last passed on a web
  message (seconds; `by` its key), `{at: 0}` once a prompt is typed in any session or the chat is
  turned off. Every session reads it for whether the user is away (#688).
- `listener.json`: `{session, cwd, pid, start, machine, busy}`, written by the mod when it changes (`start`:
  its `wb events` process's, from the hello; `machine`, the hello's: another machine's mod never
  reads that pid as gone and takes the listener, #922). A listener counts while its pid is this user's and
  started at `start` (`chat._alive`, which is `models._alive`: a root daemon under a recycled pid
  answered EPERM and read as listening, #532), or, with no pid, while its `ts` is under 15 s old.
  A claim whose `machine` is another one's always counts (`chat.listener`, for the page and `wb chat
  log`, as for the mod): its pid can't be asked here and the file is written only on a change, so the
  page said "Waiting for a Claude session" while that machine's session got every message (the
  review of #922).
- `asks.jsonl`: the dialogs. An ask row `{id: "ask-<ms>-<8 hex>", ts, tool (200 characters),
  text (2000), kind: "permission"|"plan"|"question", detail?, pid?}` from `wb chat ask` (`pid`:
  the asking session's `wb events` process, from `--pid`; once it no longer answers `kill -0`, the
  next `chat.asks` (the page's snapshot, `find_ask`, the `Pusher`'s news) answers the open ask
  `expired` by `interrupted` (`_orphaned`), so `answer` takes nothing more for it: a card left by a
  crashed or closed session stayed open for good, took an Allow nobody waited for, and showed in
  every later push, #538. An ask without `pid`, from an older mod, only goes `stale`. `detail`, at
  most `DETAIL_MAX` 40,000 bytes of JSON as stored, UTF-8 and unescaped; over that,
  `chat.fit_detail` cuts the plan, else the options' previews, else their descriptions, each to one
  length, the longest first, ending `CUT_NOTE` " (cut: the rest is in the terminal)", and refuses
  only questions that can't fit themselves. Measured as json.dumps' ASCII escapes, six bytes a CJK
  character, a 7,700-character Japanese plan was refused, #535. A question's `{questions}`, the tool's own; a plan's `{plan}`,
  from the tool's input, else `chat.session_plan`: the file `{plan_file}` names, else the last
  plan file the `--session`'s transcript names, read only when it is a `*.md` directly in
  `$CLAUDE_CONFIG_DIR/plans`; one it can't find is `{plan: "", project: <--repo's name>}`,
  answered `expired` by `terminal` at once, and the page sends the user to that project's
  terminal. It read the newest file in that directory, any project's: with two planning, one
  card showed the other's plan, #253, the audit of 1.2), then
  answer rows `{id, ts, answer: "allow"|"deny"|"expired", by:
  "web"|"setting"|"timeout"|"interrupted"|"terminal"|"cli", note?, answers?}` (`note` up to 2000 characters;
  `answers` only for a question allowed, keyed by its own questions' text, each a non-empty
  string). The first answer row wins (`chat.asks` ignores later ones), so the page's tap and the
  mod's expiry, two processes, can't both stand; `wb chat answer` prints the answer that stands.
  A row without `kind` reads as a permission. The page's list (`chat.asks`, in the snapshot) is
  the newest 20 plus every open one older than those, and `wb chat pending` every message of the
  user's without a receipt, not only the newest 200: an open question vanished behind 20 newer
  answered ones, and an unread message behind 200 replies (#265, the audit of 1.2). Both read
  `open.json` for what is still open, not the files' tails: an unread message behind 540 long
  replies, and an open question behind 120 plan cards, fell out of the 4 MiB tails, and the
  question could no longer be answered (#329, the audit of 1.4). An ask open past `ASK_STALE` (an hour; the mod waits 30 minutes)
  carries `stale: true`; the page shows a stale ask as waiting in the terminal, with no buttons.
  A message of the user's unread past `MESSAGE_EXPIRE` (6 h, the one threshold: the snapshot's
  `expire`) carries `expired: true` in `chat.thread`; `wb chat claim` refuses
  it, so no session springs it on Claude, and the page says "Not passed to Claude (over 6 h old)"
  with *send again* (a new message, its own cid, naming the same uploads: not a byte sent again,
  and what it was about, a pair of screenshots or a kept take: without it Claude got the words with
  no task, step or take, #843). The mod skipped it on a clock of its own and
  the page said "Delivered" for good (#536). The first `chat.open_work` to find it expired retires
  it (`_retire`, under `open.lock`): out of `open.json`'s `messages`, with an `expired` receipt, so
  `wb chat pending` no longer lists it, the mod no longer sees it, and `wb gc` drops its uploads;
  `wb chat claim` still refuses it from that receipt (`_expired_receipt`). Only an ack popped one,
  and every new session claimed it and toasted again, for good (#741).
- `uploads/<id>/`: one attachment (0700): `<name>` (0600) and `.meta.json` `{id, name, size, type,
  sha256, ts, path}`, written last, so it marks the upload whole; `.part-<hex>` while a body comes
  (removed whatever happens). `uploads.lock`: one upload finishing at a time.
- `prefs.json`: `{away: "ask"|"allow"}` (anything else reads as `ask`), from the gear menu
  (`/api/prefs`), read by `chat.ask` (`allow` answers a new permission at once, by `setting`).
- `push.json`: `{subs: [{endpoint, ts, ua}]}`, the devices with notifications on (the last 20,
  `MAX_SUBS`), locked by `push.lock`; `seen.jsonl`: `{id, ts, by: "page"|"push", endpoint?}`: what a
  page showed on screen (each id once; with `endpoint`, for that device only, #537), or a push one
  device took (`endpoint`, each id once per device; a push row without one, from before, counts for every device); `push-test.json`: `{ts}`, the
  last test push. The VAPID key is beside the token (`<token file>-push`, mode 600, made on first
  use: written whole to a temp file beside it, fsynced, then linked into place, and an empty or
  unparsable one replaced the same way, `webpush.private_key`; created first and written after, a
  full disk or a crash left it empty and every chat request failed, #924; renamed into place where
  the file system has no hard links, exFAT or some FUSE or SMB mounts, which left push off for good).

**Settings.** The token: `$WB_CHAT_TOKEN`, else `~/.config/workbench/chat-token` (created on first
use with `O_EXCL`, mode 600, `token_urlsafe(32)`; kept at 600; one under 16 characters is refused
with a message), read once when the server starts, so a new token needs a restart. The settings:
`$WB_CHAT_CONFIG`, else `~/.config/workbench/chat.json`, with four keys. `upload_mb` and
`upload_message_mb`: the attachment limits, per file (25) and per message (50), in MiB, read on
each request (*Attachments* above) straight from the file (`chat.upload_limits`, not `settings`:
every snapshot reads them, so a `bind` broken while the server runs must not fail each request).
`bind`: addresses to listen
on, which replace localhost (`localhost`, an address, `tailscale`: the tailnet IPv4 from
`tailscale status --json`, else its first IPv6 (a node with IPv4 turned off was "not running" and
the chat bound localhost alone, #937), the CLI found on PATH or, on macOS, in the app bundle
(`TAILSCALE_APP`), never Windows' under WSL (#920); skipped as `tailscale (not running)` (no
`Self`, or a `BackendState` other than `Running`), `tailscale (no Tailscale address)`, or
`tailscale (CLI not found: …)` when neither has it; `0.0.0.0` or `::`: every interface). `hosts`: extra host names to answer to (`*`: any).
Each is a list of strings; a string is a one-item list (iterated, `"0.0.0.0"` became the binds `0`
and `.`), and anything else stops `serve` with `chat.ConfigError` naming chat.json, exit 78, so the
unit doesn't retry it (#534). A wildcard covers its family's other binds: with `0.0.0.0` the plan
drops the specific IPv4 ones, with `::` the specific IPv6 ones (their names stay answered), and
`::` beside any IPv4 bind gets `IPV6_V6ONLY` (`plan()["v6only"]`, `_Server.v6only`). On Linux each
further socket on the port failed `EADDRINUSE`, so `["localhost", "0.0.0.0"]`, `["0.0.0.0", "::"]`
or `["127.0.0.1", "::"]` never started (#534). `--bind` replaces chat.json's
binds, `--host` adds to its hosts, `--port` changes the port. Answered host names (`chat.plan`,
worked out once at startup): `localhost`, `127.0.0.1`, `::1` always; for `tailscale` its DNS name,
first label and host name; for a wildcard the host's name, its first label, its FQDN and whatever
the host name resolves to; any other bind as itself; plus `hosts`. On any bind it also answers to
this machine's full MagicDNS name while Tailscale is up (`chat.tailnet_name`, from `tailscale status
--json`, asked at most every `REPLAN_EVERY` 30 s and only for a Host not already answered):
`tailscale serve --bg 1337` passes that name through as the Host, and the default localhost chat
answered the page itself 403 `unknown host` (#448). Under WSL with no Linux CLI it asks Windows'
`tailscale.exe` (`tailscale(windows=True)`: Tailscale's own WSL2 setup, whose serve
reaches WSL through Windows' localhost forwarding; `which` never tries `.exe`, #920), from PATH,
else `TAILSCALE_WINDOWS` under WSL's automount root (`hardware.windows_program`, as for
PowerShell): `wb-chat.service` runs with the user manager's PATH, and `appendWindowsPath=false`
leaves Windows' off too; the
`tailscale` bind doesn't, as Windows' tailnet IP isn't on WSL's interfaces in NAT networking. Only the full name (`box.tailnet.ts.net`, the one
serve's certificate has), which no other site's DNS can answer for. `serve` prints what it listens
on, binds it skipped, and warnings for a wildcard bind or `hosts: *`; an address it can't listen
on ends it with one line (`can't listen on <addr>:<port>: the port is taken: another wb chat serve
… or another program; --port picks another`; for an address after the first, `by another address in
the bind list (chat.json's bind, or --bind) or another program`; or the address isn't on this machine). With a bind skipped (tailscale
not up yet) or a `tailscale` bind (its address comes and goes), it rechecks every
`REPLAN_EVERY` 30 s and once the set of addresses differs re-execs in place (as for a code
change, below) to bind them. Only a longer list was noticed, so a tailscale-only chat serving
loopback stayed there when the tailnet came up, and the restart was an exit 75 that ended a chat
`wb chat on` had started, with no service manager to start it again (#200). Every `RELOAD_EVERY` 10 s
it looks at its package's `*.py` (`code_stamp`: names, mtimes, sizes; `watch_code`); once they
have changed and held still for a look (a pull writes files one by one), it says so and re-execs
the same command line (`sys.orig_argv`) in the same process, so systemd and launchd see no exit
and a hand-started server keeps running: one left up across an update served the new page from
the old code for a day and a half (2026-11-18). `wb chat url` prints
`http://localhost:<port>/#token=…` (the fragment never leaves the browser); when chat.json's `bind`
has neither loopback nor a wildcard, the plan's first address instead of localhost, which reached
nothing there (#534).

**The HTTP API** (`Handler`, HTTP/1.0, no keep-alive, no CORS; a connection that stalls for
`TIMEOUT` 30 s, before its request is in or on a blocked write, is closed, so an idle one holds a
thread no longer):
- Every request: the `Host` header (port and brackets stripped, lowercased) must be an answered
  name or the address the connection came in on (`Handler._local`, the socket's own address,
  `::ffff:` and a `%zone` dropped), else 403 `{"error": "unknown host <host>: add it to chat.json's
  hosts"}`: this stops other web pages and DNS rebinding, which needs a name, never an address.
  With `0.0.0.0` the names come from the host name, which Debian, Ubuntu and WSL resolve to
  127.0.1.1, and they miss an address gained after the start (a late Wi-Fi, a VPN), so a phone on
  the LAN or tailnet IP got that 403 (#533).
  Responses carry `Cache-Control: no-store` (but `GET /api/file`), `X-Frame-Options: DENY`, `nosniff`, `no-referrer` and
  a CSP (`default-src 'self'`, inline styles only, images also from `blob:` (the screenshots),
  media only from `blob:` (the audio takes, #397), no framing, no forms).
- `GET /`, `/index.html`, `/<name>` with a known suffix (html, js, css, svg, png, webmanifest)
  from `chat_static/`; anything else 404. `/manifest.webmanifest?k=<the token>` (compared in
  constant time) gives `start_url: "/?token=<it>"`, so the app installed from it opens keyed;
  any other `k`, the plain `/`.
- The API wants `Authorization: Bearer <token>` (the `Bearer ` prefix required, compared in
  constant time); else 401 "bad or
  missing token: open the link from `wb chat url`".
- `GET /api/latest`: what a push shows (`chat.latest`, #755): `{now, asks: [the newest open ask
  that isn't stale, a plan's without its `detail`], messages: [Claude's last message, from the
  messages' last `LATEST_BYTES` 1 MiB], push: {test}}`, the snapshot's shape for `sw.js`.
- `GET /api/state`: `{messages (the last 200, each user row with its receipt as `received`; `thread` reads the files' last `THREAD_BYTES` 4 MiB, `store.read_jsonl_tail`, as `asks` does: the whole history was parsed on every poll, 56 ms at 20,000 rows, the 2026-11-19 audit),
  asks (the last 20, each with `answer` (null while open), `answered`, `by`; a settled one lean,
  `chat.page_ask`: a plan past `PLAN_PREVIEW` 1,200 characters cut to them with `detail.cut`, a
  question's `detail.questions` only their `question` text, all the page shows of one answered;
  thirty answered plans were most of a 922 KB state, #755), prefs, push (`{key:
  the VAPID public key, null when it can't be had (`chat._push_key_or_none`, said once in
  serve.log: a broken key stopped messaging too, #924), test: the last test push's ts}`), listener, savings (`chat.week_saved`:
  `savings.totals` over the last 7 days with its `score`, as `wb savings --json` without `period`), uploads (`chat.upload_limits`: `{file, message, files}`, the byte limits and files a message), build, expire (`MESSAGE_EXPIRE` in seconds: past it a
  user's unread row carries `expired`, #536), now}`. `build` (`chat.build`, a crc32 of the page's files' names, mtimes and sizes) changes
  when the page does: a page that loaded other files reloads itself.
- `GET /api/ask/<id>`: `{ask}`, the ask whole (`chat.find_ask`), else 404 "no such prompt": the
  page fetches a cut plan's text when the user unfolds it (#755).
- `GET /api/shot?task=&n=&side=base|candidate`: one side of a `wb shot` pair as `image/png`,
  behind the token (401). It is read only when the task name passes `store.NAME_RE`, `n` is a
  number with a shots.json, and the side is one of the two and its capture worked (#268: a
  failed one shows "No image: the capture failed (exit N)", whatever it wrote); it never follows a link
  (`O_NOFOLLOW`) and serves at most `SHOT_MAX` (16 MB). A side `pruned` (its archived task's
  PNGs dropped after `store.SLIM_DAYS`, #821) gets 410 "expired", and the page says "This
  screenshot has expired" in its place, for a message that recorded the pair before then
  too. Anything else gets 404 "no such screenshot". The page can't put the token in an `<img src>`, so it fetches each image with the
  token and shows a blob URL.
- `GET /api/audio?batch=&n=`: one take of a `wb chat listen` shortlist (#397), behind the token
  (401), with the media type it was sent with. It is read only when the batch matches `<ms>-<6
  hex>` (`BATCH_RE`) and is a directory (not a link) with an audio.json, and `n` is one of its
  takes; it never follows a link (`O_NOFOLLOW`, a regular file only) and serves at most
  `AUDIO_MAX` (64 MiB). Anything else gets 404 "no such take". The page fetches each take with the
  token and plays a blob URL, as it shows the screenshots.
- `GET /api/stream`: server-sent events (with the security headers): `event: state` with the
  snapshot at once, then `event: patch` whenever it changes (`chat.patch`, against what this
  stream sent: `messages` and `asks` as `{put: the rows new or changed, drop: the ids gone}`, only
  when they changed, and every other field whole, about a kilobyte, with `now`), `: ping` after
  15 s idle. The whole state went out on every receipt and busy flip, five times an exchange,
  4.6 MB per open device with a long thread and plan mode (#755). The small fields go whole so a
  page that took an older state from a POST's reply can't keep it (a busy flipped back would never
  be sent again). At most `MAX_STREAMS` 16
  open: past it the oldest stream gives way (its handler's `evicted`, then a wake) and the new one
  waits up to 5 s for its slot (503 after), since a stream a phone dropped without a word (asleep,
  a new network) lingers while the live page can't get in; with the cap full of those, the page
  said "Reconnecting" until a hard refresh (2026-11-18). On Linux a stream's socket gets
  `TCP_USER_TIMEOUT` `UNACKED_MS` 45 s, so a write the peer never acknowledges fails within a
  minute rather than the kernel's quarter of an hour. One `Hub` thread watches
  `chat/` (inotify, or `wait()` when it fell back to polling) and a pidfd on the listener and
  wakes every stream. Without inotify it looks every second but wakes them only for a change, the
  listener's process no longer answering `kill 0` (once per pid: how a dead listener is noticed
  there, no `ps`), or `IDLE_BUMP_S` (60 s) with neither, as the native path's timeout: waking every
  second, each open stream rebuilt its whole snapshot, a `ps` fork each on macOS, with nothing new
  (#841); a wake with nothing new writes nothing, so the 15 s ping holds on every platform. A
  failure in the hub's watching (`_watch`) is printed and the watching starts again a second
  later: a dead hub would have left every page without news. It keeps the `chat/` it started with
  (`Hub.dir`) and stops at `close()`: a test's hub, resolving `WB_HOME` again on each restart,
  made the next test's state directory in its setUp's way (#134).
- `POST /api/send`: JSON only (415), at most 32 KB (413), a `Content-Length` that isn't a number
  0 or more (400), `{text: 1–8000 characters, cid?: 1–64 characters, about?: {task, n} | {audio, n},
  files?: up to 10 upload ids}` (400; an `about` naming no pair, 400 "no such screenshots"; no such
  take, an `n` that isn't a whole number among them, 400 "no such take"; text may be empty with
  files; an id with no upload, 400 "no upload <id>: …"; the files over `upload_message_mb`
  together, 413), → 200 `{message, listener, state}`.
- `PUT /api/upload/<id>` (`<id>` 8–64 of `[A-Za-z0-9-]`, else 400): the file's bytes as a raw body
  (no multipart parser: `cgi` is gone in 3.13), its name URI-encoded in `X-File-Name`, its type in
  `Content-Type` (kept when it looks like one, else `application/octet-stream`). No
  `Content-Length`, 411; over `upload_mb`, 413 "too big: <size>, the limit is <limit>" before
  reading; a name that is a path, 400; a link in the way, 409; a body cut short, nothing kept. →
  200 `{upload: {id, name, size, type, path}, new}`; an id already stored → the same, `new: false`.
- `GET /api/upload/<id>`: 200 `{upload}` when stored, else 404 (the page asks before it uploads).
  `GET /api/file/<id>`: the file, never through a link; an image (`SHOWN`: png, jpeg, gif, webp,
  avif) as itself, anything else as `application/octet-stream` with `Content-Disposition:
  attachment`, so nothing uploaded renders as a page. It alone is cacheable, `FILE_CACHE`
  (`private, max-age=31536000, immutable`, `Vary: Authorization`): an upload never changes under
  its id, and with `no-store` every photo in the thread was fetched whole again on each load (#754).
- `POST /api/answer`: the same checks, `{id: 1–64 characters, answer: "allow"|"deny", note?: up
  to 2000 characters, answers?: up to 4}` (400; `expired` is the mod's alone; answers that don't
  fit the question, or answers on anything but a question, or a question allowed without them,
  400), an unknown id 404 "no such prompt", → 200 `{ask, state}`, the ask with the answer that
  stands (an earlier one, when the prompt was already answered).
- `POST /api/prefs`: the same checks, `{away: "ask"|"allow"}` and nothing else (400) → 200
  `{state}`.
- `POST /api/seen`: `{ids: up to 200 ids, endpoint?: a push service's URL}` (400 otherwise) → 200;
  the ids go in seen.jsonl, with `endpoint` (no push owed to that device alone) when it is given.
- `POST /api/push`: `{endpoint, on: true|false}` subscribes or drops a device (400 unless the
  endpoint is `https` on port 443 at a push service, `webpush.PUSH_HOSTS`, so the token alone
  can't make this machine post where it likes); `{test: true}` pushes every device now → 200
  `{sent, ok}`.

**The page** (`chat_static/`: `index.html`, `app.js`, `app.css`, `manifest.webmanifest`,
`icon.svg`; no inline script, as the CSP requires). Its header and title say Workbench (the app),
and the presence line whom you talk to: "Claude · listening in ~/project", "Claude · working in
…", "no session listening · messages wait" (#103: a notification opened on "Claude" said
nothing of which app). The token is taken from the address's
fragment (or `?token=`, the installed app's start URL) into `localStorage` (`wb-chat-token`) and
stripped from the address bar; a missing or refused one shows a screen that accepts a pasted link
or token. It never expires (it is the token file). A keyed page over https points its manifest link at
`?k=<token>`, since an app installed on iPhone gets storage of its own, not Safari's (the user,
2026-11-18: no key to paste in the app). A reload shows the thread the page last had (the last
50 messages, `wb-chat-thread`) and "connecting…" until the first live state, which it asks
`/api/state` for at once as well as opening the stream (a refresh showed "no session listening"
and an empty thread for seconds while the stream waited for a slot, 2026-11-18). The stream is a `fetch` with the
bearer header (EventSource can't send one), parsed by hand; each connection starts with a whole
state, a resync, so nothing arrives half-received, and a `patch` is merged by id (`merge`: a row
put replaces its own or is added at the end, a dropped one goes). The page keeps the server's
`now` of the newest state it took (`stamp`), and skips a POST's reply (`/api/send`, `/api/answer`,
`/api/prefs`) or the first `/api/state` older than that: the patches build on what the stream sent,
so a row an older reply lacked would never come again (#755). The thread is saved for a reload
only when a state or patch carries messages. A settled plan that came cut shows "Show the whole
plan", which fetches `/api/ask/<id>` and unfolds it ("Not loaded: try again" on a failure). A message goes into a local outbox (one localStorage key per
message, `wb-chat-out-<cid>`, the cid a `crypto.randomUUID()`), read afresh whenever it is used,
and is sent in order until the server has it: an item is dropped when `/api/send`'s reply names
its cid (`message.cid`, the row the server logged or already had), or when a snapshot lists it.
The snapshot alone holds the newest 200, so a retry after a lost reply, 205 messages later, kept
its pending bubble for good (#264, the audit of 1.2). A `storage` event (another tab queued, sent or
dropped one) redraws and flushes, so whichever tab is online sends every tab's. One shared array
(`wb-chat-outbox`, moved into the keys on load) was each tab's copy saved over the others':
two tabs offline, and only the second's message reached the server (#199). A message the
browser won't store (its storage full, or denied) is `held`: it stays in the composer, sent from
memory and retried like the outbox, and the box is cleared only once the server has it; the
banner says so while it waits (`HELD`). Send cleared the box at quota, showed no pending bubble
and sent nothing (#245, the audit of 1.2). Held or not, a message has landed only when the reply
names its cid: a 200 that doesn't (a captive portal's or a proxy's page, an empty body) is tried
again, where any 200 cleared a held message's box, its only copy (#934). The server ignores a cid
it already holds, so nothing is sent twice; a 4xx other than 401 marks it not sent, with retry,
edit and delete, except 408, 425 and 429 (`transient`, which the uploads share): something in
front of the chat saying "later", tried again by itself after its `Retry-After` (`retryAfter`, held
under 30 s) or the backoff, whichever is longer; it waited for a tap on retry (#936). Each send
(`post`, the reply's body included: cleared at the headers, a body that stalled held `flush`, and
every later send, until a reload, #935) gives up after `POST_MS` 15 s of silence, before the
headers or between two chunks of the body (the timer re-armed at each, as an upload's
`STALL_MS`: one deadline for the whole body cut off every reply's snapshot on a link too slow to
carry it in 15 s, so a held message, cleared only by its reply, stayed in the box for good), and
is tried again, so a dead line can't hold the outbox; `flush` clears its `flushing` flag and reschedules in a
`finally`. Staying connected: a 40 s watchdog (`DEAD_MS`; pings count) aborts a silent
stream, and that counts as a failure, backing off like any other (reconnecting at once kept the
count at one, so a server that took the call and never answered showed "Reconnecting…" for ever;
2026-11-18); jittered backoff, 0.5 s to 30 s, a banner after three failures; aborting a stream
also cancels its body's reader, since WebKit can keep the socket (and the server's slot) open
otherwise; offline, it still tries every 30 s or so, since a phone doesn't always fire `online`;
back on screen after more than `AWAY_MS` (3 s) off it, or from the back-forward cache with nothing
heard for `STALE_MS` 20 s, it dials at once rather than waiting out the watchdog: a phone asleep
a few seconds after the last ping came back to a line heard from under 20 s before, kept it, and
showed a new message 10 to 40 s after its push (the owner, 2026-11-20); and when the worker
shows a push it posts `{kind: "push"}` to each open page, which dials again (a push is only for
news no page showed, so that page's line is likely dead); a page hidden for a minute drops its stream. When a
state's `build` differs from the one the page loaded with, the page reloads (`reloadOnce`, at
most once a minute, else it carries on with the new build; the draft and the outbox are in
localStorage). The phone keyboard (as merecatholicity.com's DM composer handles it, 2026-11-19):
with one up (the visual viewport over 120 px short of the window), the body is sized to the
visual viewport and moved to its `pageTop`, which counts iOS's own scroll of the page on focus
(with `offsetTop` alone, that scroll outlived the keyboard and left the composer halfway up the
app); with none, the inline size goes and the page is scrolled back to 0. It is fitted on every
viewport resize or scroll and on a ladder after focus and blur (0 to 1200 ms), since the keyboard
takes ~300 ms and iOS scrolls after it. A swipe down from outside the composer (48 px, measured
in screen coordinates, since iOS pans the page with the finger and `clientY` barely moves) or a
tap on nothing that takes one puts the keyboard away. Rendering is DOM only (inline code, bold, links, fenced code,
lists); a receipt is one short line with one time (#103: it wrapped, and showed the time twice):
"✓ Delivered · <sent>", "✓ Waiting for a Claude session · <sent>", "✓✓ Read by Claude · <read>",
"✓✓ Queued for Claude · <read>" (mid-turn, read after the current step), "Not passed to Claude
(over 6 h old) · <sent> · send again" (`expired`, #536); the meta line is
`--dim` (4.9:1 on the background; it was `--faint`, 2.4:1), its buttons (copy, retry, edit,
delete) padded to a thumb's target. The user's bubbles are dark text on coral (5.1:1; white was
3.1:1). "Claude is on it" shows while the listener is
busy with the user's latest message. A dialog is a card in the thread by its time (`makeAsk`,
the three kinds above; buttons and option rows at least 44 px tall) whose answer posts
`/api/answer` and renders the state it returns; while it waits, the meta line says "Claude is
waiting for your answer" and a hidden page's title "Claude asks: allow?" (a permission) or
"Claude needs you"; answered, the buttons go and the meta says "you allowed it", "allowed by
your setting", "you said no", "you answered" (the picks shown), "you passed", "you asked for
changes" (the note shown), "settled in the terminal" (an interrupt, or the dialog answered
there) or "no answer in time: it waits in the terminal". The gear in the header drops a settings
sheet (`#settings`; closed by the gear, Escape or a tap outside), what people come back for first
(#103): *Tool permissions while you're away* (Ask me here / Let Claude go ahead, posting
`/api/prefs`, with what each means), *Notifications* and *What it saved* (`drawSaved`: the week's
`savings`, in a sentence, called an estimate, the GPU's energy with `, cost 0.27` once a price is
set, no currency sign, as `wb savings` and the pane: a `$` made a euro or pound price dollars,
#845; "Nothing to compare yet" before a task can be), then
*The app*, *This chat* (what this lane is: a second lane to the session, not a copy of the
terminal; Claude sends here what matters, and keeps the user posted here when asked) and *This
device* (forget the key: the key screen, with no restoring of the old one). Claude's messages flow in at a reading pace (`flows`) once
the first render is done; the backlog a first visit loads, a message that arrives while the page
is hidden (it counts as unread in the title) and reduced motion show whole, and each shown message
is remembered (`wb-chat-seen`, the last 500) so a reload doesn't replay it. Light and dark follow `prefers-color-scheme` (tokens on
`:root`, `color-scheme` meta, a theme colour per scheme); reduced motion turns animations off.
Attachments (#623): the tray's chips (`drawTray`; wrapped, not scrolled sideways, so a refused
chip says why on screen) are the draft's files, kept in localStorage (`wb-chat-files`: `[{id,
name, size, type, mod, state: up|retry|done|refused, why?}]`) with their bytes in IndexedDB
(`wb-chat`, store `files`) until the message carrying them lands, so a reload shows the same
chips and never sends a stored file again. `pump` uploads the draft's files one at a time (XHR,
for the progress bar; one with no progress for `STALL_MS` 30 s is dropped and tried again with
the same id), a network failure backing off, a refusal shown on its chip. The same file picked
twice (name, size, modified time) is one chip. Send takes the text and the chips not refused into
the outbox item (`files`: `[{id, name, size, type}]`); `flush` makes sure each is uploaded before
it posts `/api/send` with their ids, and a refused one marks the message not sent, naming the file
(edit puts its files back in the tray, and what it was about back above the box: `setAbout`, a
kept take shown by its `aboutTag`; the edited message went out as a general one, #843). In the thread a message shows its images as thumbnails
(a tap shows one whole, `view`; a tap or Escape closes it) and other files as name and size (a
tap saves it), each fetched once with the token as a blob (`fileURL`), or from this page's own
bytes; one `wb gc` removed says "no longer on the computer". A thumbnail is fetched only once it
scrolls within 600 px of the thread's view (`whenNear`, an IntersectionObserver on `main`), and the
browser's cache may answer it: a thread of 30 phone photos was 100-150 MB on every load (#754). Each render and each removed chip
revokes the object URLs no chip, thread row or open viewer still names (`sweepSoon`): picked and
removed photos held their full-size blobs until the page closed (#746).
Away from localhost over plain HTTP the page isn't a secure context, so the browser's UUID and
clipboard are missing (the page falls back: its own ids, and a reply's *copy* through a selected
textarea and `execCommand('copy')`, `copyText`; it said "copy failed" on every tap, #745), and it can't install or notify: the gear says so,
and that `tailscale serve --bg 1337` gives it an https address on the tailnet.

**The app and notifications** (the user, 2026-11-18: like their other site's, but no new
infrastructure). The manifest (named "Claude's Workbench"; its `short_name` and
`apple-mobile-web-app-title`, which iOS reads, "Workbench", since a home screen cuts long names; standalone, PNG icons at 192 and 512, maskable, and an
apple-touch icon at 180, rendered full-bleed from icon.svg) makes the page installable, over https
only: `http://localhost` is a secure context too, so Chromium offered the install there as well and
one computer got two apps of one name, the localhost one useless away from it (the user,
2026-11-18); over http `app.js` removes the manifest link, so no browser offers it, and the gear
points at the https address (`tailscale serve --bg 1337`). Notifications still work over localhost.
The gear's *Install the app* section says "Installed ✓" when it runs standalone (`display-mode: standalone`
or `navigator.standalone`); otherwise an Install button where the browser offered
`beforeinstallprompt`, Safari's Share → Add to Home Screen on iOS (another iOS browser is sent to
Safari), else the browser's menu. *Notifications*: a switch (iOS: only in the installed app,
which is Apple's rule; blocked: where to allow them), on asks permission (only on that tap) and
subscribes with the server's VAPID key, re-subscribing when the key changed; on shows Send a test.
A notification's `badge` is `badge-96.png`, the white spark on transparent (RGBA): Android draws the
status-bar badge from the alpha channel alone, and the RGB app icon showed a white square (#757).
`sw.js` (registered with `updateViaCache: 'none'`) caches nothing and answers no fetch (another
app's offline cache gave iOS installed apps white screens). Pushes carry no payload (RFC 8030)
and are signed with VAPID (RFC 8292: ES256, done in plain integers in `webpush.py`, checked
against RFC 6979's vectors and openssl), so nothing needs encrypting and nothing the user and
Claude write passes through Apple's, Google's or Mozilla's service: the worker fetches
`/api/latest` (the whole `/api/state`, up to a megabyte with plans in it, until #755) with the key the page left it in Cache Storage (`wb-chat` `/key`, deleted before
each write: WebKit drops a put over an entry a reloaded page wrote) and shows the newest open
dialog that isn't `stale`, unless Claude's latest message is newer, else that message (or
"Notifications work" for a test; a dead session's card beat every later reply, #538), tagged `wb-chat`; a
tap focuses the chat or opens it. Which news is pushed: a page posts what it showed to
`/api/seen`: for every device while it is in use (visible, focused, and a pointer, key, wheel or
touch within `USING_MS` 2 min; it reports again on focus and on each input), else, when this
device has notifications on, with its own `endpoint`, so only its push is spared; a page merely
visible and unsubscribed reports nothing. Any visible tab counted for every device, so a desktop
tab left open behind the terminal meant the phone was never notified (#537); the server's `Pusher` thread (woken by each change, and every `PUSH_DELAY`/2) sends
one push to each device still owed Claude's messages and open dialogs that no page showed within
`PUSH_DELAY` 10 s and that are under `PUSH_WINDOW` 15 min old (never a backlog; with no device
subscribed it works nothing out, and seen.jsonl is read on from where the last look stopped,
`_seen_update` under `_seen_lock`: each tick reread the whole file, 94 ms at 60,000 rows with
nobody subscribed, #456), and marks them
`push` for each device that took it. A device its service failed for now (not reached, 429, 5xx:
`_transient`) is tried again after `PUSH_RETRY` (30 s) while the news is in the window: every
due push was marked sent whatever the services said, and a phone whose service was down for
seconds missed a permission prompt (#86). A device the service says is gone (404, 410) is
dropped; another refusal is not retried, and its seen.jsonl rows say `by: "refused"` with its
`status`, not `push`. `webpush.send` returns `(status, reason)`; a certificate this machine can't
check is `webpush.CERT` (-1), for good, not transient; the `Pusher` prints each distinct reason
once to stderr (serve.log: `web chat: a push to <host> failed: <reason>`); pushes go out with
`webpush.tls()`, the default context plus macOS's `/etc/ssl/cert.pem` (`MAC_CAS`) when its store
is empty (python.org's Python before Install Certificates.command; `bin/wb` runs the newest
`python3.N` on PATH, often that one). Send a test answers `{sent, ok, hint, reasons}`
(`chat.push_hint`: `cert`, `clock` for a 403, VAPID's expiry against a skewed clock, `unreached`,
`refused`), and the page says what to do for each: with the reason dropped, an empty CA store read
as "the push service didn't take it", serve.log stayed empty, real pushes were retried for 15
minutes and dropped, and a 403 was written down as delivered (#539). Checked live: Chromium's push
service is `jmt17.google.com` (Chrome's `fcm.googleapis.com`), and a reply reached the worker as
a notification with its text (2026-11-18).

A change to `chat.py` or `chat_static/` also needs the browser test (*The tests*).

## Stopping everything

Only the user's two slash commands stop the delegation, never words in a message:

- **`/workbench-quit`** runs `wb stop --all --park-waiting --repo <the session's directory> --session <id>…`
  (each id the session's process has had): this session's
  running agents stop, every task keeps its worktree for later, and Claude is told not to finish,
  restart or clean up anything unless asked. Each stopped task is `parked` (status), and so is
  each of the session's tasks already waiting on Claude (review, stuck, failed), as it stands,
  its news acknowledged (`--park-waiting`, `cli._park_waiting`: only the running ones were, and a
  review left at the quit stayed "awaiting review" and in every new conversation's pick-up
  block, #698): out of the status line's count, rewake, the boundary, the jobs' gate and `wb
  status` without `--all` (so out of a new conversation's open-tasks block), until something
  picks it up (#541; `spawn_runner` and `wb takeover` clear the mark).
- **`/workbench-quit-and-hand-back-claude`** runs `wb takeover --all --user` with the same scope and
  starts a turn for Claude
  to leave workbench mode, finish each task taken over itself to its own standard (`wb diff`, the acceptance
  command, `wb accept`), and carry on with the rest of the user's request without delegating.

`--session` and `--repo` keep them to this session's tasks (the mod's `mine`, *Waking Claude,
exactly once*):
another session keeps its agents running, and they are listed as left alone (the
2026-11-16 audit: one session's quit stopped and handed back the other's). If `wb` fails, the
command says so and no hand-back turn starts. Typed in a terminal without a scope, both still
take every task.

Both end workbench mode: Claude works directly again and the pane closes (`/workbench` turns the
mode back on, pane and all).

## The mod, inside

`mod/` is a Claude Code plugin: `mod/.claude-plugin/plugin.json` (name `workbench`, `types:
./types/index.d.ts`, one setting `userConfig.wake`, `on`|`off`, default `on`; changed with
`claude plugin configure workbench@workbench`, which reloads the module), `mod/hooks/hooks.json`
(`{"modules": ["./register.tsx"]}`), `mod/hooks/register.tsx` (everything), `mod/hooks/apprentice.ts`
(the character's art), `mod/hooks/register.test.tsx` (run by `claude plugin test mod`),
`mod/types/index.d.ts` (the atom types), `mod/.claude-plugin/icon.png` (the `work` pose).
The repo root's `.claude-plugin/marketplace.json` makes the repo a folder marketplace (`workbench`,
plugin source `./mod`), so the plugin id is `workbench@workbench` and it is read from the clone:
`wb update` (or, with no task running, `git pull`) plus a restart or `/reload-plugins` upgrades it. `mod/tsconfig.json` extends
`./.claude-plugin/types/tsconfig.json`, which Claude Code generates (gitignored, absent in a fresh
clone).

**The `$` rule.** `claude plugin validate` follows every use of the module's `$`; `$` may be
passed only to functions declared at the top level of `register.tsx` (a function declaration or a
const bound to one; imports from the module's own files also pass). The helpers type `$` as
`any`, so tsc doesn't check calls inside them; validate's listing (hooks, calls, env reads,
"gating hook without .catch" notes) is the check. Env reads must be string literals: `HOME`,
`WB_HOME`, `WB_BIN`, `CLAUDE_CONFIG_DIR`, `WB_COMPACT_AT`.

**State.** Nine `$.state` atoms survive a module reload within a session; each has a shape tag,
and an atom read under an old tag is absent, so change the tag when its type changes:
`tasks` (`tasks-8`, WbTask[]: name, phase, round, model, label, tests, last, createdAt,
updatedAt, tokens, recent, repo, cwd, subdir, session, claude_pid, claude_start, backlog, parked, allowed), `live` (`live-1`, {task, lines: {s, t}[]}: the transcript lines),
`chat` (`chat-4`, {key, delegating, url, web}: workbench mode lives here (and by session id in `$.store` `modes`, #689), plus the session's
listener key and the web chat's switch as last read), `pane` (`pane-1`, {tab, open, focus,
minimized}: the pane's tab, the open settings row, the option under the ring, the strip), `sessions` (`sessions-1`, string[]: every Claude Code session id this process
has had, `mem.ids` while loaded), `savings` (`savings-1`, string: the pane's saving line, '' for
none), `stats` (`stats-1`, {key, feed}: the Stats tab's `wb stats --json` and the stamp of the files
it was read from), `top` (`top-1`, {snap, busy}: `wb top --json`'s newest tick and each GPU's busy
% since the Stats tab opened), `said` (`said-1`, WbSaid | null, {notes, wakeOff, coding}: what the conversation was told of the
rules that depend on the state, #540; kept across a reload, #697: in `mem` a reload emptied it, prompt.context doesn't fire
again in that conversation, and `sayRules` waited for it for good, so wakes turned off mid-session were never said; a
conversation's first context block sets it again). Everything else is `mem`, a plain object reset by a reload (busy, queued turns,
this session's open set, the session's resolved `cwd` and `home`, `person`, follow, sawTurn, scoutAsked,
toasts sent, dropped wakes, the closed tasks no longer read, the events pid, `mem.said`, the `said` atom's copy, …). The task facts
themselves are re-read from `$WB_HOME`; the mod writes `tasks/<n>/acked`, scout.json's
`offered_at` and `chat/listener.json`.

**session.start.** Sets `mem.root` (`WB_HOME` or `~/.local/state/workbench`), `mem.wb` (`WB_BIN`
or `wb`), `mem.skill` (`$CLAUDE_CONFIG_DIR` or `~/.claude`, then `skills/workbench/SKILL.md`);
`WB_HOME`, `CLAUDE_CONFIG_DIR` and `WB_SAVINGS` (`mem.savingsFile`) read as wb reads them (`absolutePath`, `store.absolute_env`'s
rule: `~` expanded, relative to the session's directory, where the mod's `wb` calls run, `.`,
`..` and extra slashes dropped: settings.json's `env` passes them literally, and a `~` left the
pane empty and a trailing slash the Claude-coding guard off, #454), and `WB_BIN` too when it holds a
`/` or starts with `~` (a bare name still goes through PATH; `~/repos/workbench/bin/wb` ran a literal
`~` and the mod couldn't run wb at all, #699),
the chat key (`<start ms>-<6 base36>`, kept across reloads), `mem.cwd` and `mem.home` (the
session's directory and the home directory, resolved: which tasks without a `session` are this
session's, `mine`), `mem.ids` (the `sessions` atom plus `$.session.id()`), turns workbench mode back on when
`$.store`'s `modes` holds one of those ids (`modeKept`; `keepMode` writes `{<id>: <ms>}` for every id when the
mode turns on, and for a /clear's new id while it is on (a load that starts in the mode, after a
reload, keeps its ids and counts as delegating: a /clear's id after /workbench-update or
/reload-plugins was never kept, #840), drops this process's ids when it turns off, and
entries past MODES_KEEP_MS, 30 days: #689, `claude --continue` came back with the mode off, so the chat
didn't listen and a compaction dropped it, until Claude happened to run a delegating command; a
`wb adopt` that succeeds turns it on too, for a task still delegated (`delegatedWork`: running, or
waiting on Claude and neither parked nor `taken_over`): adopting the reviews /workbench-quit parked
or the hand-back took over turned the mode back on against them, #834; one taken over and handed
back to the agent is delegated again, `spawn_runner` clearing `taken_over`, #926), registers its `workbench-*` commands (*Commands*
below), runs `wb setup` once with a toast when the `/workbench` skill link is missing
but the old `skills/delegate` link is there (a copy updated across the 2026-11-17 rename), and, when a person can be at the session (`isInteractive`, or a surface), starts the ears
and two timers. A `claude -p` run or an SDK session (neither) stays quiet, no poll, no wake, no
`wb status` context, until `session.attach` (the desktop app attaching) starts them: such a run
took the terminal session's wakes and the weekly check (the 2026-11-16 audit).

**Ears and timers.** `ears` spawns `wb events` (cli.cmd_events: `{"hello": pid, "start": …, "parent": …, "parent_start": …, "machine": …}` first (the parent, its Claude Code process: `mem.claudePid`, whose tasks `claim` adopts, #687), then
`{"changed": [...]}` per batch; it skips tasks' `worktree/` and `rounds/`, closed tasks, `rules/`, `imports/`, `images/`, `audio/`,
the bench's clones and runs, links, `runner.log`, `*.lock`, `*.tmp` and dotfiles, and exits when its parent changes); every line runs `poll()`; when the child ends
it is respawned after 2 s. Until a child has said hello in this load (`mem.earsOk`: wb runs),
a failure toasts once (`can't run \`wb events\` (<why>)…: put wb on Claude Code's PATH or set
WB_BIN`) and the wait doubles up to a minute. A 1.5 s timer polls when there's no events child, a task is
queued/running/testing/asking, a turn is queued, or 30 s passed since the last poll (`SAFETY_MS`). A
450 ms timer animates the apprentice, blitting only changed frames. Each poll reads
`chat/switch.json` (`readSwitch`: off clears the link and `chat/away.json`); while the chat is on, every
10 minutes `wb chat url` refreshes the pinned link (`chatLink`; only a `…#token=…` URL is pinned;
the call creates the token file if missing). Subprocess limits: `wb` 120 s (`wb update` 600 s, the engine's most: its steps
take up to 300 s each), `wb watch` 30 s, `tail` 30 s, `kill -0` 5 s. `runWb` returns the exit
status with the output: a failing `wb` is said as a failure (`brief`, its last line), never
passed on as its answer. Files that only grow (notify.jsonl, the chat's messages and receipts,
a task's events.jsonl) are read by `readTail`: whole up to 1 MiB (events: 64 KiB), else their
last part through `tail -c`, from a whole line, since `$.fs.read` rejects a file over 4 MiB
(past that, no wake came again; the 2026-11-16 audit); one that can't be read toasts once.

**poll()** (re-entrant calls set `again` and run once more after): `scan` reads every
`tasks/*/status.json`, then `task.json` for the tasks shown (closed tasks drop out 30 min after
their last update, and an accepted or discarded one is then never read again in that load; open
ones get their last 4 event lines as `recent`, `recentEvents`: kept in `mem.recent` by
events.jsonl's size@mtime and read again only when that changes, since every poll spawned `tail`
for each open task's file past 64 KiB, unchanged since review: #739, the 2026-11-21 audit),
sorted by creation; sets the status line; opens
the pane once per load when one of the session's own tasks (any task, in workbench mode) is
queued/running/testing or workbench mode is on (an open the
user didn't ask for is placed only on a wide terminal; a pane the user closed stays closed for that
load); refreshes the live transcript while the pane is shown on its Tasks tab (the only one that
draws it: on Stats or Settings a running round was exported every 5 s for nothing, #838; `wb watch <task> --json --last
2000`, every 5 s (`LIVE_EVERY_MS`) while the followed task is active, its status writes in
between waiting for that (#691), at once when the followed task changes or stops; the focus, `focusOf`, sticks to the followed task while it is active,
else the newest started running one, then queued, else the newest waiting for Claude); submits
one queued turn when idle (one the engine drops goes back on the queue for a minute); detects a
task boundary and compacts; offers the weekly check; starts the update check beside it; then
`deliver`, `rewake`, `listen`.

**Busy.** `mem.busy` is set by `turn.start` (main loop) and by the model's own main-loop
`tool.call` (`next.origin.plugin === 'engine'`; a module reloaded mid-turn never saw
`turn.start`; a subagent's call doesn't count, nor another plugin's `$.tool.call` between turns,
which no `turn.complete` would clear), and cleared only by the main loop's `turn.complete`. Held
wakes are rechecked on every poll.

**Waking** (`deliver`). Only when notify.jsonl's size or mtime changed, Claude is busy, or a wake
was held for the turn; the file is stat'ed first and read only on a change, its rows kept in
`mem.notifyRows` by size@mtime for the polls of a busy turn (every poll read it whole, or spawned
`tail` past 1 MiB, before the check: #921). Per task, the newest notify row under an hour old and every question
row, past the task's `acked`; a row is still true when it's a check-in and the task is
queued/running/testing, a question while the phase is `asking` and (with an id) its
`ask/<id>.json` has no `<id>.answer`, or the phase equals the kind. A stale one is acked and dropped. A true one is
toasted once (`workbench: <name> <headline>`); a task that isn't this session's (`mine`: its
`session` is one of the process's ids, else by directory as above) gets nothing more; if Claude is busy a question is sent into the turn (`intoTurn`: `acked` first, put back if the engine
refuses, and the row's key kept in `mem.heldAsks`), and anything else waits and leaves the file unseen; a held question gone stale whose
`<id>.answer` opens with ask_mcp's NO_ANSWER, its task still open, gets the MISSED_NOTE wake; else the mod writes `acked
= row.ts` and submits (`wake`) `[workbench] Task \`<n>\` <headline>.\n\n<row.text>\n\n<NEXT[kind]>`
(and `\n\n<AWAY_NOTE>` while the user is away on the web chat, as every wake and `intoTurn` text, #540)
(HEADLINE and NEXT are the per-kind texts at the top of register.tsx; NEXT names the commands to
run: a question's `wb answer <n> --id <id>`, and a PERMISSION request is answered by the `wb
allow` it names). A submit the engine drops (`{drop}`) puts `acked` back if it still holds the
value written, records `mem.dropped`, and toasts once. With the `wake` setting off it is only
toasted: `acked` isn't written, so `wb wait` still gets it. `deliver` remembers each task's
newest notice ts in notify.jsonl's tail, however old (`mem.noticed`), a batch's for each task it
names (`tasks`: acknowledged with it, they have no notice of their own, and rewake woke for them). `rewake`: when idle, with
wake on, a task of this session's waiting on
Claude (review/asking/stuck/failed) whose status changed between 60 s (`REWAKE_MS`) and 12 h
(`REWAKE_MAX_MS`) ago, whose news Claude hasn't had and whose wake wasn't dropped in the last
minute gets `acked = now` and a prompt saying no
notice reached Claude, with `wb report <n>` and NEXT. Had the news: `acked` is at or past the
newest notice, the later of `mem.noticed` and the task's `noticed` file (the runner's last status write, clearing its pid, lands just after
its notice, so `updated_at` alone woke Claude twice; a notice pushed out of the tail by 1 MiB of
later ones did the same after a reload, #844), else, with neither, `acked` is past `updated_at`. `cli._ack_all` stops the mark short of news still
true. Wake prompts are submitted as the plugin, not `asUser`. The state directory is global and
the mod runs in every session with the plugin, so each acts only on its own tasks (the
2026-11-16 audit: two projects at once, each session was woken for the other's); among the
sessions a task belongs to, the first to deliver a notice wins (the `acked` write is not locked).

**Workbench mode** (`workbenchMode(on)`, `chat.delegating`). On: the `workbench` skill's prompt
(`skill.prompt`, which also records its path and opens the pane through `showPane`; run again
while the mode is on and with no task, which `firstTask` reads from the expanded skill's
"**First task:** \`…\`" line, it returns AGAIN_NOTE in place of the skill: the pane is back,
reply in one line), or a Bash tool call that runs `wb start|next|feedback|steer|answer|resume`
(`delegates`, checked before it runs; a resumed session or a /workbench the mod missed; not
`accept` or `takeover`, which a done note after a quit asks for). Only a command counts, not
text (#409, 2026-11-20: a Python patch's string holding "(wb next)" turned a session's mode on),
and the line is read as bash reads it (`simpleCommands`, #560: the text matcher before it missed
a quoted path, `if`/`while`/`!`, a `$(…)` in double quotes, `timeout`/`nice`/`stdbuf`, anything
after a `<<<`, and `wb resume`, and split `echo foo \; wb start` in two): a backslash or quotes
are undone within a word (`"…/bin/wb" start` is `wb`; `\;` is a `;` in a word), comments and
heredoc bodies are dropped (an unquoted heredoc's `$(…)` and backticks still run, as do those in
double quotes), a `<<<` here-string's word is a word; the simple commands split at `;`, `&`, `|`,
newlines, `(`, `)`, `$(` and backticks; the command word, past `VAR=x`, the reserved words (`if`,
`then`, `elif`, `else`, `while`, `until`, `do`, `!`, `{`) and the wrappers with their options
(`PREFIXES`: `env`, `time`, `nohup`, `exec`, `command`, `timeout` and its duration, `nice`,
`ionice`, `stdbuf`), must be `wb` or a path ending in `/wb`. It is syntactic: `true || wb
steer` counts.
Off:
either quit command, which also closes the pane. While on: the `workbench-mode` and `user-notes`
context blocks (and `claude-coding` outside "Let Claude decide", with a task open too), the idle status line, pane auto-open, web chat listening, the apprentice's
"Workbench mode is on.", the boundary compaction. `mem.delegated` remembers the mode was on in
this load, so a hand-back's compaction still keeps the state. No `$.ui.invalidate`: rewriting
the first message would cost the conversation's prompt cache, and an unrouted block isn't added
after the first message anyway: *The rules said later* below.

**Commands.** Every one is `/workbench` (the skill) or starts with `workbench-`, so typing
`/workbench` lists them all (2026-11-17: they were `/delegate` and `/delegate-*`, no alias; the
pane's own command went, as `/workbench` run again brings the pane back). `showPane` closes a
pane the engine still holds but doesn't show (a tab behind another, or undrawn) first, so it
comes back. `/workbench-quit`:
workbench mode off, `wb stop --all` with `scope()` (`--repo <mem.cwd> --session <id>…`), a toast, and hidden context (QUIT_NOTE:
don't finish, restart or clean up anything unless asked; tasks left alone are another session's;
or, when wb failed, that the agents may still run); it starts no turn.
`/workbench-quit-and-hand-back-claude`:
mode off, `wb takeover --all --user` with `scope()`, and DONE_NOTE queued as a turn (leave workbench
mode; per task taken over `wb
diff`, finish in its worktree, run the acceptance command, `wb accept` (`--merge` only if asked);
leave the tasks left alone; carry on without delegating), whenever the output has a `took over`
line, even when wb exited non-zero over a refused task (a toast says some weren't taken, and the
note carries the refusals: #918); when none was taken over, no turn, and it says so. `/workbench-models` records the check as raised (scout.json `offered_at`, `scoutAsked`: the
weekly check came straight after it) and queues SCOUT_NOTE now. `/workbench-update` runs
`wb update` and, when it updated, `/reload-plugins` (`$.command.run`; if that throws, it says to
run it; when wb failed, that /reload-plugins picks up whatever it got as far as). A command can't start a
turn itself: it pushes onto `mem.queued`, which the next idle poll submits. `/workbench` is the
skill, not a mod command.

**Context blocks** (`prompt.context`, appended in this order; Claude Code computes them at the
conversation's first message and after a compaction or `/clear`, not every turn):
`workbench-mode` while delegating (MODE_NOTE: the mode lasts until a quit, follow the skill,
every plan is a handoff plan, the SKILL.md path); `user-notes` while delegating and notes.md has
notes; `web-chat` for six hours after a web message (longer while a backlog task of this
session's is open: `awayNow`), until a prompt is typed in the terminal
(AWAY_NOTE: reply with `wb chat reply`, `wb chat log` shows the thread; each wake says it too
while away, below); `workbench-wake` with the `wake`
setting off, while delegating or with a task of this session's open (WAKE_OFF_NOTE: no wake will
come; tell the user, pick it up when asked); `workbench` whenever `wb status` with `scope()`
exits 0 listing open tasks (the status, plus `wb report`/`wb watch`; a failing one toasts once
instead). None in a session with no person at it.

**The rules said later** (#540). Claude Code computes those blocks once, and one it doesn't route
can't be added afterwards, so a session that entered workbench mode after its first message (the
usual way in) got no notes and no wake-off note, and a Claude coding change in the pane reached
only the file gates. `mem.said` records what the conversation was told of the three rules that
depend on the state (`Said`: the notes, the wake-off note, the coding mode; set by
`prompt.context`, null before one in this load); `unsaid` returns what it lacks now and counts it
said: the notes once (Claude edits them itself), the wake-off note once, the coding rule
whenever the mode differs (CODING_DECIDE when it went back to "Let Claude decide": the earlier
rule no longer applies). `/workbench` appends them to the skill's text (or to AGAIN_NOTE) and sets
`mem.skillTurn`, so a `prompt.context` computed after it in the same turn (/workbench as the
first message) leaves those blocks out; a compaction or the turn's end clears it. Every poll
runs `sayRules`: what is still unsaid (the mode turned on by a Bash `wb start`, the pane's
coding row, `wb coding` anywhere) goes in as a user-role row the model reads
(`$.session.append`, which starts no turn), or, refused, as a queued `[workbench]` turn. Being
away comes and goes with the web chat, so it isn't one of them: `wake` and `intoTurn` end
their text with AWAY_NOTE while `away()` holds (`awayToo`), and a wake after the user typed in
the terminal again doesn't (the web-chat block alone left a user who went to the web chat after
the first message unseen: a task's news was written for the terminal they had left).

**Compaction.** `session.compact` (main conversation only, while a task of this session's is
open, in a session delegating or that delegated in this load) appends
KEEP_ON_COMPACT: keep the user's goals and decisions, the tasks and what each needs next, what
was accepted, merged or discarded; drop finished tasks' diffs, reports and transcripts. At a task
boundary in workbench mode (a task in the last poll's open set of this session's tasks is gone,
Claude idle, none of them waiting for Claude) it compacts once usage reaches `WB_COMPACT_AT`% (default `COMPACT_AT` 0.5; 0 off) of the
auto-compact threshold (or the window when auto-compact is off).

**Status line and pane.** Status: `⚒ wb · <name> <phase> r<round>` for queued/running/testing,
`<name> asks`, `<N> awaiting review` (review + stuck + failed, not a parked one: `waitsOnClaude`, #541; asking and waiting this session's only, `mine`, in workbench mode too: another's reviews were counted as this one's, #693), joined by ` · `; `⚒ wb ·
workbench mode` with nothing listed. Pane: one row per task (a mark per phase: spinner running, ◌
queued, ◐ testing, ? asking, ◆ review, ▲ stuck, ✗ failed, ✓ accepted, – discarded; name, phase,
round, label or model, tests, age since creation, or "ago" once closed), its recent lines; then
the followed task's transcript (its newest lines, each cut to `LINE_CHARS` 2000 first, oldest at the top, within `HISTORY_CHARS` 60,000: Claude Code drops pane
text past 100,000 characters, which once left the bubble empty), scrolling with the newest lines
unless the user scrolled up (`ui.scroll`); then the stage (the apprentice with a speech bubble,
pixels on a terminal at least 20 rows by 40 columns, else its one-line face; text wrapped by
`wrapWords` because Text's own wrapping beside the raster drew empty rows); the saving and the
tabs last. The Stats tab, the Settings tab and the minimized strip (`AbovePrompt`)
are under *Seeing what the agent does*.

**The apprentice** (`apprentice.ts`): 16×12 pixel art as letters, drawn with half blocks
(▀/▄) into a `Raster` (cells encoded as little-endian u32 triplets, base64); a pose per state
(rest, blink, think, work, swing, tada, ask, slump, sleep), the chest lamp `L` one colour per pose
(orange while working, green tada, amber ask, red slump, slate sleep); `work` swings the wrench one
frame in six, other poses blink one in eleven, except `sleep` and `slump`; FACE has the one-line faces (`[•_•]⚒`, `\[^_^]/`,
…). The bubble says what the agent is doing (`speechOf`) in the phase's colour.

**The web chat listener** (`listen`, workbench mode with the chat on, needs the events child): another
session's live claim (its pid lives, `/proc/<pid>` on Linux, else `kill -0`, and, with a `start`, still started then: `alive`,
which reads `/proc/<pid>/stat` or `ps -o lstart=` as wb does (in UTC, then the inherited zone: #848) and compares only two of a kind; when
neither can say, while listener.json was written within 15 s, #700: read as gone, two sessions took
it from each other on every poll; without a pid, its `ts` within 15 s; asked only of another
session's claim, and a live one at most every PID_CHECK_MS, 30 s, `mem.listenerAt`: on macOS each
ask is a `kill` and a `ps`, run on every poll even for the session's own claim, #839; a claim
whose `machine` is another one's always lives, as its pid can't be asked here: each machine took
the listener from the other, #922; a crashed one there stands until a session on that machine
or a quit clears it) makes this one stand by; otherwise it writes `chat/listener.json`
`{session, cwd, pid, start, machine, busy}` when that changes, and
delivers each user message without a receipt, once `wb chat claim <id> --by <key>` gives it the
message (refused: another session's, looked at again a minute later; two sessions starting
together both took the chat and both submitted it, #84): idle → `prompt.submit('[web chat] <words>', asUser)`
(each attached file a line after the words, `attachedLines`: `[attached: <path> (<size>, <type>)]`),
receipt `how=now`; busy → `session.send` into the running turn with WEB_NOTE, else a queued
prompt (`how=queued`); `wb chat ack <id> --by <key> --how …` once it entered (a dropped prompt
gets no receipt and is tried again a minute later); a queued one is acked again `how=now` when
that turn ends (`mem.chatQueued`, `readQueued`: by then Claude has it, at the turn's next step or
as the next turn; the page said "Queued for Claude" for good, 2026-11-21), `chat/away.json`
`{at: now, by: <key>}`, a toast. Away is the user's (#688: `away()` reads that file, so every
session in workbench mode relays its dialogs and ends its wakes with AWAY_NOTE, not only the
listener; kept in the listener's own state, another session's overnight backlog left its dialogs in
the empty terminal, #110 again); a prompt typed in any session writes `{at: 0}` (`back`). Typed
is the engine's `origin.kind` (`byUser`): `composer`, `bridge`, `sdk`, `auto-continuation`, or an
`unclassified` or unstamped one not `isMeta`; a /loop or scheduled firing, another plugin's
prompt, an MCP channel's or a peer session's message ended away for every session and cancelled
the follow-up below (#835).
Each message passed to Claude is owed a reply in the chat (`mem.chatOwed`, `owedAtTurnEnd`, #767:
for two release cycles the owner's "Status" from the phone was answered in the terminal only, and
the phone heard nothing): a `wb chat reply`/`listen` or `wb shot … --chat` in Bash, a row `from:
claude` in messages.jsonl since, or a prompt typed in the terminal settles it; at the end of the
main turn that had it (one queued behind a running turn may enter only the next: `grace` 1; so
may one submitted while idle behind a prompt the mod submitted in that poll whose turn hasn't
started, a wake, a queued turn or another web message: `mem.submitted`, cleared at each main turn's
start, #837, the wake's turn ending sent the follow-up for a message Claude then answered) with
no reply, one follow-up turn is queued (OWED_NOTE: answer there with `wb chat reply`; taken back
out of `mem.queued`, and skipped by `sendQueued`, once no nudged message is owed: a reply or the
user's return before it went left it queued, and it went anyway, #837); that turn
ending without one too, `wb chat reply --text="Claude answered in the terminal; nothing was sent
here."` (OWED_POSTED) goes to the chat, once per message. Dialogs
(`classic.PermissionRequest`; the terminal shows its dialog meanwhile, and the hook's answer
settles it): unless a settings hook already decided, or the session isn't delegating with
`chat/away.json`'s `at` within AWAY_MS (6 h; a prompt typed in any session's terminal sets it to 0) or this session with a
backlog task open (`awayNow`), `askOnChat` runs `wb
chat ask --tool=<t> --kind=<KIND[tool], else permission> --text=<a permission's: the input's
command, file_path, url, path or pattern, else its JSON, cut at 1500>` (each `--opt=value`, so a
value starting with `-` isn't read as a flag; `--pid=<mem.eventsPid>`, so wb expires the ask once
this session is gone, #538; `--detail=` with a question's `{questions}`, each
option's `preview` cut to PREVIEW_CHARS 2000 with CUT_NOTE (`askQuestions`); a plan's `{plan}`, its
first DETAIL_CHARS 40,001, when the input has its text, else `{plan_file}` from
its `planFilePath`, and for a plan `--session <id> --repo <the session's directory>`, so wb reads
this session's own plan, #253). When `wb chat ask` fails, the mod posts `Claude is waiting on a
plan|question|permission in the terminal` (`wb chat reply`), toasts why, and leaves the dialog: a
refused plan sat in the terminal with the phone told nothing (#535). It prints `<id> <state>`:
`allow` (the user's setting) answers `{behavior: 'allow'}` at once; `expired` (a plan wb couldn't
read) leaves the dialog to the terminal at once; else the id goes in
`mem.asksOpen`, a toast says what waits in the web chat, and `waitOnChat` runs `wb chat wait <id>
--timeout 20 --json` (ASK_CHUNK_S) again and again, so an interrupt (`next.signal`) is seen
within 20 s, until ASK_WAIT_MS (30 min). An answer `allow` is `{behavior: 'allow'}`, for a
question with `updatedInput: {...input, answers}`; `deny` is `{behavior: 'deny', message}` with
the note: a plan's says revise and present it again, a question's and a permission's say ask the
user there (`wb chat reply`). Anything else (the time up, an interrupt, `wb` failing) writes `wb
chat answer <id> expired --by timeout|interrupted` and passes the event on, so the dialog stays.
An interrupt (Esc) drops a waiting hook outright, so its own expiry never runs (seen live,
2026-11-18): `turn.complete` expires every id left in `mem.asksOpen`, by `interrupted`. A hook
that fails is skipped, which also leaves the dialog.
The messages come from `open.json` (the tails of messages.jsonl and receipts.jsonl only for a
`wb` from before it: #329). A web message wb calls expired (`wb chat claim` refuses it: unread past
`chat.MESSAGE_EXPIRE`, 6 h) isn't submitted or asked about again this load (`mem.chatExpired`);
a toast says so once, and that the page offers to send it again (#536). The refusal retired it from
`open.json`, so a later load never sees it (#741). Quitting stops delivery and, when
this session holds listener.json, writes it empty, so the page and other sessions see nobody
listening at once.

**The weekly model check** (`scoutIfDue`): in a session that delegates (workbench mode on, or
on in this load: `mem.delegated`) with wakes on (the plugin runs in every session: one for another
project got the check, spent the day's offer, and the `wake` setting didn't stop it, #919; such a
session leaves scout.json alone, so the check stays due for the next one), once `wb events` has said hello (wb runs), Claude idle
a minute after a main-loop turn (`SCOUT_QUIET_MS`: raised the moment a turn ended, it buried
Claude's question to the user), quiet (`quietForJobs`: no task anywhere active, and none of this
session's waiting on Claude (`waitsOnClaude`: not a parked one) within `REWAKE_MAX_MS`; any open task at any age once gated it, so
one stuck task left by a quit stopped the check for good, #541), once per
load: when scout.json's `done_at` is 7+ days old and `offered_at` 1+ day old, it writes
`offered_at` and submits SCOUT_NOTE (`wb scout`, research, recommend keep/add/retire, change
nothing without a yes; the audio and image engines too, each model's licence checked against
its text today and its `notes` kept true, #398; then `wb scout --done --notes`).

**The weekly update check**: after the first main-loop turn of a load once wb runs, once, beside
the poll rather than in it (a stalled fetch held every wake), `wb update --check
--if-due` (wb asks origin at most weekly and in between counts locally against the last fetch,
falling back to `update.json`); an `update
available` answer becomes a toast naming `/workbench-update`. So a pending update is mentioned once
per session until it's installed.

**Tests** (`register.test.tsx`, an in-memory filesystem and a fake `wb events`): the empty pane,
`/workbench` run again (the pane back, AGAIN_NOTE; with a task, the skill), the old `delegate`
link running `wb setup`, a wake held mid-turn and delivered once (and a stale one dropped), the transcript
and pinned link, both quit commands (typed words stop nothing), KEEP_ON_COMPACT and the boundary
compaction, the live header label, the weekly check, the chat listener (exact text, receipt,
standing by, stopping after a quit), dialogs on the chat (only while away, allow and deny with
a note, a plan sent back, a question's answers, the go-ahead setting, an expiry, back in the
terminal, one wb refuses posted to the phone, a long plan or preview cut), Bash `wb start` turning the mode on and mid-turn delivery,
rewake, Raster vs face, `/workbench` alone, the update check and `/workbench-update`, `wrapWords`;
and the 2026-11-16 audit's: another project's task neither woken nor acked, a headless session
quiet until a surface attaches, a dropped wake retried, no false rewake for a notice delivered
before, two wakes due in one turn, two open questions, another plugin's tool call, the update
check beside the wakes, a notify.jsonl read by its tail, the pane read only while shown,
the Stats tab read only while shown and again when a task closes, `wb top` run only while the
Stats tab is on screen with Live view on and ended when left, its settings rows and the typed
price, a history that says nothing it has no data for, a sticky
focus, a cut transcript, a long line clipped, `/workbench-models` once, wb missing (one toast, a
backoff, no model check), wb failing (no open-tasks block, quit says so), no compaction without
delegating, wake off told, closed tasks not re-read. Not covered: check-in wakes, the one-hour
cutoff, scrolling, `WB_COMPACT_AT`.

**Troubleshooting.** If `wb` isn't on Claude Code's PATH, or fails, the mod toasts once (`can't
run \`wb events\``, `wb status failed`) and keeps running from the task files (the ears respawn,
backing off to a minute; the `workbench` context block is left out): set `WB_BIN`. That moves only
the mod's own calls: Claude's Bash runs `wb` by name, so it still has to be on PATH (`wb doctor`
says). `claude plugin validate mod`
lists the hooks, calls and env reads; `claude --debug` shows hook errors.

## Waiting without polling

`workbench/watch.py`. Anything that waits for a file or a process sleeps in the kernel.

- **`Watcher(*dirs, recursive=False, skip=())`**: inotify through ctypes (`inotify_init1`,
  `inotify_add_watch`, from `CDLL(None)`, the process's own symbols, so musl works too) on directories, for modify, attribute changes, close-write, create, delete and moves; a queue
  overflow or a directory that went away reports every watched directory as changed rather than
  losing the news; recursive, an overflow first walks every root again (`add(root, again=True)`),
  so a directory made while events were lost is watched and reported too (a task made in a burst
  was seen only by the mod's 30 s safety poll, #472, the audit of 1.8). `recursive` adds new subdirectories as they appear, never through a link (a
  task's `--sibling` link took 251 of 256 watches into the sibling: #439), and leaves out one it
  can't list (mode 000, removed mid-scan: that killed `wb events` at every respawn, #439); `skip`
  leaves out directories by pattern, matched against the path below the root (`tasks/*/worktree`).
  `wait(timeout, settle=0.02)` returns the changed paths (raw: duplicates, temp and lock files
  included), sleeping 20 ms after a wake to gather a burst. A directory inotify can't watch (past
  `max_user_watches`) is polled instead (one it may not read, or gone, is left out): its entries are stat'ed every 0.25 s
  (`POLL_S`). With no inotify at all (macOS, or `inotify_init1` failing) `wait` returns within a
  second whatever the timeout, so every caller loops and re-checks its condition. Callers use
  `wait()`, not the file descriptor, so the polling fallback works; the chat `Hub`, which selects
  on the descriptor beside a pidfd, switches to `wait()` when any directory is polled.
- **`wait_exit(pid, timeout)`**: `pidfd_open` and `select`; without pidfd (macOS, kernels before
  5.3) `kill(pid, 0)` every 0.1 s.
- Writers help: `store.write_json` writes a dot-temp file and renames it, `read_jsonl` stops at the
  last newline (a half-written row waits for the next read), `append_jsonl` holds a lock file.

Every waiter and its bounded wake (a timeout to re-check what the kernel can't signal):

| Caller | Waits on | Re-checks every |
|---|---|---|
| `wb events` | `$WB_HOME`, recursive, skipping `tasks/*/worktree`, `tasks/*/tree`, `tasks/*/rounds`, `rules`, `imports`, `images`, `audio`, `archive`, `chat/audio` (the takes `wb chat listen` copied, #397), the scratch clones and indexes (`SCRATCH`: `.?*`, `wb-index-*`, `wb-merge-*`, neither watched nor reported: one with a copied node_modules took it from 2 watches to 605, each write waking the mod, #373), the bench's (`bench/.?*`: `wb bench add`'s `.base-`/`.check-` clones; `bench/runs`: a run's replays; 1,209 of 1,211 watches were there, #439), `chat/uploads` and `bench/cases` (an upload's directory each, a case's hidden tests: nothing the mod acts on, and an upload's rename woke it for nothing, #842) and the tasks already closed when it starts (`EVENT_SKIP`) | 10 s (exits when its parent changes); every minute it reaps dead runners |
| `wb wait` | the state directory and the named task's directory | 60 s (a dead runner: `reap`) |
| `wb log -f` | the task directory | 30 s |
| `wb watch` | the task directory | 1.5 s on a terminal while the task is live, 30 s otherwise; the session exported again only on a change or every 30 s while live (#555) |
| the runner's steer bell | the task directory (`steer.jsonl`) and `ask/` | 5 s, while OpenCode runs |
| `ask_reviewer` | `ask/` | 30 s (`STEP_SECS`), until the ask timeout |
| the chat `Hub` | `chat/` and the listener's pidfd (without inotify: `kill 0` each second) | 60 s |
| `wb stop` / `takeover` | `wait_exit(pid, 15)` | |
| `wb top` | `select` on its nvidia-smi stream and, on a terminal, the keys | each tick (`--every`), when it also checks its parent |

`wb events` prints `{"hello": <its pid>, "start": <its start>, "parent": <its parent's pid>, "parent_start": …, "machine": <store.machine()>}` (the mod's chat listener identity, and its Claude Code process: #687; the machine, #922), then `{"changed":
[paths relative to $WB_HOME]}` for each batch of changes, dropping names
ending `.lock`, `.tmp`, `runner.log` and dotfiles; it creates `tasks/` and `chat/`, and exits on a
broken pipe or when its parent process changes.

## Every `wb` command

`workbench/cli.py` is argparse: `main()` builds one subparser per command with
`set_defaults(f=cmd_<name>)` and dispatches `a.f(a)`; a new command is a parser block plus a
`cmd_*` function. `die(msg, code=1)` prints `wb: <msg>` on stderr. Exit codes: 1 an error; 2 a
usage error, or `wait` on a closed task, with no open task, or a timeout; 3 no model can run
(`start`); 4 the GPU is held by a task the new one can't run beside (`start` without `--queue`);
`scout --due` 0 when due, 1 when not; `doctor` 0/1. cli writes notify.jsonl only in `reap` (its
died notice and a restart's batch, `_restart_notice`) and in `wb update --stop` (`_stop_for_update`:
one `stuck` notice per owner, cause `update`, with `tasks`); the runner writes the rest (#882). `wb --version` prints the version
(`workbench.__version__`).

**Acknowledging.** `_ack_all(task)` moves the task's `acked` mark: if an unacked notice of the
kind its phase stands for exists (`question` while `asking`, `checkin` while queued, running or
testing, else the phase name), the mark stops
just before the oldest such notice, so news Claude hasn't seen stays deliverable; otherwise it
moves to now; it never moves back (after a `wb note` seven seconds after a failure swallowed the
failure notice for an hour). It reads and writes under the task's `ack` lock, the one
`claim_ack` takes, and writes only a higher mark: unlocked, a `wb ack` of a question landing
between its read and its write was written over with a lower mark, and the question was
delivered twice (#786). It's called by feedback, next, answer, allow, note, resume,
takeover, accept, discard and stop (one task or `--all`); not by steer, `skill hand|take`, diff,
report or log. `_ack_all(task, upto=t)` moves the mark to `t` instead, the moment the command
acted: answer, allow when it answers a request, feedback, next and resume, which handle the news
themselves; while the task is asking, that mark too stops just before the notice of any other
question still open (`ask_mcp.is_open`). Errors `wb` raises itself (`RuntimeError`, a config that doesn't parse) print as a
message, not a traceback, and so does a file that can't be read (`OSError`: a `--spec`,
`--message` or `--file` that isn't there prints `wb: <path>: No such file or directory`).
`feedback`, `next` and `resume` act on a task one at a time (`one_at_a_time`, *Git, commits and
projects*: a second waits, then finds the task queued and is refused), refuse a task whose
worktree is gone (`_need_worktree`: "its committed work is on branch …; wb discard <task>
--keep-branch drops the task and keeps the branch"), and mark notes the last runner never
delivered as taken (`_stale_notes`, *Notes*).

### Running tasks
| Command | Flags (defaults) | What it does |
|---|---|---|
| `wb start <task> --spec <file\|->` | `--repo` (.), `--size trivial\|significant` (significant), `--model <id or fragment>`, `--test <cmd>` (granted to the agent's shell too: `context.test_allowances`, #514), `--auto-fix N` (2), `--self-review`/`--no-self-review` (default: the learned `self_review` knob), `--checkin MIN` (0: off), `--ask-budget N` (2), `--ask-timeout S` (1200), `--round-timeout S`, `--silence-timeout S`, `--think-timeout S` (0 off; unset or 0 for the other two: the measured budgets), `--test-timeout S` (900), `--unload-for-tests` (every model on this GPU let go before each test run, the task's own too, only `keep_loaded` kept: an Ollama or LM Studio model unloaded, a server with a models.json `stop` stopped, each loaded or started again by the next round's load, for tests that need the GPU, the base check, `wb verify` and `wb shot` with the GPU alone, `verify.gpu`, GPU held from other tasks while they run (#428), a task already sharing it waited out first and this machine's GPU taken for a remote model's tests too (#943), and the GPU's device nodes in the lane, `context.gpu_nodes`: task.json `unload_for_tests`), `--no-sign` (the task's commits unsigned, whatever `commit.gpgsign` says: task.json `sign: false`; without it, a key that can't sign unattended is said at start, `gitops.sign_problem`, and a signer that asks for a touch each time is named instead of tried, `gitops.presence_signer`), `--no-base-check`, `--base REF` (HEAD), `--skill NAME…`, `--allow PATTERN…`, `--allow-path DIR…`, `--setup CMD`, `--setup-timeout S` (1800; task.json `setup_timeout`, also commands.json `repos`: the setup's limit, in the worktree and each scratch checkout), `--copy PATH…`, `--sibling PATH…` (`lib` or `../lib` beside the repo, `../../shared/lib` further up: *Setting the worktree up*; with commands.json `repos`), `--force` (queue a `--model` that can't run now; the hint is offered only when its server is just down), `--queue` (start although the GPU's holders leave no room: wait behind them), `--trial`, `--backlog NAME` (one of a batch left to run: task.json `backlog`, same name rules; an earlier batch's name, every task of it closed and the newest started `BACKLOG_GAP` (6 h) ago or more, is refused with a fresh dated one, `--backlog <name>-YYYY-MM-DD` (`cli._backlog_done`): reused, the morning's `wb backlog` merged both nights and their savings, and on WSL2 the second night's first task never said nothing keeps Windows awake, #880), `--no-claude-md` | Checks the name (`^[a-z0-9][a-z0-9-]{0,47}\Z`, never reused), the spec's encoding (`cli.read_text`: strict UTF-8 from the file or stdin's bytes, "<file>: the spec isn't UTF-8 (byte N)", as for `wb feedback --message` and `wb next --spec`; a Latin-1 file was a traceback, and piped from a C-locale shell, stdin's surrogateescape, it passed every check and died writing prompt.md, leaving a task with no status, #873), the repo (with the lane on, neither commands.json `"paths": ["*"]` nor `--allow-path '*'` turning it off, `_lane_fits` refuses one that is the home directory or lies where credentials live, and a `--test` whose command is a snap), the spec and the skills, and that opencode is on PATH and not 1.x (exit 3 before anything is written, with `runner.OPENCODE_GET`: 1.x has no `run --standalone --auto` nor the layer's shape, and every round died as "opencode exited 1" after the GPU was emptied, #654); picks the model (router, or `--model`; none runnable: exit 3, with each model's next step); refuses a repo that is a task's worktree, a `--base` that names no commit (`no commit <base> in <repo>`; a repo with no commits at all says so, with `wb init` as a way to the first: #476) and a repo with no git identity; checks `CLAUDE.md` or `.claude/CLAUDE.md` is committed at the base (or CLAUDE.md gitignored: the checkout's copy; or in the `--repo` directory below the top, or the nearest one above it, committed or gitignored in the checkout: a monorepo package, task.json `subdir`, `package: …` printed, #375, #606, #785); checks the worktree setup (`_worktree_setup`: a `--copy` path inside the repo, there, ignored in the checkout, with nothing under it tracked at the task's base or in the checkout's index (#244: a tag as `--base` tracked `generated/config`, and the local copy went over it into the commit), ignored at the task's base as well, checked in the new worktree by the runner, which fails the task (#322, #529), and no `SECRET_FILES` name; a `--sibling` a directory beside the repo or further up, by a path without `.` or `..` inside it, not one of `context.TASK_FILES` beside a flat worktree, not refused by `lane_refusal`, not holding the repo, its link inside no other's or the worktree's; #261); puts the worktree there, nested under `tree/` for a sibling more than one level up; refuses a state directory on a noexec mount (`store.noexec`, *A noexec state directory*: #851) and a task the disk has no room for (`cli._disk_room`, *A full disk*: #342); refuses when another task (or `wb image`) holds the GPU and the model can't run beside it (exit 4, naming each holder's task, repo and model; `--queue` overrides); writes `starting.json` (repo, worktree, its pid and start; removed once task.json is written; one from a start before #529, which made the branch itself, may hold `branch` and `branch_at`, the branch that start made and the commit it made it at, the only branch its cleanup deletes, #416), so a start killed before task.json is undone by the next start of that name, when its pid is gone, or by `wb gc` (#376); refuses a branch `delegate/<task>` that exists, or a branch `delegate` or one under `delegate/<task>/` (`gitops.branch_clash`, #792), or a base whose paths differ only by case when the state directory folds case (`gitops.case_clash`: put WB_HOME on a case-sensitive volume, #797); leaves the worktree and branch to the runner, which makes them first (`runner.checkout`: status `branch_made`, the base it makes the branch at, recorded before `worktree add` when no such branch exists, so a cleanup of a checkout cut short, `wb discard` or a rerun, deletes the branch only through `delete_branch(at=)`, #416; no checkout hook, a failed add leaves nothing; #529: made here, a big checkout passed Claude's two-minute Bash limit) and fills each submodule from the user's own checkout of it at the commit the base records (`gitops.fill_submodules`: a scratch index and `checkout-index`, no `.git` for the agent to repoint, the files read-only since the gitlink keeps an edit there out of the diff and the commit, each one recorded for `submodule_edits` (#419); the scratch checkouts get the same, `verify._run`; empty, a C/C++ or vendored build failed on the base and in every round: #350), a submodule's own submodules too, from the user's checkout of each inside it (#383), their paths read from the base's `.gitmodules` NUL-terminated (`gitops.submodules`: split at a space, `submodule.my lib.path` was never filled, #791); `wb start` notes the ones the checkout lacks, by their whole path (`fill_submodules(dry=True)`, which writes and records nothing); says what the setup will do (`setup: …`), or, with none and no commands.json `repos` entry, notes the checkout's ignored directories (`_missing_dirs`, not `CACHE_DIRS`) the worktree lacks: those at the top, directly in the package (`subdir`) and any `INSTALL_DIRS` (`node_modules`, `.venv`, `venv`, `target`, `vendor`) deeper, named from the package (`../../web/node_modules/`; only the top level was looked at, so a monorepo's per-package installs got no note, #877); notes a home directory inside a temp root, with the lane on (`context.home_gap`); notes a mise config in the repo that mise doesn't trust (`context.mise_trusted` False: its shims fail in every copy, #674); notes each proxy variable the agent's environment leaves out (`runner.dropped_proxies`: a `*_proxy` holding a password, with the commands.json `env` that passes it through, `proxy_line`; #380); notes a repo on a Windows drive (`context.on_windows`: git is many times slower there; finding 30); on WSL2 without interop or powershell.exe, for a `--backlog` batch's first task, notes that nothing keeps Windows awake (`cli.WSL_SLEEPS`, *Kept awake*, #516, #777); notes a fixed prompt of `FIXED_SHARE` (40%) of the model's window or more (`context.fixed_prompt`: `OPENCODE_BASE_TOKENS` 3500 for OpenCode's own prompt and the tools left, plus the instruction files and their imports, AGENTS.md and round 1's prompt at `CHARS_PER_TOKEN` 4; the line names the three largest parts; finding 27: a 25 KB CLAUDE.md on a 32K window started the agent near its handover point) and an OpenCode outside `runner.OPENCODE_TESTED` (2.3 up to 3.0: `runner.untested`; finding 26); writes task.json (with `session` when `CLAUDE_CODE_SESSION_ID` is set and `claude_pid` when `CLAUDE_PID` is: Claude Code's Bash exports both) after round 1's prompt (spec + PROTOCOL; written first, so a write that fails leaves a dead start for gc, not a task with no status), then status; spawns the runner and returns at once. Prints the model and why, the slice, Claude's spec record, the handed or suggested skills, notes, `next: wb wait <task>`. With `--test` (and not `--no-base-check`, task.json `no_base_check`) the runner first runs the acceptance command once on the base (*The base check*: at most `BASE_CHECK_SECS` = 120 s, or `--test-timeout` when shorter; `base-tests.txt`, status `base_check`); what it saw comes in the first report, and a check-in at once when `--test-timeout` cut it short. |
| `wb feedback <task> --text "…" \| --message <file\|->` | `--fresh` \| `--keep-context`, `--spec-gap "…"…` | Reaps a dead runner first (`reap`). Phase review/stuck/failed and no live runner; a repo that moved is refused naming `wb relocate` (#776); OpenCode 1.x is refused (exit 3) and its version recorded (`_opencode_again`, as `wb next` and `wb resume` do: #866); empty text is refused before anything is written. Writes the next round's prompt (FEEDBACK_HEAD + "Make exactly these changes, then re-run the acceptance command and finish with a short summary:" (the re-run only when there is one) + the text), reviews+1, spawns the runner. Warns past three review rounds; prints each undelivered note it dropped ("not delivered, dropped …"). A note names the GPU's holders when it will wait for them. Gathers lessons. |
| `wb next <task> --spec <file> -m "…"` | `--include` (approve bulk additions and large binaries), `--no-sign` (this commit unsigned), `--test` (replaces the acceptance command, and grants it to the agent's shell like `wb start --test`: `context.test_allowances`, #514), `--skill` (replaces the set), `--fresh`, `--allow PATTERN…` (adds to the task's grants), `--spec-gap`, `--take-claude-md` (*Claude's files*) | Phase review. Reads the spec (a file or `-`; empty or unreadable: nothing changes), records the step's size and fit, commits the work (`<m>` + `Workbench-Task: <task> (step N)` + `OpenCode-Session:`; the agent's proposals settled around the commit and put back if it fails, *Claude's files*); a step with no changes (once the proposals are settled) makes no commit and advances all the same, "step N of <task> had no changes" (it died on "nothing to commit" and the task stayed on the step, #507, Claude's audit of 1.90), writes the next step's prompt ("Step N of this task is done and committed (<sha>). The next step:", or "(no changes to commit)" for an empty step, + spec + PROTOCOL), records the spec gaps, says what `runner.fresh_reason` makes of the status to come, then advances the step (round, steps, step_round, reviews reset, step_base the worktree's HEAD, #652, phase queued) in one status write right before it spawns: written before that slow export, an interrupt left step 2 under review with no runner, a retry dying on "nothing to commit" and accept closing the task on step 1 (#191). A retry after one interrupted past its commit (the worktree's tip carries this step's trailer and nothing changed since: `cli._step_landed`) takes that commit and measures the step from `HEAD~1`, so the task advances once; it died on "nothing to commit" (#85). The spec is read again, so give it again (`-` reads stdin). Says whether the next step gets a fresh session and why (`runner.fresh_reason`), each undelivered note it dropped, and names the GPU's holders when it will wait for them. Gathers lessons. |
| `wb answer <task> --text "…" \| --file <f>` | `--id` (the pending question) | Writes `ask/<id>.answer` (atomically, never through a link: `ask_mcp.write_answer`); the blocked `ask_reviewer` returns it, and a question's id goes in status `answered` (the Stats feed's). An empty answer is refused: the question stays open; so is one over `ask_mcp.FILE_MAX` (256 KiB, `ask_mcp.too_long`, also checked in `write_answer`), which the server never reads: it said "answered" and the agent waited out its ask timeout for `NO_ANSWER` (#605); the refusal says to put the material in a file in the task's worktree and answer with its path. A closed question (answered, or dropped by the runner) is refused, also one closed between that check and the write (`ask_mcp.answer_once`, #938). |
| `wb allow <task> ["<pattern>"…]` | `--path DIR…`, `--always`, `--text "…"` (refused when the answer it makes, `--text` with the patterns and directories named, is past `FILE_MAX`, before any grant: #605) | Adds to the task's grants (`rules/<task>/grants.json`; and commands.json with `--always`, refused when it doesn't parse or has the wrong shape: `context.commands_conf`); answers the oldest open permission request (else the pending question) with "Claude allowed … Run it again now and carry on."; if the agent is live, sends that as a `--now` steer so it restarts on its session with the rule (while the tests run or the task waits for the GPU it says the agent gets it when they end, or when its round starts). `--path` goes through `_lane_dir` (refuses a path through a link, naming its target, and what `context.lane_refusal` refuses: `/`, home, a place inside credentials, workbench's state or config, or the skill library, and a place in the task's repo or its git directory, and a missing path whose name has a suffix, a file's, #670, and a place the lane always keeps out, `context.kept_out`: an active Python environment, a `NOT_WRITABLE` place, #912; creates the directory; `*` turns the lane off for the task). |
| `wb progress [on\|off]` | `--after MIN` (with `on`, or alone to move the threshold of checks already on; refused with `off` or while off, #602; default: the task's typical length on its model; kept through a bare `on`/`off`, `0` clears it) | The user's opt-in to progress checks; with no argument, what it is (*Progress checks*). |
| `wb steer <task> --text "…" \| --message <file>` | `--now`, `--step` (a smaller step: the note opens with `STEP_NOTE`; after a progress check, recorded as a `smaller` intervention, else a `hint`) | Only while queued/running/testing/asking with a live runner. Appends to steer.jsonl: delivered when the current run ends (before the tests), or at once with `--now`. While testing: "its tests are running (up to Ns); the agent gets it when they end"; while queued: when its round starts. |
| `wb note <task> --text "…"` | | A `captain` event: Claude's log line in the transcript. |
| `wb experiment [<name> [on\|off]]` | | The experiments (*Experiments*): with no argument, each one's purpose and state (`cli.experiment_lines`: `probe: on and working (probe-code 0.6.0)`, `probe: on, but not set up: no probe with `+"`symbols`"+` is on PATH, so it changes nothing yet (probe, a code-search tool: github.com/probelabs/probe; its release binary from …)`, `probe: off (wb experiment probe on)`); with a name, its state; with `on`/`off`, sets it in `experiments.json` for the tasks started from then (`; tasks already started keep theirs`). An unknown name is refused. |
| `wb coding [only\|ask\|decide]` | `allow <task> --edit "…" --said "…" [--when "…"]`, `used <task> --did "…"` | When Claude may write a delegated task's code (*Claude coding*): with no argument, the choice and its sentence, then each open task's unspent allowance; a mode saves it. `allow` records the user's yes for one task's edit, until the task goes back to the agent; with `--when`, a one-task exception granted ahead, spent only once Claude has started on it. `used` records what Claude changed under it and says to hand the testing back; exit 1 with none. |
| `wb shot <task>` | `--capture CMD` (required), `--viewport WxH` (1280x800), `--files PATH…`, `--timeout N` (300), `--chat` (post the pair to the web chat), `--setup` (run the setup in each checkout) | At review, for a visual task: the project's capture command run on the base and on the candidate, each in a scratch checkout under the task's lane; where each PNG is, or why a side has none (*Screenshots of the base and the candidate*). |
| `wb takeover [<task> \| --all]` | `--repo DIR`, `--session ID`, `--all-sessions` (from Claude Code's Bash, without `--repo`/`--session`, the scope is the calling session's: `cli._caller`, every id its process had, `claude-sessions/<CLAUDE_PID>`, and its directory, #693; this flag, or a terminal, takes every session's), `--user` | Stops the runner, phase `review`, "Claude took over", status `taken_over`; Claude edits in the worktree and accepts, or hands back with feedback. Refuses (exit 1) a task whose checkout hasn't finished, running or failed (`its worktree isn't ready yet: wait for it, or wb discard <task>`): the hand-back's runner made the checkout again from nothing, and Claude's edits went with it (#655). Outside "Let Claude decide" it needs the user's recorded yes for the task, else exit 3; `--user` (the mod's hand-back command) is the user's own ask, and records one (*Claude coding*). `--all`: every task that isn't closed; a task refused (the coding gate, exit 3) is said and the rest are still taken over, then it exits with the refusal's code (#601: the first refusal left every other runner going). A task not checked out yet, or failed at checkout, is skipped, not refused (`not ready: <task> (its checkout hasn't finished): wait for it, or wb discard <task>`), so it can't fail every hand-back (#918). `--session ID` (repeatable) and `--repo DIR`, with `--all` (the mod passes every session id its process has had and its directory): only that session's tasks (`_scope`): one with a task.json `session` when it is one of the IDs, wherever it ran, or when its `claude_pid` is gone and DIR claims it as below; else (no `session`, or no `--session` given) when its `repo` is DIR or inside it, or DIR is inside the task's spot (its package, else its `cwd` inside the repo, else the repo: #695), or its `cwd` is DIR or inside it, by whole components of real paths (in lower case where the file system ignores case), never when DIR is the home directory or `/`; one with no key at all: every session's. The rest are listed as `left alone (other sessions'): …`. |
| `wb verify <task>` | `--test CMD` (the task's `--test`), `--files PATH…`, `--expect TEXT` (the failure the base must print to be proven), `--timeout N` (300), `--setup` (run the setup in each checkout, not copy what it made) | At review: a regression test on the base (with the candidate's test files) and on the candidate, each in a scratch checkout under the task's lane; the verdict, each run's exit and assertion, and where both outputs are (*Verifying a fix against the base*). Refuses while the agent runs. SIGTERM or SIGHUP ends it as an error would (`cli._ends_cleanly`, both commands): the tests' group killed and swept, the scratch removed; Claude's Bash killing it at 2 minutes left both behind (#372, the audit of 1.6), so the skill runs a long one in the background. `wb image`, `wb audio`, `wb bench add` and `wb bench self` end the same way (#589): an engine, a listener and `claude -p` run in a session of their own whose whole group is killed when they finish, time out or wb is ended (`media.run_group`: `subprocess.run` killed only a wrapper script, and its worker kept the GPU after the lease was gone), the GPU lease, an audio server's unload and the temp directories run their cleanups, and a stopped `bench self` writes its runs.jsonl row (`error`, "stopped before it finished (a signal)"). |
| `wb stop [<task> \| --all]` | `--repo DIR`, `--session ID`, `--all-sessions` (from Claude Code's Bash, without `--repo`/`--session`, the scope is the calling session's: `cli._caller`, every id its process had, `claude-sessions/<CLAUDE_PID>`, and its directory, #693; this flag, or a terminal, takes every session's) | A live task only. Marks status `stopping`, SIGTERM the runner (15 s, `wait_exit`, then SIGKILL to its session and the agent's), sweeps what the agent left (`runner.sweep`), phase `stuck`, "stopped by the reviewer", and acknowledges the task; the worktree is kept. `--all` (`stop_everything`): every open task, a `stopped` event "bail out: stopped by the user", status `parked` (the time: `store.parked`, out of `wb status` and the mod's counts until `spawn_runner` or a takeover clears it, #541); `--park-waiting` (with `--all`, the mod's quit) also parks the scope's tasks in review, stuck or failed with no runner, as they stand, acknowledging their news (`_park_waiting`, #698); without `--repo`/`--session`, the bench's driver first (`bench.stop_driver`), so it starts no replay; another machine's driver on a shared state directory is left to it, said as `left running: bench run <run> runs on <host>…`, and this machine's tasks still stop (the bail-out died on `stop_driver`'s refusal before stopping any: the review of #876). `--session ID`, `--repo DIR` (with `--all`): as for takeover, the rest listed as `left running (other sessions'): …`. |
| `wb resume <task> [<task>…]` | several names (a restart's or a signal's batch, as its notice names it: each under its command lock, in the order they were started; one that can't resume is said and the rest go on, exit 1 at the end: #692), `--all` (every task in scope interrupted from outside, status `last` one of `cli.INTERRUPTED`: a restart, a runner that died, a signal, `wb update --stop`; or starting with `runner.UPDATED`, workbench updated under it, whose text ends with the task's own resume, so no exact match hit it and `--all` resumed none of them, #788: `cli._interrupted`; not one a guard stopped or that crashed), with `--repo DIR`, `--session ID…` (as `wb stop --all`'s scope, `_scope`) or `--all-sessions` (as `wb status`'s, #693), `--backlog NAME` | Reaps a dead runner first. Phase stuck/failed (a task whose runner died is failed), no live runner: a fresh session (round n+1, `runner.RESUME` + what the step's rounds asked), not a review round; Claude's notes the last runner never delivered follow, as a `NOTE_HEAD` note. A task that never ran a round (round 1, no `round_started_at`, no session: it was queued) starts round 1 again on the prompt `wb start` wrote, its notes delivered with it (`_early_notes`); one interrupted before its checkout finished too, the runner making the checkout again (`_rechecks_out`, #529). `--all` resumes in the order the tasks were started (`store.all_tasks`), each under its command lock (#544). A note names the GPU's holders when it will wait for them. Acks the task and gathers lessons. |
| `wb accept <task> -m "…"` | `--include` (approve bulk additions and large binaries), `--no-sign` (this commit unsigned: a key that needs unlocking), `--merge`, `--merge-as merge|ff|squash` (how `--merge` lands, implying it: a merge commit, the default; fast-forward only, refused when the branch has moved; or one squashed commit with the tip's message, for a repo kept to linear history, #352; commands.json `repos` `merge` sets a repo's default for `--merge`, which it doesn't imply), `--force` (any open phase; stops a live runner), `--spec-gap`, `--take-claude-md` (the agent's `<name>.proposed` CLAUDE.md/AGENTS.md over the file; without it they are dropped: *Claude's files*) | Reaps a dead runner first; a repo that moved stops it before anything is stopped or changed (`wb relocate` first, #498). Phase review; refuses a closed task, unless an earlier accept or discard closed it without writing its results row (status `unrecorded`): then it writes that row, once, from what the earlier run measured, and says so (`_finish_record`, #88). A live task with nothing changed on its first step is refused before its runner is stopped ("no changes to accept yet"); a live task whose commit then fails is left `stuck` ("accept failed: …", for wb accept again, resume, feedback or discard), not live with no runner. Records the step, commits (a worktree with no new changes accepts the branch's commits past the base: earlier steps, or Claude's own after a takeover; a retry after an accept died past its commit takes that commit, and when it died before `closing` was saved (the worktree's tip carries `Workbench-Task: <task>`, no step, nothing changed since: `cli._accept_landed`) measures the step from `HEAD~1`: from HEAD it read 0 files and 0 lines, and the savings card priced the task at nothing (#879); `delegate/<task>` is then made that commit, `gitops.put_on_branch`, refused with the worktree kept when the branch holds commits it lacks, #417) (`<m>` + "Delegated to <label> via OpenCode: R round(s), F automatic test-fix, V review round(s)." + `Workbench-Task:` + `OpenCode-Session:`; no AI co-author line), removes the worktree (a failure is a warning: `remove_worktree`) and the agent's runtime directory (`drop_runtime_dir`), records the branch's tip (status `tip`) and keeps its steps, base..tip, in the task's `steps.bundle` for `wb bench add` (`gitops.bundle_steps`, made before the worktree and branch go: #649), with no ref in the user's repo (#799; only when the bundle can't be made, `refs/workbench/accepted/<task>`, `gitops.keep_accepted`, deleted again once a merge or fast-forward lands the tip in the target, else by `wb gc`), `--merge`s (one merge into a checkout at a time, `gitops.merge_lock`, #639; `merge --no-ff --commit --no-squash --no-log -m <git's message for delegate/<task>>`, no hooks in any mode, #499, or with `--merge-as` `merge --ff-only --no-squash` (#430) or `merge --squash --ff` (#429) then `commit -C <tip>` (a squash conflict backed out with `reset --merge`; the squashed branch isn't an ancestor, so it is deleted with `branch -D` once the merge is recorded, and a retry interrupted between the squash and that record, which can't find it by ancestry, finds it from status `closing`'s `merge_from`, the target's head saved before the merge: a commit on its first-parent line whose parent is that head and whose message is the tip's, `gitops.squashed`; it squashed again and recorded the landed squash as refused, #432), into `base_branch`, which the main checkout must have out, else any branch, holding the base either way (refused naming the commits the merge would bring back: #418); never a detached HEAD; no changes to tracked files (a submodule moved or edited in its own checkout only when the merge changes its gitlink, #505), no merge under way, no untracked or ignored file where the merge, done first in memory, would write one (#189, #241); a conflict, or a merge git left unfinished, is backed out (#190), and so is a signature with no answer in `COMMIT_SECS` or a SIGTERM mid-merge (#420); the merge commit is signed as the task's was, unsigned after `--no-sign` (#420); a failure is reported and the accept stands, exit 5, `NOT_MERGED`: it exited 0, and a script went on as if main had the change, #247; a merged branch is then deleted, `drop_merged_branch`). A retry after an interruption resumes from status `closing` (#246), only while the worktree is gone or still clean at the recorded commit, else refused ("<task>'s worktree changed after an earlier wb accept committed <sha>…": the forced worktree removal deleted the new edits and the merge took only the old tip); one the earlier try's removal left half-deleted goes on to the removal: deleted files aren't changes, nor is its `.git` gone (a `GitError`), which every retry refused while discard and the rest pointed back at wb accept, so only an `rm -rf` by hand got out (`cli._gained_work`, the review of #878); while `closing` stands the task is being accepted (`cli._accepting`): `last` says "being accepted: wb accept <task> finishes it if this stops", which `wb status` and the pane show, and `wb discard`, `feedback`, `next`, `resume` and `takeover` refuse it with "<task> is being accepted: an earlier wb accept committed <sha> and stopped partway; wb accept <task> finishes it", as `_worktree_problem` does before its discard advice (discard recorded committed, maybe merged, work as discarded, #878): a merge already made is found by the commit's ancestry in the target branch (`gitops.contains`), not by the branch's name, a squash by `merge_from` (#432), writes the results row, removes the task's rules (`_closed`, and `gc` once a day), prints how far CLAUDE.md (or `.claude/CLAUDE.md`; a package task's own first, #783) is behind (a failure there never fails the accept) and what the task cost Claude (`claude:`, when known). Gathers lessons. |
| `wb relocate <task> --repo <dir>` | | Where the task's repository is now: moved or renamed, or the checkout it started from removed. Refuses a repo without the task's base commit, or whose git dir keeps no worktree linked to the task's; refuses a `.git` naming another git dir; repairs the worktree's link (`git worktree repair`, else written as it would be), records `rules/<task>/gitdir.json` afresh, rewrites task.json `repo`, `git_common` and a `cwd` inside the old place (`gitops.relocate`, #498), and the filled submodules' `src` in `rules/<task>/submodules.json` (#682). Relative worktree links (`worktree.useRelativePaths`) work too (#682). |
| `wb discard <task>` | `--reason "…"`, `--spec-gap`, `--keep-branch`, `--drop-steps` (delete the branch even with committed steps) | Stops the runner, records the step, removes the worktree (never fails on it: a warning), the agent's runtime directory (`drop_runtime_dir`), its rules (`_closed`, which also runs `gc` when the last was over `GC_EVERY` a day ago, as accept does) and the branch, its tip recorded first (status `tip`) and printed (`deleted (was <sha>)`), in the repo `gitops.repo_of` finds (a removed linked worktree's main one); not with `--keep-branch`, a repo that moved (said: "wasn't deleted"), or a branch with commits past the base (the steps `wb next` committed: kept, with how to merge or delete it, unless `--drop-steps`; #494); for a task whose checkout was cut short (#529), only the branch its runner made (status `branch_made`), while it still points there (#416), writes the results row, prints what the task cost Claude (`claude:`, when known). Gathers lessons. Refuses a closed task, unless its row is unwritten (as for accept). |

### Watching
| Command | Flags | What it does |
|---|---|---|
| `wb wait [<task>]` | `--timeout S` (0: none), unnamed: `--repo DIR`, `--session ID…`, `--all-sessions` (as `wb status`'s scope, `_caller`: from Claude Code's Bash, the calling session's tasks only, #696) | Reaps dead runners, then blocks (inotify) until a notice past a task's `acked` arrives, prints `[<kind>] <task>\n<text>` and acks it (under the task's ack lock, `cli.claim_ack`: of two waits, or a wait and the mod, one takes it, #696; a bare wait skips another session's tasks, whose mod then never woke for a notice it took) (skipping notices no longer true, rows that aren't whole and removed tasks'). Named: a closed task exits 2; a task already waiting whose notice was taken elsewhere prints it again "(already delivered once)"; one stopped or taken over by hand prints `[<phase>] <task> (no notice: <last>)`. Bare, with no open task: exits 2. |
| `wb status [<task>]` | `--all`, `--repo DIR`, `--session ID`, `--all-sessions` (from Claude Code's Bash, without `--repo`/`--session`, the scope is the calling session's: `cli._caller`, every id its process had, `claude-sessions/<CLAUDE_PID>`, and its directory, #693; this flag, or a terminal, takes every session's) | Reaps dead runners. One line per open task: name, phase, round, model, age, idle, last action; `?` after queued/running/testing whose runner died within `REAP_GRACE`. Named: also `worktree: <path>` while it exists. A task `wb stop --all` parked (`store.parked`: still stuck, `parked` set) shows as phase `parked`, and without `--all` or a name is left out of the table for one line, `parked by wb stop --all (/workbench-quit): …; leave them unless the user asks`, after it ("no open tasks" first when it was all there was, so the mod's context block stays out; #541). `--session ID`, `--repo DIR` (the mod's context block): only that session's tasks (as for `wb stop`), then `open elsewhere (other sessions'): …`, by name. |
| `wb watch [<task>]` | `-v`, `--once`, `--no-color`, `--json` (hidden: one pass of JSON lines, the mod's pane), `--last N` (hidden, with `--json`: the newest N transcript lines) | The live transcript (`transcript.follow`); default task: the most recently updated open one, else the most recently updated task, never a `wb bench` replay (#555). |
| `wb log <task>` | `-n N` (0 all), `-f`, `-v` | The agent's events: tool calls (`HH:MM:SS rN tool brief  ✗ error`), text, and one line for each kind `wb watch` shows (`transcript.EVENT_KINDS`, one set for both: questions, answers, stops, auto-fixes, rounds, tests, errors, retries, the runner's gpu, handover, compaction, load, steer and interrupt rows among them; it once printed nine kinds, #861). `-n` counts the lines printed, the rows that never print (one `step` per model request) left out first: they once used up the count (#861). `-f` follows until the task needs Claude or is closed, looking at the phase before each wait (on a finished task it returns at once: it waited 30 s, #90) and printing the events that came with it; each pass reaps a task whose runner died (`cli.reap`), so the follow ends on its error instead of following it for ever, and each line is flushed, so a pipe or a file gets it as it comes (#545). |
| `wb report <task>` | `--round N` | The round's summary.md. |
| `wb diff <task> [paths…]` | `--stat`, `--all` | The worktree against the task's base, or after `wb next` against the last committed step (`--all`: the whole branch); new files included. Once the worktree is gone (accepted, discarded), the git command for the branch's commits: from the base to status `tip`, the accepted commit, since `--merge` deletes the branch (#477); the branch for a task never accepted. |
| `wb top` | `--json` (one object per tick, until its parent exits), `--every S` (0.2 to 3600 s, else exit 1; default stats.json `every`, else 2) | A live view of the machine (*Seeing what the agent does*, `wb top`): each GPU's memory, busy % and watts, the running tasks, every model (the rack) and the GPU lease's queue; on a terminal redrawn in place, `q` or Ctrl-C quits; elsewhere one plain pass. Never a model call, a load or a session export. |
| `wb adopt <task>` | `--session ID…` (required: the claimer's ids, the current first), `--pid PID` (default `CLAUDE_PID`, else wb's parent) | The mod's (#687): under the task's command lock, a task whose recorded Claude Code process is gone becomes the claimer's (task.json `session`, kept when it is one of the ids, `claude_pid`, `claude_start`, `claude_machine`); exit 1 while that process lives, or was recorded on another machine (`… (pid N on another machine)`, #922), for a task with no `session` (it goes by directory) or a pid that runs nothing. |
| `wb ack <task> <ts>` | `--if TS` (the mod's rollback of a wake not delivered: the mark back to `ts` only while it is still `TS`, `cli.release_ack`, exit 3 otherwise, `released <task>`: #786) | The mod's, before a wake (#687): moves the task's `acked` to `ts` under its `ack` lock unless it is there already (`cli.claim_ack`, which `wb wait` uses too); exit 3 when another session or a wait took the notice first. |
| `wb events` | | `{"hello": pid, "start": …, "parent": pid, "parent_start": …, "machine": …}` (the parent: the Claude Code process the mod claims tasks for, #687; `store.machine`, #922), then `{"changed": [paths]}` whenever `$WB_HOME` changes (not tasks' worktrees and rounds, closed tasks, `rules/`, `imports/`, `images/`, `audio/`, the bench's clones and runs, what a link leads to, `runner.log`, `*.lock`, `*.tmp`, dotfiles); reaps dead runners once a minute; exits when its parent does. The mod's ears. |

### Models, skills, lessons, notes
| Command | Flags | What it does |
|---|---|---|
| `wb models` | `--set-default` | Each model's state, slice and speeds (and `bench:`, its cases passed, when replayed; 
`size:` when the server says none, guessed from its name or unknown, with `weights_gb` named: #704); `weights changed since its record: starting fresh` while every recorded task of it ran on other weights, `router.weights_changed`, #726); the router's ranking per size, each model the record left out on fewer than `router.EXPLORE_TRIES` tasks marked (*Exploring*, #648). `--set-default` writes the significant-work pick as OpenCode's `model` (`models.set_default`: in the user's file, refused while `OPENCODE_CONFIG_CONTENT` sets one, which would win: #421). |
| `wb model add <provider/model>` | `--pull`, `--label`, `--context N`, `--url URL`, `--start CMD`, `--stop CMD` | Registers a model in opencode.json, merged into any existing entry; `--url` first writes an OpenAI-compatible provider for any server on this machine (`models.add_server_provider`: a provider already there is never touched, and one for another baseURL refuses the add; a URL off this machine needs models.json `local: true`), and `--start`/`--stop` write the model's models.json `start`/`stop`; on a first run with no `--url` it writes the `ollama` provider when Ollama answers; refuses a cloud model, an unknown served context (a server other than Ollama needs `--context`), a down Ollama, a down server of unknown engine (see *Managing the set*). |
| `wb optimize [start\|estimate\|report\|stop\|apply] [<id>…]` | `--bench`, `--if-due` | Asked for, or when due at setup and session start (*Optimize*). `start --if-due`: only when due, else nothing printed. `estimate`: how long a run would hold the GPU. `start`: detached; measures each Ollama model's largest window all on the GPU (refused while a task holds it; a task that wants it stops it); `--bench` then starts `wb bench run` on every model. `report` (the default): a line per model. `stop`. `apply <id>…`: adds the measured window as an entry of its own beside the model (an Ollama `<name>:<tag>-<N>k`, `optimize.entry_name`, with that `num_ctx`, the entry's settings copied; refused when that name exists). |
| `wb remote <host>` | `--port N` (11434), `--context N`, `--remove` | Another machine's Ollama as this one's models: provider `ollama-<host>` marked `local: true`, each tool-capable model it has pulled registered as `wb model add` would, one line each (see *Models*); exit 1 when it doesn't answer (with `OLLAMA_HOST=0.0.0.0` to try). Refuses a provider of that id already there for another baseURL, and a host no URL can carry; an IPv6 address is bracketed either way (#707). `--remove` undoes it; not while OpenCode's default model or `small_model` is one of them (#708), nor for a provider wb didn't add or that now points elsewhere. |
| `wb model retire <id>` | `--delete` | Unregisters it (not OpenCode's default `model` nor its `small_model`, each refusal naming the field: #708) and drops its models.json overrides but `variant_of` and `replaces` (its tasks stay in its source's record, #723); `--delete` removes Ollama's weights (or says `ollama rm <name>` when it can't). |
| `wb model rename <old id> <new id>` | | The new id (a model OpenCode has now) carries on the old one's record (models.json `renamed_from`, *Models*, #818): refused when the old id is still configured (its tasks would count twice: retire it first) or nothing is recorded under it. |
| `wb model sizes <id> [trivial] [significant]` | | Limits the sizes it's routed (none: every size). A flag or size for another action is refused, not ignored (#602): `--url`, `--start`, `--stop`, `--label`, `--context` and `--pull` go with `add`, `--delete` with `retire`, sizes with `sizes`. |
| `wb scout` | `--done [--notes "…"]` (`--notes` without `--done` refused, #602), `--due`, `--watch "…"`, `--unwatch N` (1-based; 0 refused) | The weekly check's facts (with the GPU budget and the devices it counts, `cli.gpu_line`; where Ollama's settings were read, `cli.ollama_line`; the model servers here, `cli.server_lines`: the server commands on PATH (`models.SERVER_COMMANDS`) and each usual port whose `/v1/models` answers (`models.SERVER_PORTS`: Ollama's 11434, LM Studio's 1234, 8080, vLLM's 8000, KoboldCpp's 5001, SGLang's 30000, Jan's 1337 and text-generation-webui's 5000, the last two missing until #810; a 401 is a server that wants an API key, `NEEDS_KEY`, said so, unless it is wb's own web chat on 1337, and a 403 is nothing, macOS's AirPlay on 5000; on WSL2, at the Windows host too when nothing answers here, and `models.WSL_NAT` when nothing answers at all: *A server on Windows, from WSL2*, #663), flagged when OpenCode has no provider for it, compared by `models.server_key`, so `::1`, `localhost` or this host's name is one server, #588); the image and audio engines (`audio.coverage`: what the audio ones cover), and an image server answering on ComfyUI's (8188, ComfyUI Desktop's 8000) or A1111's port that no engine uses, on WSL2 at the Windows host too (`cli.image_server_lines`, #753, #923); `--done` records it; `--due` exits 0 when one is due (7 days); the watch list; each model's bench cases passed, when replayed. |
| `wb skill list \| show <n> \| scan <n\|path>` | | The library, a skill with its history, the scan alone. |
| `wb skill add <n> --from <src> -m "…"` | `--source "<origin>, <license>"`, `--lesson ID…`, `--reviewed RULE…` (a scan rule whose critical findings Claude read and judged safe: they pass, recorded in the commit; never one in `scan.UNREVIEWABLE`) | Check, scan, copy, commit. |
| `wb skill patch <n> --old … --new … -m "…"` | `--old-file`, `--new-file`, `--lesson` | An exact, unique replacement, then as add. |
| `wb skill import <url\|owner/repo\|path>` | `--path DIR`, `--as NAME` | Fetch into `imports/`, show license, hash, scan; never adds. |
| `wb skill retire <n> -m "…"` / `restore <n>` | | Move to and from `retired/`. |
| `wb skill hand\|take <task> <n…>` | | Change a task's skills from its next run. |
| `wb lessons` / `wb lessons close <id…> -m "…"` | `--task`, `--all` | Open lessons, recurring first (12 unless `--all`); close with why. |
| `wb notes` / `add "…"` / `drop N…` | | The user's standing delegation preferences (`notes.md`, `- ` lines, at most 20 of 300 characters). |
| `wb bench add <task>` | `--step N` (the last), `--hidden PATH…` (the test files the step changed), `--check CMD`, `--name CASE` (the task's; `<task>-sN` for a step of several) | Makes a case of one step of an accepted task (*Bench*): the base as a bundle, the spec, the acceptance command, the hidden checks, the grants. Refused: not accepted or a trial, the repo moved (`wb relocate` named; a removed linked worktree's main one is used, #909) or the commit gone, no acceptance command, no hidden checks, ones that pass on the base already, submodules or Git LFS files the repo can't supply (named), or ones its own commit fails in the agent's lane (no replay could pass them). |
| `wb bench rm <case…>` | | Removes the cases with their bundles and hidden checks (`bench.remove`); their runs.jsonl rows stay in the report. Refused for an unknown case or while a run goes. Nothing removed one before (#740). |
| `wb bench list` / `wb bench report` / `wb bench stop` | `report`: `--run ID`, `--label TEXT` | The cases; pass rates, rounds, auto-fixes, minutes and local tokens per label and model, then each case against the original's model and review rounds (with the running run's progress), the preempted count, and each replay that didn't start with why and its `wb.log`, or that the machine broke off (`broke off: <infra>: …`, its task's `runner.log`, #508) (the last 10; a run of only those said "no replays yet", #89); stop the driver, which closes its replay. |
| `wb bench self <case>` | `--yes` (required: it spends Claude tokens), `--turns N` (40) | Claude Code writes the case (`claude -p`, edits and the acceptance command only), graded by its hidden checks in the original task's lane; one runs.jsonl row (`arm: claude`) and its line: PASS or fail, the weighted tokens, the handoff's cost of the case's step and the ratio, or for a row with only a whole multi-step task's cost, that cost marked not comparable and no ratio (*Bench*). |
| `wb bench run` | `--model ID…` (every model that can run and takes the case's size), `--case NAME…` (every case), `--skill NAME…`, `--label TEXT`, `--repeat N` (1) | Writes the run's plan and detaches its driver, then returns: one replay at a time, after any real task, preempted by one; refuses while another run runs. First trims the runs older than the newest `RUNS_KEPT` (20) to
their `plan.json` (`bench.prune_runs`: each replay's `wb.log`, `diff.patch` and `grade.txt` went
for good otherwise, #740), and closes what a killed driver left (`bench.sweep`), and refuses while a replay's runner still lives. Skips what an earlier run with the same label already passed or failed (an `error` runs again); with nothing left, says so and starts no driver. |
| `wb backlog [NAME]` | `--json` | A batch started with `wb start --backlog NAME` (the morning summary of a night's run), archived tasks included (#270): `backlog NAME: N task(s) · 2 accepted · 1 review`, then a line per task (phase, rounds, minutes: the results row's, or since start while open; the branch when accepted; `savings.line` of its row once closed), then `savings.summary` over the batch's non-trial rows (`the batch: …`). An unknown name: exit 1. Without a name, each batch with its task count and how many are open. `--json`: `{backlog, tasks: [{task, phase, rounds, minutes, branch, saving}], totals}`; without a name, `[{backlog, tasks, open}]` (it printed the text, #602). |
| `wb savings` | `--week` (default) \| `--month` \| `--all`, `--json`, `--share` (a summary to paste: the machine, model sizes, no names; *Sharing it*), `--card FILE.svg`, `--price X\|off` | What the delegated tasks saved Claude over the period against the estimate of writing them (`savings.totals`, `summary`; trials left out): tasks, Claude's tokens, the estimate, the saving and its percentage, the GPU energy and, with a price, its cost. `--price` (per kWh, positive and finite, else exit 1) writes savings.json first; `--price off` removes `kwh_price`, its other keys kept (`savings.set_price(None)`, #609). The cost reads `GPU 600 Wh, cost 0.15`: no currency sign. `--json`: `{period, tasks, of, claude, self_est, saved, wh, cost, remote, score, price}` (`price`: the kWh price set, or null; the pane's Settings row shows it). `--card FILE.svg`: the badge as an image (*The badge*). |
| `wb stats [set KEY VALUE]` / `wb tune` / `wb trial <task…>` | `set recording\|live on\|off`, `set every 1\|2\|5`, `--json` (the feed, *The Stats feed*), `--all` (every model that ran a task) | `wb stats set` changes the Stats tab's settings (stats.json, *Stats recording*) and prints them. `wb stats` starts with the feed's headline (`stats.summary` over `feed(only=stats.SUMMARY)`: the week and all time, the streak, what the agents absorbed, their questions, the guards that fired), then the results by model and size (judged rows: it says how many spec-gap discards, tasks whose agent never ran and trials it left out, each among the models shown, #817; the models the Stats tab shows, each variant on its own row, then "N older model(s), retired or idle 90+ days: M task(s) (wb stats --all)"; `--all`: every model, #638), with a `claude` column (the average input-equivalent tokens a task cost Claude) once a row records one; the tuned settings; mark closed tasks as trials: their results rows, and their open lessons are dropped; an open task is refused (it has no row yet, so it was marked as nothing while its lessons went). |
| `wb gc` | `--days N` (default `ARCHIVE_DAYS` 30) | Tidies what history leaves behind (`cli.gc`, the 2026-11-19 audit, finding 18): archives tasks closed and untouched for N days (`store.archive`), moves notices older than that which are handled (acknowledged, their task closed or gone) to `notify.old.jsonl` under notify's lock (`_rotate_notices`), removes the rules of closed tasks and of vanished ones (a rules directory with no task waits `RULES_GRACE` an hour: a start in progress), stale runtime directories (`context.drop_stale_runtime_dirs`), the scratch directories (`store.SCRATCH_PREFIXES`: `.verify-`, `.base-`, `.check-`, `.submodule-`, `wb-index-`, `wb-merge-`, `.wb-image-`, `.wb-audio-`, each named `<prefix><maker's pid>.<start tag>.<machine tag>-` by `store.scratch`, the tag `models.start_tag`, a crc32 of its start, the machine's `store.machine_tag`, a crc32 of `store.machine()`: another machine's is left to that machine's gc for `FAR_SCRATCH_AGE`, a day, since gc here removed a live base check or verify clone there, its pid not in this process table, #876; and `wb bench add`'s half-made case `.<case>.<pid>.tmp`) in the state directory, `bench/`, `bench/cases/` and each default output directory of `wb image` and `wb audio` (`_scratch_homes`: only the top level was swept, and a bench add or a generation killed at Claude's Bash limit left its clone or temp directory for good, #589) `SCRATCH_AGE` (an hour) old whose maker is gone (`bench/`: a killed `wb bench add`'s clones, #439) (`_drop_scratches`, `_maker_alive`: a pid live again under a process with another start is gone, #532; an untagged name goes by the pid), half-made starts (`_dead_start`, `_drop_start`: a task directory with no task.json whose `starting.json` pid is gone or now another process's (its `start`, #532), or with none past `RULES_GRACE`; one another machine wrote (its `machine`) only once its `at` is `RULES_GRACE` old, #876; its worktree (unlocked first: killed mid-checkout, git leaves it locked "initializing", which remove and the registration's drop skip), its registration only (#641) and rules go too, and the branch only when `starting.json` says this start made it and only while it still points at `branch_at` (`delete_branch(at=)`: one `update-ref -d` compare-and-delete; an earlier task's unmerged `delegate/<task>` was deleted after a start killed before its worktree, #416); killed commands left full clones that `_disk_room` counted, and a killed start's name was refused for good: #376, the audit of 1.6), the web chat's uploads older than N days whose message has its receipt (an expired one is retired with one, #741), or that no unread message names (`chat.drop_old_uploads`, #623), and the delegate branches of accepted tasks that have landed, merged by `--merge` before accept deleted them itself or by hand after a plain accept (`_merged_branches`: each repo's `refs/heads/delegate/` listed once with `for-each-ref`, the tip recorded first, then `gitops.drop_landed_branch`: `branch 
-d`, else a compare-and-delete when the task's `base_branch` holds the tip, never while a worktree has the branch checked out (`gitops.checked_out_in`, from `worktree list --porcelain`; update-ref skips git's own check, and a second worktree's HEAD was left naming no ref, every file staged, #930; skipped, it is asked again next time); a branch moved past the tip accept recorded is the user's and stays (#930: the tip compared was the one gc read); a branch gone or deleted is recorded, status `branch_gone`, and never looked at again: only `--merge` rows were considered, so a hand-merged branch stayed for good, and every merged task ever recorded cost a git call on every run, #686). A branch squash-merged elsewhere (a pull request) holds commits its target lacks, so it stays: `git branch -D` it. Then each accepted task's `refs/workbench/accepted/<task>`, which accept kept in the user's repo before the steps bundle (or when it couldn't make one) (`_released_refs`, `gitops.drop_accepted`, a compare-and-delete; status `accepted_ref_gone` then, never looked at again): deleted outright when its tip is in the task's `base_branch` (one `for-each-ref --merged` per repo and base branch), which keeps every step alive, else moved into the task's `steps.bundle` first (`gitops.bundle_steps`), which `wb bench add` reads (deleted without it only when the bundle can't be made and each step has its bench case); kept on every accept for good, each task's steps showed in `git log --all`, mirrors copied them and git gc could never prune them (#799). A `steps.bundle` stays as long as its task, every step cased or not: removed then, a case taken out with `wb bench rm` could never be made again after a squash accept (#940). And what history kept for good (#740, the 2026-11-21 audit): archived tasks closed over `store.SLIM_DAYS` (90) days lose `store.SLIM_GLOBS` (`runner.log`, `base-tests.txt`, `setup.txt`, `rounds/*/tests.txt`, verify's and shot's outputs, the earlier sessions' exports `.export-<sid>.json`, a cache `transcript.finished_export` fills again on demand; and wb shot's PNGs, each side of its shots.json marked `pruned` first, which `chat.shots` reports as no image and `/api/shot` answers with 410, so the web chat says the screenshot expired, not that it failed or couldn't load, #821; task.json, status.json, the prompts, summaries, events and asks stay: names stay taken, bench add reads the prompts, the lessons the events; `store.slim_archive`), `notify.old.jsonl` past `NOTIFY_OLD_MAX` (8 MiB) keeps its newest half from a whole line (`_cap_old_notices`), and `_drop_leftovers` removes `imports/` entries older than N days and `claude-sessions/<pid>` files older than that whose process is gone and that no open task records. 
Prints the counts and the bytes freed; writes `gc.json`. Then (not in `cli.gc`, which a discard runs) `bench.sweep`: the bench replays a driver killed without warning left (*Bench*, #511), with a line naming them. `wb accept` and `wb discard` run it without the branches at most once a day (`GC_EVERY`). |

### Other
| Command | Flags | What it does |
|---|---|---|
| `wb image "<prompt>"` | `--n` (4; at least 1), `--size WxH` (1024x1024), `--seed`, `--ref <img>…`, `--out DIR`, `--engine`, `--list`, `--wait` | Candidates from a local image engine (see *Images*). While anything holds the GPU it refuses at once, naming the holders; `--wait` queues behind them. An engine off this GPU (`"gpu": false`, or a url on another host) runs beside tasks; one pinned to a card (`devices`, `beside`) waits only for the tasks on it. A bare `list` or `ls` as the prompt acts as `--list`. |
| `wb audio "<text>"` | `--kind speech\|sfx\|music` (default: the first engine), `--n` (3; at least 1), `--seconds S` (engines with `{seconds}`; default the entry's `seconds`, else 5 for sfx, 30 for music, 10 otherwise), `--voice NAME` (default: the entry's first of `voices`), `--ref <clip>…`, `--lyrics FILE\|-`, `--seed`, `--engine`, `--out DIR`, `--no-check` (no listener, no spectrograms), `--list`, `--wait` | Clips from a local audio engine, each with one line of checks (see *Audio*). `--n` below 1 is refused (exit 2, before any lease: #592); a clip that isn't audio fails the command, unpublished. A GPU engine refuses while anything holds the GPU (`--wait` queues); a `"gpu": false` engine runs beside tasks. A bare `list` or `ls` acts as `--list`. An option the engine has no placeholder for is refused, naming it. |
| `wb chat [log\|on\|off\|serve\|url\|reply\|listen\|ack\|claim\|pending\|ask\|wait\|answer]` | `listen <clip>… [--text]` (Claude's shortlist of `wb audio` takes for the user to play and pick, up to 8: *Listening by ear*, #397), `on`, `off` (the switch, kept; `on` starts a server when none answers on `--port`, waits for it, and prints the link; it refuses, leaving the switch off (#690), when another program or another account's chat answers there or its server didn't start, `off` stops only one it started; `url` first starts again one `on` started that is gone, #449), `--port` (the running server's, from `chat/port.json`, else the one `chat/serve.pid` names, else 1337: #349), `--bind` (replaces chat.json's), `--host` (adds), `--text`, `--message <file\|->` (reply reads stdin without either), `-n` (10); `ack <id> --by --how`, `claim <id> --by` (exit 1: another session's), `ask --tool --kind permission\|plan\|question --text --detail <json> --session --repo --pid` (a plan's session and directory; `--pid`, the asking session's `wb events` process, #538; prints `<id> open`, `<id> allow` when the user's setting answered it, or `<id> expired` for a plan it can't read), `wait <id> --timeout` (30 s; prints allow, deny, expired, or `open` at the timeout; `--json`: the whole ask), `answer <id> allow\|deny\|expired --by --note` (prints the answer that stands) (the mod) | The web chat: the thread, the server, the link with its token, Claude's reply, permission prompts. |
| `wb try` | `--model <id or fragment>` (the router's pick) | A sample task that proves the setup (#112): copies `workbench/try/project/` (a tiny `stats.py` with its tests and a committed CLAUDE.md; `from __future__ import annotations`, so its `list[float]` imports on Python 3.7 and 3.8 too) into `~/.local/share/workbench/try/<n>`, without Python's caches (a `__pycache__` left in the clone's sample made `wb init` refuse the copy as generated files, 2026-11-21) (beside `$WB_SKILLS`: the state directory is hidden from the lane, and its agent had no git there, #164), sets it up as `wb init` does, and starts `workbench/try/spec.md` (add `median`) as `try-<n>`, `--size trivial --trial --test '<wb's python> -m unittest'` (`sys.executable`, quoted: PATH's `python3` is 3.6 on RHEL 8, and the untouched base failed, #530): never the router's evidence or the lessons. Prints what `wb start` does, the project's path and the hidden check for review, `<wb's python> <pkg>/workbench/try/check.py <worktree>` (the agent never sees it; it fails on the untouched base, also when its Python can't read the module, passes once `median` meets the spec, and leaves no `__pycache__`). A refusal, by `wb init` (no git identity: #530; a home that is a git repo no longer refuses it, #684) or by the start (the GPU busy without `--queue`, no model), removes the copy again (#161). |
| `wb init <dir>` | | A project the way Claude keeps one: git on the default branch, an initial commit, AGENTS.md → CLAUDE.md (a CLAUDE.md → AGENTS.md link is swapped; a gitignored CLAUDE.md isn't linked; in a repo with commits only the link is committed, the user's CLAUDE.md edits left alone, #931, and nothing while a merge, cherry-pick, revert or rebase waits: `gitops.under_way`). Refuses the home directory or above, inside another repo (but a home kept as a git repo, dotfiles in `~`, or one above it: the project gets a repo of its own nested there, else every new project and `wb try` were refused there, #684), a repo git refuses (git's reason: no `git init` over it; "not a repo" is told apart in any language, `gitops.NotARepo`), without a git identity (`git var`, as for `wb start`), and a first commit holding likely secrets or installed directories no .gitignore covers. |
| `wb setup` | `--force` (replaces a link that points elsewhere; never a real file) | Links `~/.local/bin/wb` to this copy's `bin/wb` and Claude Code's `skills/workbench` to its `skill/workbench`, removes an old `skills/delegate` link that now leads nowhere (the skill was `/delegate` until 2026-11-17; the mod runs `wb setup` itself when it finds only that), warns when `~/.local/bin` isn't on PATH (Claude and the mod run `wb` by name) with the line for the user's `$SHELL` (`cli.path_advice`: zsh's `~/.zshrc`, bash's `~/.bashrc`, on macOS `~/.bash_profile`, fish's `fish_add_path`, else `~/.profile`) and to start Claude Code again from a new terminal (the desktop app or an IDE too); "add it" was all it said (#274, the audit of 1.2), and `wb doctor`'s "wb isn't on PATH" gives the same line when that link is there; exit 1 when it left something in the way (see *Installing*). Then, when due (*Optimize*), starts the minute or two of measuring the GPU and prints its line as `--`. Ends with a `first run:` checklist (`cli.first_run`, #111), one line each, `ok` or `--` with the fix: OpenCode 2.x (else `runner.OPENCODE_GET`: OpenCode's `/v2/install`, or `opencode upgrade --major` on 1.x; npm's `opencode-ai`, `opencode.ai/install` and GitHub's Latest release are the 1.x line, #654), a model server answering (a configured provider, this machine's Ollama, or a server on a default port; on WSL2 one only at the Windows host is a `--` line that it needs `local: true`, and none at all adds `models.WSL_NAT`, #663; else: start yours, or run /workbench and Claude lays out the ones that fit the machine, never steering to one; `wb model add --url`), a local model registered (else: run /workbench, and Claude picks one for the machine), Landlock. It names no model, and changes no exit code. |
| `wb update` | `--check` (only say whether the upstream has news: `update available: N new commit(s)…` or `up to date`), `--if-due` (with `--check`, refused without it, which pulled at once, #602: ask origin at most weekly, `UPDATE_EVERY`, else answer from `update.json`; never with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`), `--stop` (stop the running tasks first, `cli._stop_for_update`: each stuck with `last` `UPDATE_STOP`, not parked, its news not acknowledged, and one `stuck` notice per owner, `store.owner`, naming `wb resume <a> <b> …` with `tasks`, the rest of a batch acknowledged with it, so each session, this one or another, is woken to continue its own; resumed by `--all` too, `UPDATE_STOP` being in `cli.INTERRUPTED`: #694) | Updates this copy (see *Installing*): refuses while any runner is live, naming whose each is (`this session's`, or `session <id> in <dir>`: `_whose`) and `--stop` (the advice was an unscoped `wb stop --all`, which parked other live sessions' agents and acknowledged their news, so their Claude waited for a wake that never came, #694); a marketplace copy runs `claude plugin marketplace update workbench` then `claude plugin update workbench@workbench`; a clone (refusing uncommitted tracked changes) runs `git pull --ff-only` first. Every check that can refuse runs before `--stop` stops anything (#775: it stopped every session's tasks, then died or found nothing new): uncommitted changes, `claude` not on PATH, and for a clone the fetch (`_fetch_origin`, from the remote the branch's upstream is on, `branch.<name>.remote`, origin only when none is set, nothing for a local upstream: it fetched `origin` alone, so a fork's clone tracking `upstream/main` read "already up to date" against a stale ref, and one with no origin couldn't check, #875) and `HEAD..@{u}`, refusing a clone behind its upstream with commits it hasn't (or no upstream; one only ahead, a local patch, has nothing to pull and goes on to the plugin steps: it was refused, #875); a clone with nothing to pull stops no task and refuses none, runs only the plugin steps and prints `already up to date`. A marketplace copy can't count its news beforehand (one commit deep), so a step failing after the stop ends with `the tasks were stopped for it: wb resume <a> <b> … continues them`; a step that can't run or runs past 300 s fails with a line (after a clone's pull: what is left to run), and update.json is written as soon as the pull lands. Prints `updated <kind> a..b (N commit(s))` or `already up to date`; without the count when `a` is gone, as in Claude Code's marketplace clone, which is one commit deep and replaced by its update (the count once failed an update that had landed, 2026-11-20). The check's fetch (`cli._fetch_origin`) never prompts and never hangs: no terminal, `GIT_TERMINAL_PROMPT=0`, `SSH_ASKPASS_REQUIRE=never`, at most `FETCH_SECS` = 60 s; the user's own ssh command (`GIT_SSH_COMMAND`, `GIT_SSH`, `core.sshCommand`) is kept, and with none ssh runs with `BatchMode`. In between, `--if-due` recounts `HEAD..@{u}` locally, so a pull made elsewhere shows at once. |
| `wb doctor` | | `opencode --version` (BAD below 2.x, whose config shape and run flags workbench writes, or missing, either with `runner.OPENCODE_GET`; a version that doesn't parse is a `--` line; one outside `runner.OPENCODE_TESTED` another `--` line), the OpenCode config files (the user's `$OPENCODE_CONFIG` among them), the Python wb runs on (its version and path, and when the launcher handed over from an older `python3`, #259), git (BAD below `gitops.GIT_FLOOR`, 2.34: #527), models found and each one's readiness (BAD when none can run), the providers skipped and why, an Ollama provider not answering (asked once), a provider's baseURL problem, any entry without `limit.context` (BAD), each Ollama entry's `options.max_tokens` and context against what Ollama serves (or that it can't say), a `--` line for each model `wb optimize` measured with a window to change (`optimize.advice`), a `--` line for a model left thinking whose output cap (`options.max_tokens`, else `limit.output`: any server) at its measured write speed here outlasts its think budget (`router.thinking_stall`: it can sit silent until nudged and stopped; seen 2026-11-18 on a spilled 64K entry; harmless on a fast card, so measured per machine), the state directory (made if missing, then checked writable; BAD on a noexec mount, `store.noexec`, #851; a `--` line when it is on a network file system, whose machines each run and reap only their own tasks, #849; what it holds, counted for at most 3 s, and the free space beside it: BAD under 2 GB, #342; on WSL a `--` line naming the Windows drive that free space is capped by, `store.host_drive`, #897), a `--  waiting on Claude for 3+ days: <name> (<phase> <N>d[, parked]), …` line naming the tasks in review, stuck, failed or asking whose status hasn't changed for `IDLE_DAYS` (3) with `wb resume`, `wb report`, `wb discard` (`idle_line`: nothing else named a task left for weeks, #541), the GPU budget and the devices it counts (or that the GPU's memory is unknown, or that none was found: a `--` line), where the Ollama here had its settings read or that nothing could say (`cli.ollama_line`, a `--` line, with a local Ollama model: #379), the models this machine's Ollama has loaded that no task here holds (`models.unheld_loaded`, a `--` line: a task that needs the room unloads them once idle; on a shared Ollama `keep_loaded` keeps them and `gpu_gb` gives the budget that lets a model fit beside them, #378), a real lane drawn around a test write (`ok agents write only in their lane (Landlock ABI N)`: the probe's `PermissionError`, not exit 126; then a `--  Landlock ABI N: …` line for each of `lane.gaps`, and on WSL with interop on a `--  WSL interop is on: …` line (`context.interop_gap`), and a `--` line when the home directory lies in a temp root, which the lane writes whole (`context.home_gap`: its credentials are then readable to agents; the 2026-11-19 audit, a sandbox's profile under `/tmp`); without Landlock a `--` line saying writes and credential reads aren't refused and whether sudo still is), `commands.json` (`context.commands_conf`: it must parse and hold lists of strings, and `repos` its settings; `BAD` stops the check), the toolchains on PATH that are snaps (`context.TOOLCHAINS`; they can't run in the lane), `wb` on PATH (Claude's Bash runs it by name: BAD without it, whatever `WB_BIN` says; `WB_BIN` is noted when set), what a logout would stop (`cli.logout_stops`), whether runs keep the machine awake (`cli.awake_line`, *Kept awake*: `ok` with caffeinate, with powershell.exe on WSL2 (#777), or with systemd-inhibit when a probe's sleep lock is granted; a `--` line for an idle lock only, for WSL2 without interop or powershell.exe, or for no tool), with web chat notifications subscribed, this Python's CA certificates (`webpush.has_cas`: loaded, or a CA directory with files; BAD without, with the fix, #539), the `/workbench` skill link, a `--` line when `wb` or `/workbench` comes from another copy (`wb setup --force` from the one you want), and whether Claude Code lists `workbench@…` in `plugins/installed_plugins.json` (information only: a mod loaded another way isn't listed), and one `--  experiment …` line per experiment (`wb experiment`'s). `ok`/`BAD` lines set the exit code; `--` lines inform. |

## Files and formats

```
$WB_HOME (~/.local/state/workbench)
  notify.jsonl                   notices that need Claude, all tasks (the runner writes them)
  notify.old.jsonl               notices handled and older than ARCHIVE_DAYS, moved by gc (_rotate_notices), its newest half kept past NOTIFY_OLD_MAX
  claude-sessions/<pid>          "<ts> <session id>" lines, each process's after a "start <its start>" line (#787): each session a Claude Code process ran wb in (spend.sessions, cli._caller)
  gc.json                        the last gc: {at, archived, notices, rules, runtime, scratch, starts, uploads, branches, refs, …}
  archive/<task>/                a task closed and untouched for ARCHIVE_DAYS (30), moved from tasks/ by gc
  coding.json                    Claude coding, the user's choice: {mode: only|ask|decide, ts}; none: decide
  experiments.json  .lock        wb experiment: {<name>: "on"|"off"}; a missing name is off (*Experiments*)
  progress.json                  progress checks, the user's opt-in: {on, after?, ts}; none: off
  results.jsonl                  one row per closed task: what the router, slices, tuning and skill records learn from
  stats.json  stats.lock         the Stats tab's settings ({recording, live, every, ts}; none: all defaults: *Stats recording*)
  lessons.jsonl                  what each task taught, open until written into a skill or closed
  notes.md  notes.lock           wb notes: how the user wants delegation run
  tuning.json                    optional: pin a tuned setting ({"fresh_at": 0.6})
  speed.json  speed.lock         each model's measured write and read speeds
  gpu.lock  gpu.json  gpu.admit  the GPU lease: the lock, who holds or waits for it, the admission lock,
  gpu.load                       and the lock that takes model loads one at a time (all in
                                 models.lease_dir(): $WB_GPU_DIR or /var/lib/workbench/gpu
                                 when shared by the machine's accounts, #393; machines/<machine>/
                                 when the state dir is on a network file system, #849)
  machines/<machine>/            on a network file system, one machine's own (store.machine_dir, #849, #894): its
                                 GPU lease, optimize.json and .log, boxes.json, wsl-gpus.json, speed.json (#901)
  gpu-<host>-<port>.{lock,json,admit,load}   the same for a remote server's models (models.pool)
  scout.json  watch.json         the weekly model check: when it was done and offered; the watch list
  update.json                    wb update: when origin was last asked, how far behind this copy was
  boxes.json                     what this machine loaded on each wb remote box ({root: {name: ts}}, models.box_mine): its own models there aren't another client's (#812) unless seen in use (#893)
  wsl-gpus.json                  WSL only: Windows' display adapters ({ts, gpus: [{name, vram}], tried?}), re-read hourly (hardware.WINDOWS_FOR); a failed read keeps the last good one and stamps tried (retried after WINDOWS_RETRY)
  bench/cases/<case>/            case.json  spec.md  base.bundle  hidden/<path>…  reference.patch
  bench/runs/<run>/              plan.json  driver.log  <task>/{wb.log,diff.patch,grade.txt} (repo/ while it runs)
  bench/runs.jsonl  driver.json  one row per replay; the driver's {pid, run, start, machine, host} (driver.lock: its beat, #876)
                                 (bench.jsonl and bench/repos/ are the old suite's: nothing reads them)
  optimize.json  optimize.log    wb optimize: {pid, start, began, done, stopped, hardware (fingerprint: [name, vram] per GPU, then ["remote", root, [[name, size]…]] per remote Ollama),
                                 secs_per_load, models: {<id>: {window, fits, spill, clamped, cpu? (nothing in VRAM: #809), applied?, digest? (its weights', #709), tried:
                                 [{window, size, vram, served}], ts}}, skipped: {<id>: {outcome (busy|failed|unreachable), why,
                                 ts, retry_after}} (#583), made: {<provider>/<name>: <source id>} (a variant
                                 apply made and hasn't registered yet: #266)}; the run's output
  imports/<slug>/                skills fetched by wb skill import, for Claude to read
  images/<YYYYmmdd-HHMMSS>/      wb image's candidates (unless --out), their .json sidecars, engine.log
  audio/<YYYYmmdd-HHMMSS>/       wb audio's clips (unless --out): .wav, .json sidecar, .png spectrogram, engine.log
  chat/                          messages.jsonl  receipts.jsonl  asks.jsonl  prefs.json  listener.json  claims.json
                                 switch.json ({on}: wb chat on|off)  serve.pid ({pid, port, start}; wb chat url revives from it)  serve.log (the server wb chat on started)
                                 port.json ({port, pid, start}: the port wb chat serve runs on, read back without --port)
                                 audio/<batch>/ (wb chat listen's copies, <n>.<ext>, and audio.json; the newest 20)
                                 uploads/<id>/ (an attachment: <name> 0600 and .meta.json; *The web chat*)  uploads.lock
  rules/<task>/                  outside the lane: opencode.json (the config layer), HANDBOOK.md,
                                 CLAUDE.md (a copy of the user's), user-rules/<path> (their
                                 ~/.claude/rules: context.user_rules), project-rules/<path> (a project
                                 rule a link takes outside the repo: context.project_rules),
                                 imports/<n>/<name> (an import
                                 from outside the repo: context.import_files), bin/git (the shim),
                                 grants.json (what Claude allowed: {"allow", "paths", "test_tools"}),
                                 gitdir.json (the worktree's real git dir and its .git's text: {"gitdir", "dotgit"}),
                                 submodules.json (each submodule filled in the worktree: [{"path", "src" (the
                                 user's checkout of it), "sha", "index"}]) and its submodule-<n>.index (#419);
                                 removed when the task closes (cli._closed), and by gc for a closed or vanished task
  locks/<task>.runner.lock       held by the task's runner for its life (its pid inside; touched every BEAT_SECS, #872): one runner a task
  locks/<task>.cmd.lock          one wb command on the task at a time
  locks/<task>.<file>.lock       one writer of the task's status, events, steer and grants files
  locks/<task>.ack.lock          one taker of the task's notice (`wb ack`, `wb wait`: cli.claim_ack, #687; _ack_all and release_ack, #786)
  locks/<task>.ask.lock          one answer to a question: the open check and the write (ask_mcp.answer_once, #938)
                                 (store.task_lock: every lock a task's writers take is here, where no
                                 lane reads; in the task's directory an agent held runner.lock, then
                                 status.lock, with flock, and every later runner exited at once, then
                                 the runner and wb stop froze at their next status write: the 0.90 review)
  locks/prepare.json, prepare-<n>.lock  the setups' queue ({pid: {task, since, start, holding}}) and
                                 their turns, PREP_SLOTS of them (runner.prep_turn, #590)
  locks/prepare-check.json, prepare-check-<n>.lock  the base checks' own, the same (#868)
  locks/signal-stop.lock         one runner at a time writing a shutdown's one notice (runner._signal_notice, #544)
  locks/skills.lock              one change to the skill library at a time, add to commit (skills._library_lock, #822)
  locks/config-<key>.lock        not here: in store.config_lock_dir, $XDG_RUNTIME_DIR/workbench (else a 0700
                                 workbench-<uid> in the temp directory, else here), one for every WB_HOME of
                                 the account, since the files are shared (#939): one read-modify-write at a
                                 time of a user's config file (store.config_lock: <key> from the path a write
                                 lands in; beside the file it would be a stray file in the user's dotfiles; #495)
  tasks/<task>/                  readable from the lane; only worktree/ and ask/ writable
    task.json  status.json
    events.jsonl  steer.jsonl  acked  noticed (its newest notice's ts, #844)  context.md  runner.log
    claude-sessions              "<ts> <session id>" lines: each Claude Code session a wb call naming the task ran in (spend.sessions, #719)
    coding.json                  what the user allowed Claude to edit: {allowed: [{edit, said, ts, used, when?, started?, did?}]} (*Claude coding*)
    verify/<n>/                  wb verify's runs: base.txt  candidate.txt  result.json
    shots/<n>/                   wb shot's pairs: base.png  candidate.png  base.txt  candidate.txt  shots.json
    base-tests.txt               the base check's output: the acceptance command on the base (`--test`)
    starting.json                a start under way: repo, worktree, wb start's pid, start and machine (#876) (one from before #529, whose start made the branch, also the branch and its commit, #416); gone once task.json is (#376)
    setup.txt                    the setup's output (`--setup`, *Setting the worktree up*)
    prepared.json                what the setup left, for the scratch checkouts (runner.PREPARED, #867): {paths
                                 (the worktree's ignored paths, which each copies instead of running the setup, #249,
                                 unless one is a virtualenv, #325, or was rebuilt since), marks ({path: fingerprint},
                                 runner.prepared_mark, #732), bytes (their size, checked against the free space, #860)}
    steps.bundle                 an accepted task's steps, base..tip, for wb bench add (gitops.bundle_steps,
                                 STEPS_BUNDLE, #799); kept as long as the task, so a case can be remade (#940)
    .export-<sid>.json           an earlier session's OpenCode export, before a handover: made once, for wb watch (#691)
    <name> → ../<name>           a sibling's link, beside the worktree (`--sibling`; not one of context.TASK_FILES)
    tree/<parents>/worktree/     the worktree instead, with a sibling more than one level up (task.json `worktree`), the links around it (#261)
    rounds/<n>/                  prompt.md  instructions.md (before a handover rewrote it)  summary.md  tests.txt
                                 notes.md (Claude's notes folded into prompt.md after its opening: runner.folded_notes, #677)
                                 nudged (empty: prompt.md is the runner's think nudge, which round_asks skips, #681)
    ask/<id>.json  <id>.answer   questions and permission requests; their answers (all the lane writes here, with worktree/)
    worktree/                    the agent's git worktree, branch delegate/<task>
~/.local/share/workbench/skills/ ($WB_SKILLS) the skill library, its own git repo; retired/
~/.local/share/workbench/try/<n>/ wb try's sample projects, each a repo of its own (its task: try-<n>;
                                 beside $WB_SKILLS, whatever it is set to)
~/.config/workbench/             wb's writes to models.json, commands.json and savings.json (and OpenCode's
                                 config, models.own_config) go through store.edit_config: locked, through a
                                 symlink to its target, the mode kept (0600 for a new file); a read-only
                                 target is refused
  models.json ($WB_MODELS)       what OpenCode can't say about each model or provider
  images.json ($WB_IMAGES)       image engines
  audio.json ($WB_AUDIO)         audio engines (speech, sfx, music, and a listener)
  commands.json ($WB_COMMANDS)   the user's standing allowances: {"allow": [patterns], "paths": [dirs], "env": [names]}
                                 (each a list of strings, or the file is refused: context.commands_conf), and
                                 "repos": {"<repo path>": {"setup": cmd, "setup_timeout": secs, "copy": [paths], "siblings": [paths],
                                 "merge": "merge|ff|squash"}}, each repo's worktree setup (context.repo_conf, for the
                                 task's spot, the repo or its package (task.json subdir): a key may name a monorepo
                                 package, and the key nearest the spot wins, the spot itself, else the nearest
                                 directory above it in the repo, so the root's entry holds for a package without its
                                 own and a package's never for the root or another package (#778: any key matched
                                 by git dir, the file's first package entry for every task); by real path, else by
                                 git dir and the path inside the worktree: its linked worktrees too; wb accept reads it
                                 the same way; --setup and --setup-timeout replace its setup and its limit, a
                                 positive whole number, --copy and --sibling add) and how wb
                                 accept --merge lands there (context.MERGE_AS; --merge-as overrides, #352)
  chat.json ($WB_CHAT_CONFIG)    the web chat's {"bind": [...], "hosts": [...], "upload_mb": 25, "upload_message_mb": 50}
  chat-token ($WB_CHAT_TOKEN)    the web chat's token, mode 600
  savings.json ($WB_SAVINGS)     {"kwh_price": N}, the electricity price the energy is costed at (wb savings --price;
                                 --price off removes it; other keys kept)
~/.config/opencode/opencode.json + .jsonc (layered, under $XDG_CONFIG_HOME; then $OPENCODE_CONFIG; $WB_OPENCODE_CONFIG) the models
/tmp/wb-run-<uid>-<hash>/        the agent's XDG_RUNTIME_DIR (lane on; context.runtime_dir), 0700: kept while
                                 the task is open (stuck or in review too), removed by wb accept and wb discard
                                 (drop_runtime_dir); taken by another user, a mkdtemp wb-run-* is used instead;
                                 each holds .wb-owner {home, task} (RUNTIME_OWNER); gc removes one of this
                                 user's untouched for STALE_RUNTIME_DAYS (7) only when it names this profile
                                 and a task closed or gone (unmarked: a closed task's, by its name), never
                                 another profile's or a wb-run-* wb didn't make (drop_stale_runtime_dirs, #243)
```

**Store primitives** (`workbench/store.py`). `home()` is `$WB_HOME`, else
`~/.local/state/workbench`. The path variables (`PATH_VARS`: `WB_HOME`, `WB_MODELS`, `WB_SKILLS`,
`WB_IMAGES`, `WB_AUDIO`, `WB_COMMANDS`, `WB_CHAT_TOKEN`, `WB_CHAT_CONFIG`, `WB_OPENCODE_CONFIG`, `WB_SAVINGS`, `WB_GPU_DIR` (the GPU lease's directory, `models.lease_dir`),
and the user's `OPENCODE_CONFIG` and `CLAUDE_CONFIG_DIR`, #328, and `OPENCODE_CONFIG_DIR`,
`XDG_CONFIG_HOME` and `XDG_DATA_HOME`, where OpenCode keeps its global config and its sessions,
#650) accept `~` and
relative paths: `absolute_env()`, first thing in `cli.main` and the runner, makes them absolute
against wb's cwd (not resolved: a symlinked home stays as named; the mod's `absolutePath` does the
same for `WB_HOME`, `CLAUDE_CONFIG_DIR` and `WB_SAVINGS`, #454), so every child inherits the
same place (a relative `WB_HOME` once had wb write the task under its cwd and the runner, which
runs from the package's directory, look for it there: the 2026-11-16 audit; a relative
`OPENCODE_CONFIG` had `wb start` pick a model the runner then called unknown: #328, the audit of
1.4; a relative `OPENCODE_CONFIG_DIR` did the same: #650). `write_json` writes `.<name>.<pid>.<random>.tmp` beside the file (created exclusively, so two threads never share one: the 2026-11-19 audit) and renames it
after an fsync (`store._synced`, `write_through` too: renamed unsynced, a power loss on XFS or
ext4 without `auto_da_alloc` could leave `task.json` or `status.json` empty, #475, the audit of
1.8), replacing a symlink with a plain file, which is right for the state directory.
`replace_bytes(path, data)` does the same for a file rewritten whole that isn't JSON: `mark_trials`'
results.jsonl, the daily gc's notify.jsonl (`cli._rotate_notices`, notify.old.jsonl's append synced
first), a task's `acked` (`write_ack`) and notes.md; renamed unsynced under a pid-only name, a crash
soon after could empty the router's whole history or every pending notice (#734, the 2026-11-21
audit). `Task.spec`
is a `store.Record`: a key `task.json` lacks raises `store.Damaged` (a `KeyError` to the code
reading it, a `RuntimeError` to `cli.main`), "task <t>'s task.json is damaged (it has no
'model'…)", and the runner fails the task with that line (`_load_failed`), not a crash. The
user's own config files take `write_through` instead: `writable_target` follows a symlink to its
target (refused, saying to edit it in its source, when that isn't writable: a Nix store), the
temporary file goes beside the target, created 0600, and gets the target's mode (0600 for a new
file) before the rename; `edit_config(path, read, change)` is the read-modify-write around it,
under `config_lock(path)` (`config-<key>.lock` in `config_lock_dir()`, shared by every state
directory of the account: under each WB_HOME's `locks/`, two profiles editing one commands.json
took different locks and one grant was lost, #939), `read()` checking the file first and nothing
written when the change raises (#495: a dotfiles link became a plain 0644 file, and two
`wb allow --always` close together lost one grant); a file whose inode, mtime or size changed
between the read and the write (OpenCode, an editor) is left as it is, a RuntimeError saying "changed
while wb was editing it; nothing was written: run the command again" (#939); `read_json` returns the default for a missing or broken file. `append_jsonl` appends
one line under `<file>.lock` (flock; a task's own events and steer files under `locks/<task>.<file>.lock`, `store.task_lock`, out of the lane), first ending a last line a write cut short (a full disk, a
crash), so only that fragment is lost, not the row after it; `read_jsonl(path, offset)` returns
the whole lines and the offset after the last one, skipping bad lines (bad JSON, or bytes that
aren't UTF-8). `scrub(data)` makes every lone surrogate in data's strings U+FFFD and `loads(text)`
is `json.loads` then `scrub`, for JSON from outside workbench (#438). `append_jsonl` and
`write_json` write a lone surrogate still in their data as its JSON escape (`backslashreplace`,
which reads back the same): strict, one in a notice raised past every caller's guard (#784); the
paths git gives as bytes are shown with `gitops.shown` (a byte that isn't UTF-8 as `\xe9`:
`snapshot_left`'s left-out list, `submodule_edits`), and `~/.claude/CLAUDE.md` is copied for the
agent as bytes (a CP1252 byte failed every `wb start` and round, #784). All of them read and write UTF-8 whatever the locale (the 2026-11-16 audit: under a
legacy one an em dash in a spec failed to write), as do `wb start|next|feedback`'s specs and
prompts, and the runner runs under `-X utf8`. `results(trials=False)` leaves out trial rows,
and parses the file again only when its inode, size or mtime changed, so the router, the slice
and `wb tune`, asking per model, size and knob, read it once per command (#727: 9 and 25 full
reads of a 20,000-row history, 2.9 s and 7.8 s; the rows are shared, so callers don't change them);
`mark_trials` rewrites results.jsonl under its lock. `Task(name)`: `spec` (task.json) and `status`
are re-read on every access; `set_status(**kw)` is a read-modify-write under `locks/<task>.status.lock` that adds
`updated_at`; `set_status_if(check, **kw)` writes only while `check(status)` holds under that
lock (a compare-and-set: `cli.reap`); never write status.json directly. `all_tasks()` lists task directories with a
task.json, oldest first, in `tasks/` only (`archived=True` adds `archive/`'s, for a question
about history: `wb backlog`, whose batches lost their older tasks and totals after 30 days, #270,
the audit of 1.2): `archive(days)` moves the tasks closed and untouched for
`ARCHIVE_DAYS` (30) to `archive/` and drops their locks, since every `wb wait` wake, `wb events`
minute and `wb start` read every task's two files (101 tasks in three days here, the 2026-11-19
audit); `task_dir(name)` falls back to `archive/<name>`, so `Task(name)` (wb status, report,
bench add) still finds one and its name stays taken. `read_jsonl_tail(path, max_bytes)`: the
whole rows in the file's last bytes (a cut first line skipped).

**task.json** (written by `wb start`; `wb next --test` rewrites `test_cmd`, `wb relocate` `repo`,
`git_common` and `cwd`): `name`, `repo`, `git_common` (the repository's own git dir, a real path,
which all its worktrees share: `gitops.repo_of` finds the repo there once `repo` is removed, #498),
`cwd` (the directory `wb start` ran in), `session` (when set: `CLAUDE_CODE_SESSION_ID`, the
Claude Code session whose Bash ran `wb start`; with `cwd` and `repo`, which session the task is
`mine` to, and `_scope`'s `--session`/`--repo`), `claude_pid` (when set: `CLAUDE_PID`, that
session's Claude Code process; once it is gone the directory rule adopts the task), `claude_start`
(with it: when that process started, `models._started`, so a recycled pid isn't it: #532),
`claude_machine` (with it: `store.machine()`; a process recorded on another machine is never gone
here, `cli._gone`, and the mod's `noteClaude` never asks of it: on a state directory two machines
share, each adopted the other's live session's tasks, back and forth, #922), `base` (the full sha), `base_ref`, `base_branch` (the branch
`--merge` lands on: the one checked out for `HEAD`, or `--base` when it names a local branch; null
on a detached HEAD, a tag or a commit), `branch`, `model`, `model_label`, `opencode_model`, `weights_id` (`models.identity`, when the server says: #726), `route` (the
router's reason), `size`, `stack`, `trial` (when set), `backlog` (`--backlog`), `bench` (a replay's `{case, run, label}`:
*Bench*), `test_cmd`, `no_base_check`, `unload_for_tests`, `sign` (false: `--no-sign`), `subdir` (a
monorepo package, *Instructions*) (each when set), `setup`, `setup_timeout` (with a setup, when
set: its limit in seconds, `--setup-timeout` or the repo's commands.json one), `copy`, `siblings` (when set: the
flags with commands.json `repos`, *Setting the worktree up*; `lib` one level up, `../../a/b` further),
`worktree` (when nested: the worktree's path in the task's directory, `tree/…/worktree`, #261), `checkout` (`"runner"`: the runner makes the worktree, `runner.checkout`; missing on a task from before #529, whose worktree `wb start` made), `checkout_bytes` (the checkout and `--copy` size `wb start`'s disk check measured: counted as taken until the runner has made it, and checked again before it does, #676; missing when the free space was unknown), `auto_fix`, `self_review` (true/false from the flags; null: learned), `ask_budget`,
`ask_timeout`, `checkin`, `round_timeout`, `silence_timeout`, `think_timeout`, `timeouts_given`
(which of `round`, `silence`, `think` a flag gave: the rest stretch, `runner.stretch_limits`,
#814), `test_timeout`,
`created_at`, `wb_version`, `experiments` (`{probe: true|false}`: what this task's agent has,
`context.task_experiments`; missing on a task from before them: all off). Read but written by no command: `stuck` (the guards' thresholds),
`deny_skills`. A missing key takes the runner's own default (auto-fix 0, think and
check-ins off), not `wb start`'s.

**status.json** keys and who sets them:

| Key | Meaning; set by |
|---|---|
| `phase`, `last`, `pid` | the phase; the last action in words; the runner's pid (cleared when it exits) |
| `parked` | when `wb stop --all` (/workbench-quit) stopped it, or `--park-waiting` parked it waiting on Claude; counted only while the phase is review, stuck or failed (`store.parked`, `store.PARKS`: #698), cleared by `spawn_runner` and `wb takeover` (#541) |
| `signalled` | when a SIGTERM that wasn't wb's stopped the runner (`SIGNAL_STOP`): a shutdown's tasks are batched by it (`runner._signal_notice`, #544) |
| `boot` | the boot the runner started in (`store.boot_id`: Linux's and WSL2's `/proc/sys/kernel/random/boot_id`, macOS's `kern.boottime`); `reap` reads another as a restart (#544) |
| `machine`, `host` | the machine the runner runs on (`store.machine()`) and its name (`store.host()`), written by `spawn_runner` and `drive`: another machine's runner, on a shared state directory, is never reaped, stopped or signalled here (`store.elsewhere`, #849) while its lock file beats |
| `beat` | `runner.BEAT_SECS`, written by `drive` (cleared by `spawn_runner`): the runner touches `locks/<task>.runner.lock` that often, and another machine's runner silent past `cli.BEAT_DEAD` is dead (#872) |
| `round`, `round_started_at` | the runner round (every kind counts); when it started |
| `limits` | `{think?, silence?, round?}` seconds: the limits no flag gave, raised before the round for a model measured slower since wb start (`runner.stretch_limits`, #814); null when none was |
| `steps`, `step_round`, `step_sizes` | `wb next`: the step number, the round it began, the closed steps' `results.step` |
| `step_tests` | `wb start` and `wb next`: each step's acceptance command, `{"<step>": cmd or null}`, which `wb bench add` reads (task.json's `test_cmd` is only the latest; before it, bench read the prompt's line, #941) |
| `step_base` | `wb next`: the worktree's HEAD as the step advanced, its commit or, for a step with no changes, the last one before it: what `wb verify` and `wb shot` compare the next step with (`verify._review_base`; without it, the newest earlier step's commit by its trailer, else the base: the step after a clean one refused both, #652) |
| `reviews` | review rounds in this step (`wb feedback` +1, `wb next` resets) |
| `auto_fixes`, `auto_fixes_total` | auto-fix rounds since the last review or step; earlier ones |
| `self_reviewed` | `[steps, reviews]` when the self-review round last ran (`tuned.self_review` on: once per review round) |
| `reviewed` | `{step, tree}`: the working tree the last review notice showed, a tree object (`gitops.snapshot`, bulky new files left out); the next review notice of the same step shows the diff since it (the whole diff once git gc pruned it, #795) |
| `tests` | `{ok, exit, tail, round, lane?, proxy?, hang?}` of the last test run (`exit`: a code, `timeout` or `output limit`; `lane`: the device nodes it was refused outside the lane, #331; `proxy`: the proxy variables the agent's environment left out, when the run failed on a connection, #380; `hang`: `{base, limit}`, a timeout of a command the base check ran in a quarter of the limit or less, #779) |
| `base_check` | `{ok, exit, tail, limit, secs, cmd}` of the acceptance command run once on the base, in the lane (`runner.base_check`; `exit` is `"timeout"` past `limit`, `"setup failed"` when its scratch checkout couldn't be set up, `"filtered"` when it isn't the task's bytes, #932); the runner, before round 1, only with `--test` and without `--no-base-check` |
| `infra` | why the machine, not the agent, failed the task: `setup` (`runner._prepare`), `model` (`_load_failed`: it couldn't load, or its server stayed down past `DOWN_WAIT`, or died again after a round's revive: #657), `crash`, `disk full` (the runner's crash handler), `runner died` (`cli.reap`); cleared at each runner's start. A replay with it is an `error` row, not `failed` (*Bench*, #508) |
| `prepared` | true once the worktree is set up (`runner._prepare`: `setup`, `copy`, `siblings`), so a later run of the runner doesn't again |
| `checked_out`, `checkout_secs` | `runner.checkout`: the worktree is made (task.json `checkout: "runner"`, #529); how long the checkout took |
| `taken_over` | `wb takeover`: Claude has had the worktree; `runner.checkout` then fails a task not checked out rather than remove it and check it out again (#655). Cleared by the hand-back (`spawn_runner`: wb feedback, next, resume) once the task is checked out, so the mod's `delegatedWork` reads its next review as the agent's again (#926) |
| `branch_made` | `runner.checkout`: the commit it makes `delegate/<task>` at, recorded before `worktree add` when no such branch exists; the only branch a cleanup of the checkout cut short deletes, and only there (#416, #529) |
| `setup_secs` | set with `prepared`: how long the preparation took, in the first report; what it left is the task's `prepared.json` (*Files and formats*: #867). A task prepared before that file has `prepared_paths`, `prepared_marks` (and `prepared_bytes`) here instead, which `runner.prepared_record` reads |
| `failed_before` | `setup` or `load`: the runner failed the task on its setup or its model's load before the agent ran (`_prepare`, `_load_failed`); the results row copies it (#581) |
| `stopping` | wb is stopping the runner (`cli._stop_runner`); cleared by `spawn_runner` and the runner's exit |
| `tools`, `tok_in`, `tok_out` | task-wide tool calls and tokens (input without cache reads) |
| `live_used` | `{session, used}`: the context the round's last `step_finish` carried (input + cache + output + reasoning, #644), what the between-rounds check uses when the session export fails (#262) |
| `gpu_wh` | the GPU energy its rounds used so far, in Wh (the runner's `_Power`, its share while tasks share the GPU: #706; absent for a remote model or no reading) |
| `gpu_w_sum`, `gpu_w_n`, `gpu_w_peak` | the same sampler's readings in watts: their sum, count and peak, for the row's `gpu_w` (*Stats recording*) |
| `speeds` | `{write, read, ttft}`: this task's own samples (`router.speed_samples`), the newest `TASK_SPEED_KEEP` 200 of each, with stats recording on |
| `guards` | `{<guard>: n}`: the guards that stopped its rounds, with stats recording on (*Stats recording*) |
| `opencode` | OpenCode's version (`M.m`) when `wb start`, `wb feedback`, `wb next` or `wb resume` last started the runner; `runner.opencode_moved` stops the task when it changes (#866) |
| `leased` | the pid of the runner that entered its GPU lease (`drive`): that runner, alive and not in gpu.json, stepped aside (its tests, a server's wait), and `cli._gpu_holders` doesn't count it a holder (#805) |
| `remote_gpu` | true when its model runs on another machine (set in `drive`): the results row carries it, and the savings say the energy wasn't measured |
| `unrecorded` | set with an accept's or discard's closing phase, cleared once its results row is written: `{outcome, step, extra}`, what a retried accept or discard writes the row from |
| `closing` | set by `wb accept` once its commit is made, before anything is removed, cleared with the phase: `{commit, step, merge, merge_into, merge_as, sign, merge_from?, merged_head?}` (`sign`: false after `--no-sign`, so a retry's merge is unsigned too; `merge_from`: the target's head, saved right before each merge attempt, from which a retry finds a squash already made, `gitops.squashed`, #432). The same status write saves the full object ID as `tip`. A retry uses that object and the original destination even if the delegate ref moved. A recovered refusal still exits 5. An interrupted accept recorded merged=false for a merge git had made, and stranded a last step with no new edits once its worktree was gone (#246, the audit of 1.2). While it stands (the phase not closed) the task is being accepted: discard, feedback, next, resume and takeover refuse it (`cli._accepting`, #878) |
| `grants_kept` | the task's grants (`{allow, paths}`), set when it closes, before its rules directory goes: what `context.grants` reads afterwards, for `wb bench add` (#250) |
| `session`, `sessions`, `session_mark`, `session_floor` | the OpenCode session; earlier ones; `gitops.mark` when it began; the context it had read at its first change |
| `context` | a one-round instruction: `fresh`, `keep`, `full` (a handover happened) |
| `full_pct`, `handovers`, `full_compacted` | the fill at the last mid-round handover; how many; whether OpenCode had compacted the session first (#774) |
| `window`, `load_secs`, `loads` | the model's context window; the load time, summed over every runner of the task (`wb feedback`, `next`, `resume`) and the reloads before later rounds (`runner._loaded`); each load that happened, alone (`[secs…]`: the typical load's samples, #577) |
| `tuned`, `explored`, `tuned_max` | the knob values this task runs at (`tuning.tune`) |
| `self_review_due` | true once a round's tests passed, so self-review could run, whether or not it did: the row says whether `self_review` could act (`tuning.acted`, #816) |
| `peak_share` | the fullest any of its sessions got, a share of the window (`runner.peak`: each `step_finish`, and each session export's last message), so the row says whether `fresh_at` could act (#721) |
| `steer_taken`, `nudges`, `nudged_round`, `checkin_at` | notes delivered; nudges sent; the round that ended in one; the last check-in |
| `active_s` | the agent's active work so far, in seconds: rounds less answers and a frozen machine (*Progress checks*) |
| `step_active_s` | `active_s` when `wb next` started the current step: the ETA and the progress checks count the step's work from it (#815) |
| `progress_checks`, `progress_mark`, `progress_open`, `interventions` | progress checks raised (this step's: `wb next` sets it to 0); the worktree's mark at the last; a check not yet answered; the steers that answered one, `[{kind, ts, round, step}]` |
| `skills`, `skills_ever`, `skills_rev`, `skills_told` | the handed set; every skill held; the library rev of each; what this session was told |
| `asking`, `agent_pid` | the oldest open question's id; the agent's pid while a round runs (cleared by `_end_agent`, or `reap`) |
| `tip` | the branch's tip at `wb accept` (or `wb gc`, for a branch merged before): `gitops.step_commit` and `_landed` read it once the merged branch is deleted; accept also keeps base..tip in the task's `steps.bundle` (`gitops.bundle_steps`), from which `wb bench add` restores every step's commit once git's gc has pruned it (#649, #799; before #799, and when the bundle can't be made, the ref `refs/workbench/accepted/<task>`, `gitops.ACCEPTED_REF`) |
| `branch_gone` | `wb gc`: the accepted task's branch is deleted (by it, or already gone), so later runs skip the task (`_merged_branches`, #686) |
| `accepted_ref_gone` | `wb accept` (the steps bundle made, so no ref) or `wb gc`: the task has no `refs/workbench/accepted/<task>` in the repo: deleted (moved into its steps bundle, or no longer needed) or never made, so later runs skip the task (`_released_refs`, #799) |
| `asks` | the runner's count of the task's ask files, `{id: "q" \| "p" \| "x"}` (question, permission request, refused): the budgets |
| `answered` | the question ids `wb answer` answered (written outside the lane, where an answer file the agent wrote itself isn't one): the Stats feed's `questions.answered` |
| `spec_gaps` | `[{round, text}]` from `--spec-gap` |
| `updated_at` | every write |

**events.jsonl** rows are `{ts, round, kind, …}`. From OpenCode, normalized (`events.normalize`):
`tool {tool, brief, ok, error?}` (`brief`: the input's command, path, pattern, url, query or
description, 90 characters; a skill's id), `text {text}` (2000 characters), `step {in, out,
cache, reasoning?}` (reasoning tokens apart from `out`, when any, #644), `error {text}`, `retry {text, attempt}` (OpenCode resending a request, #491). From the runner: `round`, `stopped {text}`, `steer {now, by:
"workbench"}` (a nudge), `interrupted`, `tests {ok, text}`, `skills`, `fresh {overflow,
compacted}`,
`autofix`, `self_review`, `reading_full`, `full`, `compacted {text}` (OpenCode compacted the session mid-round and it carried on, #774), `load` (the model reloaded before a round), `limits {text}` (the limits stretched for a model measured slow, #814), `left_bg {text}` (the round ended with a job still in the background, #658),
`round_end {secs, how, guard?}` (with stats recording on: *Stats recording*), `export` (the session export failed: judged by `live_used`), `stopped {by:
"signal"}` (a SIGTERM not from wb), `gpu {text}` (a warning from loading the model: a server wb
can't stop, a model partly on the CPU, a share Ollama couldn't keep), and relaying the agent's
questions `ask {id}`, `answer {id}`. From `wb`:
`spec_gap`, `next_step`, `stopped` (bail out), `resumed`, `allow`, `steer {now}`, `captain`,
`takeover`, `coding` (the user allowed Claude an edit), `error` (`reap`: the runner died without a report).

**results.jsonl** (`results.record`, on accept and discard): `ts`, `task`, `outcome`
(`accepted`/`discarded`), `model`, `size`, `repo`, `stack`, `subdir` (task.json's, a monorepo
package, when set: #820), `rounds`, `auto_fixes`, `reviews`
(every step's), `spec_rounds`, `tests_ok`, `minutes` (wall clock since `wb start`, queueing and
review included), `tok_in`, `tok_out`, `ran` (whether the agent ever got a request to its model, `results.ran`: a
session began or a token was written), `failed_before` (`setup` or `load`, when it never ran:
status's), `skills_offered`, `skills_loaded`, `skills_rev`, `experiments` (the
names on for the task, when any), `steps` (one `results.step` per step), `window`, `weights_id` (task.json's, when known: #726), `tuned`, `explored`, `tuned_max`, `peak_share` (status's, when recorded: `tuning.acted`), `self_review_due` (status's, false when unset: `tuning.acted`, #816), `spec_gaps`, `claude`
(when known: `spend.usage`, `{turns, calls, input, cache_write_5m, cache_write_1h, cache_read,
output}`, *What a task cost Claude*), `gpu_wh` (status's, when measured), `remote_gpu` (true
when its model ran on another machine, whose energy nothing here measures), `active_minutes`
(status `active_s`), `interventions` (status's, when a progress check was answered), `diff` (accepted only:
`{files, added, removed, generated?, deleted?}` summed over the steps, `generated` `{files, lines,
removed}` and `deleted` `{files, removed}` when a step had any (`gitops.footprint`, #725); *What a
task saved*), `landed_steps` (discarded only:
the steps `wb next` committed and the discard kept, when any; `steps_dropped` true after `--drop-steps`,
#722), `backlog` (task.json's), `trial` (when set);
with stats recording on (`results.for_stats`, each only when measured), `started_at`, `load_secs`, `setup_secs`,
`nudges`, `asks` (`{questions, permissions, refused, answered}`), `guards`, `speed` (`{write, read, ttft}`, the
medians of status `speeds`) and `gpu_w` (`{mean, peak}`); `commit` and `merged` on accept (and `merge_refused`, git's reason, when `--merge` was refused), `reason` on
discard. A step (`results.step`): `files`,
`lines` (added, against HEAD, new files included), `removed`, `window`, `landed`, `compacted` (its last
session, or one a handover replaced: a `fresh` event's `compacted`), `handovers` (fresh sessions
with overflow), `read_full`, `reviews`, `spec_rounds` (the step's rounds with a `--spec-gap`, a
gap given on the `wb next` or `wb accept` closing it included: measured before it was recorded,
it counted as the agent's review round in the slice, #904), `stuck`, `took_over`, and `claude` (that
step's share of the row's `claude`, `spend.usage_by_step`, same shape: only in a row of several
steps whose cost was split, #558).

**bench/cases/<case>/case.json** (`bench.add`): `name`, `task`, `step`, `repo` (where add ran
its git: `gitops.repo_of`, the task's checkout or, that linked worktree removed, its repository's
main one), `checkout` (task.json `repo`, the checkout the task ran in, which its `siblings` are
relative to: `bench._checkout` lays a replay's tree out and resolves them from that path, lexically,
even once that linked worktree is removed; from the main worktree, elsewhere, a replay's `../lib`
named the wrong place, #909's review; `repo` in a case from before the key), `git_common` (its
git dir: a replay's checkout, LFS objects, submodules and `--copy`
inputs come from `bench._repo`, the main worktree once `repo` is removed, #909), `base`,
`reference`, `size`, `stack`, `test_cmd`, `test_timeout`, `check_cmd`, `hidden` (paths, their
files in `hidden/`), `allow`, `paths` (the task's grants, from status `grants_kept` once its
rules are gone), `setup`, `copy`, `siblings` (its worktree's setup: #250), `setup_timeout`
(task.json's, or null), `unload_for_tests` (#735), `subdir` (the package it ran in, '' for the repo's
top: #425), `skills` (the original's), `original` (`model`, `rounds`,
`reviews`, `minutes`, `steps`), `base_check` (`fails` or `not checked (timed out)`),
`created_at`. **bench/runs.jsonl** (`bench.replay`): `ts`, `run`, `label`, `rep`, `case`,
`model`, `task`, `wb_commit`, `skills`, `outcome` (`passed`, `failed`, `preempted`, `error`:
it didn't start, or the machine broke it, `<infra>: <last>`, #508), `why`, and from the replay's status `phase`, `rounds`, `auto_fixes`, `tok_in`, `tok_out`,
`minutes`, `asks_refused`, `visible_ok` (its own last run of the acceptance command, before the
hidden files), `handovers` (fresh sessions). A `wb bench self` row (`bench.self_run`) has `arm:
"claude"`, `model` and `label` `"claude"`, `claude` (spend's usage shape), `turns`,
`claude_model`, `minutes`, `outcome` and `why`.

**Other formats.**
- `steer.jsonl`: `{ts, text, now}`. `acked`: a float timestamp as text, replaced whole
  (`store.write_ack`: a synced temp file renamed over it, `replace_bytes`), since the mod and `wb wait` read it every poll
  and a read between a truncate and the write saw 0.
- `ask/<id>.json`: `{id, ts, round, question, context, command?, path?}` (the agent's: the runner
  checks it); `<id>.answer`: the text (`ask_mcp.write_answer`), `NO_ANSWER` for one the runner
  dropped (timed out, its round ended, stopped, or its runner died).
- `lessons.jsonl`: `{ts, task, repo, skills, id, kind, round, text}`; a close is `{close: id, ts,
  how: "skill:<name>"|"dropped", why}` (*Lessons*).
- `speed.json`: `{"<model id>": {"write": [tok/s…], "read": [tok/s…]}}`, the last 60 of each.
- `stats.json`: `{recording, live, every, ts}` (`stats.py`, `wb stats set`): `recording` and `live`
  booleans, `every` 1, 2 or 5 seconds; a missing or mistyped key is its default (`stats.DEFAULTS`:
  on, on, 2). `set_setting` changes one key under `stats.lock`, the others kept: two picks at once
  each wrote back what it had read, and one was lost (#564).
- `gpu.json`: `{"<pid>": {model, task, since, start, uid, user, waiting?, waiting_since?, tests?}}` (`uid`, `user`: whose, for a lease shared by accounts, #393) (`tests`: true while a
  task's `--unload-for-tests` tests hold the GPU, `model` null then; `since`: its
  place in the queue, the task's `created_at`; `waiting_since`: on a waiting entry, when this
  lease began to wait, kept across its rewrites until it is admitted, for `wb top`'s `waited_s`
  (#573); `start`: the holder's start time, `/proc/<pid>/stat` field 22, else
  `ps -o lstart=` in UTC (macOS: #236, #848), so a recycled pid isn't taken for it; null when neither says).
- `scout.json`: `{done_at, notes, offered_at}` (`offered_at` from the mod); `watch.json`: `[{ts, text}]`.
- `update.json`: `{checked_at, behind, kind}` (`kind`: `marketplace` or `clone`); `checked_at`
  is written before the fetch, so a failed, timed-out or killed check waits a week too.
- `tuning.json`: `{"<knob>": value}`, a pin for every model.
- `notes.md`: one `- <note>` line each.
- The image sidecar: `{prompt, seed, width, height, engine, refs, secs, ts, format}` (`format`:
  png, jpeg or webp, as the file's first bytes say, #744).
- The chat files: *The web chat*.

## Installing

**Users** install from the marketplace (README's quickstart):
```sh
claude plugin marketplace add a-schaefers/claudes-workbench
claude plugin install workbench@workbench
"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/marketplaces/workbench/bin/wb setup
```
then `/workbench` in Claude Code, inside a project: the first time, the skill walks the first run
in order (`wb setup`'s checklist, `wb scout` and `wb model add`, `wb optimize estimate` then `start`, `wb try`, its
review and accept, the savings line; #113). `wb setup` ends with the `first run:` checklist, so
the quickstart no longer runs `wb doctor` itself. The plugin install copies only `mod/` (the marketplace entry's `source`) into Claude Code's plugin
cache, but `marketplace add` keeps a full clone of the repo under
`~/.claude/plugins/marketplaces/<the marketplace's name>` (`installLocation` in
`known_marketplaces.json`; elsewhere under `CLAUDE_CODE_PLUGIN_CACHE_DIR`). `wb setup` links `wb`
and the `/workbench` skill from that clone, so `wb` runs from the clone the way it does from a
developer's. Upgrading is `wb update` (or `/workbench-update`, which reloads the plugins after):
`claude plugin marketplace update workbench` pulls the clone (the links follow it), `claude plugin
update workbench@workbench` refreshes the mod. The mod runs `wb update --check --if-due` once per
session, so a new commit is noticed within a week.
`mod/.claude-plugin/plugin.json` has no `version`, on purpose: Claude Code then versions the plugin
by commit (the commit SHA of the installed directory), so a fresh install gets main as it is and
every merge to main is an update. A `version` there would hold every install on its cached copy
until someone changed the string (2026-11-18: that took a bump in every pull request, which
doesn't scale to outside contributors). `claude plugin validate` warns that it's missing; that's
expected. There is nothing to publish: main is the marketplace. A third-party marketplace doesn't
auto-update unless the user turns that on (`/plugin` → Marketplaces).

**Developing**: a clone, with the links pointing into it and the clone itself as the marketplace,
so the plugin, `wb` and the skill all read the working tree (the README's install until
2026-11-16):
```sh
git clone https://github.com/a-schaefers/claudes-workbench ~/repos/workbench
# to upgrade later: wb update (it pulls with --ff-only and refuses while tasks run), or stop
# running tasks first (wb stop --all), git -C ~/repos/workbench pull, then restart Claude Code (or
# /reload-plugins); the links and the plugin read from the clone, and your state and skills stay
cd ~/repos/workbench
mkdir -p ~/.local/bin ~/.claude/skills   # ~/.local/bin must be on your PATH
ln -s "$PWD/bin/wb" ~/.local/bin/wb
ln -s "$PWD/skill/workbench" ~/.claude/skills/workbench
claude plugin marketplace add "$PWD"
claude plugin install workbench@workbench
wb doctor
```
(`bin/wb setup` makes the same two links; `wb update` pulls with `--ff-only`, then the same two
`claude plugin` steps, since a path marketplace is copied too.) Moving from one to the other: `wb setup --force` from
the copy you want repoints the links; the state directory and the skill library don't move.

## The tests

Run from the repo root (`tests/__init__.py` makes `tests` a package; the other modules import
`tests.test_workbench`): `python3 -m unittest` (the whole suite, six modules; 24 to 28 minutes on
CI's Ubuntu at 24dfb6d, 7.5 at 594c0bc: its tests doubled in a day, #950),
one class or test with `python3 -m unittest tests.test_workbench.Context[.test_…]`, by name with
`-k handover`. The mod's tests: `claude plugin validate mod && claude plugin test mod`
(`mod/hooks/register.test.tsx`). The web chat in real browsers: `PLAYWRIGHT=…/node_modules/playwright
node tests/e2e_chat.mjs`.

**CI.** `.github/workflows/check.yml` runs `python3 -m unittest` and `claude plugin validate mod
&& claude plugin test mod` on every push to main and every pull request, on Python 3.11 (the
floor, through `actions/setup-python`: a 3.12+ API can't slip in) with the Claude Code the
mod was last verified with (`CLAUDE_CODE_VERSION`); `nightly.yml` runs the same once a day on the
newest Claude Code and the runner's newer python3, so a red nightly means a new release broke the
mod, not that main is broken. Its `macos` job runs the Python suite on macOS on Apple silicon,
Python 3.11, with OpenCode (`install-opencode.sh` takes this platform's asset, the
`darwin-arm64` zip, against its own pinned hash); its `wsl` job runs it in WSL2's Debian on a
Windows runner (Windows' own `wsl --install`, then `scripts/ci-wsl.sh`: dash as `/bin/sh`, as a
user who isn't root, a clone in WSL's own file system, OpenCode; no third-party action, which
the repo's settings refuse). Either failing turns the run red, and a release waits for a
green nightly on its commit (`docs/release-checklist.md`; the 2026-11-19 audit: the macOS job
could fail unseen and ran without OpenCode, and nothing ran WSL). The `macos` job is a matrix of
three shards (`WB_TEST_SHARD=K/3`: `tests/__init__.py`'s `load_tests` deals whole test classes,
largest first, to the lightest shard; discovery is sharded, and so is the package named,
`python3 -m unittest tests`, dealt once by the outermost `load_tests` (nested, it once sharded
twice and each shard ran about a third of its tests, the review of #950); named modules,
classes or tests run as named), each
`python3 -X faulthandler -m unittest -v`, so each test's name is in the log as it runs: unsharded,
it passed its 60 minutes and was cancelled on every run from d56ef5d on, and since unittest
prints failures only at the end, about 40 failures and an 18-minute hang were never reported
(#950). Every suite job (`check.yml`, `opencode.yml`, the nightly's three, through `WSLENV` and
`ci-wsl.sh` for WSL) sets `WB_TEST_HANG_SECS` (600): `tests/__init__.py` arms `SIGALRM` around
each test, and one still running then gets every thread's stack on stderr (`faulthandler`) and
fails with `TimeoutError: <test id> hung past WB_TEST_HANG_SECS (N s)`, its tearDown run and the
suite going on. Their limits are 60 minutes. The credential-read enforcement test requires Landlock, and the Snap launcher test requires Linux.
The killed-runner test checks immediate kernel cleanup on Linux and cleanup after reaping on both platforms. Neither is a required check:
each pull request would wait on a macOS and a Windows runner. Both Linux jobs install the OpenCode the real-OpenCode tests were last verified with (`OPENCODE_VERSION`,
from its GitHub release through `scripts/install-opencode.sh`, checked against the tarball's hash
pinned beside it as `OPENCODE_SHA256`: 2.x isn't on npm), so those tests run there instead of
skipping. `opencode.yml` runs the Python suite once a day on the newest OpenCode (the highest
version among the releases, not GitHub's "Latest", which marks the 1.x line's patches), so a red
run there means a new OpenCode broke the interop. The README shows all three as badges. A
newer push cancels a workflow's run on a branch, never on main (`cancel-in-progress` is off
there): shields.io shows a cancelled run as failing, and two merges a minute apart turned the
tests badge red with nothing broken (2026-11-19). The
exact floors are kept here; the README names only the ones a user checks (Python 3.11, git
2.34, OpenCode 2.3, `runner.OPENCODE_TESTED`'s floor, and a 32K window recommended, 16K the least: OpenCode's own
prompt is about 10K tokens, so a 16K task hands over almost at once; it said "OpenCode 2.x" and
"16K at least" until #273, the audit of 1.2) so it can't fall behind (2026-11-17, #102): Claude Code 2.1.287, the floor for mods, and the mod's own
`MIN_CLAUDE_CODE` (the `CLAUDE_CODE_VERSION` it is verified with), below which it toasts once per
load (`this Claude Code (<v>) is older than <min>…: claude update if they misbehave`, also when
`$.session.version` itself is missing) and carries on (the 2026-11-19 audit: an older one met a
call it lacks as a bare error); OpenCode 2.2.7, the oldest release that
passes the real-OpenCode tests (2.2.0 never lists `workbench_ask_reviewer`, found 2026-11-17);
Python 3.11 (before 3.14 `Path.exists`, `is_dir` and `is_file` raise `PermissionError` under a parent
this account can't read, where 3.14 says False: a probe of a path another account or an admin owns,
the shared lease, OpenCode's system and global config, PATH's `bin` directories, uses `os.path`, #850;
`tests.test_portable.UnreadableParents` holds 3.14 to the older behaviour); git 2.34 (`gitops.GIT_FLOOR`, Ubuntu 22.04's, where the fallbacks for `merge-tree
--write-tree`, 2.38, and `GIT_NO_LAZY_FETCH`, 2.44, are checked; `wb doctor` is BAD below it, and
the skill library no longer needs 2.28's `init -b`: #527, the audit of v1.90). Each Linux job's `Landlock`
step prints the runner's Landlock ABI, or that it has none and the Lane tests skip. `check.yml`'s
`Git LFS` step installs git-lfs when the runner image lacks it (the LFS test skips without it,
#382). The tests that hide credentials under the home directory also skip, saying why, when the home lies in a temp root (`home_outside_the_lane`: the lane writes those whole), and a profile without a git identity gets a scratch one for the run (the 2026-11-19 audit: Codex's clean profile under `/tmp` failed 11 isolation tests and seven on "Author identity unknown"). `chat.yml`
runs the browser test (WebKit and Chromium, through the Playwright pinned there as
`PLAYWRIGHT_VERSION`) on each pull request and push to main that changes `chat.py`, `webpush.py`,
`chat_static/`, the test or itself; it is not a required check (#91). Not run in CI: a real run
with a real model.
`.github/dependabot.yml` moves the actions' SHA pins weekly. `check` is the required check on
main (*Shipping to main*).

**Files.**
- `tests/test_workbench.py`: end to end, one class per feature (Lifecycle, Context, Steering,
  WorktreeSetup, Watch, AskServer, ConfigLayer, AgentContext, SkillLibrary, RealOpenCode, GitGuard, Lane,
  Permission, Images, Audio, Discovery, Routing, Tuning, Notes, Setup, Update, Projects, ModelSet,
  WebChat, ChatUploads, Hardware, Detector, SkillLearning, RealOpenCodeSkillFiles, RealOpenCodeRun, Drift).
- `tests/test_gpu.py`: sharing the GPU (side by side, taking turns, unknown VRAM, an exclusive
  holder, `wb start` refused or `--queue`d behind a holder, `wb image` refused or `--wait`ing,
  `wb audio` refused while a CPU engine runs beside a task, stale holders, a share Ollama couldn't keep), `can_share` (with `OLLAMA_MAX_LOADED_MODELS`) and
  the budget (driver groups, an iGPU's carve-out, Apple's default).
- `tests/test_portable.py`: discovery against real HTTP servers on port 0 (the Ollama probe, the
  port guess, multi-model servers, loopback and host names, `local: true`, `opencode.jsonc` under
  `XDG_CONFIG_HOME` and layered with `opencode.json`, provider filters and `{env:}` URLs, skipped
  providers, `/v1`, cloud models, API keys, a proxy, a down Ollama on another port,
  `CLAUDE_CONFIG_DIR`, aliases, a start command's paced probes), a server briefly away
  (`ServerAway`: tasks against a fake Ollama that answers 503 while a file exists: waited for at
  start and between rounds, a lost round run again, a config error still failing at once), the
  polling watcher (`watch._libc = False`), the launchers on an old Python or native Windows, fit,
  budgets.
- `tests/test_sizing.py`: the slice guess and its correction from real steps.
- `tests/test_workflows.py`: the merge gate, in plain text (no YAML library): every action pinned
  to a commit with its version, every workflow with its own permissions, `check` never
  path-filtered and required by the ruleset from GitHub Actions, the ruleset with no bypass, the
  plugin with no `version` (so installs track main), and `owner-merge.yml` approving only the
  owner's pull requests without running their code.
- `tests/test_docs.py`: the docs cover the code: every `wb` command and flag (from `cli.main`'s
  parser) in *Every `wb` command*, every module in CLAUDE.md's layout, every `WB_*` variable the
  code or the mod reads in CLAUDE.md, CLAUDE.md under 25,000 characters.
- `tests/fake_opencode.py`: the fake OpenCode; `tests/capture_llm.py`: a recording model server
  for real-OpenCode checks; `tests/e2e_chat.mjs`: the browser test.

**The fixture** (`Base`). A temp dir with `WB_HOME=<tmp>/state`, `WB_OPENCODE_BIN` = the fake
(a command line, split with `shlex`), `WB_FAKE_MODELS=1`, `WB_OPENCODE_CONFIG` (a fixture with
providers `ollama` on 127.0.0.1:11434 holding `mimo-v2.6:9b-q8_0`, which has a 32K
`limit.context`, and `qwen3.8-27b` with none; `strata` on :8080; `cloud` on a remote host that
discovery drops), `WB_MODELS`, `WB_SKILLS`, `WB_COMMANDS`, `store.config_lock_dir` patched to
`<tmp>/state/locks` (else the suite left its config locks in the user's `$XDG_RUNTIME_DIR`); a git repo `<tmp>/repo` on `main`
with README.md and a committed CLAUDE.md and a repo-local identity; a spec "Write the answer to
answer.txt."; the acceptance command `grep -qx 42 answer.txt`. `self.start(name, scenario,
*extra)` sets `FAKE_SCENARIO` and runs `wb start … --model mimo`. tearDown restores the env and
deletes the temp dir; it kills nothing, so a test stops its own `hang`/`slow` tasks.

**Helpers.** `run_wb(*argv)` runs `cli.main` in-process and returns stdout (a `die` is
`SystemExit`, its message on stderr: `assertRaises(SystemExit)` + `redirect_stderr`).
`wait_phase(name, phases, timeout=30)` waits until the phase is one of `phases` and the runner has
cleared its pid (so it can't wait for `running`: `running(name)` does, until the agent's pid is
set too). `wait_gone(pid)` waits for a process to end; `backdate(name)` ages the last status
change past `cli.REAP_GRACE`, for the dead-runner tests. `write_skill`,
`RealOpenCode.run_calls`, and per-class helpers.

**What's real.** `wb start` spawns the real runner (`python -m workbench.runner`), which runs the
fake through the real config layer, git shim and lane; real git, real worktrees, real tests, real
gpu.lock. `WB_FAKE_MODELS` short-circuits every model-server call (probe, status, weights,
residency, free_gpu, budget, need, Ollama's show/pull/delete, images' settle); `WB_FAKE_GPU_GB`
sets the fake GPU's size (unset: VRAM unknown, so no sharing). The runner keeps the env it was
spawned with: a `FAKE_*` change reaches only runners spawned later (feedback, next, resume spawn
new ones).

**The fake OpenCode** (`fake_opencode.py`). Handles `--version` (`FAKE_VERSION`, else
`opencode v2.3.0`: `wb doctor`, `wb start`), `run …` (prompt = last argument, `--session`
continues; it starts the config's workbench MCP server and lists its tools first, as OpenCode
does, unless `FAKE_NO_MCP`; a prompt starting with `-` without `--` before it prints the usage and exits 1, as
OpenCode does) and `session export <sid>` (a fixed export: one user message, one assistant message
with tokens `FAKE_FILL` or 1200, an edit of answer.txt 41 → 42, text; a compaction message when
`FAKE_COMPACTED`). It streams one JSON event per line (`step_start`, `tool_use`, `text`,
`step_finish` with tokens). It records each run's prompt to `FAKE_PROMPTS` and `{session,
prompt}` to `FAKE_RUNS`; `FAKE_LATE` pauses before its first event (a model reading its prompt),
`FAKE_SLEEP` after `step_start`; `FAKE_LESSON` adds a `Lesson:`
line; `FAKE_BG` (a file) starts a `sleep` in a session of its own, left running, and writes its pid
there (what `sweep` must end); `FAKE_STRAY` first prints lines that are JSON but not events
(`42`, a list, `null`) and events whose parts have the wrong shape; `FAKE_SURROGATE` first
a `read` and a `text` event carrying a lone surrogate escape; `FAKE_LATIN1` first a line
that isn't UTF-8; `FAKE_LINGER` closes its
output after its last event and stays alive; `FAKE_EXIT` exits with that code after its last event
(a crash after words or an edit). Scenarios (`FAKE_SCENARIO`): `ok` (writes 42), `fix` (41 in a new session, 42 when
continued: an auto-fix round passes), `loop` (the repeat guard stops it), `hang`, `crash` (exit 1,
no events; with `FAKE_DOWN`, a file, it creates it the first time, taking the model server down
with it, and runs like `ok` after), `crashtalk` (like `crash` after a `text` event; with `FAKE_CRASH_HANG` silent instead of exiting: #657), `devserver` (writes 42, a `shell` call with `background: true`, a `stop` step, then `background_wait` on `npm run dev` for an hour: #658), `slow` (hangs in a new session, ok when continued), `fill` (a 25K-token step at 76%
of 32K, then sleeps: the runner hands over mid-round; the handover prompt turns it into `ok`),
`read` (25K tokens before any change: it carries on), `floor` (a re-read floor too high to hand
over: `HANDOVER_ROOM`), `refill` (every session changes a file, then fills: `HANDOVER_MAX`),
`compact` (writes 41, a step at 52%, then one at 15%: compacted between them, #774; it hands
over, or with `FAKE_COMPACT_READ`, a 50% reading floor, carries on and writes 42),
`bgwait` (a `background_wait` line, then `FAKE_BGWAIT` seconds, 6, of quiet, then `ok`),
`toolhang` (one tool call, then silent), `retry` (a `retry` line every `FAKE_RETRY_EVERY`
seconds, 1, as OpenCode prints it cutting each request at the provider timeout). 
`say` (a few words, no tool call). 
`session list` lists nothing. Both session commands fail
without `--standalone`, as the real ones do when another service holds the managed port. Its
live tool names are 1.x-style (`bash`, `filePath`); real OpenCode 2.x says `shell`, `path`
(`events._brief` reads both).

**Real-OpenCode checks** (`RealOpenCode`, `RealOpenCodeSkillFiles`, `RealOpenCodeRun`, skipped
without `opencode` on PATH; the lane ones also need Landlock, `lane.abi()`). `capture_llm.py
<port> <out.jsonl> [calls] [prompt tokens]` is an OpenAI-compatible server that records every
request and answers each request that offers tools with the next scripted tool call (`{"name",
"arguments"}`), so a test sees what OpenCode does with it. Every answer reports `prompt tokens`
read (default 1), so a test can fill the window without sending it; a request carrying OpenCode's
compaction template (`<template>`, `## Objective`) gets the template's headings back, which
OpenCode accepts as a summary (anything else fails the compaction: `compaction.failed`).
`RealOpenCode` and `RealOpenCodeSkillFiles` cover the MCP shape, skills, denials, compound shell
commands, rule order, git by path, the edit rule, PATH and the lane; `RealOpenCodeRun` the
events, the export, `--session`, compaction and the header wait (CLAUDE.md's *OpenCode quirks*
points here).
With `CAPTURE_HEADER_DELAY=<seconds>` every POST waits that long before its headers: RealOpenCodeRun
sets the user's `headerTimeout` to 2 s, below a 4 s delay, and the task still answers (#491). `run_calls(name, calls, *start_flags)` starts a task, points its config
layer at the capture server, runs `opencode run --auto` in the worktree through `agent_env` and
`lane.wrap`, and returns the task and the tool results, in order. Refusals read `permission.rejected` (a
rule), `external_directory` (the file tools, the workdir) or `Permission denied` (Landlock).
`RealOpenCodeRun` is the runner itself on real OpenCode, for what the fake only imitates: its
own XDG config, data and state (a `cap` provider in its config, sessions in the test's temp dir),
`wb start --model cap`, and the capture server writing `answer.txt`. It checks the argv (the round
passes its test), the `run --format json` events (`sessionID`, the `tool_use` row's tool and brief,
`step_finish` tokens, the text), `session export` (`context_state`, `wb watch --once`),
`session list` by title (`find_session`), `--session` (a `wb feedback` round's request carries
the first round), and a full window then a real compaction (`fresh_reason` says full, then
`COMPACTED`; `wb watch` shows it). These tests are the only checks of the OpenCode quirks, the
interop and the lane: a skip is not a pass, so a change to `context.py`, the config layer,
`gitguard.py` or `lane.py` needs them run where they don't skip (CI does, except the lane where
the runner lacks Landlock). A change to how the runner invokes or reads OpenCode updates
`fake_opencode.py` in the same commit, `RealOpenCodeRun` if it reads something new, and needs one
real run with a real model (CLAUDE.md, *Checks before committing*).

**The browser test** (`e2e_chat.mjs`): the real `bin/wb chat serve` on port 13371 (`WB_E2E_PORT`) against a temp
`WB_HOME`, a fake listener claim, WebKit as an iPhone 13 and Chromium (`$CHROMIUM`, else
`/usr/bin/chromium` when it exists, else Playwright's own) as a
Pixel 7: the token leaves the address bar, a send lands once with its tick, the receipt, "working"
then the reply, a message sent during an outage lands exactly once, the stream recovers, a
reload doubles nothing, a permission prompt's card (Allow at least 44 px tall, a tap answers it,
the buttons go) and one left to expire, a long plan folded and sent back with a note, a settled plan cut and fetched whole on unfolding (#755), a question
answered (Answer disabled until a pick), the gear's sheet (what this lane is; Let Claude go
ahead saved, the next prompt allowed at once and listed), a reload whose state is slow to come (the last thread, "connecting…"; Chromium only, as
Playwright's WebKit routes no requests once a service worker is registered), the install only
over https (no manifest link over localhost; a keyed one on an https origin routed to the server),
the app (its worker runs and holds the
key; the gear sends the install to https; notifications offered, or on iPhone sent to the installed app), what a page
showed while in use reported to `/api/seen`, and not while only on screen (`hasFocus` false,
#537), a server frozen (SIGSTOP) past the 40 s watchdog and then
let go (the page heals with no reload; a message sent meanwhile lands once), a changed page file
(the page reloads itself, keyed, with the thread), wb shot's pair, `wb chat listen`'s shortlist
(each take plays from its blob with its length and check line, and Keep sends the pick with its
take, the composer's draft untouched: #397), the phone keyboard (a swipe down or a tap on
the thread puts it away, a tap on the composer or a button doesn't: touches made by hand, Chromium
only, since no headless browser raises a keyboard; once it is down the composer is back at the
foot), a message over 6 h unread (not passed to Claude, never "Delivered", *send again* lands a
new one), an attachment (a photo picked, the page reloaded before sending: the chip is back and it
was uploaded once; sent, one message with one path reaches `wb chat pending`, its thumbnail opens
whole) and one refused on its chip (over chat.json's `upload_mb`, then dropped with ✕; the test's
own `WB_CHAT_CONFIG`), no script errors; and once, in node (`swSays`: `sw.js` in a `vm` against a
given state, since no browser here shows a push), a push's text: Claude's newer reply over an older
or stale prompt, a newer open prompt over the reply (#538).

**Conventions for a new test.** Names read as sentences (`test_a_note_does_not_swallow_a_failure_claude_has_not_seen`);
one class per feature with a one-line docstring; end to end through `self.start`/`wait_phase`/
`run_wb`, asserting the phrases Claude reads and the state files; real processes and servers on
port 0 rather than mocks (only `chat.tailscale` and Hardware's probes are mocked); a regression
test cites the incident and its date; task names `t-<slug>`; a new fake behaviour is a new
`FAKE_SCENARIO`; anything that depends on OpenCode goes through `run_calls`; kernel-specific
tests `@unittest.skipUnless(lane.abi(), …)`; reuse helpers by import or assignment, never by
subclassing a class that has tests; new classes go above the `__main__` block (each module also
runs as a script).

**Not hermetic.** The real HOME is used (`~/.claude/CLAUDE.md` enters task instructions; the lane
tests make and remove `~/.wb-sec-test-*`, `~/.wb-lane-test-*` and `~/.wb-sock-*`, and each task's
`/tmp/wb-run-<uid>-<hash>`), the real-OpenCode tests use OpenCode's own session
storage, test_portable probes 127.0.0.1:11434, `wb scout` reads the real hardware. It never
touches the real state directory, gpu.lock or a model, so it's safe beside running tasks.

## Shipping to main

Ported from backseat-driver (2026-11-16), which has run it since 2026-10-10. main takes no direct
push: every change is a pull request that merges once `check` is green and it is approved.

A new `.md` file in the repository's root is never committed by accident: `.gitignore` ignores
`/*.md` but README.md, CLAUDE.md, ARCHITECTURE.md and THESIS.md, so a scratch note (an
experiment's steps, a draft) stays local. A root file already tracked (an audit's FINDINGS.md, until its fixes ship) stays tracked, and
nested `.md` files (`docs/`, `skill/`, `mod/`, `agent/`) are unaffected. A new root doc needs its own `!/` line.

- **The ruleset** (`.github/rulesets/main.json`, on the default branch): no deletion, no force
  push, a pull request with one approval (stale approvals dismissed on push), and `check` green
  from GitHub Actions (integration 15368, so a status posted by anyone else doesn't count). No
  bypass actor: the owner and every agent get the same rule.
- **Auto-merge for the owner only.** `.github/workflows/owner-merge.yml` (`pull_request_target`)
  approves a pull request whose author and event sender are both user id 26800291 (a-schaefers;
  ids, since a login can be renamed and taken), from this repository, not a draft, at the head it
  was woken for, then arms auto-merge if nobody has. Claude sessions open pull requests and push as
  the owner, so they count as the owner. Anyone else's (other people, Dependabot, forks) waits for
  the owner's approval by hand; so does the owner's own after someone else pushes to it. A draft
  is how the owner holds one back. It runs main's copy of the file and never the pull request's
  code: no checkout, no `uses:`, nothing from the event in a shell but numbers, the head hash, the
  repository and the token (`tests/test_workflows.py` holds it to that).
- **Who arms auto-merge** decides whether main gets its own `check` run: a merge armed with the
  workflow's token is GitHub Actions' push, which starts no workflow. So `scripts/ship.sh` arms it
  as the owner; `owner-merge.yml` arms it only when nobody has, and then the nightly is main's only
  run.
- **`scripts/ship.sh`**, the one road to main: from a branch or a worktree (a detached HEAD ships
  as `agent/<worktree>`), it pushes, opens the pull request or finds the open one, arms auto-merge
  as you with `--match-head-commit`, and waits for the merge or names the failing check. It
  refuses to ship from main and acts only on this repository's own pull request at the commit it
  pushed. `--title`, `--body-file`, `--squash`, `--no-wait`, `--draft`. A red check leaves
  auto-merge armed: fix, commit, run it again.
- **`scripts/github-settings.sh check|apply`** keeps the repository's settings in git (`check`
  names any drift, `apply` writes them; `gh` as admin): the ruleset; Actions may approve pull
  requests, the default token read only; auto-merge, merge commits, delete branch on merge, update
  branch; only GitHub-owned and verified actions, each pinned to a commit; a fork's workflows wait
  for approval every time; secret scanning with push protection; Dependabot alerts and security
  fixes. The first time, `owner-merge.yml` must be on main before the ruleset is applied, or the
  owner's next pull request has nobody to approve it.
- **The emergency door**: when `check` itself is broken and its fix can't pass it, the owner sets
  the ruleset's `enforcement` to `disabled` (Settings → Rules, or the JSON and `apply`), merges the
  fix, and sets it back (`check` shows the drift if that's forgotten). Never a bypass actor.

## Couplings: change one, change the other

- **A file a round's children load** (the lane, the git shim, the ask server, and what they
  import) → `runner.CHILD_CODE`, so an update under a running task is caught (*The runner, inside*).
- **An experiment** (`context.EXPERIMENTS`) → its effects (`shell_rules`, `EXPERIMENT_NOTES`),
  `task_experiments` (when it can work), `cli.experiment_lines`, the pane's Settings row
  (`PROBE_STOPS`, `probeMode`, `probeStatus` and `probeSaid`, which read `experiment_lines`' wording,
  `PROBE_SETUP_NOTE`), and *Experiments*.
- **What a handoff costs Claude, measured** → THESIS.md (the case for users, with the same
  numbers) and the README's sentence on it, which links there.
- **Anything a reader looks up** (a command, flag, default, guard, key, file, prompt text,
  environment variable) → this file, CLAUDE.md if it names it, and the skill
  (`skill/workbench/SKILL.md`) if Claude uses it there; README only for the quickstart. CLAUDE.md's
  *Keeping the docs true* is the procedure; `tests/test_docs.py` checks what it can (every command
  and flag here, every module and environment variable in CLAUDE.md, CLAUDE.md's size).
- **`wb image` and `wb audio` share `media.py`** (the engine file, `problem`, `ready`, `auth`, `post`, `fill`, `settle`, `gpu`, `on_gpu`, `shares_gpu`, `cards`, `serving`,
  `free`, `publish`): a change there changes both (`tests.Images`, `tests.Audio`). A new kind of
  generated media → its config path in `store.PATH_VARS` and `context.private_paths`, its output
  directory in `cli.EVENT_SKIP` (and the mod's ears), its engines in `wb scout`.
- **`models.same_gpu`** (a remote server on this GPU, #750) → every place that tells this GPU's
  models from another host's: `pool`, `on_this_gpu` (`free_gpu`, `_others_resident`),
  `releasable`, `make_resident`, `GpuLease.step_aside`/`_unload_unshared`, `optimize.busy` and its
  per-server lease, `runner._tests_gpu` (by the lease's pool), `media.boxes` and `media.shares_gpu`. One left out
  takes a second lease on `gpu` in one process (it waits on itself) or leaves a model loaded.
- **`models.BOX_QUIET` and `BOX_WAIT`** (a wb remote box's turns, #812) → OpenCode's 2-minute
  move of a shell command to the background (`BG_GRACE`), which bounds the gap between a round's
  requests, and `router.ROUND_DEFAULT_S`, a round's default limit; `wb start`'s note names both;
  `media.turns` waits on `box_quiet` too (#944).
- **`progress.DEFAULT_MIN` and `TYPICAL_MIN`** → the pane's Progress checks sentence
  (`PROGRESS_STOPS` in `register.tsx`), which names them (#724).
- **`ask_mcp.NO_ANSWER`'s opening** ("No answer arrived in time.") → the mod's `NO_ANSWER`, which
  tells a question that timed out unseen from one answered (#542).
- **How wb reads a path variable** (`store.absolute_env`, `home()`) → the mod's `absolutePath`,
  which reads `WB_HOME` and `CLAUDE_CONFIG_DIR` the same way (#454).
- **A process wb leaves running** (a runner, the bench driver, `wb optimize`, the chat `wb chat
  on` starts) → started through `cli.detach` (its own scope where logind kills sessions: #531),
  with `awake=` when it runs unattended (*Kept awake*, #516), and named in `cli.logout_stops`' lines.
- **A file in a task's directory** → `context.TASK_FILES`, the names a `--sibling` can't take
  (its link sits beside the worktree).
- **Where a task's worktree is** (`Task.worktree`, `tree/…/worktree` for a sibling further up,
  #261) → `gitops._record` (the git pin), `spend._theirs`, `EVENT_SKIP`, the mod's
  `codingRefusal` pattern.
- **A prompt's opening words** (the heads in *The runner, inside*) → `transcript` labels,
  `round_asks`, `lessons`, the fake OpenCode, and the tests that quote them.
- **Where a round's own prompt is** (`instructions.md` once `_start_fresh` makes prompt.md the
  handoff) → `store.round_prompt`, which `current_task_prompt`, `round_asks`, `lessons` and
  `bench._step_prompt` all read it through (#503).
- **A task.json `bench` key** → `Task.notify`, `results.record`, `cmd_status`, `_preempt_bench`
  and the mod's task listing (register.tsx) all leave a replay out of real work; the Bench tests
  and the mod's replay test.
- **`cli.PROTOCOL`'s acceptance line or fold, or `wb next`'s step opening** → `bench.py` reads
  them back out of old prompts (`TEST_LINE` for a task without status `step_tests`, `FOLD`, `STEP_HEAD`); the trailers `wb next` and
  `wb accept` write → `gitops.step_commit`, which finds them from status `tip` once the merged
  branch is gone, in commits `bench add` restores from the task's `steps.bundle` (#799): what
  `bundle_steps` packs (base..tip) must hold every step `step_commit` looks for.
- **The mod's wake opening** (`` [workbench] Task `<name>` ``, register.tsx) **or Claude Code's
  transcript rows** (`type`, `isMeta`, `isCompactSummary`, `message.id`, `message.usage`, a Bash
  `tool_use`'s `command`, `timestamp`, `subagents/`, the line before a plugin's message) →
  `spend.py` (`WAKE`, `_prompt`, `calls`) and the ClaudeSpend tests' rows.
- **`wb next`'s `next_step` event** (its `ts`, written after the step's commit) **or the
  results row's `steps` count** → `spend.usage_by_step` (where each step's cost begins),
  `results.record` (which writes it per step) and `bench.handoff_cost` (which reads it, #558).
- **`cli.PROTOCOL`** → the transcript's fold marker `\n---\nHow to work`, the `Lesson:` parser,
  the handbook (they shouldn't contradict), and every agent's prefill (keep it short).
- **`agent/HANDBOOK.md`** → every agent prompt carries it; each token costs prefill time.
- **How OpenCode is invoked or read** (`run_round`'s argv, the event fields `normalize` reads, the
  export fields `context_state`, `measure_speed` and `transcript` read) → `tests/fake_opencode.py`
  in the same commit, `RealOpenCodeRun` for a field it doesn't check yet, and one real run
  (`wb start --trial`, CLAUDE.md).
- **A model server's API fields** (`models.server_facts`: LM Studio, llama-server, vLLM/SGLang;
  `ollama_served_context`, `weights` for Ollama) → the `Real` tests in `tests/test_portable.py`
  that imitate them, and *Running your own server* where it says what each server needs set.
- **The status keys and event fields `wb top` reads** (`live_used`, `window`, `round`,
  `round_started_at`, `load_secs`, `last`; a `step` row's `ts`, `round`, `out`; gpu.json's
  `waiting`, `since`, `waiting_since`) → `top.py` and the Top tests; its `--json` shape → *wb top* here.
- **A git call on a task's worktree** → through `gitops.git` (pinned to the recorded git dir, no
  hooks), never `git -C <worktree>` by hand; parsed output → a porcelain or `-z` form.
- **Permissions or the config layer** (`context.py`, `write_config_layer`) → the real-OpenCode
  tests, run where they don't skip.
- **The lane** (`context.writable`, `readable`, `SECRETS`, `lane.py`) → the Lane and RealOpenCode
  tests on a Landlock machine; the protocol's lane line and the handbook's boundaries. What it
  leaves writable that runs later outside it (`TOOL_HOMES`, `NOT_WRITABLE`) and what WSL's
  interop runs outside it (`windows_drives`, `agent_path`, `interop_gap`) → the lane's *Writes*
  and *Reads* here, and `wb doctor`'s line.
- **`wb update`'s flags or output** (`--check --if-due`; `update available…`, `updated …`) → the
  mod's weekly check, which toasts only an `update available` answer, and `/workbench-update`, which
  reloads the plugins only after an `updated` one (register.tsx `poll` and the `UPDATE` command).
- **A file the runner or wb reads from the task directory, or one the ask server writes** → keep
  the lane's part of it to `worktree/` and `ask/`, and have the runner check what comes from there
  (`ask_mcp.relay`): nothing the agent writes may steer code outside its lane.
- **The layer's `permissions`** → they go twice, in the file and as `OPENCODE_CONFIG_CONTENT`
  (`rules_env`): keep them under `CONFIG_CONTENT_MAX`, or the fallback drops AGENTS.md. A new
  layer key a project config mustn't change goes in `RESTATED` too.
- **`wb watch --json`** (a style, the order, the activity wording) → the mod's `LINE_STYLE`, its
  pose regex, the `live-1` tag; `--last` and `JSON_LINE_CHARS` with the mod's `KEEP_LINES` and
  `LINE_CHARS`.
- **A `$.state` atom's type** in the mod → its tag (`tasks-8`, `live-1`, `chat-4`, `sessions-1`, `savings-1`, `pane-1`, `stats-1`, `top-1`, `said-1`).
- **The Claude coding choices** (`cli.CODING`: modes, labels, sentences) → the mod's
  `CODING_STOPS` (the Settings row) and `CODING_RULES` (the context block), and the skill's *Claude
  coding* bullet.
- **`savings.totals`' keys** → the mod's `savedLine` and the chat page's `drawSaved`, which read them;
  how the cost is labelled (no currency sign, #609, #845) → `wb savings`, the pane's Stats tab and
  `savedLine`, and `drawSaved`, alike.
- **Which session a task is** (task.json `session`, else `cwd`/`repo`) → the mod's `mine` and
  `cli._scope` (`--session`, `--repo`): the same rule, the home-or-`/` exception included, and
  the mod's `scope()` passing every id it has.
- **A notice kind or its text** → the mod's `HEADLINE` and `NEXT`, `_ack_all`'s still-true rule,
  the mod's still-true rule, `wb wait`.
- **A task.json or status key** → *Files and formats*; a key the router, tuning or skills read from
  results → `results.record` and the readers' defaults for old rows.
- **The GPU admission rule** (`models.admits`, `can_share`) → the lease, `wb start`'s refusal and
  the feedback/next/resume note (`cli._gpu_holders`, `_gpu_note`), and the Sharing tests. **A new
  event kind** → `transcript.task_entries` and `transcript.EVENT_KINDS`, which `wb log` prints
  from too (an unknown kind is never shown: `reading_full`, `resumed`, `spec_gap` and `coding`
  were missing from `wb watch` and the pane, #846, and the runner's own from `wb log`, #861) and
  *Files and formats*. `Watch`'s test of every kind takes them from the code's own
  `.event({… "kind": …})` literals and checks each is in `EVENT_KINDS` and shows its text (or is
  one of the few with a fixed line): #846's hard-coded list missed `compacted`, `limits` and
  `export`, which `wb watch` and the pane then dropped (#865).
- **A new tuned knob** → `tuning.KNOBS`, read with `tuning.value(task, name)`, a ceiling in
  `drive` if it has one.
- **`chat.py` or `chat_static/`** → the browser test (`chat.yml` runs it on the pull request too).
- **`/api/state`'s asks or messages** → `sw.js`, which builds the notification from them.
- **A message's `about`** (a pair's `{task, n, step, round}`, a kept take's `{audio, n, name, path}`) → the mod's prefix for it in `listen` (register.tsx), the page's `aboutTag` and `aboutBody`, and `/api/send`'s check, which fills it in from the pair or the batch (#99, #397).
- **`wb chat ask|wait|answer`'s output** (`<id> <state>` on the last line, `wait --json`'s ask) → `askOnChat` and `waitOnChat` in register.tsx, which parse it.
- **AskUserQuestion's or ExitPlanMode's input shape** → `askOnChat` (`--detail`) and `makeAsk` in app.js.
- **The `$` uses in `register.tsx`** → only through functions declared at its top level, or
  `claude plugin validate mod` fails.
- **The Claude Code version** the mod is verified with → `CLAUDE_CODE_VERSION` in
  `.github/workflows/check.yml` and the mod's `MIN_CLAUDE_CODE` (raise it when the mod starts
  using a call a newer Claude Code added) and `register.test.tsx`'s `TESTED`; the floor it needs → *The tests* (the README names no Claude Code version).
- **The OpenCode version** the tests are verified with → `OPENCODE_VERSION` and `OPENCODE_SHA256`
  in `check.yml` and `nightly.yml` together; the floor → *The tests*, and the "checked against"
  lines here and in CLAUDE.md; a newer range verified → `runner.OPENCODE_TESTED`.
- **OpenCode's own prompt size** (re-measured with `capture_llm.py` after an OpenCode update or a
  change to `DENIED_TOOLS`) → `context.OPENCODE_BASE_TOKENS`.
- **The Python floor** (3.11) → the launchers' guard (`bin/wb`, `bin/wb-ask-mcp`), `check.yml`'s
  and the `macos` job's `python-version`, *The tests*, the README's *What you need*. A new
  OpenCode major → the README's *What you need* too.
- **The merge gate** (`owner-merge.yml`, the ruleset, `check.yml`'s job name) →
  `tests/test_workflows.py`, `scripts/github-settings.sh apply`, *Shipping to main*.
- **`mod/` for users** → nothing: plugin.json has no `version`, so every merge reaches them
  (*Installing*); adding one would freeze them on it. **A release** (by hand, when the owner
  calls it one) → `__version__` in `workbench/__init__.py` (`wb --version`, task.json's
  `wb_version`, the ask server's `serverInfo`), `docs/release-checklist.md` filled in as
  `docs/releases/<version>.md` (a green nightly on the commit, every command the README offers
  run at the tagged commit (#422), the platforms by hand and the release evidence (#482), each
  run recorded against the candidate: its SHA, OS, filesystem, versions, hardware, result and
  skip reason; best effort, a skip is not a gate), then a
  `v<version>` tag (a trailing `.0` dropped, as `v0.90`) and a GitHub release (`gh release create
  v<version> --generate-notes`, its notes linking the filled-in checklist). **`wb setup`'s links** → README's quickstart and
  *Installing*.
- **A model name** → never in code or the skill: models come from OpenCode's config, choices from
  the router and the weekly check.
