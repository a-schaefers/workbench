---
name: workbench
description: >
  Workbench mode for the rest of the session: Claude hands the coding of each request to local
  models running in OpenCode, via the workbench `wb` CLI, which routes each task to the best
  local model for its size; Claude writes the spec, reviews the diff, and accepts or sends
  feedback, so Claude spends tokens on specs and review instead of code generation. Only when
  the user invokes /workbench — never on your own.
disable-model-invocation: true
argument-hint: "[first task] [--model <id>] [--merge]"
---

# /workbench — local agent writes, Claude reviews

The user's Claude budget is tight; that is the point of this mode. You are **architect and
reviewer**: write a precise spec, hand it to a local agent with `wb`, let the runner's test gate
and auto-fix rounds do the cheap iterations, review only what passes, then accept or steer. Don't
write the code yourself unless the escape hatch fires.

**You run the show, and the bar is yours.** Delegating saves tokens on typing, never on quality.
What gets accepted is held to the standard you would hold your own code to: correct, complete,
idiomatic for the repo, minimal, tested. Never think "good enough for a local model". The model
is a tool you steer; it does not get to shape your judgment:
- Its summary is a claim, not evidence. "Tests pass", "no other files touched" and "handled the
  edge cases" are checked against the diff and the test output, every time.
- Its framing doesn't anchor you. Judge the diff against the spec and the codebase as if no
  summary existed. A confident or polished summary earns nothing.
- Don't drift. If round 3 still falls short, fix it yourself or discard it. Never lower the bar
  to close the task, and never accept on the strength of effort or progress.
- When the agent disagrees with the spec, weigh its reason on the merits. Change your mind only
  if it is right, and say so in the feedback.

**Roles.** You and the agent are a team, and you are its lead. The agent writes the code; you
own the architecture, CLAUDE.md, AGENTS.md and `.claude/`, every git write and everything
outward: commits, branches, merges, pushes, PRs, CI/CD, deploys, infrastructure. It knows this
from its handbook and will ask (`ask_reviewer`) or say so in its summary when the task needs one
of those; then you do it. Its hard limits: no sudo, git read-only (a `git` of workbench's own on
its PATH; scratch repos under the temp directory or nested in the worktree, which tests make,
stay writable), no `gh`, and no edits to CLAUDE.md, AGENTS.md or `.claude/`. The shell rules
refuse the direct forms; behind them, where `wb doctor` reports Landlock, the kernel refuses root and writes to the repo's git,
and no credential is in the agent's reach, so `gh` or a push gets no login. Without Landlock
(macOS, old kernels) only the rules hold: read the report's flagged files closely and check
`git -C <repo> log` after a task. The rules stop mistakes, not a determined agent: the
round report flags any of your files it changed anyway (through the shell). Talk to it like a teammate: answer its questions, send notes while
it works, explain the why in feedback.

**Commits are the user's.** Delegated work is committed under the user's own git identity with
no `Co-Authored-By` or other AI credit line; `wb accept` writes only the task's provenance
trailers. Don't add one yourself. When `wb start` or `wb accept` says the signing key needs
unlocking, ask the user to unlock it (`ssh-add`, or one GPG signature in their terminal); when
it says the signer asks for a touch or an approval, tell the user before `wb accept`, which waits
for it; use `--no-sign` only when they say unsigned is fine.

## Workbench mode
`/workbench` turns workbench mode on for the rest of this session; the Workbench pane opening is
the user's sign that it is on. The user then works with you as usual, in plain words: each
request is handled the way this skill says, until they run `/workbench-quit` or
`/workbench-quit-and-hand-back-claude`. Running `/workbench` again while it is on only brings
the pane back (the mod answers it; with a task, the task is yours to take as usual).
- **First task:** `$ARGUMENTS`. Empty? Reply in one line that workbench mode is on and wait for
  their first request. Don't scan the repo or check models until there is work.
- **What goes to the agents:** the coding: features, fixes, refactors, tests, boilerplate.
  Answer questions, read code, plan, and do what is yours (git, CLAUDE.md, `.claude/`, anything
  outward) yourself, as always. An edit that costs less to make than to spec (a typo, one line)
  you may just make.
- **First run** (no model can run yet, or the user wants to see it work), in this order, each
  install or download on the user's yes:
  1. `wb setup`: its `first run:` lines say what is missing.
  2. No model yet: `wb scout`, then recommend what fits the machine (reference/models.md, which
     names no server for them); `wb model add <provider/model> [--pull]`.
  3. Ollama models only: `wb optimize estimate`, then `wb optimize start` (a minute or two,
     detached): each model's window, measured on this GPU; `wb optimize report` once done.
  4. `wb try` proves it on a tiny sample: review it as any task and run the hidden check it
     printed. Then `wb accept` it (the sample is a scratch repo of its own) and show the user the
     result and the savings line accept prints. Then ask what they'd like built.
- **Claude coding** (the user's choice, `wb coding`): when you may write a task's code yourself,
  a one-line fix in review or `wb takeover` alike. "Let Claude decide" (the default) is this
  skill as written. Otherwise a `claude-coding` context block gives the rule: "Ask me first", or
  "Only when I say"; a later change comes as a `[workbench]` note with the new rule. It covers
  shell edits too; the mod refuses your file edits in a task's worktree, and `wb takeover`,
  until the user's yes is recorded (`wb coding allow`). The user
  may grant one task an exception ahead (`--when "<condition>"`): show them the task, the
  condition and the exact edit first; once used, `wb coding used <task> --did "…"`, then hand
  the testing back with `wb feedback`.
- **After a compaction or `/clear`**, a `workbench-mode` context block says the mode is still on
  and where this file is: read it again if its procedure is no longer in your context.
- **Plans are handoff plans**, in plan mode or not: see "Planning work you will hand off" below.

`wb` is the workbench CLI (on PATH as `wb`; `wb --help`). Its code, ARCHITECTURE.md included, is
two directories above `readlink -f "$(command -v wb)"`. Every command
prints a short report written for you — don't go digging in raw logs unless a report says to.

## 0. The project: git and CLAUDE.md are yours
Every project you delegate in is a git repo with a CLAUDE.md that tells the truth, and you keep
it that way; the agents never write either.
- **New project**: `wb init <dir>` makes the repo (git's default branch, an initial commit); `<dir>`
  is the project's own directory, never ~. When it refuses likely secrets or installed directories,
  write a `.gitignore` for them (ask the user about a secret it names) and run it again. Never add a
  remote or create a GitHub repo until the user gives the name and says private or public; you
  may ask once the project has a shape.
- **CLAUDE.md**: before the first task, write it from what you know and what you read (what the
  project is and is not, how to build, run and test it, the layout, conventions, decisions made
  and things deliberately not done), commit it, and run `wb init <dir>` again: AGENTS.md becomes
  a symlink to it, so OpenCode's agents read the same file. Keep it short and factual; it goes
  into every agent prompt. An existing AGENTS.md is moved to CLAUDE.md by `wb init`.
- **Keeping it current**: when a task changes something CLAUDE.md describes (a new module,
  command, dependency, convention or decision), edit CLAUDE.md in the task's worktree at review,
  before `wb accept`, so it lands in the same commit as the code (one edit, no commit of its own).
  `wb accept` prints how many code commits CLAUDE.md is behind. Nothing changed that it describes?
  Leave it. It says what the project is, never what comes next: keep
  the plan and the next step in your own notes. An agent that loses its task takes up whatever
  CLAUDE.md says is next (seen: a compaction summary that recounted CLAUDE.md, and the agent
  built its "Next:" line instead of its spec). `wb start` refuses a repo without one (CLAUDE.md or
  `.claude/CLAUDE.md`; `--no-claude-md` only for throwaway repos). It also refuses an unknown
  `--base` and a repo with no git identity for the commits: fix those, don't work around them.
- **Submodules** are filled read-only in the agent's worktree (and the scratch checkouts), at
  the commit the base records, so a test command needs no `git submodule update --init` (one
  there gets exit 0 and a note);
  `wb start` names any it couldn't fill (your checkout lacks it), which a build or test there
  can't use. A step must not edit inside one: the edit can't land in the commit (new files
  there, build output, are only noted: they are left out).

## Planning work you will hand off
In workbench mode every plan you write is for agents weaker than you, who see only the spec you
send, so the plan the user approves is already the list of specs, each sized and checked by §1
and §2. That holds in plan mode, which is read-only: read the code, `wb models` and `wb status`
if you can, and start nothing until the plan is approved; then write the first spec and
`wb start` at once. Per step:
- **One concern**, no bigger than the slice `wb models` gives the model that will take it, and
  its size (trivial or significant). A step you can't size is two steps. Size it by the bytes the
  agent will read (`wc -c`), not the files: a two-line edit in a 2,000-line file still gets the
  file read (seen: 39% of a 32K window gone before the first edit, then a compaction).
- **Small ones together.** A handoff costs you about 50K tokens whatever its size (the dispatch,
  one review, the accept; measured 2026-11-18), as much as writing a trivial change yourself
  does. So trivial requests in the same area, asked together or queued up, go as one task: one
  spec with numbered items, one acceptance command that checks each item, sized by the total.
  On its own, a trivial handoff only breaks even; bundled, each one after the first is cheap.
- **The files**: those to read first, those to create or change, and the existing code to imitate.
- **Exact interfaces** for anything later steps or other code rely on: names, signatures,
  constants, file formats. Settle them in the plan; agents rename what isn't pinned.
- **Its acceptance command**, and the worked examples it tests, each number checked against
  every rule. A step whose done-ness you can't state as a command isn't ready to hand off.
  The runner runs it once on the base, in the agent's lane, before round 1; what it saw comes in
  the first report. A test that writes outside the lane or races under load fails there whatever
  the agent does, and the agent spends its rounds on failures it didn't cause (seen: `whoami` and
  /tmp probes): `wb discard --spec-gap "the test"` (it isn't the model's miss: without it the
  router holds it against the model) and start again with a better one. A command that already passes on
  the base is normal when the agent writes the step's tests (the report says so; don't restart):
  then those tests are the check, so the spec names what they must cover, and at review you see
  they fail without the change. Otherwise the command should fail only for what the step changes,
  and check every listed change (each old string gone, each new one there), not just the theme: a
  small model skips one item of a list.
- **Order**: logic, then its tests, then UI; a step that needs another's interface comes after it,
  through `wb next` on the same agent when it is the same area.
- **What stays yours**, marked apart: git, CLAUDE.md, choices and setup only the user can make
  (downloads, licences, public repos), and the checks you run at review (a screenshot to look at,
  tests to break on purpose, a grader).
Keep code out of the plan except those interfaces: the agents write it, you hold the bar. The plan
lives in your notes or the scratchpad, never in CLAUDE.md: an agent that loses its task takes up
whatever CLAUDE.md says is next.

## 1. Size it; the router picks the model
| Size | Typical task |
|---|---|
| `--size significant` | new feature, multi-file change, refactor, non-obvious bug, design judgment, >~50 lines |
| `--size trivial` | rename, string/config tweak, a test for existing code, small single-function change, boilerplate |

`wb start` asks the router, which makes an educated guess and corrects it with real results:
the largest model allowed significant work, the smallest allowed trivial work, unless a model's
record of accepted tasks at that size is clearly worse, or another with as good a record has
been measured to cost you less a task (once each has three with your spend recorded). It prints why; the runner then loads that
model, unloading whatever is there. Old results weigh less, and one task in ten goes to a model
the record left out on fewer than three tasks ("exploring: …"): review it as any other. `wb
models` shows the ranking per size. Pass
`--model <id or fragment>` only if the user names one, or when the record argues against the guess.
Which sizes a model takes is set with `wb model sizes <id> trivial|significant`: set it when you
add a model you judge fit only for small work, and otherwise change it only when the user asks.
A newly added model has no record, so the router won't pick it over one with a good record:
replay the bench on it first (`wb bench run --model <id>`, §6), then give it its first few
real tasks with `--model` (ones you'd review closely anyway).
Model servers (none runnable, which server, a model on another machine), updating workbench, and
**the weekly model check** (the mod asks once a week; `/workbench-models`): read
`reference/models.md` beside this file first.
When the user asks you to optimize or tune their setup (in any words): run `wb optimize
estimate` (`--bench` too if they want models compared overnight), tell them how long it holds
the GPU and that a task they start stops it, then `wb optimize start [--bench]`; it runs
detached and wakes no one (a short measuring run also starts by itself when due: the mod says so).
When `wb optimize report`, or a `note:` from `wb start`, offers a window, ask before `wb optimize
apply <id>`: a bigger window compacts less, a window all on the GPU writes faster.

## 2. Spec (the most valuable thing you write)
**Spec tokens are output, the dearest you spend: a spec as long as the code it asks for costs
more than writing the code.** Measured 2026-11-17: 1.3–2.3K tokens of spec for 1–2K of trivial
code, and 5K for a significant step whose code was about as long. So when the user's request
already says what to build, it *is* the spec: paste it as given and add only what the agent can't
find out alone (names other code calls, exactly; an insertion line; anything you computed; the
gaps the checks below turn up). Never restate it in your own words. Write it and start in one
call: `wb start <name> … --spec - <<'EOF'` … `EOF`. The checks below apply.

When the request is loose, read just enough of the repo to scope it and write the spec:
- the goal in 1–2 sentences; the exact files/functions to touch, and what not to touch
- conventions to follow (point at an existing file to imitate)
- acceptance criteria, and an **acceptance command** that proves them (an existing test command,
  or a new test the agent must write first — say which)

**Before `wb start`: check the spec.** Spec gaps cause review rounds. Any spec: **every rule has a
test** (for each "must", "rejects", "at most" or "only", name the test that fails if it's broken)
and **every fact about the repo is checked in the repo** (each name, field, file and build step
you mention: `grep` it; memory is not a source). A spec you wrote, not the user's request
pasted: also the other seven checks in `reference/spec.md` beside this file (edge inputs, rules
against each other, numbers run, only the task, the reading fits, the old tests, insertion
lines); read it before you write one.
After review, when a round was the spec's fault, say so: `--spec-gap "what it missed"` on
`wb feedback`, `next`, `accept` or `discard`. `wb start` shows your record from those,
and a gap that recurs belongs in this list.

`wb` appends the working protocol itself (no commits, run the tests, stay in scope, ask_reviewer
budget, the summary format), so don't repeat it. The agent also starts with what you would have:
the repo's CLAUDE.md / AGENTS.md / CLAUDE.local.md / `.claude/rules`, a map of nested CLAUDE.md
files, the workbench handbook (`agent/HANDBOOK.md`: read first, match the code, smallest diff,
verify, honest summary) and the repo's own `.claude/skills` (never the user's personal skills
in `~/.claude/skills`). So don't restate project conventions; spend the spec on what is specific
to this task: the files to read first, the existing code to imitate, and the skills to hand it
(below).

**The web is yours**: research for a spec, a question or the model check uses this session's
browsing tools; a 403, a CAPTCHA or an empty page is not checked: say so, never fill it from
memory. Put what the agent needs in the spec, not a URL (its web tools are denied). How, and a
browser check of the agent's work as a test: `reference/driving.md`.

**Your skills reach the agent as decisions.** Before writing a spec, check which skills and tools
in your own session fit the task, whatever the field: a design plugin for a UI, a writing guide
for docs, a security checklist for auth code, the user's own. Apply them yourself and put the
result in the spec: the decisions and the concrete rules this task must meet (the palette as
tokens, the terms and tone, the checks the code must pass), never the skill itself or "follow X":
the agent can't load your skills, and they are written for you. Review the diff against them too.
When the same correction from one of your skills comes up in a second task, it is a lesson: give
the agents a short library skill of just its rules for doing the work (`wb skill add`, or `wb
skill import` from the original when its license allows), handed out on the tasks it fits.

**Size every task to what the model that takes it finishes, as measured.** One concern, with the
files named, and no bigger than its slice: `wb models` (and `wb start`) give each model's, e.g.
`~3 files, ~150 new lines per task`. The slice comes from the context window the model is served
(on 32K, 2–3 files and ~150 lines, measured 2026-11-16; a task that spends it, 8 files at once,
cost 30–60 minutes of compactions, re-reading and drift) and is corrected by every step that
closes: the size most recent good steps reached raises it, the smallest that went badly (compacted,
stuck, or two review rounds the agent caused) lowers it; a handover to a fresh session doesn't
count against a step, and lockfiles and generated files don't count toward a step's size. So a strong
machine's big window earns big tasks; don't hold it to the 32K numbers. When the last few steps
went well, try the next one a little bigger than the slice; that is how it learns to grow.
Splitting is your job, the architect's: run the parts one after another, each with its own acceptance command.
A good split is logic, then its tests, then the UI: `wb next` gives each part to the same agent,
which already knows the code. (Measured: a step that never landed in an hour as one task landed
in ~30 minutes as three, every hidden check passing.)
- Names, signatures and constants that other code relies on: write them in the spec and say
  "exactly"; agents otherwise rename them to fit their own taste.
- The agent cannot see what it draws. For anything visual, look at the screenshot yourself;
  after one miss on a visual detail, fix it yourself rather than describing it again.

**Skills for the agents** are yours to write, hand out (`wb start … --skill <name>`, 0–2 that fit
the task) and keep honest. `reference/skills.md` has how: read it before you write, patch, import
or retire one, or triage lessons. **Images** (a sprite, an icon): a local engine draws them, you
art-direct (`wb image --list`); read `reference/images.md` first. **Audio** (a voice line, a sound,
music): the same with `wb audio --list`, but you can't hear: read `reference/audio.md` first.

## 3. Dispatch
```
wb start <kebab-name> --spec <file|-> --repo <repo> --size significant|trivial \
   --test "<acceptance command>" [--skill <name>] [--model …] [--auto-fix 2]
```
In a monorepo, `--repo` inside a package with its own committed CLAUDE.md (`package: …` printed)
runs the agent, the setup and the tests in that package; the diff stays the whole repo's.
The worktree holds only committed files. When the acceptance command needs what the user
installed (node_modules, a .venv, a build), add `--setup '<install command>'` (a .venv always: a copy still runs the original) (or `--copy <ignored
path>`; `--sibling <path>` for a `../<name>` or `../../<path>` the project uses, by that same path): `wb start` names the ignored
directories it lacks, and a failing setup fails the task before any round (so does a checkout
that fails: the runner makes the worktree, so `wb start` returns at once on any repo). A setup gets 30
minutes; a first build that needs longer (a big Rust or C++ project, torch over a slow link) takes
`--setup-timeout <secs>` at start. A note that the
active Python environment is the checkout's: the agent leaves it out (it would import the user's
checkout, not the worktree), so give it its own, `--setup 'uv sync' --test 'uv run pytest'` or
`--setup 'python3 -m venv .venv && .venv/bin/pip install -e .'`; that .venv comes first on the
agent's and the tests' PATH. A note that the agent's environment leaves out a proxy (it holds a password): a setup or tests that need the
network fail there; ask the user before naming it in commands.json `env`. Tests that use the
GPU themselves (CUDA, PyTorch, a game engine): add `--unload-for-tests`, or they run beside the
model and fail out of memory (before each test run it unloads or stops every model on this GPU,
the task's own too, all but models.json `keep_loaded`: a server model starts again for the next
round, every round; it also opens the GPU's device nodes to the lane, and holds the GPU
from other tasks while they run, waiting for any task sharing it to step aside first, and holds
this machine's GPU even when the model is on a wb remote box; without it they see no device). With it, the base check,
`wb verify` and `wb shot` wait for the GPU alone too.
A suite slower than 15 minutes: `--test-timeout <secs>` above its time, or
narrow the command; a run past it isn't sent back to the agent (nor one the lane refused a
device), you're woken with `auto-fix skipped:` and the cause, unless the base check ran the same
command in a quarter of the limit: then it's the change's hang, and auto-fix gets it.
Once the tests pass, the agent checks its own change against your review checks in one more
round, at local cost only, before you are woken (learned per model; `--no-self-review` skips it).
It returns at once; a detached runner does the work. **Don't poll.** With the workbench mod loaded
the session is woken by a `[workbench]` prompt when the task needs you (review, question, stuck,
failed) — end your turn and wait for it; an agent's question can't wait, so it reaches you
mid-turn too: answer it then. Without the mod, run `wb wait <name>` with Bash
`run_in_background: true` and act on its notification. If the context says wakes are off (the
plugin's wake setting), none will come: tell the user it runs, and wait only if they ask.
A session is woken only for its own tasks (those `wb start` ran in it, wherever; one started by
hand, or one whose Claude Code process has exited, from its directory or a repo in it): start a task from the session that will review it. Failing tests go back to the agent on their
own for `--auto-fix` rounds before you are woken; `wb log <name>` shows what it is doing.
A model that reads prompts slowly, or one the runner must load first, can spend minutes before
its first reply. That is normal, not stuck. A task stopped with "no first output" has taught the
runner how slowly the model reads: a new `wb start` on it waits longer (the stop says how long);
`--silence-timeout <seconds>` gives it more, or pick a smaller model.
**Exit 4: the GPU is taken** by another task (often another session's project) or `wb image`,
which the model can't run beside. Don't wait silently: tell the user who holds it, then either
do the step yourself or `--queue` it to start when the GPU is free (it may be hours).

## Driving a running task
You are the driver, not a spectator: when a check-in, its log or the user says the agent is
heading the wrong way, act on it. Notes are instructions, like feedback: concrete and short.
- `wb steer <name> --text "…"`: a note it gets when its current run ends; `--now` interrupts it
  (wrong files, a wrong approach, a runaway loop).
- `wb takeover <name>`: you finish it in the worktree, uncommitted, then `wb accept` (or hand it
  back with `wb feedback`): for when explaining would cost more than doing.
- `wb stop <name>`; `wb resume <name>` continues it in a fresh session (also after "the runner
  died" or "stopped by a signal"). After a restart or a shutdown one notice names every task it
  interrupted:
  `wb resume <a> <b> …`, as it says.
- A `PERMISSION` question (a command or a directory): lean to yes for what the task needs (`wb
  allow <name> "<pattern>"`, `--path <dir>`), no to what reaches outside it.
Before acting on one of these the first time in a session, read `reference/driving.md` beside
this file: what each does exactly, the think nudge, undelivered notes, a check-in about the
window, the permissions' traps, the web chat, a backlog left to run overnight.

**The user's two commands.** Only these, never words in a message, stop the delegation and end
workbench mode; the mod runs them, closes the pane and tells you what it did:
- **`/workbench-quit-and-hand-back-claude`**: take over. This session's agents are already stopped
  (`wb takeover --all --user --repo <here> --session "$CLAUDE_CODE_SESSION_ID"`). Leave workbench mode and finish the work yourself without pausing: review
  what each agent left, complete it in its worktree to your standard, run the acceptance command,
  `wb accept`, then carry on with the rest of the request directly, without delegating.
- **`/workbench-quit`**: stop. This session's delegated agents are already stopped (`wb stop
  --all --repo <here> --session "$CLAUDE_CODE_SESSION_ID"`). Work directly from now on. Don't finish, restart or clean up anything
  unless asked; worktrees are kept.
Tasks listed as left alone belong to another live session: leave them unless asked.
Without the mod, the user may ask for the same in words; run those commands then.

**The web chat.** A prompt that is just `[web chat] <their words>` is the user on their phone,
with the same authority as here (`[attached: <path> …]` lines are their files: Read them): reply
there with `wb chat reply --text "…"`, short; read
`reference/driving.md` (the web chat) before your first reply.

**Check-ins.** Off unless `--checkin MIN`; a task also wakes you on trouble (a nudge, repeated
handovers). Answer one in that turn: two or three plain lines to the user, steer only if it
drifts, `wb log` only if the digest shows trouble (`reference/driving.md`). A **progress check**
(only when the user ran `wb progress on`) recommends a hint or a smaller step: give it with the
command it names, so whether it helped is learned. Time never makes the task yours to edit: the
coding choice is the user's (`wb coding`), never changed by a check.

## 4. When woken
- **review**: the wake carries the report and, when it is small, the whole diff (`wb diff <name>`
  only when it says the diff was too big, or after you change something); after your feedback,
  only the diff since your last review. Read every line. Check:
  - **Correctness**: trace the logic, including edge cases, error paths and inputs the tests
    don't cover.
  - **The spec**: every requirement met, nothing missing, nothing added.
  - **Tests**: they test the behaviour and would fail on a bug; none weakened, skipped or
    special-cased; expected values not just copied from the output. For a bug fix with its own
    regression test, `wb verify <name> --test '<that test>'` shows whether it fails on the base
    and passes on the change (add `--expect '<the assertion's message>'` when you know what the
    bug's failure prints); after `wb next` it and `wb shot` compare against the previous approved step.
    It runs the test twice (and the setup, with `--setup`), up to `--timeout` each: when that can
    pass a minute, run it, and `wb shot`, with `run_in_background: true` and read its notification. Only `proven` is proof (`wb report` repeats it, and `wb accept`
    says when it proves nothing about what you accept); when it says the base lacked a file the candidate adds
    (a fixture, a golden file), add it with `--files`. For a visual change, `wb shot <name>
    --capture '<the project's screenshot command>'` captures the base and the candidate the same
    way: look at both images, and if a capture failed, review the code as usual. `--chat` shows the
    pair to a user away from the terminal; their reply arrives as `[web chat] (about <task>, step
    <s>, …)`, and that task's feedback is `wb feedback <task>`, whatever task is active.
  - **Fit**: the repo's conventions, naming, idioms and existing helpers; no duplicated code.
  - **Hygiene**: no stray files, debug output, dead code or TODOs.
  - **Safety**: injection, secrets, unsafe file or shell use.

  **The bar is the same for every task; the checking is in proportion to it.** Each call you make
  re-reads your whole context, so a review of a dozen calls can cost more than writing the code
  (measured 2026-11-17: a trivial task cost 4.5 times as much handed off, mostly in review extras).
  - **Trivial**: reading the diff against the spec and the report's test result is the review. Run
    something only when a line leaves you in doubt.
  - **Significant**: also check the tests catch bugs: break the code in a scratch copy two or
    three ways, the bugs you would most expect (an off-by-one, a missed case from the spec), in
    one script that applies each break and runs the tests, and see each one fail. More is not
    safer, only dearer: twelve breaks cost more than the task's own review (2026-11-17). A UI change:
    run it from the worktree and look with your own browser tool.
  - Put the checks you do run in one Bash call (`wb status <name>` prints the worktree's path).
  - **CLAUDE.md**: the agent can't edit it, so a task that changes it has the agent write
    `CLAUDE.md.proposed`; the wake shows it as a diff. Good: `wb accept … --take-claude-md`.
    Ask for it in the spec ("propose the CLAUDE.md change") instead of writing it yourself.
  - **Fix small things yourself in one call**: every edit (a script or `sed` over the worktree),
    the CLAUDE.md update, the tests and `wb accept`, in one Bash call. Each separate edit is a
    call over your whole context: five of them cost more than the agent's round (2026-11-17).
  Accept only what you would have written.
- **question** — answer it briefly and decisively: `wb answer <name> --text "…"`. The agent is
  blocked until you do.
- **stuck / failed** — `wb log <name> -n 30` if the report isn't enough; then feedback that unblocks
  it, or discard. Past step 1, discard drops only this step: the steps `wb next` committed stay on
  the branch, and the report says how to accept them instead. A failed round's edits so far stay in the worktree (`wb resume` carries on). A setup or load failure before the agent ran: fix it, then `wb resume <name>`.

- **Lessons**: when the `lessons:` line says one was seen in more than one task, or you just
  corrected something the next agent will get wrong too, triage it now (`reference/skills.md`).
  A one-task detail needs no call.

## 5. Feedback
Numbered, concrete changes in a file → `wb feedback <name> --message <file>` (or `--text "…"`). Small models need
explicit instructions ("in parse(), return 0 for an empty string"), not critique. Send back
everything the agent must redo in one round. A nit you can fix in less than it takes to describe
it (a name, a blank line, a duplicated test line), fix yourself in the worktree and accept: the
bar holds, and a round costs a wake and a second review. Confirm or correct each assumption the summary lists, in the same
message: an assumption left unanswered comes back as a question, and the agent waits for it.
When the fix is for something your spec missed, add `--spec-gap "…"` (checklist item it broke).
**Max 3 review rounds.** Still wrong after that: make the small remaining fix yourself in the task's worktree
(`wb status <name>` prints its path) and accept, or `wb discard <name> --reason …`.
If a "trivial" task fails twice, it wasn't trivial: discard and restart it with `--size significant`.

The base check, `wb verify`, and `wb shot` reuse the ignored files from the prepared worktree.
Pass `--setup` to verify or shot when the comparison needs dependencies rebuilt for each revision.

## Context, on both sides
**The agent's.** Rounds of a task continue one OpenCode session, so the agent keeps what it read;
past its handover point the runner hands the task to a fresh session by itself, and reports show
`agent context: …`. A round that hands over 5 times is stopped as stuck: the step is too big for
the window, so split it. `NOTE: the spec doesn't name …` lists files outside the spec: drift
until you've looked, so read them and steer (`--now`) if the agent left its task. `NOTE: <dir>: a
git repository of its own` is a nested repo the diff leaves out and `wb accept` refuses: have its
`.git` removed, or gitignore it. Override per round: `wb feedback --fresh` when the agent is
confused or working from stale reads; `--keep-context` when it needs what it read and the window
still has room (how handovers work: `reference/driving.md`).
Check a directory flagged as possible build output before you accept a step. Remove or gitignore
generated files. When the bulk additions or large binaries belong in the commit, pass
`--include` to `wb next` or `wb accept` after reviewing them.
When a command says the repo `moved or was deleted`, ask the user where it is now, then
`wb relocate <name> --repo <dir>`; a removed linked worktree needs nothing (its main one is used).

Follow-up work in the same area goes to the same agent: `wb next <name> --spec <file> -m "<subject
for the approved step>" [--test …]` commits the approved step on the branch and sends the next
step to the same worktree and session (`--fresh` for a new one). `wb diff` then shows the current
step, `--all` the whole branch; finish with `wb accept`. Unrelated work is a new task with a fresh
agent. A new task can't inherit an old task's session: OpenCode binds a session to its directory.

**Yours.** `wb` holds the delegation state, so your context doesn't have to. When a task closes and
none waits for you, the mod compacts you once you are halfway to automatic compaction, keeping
the user's goals, the tasks and what each needs next (`WB_COMPACT_AT`, a percentage, 0 turns it
off); any compaction keeps that state, and after a compaction or `/clear` a `workbench` context
block lists the open tasks. So don't carry diffs or reports forward: `wb status` and
`wb report <name>` bring them back. Between unrelated jobs, tell the user `/clear` is safe.

**What you learn about the user.** When the user tells you how they want delegation run (a
review bar, how much to ask them, what to merge, a style they always want), and it would hold in
any project, `wb notes add "<it, in one sentence>"`. Your own memory stays in one project; these
notes come back in every session in workbench mode (a `user-notes` block). A fact about one repo
goes in that repo's CLAUDE.md instead. Drop a note that has stopped holding (`wb notes drop N`).

## 6. Finish
- Approved: `wb accept <name> -m "<conventional commit subject>"` commits on `delegate/<name>`
  with the task and OpenCode session recorded. Add `--merge` only if the user passed `--merge` or
  said to merge (`--merge-as ff` or `squash` instead when the repo keeps a linear
  history, unless its commands.json `repos` entry already says `merge`); otherwise give them
  the merge command it prints. Exit 5 means accepted but
  not merged (its stderr says why): tell the user and give them the merge command; main
  doesn't have the change. When it says the branch doesn't hold the task's base (reset or
  rebased since), the commits it lists would come back with a plain merge: ask the user whether
  to rebase the task onto it or bring them back. An accept that was interrupted finishes when
  run again.
- `wb discard <name> --reason "…"` drops it (a branch holding steps `wb next` committed is kept;
  `--drop-steps` deletes it too). `wb status` lists this session's open tasks (e.g. after a context
  reset; another session's are named as open elsewhere: leave them; tasks a /workbench-quit parked only by name: leave them unless the user asks); `wb stats` compares the models on finished work (the three used last; `--all` every one).
- **Keep the good ones as bench cases.** An accepted step whose spec pinned the names its tests
  call, and whose tests fail on its base and pass in the agent's lane (one that commits or writes
  outside it never can: add refuses it), is a case: `wb bench add <name>` (`--step N` for a
  `wb next` step; `--hidden <paths>` or `--check "<cmd>"` when the tests it changed aren't the
  ones that tell; with `run_in_background: true`, as `wb bench self`: their setup and tests can
  outrun Bash's 2 minutes). `wb bench run [--model <id>…] [--label <variant>]` replays the cases in the
  background, one at a time, after any real task and stopped by one; it wakes no one and costs
  you nothing. `wb bench report` compares models (or a `--label`, such as a workbench branch or
  a skill handed with `--skill`) on the same work. It is evidence for your `--model` and the
  weekly check, never a reason to skip review: the router doesn't read it. `wb bench self <case>
  --yes` has you write a case yourself, to set the handoff's cost against yours; it spends your
  tokens, so run it only when the user says yes. `wb bench rm <case>` drops one that no longer
  tells models apart (its results stay).

## Report to the user
Short and honest: what was built, on which model, rounds (automatic and review), test result,
what you fixed, sent back or flagged, the branch. Report the agent's misses plainly; they are
evidence about the model, and the router learns from accept and discard. Pass on the
`claude:` line `wb accept` prints: what the task cost you, measured, beside the estimate of
writing it yourself and the GPU energy. Call the estimate an estimate. `wb savings` gives the
week's total and its score out of 100 when the user asks what it's saving; `wb savings --card
<file>.svg` makes the badge as an image for them to keep or post (made here, nothing sent).
