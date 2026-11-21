// workbench: the Claude Code side of delegating to local OpenCode agents.
//
// It reads the task files `wb` and its runners write (~/.local/state/workbench, or $WB_HOME) and
// does three things with them: draws a live pane of the tasks, keeps a one-line status, and, when
// a task needs Claude (ready for review, a question, stuck, failed), starts a turn for Claude with
// the task's report in it, so nobody has to poll. Acknowledgements are shared with `wb wait`
// through each task's `acked` file, so a notification wakes Claude once, by whichever got it first.
// A wake is held while Claude's main loop is mid-turn (a prompt submitted then would queue and
// arrive stale) and checked against the task's phase when it is finally sent.
// A session acts only on its own tasks (`mine`): those `wb start` ran in it (task.json `session`,
// one of the ids this process has had), wherever it ran; a task without one (started by hand, or
// before 0.90), or whose Claude Code process is gone, by directory, and an old task with neither
// that nor a directory is everyone's.
// Another session wakes for, stops and hands back its own (the 2026-11-16 audit: two
// projects at once, each session was woken for and quit the other's). A session with no person
// at it (`claude -p`, the SDK, until a surface attaches) stays quiet.
// Claude's own context. In workbench mode, whatever compacts it (the engine at its limit, /compact,
// this mod), the summary is told to keep the delegation state, and after a compaction or /clear
// the open tasks come back as a context block. At a task boundary (one of this session's just
// closed, none waiting for Claude) the mod compacts early once Claude is COMPACT_AT of the way to
// the engine's own compaction, so a long delegation session sheds finished tasks' detail at a
// clean point instead of mid-review.
const COMPACT_AT = 0.5
const KEEP_ON_COMPACT =
  'Workbench delegation is in progress. Keep: the user\'s goals and decisions, which tasks were ' +
  'delegated (names, repos, branches, what each is for), which are open and what each needs ' +
  'next, and what was accepted, merged or discarded. Drop the diffs, reports and transcripts of ' +
  'finished tasks; `wb status` and `wb report <name>` bring back any detail.'
// The weekly model check: once a week, in a quiet moment of a session the person is using,
// Claude is asked to look at this machine, what is installed and how it has done, and what is
// newest, and to recommend what to add or retire. /workbench-models asks for it now.
const SCOUT_EVERY_MS = 7 * 24 * 3600 * 1000
const SCOUT_RETRY_MS = 24 * 3600 * 1000 // raised but never finished: ask again a day later
const MODELS = 'workbench-models'
const SCOUT_NOTE =
  '[workbench] The weekly model check is due. As the driver, keep the local agents on the best ' +
  'models this machine can run:\n' +
  '1. `wb scout`: this machine\'s hardware, what is installed, and how each model has done ' +
  '(real tasks), and its watch list: models set aside and what each needs ' +
  'before it is tried again.\n' +
  '2. Look up what is newest: open-weight coding models with tool calling, their sizes and ' +
  'quantizations, which fit this GPU\'s VRAM (with room for the context) and this RAM, and ' +
  'recent releases of the model server this machine runs (whichever it is: `wb scout` lists ' +
  'them). Prefer primary sources (model cards, the server\'s own model library, ' +
  'release notes) and recent reports; name nothing you could not verify.\n' +
  '3. Recommend in a few lines: keep, add (the model and quantization, why it should beat what ' +
  'is installed, its size and how it fits), retire (what it replaces, the disk it frees). ' +
  'Aim for the best results first, then efficiency. For each watch-list item, say whether ' +
  'its conditions are met yet; `wb scout --unwatch N` once one is settled.\n' +
  '4. Ask before downloading or deleting. With a yes: on Ollama `wb model add <provider/model> ' +
  '--pull` in the background, on another server its own download then `wb model add`; ' +
  '`wb model sizes <id> …` if it should only take some task sizes, and ' +
  '`wb model retire <id> [--delete]` for what it replaces. Installed models that are not ' +
  'registered may belong to other tools: ask first.\n' +
  '5. The audio and image engines `wb scout` lists, if any (speech, sound effects, music, the ' +
  'listener; images): check each model\'s licence today against its licence text, not its tag ' +
  '(licences change: one audio model went non-commercial mid-2026), and whether a newer local ' +
  'model of that kind fits this machine better. Recommend keep / add / retire as for the coding ' +
  'models; keep each engine\'s `notes` (its licence) true.\n' +
  '6. The skill library: rewrite or retire (`wb skill retire`) what `wb scout` flags.\n' +
  '7. `wb scout --done --notes "<what you recommended or changed>"`.\n' +
  'Keep it short; if nothing is worth changing, say so in one line.'
// Workbench mode: /workbench turns it on for the rest of the session and opens the pane, its sign.
// The user then asks for things in plain words, and Claude hands the coding to local agents as
// the skill says. A fresh or compacted conversation is told the mode is still on and where the
// skill is (`workbench-mode` block). Two slash commands end it: /workbench-quit stops this session's
// agents at once (`wb stop --all --repo <cwd> --session <id>…`) and tells Claude so;
// /workbench-quit-and-hand-back-claude stops them and hands their tasks to Claude (`wb takeover
// --all`, the same scope), starting a turn for Claude to finish them. Either closes the pane.
// Under the task list the pane follows one task live: the conversation between Claude and the
// agent, every tool call and test, as `wb watch --json` prints it.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { WbChat, WbLine, WbLive, WbPane, WbSaid, WbStats, WbTask, WbTop } from '../types'
import { cells, COLUMNS, FACE, MOUTH, ROWS } from './apprentice'
import type { Pose } from './apprentice'

const PANE = 'workbench'
// Nothing waits on a timer for news: `wb events` (inotify) prints a line the moment a task, a
// notification or a chat message changes, and each line runs poll() at once. The timer only
// redraws running tasks' clocks, and checks in now and then should the watcher be gone.
const POLL_MS = 1500 // the clock's redraw while a task runs
const SAFETY_MS = 30_000 // a poll at least this often, whatever the watcher says
const KEEP_CLOSED_MS = 30 * 60 * 1000 // closed tasks stay in the pane for half an hour
const OLDEST_WAKE_MS = 60 * 60 * 1000 // never wake for a notification older than an hour

// Change the tag when WbTask's fields change: a reload declines what the earlier shape stored.
const tasks = atom({ plugin: 'workbench', key: 'tasks' } as const, [] as WbTask[], {
  shape: 'tasks-8',
})

// Every Claude Code session id this process has had (`$.session.id()`): /clear and a resume go on
// under another, and a task started before still belongs here. Kept across a reload.
const sessions = atom({ plugin: 'workbench', key: 'sessions' } as const, [] as string[], {
  shape: 'sessions-1',
})

const live = atom({ plugin: 'workbench', key: 'live' } as const, { task: '', lines: [] } as WbLive, {
  shape: 'live-1',
})

// The week's saving, the pane's last line (`wb savings --json`, read as the chat link is, and
// again when a task closes): the user, 2026-11-18, nothing in the product showed it (#107).
const savings = atom({ plugin: 'workbench', key: 'savings' } as const, '', { shape: 'savings-1' })
const KEEP_LINES = 2000 // the pane scrolls back through this much history (`wb watch --last`)
// One heredoc command or minified write is a single line of 100 KB or more, and alone it took the
// whole HISTORY_CHARS budget, hiding everything before it (the 2026-11-16 audit): each line is
// cut to this first.
const LINE_CHARS = 2000
const LIVE_EVERY_MS = 5000 // a running task's transcript is re-read this often, and no more often though its status moves (#691)
// The engine draws a pane's first 100,000 characters of text and drops the rest, and the
// apprentice comes after the history: a long task's history pushed its words (and its mouth)
// past the cut, leaving an empty bubble (seen 2026-11-16, 119,728 characters). So the history
// drawn is its newest lines within this budget, leaving the rest of the pane room.
const HISTORY_CHARS = 60000

// The web chat (`wb chat serve`): the user's side door while away from the terminal. A session
// listens while workbench mode is on in it (`delegating`), from /workbench until a quit command;
// with several, the first to claim chat/listener.json does, and the others stand by. A message is
// submitted as a prompt (so the terminal shows it too) with a receipt the page shows at once.
// The user turns it on or off (`wb chat on|off`, or the pane's row; chat/switch.json): off by
// default, and then no session listens, sends it prompts or shows its link (the user, 2026-11-19).
const chat = atom({ plugin: 'workbench', key: 'chat' } as const,
  { key: '', delegating: false, url: '', web: false } as WbChat, { shape: 'chat-4' })
// The pane's view: a Tasks tab and a Settings tab, as backseat-driver's (the user, 2026-11-19: the
// settings belong on a page of their own). A settings row names its value, a press opens its
// options under it as Buttons (a click or the ring's Enter picks), the option under the ring or the
// pointer shows its sentence. A Select there opened on a click and could pick nothing (2026-10-05),
// and its sentence followed only the saved choice (the user, 2026-11-19).
// Closed by the user (its mark, Esc), the pane is minimized, as backseat-driver's is (the user,
// 2026-11-19): a strip above the prompt stands in for it, a press there or /workbench brings it back.
const pane = atom({ plugin: 'workbench', key: 'pane' } as const,
  { tab: 'tasks', open: '', focus: '', minimized: false } as WbPane, { shape: 'pane-1' })
const STRIP_HINT = 'minimized · restore: click, or Ctrl+X Tab then Enter'
// Stats between them (#406): looked at more often than Settings
const TABS: [string, string, string][] = [['tasks', 'Tasks', '1'], ['stats', 'Stats', '2'], ['settings', 'Settings', '3']]
// The Stats tab's history (`wb stats --json`), read while the tab is shown: when it is first
// shown in a load (`mem.statsLoaded`: the atom outlives a reload), on each press of the tab, again
// when a file it is made from changes (refreshStats), and once the feed's `until` (the next local
// midnight) has passed. No timer.
const statsFeed = atom({ plugin: 'workbench', key: 'stats' } as const, { key: '', feed: null } as WbStats,
  { shape: 'stats-1' })
// The Stats tab's live view (#408): one `wb top --json` child, only while the tab is on screen
// with the live view on, ended the moment it isn't; each line its newest tick
const topNow = atom({ plugin: 'workbench', key: 'top' } as const, { snap: null, busy: {} } as WbTop,
  { shape: 'top-1' })
const BUSY_KEEP = 60 // busy % samples kept per GPU for the sparkline: two minutes at 2 s
const TOP_RETRY_MS = 30_000 // a `wb top` that ended by itself (wb missing, failing) is tried again this long after, doubling
// A `wb stats --json` that failed or timed out is tried again after STATS_RETRY_MS, doubling to
// RETRY_MAX_MS; each poll ran it again, a full-history read a core kept busy on a slow host (#553)
const STATS_RETRY_MS = 60_000
const RETRY_MAX_MS = 10 * 60_000
const SETTINGS_HINT = 'Click a row to see its options, then click one; or Tab to it and press Enter. A change applies at once.'
const CHAT_STALE_MS = 15_000 // as wb's LISTENING_FOR: a listener silent this long has gone
const AWAY_MS = 6 * 3600 * 1000 // the user counts as away this long after a web message
// ...or for as long as this session has a backlog task open: a night's batch outlasts six hours,
// and its permission prompts then waited in the terminal until morning (#110, 2026-11-18)
export function awayNow(webAt: number, now: number, list: WbTask[], isMine: (t: WbTask) => boolean): boolean {
  if (!webAt) return false
  if (now - webAt < AWAY_MS) return true
  return list.some(t => t.backlog && isMine(t) && (ACTIVE.has(t.phase) || waitsOnClaude(t)))
}
// Whether the weekly model check and the automatic optimize may run: no task anywhere active (the
// GPU's, and a check's question beside a running task's), and none of this session's waiting on
// Claude lately. Any task open at any age once gated both, so one stuck, failed or unreviewed
// task left after a quit stopped them for good (#541); one idle past REWAKE_MAX_MS waits for a
// session long gone, as rewake judges it; a parked one waits for no one.
export function quietForJobs(list: WbTask[], now: number, isMine: (t: WbTask) => boolean): boolean {
  return !list.some(t => ACTIVE.has(t.phase) ||
    (waitsOnClaude(t) && isMine(t) && now - t.updatedAt <= REWAKE_MAX_MS))
}
// Away is the user's, not one session's (#688): the listening session records the last web
// message in chat/away.json and a prompt typed in any session clears it, so every delegating
// session relays its dialogs and says AWAY_NOTE. Kept in the listener's own state, only it did:
// another session's overnight backlog left its permission dialogs in the empty terminal (#110 again).
const awayFile = () => `${mem.root}/chat/away.json`
// Whether a prompt is the user's own (at the terminal, or through Remote Control), by the
// engine's stamp: a /loop or scheduled firing, another plugin's prompt or an MCP channel's
// message ended away for every session and cancelled the #767 follow-up (#835). An unstamped
// prompt goes by isMeta, as before the stamp; an `unclassified` one by isMeta too (the engine
// stamps some queued typed prompts so).
const USER_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'auto-continuation'])
const byUser = (e: { isMeta?: boolean; origin?: { kind?: string } }) => {
  const kind = e.origin?.kind
  if (!kind || kind === 'unclassified') return !e.isMeta
  return USER_ORIGINS.has(kind)
}
async function webAt($: any): Promise<number> {
  return Number((await readJson($, awayFile())).at ?? 0) * 1000 || 0
}
async function away($: any, st: WbChat): Promise<boolean> {
  return st.web && awayNow(await webAt($), await $.clock.now(), await read($, tasks), mine)
}
async function back($: any) {
  if (await webAt($)) await $.fs.write(awayFile(), JSON.stringify({ at: 0 })).catch(() => {})
}
// Said in the context blocks while away, and in each wake while away (#540): those blocks come once
// per conversation, so a user who went to the web chat later was never told of, and a task's
// news reached only the terminal they had left.
const AWAY_NOTE =
  'The user is away from the terminal and last wrote from the web chat. Tell them ' +
  'there (`wb chat reply --text "…"`) when something they asked for is done or needs them; ' +
  '`wb chat log` shows the thread. Typing in the terminal again ends this.'
async function awayToo($: any, text: string): Promise<string> {
  return (await away($, await read($, chat))) ? `${text}\n\n${AWAY_NOTE}` : text
}
const WEB = '[web chat]'
// Only for a delivery into a running turn, which the engine frames as another session's message:
// the rules for answering live in the /workbench skill (The web chat), loaded whenever this listens.
const WEB_NOTE =
  '(The user wrote this in the web chat; the workbench mod delivered it into your running turn. ' +
  'Answer as /workbench\'s "The web chat" says: `wb chat reply --text "…"`.)'

// A web message's attachments (#623), one line each after the user's words, so Claude can Read
// each file wb chat saved on this machine (an image is seen, a PDF or text read)
export function attachedLines(files: unknown): string {
  if (!Array.isArray(files)) return ''
  const size = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`
  return files.flatMap(f => f && typeof f === 'object' && typeof f.path === 'string'
    ? [`\n[attached: ${f.path} (${size(Number(f.size) || 0)}, ${String(f.type || 'unknown type')})]`] : []).join('')
}

const ACTIVE = new Set(['queued', 'running', 'testing', 'asking'])
const NEEDS = new Set(['review', 'stuck', 'failed', 'asking'])
// Waiting on Claude, unless parked: stopped by /workbench-quit (`wb stop --all`, status `parked`),
// which the status line, rewake, the boundary and the jobs' gate don't count. It stayed "awaiting
// review" and kept the weekly check off for good (#541); the pane and `wb status --all` still show it.
const waitsOnClaude = (t: WbTask) => NEEDS.has(t.phase) && !t.parked
const COLOR: Record<string, string> = {
  queued: 'subtle', running: 'claude', testing: 'suggestion', asking: 'warning',
  review: 'success', stuck: 'error', failed: 'error', accepted: 'inactive', discarded: 'inactive',
}

type Row = Record<string, any>

// wb watch's line styles, in the theme's colours
const LINE_STYLE: Record<string, Row> = {
  claude: { color: 'claude', bold: true }, agent: { color: 'suggestion', bold: true },
  think: { dimColor: true, italic: true }, tool: { color: 'warning' }, out: { dimColor: true },
  ok: { color: 'success', bold: true }, bad: { color: 'error', bold: true },
  // diff lines as Claude Code draws its own: text on the diff background, readable on any
  // terminal (diffAdded/diffRemoved as a text colour were dim on a dark one)
  sys: { color: 'permission' }, add: { color: 'text', backgroundColor: 'diffAdded' },
  del: { color: 'text', backgroundColor: 'diffRemoved' },
  head: { bold: true }, activity: { color: 'claude' }, clock: { dimColor: true },
}
const SPIN = ['✻', '✳', '✶', '✢', '·', '✢', '✶', '✳']
// Each phase's mark in the task list; a running task's is the spinner.
const MARK: Record<string, string> = {
  queued: '◌', testing: '◐', asking: '?', review: '◆', stuck: '▲', failed: '✗',
  accepted: '✓', discarded: '–',
}

// The apprentice (apprentice.ts) at the foot of the pane: how it stands and what it says about
// the followed task. A timer (FRAME_MS) swings the wrench now and then while it works and blinks
// it otherwise: a stroke every frame was a distraction beside the transcript.
const FRAME_MS = 450
const BLINK_EVERY = 11 // frames
const STROKE_EVERY = 6 // frames: the wrench comes up once in this many, else rests at its side
const APPRENTICE = 'apprentice' // its Raster's key, for $.ui.blit
type Speech = { pose: Pose; say: string; more: string; color: string }

const speechOf = (focus: WbTask | undefined, doing: string, list: WbTask[], on: boolean): Speech => {
  if (!focus) {
    const more = on ? 'Ask Claude for anything: the coding comes to me.' : '/workbench turns workbench mode on.'
    if (list.length) return { pose: 'rest', say: 'All caught up.', more, color: 'inactive' }
    return on
      ? { pose: 'rest', say: 'Workbench mode is on.', more, color: 'claude' }
      : { pose: 'sleep', say: 'No delegated tasks.', more, color: 'inactive' }
  }
  const n = focus.name
  switch (focus.phase) {
    // each handoff names who acts next: "done" read as tests passed, accepted or landed (#103)
    case 'review': return { pose: 'tada', say: focus.tests === 'pass' ? `Local tests passed on ${n}.` : `${n} is done.`,
      more: 'Claude reviews next.', color: 'success' }
    case 'asking': return { pose: 'ask', say: `I asked Claude about ${n}.`, more: 'Claude answers next.', color: 'warning' }
    case 'stuck': return { pose: 'slump', say: `I'm stuck on ${n}.`, more: focus.last, color: 'error' }
    case 'failed': return { pose: 'slump', say: `${n} failed.`, more: focus.last, color: 'error' }
  }
  // the hands move while it writes or tests; everything else is the model thinking or waiting
  const working = /^(Writing|Running)/.test(doing)
  return { pose: working ? 'work' : 'think', say: doing || focus.last || `${focus.phase}…`, more: '', color: COLOR[focus.phase] ?? 'claude' }
}

// The frame a pose shows at a tick: a stroke of the wrench now and then while working, else a
// blink now and then.
const frameOf = (pose: Pose, tick: number): Pose => {
  if (pose === 'work') return tick % STROKE_EVERY ? 'swing' : 'work'
  if (pose === 'sleep' || pose === 'slump') return pose
  return tick % BLINK_EVERY === 0 ? 'blink' : pose
}

const parseLines = (text: string): Row[] =>
  text.split('\n').flatMap(line => {
    if (!line.trim()) return []
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })

const readJson = async ($: any, path: string): Promise<Row> =>
  $.fs.read(path).then((t: string) => JSON.parse(t)).catch(() => ({}))

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}

const clip = (text: string, n: number) => (text.length <= n ? text : text.slice(0, n - 1) + '…')

// Words broken into lines of at most n characters (a longer word is cut across lines). The
// bubble wraps with this, not with Text's own wrapping: in a row that shares its width, that
// laid out the rows and drew them empty (seen 2026-11-16).
export const wrapWords = (text: string, n: number): string[] => {
  const lines: string[] = []
  let line = ''
  for (let word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > n) {
      lines.push(line)
      line = ''
    }
    while (word.length > n) {
      lines.push(word.slice(0, n))
      word = word.slice(n)
    }
    line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

// A line of coloured parts broken into lines of at most n characters at spaces, each further
// line indented: the Stats tab's live rows were cut at the pane's edge (truncate-end), so a GPU
// with a long name lost its busy bar, watts and sparkline, and a model its load time, to "…"
// (2026-11-21). A word longer than a line stays whole; the Text still cuts it at the edge.
type Part = { color?: string; dim?: boolean; bold?: boolean; text: string }
export const wrapParts = (parts: Part[], n: number, indent = 2): Part[][] => {
  const lines: Part[][] = []
  let line: Part[] = []
  let width = 0
  const add = (p: Part, text: string) => {
    const last = line[line.length - 1]
    if (last && last.color === p.color && last.dim === p.dim && last.bold === p.bold) last.text += text
    else line.push({ ...p, text })
    width += text.length
  }
  for (const p of parts) {
    for (const tok of p.text.split(/(\s+)/).filter(Boolean)) {
      if (/^\s/.test(tok)) {
        if (width > (lines.length ? indent : 0)) add(p, tok)
        continue
      }
      if (width > (lines.length ? indent : 0) && width + tok.length > n) {
        const end = line[line.length - 1]
        if (end) end.text = end.text.trimEnd()
        lines.push(line)
        line = [{ text: ' '.repeat(indent) }]
        width = indent
      }
      add(p, tok)
    }
  }
  if (line.length) {
    const end = line[line.length - 1]
    end.text = end.text.trimEnd()
    lines.push(line)
  }
  return lines.length ? lines : [[{ text: '' }]]
}

const eventLine = (r: Row): string | null => {
  switch (r.kind) {
    case 'tool': return `${r.tool} ${r.brief ?? ''}${r.ok ? '' : '  ✗'}`.trim()
    case 'tests': return `tests ${r.ok ? 'pass' : 'FAIL'}`
    case 'autofix': return 'tests failed → sent back to the agent'
    case 'ask': return `asks: ${r.text}`
    case 'answer': return `answered: ${r.text}`
    case 'allow': return `Claude ${r.text}`
    case 'stopped': return `stopped: ${r.text}`
    case 'error': return `error: ${r.text}`
    case 'text': {
      const first = String(r.text ?? '').trim().split('\n')[0]
      return first ? `“${first}”` : null
    }
    default: return null
  }
}

const HEADLINE: Record<string, string> = {
  review: 'is ready for review',
  question: 'asks the reviewer a question (the agent is waiting)',
  stuck: 'was stopped: it got stuck',
  failed: 'failed',
  checkin: 'check-in (still running)',
}
const NEXT: Record<string, (n: string, id?: string) => string> = {
  review: n => `Review it as /workbench says, from the diff above (\`wb diff ${n}\` when it was too ` +
    `big to include), then \`wb accept ${n} -m "…"\` or \`wb feedback ${n} --message <file>\`.`,
  question: (n, id) => `Answer with \`wb answer ${n}${id ? ` --id ${id}` : ''} --text "…"\`; it is blocked until then. A ` +
    `PERMISSION request (a refused command or directory): the \`wb allow ${n}\` it names ` +
    `(\`--always\` to keep it) when it is reasonable, which answers it and restarts the agent ` +
    `with it; else answer with another way.`,
  stuck: n => `Steer it with \`wb feedback ${n} --message <file>\`, or \`wb discard ${n}\`.`,
  failed: n => `Look at \`wb log ${n}\`; then \`wb feedback ${n} --message <file>\` or ` +
    `\`wb discard ${n}\`.`,
  checkin: n => `As the driver: tell the user in two or three plain lines how it is going ` +
    `(progress, time, anything off), and log the same with \`wb note ${n} --text "…"\`. ` +
    `If it is heading the wrong way, \`wb steer ${n}\` (\`--now\` to interrupt). Keep it short.`,
}
// One notice for the tasks a restart or a shutdown interrupted (its `tasks`: cli._restart_notice,
// runner._signal_notice). Nothing went wrong in them, yet the wake ended with the failure's
// `wb log`, feedback or discard after the notice's own `wb resume --all` line (#544).
const BATCH_NEXT = (names: string[]) => names.length > 1
  ? `Nothing went wrong in the tasks themselves: \`wb resume ${names.join(' ')}\` continues ` +
    'them all, in the order they were started (`wb resume <name>` one, `wb discard <name>` drops one).'
  : `Nothing went wrong in the task itself: \`wb resume ${names[0]}\` continues it in a fresh ` +
    `session, \`wb discard ${names[0]}\` drops it.`
const batchOf = (row: Row): string[] | null =>
  Array.isArray(row.tasks) && row.tasks.length ? row.tasks.map(String) : null
const RUNNING = new Set(['queued', 'running', 'testing'])

// A question delivered into a running turn (#542): the engine frames it as another session's
// message, so one line says whose it is and that it can't wait for the turn to end.
const MIDTURN_NOTE = '(The workbench mod delivered this into your running turn: the agent is ' +
  'blocked until it is answered, and gives up after a while. Answer it now, then carry on.)'
// ask_mcp.NO_ANSWER's opening: what the runner answers a question nobody answered in time
const NO_ANSWER = 'No answer arrived in time.'
// A question held for a turn that could not take it, which then timed out: said after the turn
// rather than acknowledged in silence (#542)
const MISSED_NOTE = (n: string) => `No answer reached it in time (you were busy in a turn), so the ` +
  `agent went on with its own assumption and states it in its summary. Check that assumption ` +
  `when you review, or \`wb steer ${n} --text "…"\` now if it is wrong.`

// /workbench run again with the mode already on and no task: the pane is back, and Claude needn't
// reread the skill to say so.
const AGAIN_NOTE = (skill: string) =>
  '[workbench] The user ran /workbench again: workbench mode is still on, and the Workbench ' +
  `pane is open again. Carry on as the skill says (read ${skill} if it is not in your context); ` +
  'reply in one line.'

const MODE_NOTE = (skill: string) =>
  'Workbench mode is on in this session: the user ran /workbench, and it lasts until /workbench-quit. ' +
  'Treat each request as the /workbench skill says: hand its coding to local agents with wb, ' +
  `then review and accept. Every plan you write, in plan mode or not, is a handoff plan: steps ` +
  `sized to the agents' slice, each with its files, exact interfaces and acceptance command (the ` +
  `skill's "Planning work you will hand off"). If that procedure is not in your context, read ` +
  `${skill} first.`

// What Claude learned about how this user wants delegation run (`wb notes`), in any project:
// Claude Code's own memory is per project, so these come back wherever workbench mode is on.
const NOTES_NOTE = (notes: string) =>
  'How this user wants delegation run, learned across their projects (`wb notes`; ' +
  '`wb notes add "…"` when they tell you something that holds in any repo, `wb notes drop N` ' +
  `when one no longer does):\n${notes}`

// Every slash command is /workbench or starts with it, so typing /workbench lists them all.
// /workbench is the skill; once the mode is on, running it again brings the pane back
// (2026-11-17: the commands were /delegate-*, and /delegate-pane did that).
const SKILL = 'workbench'
const UPDATE = 'workbench-update'
const QUIT = 'workbench-quit'
const HAND_BACK = 'workbench-quit-and-hand-back-claude'

// Claude coding (#92), the user's choice (`wb coding`): when Claude may write code for a delegated
// task. "decide" (no saved choice) adds nothing, so Claude works as before there was a choice.
const CODING_RULES: Record<string, string> = {
  ask: 'Claude coding is "Ask me first" (the user\'s choice; `wb coding` shows it). The local agent ' +
    'gets the first shot; review and advise as always. Before you write any of a task\'s code (an ' +
    'edit in its worktree, `wb takeover`), help the agent first (feedback, a smaller step). If it ' +
    'still falls short, ask the user for one specific edit, naming the task and the exact change, ' +
    'and wait: only their yes allows it. Record it with `wb coding allow <task> --edit "…" --said ' +
    '"<their words>"`; it lasts until you hand the task back. Unanswered, the work stays local.',
  only: 'Claude coding is "Only when I say" (the user\'s choice; `wb coding` shows it). Never write ' +
    'a task\'s code yourself, not a one-line fix in review nor `wb takeover`: guide the agent, ' +
    'and when it stays stuck, report the blocker to the user and keep the work with the agent. ' +
    'They say when you write code; then record their words with `wb coding allow <task> --edit ' +
    '"…" --said "<their words>"`.',
}

// The pane's Claude coding row (#93), in order; the choice is wb's (`wb coding`), the sentence is
// what the pane shows for the option under the ring or the pointer. The default says so, to show
// how it was at the start (the user, 2026-11-19)
const CODING_STOPS: [string, string, string][] = [
  ['only', 'Only when I say', 'You tell Claude when to write code.'],
  ['ask', 'Ask me first', 'Claude can ask to make a specific fix and waits for your yes.'],
  ['decide', 'Let Claude decide (default)', 'Claude uses its judgment to guide the local agent or make a fix itself.'],
]

// The web chat's row: the choice is wb's (`wb chat on|off`, chat/switch.json), off by default
const CHAT_STOPS: [string, string, string][] = [
  ['off', 'Off (default)', 'A localhost web server to interact with Claude.'],
  ['on', 'On', 'A localhost web server to interact with Claude.'],
]

// The probe experiment's row (ARCHITECTURE.md, *Experiments*): wb's choice (`wb experiment probe
// on|off`, experiments.json), off by default. A task keeps what it started with.
const PROBE_STOPS: [string, string, string][] = [
  ['off', 'Off (default)', 'The agent reads whole files, as without the experiment.'],
  ['on', 'On', "The agent reads a file's outline and one function with probe (github.com/probelabs/probe)."],
]

// What wb says of it: off, on and working (with probe's version), or on but not set up (no probe
// with `symbols` on PATH). The row says which, since it read "On" whether or not anything changed
// (the user, 2026-11-20). Asked of wb (`wb experiment probe`) only while the Settings tab draws
// with it on, at most every PROBE_RECHECK_MS, and again after each pick: a probe installed
// meanwhile shows without a restart.
const PROBE_RECHECK_MS = 30_000
type ProbeState = { state: 'off' | 'ready' | 'missing' | 'unknown'; version: string }
function probeSaid(out: string): ProbeState {
  const line = out.split('\n').find(l => l.startsWith('probe:')) ?? ''
  if (line.startsWith('probe: off')) return { state: 'off', version: '' }
  if (line.includes('not set up')) return { state: 'missing', version: '' }
  if (line.startsWith('probe: on')) return { state: 'ready', version: /and working \(([^)]*)\)/.exec(line)?.[1] ?? '' }
  return { state: 'unknown', version: '' }
}

async function probeStatus($: any): Promise<ProbeState> {
  if ((await probeMode($)) === 'off') return { state: 'off', version: '' }
  const now = await $.clock.now()
  if (mem.probe && now - mem.probe.at < PROBE_RECHECK_MS) return mem.probe.said
  const { ok, out } = await runWb($, ['experiment', 'probe'], 15_000)
  const said = ok ? probeSaid(out) : { state: 'unknown' as const, version: '' }
  mem.probe = { at: now, said }
  return said
}

function probeStops(s: ProbeState): [string, string, string][] {
  if (s.state === 'ready')
    return [PROBE_STOPS[0], ['on', 'On, working', `The agent reads a file's outline and one function with probe${s.version ? ` (${s.version})` : ''}.`]]
  if (s.state === 'missing')
    return [PROBE_STOPS[0], ['on', 'On, not set up', "probe isn't installed, so nothing changes yet: Claude can set it up."]]
  return PROBE_STOPS
}

// Claude's turn when the user turns it on and probe isn't there: offer to set it up (the user,
// 2026-11-20: "let Claude offer to help the user get it fully set up"), with wb's own line
const PROBE_SETUP_NOTE = (said: string) =>
  "[workbench] The user just turned on Agent code navigation (the probe experiment) in the " +
  `pane's Settings, but it can't work yet. wb says: ${said}\n` +
  'Offer to set it up, and install nothing without their yes. probe (github.com/probelabs/probe) ' +
  'is a code-search command-line tool; the agents need its release binary, whose `probe --help` ' +
  "lists `symbols` (crates.io's probe-code 0.6.0 doesn't, though it reports the same version). " +
  'Pick the asset for this OS and CPU from github.com/probelabs/probe/releases, put `probe` in a ' +
  'directory on the PATH you and wb run with (such as ~/.local/bin), then run `wb experiment ' +
  'probe` until it says "on and working". Tasks started from then use it; running ones keep ' +
  'what they started with. If they would rather not, `wb experiment probe off`.'

// Turns the probe experiment on or off through wb, then says how it came out: on and working, or
// on but not set up, which also asks Claude to offer the setup (once while it's queued)
async function setProbe($: any, value: string) {
  const { ok, out } = await runWb($, ['experiment', 'probe', value])
  mem.probe = null // the row asks wb again
  if (!ok) { $.ui.toast(`workbench: ${brief(out)}`); return }
  if (value !== 'on') return
  const s = probeSaid(out)
  if (s.state === 'missing') {
    $.ui.toast("workbench: Agent code navigation is on but not set up: probe isn't installed. Claude will offer to set it up.")
    const line = out.split('\n').find(l => l.startsWith('probe:')) ?? out
    if (!mem.queued.some(q => q.startsWith(PROBE_SETUP_NOTE('').slice(0, 60)))) mem.queued.push(PROBE_SETUP_NOTE(line))
  } else if (s.state === 'ready') {
    $.ui.toast(`workbench: Agent code navigation is on and working${s.version ? ` (${s.version})` : ''}: tasks started from now use it.`)
  }
}

async function probeMode($: any): Promise<string> {
  try {
    return JSON.parse(await $.fs.read(`${mem.root}/experiments.json`)).probe === 'on' ? 'on' : 'off'
  } catch {
    return 'off'
  }
}

// The Stats tab's rows (#406): what wb records for it and its live view, on by default (the user,
// 2026-11-20: a measurement that costs nothing is on, and every one can be turned off), then
// progress checks, off by default since each one wakes Claude. Each is wb's choice: `wb stats set`
// (stats.json), `wb progress` (progress.json).
const RECORD_STOPS: [string, string, string][] = [
  ['on', 'On (default)', 'Each task keeps how it went for the Stats tab: speeds, watts, what stopped it. Nothing leaves this machine.'],
  ['off', 'Off', 'Tasks keep only what workbench itself learns from.'],
]
const LIVE_STOPS: [string, string, string][] = [
  ['on', 'On (default)', 'The Stats tab shows this machine now (wb top), and only while it is on screen.'],
  ['off', 'Off', 'The Stats tab shows the history only.'],
]
const EVERY_STOPS: [string, string, string][] = [
  ['1', '1 s', 'How often the live view samples the GPU, the tasks and the models.'],
  ['2', '2 s (default)', 'How often the live view samples the GPU, the tasks and the models.'],
  ['5', '5 s', 'How often the live view samples the GPU, the tasks and the models.'],
]
const PROGRESS_OFF: [string, string, string] = ['off', 'Off (default)', 'No progress checks: each one wakes Claude, which spends its tokens.']
const PROGRESS_STOPS: [string, string, string][] = [
  PROGRESS_OFF,
  // the defaults are progress.py's DEFAULT_MIN and TYPICAL_MIN (#724)
  ['on', 'On', 'A task past its typical length (20 min trivial, 45 significant, until 3 of the size are timed on its model) gets a check, again at 2x and 4x, each with one recommendation, waking Claude.'],
]
// With a threshold set (`wb progress on --after N`, kept through the row's bare on/off) On says
// it: the typical length it named instead was the wrong one (#578)
function progressStops(after: number): [string, string, string][] {
  if (!after) return PROGRESS_STOPS
  return [PROGRESS_OFF, ['on', `On, after ${after} min`,
    `A task past ${after} min of active work gets a check and one recommendation, waking Claude.`]]
}
const SETTING_ROWS = /^(coding|chat|probe|record|live|every|progress):/ // the rows whose ring the pane follows

// One settings row: a Button naming the choice, which opens its options under it, each a Button
// (a click, or Enter on the ring), the chosen one marked. Under them the sentence of the option
// the ring is on, else the chosen one's; the pointer on an option lays its own over it (a hover
// reveal: no hook runs on hover). A pick folds the row again, which redraws it; the option
// already chosen only folds it, running nothing (#578: picking On again ran a bare
// `wb progress on`, which then dropped a `--after` threshold).
function settingRow(kit: Row, $: any, name: string, title: string, stops: [string, string, string][],
  value: string, view: WbPane, pick: (value: string) => Promise<unknown>) {
  const { Box, Text, Button } = kit
  const chosen = stops.find(s => s[0] === value) ?? stops[stops.length - 1]
  if (view.open !== name)
    return <Button key={name} label={`▸ ${title}: ${chosen[1]}`} plain onPress={() => { void update($, pane, p => ({ ...p, open: name, focus: '' })) }} />
  const ringed = stops.find(s => `${name}:${s[0]}` === view.focus) ?? chosen
  const width = Math.max(...stops.map(s => s[2].length))
  return (
    <Box flexDirection="column">
      <Button key={name} label={`▾ ${title}: ${chosen[1]}`} plain onPress={() => { void update($, pane, p => ({ ...p, open: '', focus: '' })) }} />
      {stops.map(([v, label]) => (
        <Button key={`${name}:${v}`} label={`  ${v === chosen[0] ? '❯' : ' '} ${label}`} plain dimColor={v !== chosen[0]}
          hover={{ scope: `wb-${name}-${v}` }}
          onPress={() => { void (v === chosen?.[0] ? Promise.resolve() : pick(v)).then(() => update($, pane, p => ({ ...p, open: '', focus: '' }))) }} />
      ))}
      <Box key={`${name}-says`}>
        <Text dimColor>{`    ${ringed[2].padEnd(width)}`}</Text>
        {stops.map(([v, , said]) => (
          <Box position="absolute" top={0} left={0} display="none" hover={{ display: 'flex', scope: `wb-${name}-${v}` }}>
            <Text dimColor>{`    ${said.padEnd(width)}`}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

// Turns the web chat on or off through wb, which keeps the choice (and starts a server for on),
// then reads it back at once: the link shows (or goes) with the pick, not at the next poll
// wb's reason is shown when it fails, as setProbe does: ignored, the row read On and the pane
// pinned a link that gave a 401 or nothing on the phone (#690). wb leaves the switch off then,
// so no link is pinned.
async function setWeb($: any, value: string) {
  const { ok, out } = await runWb($, ['chat', value], 15_000)
  if (!ok) $.ui.toast(`workbench: ${brief(out)}`)
  mem.chatUrlAt = 0
  await readSwitch($)
  await chatLink($)
}

// stats.json's settings as wb reads them (stats.py): each its default unless the file says
// otherwise, a mistyped value ignored
async function statsSettings($: any): Promise<{ recording: boolean; live: boolean; every: number }> {
  let d: any = {}
  try { d = JSON.parse(await $.fs.read(`${mem.root}/stats.json`)) } catch { /* the defaults */ }
  const on = (v: unknown) => (typeof v === 'boolean' ? v : true)
  return { recording: on(d?.recording), live: on(d?.live), every: [1, 2, 5].includes(d?.every) ? d.every : 2 }
}

// progress.json as wb reads it (progress.py): on only when it says so; a fixed threshold when
// `after` is a number other than 0 (wb's falsy), else 0
async function progressSettings($: any): Promise<{ on: boolean; after: number }> {
  let d: any = {}
  try { d = JSON.parse(await $.fs.read(`${mem.root}/progress.json`)) } catch { /* off */ }
  const after = typeof d?.after === 'number' && Number.isFinite(d.after) ? d.after : 0
  return { on: d?.on === true, after }
}

// The Stats tab's history: `wb stats --json`, only while the tab is shown, and only when what it
// is made from changed since the last read (results.jsonl: a task closed; stats.json: a setting;
// optimize.json, bench/runs.jsonl, speed.json and the price's savings.json, which the feed reads
// too and a stale tab kept for good, #549), the day it was counted from has ended (its `until`:
// an ended streak and last week's numbers stayed for days, #575), or not yet in this load.
// `force` on the tab's press and after a settings pick. A stat a file is all a poll costs while
// the tab is shown; nothing at all while it isn't.
async function refreshStats($: any, force = false) {
  if (mem.statsReading || (await read($, pane)).tab !== 'stats') return
  const shown = ((await $.ui.panes().catch(() => [])) as Row[]).find(p => p.id === PANE)
  if (!shown?.isShown) return
  const stamp = async (f: string) => {
    try { const s = await $.fs.stat(f.startsWith('/') ? f : `${mem.root}/${f}`); return `${s.size}@${s.mtimeMs}` } catch { return '-' }
  }
  // on a network home each machine keeps its optimize.json and speed.json in machines/<id>/
  // (store.machine_dir, #894): every machine's, since which one is this is wb's to say
  const machines = await $.fs.list(`${mem.root}/machines`).catch(() => []) as { name: string; kind: string }[]
  const own = machines.filter(e => e.kind === 'dir').flatMap(e =>
    ['optimize.json', 'speed.json'].map(f => `machines/${e.name}/${f}`))
  const key = (await Promise.all(['results.jsonl', 'stats.json', 'optimize.json', 'bench/runs.jsonl',
    'speed.json', ...own, mem.savingsFile || '-'].map(stamp))).join(' ')
  const had = await read($, statsFeed)
  const now = await $.clock.now()
  const dayOver = typeof had.feed?.until === 'number' && now / 1000 >= had.feed.until
  if (!force && had.feed && key === had.key && mem.statsLoaded && !dayOver) return
  if (!force && now < mem.statsRetryAt) return // it failed: not at every poll (#553)
  mem.statsReading = true
  // wb missing, failing or slow: the last feed stays, the reason is said, and the next try waits
  const failed = (why: string) => {
    mem.statsBackoff = Math.min(mem.statsBackoff ? mem.statsBackoff * 2 : STATS_RETRY_MS, RETRY_MAX_MS)
    mem.statsRetryAt = now + mem.statsBackoff
    mem.statsWhy = why
    $.ui.invalidate('ui.render')
  }
  try {
    const r = await $.process.run([mem.wb, 'stats', '--json'], { timeoutMs: 30_000 })
    if (r.exitCode !== 0) return failed(brief(r.stderr || r.stdout) || `exit ${r.exitCode}`)
    const feed = JSON.parse(r.stdout)
    if (!feed || typeof feed !== 'object') return failed('not a feed')
    mem.statsWhy = ''
    mem.statsBackoff = mem.statsRetryAt = 0
    await update($, statsFeed, () => ({ key, feed }))
    mem.statsLoaded = true
  } catch (err) {
    failed(brief(String(err)))
  } finally {
    mem.statsReading = false
  }
}

// Whether the live view should run now: the Stats tab on screen (its tab, the pane shown and not
// minimized) with the live view on. Anything else and `wb top` isn't running.
async function topWanted($: any): Promise<boolean> {
  const view = await read($, pane)
  if (view.tab !== 'stats' || view.minimized) return false
  const shown = ((await $.ui.panes().catch(() => [])) as Row[]).find(p => p.id === PANE)
  return !!shown?.isShown && (await statsSettings($)).live
}

// Starts or ends the live view's child to match topWanted: at each poll, on a tab's press, a
// minimize and a Live view pick, and on each line it prints (so leaving the tab ends it within a
// tick, whatever else happens). Every await comes first and the check and the spawn after them,
// with none between: a poll and a tab press at once both saw no child across the clock's await,
// both started one, and only the second was ever ended by a close (#546)
async function syncTop($: any) {
  const gen = mem.topGen
  const now = await $.clock.now()
  const want = await topWanted($)
  if (gen !== mem.topGen) return // started or stopped meanwhile: that call's view is newer
  if (want && !mem.top && now >= mem.topRetryAt) runTop($)
  else if (!want && (mem.top || mem.topKids.size)) stopTop($)
}

// Ends every child started, and forgets the last tick: shown again, the tab said a finished task
// was still "running · round 2" under Now until the next child's first line (#552)
function stopTop($: any) {
  mem.top = null
  mem.topGen += 1
  for (const child of mem.topKids)
    try { void child?.return?.(undefined)?.catch?.(() => {}) } catch { /* already ended */ }
  mem.topKids.clear()
  void update($, topNow, () => ({ snap: null, busy: {} })).catch(() => {})
}

// Starts the child and claims it at once (mem.top, mem.topKids), before any await; pumpTop reads it
function runTop($: any) {
  mem.topGen += 1
  const child = $.process.spawn({ argv: [mem.wb, 'top', '--json'] })
  mem.top = child
  mem.topKids.add(child)
  void pumpTop($, child)
}

async function pumpTop($: any, child: any) {
  await update($, topNow, () => ({ snap: null, busy: {} })) // the sparkline starts as the tab opens
  let buf = '', err = '', ticked = false, putAway = false
  try {
    for await (const { stream, text } of child) {
      if (!mem.topKids.has(child)) break // stopped meanwhile: its lines aren't the view's
      if (stream === 'stderr') err = (err + text).slice(-2000) // why it ended, should it (#553)
      if (stream !== 'stdout') continue
      buf += text
      let cut
      while ((cut = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, cut)
        buf = buf.slice(cut + 1)
        let snap: Row
        try { snap = JSON.parse(line) } catch { continue }
        if (!snap || typeof snap !== 'object') continue
        ticked = true
        mem.topFails = mem.topBackoff = 0
        mem.topWhy = ''
        await update($, topNow, prev => {
          const busy: Record<string, number[]> = {}
          for (const g of (snap.gpus ?? []) as Row[])
            if (typeof g.busy === 'number') busy[String(g.index ?? 0)] = [...(prev.busy[String(g.index ?? 0)] ?? []), g.busy].slice(-BUSY_KEEP)
          return { snap, busy }
        })
      }
      if (!mem.topKids.has(child)) break
      if (!(await topWanted($))) { putAway = true; break } // off screen now: leaving the loop ends the child
    }
  } catch (e) {
    err ||= String(e) // it could not start, or its stream closed: tried again after a while
  }
  const mine = mem.topKids.delete(child)
  if (mine && mem.top === child) { // it ended by itself, not by stopTop
    mem.top = null
    // put away by the engine is no failure: booked as one, a pane shown again 5 s later got no
    // child for 30 s, its last tick drawn as Now meanwhile (#552). Only an exit, a stream error or
    // a child that printed nothing waits, doubling, and says why (#553)
    if (putAway) await update($, topNow, () => ({ snap: null, busy: {} }))
    else {
      if (!ticked) mem.topFails += 1
      mem.topWhy = brief(err) || 'it ended'
      mem.topBackoff = Math.min(mem.topBackoff ? mem.topBackoff * 2 : TOP_RETRY_MS, RETRY_MAX_MS)
      mem.topRetryAt = (await $.clock.now()) + mem.topBackoff
      $.ui.invalidate('ui.render')
    }
  }
}

const BLOCKS = '▏▎▍▌▋▊▉█'
// ``frac`` (0..1) of ``width`` cells, in eighths, the rest light shade
export function bar(frac: number, width: number): string {
  const eighths = Math.round(Math.max(0, Math.min(1, frac)) * width * 8)
  const full = Math.floor(eighths / 8), part = eighths % 8
  const drawn = '█'.repeat(full) + (part ? BLOCKS[part - 1] : '')
  return drawn + '░'.repeat(Math.max(0, width - drawn.length))
}

const gib = (n: number) => (n / 2 ** 30).toFixed(1)
const secs = (s: number) => (s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`
  : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`)
// lspci's long name cut to the card's own, as `wb top` draws it (top.short): its last bracket
// when the name ends with one, else what follows the last bracket, the vendor's ("[AMD/ATI]
// Phoenix1" was shown as AMD/ATI, #576); "(rev c4)" dropped
export function cardName(name: string): string {
  const n = name.replace(/\s*\(rev [0-9a-f]+\)\s*$/i, '').trim()
  if (n.endsWith(']')) return [...n.matchAll(/\[([^\]]+)\]/g)].at(-1)?.[1] ?? n
  return n.slice(n.lastIndexOf(']') + 1).trim() || n
}
// cpu: all in RAM on a machine with no GPU memory, its normal state, not a split (#551)
const RACK_MARK: Record<string, string> = { resident: '●', cpu: '●', split: '◑', idle: '○', "can't run": '✗', remote: '⇢' }
const RACK_COLOR: Record<string, string> = { resident: 'success', cpu: 'success', split: 'warning', "can't run": 'error' }

// The rack rows folded into one line when more than RACK_FOLD_MIN of them (`wb top`'s top.FOLD):
// the owner, 2026-11-21: a machine with many models tried drew a row each, and the tab's menu sat
// a long scroll below a new user's first look. `wb top` and `wb models` still list every one.
const RACK_FOLD = new Set(['idle', "can't run", 'remote'])
const RACK_FOLD_MIN = 2

// The live view as lines of coloured parts: each GPU (memory and busy as bars, watts, busy's
// sparkline), what runs now, the rack (every model resident or with a task: where it is, its
// speeds, its load time, the task on it; the idle, can't-run and remote ones on one line past
// RACK_FOLD_MIN) and the queue. Nothing is said for what a platform can't tell.
export function liveLines(t: WbTop, why = ''): { color?: string; dim?: boolean; bold?: boolean; text: string }[][] {
  const s = t.snap
  // `why`: what `wb top` said as it ended, once it has failed twice: "Reading…" was all ever said (#553)
  if (!s) return [[{ dim: true, text: why ? `This machine can't be read: ${why} (wb top --json)` : 'Reading this machine…' }]]
  const out: { color?: string; dim?: boolean; bold?: boolean; text: string }[][] = []
  for (const g of (s.gpus ?? []) as Row[]) {
    const row: { color?: string; dim?: boolean; bold?: boolean; text: string }[] = [
      { bold: true, text: g.ram ? 'RAM ' : `GPU ${g.index ?? ''} ` }, { dim: true, text: `${cardName(String(g.name ?? ''))} ` }]
    if (typeof g.used === 'number' && g.total) {
      const f = g.used / g.total
      row.push({ color: f > 0.95 ? 'error' : f > 0.8 ? 'warning' : 'success', text: bar(f, 12) },
        { text: ` ${gib(g.used)}/${gib(g.total)} GiB ` })
    } else if (g.total) row.push({ dim: true, text: `${gib(g.total)} GiB${g.unified ? ' unified' : ''} ` })
    // an Apple GPU: its bar is the RAM, and the most of it the GPU may wire is said here (#701)
    if (typeof g.limit === 'number' && g.limit) row.push({ dim: true, text: `· GPU may wire ${gib(g.limit)} GiB ` })
    if (g.stale) row.push({ dim: true, text: 'no reading ' })            // known, not read just now (#547)
    if (typeof g.busy === 'number')
      row.push({ dim: true, text: '· busy ' }, { color: g.busy > 80 ? 'warning' : 'success', text: bar(g.busy / 100, 8) },
        { text: ` ${g.busy}% ` })
    if (typeof g.watts === 'number') row.push({ text: `· ${Math.round(g.watts)} W ` })
    const line = spark(t.busy[String(g.index ?? 0)] ?? [])
    if (line.length > 1) row.push({ dim: true, text: line.slice(-24) })
    out.push(row)
  }
  for (const r of (s.running ?? []) as Row[]) {
    const parts = [r.phase, r.round ? `round ${r.round}` : '', typeof r.round_s === 'number' ? secs(r.round_s) : '',
      typeof r.tok_s === 'number' ? `${Math.round(r.tok_s)} tok/s${r.tok_s_from === 'live' ? '' : ' (last call)'}` : '',
      typeof r.context_pct === 'number' ? `context ${r.context_pct}%` : ''].filter(Boolean)
    out.push([{ color: 'claude', text: '▶ ' }, { bold: true, text: `${r.task} ` }, { dim: true, text: `${r.label || r.model} · ${parts.join(' · ')}` }])
  }
  if (!(s.running ?? []).length) out.push([{ dim: true, text: 'Nothing running.' }])
  const rack = (s.rack ?? []) as Row[]
  const folds = rack.filter(m => RACK_FOLD.has(m.state) && !m.tasks?.length)
  const fold = folds.length > RACK_FOLD_MIN ? folds.length : 0
  for (const m of fold ? rack.filter(m => !folds.includes(m)) : rack) {
    const where = m.state === 'cpu' && typeof m.cpu_bytes === 'number' ? ` ${gib(m.cpu_bytes)} GiB in RAM`
      : typeof m.gpu_bytes === 'number'
        ? ` ${gib(m.gpu_bytes)} GiB on the GPU${m.cpu_bytes ? ` + ${gib(m.cpu_bytes)} on the CPU` : ''}` : ''
    const facts = [m.write_tok_s ? `writes ~${Math.round(m.write_tok_s)}` : '', m.read_tok_s ? `reads ~${Math.round(m.read_tok_s)}` : '',
      m.load_s ? `loads ~${secs(m.load_s)}` : '', m.state === 'remote' ? 'another machine: no telemetry' : m.why ?? ''].filter(Boolean)
    out.push([{ color: RACK_COLOR[m.state], dim: !RACK_COLOR[m.state], text: `${RACK_MARK[m.state] ?? '•'} ` },
      { text: `${m.label || m.model} ` }, { color: RACK_COLOR[m.state], dim: !RACK_COLOR[m.state], text: `${m.state}${where}` },
      { dim: true, text: facts.length ? ` · ${facts.join(' · ')}` : '' },
      ...(m.tasks?.length ? [{ color: 'claude', text: ` ← ${m.tasks.join(', ')}` }] : [])])
  }
  if (fold) out.push([{ dim: true, text: `+${fold} more models idle, can't run or remote (wb top)` }])
  for (const q of (s.queue ?? []) as Row[])
    out.push([{ color: 'warning', text: '◌ ' }, { text: `${q.task} ` },
      { dim: true, text: `waits for the GPU${typeof q.waited_s === 'number' ? ` (${secs(q.waited_s)})` : ''}` }])
  return out
}

// The commands that hand work out: run as a command, not merely written down. #409 (2026-11-20):
// a Python patch whose string held "split it (wb next)" turned a session's workbench mode on. So
// the command is read as bash reads it (#560, the text matcher before it disagreed both ways: it
// missed `"…/bin/wb" start`, `if wb start`, `! wb start`, `echo "$(wb start)"`, `timeout 60 wb
// start`, anything after a `<<<` here-string, and `wb resume`, and took `echo foo \; wb start` for
// two commands): heredoc bodies and comments dropped, quotes and backslashes undone within a word,
// a `$(…)` or backtick inside double quotes read as the commands it runs, and only a simple
// command's own word counts, past `VAR=x`, the reserved words and the wrappers (with their
// options): `wb` or a path ending in `/wb`.
const HANDS_OUT = new Set(['start', 'next', 'feedback', 'steer', 'answer', 'resume'])
const RESERVED = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', '{'])
// A wrapper that runs the rest: the options of it that take a value, and the words it takes
// before the command (timeout's duration)
const PREFIXES: Record<string, [string[], number]> = {
  env: [['-u', '-C', '-S', '--unset', '--chdir', '--split-string'], 0],
  time: [['-f', '-o', '--format', '--output'], 0],
  nohup: [[], 0], exec: [['-a'], 0], command: [[], 0],
  timeout: [['-s', '-k', '--signal', '--kill-after'], 1],
  nice: [['-n', '--adjustment'], 0], ionice: [['-c', '-n', '--class', '--classdata'], 0],
  stdbuf: [['-i', '-o', '-e', '--input', '--output', '--error'], 0],
}

// Where the `(` at `open` closes, quotes skipped (the end when it never does)
function closing(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') i++
    else if (c === "'") { const j = src.indexOf("'", i + 1); i = j < 0 ? src.length : j }
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return src.length
}

// The commands an unquoted heredoc's body runs: its `$(…)` and backticks (`\\` escapes)
function expansions(body: string): string[][] {
  const out: string[][] = []
  for (let j = 0; j < body.length; j++) {
    if (body[j] === '\\') j++
    else if (body[j] === '$' && body[j + 1] === '(') {
      const k = closing(body, j + 1)
      out.push(...simpleCommands(body.slice(j + 2, k)))
      j = k
    } else if (body[j] === '`') {
      const k = body.indexOf('`', j + 1)
      const end = k < 0 ? body.length : k
      out.push(...simpleCommands(body.slice(j + 1, end)))
      j = end
    }
  }
  return out
}

// The simple commands a bash command line runs, each as its words (quotes undone)
function simpleCommands(src: string): string[][] {
  const out: string[][] = []
  let words: string[] = []
  let word: string | null = null // null: between words
  const heredocs: { tag: string; strip: boolean; quoted: boolean }[] = []
  const endWord = () => { if (word !== null) words.push(word); word = null }
  const endCommand = () => { endWord(); if (words.length) out.push(words); words = [] }
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]!
    if (c === '\\') {
      if (src[i + 1] !== '\n') word = (word ?? '') + (src[i + 1] ?? '') // `\;` is a `;` in a word
      i += 2
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1)
      const end = j < 0 ? n : j
      word = (word ?? '') + src.slice(i + 1, end)
      i = end + 1
    } else if (c === '"') {
      let j = i + 1
      let text = ''
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') { text += src[j + 1] ?? ''; j += 2 }
        else if (src[j] === '$' && src[j + 1] === '(') {
          const k = closing(src, j + 1)
          out.push(...simpleCommands(src.slice(j + 2, k)))
          j = k + 1
        } else if (src[j] === '`') {
          const k = src.indexOf('`', j + 1)
          const end = k < 0 ? n : k
          out.push(...simpleCommands(src.slice(j + 1, end)))
          j = end + 1
        } else text += src[j++]
      }
      word = (word ?? '') + text
      i = j + 1
    } else if (c === '#' && word === null) { // a comment, to the line's end
      const j = src.indexOf('\n', i)
      i = j < 0 ? n : j
    } else if (c === '\n') {
      endCommand()
      i++
      for (const h of heredocs) { // their bodies start on the next line: up to the line that is the tag
        let body = ''
        while (i < n) {
          const j = src.indexOf('\n', i)
          const line = src.slice(i, j < 0 ? n : j)
          i = j < 0 ? n : j + 1
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.tag) break
          body += `${line}\n`
        }
        if (!h.quoted) out.push(...expansions(body)) // text, but `$(…)` in it runs
      }
      heredocs.length = 0
    } else if (c === '<' && src.startsWith('<<<', i)) { // a here-string: its word follows
      endWord()
      i += 3
    } else if (c === '<' && src[i + 1] === '<') { // a heredoc: its tag, quotes undone
      endWord()
      let j = i + 2
      const strip = src[j] === '-'
      if (strip) j++
      while (src[j] === ' ' || src[j] === '\t') j++
      const m = /^(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()'"]+))/.exec(src.slice(j))
      if (m) heredocs.push({ tag: m[1] ?? m[2] ?? m[3]!, strip, quoted: m[3] === undefined || m[0].startsWith('\\') })
      i = j + (m ? m[0].length : 0)
    } else if (c === '$' && src[i + 1] === '{') { // ${…}: part of the word
      const j = src.indexOf('}', i)
      const end = j < 0 ? n : j
      word = (word ?? '') + src.slice(i, end + 1)
      i = end + 1
    } else if (c === '$' && src[i + 1] === '(') { // $(…): the commands inside are commands too
      endCommand()
      i += 2
    } else if (';&|()`'.includes(c)) {
      endCommand()
      i++
    } else if (c === ' ' || c === '\t' || c === '<' || c === '>') {
      endWord()
      i++
    } else {
      word = (word ?? '') + c
      i++
    }
  }
  endCommand()
  return out
}

export function delegates(command: string): boolean {
  for (const words of simpleCommands(command)) {
    let i = 0
    for (;;) {
      const w = words[i] ?? ''
      if (/^[A-Za-z_]\w*=/.test(w) || RESERVED.has(w)) { i++; continue }
      const prefix = PREFIXES[w]
      if (!prefix) break
      i++
      let positional = prefix[1]
      while (i < words.length) {
        const o = words[i]!
        if (o === '--') { i++; break }
        if (o.startsWith('-') && o.length > 1) { i += prefix[0].includes(o) ? 2 : 1; continue }
        if (positional > 0) { positional--; i++; continue }
        break
      }
    }
    const cmd = words[i] ?? ''
    if ((cmd === 'wb' || cmd.endsWith('/wb')) && HANDS_OUT.has(words[i + 1] ?? '')) return true
  }
  return false
}

const SPARKS = '▁▂▃▄▅▆▇█'
// Values as one character each, the highest the full block; none for all zero
export function spark(values: number[]): string {
  const top = Math.max(0, ...values)
  return top > 0 ? values.map(v => SPARKS[Math.min(7, Math.round((Math.max(0, v) / top) * 7))]).join('') : ''
}

const kilo = (x: number) => (Math.abs(x) >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : `${Math.round(x / 1e3)}K`)
const GUARD_WORDS: Record<string, string> = {
  repeat: 'the same call repeated', errors: 'tool errors in a row', no_edit: 'no file changed',
  round: 'the round time limit', silence: 'silence', think: 'thinking with no tool call',
  handovers: 'handovers without finishing',
}

// stats.STATS_MODEL_LINES, kept here too: the mod tracks main while wb runs from the user's clone,
// so an older wb's feed (every model line, or only `models`) must not draw a row per model; and
// with no line to go by (no task yet), what Optimized, Bench and What helps name (2026-11-21)
const STATS_SHOWN = 3

// The Stats tab's history as lines (a label in bold, then the text): what the feed holds, each
// section left out when it has nothing, estimates said as such. A run of days that ended isn't
// mentioned, only the best (the plan's rule: show what went right, never nag).
export function statsLines(f: Record<string, any> | null, why = ''): { label: string; text: string }[] {
  // `why`: the last `wb stats --json` failed, said (#553): with no feed yet "Reading…" never ended
  if (!f) return [{ label: '', text: why ? `History unavailable: ${why} (wb stats --json)` : 'Reading the history…' }]
  if (why) return [{ label: '', text: `Not updated: ${why} (wb stats --json)` }, ...statsLines(f)]
  // only when the feed has no section at all: with no judged task, a period of spec-gap
  // discards (#569), the optimized windows and the bench results still have something to say (#549)
  if (!f.tasks && !Object.keys(f).some(k => !['ts', 'until', 'settings', 'tasks'].includes(k)))
    return [{ label: '', text: 'No finished tasks yet: delegate one with /workbench, and how it went shows here.' }]
  const out: { label: string; text: string }[] = []
  const period = (name: string, label: string) => {
    const p = f.periods?.[name]
    if (!p) return
    const s = p.score
    const saved = p.savings?.saved ?? 0
    const parts = [
      s ? `score ${s.score}/100` : '',
      p.savings ? (saved >= 0 ? `saved ~${kilo(saved)} Claude tokens (estimate)` : `cost ~${kilo(-saved)} more Claude tokens (estimate)`) : '',
      `${p.tasks} task${p.tasks === 1 ? '' : 's'}`,
      `${p.landed} landed${p.accepted_pct !== undefined ? ` (${p.accepted_pct}%)` : ''}`,
      // left out of the count, not the saving: Claude's tokens were spent on them (#569)
      p.spec_gaps ? `and ${p.spec_gaps} discard${p.spec_gaps === 1 ? '' : 's'} put down to the spec` : '',
      // the period's own energy, every task's: the saving's counts only the tasks it compares (#568)
      p.energy?.wh ? `${p.energy.wh >= 1000 ? `${(p.energy.wh / 1000).toFixed(1)} kWh` : `${Math.round(p.energy.wh)} Wh`}` +
        (p.energy.cost != null ? `, cost ${p.energy.cost.toFixed(2)}` : '') : '',
    ]
    out.push({ label, text: parts.filter(Boolean).join(' · ') })
  }
  period('week', 'This week')
  period('all', 'All time')
  if (f.streak) out.push({ label: 'Streak', text: f.streak.current
    ? `${f.streak.current} day${f.streak.current === 1 ? '' : 's'} in a row with a task landed · best ${f.streak.best}`
    : `best: ${f.streak.best} day${f.streak.best === 1 ? '' : 's'} in a row with a task landed` })
  const ab = f.absorbed
  if (ab) {
    const parts = [
      // attempts, whatever came of them; "green" only for the tasks whose tests then passed (#562)
      ab.auto_fixes ? `${ab.auto_fixes} test failure${ab.auto_fixes === 1 ? '' : 's'} sent back to the agent` +
        (ab.auto_fixed_tasks ? ` (${ab.auto_fixed_tasks} task${ab.auto_fixed_tasks === 1 ? '' : 's'} then green)` : '') : '',
      ab.handovers_landed ? `${ab.handovers_landed} landed after a handover to a fresh session` : '',
    ].filter(Boolean)
    if (parts.length) out.push({ label: 'Without waking Claude', text: parts.join(' · ') })
  }
  const q = f.questions // a question wakes Claude: its own line, "answered" only for wb answer's (#562)
  if (q?.asked) out.push({ label: 'Questions', text: `${q.asked} asked mid-task` +
    (q.answered ? ` · ${q.answered} answered` : '') })
  // the models OpenCode has now, a wb optimize variant folded under its source, the most recently
  // used first, the rest on one line (`model_lines`, #638); an older wb's feed: its `models`.
  // Capped here as well as in wb: a wb from before the cap sends every line (2026-11-21)
  const all: [string, any][] = f.model_lines
    ? (f.model_lines.lines ?? []).map((m: any) => [String(m.model), m])
    : Object.entries(f.models ?? {})
  const shown = all.slice(0, STATS_SHOWN), past = all.slice(STATS_SHOWN)
  for (const [model, m] of shown) {
    const trend = spark((m.write_trend ?? []).map((p: number[]) => p[1]))
    const speed = m.speed?.write ? ` · writes ~${Math.round(m.speed.write)} tok/s` : ''
    const change = typeof m.write_change_pct === 'number' && m.write_change_pct
      ? ` (${m.write_change_pct > 0 ? '+' : ''}${m.write_change_pct}%)` : ''
    const windows = (m.windows ?? []).length > 1 ? ` (${m.windows.map((w: number) => `${Math.round(w / 1024)}K`).join(', ')})` : ''
    out.push({ label: model + windows, text: `${m.tasks} task${m.tasks === 1 ? '' : 's'} · ${m.accepted_pct}% landed` +
      (m.rounds != null ? ` · ${m.rounds} rounds` : '') + (m.minutes != null ? ` · ${m.minutes} min` : '') +
      speed + (trend ? ` ${trend}` : '') + change + (m.claude ? ` · Claude ~${kilo(m.claude)}/task` : '') })
  }
  // the recent ones past stats.STATS_MODEL_LINES (and past this cap) and the older ones, one row;
  // labelled "Other models" so the text after it doesn't say "more models" twice (2026-11-21)
  const older = f.model_lines?.older
  const moreModels = (f.model_lines?.more?.models ?? 0) + past.length
  const moreTasks = (f.model_lines?.more?.tasks ?? 0) + past.reduce((n, [, m]) => n + (Number(m.tasks) || 0), 0)
  const others = moreModels + (older?.models ?? 0), otherTasks = moreTasks + (older?.tasks ?? 0)
  if (others) out.push({ label: 'Other models',
    text: [moreModels ? `${moreModels} more` : '', older?.models ? `${older.models} older` : ''].filter(Boolean).join(' · ') +
      ` model${others === 1 ? '' : 's'}: ${otherTasks} task${otherTasks === 1 ? '' : 's'} (wb stats --all)` })
  // Optimized, Bench and What helps name only the models shown above, a line's variants with it,
  // the rest counted, with where to see them (2026-11-21: 30 models' windows and runs made rows
  // taller than the screen); no model line yet (no task, or only older ones): the first STATS_SHOWN
  const ids = shown.length
    ? new Set<string>(shown.flatMap(([model, m]) => [model, ...(m.variants ?? [])])) : null
  const pick = <T,>(entries: [string, T][]): [[string, T][], number] => {
    const kept = entries.filter(([m], i) => (ids ? ids.has(m) : i < STATS_SHOWN))
    return [kept, entries.length - kept.length]
  }
  const counted = (kept: string[], rest: number, report: string) => kept.length
    ? kept.join(' · ') + (rest ? ` · ${rest} more (${report})` : '') : `${rest} model${rest === 1 ? '' : 's'} (${report})`
  const sized = Object.entries(f.sizes ?? {}) as [string, any][]
  if (sized.length) out.push({ label: 'By size', text: sized.map(([k, v]) => `${k} ${v.tasks} (${v.accepted_pct}%)`).join(' · ') })
  if (f.days?.length) {
    const line = spark(f.days.map((d: any) => d.tasks))
    if (line) out.push({ label: 'Last 30 days', text: `${line}  tasks per day` })
  }
  const bests = [
    f.bests?.largest_first_try ? `largest landed first try: ${f.bests.largest_first_try.lines} lines (${f.bests.largest_first_try.task})` : '',
    f.bests?.fastest ? `fastest landing: ${f.bests.fastest.minutes} min (${f.bests.fastest.task})` : '',
  ].filter(Boolean)
  if (bests.length) out.push({ label: 'Bests', text: bests.join(' · ') })
  const last = (f.milestones ?? []).at(-1)
  if (last) out.push({ label: 'Milestone', text: last.kind === 'landed'
    ? `${last.n} task${last.n === 1 ? '' : 's'} landed${last.day ? ` (${last.day})` : ''}`
    : `${kilo(last.n)} Claude tokens saved, estimated${last.day ? ` (${last.day})` : ''}` })
  const guards = Object.entries(f.guards ?? {}) as [string, number][]
  if (guards.length) out.push({ label: 'What stopped agents', text: guards.sort((a, b) => b[1] - a[1])
    .map(([g, n]) => `${GUARD_WORDS[g] ?? g} ${n}`).join(' · ') })
  const [helps, helpsRest] = pick(Object.entries(f.helps ?? {}) as [string, any][])
  const helped = helps.map(([model, h]) => [model, Object.entries(h).filter(([, v]: any) => v[1])
    .map(([k, v]: any) => `a ${k === 'smaller' ? 'smaller step' : k} helped ${v[0]} of ${v[1]}`)] as [string, string[]])
    .filter(([, said]) => said.length)
  helped.forEach(([model, said]) => out.push({ label: `What helps (${model})`, text: said.join(' · ') }))
  // the rest on a row of their own, not on the last model's, where it read as that model's (2026-11-21);
  // no text command prints them, the feed does
  if (helpsRest) out.push({ label: 'What helps', text: `${helped.length ? `${helpsRest} more` : helpsRest} model${helpsRest === 1 ? '' : 's'} (wb stats --json)` })
  const [bench, benchRest] = pick(Object.entries(f.bench ?? {}) as [string, any][])
  // the newest finished run, and a newer one beside it, never in its place (#570)
  const sofar = (p: any) => `${p.of} of ${p.planned} ${p.running ? 'so far' : 'before it stopped'}` +
    (p.of ? `, ${p.passed} passed` : '')
  if (bench.length || benchRest) out.push({ label: 'Bench', text: counted(bench.map(([m, b]) => `${m} ` +
    [b.run !== undefined ? `${b.passed}/${b.of} (${b.day})` : '', b.partial ? `newer run ${sofar(b.partial)}` : '']
      .filter(Boolean).join(', ')), benchRest, 'wb bench report') })
  const [opt, optRest] = pick(Object.entries(f.optimized ?? {}) as [string, any][])
  if (opt.length || optRest) out.push({ label: 'Optimized', text: counted(opt.map(([m, o]) => `${m} ${Math.round(o.window / 1024)}K` +
    (o.spill ? ` (${o.spill}% on the CPU)` : ' all on the GPU')), optRest, 'wb optimize report') })
  return out
}

// The file tools' path fields: an edit in a task's worktree is writing that task's code
const EDIT_TOOLS: Record<string, string> = { Edit: 'file_path', MultiEdit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' }

async function codingMode($: any): Promise<string> {
  try {
    const mode = JSON.parse(await $.fs.read(`${mem.root}/coding.json`)).mode
    return mode in CODING_RULES ? mode : 'decide'
  } catch {
    return 'decide'
  }
}

// Why Claude may not make this edit now, or '': outside a task's worktree, under "decide", or
// with the user's yes recorded for that task and not yet handed back (`wb coding allow`).
async function codingRefusal($: any, path: string): Promise<string> {
  const task = path.startsWith(`${mem.root}/tasks/`)
    // tasks/<t>/worktree, or tasks/<t>/tree/…/worktree for a sibling further up (#261)
    ? /^([^/]+)\/(?:tree\/(?:[^/]+\/)+)?worktree\//.exec(path.slice(mem.root.length + 7))?.[1] : undefined
  if (!task) return ''
  const mode = await codingMode($)
  if (mode === 'decide') return ''
  const file = `${mem.root}/tasks/${task}/coding.json`
  let allowed: Row[] = []
  try {
    allowed = JSON.parse(await $.fs.read(file)).allowed || []
  } catch {}
  const open = allowed.find(x => !x.used)
  if (open) {
    // a one-task exception (#94) is under way from its first edit: the next hand-back spends it
    if (open.when && !open.started) {
      open.started = (await $.clock.now()) / 1000
      await $.fs.write(file, JSON.stringify({ allowed })).catch(() => {})
    }
    return ''
  }
  return `workbench: not edited: ${task} is the local agent's. ${CODING_RULES[mode]}`
}
// Tasks of another session are listed as left alone: theirs to stop or finish.
const QUIT_NOTE = (out: string, ok: boolean) =>
  `[workbench] The user ran /${QUIT}: ` + (ok
    ? `this session's delegated agents were stopped (\`wb stop --all\`):\n`
    : `but \`wb stop --all\` failed, so its agents may still be running (\`wb status\`):\n`) +
  `${out}\nWorkbench mode is off: from now on work directly, without delegating. Don't finish, ` +
  `restart or clean up any of the stopped work unless they ask; real tasks keep their ` +
  `worktrees (\`wb status --all\`). Tasks left alone belong to another session.`
const DONE_NOTE = (out: string) =>
  `[workbench] The user ran /${HAND_BACK}: this session's agents were stopped and their tasks ` +
  `handed to you (\`wb takeover --all\`):\n${out}\n\nLeave workbench mode and finish the work ` +
  `yourself, without pausing to ask. For each task taken over: read what the agent left (\`wb diff <name>\`), ` +
  `complete it in its worktree to your own standard, run its acceptance command, then ` +
  `\`wb accept <name> -m "…"\` (add --merge only if the user asked for merging). Tasks left ` +
  `alone belong to another session: don't touch them unless the user asks. Then carry on ` +
  `with the rest of the user's request directly, without delegating, and report briefly at the end.`
// With the plugin's wake setting off, no [workbench] prompt comes: Claude must not end its turn
// waiting for one (the 2026-11-16 audit).
const WAKE_OFF_NOTE =
  'Wakes are off in this session (the workbench plugin\'s wake setting): no [workbench] prompt ' +
  'will say when a task needs you. After `wb start`, tell the user it runs and that a toast says ' +
  'when it is ready; pick it up when they ask (`wb report <name>`), and wait (`wb wait <name>`) ' +
  'only if they ask you to.'

// Back to "Let Claude decide" after a rule the conversation was given (#540)
const CODING_DECIDE = 'Claude coding is now "Let Claude decide" (the user\'s choice; `wb coding` shows it): ' +
  'the earlier Claude coding rule no longer applies; work as the /workbench skill says.'

// What this conversation was told of the rules that depend on the state (#540): the user's notes,
// that wakes are off, the Claude-coding rule. prompt.context fires once per conversation, at its
// first message (again after a compaction or /clear), and a block the engine doesn't route can't
// be added later: a session that entered workbench mode afterwards got no notes and no wake-off
// note, and a coding change from the pane reached only the file-tool gates.
type Said = WbSaid
// Kept across a reload within the session (#697): in `mem` alone a reload (a plugin option
// changed, /workbench-update, /reload-plugins) emptied it, and since prompt.context doesn't fire
// again in that conversation, sayRules waited for it for good: turning wakes off mid-session
// never said WAKE_OFF_NOTE, and Claude ended its turn waiting for a wake that would not come.
// A conversation's first context block (a /clear's, a compaction's) sets it again.
const saidState = atom({ plugin: 'workbench', key: 'said' } as const, null as WbSaid | null, { shape: 'said-1' })
async function setSaid($: any, said: Said) {
  mem.said = said
  await update($, saidState, () => said).catch(() => {}) // mem has it for this load either way
}

async function wanted($: any, delegating: boolean, notesToo = true): Promise<Said> {
  const notes = delegating && notesToo ? (await $.fs.read(`${mem.root}/notes.md`).catch(() => '')).trim() : ''
  const any = delegating || mem.open.size > 0
  return { notes, wakeOff: !mem.wake && any, coding: any ? await codingMode($) : 'decide' }
}

// The rules this conversation lacks now, as text, counted as said. Notes come once (Claude adds
// them itself, `wb notes add`); the coding rule again whenever it changes. Without a context block
// answered in this load (a reload), nothing is known of what it holds: it is all still to say.
async function unsaid($: any, delegating: boolean): Promise<string[]> {
  const want = await wanted($, delegating, !mem.said?.notes) // said once: not read at every poll
  const was = mem.said ?? { notes: '', wakeOff: false, coding: 'decide' } // after the await: no other caller in between
  const out: string[] = []
  if (want.notes && !was.notes) out.push(NOTES_NOTE(want.notes))
  if (want.wakeOff && !was.wakeOff) out.push(WAKE_OFF_NOTE)
  const any = delegating || mem.open.size > 0 // out of the mode with nothing open: nothing changes
  if (any && want.coding !== was.coding) out.push(want.coding === 'decide' ? CODING_DECIDE : CODING_RULES[want.coding])
  await setSaid($, { notes: was.notes || want.notes, wakeOff: was.wakeOff || want.wakeOff, coding: any ? want.coding : was.coding })
  return out
}

// Mid-conversation, a rule the conversation lacks goes in as a row the model reads, starting no
// turn; refused (an older Claude Code, a policy), a turn of its own.
async function sayRules($: any, delegating: boolean) {
  if (!mem.said) return // no context answered yet: the first message's blocks will say it
  const lines = await unsaid($, delegating)
  if (!lines.length) return
  const text = `[workbench] ${lines.join('\n\n')}`
  const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    .catch((err: unknown) => ({ deny: String(err) }))
  if (r?.deny) mem.queued.push(`${text}\n\nNothing to do now; reply in one line.`)
}

// The module's own memory: reset by a reload, which runs register and session.start again.
const mem = {
  wake: true,
  asksOpen: new Set<string>(),  // chat asks this session is waiting on (askOnChat)
  root: '',
  startedAt: 0,
  lastDrawn: '',
  lastNotify: '-', // notify.jsonl's size and mtime when last read
  notifyRows: { key: '', rows: [] as Row[] }, // its rows as last parsed, under that key (#921)
  paneOpened: false,
  polling: false,
  watching: false,
  wb: 'wb',
  liveKey: '', // the followed task and its updated_at when last read
  liveAt: 0, // when its transcript was last read
  statsReading: false, // a `wb stats --json` under way (refreshStats)
  statsLoaded: false, // the history was read in this load: the atom's feed may be an older load's
  statsWhy: '', // why the last `wb stats --json` failed ('' when it didn't): said on the tab (#553)
  statsRetryAt: 0, // not again before then, unless the tab is pressed
  statsBackoff: 0, // the wait after the last failure, doubling
  topWhy: '', // why the last `wb top` ended by itself: its stderr's last line
  topFails: 0, // `wb top` runs in a row that ended with no tick: said under Now from the second
  topBackoff: 0, // the wait before the next try, doubling
  top: null as any, // the `wb top --json` child while the live view runs (syncTop)
  topKids: new Set<any>(), // every child started and not yet ended: stopTop ends them all (#546)
  topGen: 0, // bumped by each start and stop: a syncTop whose awaits saw it change starts nothing
  topRetryAt: 0, // not before then, after one ended by itself
  price: null as number | null, // the electricity price wb says is set (`wb savings --json`)
  cwd: '', // the session's directory, resolved: which old tasks are this session's (mine)
  home: '', // the home directory, resolved: a session there claims no task by directory
  ids: new Set<string>(), // the `sessions` atom: which tasks are this session's (mine)
  deadPids: new Set<string>(), // Claude Code processes tasks recorded that are gone (pid@start): final (mine)
  pidAt: new Map<string, number>(), // when a live one was last checked (noteClaude)
  person: false, // someone can be at this session (not a bare `claude -p` or SDK run)
  started: false, // the ears and timers run
  busy: false, // Claude's main loop is mid-turn: a wake would queue and arrive stale
  queued: [] as string[], // turns for Claude that a command asked for
  probe: null as null | { at: number; said: ProbeState }, // wb's last word on the probe experiment (probeStatus)
  queuedRetryAt: 0, // a queued turn the engine dropped is tried again from then
  open: new Set<string>(), // this session's delegated tasks open at the last poll
  heldAsks: new Set<string>(), // questions (task:ts) held for a turn that could not take them (#542)
  said: null as Said | null, // what the conversation was told of the state's rules (#540); null: no context yet
  skillTurn: false, // /workbench's text said them in this turn: the context block computed after it doesn't
  delegated: false, // workbench mode was on in this load (a hand-back's compaction still keeps the state)
  turnEndedAt: 0, // when Claude's last main-loop turn ended
  follow: true, // the pane sticks to the newest lines until the person scrolls up
  sawTurn: false, // the person has used this session: a weekly check may follow
  scoutAsked: false, // the weekly model check was raised in this load
  updateAsked: false, // `wb update --check --if-due` ran in this load (wb keeps it weekly)
  optimizeAsked: false, // `wb optimize start --if-due` ran in this load (wb says when it's due)
  boundary: false, // one closed since: a moment to make room in Claude's context
  toasted: new Set<string>(),
  noticed: new Map<string, number>(), // each task's newest notice (its ts), as deliver last read
  dropped: new Map<string, number>(), // a task whose wake the engine dropped, and when: rewake retries after a minute
  warned: new Set<string>(), // one-time toasts already shown (a file unreadable, wb failing)
  chatSent: new Set<string>(), // web messages submitted by this load, awaiting their receipt
  chatRetry: new Map<string, number>(), // a web message whose prompt was dropped: tried again from then
  chatExpired: new Set<string>(), // web messages wb said are too old to pass on (#536): not asked again
  chatQueued: new Map<string, string>(), // web messages whose receipt says queued (id → by): read once a turn ends
  chatOwed: new Map<string, Owed>(), // web messages passed to Claude with no reply in the chat yet (#767)
  listenerAt: new Map<string, number>(), // another session's chat listener (pid@start), when last seen alive (#839)
  submitted: false, // this mod submitted a prompt while Claude was idle, and no turn has started since (#837)
  chatUrlAt: 0, // when the web chat's link was last looked up
  savingsAt: 0, // when the week's saving was last read
  eventsPid: 0, // the `wb events` child: its lines wake poll(); the chat counts it as this session
  eventsStart: '', // its start, as its hello says: with the pid, listener.json's proof of life (#532)
  claudePid: 0, // this Claude Code process, the `wb events` child's parent, as its hello says: 0 unknown (#687)
  machine: '', // this machine, as the hello says (store.machine): '' from a wb before #922
  claudeStart: '', // and its start
  earsOk: false, // `wb events` has said hello in this load: wb runs
  gone: new Set<string>(), // task directories closed past KEEP_CLOSED_MS: final, never read again
  recent: new Map<string, { key: string; recent: string[] }>(), // each task's last events, by events.jsonl's size@mtime (recentEvents)
  again: false, // something changed while a poll ran: run another after it
  hasActive: false, // a task is running: the clock redraws
  lastPoll: 0,
  listenerBody: '', // what this session last wrote to chat/listener.json
  tick: 0, // the apprentice's frame count
  posed: '' as Pose | '', // its pose as last drawn in a Raster: the timer animates it while set
  shown: '' as Pose | '', // the frame on screen now
  skill: '', // the /workbench skill's SKILL.md, for the workbench-mode block
  savingsFile: '', // savings.json, where wb keeps the kWh price ($WB_SAVINGS): the Stats key stamps it
  fold: false, // the session's directory is on a file system that ignores case (macOS): `within`
}

// Whether path b is path a or inside it, by whole components: /x/ab is not inside /x/a. In lower
// case where the file system ignores it (`mem.fold`, macOS): ~/Repos typed for ~/repos once
// missed (the 2026-11-19 audit). wb records task paths real (getcwd, git's toplevel).
const parts = (p: string) => (mem.fold ? p.toLowerCase() : p).split('/').filter(c => c && c !== '.')
const within = (a: string, b: string) => {
  const [pa, pb] = [parts(a), parts(b)]
  return pa.length <= pb.length && pa.every((c, i) => c === pb[i])
}

// Whether a task is this session's. One `wb start` ran in this process's sessions (task.json
// `session`) is, wherever it ran: by directory alone, a `cd /tmp/x && wb start` task was no one's
// (the 0.90 review). One without (started by hand, or before 0.90) goes by directory: its repo
// is the session's directory or inside it (a folder of several repos), or the session is inside
// the task's spot (`spotOf`: its package, else its cwd, else the repo; #695), or where `wb start` ran (`cwd`) is the session's directory or inside it. So
// does another session's whose Claude Code process (`claude_pid`) is gone: a new process in the
// project adopts it (the 0.90 review: after a crash or an update, plain `claude` in the same repo
// was woken for none of them). A session in the home directory or / claims none by directory: a
// task started from ~ belonged to every session under it (the 0.90 review). A task with no key
// at all is everyone's. `wb`'s _scope judges the same.
// A session inside the repo counts only inside the task's own spot: its package (repo/subdir),
// else where `wb start` ran when that is inside the repo, else the repo. Inside the repo alone, a
// session in a monorepo's sibling package was woken for another package's review (#695).
const spotOf = (t: { repo?: string; cwd?: string; subdir?: string }) =>
  t.subdir ? `${t.repo}/${t.subdir}` : t.cwd && within(t.repo!, t.cwd) ? t.cwd : t.repo!
const near = (t: { repo?: string; cwd?: string; subdir?: string }) => {
  const at = parts(mem.cwd).join('/')
  if (!at || (mem.home && at === parts(mem.home).join('/'))) return false
  return (!!t.cwd && within(mem.cwd, t.cwd)) ||
    (!!t.repo && (within(mem.cwd, t.repo) || within(spotOf(t), mem.cwd)))
}
const mine = (t: { session?: string; repo?: string; cwd?: string; subdir?: string; claude_pid?: number; claude_start?: string }) => {
  if (t.session && mem.ids.size) {
    return mem.ids.has(t.session) || (mem.deadPids.has(pidKey(t)) && near(t))
  }
  if (!mem.cwd || (!t.cwd && !t.repo)) return true
  return near(t)
}

// Whether another session's task's Claude Code process is gone (mem.deadPids, for `mine`): `kill
// -0` and its start (task.json `claude_start`: a recycled pid is another process, #532), a live
// one at most every PID_CHECK_MS. A gone one stays gone; one wb can't ask about (kill failed to
// run) stays unknown, so its task stays the other session's. Keyed by pid and start.
const PID_CHECK_MS = 30_000
const pidKey = (t: { claude_pid?: number; claude_start?: string }) =>
  `${Number(t.claude_pid ?? 0)}@${t.claude_start ?? ''}`
// A pid recorded on another machine (task.json `claude_machine`, listener.json `machine`): it
// means nothing in this one's /proc. On a state directory two machines share, each machine's mod
// read the other's live session as gone and adopted its tasks, back and forth, and took the chat's
// listener from it too (#922; the runners' own pids got the same fix in #849).
const elsewhere = (machine: unknown) => typeof machine === 'string' && !!machine && !!mem.machine && machine !== mem.machine

async function noteClaude($: any, t: { session?: string; claude_pid?: number; claude_start?: string; claude_machine?: string },
  now: number): Promise<void> {
  const pid = Number(t.claude_pid ?? 0)
  const key = pidKey(t)
  if (!pid || !t.session || mem.deadPids.has(key) || elsewhere(t.claude_machine)) return
  // this session's own, unless stamped by an older process of it (`claude --resume`): that one's
  // death is what lets this process claim it back from the others (#687)
  if (mem.ids.has(t.session) && (!mem.claudePid || ownPid(t))) return
  if (now - (mem.pidAt.get(key) ?? -Infinity) < PID_CHECK_MS) return
  mem.pidAt.set(key, now)
  const live = await alive($, pid, t.claude_start)
  if (live === false) mem.deadPids.add(key)
}

const ownPid = (t: { claude_pid?: number; claude_start?: string }) =>
  Number(t.claude_pid ?? 0) === mem.claudePid && (!t.claude_start || !mem.claudeStart || t.claude_start === mem.claudeStart)

// A task whose Claude Code process is gone is claimed, once, by the first session that would own
// it (`wb adopt`, under the task's lock): task.json then names this process, so every other
// session drops it. Unrecorded, it stayed every nearby session's for good, and the one resumed
// with `claude --resume` too: both woke for its review and both could act on it (#687). Returns
// task.json as it stands after the claim, whoever won.
async function claim($: any, name: string, sp: Row): Promise<Row> {
  if (!mem.claudePid || !sp.session || !mem.ids.size || !mem.deadPids.has(pidKey(sp)) || ownPid(sp)) return sp
  if (!mem.ids.has(sp.session) && !near(sp)) return sp
  const id = await $.session.id().catch(() => '')
  const ids = [...new Set([id, ...mem.ids].filter(Boolean))]
  const r = await runWb($, ['adopt', name, '--pid', String(mem.claudePid), ...ids.flatMap(i => ['--session', i])], 15_000)
  const now = await readJson($, `${mem.root}/tasks/${name}/task.json`)
  if (!r.ok && now.claude_pid === sp.claude_pid) mem.deadPids.delete(pidKey(sp)) // wb couldn't say: not ours to claim
  // a task adopted into this session was being delegated: the mode comes back with it (#689).
  // Not one the user's quit parked, nor one handed back to Claude (taken over): adopting those
  // turned the mode back on against /workbench-quit or the hand-back (#834).
  if (r.ok && delegatedWork(await readJson($, `${mem.root}/tasks/${name}/status.json`))) await workbenchMode($, true)
  return now.name ? now : sp
}

// Whether a task (its status.json) is still delegated work: running, or waiting on Claude and
// neither parked by a quit (store.parked, #698) nor taken over by Claude (#834)
const delegatedWork = (st: Row) => {
  const phase = String(st.phase ?? 'queued')
  if (ACTIVE.has(phase)) return true
  return NEEDS.has(phase) && !(['review', 'stuck', 'failed'].includes(phase) && st.parked) && !st.taken_over
}

// This session's id joins the ids this process has had: at the start and at each poll, so a
// /clear's new one counts before its first `wb start` is read.
async function noteSession($: any): Promise<void> {
  const id = await $.session.id().catch(() => '')
  if (!id || mem.ids.has(id)) return
  mem.ids.add(id)
  await update($, sessions, ids => (ids.includes(id) ? ids : [...ids, id]))
  if (mem.delegated && (await read($, chat)).delegating) await keepMode($, true) // a /clear's id resumes in the mode too (#689)
}

// A toast shown once per load: something is wrong that the person should hear about once.
const warnOnce = ($: any, key: string, text: string) => {
  if (mem.warned.has(key)) return
  mem.warned.add(key)
  $.ui.toast(`workbench: ${text}`)
}

// The Claude Code the mod is verified with (check.yml's CLAUDE_CODE_VERSION). Installs track
// main, so an older one met a call it lacks as a bare runtime error (the 2026-11-19 audit): it
// hears why once instead, and the mod carries on, since most of it may still work there.
const MIN_CLAUDE_CODE = '2.1.311'
const older = (a: string, b: string) => {
  const [x, y] = [a, b].map(v => v.split('.').map(n => parseInt(n, 10) || 0))
  const i = [0, 1, 2].find(k => x[k] !== y[k])
  return i !== undefined && x[i] < y[i]
}
async function checkVersion($: any) {
  let at: string | undefined
  try {
    const v = await $.session.version()
    at = (v?.base ?? v?.version ?? '').match(/^\d+\.\d+\.\d+/)?.[0]
  } catch { /* a Claude Code older than the call itself */ }
  if (at && !older(at, MIN_CLAUDE_CODE)) return
  warnOnce($, 'version', `this Claude Code${at ? ` (${at})` : ''} is older than ${MIN_CLAUDE_CODE}, ` +
    'which the pane and wake-ups are tested on: `claude update` if they misbehave')
}

// The last line of what a failing command said (a traceback ends with the error itself).
const brief = (out: string) => out.trim().split('\n').filter(Boolean).at(-1) ?? ''

// A file's text, only its last `max` bytes (from a whole line) when it is longer; '' when it is
// missing, null when it can't be read. $.fs.read rejects a file over 4 MiB, and notify.jsonl and
// the chat's files only grow: past that, deliver read '' and no wake came again (the 2026-11-16
// audit). `key` (size and mtime) tells a change without reading.
async function readTail($: any, path: string, max: number): Promise<{ text: string; key: string } | null> {
  const gone = async () => !(await $.fs.exists(path).catch(() => true))
  let st
  try {
    st = await $.fs.stat(path)
  } catch {
    return (await gone()) ? { text: '', key: '' } : null
  }
  const key = `${st.size}@${st.mtimeMs}`
  if (st.size <= max) {
    try {
      return { text: await $.fs.read(path), key }
    } catch {
      return (await gone()) ? { text: '', key: '' } : null
    }
  }
  try {
    const r = await $.process.run(['tail', '-c', String(max), path], { timeoutMs: 30_000 })
    if (r.exitCode !== 0) return null
    return { text: r.stdout.slice(r.stdout.indexOf('\n') + 1), key }
  } catch {
    return null
  }
}
const NOTIFY_TAIL = 1 << 20 // far more than OLDEST_WAKE_MS's hour of notices
const EVENTS_TAIL = 64 << 10 // the pane shows a task's last four events

// A task's last four events, read again only when events.jsonl's size or mtime changed: every
// poll (each 1.5 s while one task runs) read each open task's file, past EVENTS_TAIL by spawning
// `tail`, for tasks in review whose files hadn't changed in hours: 10-30 spawns a second in every
// session with the mod (#739, the 2026-11-21 audit).
async function recentEvents($: any, name: string, path: string): Promise<string[]> {
  let key = ''
  try {
    const st = await $.fs.stat(path)
    key = `${st.size}@${st.mtimeMs}`
  } catch {}
  const had = mem.recent.get(name)
  if (key && had?.key === key) return had.recent
  const got = await readTail($, path, EVENTS_TAIL)
  const recent = parseLines(got?.text ?? '').map(eventLine).filter(Boolean).slice(-4) as string[]
  if (got?.key) mem.recent.set(name, { key: got.key, recent })
  else mem.recent.delete(name)
  return recent
}

// Every task directory, as the pane draws it. Closed tasks drop out after half an hour, and are
// then never read again in this load (a closed phase is final): every poll read both files of
// every task ever created (the 2026-11-16 audit).
async function scan($: any, root: string, now: number): Promise<WbTask[]> {
  const dir = `${root}/tasks`
  const entries = (await $.fs.exists(dir)) ? await $.fs.list(dir) : []
  const list: WbTask[] = []
  const names = new Set<string>()
  for (const ent of entries) {
    if (ent.kind !== 'dir') continue
    names.add(ent.name)
    if (mem.gone.has(ent.name)) continue
    const base = `${dir}/${ent.name}`
    const st = await readJson($, `${base}/status.json`)
    const phase = String(st.phase ?? 'queued')
    const updatedAt = Number(st.updated_at ?? 0) * 1000
    if (!ACTIVE.has(phase) && !NEEDS.has(phase) && now - updatedAt > KEEP_CLOSED_MS) {
      if (phase === 'accepted' || phase === 'discarded') mem.gone.add(ent.name)
      continue
    }
    let sp = await readJson($, `${base}/task.json`)
    if (!sp.name || sp.bench) continue // a replay of wb bench's: no one's task, never shown or woken
    let recent: string[] = []
    if (ACTIVE.has(phase) || NEEDS.has(phase)) {
      await noteClaude($, sp, now)
      sp = await claim($, ent.name, sp)
      recent = await recentEvents($, ent.name, `${base}/events.jsonl`)
    }
    list.push({
      name: sp.name, phase, round: Number(st.round ?? 1), model: String(sp.model ?? ''),
      label: String(sp.model_label ?? ''),
      tests: st.tests ? (st.tests.ok ? 'pass' : 'fail') : null,
      last: String(st.last ?? ''), createdAt: Number(sp.created_at ?? 0) * 1000, updatedAt,
      tokens: Number(st.tok_in ?? 0) + Number(st.tok_out ?? 0), recent,
      repo: String(sp.repo ?? ''), cwd: String(sp.cwd ?? ''), subdir: String(sp.subdir ?? ''),
      session: String(sp.session ?? ''),
      claude_pid: Number(sp.claude_pid ?? 0), claude_start: String(sp.claude_start ?? ''),
      backlog: String(sp.backlog ?? ''),
      parked: ['review', 'stuck', 'failed'].includes(phase) && !!st.parked, // as store.parked (#698)
      allowed: allowedLine((await readJson($, `${base}/coding.json`)).allowed),
    })
  }
  for (const name of mem.gone) if (!names.has(name)) mem.gone.delete(name) // removed by hand
  for (const name of mem.recent.keys()) if (!names.has(name) || mem.gone.has(name)) mem.recent.delete(name)

  return list.sort((a, b) => a.createdAt - b.createdAt)
}

// The user's unspent allowance for a task (`wb coding allow`), for its line in the pane: what
// Claude may edit, and when, for a one-task exception (#94); '' for none
export function allowedLine(rows: unknown): string {
  const x = Array.isArray(rows) ? rows.find((r: Row) => r && !r.used) : undefined
  if (!x) return ''
  return x.when ? `Claude may, once, if ${x.when}: ${x.edit}` : `Claude may: ${x.edit}`
}

async function scoutIfDue($: any, now: number): Promise<void> {
  const path = `${mem.root}/scout.json`
  const st = await readJson($, path)
  const done = Number(st.done_at ?? 0) * 1000
  const offered = Number(st.offered_at ?? 0) * 1000
  if (now - done < SCOUT_EVERY_MS || now - offered < SCOUT_RETRY_MS) return
  await scoutOffered($, now)
  void $.prompt.submit({ text: SCOUT_NOTE })
}

// The model check is raised: not again in this load, nor by any session for a day. Also when
// /workbench-models raised it: the weekly check came straight after (the 2026-11-16 audit).
async function scoutOffered($: any, now: number): Promise<void> {
  mem.scoutAsked = true
  const path = `${mem.root}/scout.json`
  const st = await readJson($, path)
  await $.fs.write(path, JSON.stringify({ ...st, offered_at: now / 1000 })).catch(() => {})
}

async function compactAtBoundary($: any): Promise<void> {
  const set = await $.env.get('WB_COMPACT_AT') // a percentage; 0 turns it off
  const at = set && Number.isFinite(Number(set)) ? Number(set) / 100 : COMPACT_AT
  if (!at) return
  let context
  try {
    ({ context } = await $.session.usage({ breakdown: 'summary' }))
  } catch {
    return // no reading yet (a session before its first turn)
  }
  const b = context.breakdown
  const limit = b?.isAutoCompactEnabled && b.autoCompactThreshold ? b.autoCompactThreshold : context.window
  if (!context.tokens || context.tokens < at * limit) return
  try {
    const r = await $.session.compact({ instructions: KEEP_ON_COMPACT })
    if (!r.skip) {
      $.ui.toast(`workbench: a task closed; compacted Claude's context ` +
        `(${Math.round(context.tokens / 1000)}K tokens) to make room`)
    }
  } catch {
    // a turn began meanwhile: the next boundary tries again
  }
}

// `wb <args>`: ok when it exited 0, and what it said. A failing wb's traceback is not output to
// pass on as if it were the answer (the 2026-11-16 audit: it reached Claude as "open tasks").
// `wb update` takes the longest the engine allows: its steps may take 300 s each.
async function runWb($: any, args: string[], timeoutMs = 120_000): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await $.process.run([mem.wb, ...args], { timeoutMs })
    return { ok: r.exitCode === 0, out: `${r.stdout}${r.stderr}`.trim() || '(no output)' }
  } catch (err) {
    return { ok: false, out: `could not run wb ${args.join(' ')}: ${err}` }
  }
}

// `--session <id>` for each id this process has had, and `--repo <the session's directory>` for
// tasks without one: a quit or the status block takes this session's tasks only, as `mine` does.
async function scope($: any): Promise<string[]> {
  await noteSession($)
  return [...(mem.cwd ? ['--repo', mem.cwd] : []), ...[...mem.ids].flatMap(id => ['--session', id])]
}

// The task worth watching. The one followed stays while it runs: with two running, choosing by
// the latest status write swapped the pane between them on every tool call (the 2026-11-16
// audit). Else the newest started that runs (running, testing, asking before queued: a queued one
// shows nothing yet), else the newest waiting for Claude.
const focusOf = (list: WbTask[], followed: string): WbTask | undefined => {
  const kept = list.find(t => t.name === followed && ACTIVE.has(t.phase))
  if (kept) return kept
  const by = (ts: WbTask[], k: 'createdAt' | 'updatedAt') => [...ts].sort((a, b) => b[k] - a[k])[0]
  return by(list.filter(t => ACTIVE.has(t.phase) && t.phase !== 'queued'), 'createdAt') ??
    by(list.filter(t => t.phase === 'queued'), 'createdAt') ??
    by(list.filter(t => NEEDS.has(t.phase)), 'updatedAt')
}

// Re-read the followed task's transcript, while the pane is shown: while it runs (the agent's
// session moves between status writes) at most every LIVE_EVERY_MS, or once when it changed. Each
// read is an OpenCode export, which every session ran back to back, pane or not (the 2026-11-16
// audit). Off the poll's path: an export takes a moment.
async function refreshLive($: any, list: WbTask[], now: number) {
  if (mem.watching) return
  const followed = (await read($, live)).task
  const focus = focusOf(list, followed)
  const key = focus ? `${focus.name}@${focus.updatedAt}` : ''
  if (key === mem.liveKey && !(focus && ACTIVE.has(focus.phase) && now - mem.liveAt >= LIVE_EVERY_MS)) return
  // A running task writes its status on every tool call, and each write ran another `wb watch`
  // (a Python start and an OpenCode export) back to back for the whole round, a core kept busy
  // beside the model (#691): the same task, still running, is read at most every LIVE_EVERY_MS,
  // the change kept for the clock's next poll. Another task, or one that stopped, is read at once.
  if (focus && ACTIVE.has(focus.phase) && mem.liveKey.startsWith(`${focus.name}@`) &&
    now - mem.liveAt < LIVE_EVERY_MS) return
  // only the Tasks tab draws the transcript: on Stats or Settings each running round was exported
  // every LIVE_EVERY_MS for nothing (#838); the key still differs, so it is read on the way back
  if ((await read($, pane)).tab !== 'tasks') return
  const shown = ((await $.ui.panes().catch(() => [])) as Row[]).find(p => p.id === PANE)
  if (!shown?.isShown) return // read when it shows again: the key still differs
  mem.watching = true
  try {
    if (!focus) {
      mem.liveKey = ''
      await update($, live, () => ({ task: '', lines: [] }))
      return
    }
    const r = await $.process.run([mem.wb, 'watch', focus.name, '--json', '--last', String(KEEP_LINES)],
      { timeoutMs: 30_000 })
    if (r.exitCode !== 0) return
    mem.liveKey = key
    mem.liveAt = now
    const prev = await read($, live)
    // Cut at the engine's 4 MiB, the newest lines are the ones lost: keep what was shown and say so
    if (r.isStdoutTruncated) {
      const why = { s: 'bad', t: `transcript too long for the pane: wb watch ${focus.name}` }
      if (prev.task === focus.name && prev.lines.at(-1)?.t !== why.t) {
        await update($, live, () => ({ task: focus.name, lines: [...prev.lines, why] }))
      }
      return
    }
    const lines = parseLines(r.stdout)
      .map(x => ({ s: String(x.s ?? ''), t: clip(String(x.t ?? ''), LINE_CHARS) }))
      .slice(-KEEP_LINES)
    if (prev.task !== focus.name || JSON.stringify(prev.lines) !== JSON.stringify(lines)) {
      await update($, live, () => ({ task: focus.name, lines }))
      // The engine keeps a window at the end once it is there, but the pane opens at its top:
      // bring the newest lines into view, unless the person scrolled up to read.
      if (mem.follow) void $.ui.scroll({ in: PANE, to: 'end' }).catch(() => {})
    }
  } catch {
    // wb missing or slow: the task list still shows; try again next poll
  } finally {
    mem.watching = false
  }
}

// The ears: a `wb events` child for the session's life, respawned if it dies. One that never says
// hello (wb not on Claude Code's PATH, `wb setup` never run, a Python too old) was respawned every
// 2 s for good, and nobody was told (the 2026-11-16 audit): it is said once, and the respawns back
// off to a minute until wb has answered once.
async function ears($: any) {
  let wait = 2000
  for (;;) {
    let why = 'it exited at once'
    let hello = false
    try {
      const child = $.process.spawn({ argv: [mem.wb, 'events'] })
      let buf = ''
      for await (const { stream, text } of child) {
        if (stream !== 'stdout') {
          if (!hello && text.trim()) why = brief(text)
          continue
        }
        buf += text
        let cut
        while ((cut = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, cut)
          buf = buf.slice(cut + 1)
          let ev: Row
          try { ev = JSON.parse(line) } catch { continue }
          if (ev.hello) {
            mem.eventsPid = Number(ev.hello)
            mem.eventsStart = typeof ev.start === 'string' ? ev.start : '' // listener.json's start (#532)
            mem.claudePid = Number(ev.parent ?? 0) || 0 // whose tasks `wb adopt` claims (#687)
            mem.claudeStart = typeof ev.parent_start === 'string' ? ev.parent_start : ''
            mem.machine = typeof ev.machine === 'string' ? ev.machine : ''
            mem.earsOk = hello = true
            wait = 2000
          }
          void poll($)
        }
      }
    } catch (err) {
      why = brief(String(err)) // the child could not start or its stream closed: start another below
    }
    mem.eventsPid = 0
    mem.eventsStart = ''
    if (!mem.earsOk) {
      warnOnce($, 'ears', `can't run \`${mem.wb} events\` (${why}): the pane runs on the task ` +
        `files alone. Put wb on Claude Code's PATH or set WB_BIN; wb doctor`)
      wait = Math.min(wait * 2, 60_000)
    }
    try {
      await $.clock.sleep(wait)
    } catch {
      return // no clock to wait on (a test): the timer's safety poll stands in
    }
  }
}

// The weekly check waits for a quiet minute after a turn: raised the moment the first turn ended,
// it buried the question Claude had just asked the person (the 2026-11-16 audit).
const SCOUT_QUIET_MS = 60_000

// `wb savings --json` as the pane's footer: "this week: saved ~1.2M Claude tokens (46%, estimate) · 0.9 kWh",
// with ", cost 0.27" once a price is set (as the Stats tab and `wb savings` label it: no currency
// sign, the price is the user's); '' until a task can be compared, or when the output isn't wb's.
export function savedLine(out: string): string {
  let t: any
  try { t = JSON.parse(out) } catch { return '' }
  if (!t || typeof t.tasks !== 'number' || !t.tasks || typeof t.saved !== 'number') return ''
  const n = (x: number) => (Math.abs(x) >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : `${Math.round(x / 1e3)}K`)
  const pct = t.self_est > 0 ? ` (${Math.round((100 * t.saved) / t.self_est)}%, estimate)` : ' (estimate)'
  const what = t.saved >= 0 ? `saved ~${n(t.saved)} Claude tokens${pct}` : `cost ~${n(-t.saved)} more Claude tokens (estimate)`
  const cost = typeof t.cost === 'number' ? `, cost ${t.cost.toFixed(2)}` : ''
  const gpu = t.wh ? ` · ${t.wh >= 1000 ? `${(t.wh / 1000).toFixed(1)} kWh` : `${Math.round(t.wh)} Wh`}${cost}` : ''
  return `this week: ${what}${gpu}`
}

// The electricity price `wb savings --json` says is set (per kWh), or null
export function priceOf(out: string): number | null {
  try {
    const p = JSON.parse(out).price
    return typeof p === 'number' && p > 0 ? p : null
  } catch {
    return null
  }
}

// What the price row was typed, as `wb savings --price` takes it: "0,30", "€0.30", "0.30 EUR" and
// "$0.3" are 0.3 (one comma or point, a currency sign or code before or after); empty is 'off'
// (it clears the price); anything else, "0x10" or "1e3" among them, is null. Number() took
// "0x10" as 16, and "0,30" and "€0.30" as nothing, with no hint why (#609).
export function parsePrice(text: string): number | 'off' | null {
  const s = text.trim()
  if (!s) return 'off'
  const m = /^(?:[^\d\s.,+-]{1,3}\s*)?(\d+(?:[.,]\d+)?|[.,]\d+)(?:\s*[^\d\s.,+-]{1,3})?$/u.exec(s)
  const v = m ? Number(m[1].replace(',', '.')) : NaN
  return v > 0 ? v : null
}

// The Settings tab's price row: wb checks and keeps it (`wb savings --price`), and its answer
// is the week's saving again, now with the energy's cost (the footer's `, cost …`)
async function setPrice($: any, text: string) {
  const v = parsePrice(text)
  if (v === null) {
    $.ui.toast('workbench: the electricity price per kWh is a number, like 0.30 or 0,30 (empty clears it)')
    return
  }
  const { ok, out } = await runWb($, ['savings', '--price', String(v), '--json'])
  if (!ok) {
    $.ui.toast(`workbench: ${brief(out)}`)
    return
  }
  mem.price = priceOf(out)
  const said = savedLine(out)
  if (said !== (await read($, savings))) await update($, savings, () => said)
  $.ui.invalidate('ui.render')
}

async function poll($: any) {
  if (!mem.root || !mem.person) return
  if (mem.polling) { // a slow file system must not stack polls, but no change may be missed
    mem.again = true
    return
  }
  mem.polling = true
  mem.again = false
  mem.lastPoll = await $.clock.now()
  try {
    await noteSession($)
    const now = await $.clock.now()
    const list = await scan($, mem.root, now)
    const drawn = JSON.stringify(list)
    if (drawn !== mem.lastDrawn) { // write only on change: every write redraws the pane
      mem.lastDrawn = drawn
      await update($, tasks, () => list)
    }
    const on = (await read($, chat)).delegating
    mem.hasActive = list.some(t => ACTIVE.has(t.phase))
    const { live, parts } = taskParts(list, on)
    $.ui.status(parts.length ? `⚒ wb · ${parts.join(' · ')}` : on ? '⚒ wb · workbench mode' : undefined)
    if ((live.length || on) && !mem.paneOpened) { // open once per load, in workbench mode or when its work starts
      mem.paneOpened = true
      if (!(await read($, pane)).minimized) void $.ui.open({ id: PANE, title: 'Workbench' }) // put away stays away
    }
    void refreshLive($, list, now)
    void refreshStats($)
    void syncTop($)
    if (!mem.busy && mem.queued.length && now >= mem.queuedRetryAt) void sendQueued($, mem.queued.shift()!)
    const isOpen = (t: WbTask) => ACTIVE.has(t.phase) || NEEDS.has(t.phase)
    // Only this session's tasks, and only in workbench mode, make a boundary: a task closing
    // compacted every session's context, delegating or not (the 2026-11-16 audit).
    const open = new Set(list.filter(t => isOpen(t) && mine(t)).map(t => t.name))
    if (on && [...mem.open].some(name => !open.has(name))) mem.boundary = true
    if ([...mem.open].some(name => !open.has(name))) mem.savingsAt = 0 // one closed: its row is new
    if (!on) mem.boundary = false
    mem.open = open
    await sayRules($, on)
    if (mem.boundary && !mem.busy && !list.some(t => waitsOnClaude(t) && mine(t))) {
      mem.boundary = false
      await compactAtBoundary($)
    }
    // the weekly check needs wb to run (`wb events` said hello) and a quiet minute after a turn,
    // in a session that delegates with wakes on: the plugin runs in every session, and one for
    // another project got the check, spent the day's offer and ignored wake off (#919)
    const quiet = quietForJobs(list, now, mine)
    if ((on || mem.delegated) && mem.wake &&
      mem.sawTurn && mem.earsOk && !mem.busy && !mem.scoutAsked && quiet &&
      now - mem.turnEndedAt >= SCOUT_QUIET_MS) await scoutIfDue($, now)
    if (mem.sawTurn && mem.earsOk && !mem.updateAsked) {
      mem.updateAsked = true
      void checkUpdate($) // off the poll's path: a stalled fetch held every wake (the 2026-11-16 audit)
    }
    if (mem.sawTurn && mem.earsOk && !mem.optimizeAsked && quiet) {
      mem.optimizeAsked = true
      void measureIfDue($)
    }
    await deliver($, now)
    await rewake($, now, list)
    await listen($, now)
    await readSwitch($)
    await chatLink($)
    if (now - mem.savingsAt > 10 * 60_000) {
      mem.savingsAt = now
      const { ok, out } = await runWb($, ['savings', '--json'])
      const said = ok ? savedLine(out) : ''
      mem.price = ok ? priceOf(out) : mem.price
      if (said !== (await read($, savings))) await update($, savings, () => said)
    }
  } finally {
    mem.polling = false
  }
  if (mem.again) void poll($)
}

// A minute or two of measuring the GPU for the local models, when wb says it's due (never run,
// the GPU changed, a new model); the user is told, Claude is not woken (the user, 2026-11-18).
async function measureIfDue($: any) {
  const { ok, out } = await runWb($, ['optimize', 'start', '--if-due'])
  if (ok && out.startsWith('measuring')) $.ui.toast(`workbench: ${out.trim()}`)  // else not due
}

// Claude Code's dialogs while the user is away on the web chat: the dialog would wait for nobody,
// so it goes to the chat and the user's answer there settles it (the user, 2026-11-18): a
// permission (Allow or Deny), a question (AskUserQuestion: the options they pick), a finished
// plan (ExitPlanMode: Keep planning, with a note). Approving a plan stays in the terminal: Claude
// Code ignores a hook's allow there, with or without a setMode (seen live, 2026-11-18), though it
// takes a deny. Unanswered in ASK_WAIT_MS, or the
// turn interrupted, it expires there and the dialog comes up as usual. It waits one `wb chat wait`
// at a time (a hook's budget stands still while a `$` call runs, and one may take ten minutes at
// most), so an interrupt is seen soon.
const ASK_WAIT_MS = 30 * 60_000
const ASK_CHUNK_S = 20
const KIND: Record<string, string> = { ExitPlanMode: 'plan', AskUserQuestion: 'question' }

function askText(input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const what = [i.command, i.file_path, i.url, i.path, i.pattern].find(v => typeof v === 'string')
  const text = typeof what === 'string' ? what : JSON.stringify(i)
  return text.length > 1500 ? text.slice(0, 1500) + '…' : text
}

// What a dialog sends wb, within an argument's size: a plan's first DETAIL_CHARS (one past wb's
// budget, so wb cuts it and says so) and each option's preview to PREVIEW_CHARS. wb measures the
// rest and cuts it to its own budget; a long plan was refused whole, and the dialog sat in the
// terminal with the phone told nothing (#535)
const DETAIL_CHARS = 40_001
const PREVIEW_CHARS = 2000
const CUT_NOTE = ' (cut: the rest is in the terminal)'
export function askQuestions(questions: unknown): unknown {
  if (!Array.isArray(questions)) return questions
  return questions.map(q => !q || typeof q !== 'object' || !Array.isArray((q as any).options) ? q : {
    ...q, options: (q as any).options.map((o: any) => o && typeof o.preview === 'string' && o.preview.length > PREVIEW_CHARS
      ? { ...o, preview: o.preview.slice(0, PREVIEW_CHARS) + CUT_NOTE } : o),
  })
}

// The PermissionRequest answer from the user's answer in the chat, else undefined (the dialog)
async function askOnChat($: any, tool: string, input: unknown, signal?: AbortSignal) {
  const kind = KIND[tool] ?? 'permission'
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  // `--opt=value`: a value starting with `-` was read as a flag (#535)
  const args = ['chat', 'ask', `--tool=${tool}`, `--kind=${kind}`, `--text=${kind === 'permission' ? askText(input) : ''}`]
  // this session's `wb events` process: once it's gone wb expires the ask, so a card left by a
  // crashed or closed session doesn't stay open for good, and pushes don't show it (#538)
  if (mem.eventsPid) args.push(`--pid=${mem.eventsPid}`)
  if (kind === 'question') args.push(`--detail=${JSON.stringify({ questions: askQuestions(i.questions) })}`)
  // what the call is for, as Claude described it (Bash's description): the card leads with it
  if (kind === 'permission' && typeof i.description === 'string' && i.description.trim())
    args.push(`--detail=${JSON.stringify({ purpose: i.description.trim().slice(0, 300) })}`)
  // a plan: its text, else its file, and whose it is; wb read the newest in the plans directory,
  // any project's, so a card could show another session's plan (#253, the audit of 1.2)
  if (kind === 'plan') {
    if (typeof i.plan === 'string' && i.plan) args.push(`--detail=${JSON.stringify({ plan: i.plan.slice(0, DETAIL_CHARS) })}`)
    else if (typeof i.planFilePath === 'string') args.push(`--detail=${JSON.stringify({ plan_file: i.planFilePath })}`)
    const session = await $.session.id().catch(() => '')
    if (session) args.push('--session', session)
    if (mem.cwd) args.push('--repo', mem.cwd)
  }
  const posted = await runWb($, args, 15_000)
  const [id, state] = (posted.out.split('\n').pop() || '').split(' ')
  if (!posted.ok || !id?.startsWith('ask-')) { // the away user is told where it waits, not left guessing (#535)
    const what = kind === 'plan' ? 'a plan' : kind === 'question' ? 'a question' : 'a permission'
    await runWb($, ['chat', 'reply', `--text=Claude is waiting on ${what} in the terminal: it couldn't be shown here.`], 15_000)
    $.ui.toast(`workbench: ${what} couldn't go to the web chat (${brief(posted.out)}): answer it here`)
    return undefined
  }
  if (state === 'allow') return { behavior: 'allow' as const }  // their setting: go ahead while away
  if (state === 'expired') return undefined  // a plan wb can't show: the dialog, in the terminal
  mem.asksOpen.add(id)
  try {
    return await waitOnChat($, id, kind, i, signal)
  } finally {
    mem.asksOpen.delete(id)
  }
}

async function waitOnChat($: any, id: string, kind: string, i: Record<string, unknown>, signal?: AbortSignal) {
  $.ui.toast(`workbench: ${kind === 'plan' ? 'the plan' : kind === 'question' ? "Claude's question" : 'a permission prompt'} is waiting for you in the web chat`)
  const deadline = (await $.clock.now()) + ASK_WAIT_MS
  while (!signal?.aborted) {
    const left = deadline - (await $.clock.now())
    if (left <= 0) break
    const secs = Math.max(1, Math.min(ASK_CHUNK_S, Math.ceil(left / 1000)))
    const { ok, out } = await runWb($, ['chat', 'wait', id, '--timeout', String(secs), '--json'], (secs + 15) * 1000)
    let a: any = null
    try { a = ok ? JSON.parse(out) : null } catch {}
    if (!a) break
    if (a.answer === 'allow') {
      if (kind === 'question') return { behavior: 'allow' as const, updatedInput: { ...i, answers: a.answers } }
      return { behavior: 'allow' as const }
    }
    if (a.answer === 'deny') {
      const note = a.note ? ` They said: "${a.note}"` : ''
      return { behavior: 'deny' as const, message: kind === 'plan'
        ? `The user wants changes to the plan before you go ahead (from the web chat).${note} Revise the plan, then present it again.`
        : kind === 'question'
          ? `The user didn't pick an answer in the web chat.${note} Ask them there (wb chat reply) instead.`
          : `The user said no in the web chat.${note} Ask them there (wb chat reply) what to do instead.` }
    }
    if (a.answer) break  // expired elsewhere
  }
  await runWb($, ['chat', 'answer', id, 'expired', '--by', signal?.aborted ? 'interrupted' : 'timeout'], 15_000)
  return undefined
}

async function checkUpdate($: any) {
  const { ok, out } = await runWb($, ['update', '--check', '--if-due'])
  if (ok && out.startsWith('update available')) $.ui.toast(`workbench: ${out}`)
}

// A turn a command asked for. One the engine drops (a settings hook's block, a Stop, a host's
// limit) goes back on the queue and is tried again in a minute: the hand-back's turn was lost
// after its agents were already stopped (the 2026-11-16 audit).
async function sendQueued($: any, text: string) {
  if (text === OWED_NOTE && !owedNudged()) return // answered, or the user came back, since it was queued (#837)
  mem.submitted = true
  const r = await $.prompt.submit({ text }).catch((err: unknown) => ({ drop: String(err) }))
  if (!r?.drop) return
  mem.submitted = false // dropped: no turn of its own comes
  mem.queued.unshift(text)
  mem.queuedRetryAt = (await $.clock.now()) + REWAKE_MS
  warnOnce($, `queued:${text.slice(0, 40)}`, `a turn for Claude was dropped (${r.drop}); trying again in a minute`)
}

// When a process started, as wb's models._started says it: /proc/<pid>/stat's 22nd field, else
// `ps -o lstart=` (macOS has no /proc) in UTC, since ps prints local time and a laptop that
// changed zones read every live session as gone (#848); '' when neither says.
async function startOf($: any, pid: number): Promise<string> {
  try {
    const stat = String(await $.fs.read(`/proc/${pid}/stat`))
    const field = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19]
    if (field) return field
  } catch {}
  return psStart($, pid, true)
}

// ps's lstart, in UTC, or (utc false) in the zone ps inherits, as stamps written before #848 were.
async function psStart($: any, pid: number, utc: boolean): Promise<string> {
  try {
    const r = await $.process.run(['env', 'LC_ALL=C', ...(utc ? ['TZ=UTC0'] : []), 'ps', '-o', 'lstart=', '-p', String(pid)], { timeoutMs: 5000 })
    if (r.exitCode === 0) return r.stdout.trim().split(/\s+/).join(' ')
  } catch {}
  return ''
}

// Whether a process lives and, given the start recorded beside its pid, is still the one that
// wrote it: a recycled pid is another process (#532), as wb's models._alive judges. Only two
// starts of one kind compare (both /proc's tick count, or both ps's date). Where there is /proc
// (Linux), /proc/<pid> says, else `kill -0` (macOS): a container without procps has no `kill`, so
// no gone process was ever seen, nobody adopted a crashed session's tasks, and two listening
// sessions took the chat's listener from each other on every poll (#700). null: unknown.
async function alive($: any, pid: number, start?: string): Promise<boolean | null> {
  if (await $.fs.exists('/proc/self/stat').catch(() => false)) {
    if (!(await $.fs.exists(`/proc/${pid}/stat`).catch(() => false))) return false
  } else {
    try {
      if ((await $.process.run(['kill', '-0', String(pid)], { timeoutMs: 5000 })).exitCode !== 0) return false
    } catch {
      return null
    }
  }
  if (!start) return true
  const now = await startOf($, pid)
  if (!now || /^\d+$/.test(now) !== /^\d+$/.test(start) || now === start) return true
  // a ps date recorded before #848, in local time, is still that process
  return !/^\d+$/.test(now) && (await psStart($, pid, false)) === start
}

// The web chat's switch, as the user left it (chat/switch.json, written by `wb chat on|off`): turned
// off, the link goes and the away state with it, so no prompt is sent where nobody reads; turned
// on, the link is looked up at once.
async function readSwitch($: any) {
  const web = !!(await readJson($, `${mem.root}/chat/switch.json`)).on
  if (web === (await read($, chat)).web) return
  if (web) mem.chatUrlAt = 0
  await update($, chat, c => ({ ...c, web, ...(web ? {} : { url: '' }) }))
  if (!web) await back($)
}

// The web chat's link while it is on, looked up again every ten minutes (it changes only with the token)
async function chatLink($: any) {
  const now = await $.clock.now()
  if (!(await read($, chat)).web || now - mem.chatUrlAt <= 10 * 60_000) return
  mem.chatUrlAt = now
  const { ok, out } = await runWb($, ['chat', 'url'])
  const link = ok && /^https?:\/\/\S+#token=\S+$/.test(out) ? out : ''
  if (link !== (await read($, chat)).url) await update($, chat, c => ({ ...c, url: link }))
}

async function listen($: any, now: number) {
  const st = await read($, chat)
  if (!st.delegating || !st.web) return
  const dir = `${mem.root}/chat`
  if (!mem.eventsPid) return // the chat knows a listener by its live `wb events` process
  const claim = await readJson($, `${dir}/listener.json`)
  const theirs = claim.session && claim.session !== st.key
  // whether it lives unknown, its claim stands while the file is fresh: read as gone, two
  // sessions took the listener from each other on every poll, each write the other's event (#700).
  // Asked only of another session's claim, and a live one at most every PID_CHECK_MS: on macOS
  // (no /proc) each ask is a `kill` and a `ps`, run on every poll, 80 a minute, even for this
  // session's own claim, whose answer went unused (#839).
  let lives: boolean | null = false
  if (theirs && claim.pid && elsewhere(claim.machine)) lives = true // can't be asked here (#922)
  else if (theirs && claim.pid) {
    const key = `${Number(claim.pid)}@${claim.start ?? ''}`
    if (now - (mem.listenerAt.get(key) ?? -Infinity) < PID_CHECK_MS) lives = true
    else {
      lives = await alive($, Number(claim.pid), claim.start ? String(claim.start) : '')
      mem.listenerAt.clear() // one claim at a time
      if (lives === true) mem.listenerAt.set(key, now)
    }
  }
  const fresh = async () => now - ((await $.fs.stat(`${dir}/listener.json`).catch(() => undefined))?.mtimeMs ?? 0) < CHAT_STALE_MS
  if (theirs && (claim.pid ? lives === true || (lives === null && await fresh())
    : now - Number(claim.ts ?? 0) * 1000 < CHAT_STALE_MS)) return // another session listens
  if (!(await $.fs.exists(dir))) await runWb($, ['chat', 'log']) // wb makes the directory
  const body = JSON.stringify({ session: st.key, cwd: mem.cwd, pid: mem.eventsPid,
    ...(mem.eventsStart ? { start: mem.eventsStart } : {}), ...(mem.machine ? { machine: mem.machine } : {}), busy: mem.busy })
  if (body !== mem.listenerBody || theirs || claim.session !== st.key) { // only on change: a write is an event
    mem.listenerBody = body
    await $.fs.write(`${dir}/listener.json`, body)
  }
  for (const m of await unread($, dir)) {
    const id = String(m.id ?? '')
    if (m.from !== 'user' || !id || mem.chatSent.has(id) || mem.chatExpired.has(id)) continue
    if ((mem.chatRetry.get(id) ?? 0) > now) continue // its prompt was dropped: again in a minute
    // Claimed under wb's lock: two sessions starting together both took the chat and both
    // submitted it, each guard knowing only its own sends (#84). Refused: another session's, or
    // too old to spring on Claude, by wb's one threshold, which the page shows too (#536): the mod
    // skipped it on its own clock, and the phone said "Delivered" for a message Claude never got.
    const claimed = await runWb($, ['chat', 'claim', id, '--by', st.key])
    if (!claimed.ok) {
      if (/ expired: /.test(claimed.out)) {
        mem.chatExpired.add(id)
        warnOnce($, 'chat-old', `${brief(claimed.out).replace(/^wb: \S+ /, 'a web chat message ')}`) // said, not dropped in silence (#329)
      } else mem.chatRetry.set(id, now + REWAKE_MS)
      continue
    }
    mem.chatSent.add(id)
    // The terminal shows only `[web chat] <their words>`: how to answer is the skill's to say. A
    // reply to wb shot's pair says which task and step it's about, whichever is active now (#99);
    // a take kept from Claude's shortlist (wb chat listen), which take and where it is (#397).
    const a = m.about && typeof m.about === 'object' ? m.about : null
    const about = !a ? ''
      : a.audio ? `(keeps take ${Number(a.n)} of the shortlist: ${String(a.path ?? a.name ?? '')}) `
      : `(about ${String(a.task)}, step ${Number(a.step)}, screenshots ${Number(a.n)}) `
    const text = `${WEB} ${about}${String(m.text ?? '')}${attachedLines(m.files)}`
    // Mid-turn, into the running turn, as a message typed mid-turn would be; else, or if that is
    // refused, as a prompt of its own (which waits for the turn to end).
    if (mem.busy) {
      const r = await $.session.send({ to: { sessionId: await $.session.id() }, text: `${text}\n\n${WEB_NOTE}` })
        .catch(() => ({ isDelivered: false }))
      if (r.isDelivered) await runWb($, ['chat', 'ack', id, '--by', st.key, '--how', 'now'])
      else void sendWeb($, id, text, 'queued', st.key)
      mem.chatOwed.set(id, { at: now, grace: r.isDelivered ? 0 : 1, nudged: false }) // queued: maybe the next turn's
    } else {
      // behind a prompt submitted this poll (a wake, a queued turn, another web message) whose
      // turn hasn't started yet, it enters only the turn after: that turn's end, Claude not yet
      // having seen it, sent the follow-up for a message Claude then answered (#837)
      mem.chatOwed.set(id, { at: now, grace: mem.submitted ? 1 : 0, nudged: false })
      void sendWeb($, id, text, 'now', st.key)
    }
    await $.fs.write(awayFile(), JSON.stringify({ at: now / 1000, by: st.key })).catch(() => {})
    $.ui.toast('workbench: a message from the web chat')
  }
}

// The user's messages without a receipt: wb's index of open work (chat/open.json), whatever the
// files' size. The tails it replaces lost a message behind 4 MiB of replies (#329, the audit of
// 1.4); they remain for a wb from before the index.
async function unread($: any, dir: string): Promise<Row[]> {
  const work = await readJson($, `${dir}/open.json`)
  if (work.messages && typeof work.messages === 'object') {
    return (Object.values(work.messages) as Row[]).sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0))
  }
  // the tails: both files only grow, and past 4 MiB the whole read failed and the chat went silent
  const messages = await readTail($, `${dir}/messages.jsonl`, NOTIFY_TAIL)
  const receipts = await readTail($, `${dir}/receipts.jsonl`, NOTIFY_TAIL)
  if (!messages || !receipts) {
    warnOnce($, 'chat', `can't read the web chat's files in ${dir}: wb doctor`)
    return []
  }
  const got = new Set(receipts.text.split('\n')
    .map(l => { try { return JSON.parse(l).id } catch { return undefined } }))
  return messages.text.split('\n').flatMap(line => {
    try {
      const m = JSON.parse(line)
      return m && !got.has(String(m.id ?? '')) ? [m as Row] : []
    } catch { return [] }
  })
}

// A web message as a prompt of its own; the receipt only once it entered. A dropped one had a
// "read" receipt for a message Claude never got (the 2026-11-16 audit): it is tried again.
async function sendWeb($: any, id: string, text: string, how: string, by: string) {
  mem.submitted = true
  const r = await $.prompt.submit({ text, asUser: true }).catch((err: unknown) => ({ drop: String(err) }))
  if (r?.drop) {
    mem.submitted = false
    mem.chatSent.delete(id)
    mem.chatOwed.delete(id) // not given to Claude: nothing owed yet
    mem.chatRetry.set(id, (await $.clock.now()) + REWAKE_MS)
    return
  }
  const { ok, out } = await runWb($, ['chat', 'ack', id, '--by', by, '--how', how])
  if (!ok) warnOnce($, 'chat-ack', `wb chat ack failed: ${brief(out)}`)
  else if (how === 'queued') mem.chatQueued.set(id, by)
}

// A web message Claude was given and hasn't answered in the chat (#767): the skill and WEB_NOTE
// say to answer with `wb chat reply`, and nothing checked. For two release cycles the owner wrote
// "Keep me updated over here" and "Status" from the phone, Claude answered every one in the
// terminal only, and the phone heard nothing (2026-11-21). At the end of the turn that had it
// (`grace`: a message queued behind a running turn may only enter the next), no reply yet means
// one follow-up turn naming `wb chat reply`; that one ending without a reply too, a plain note
// goes to the chat, so the phone always hears something. A reply is a `wb chat reply` (or
// `listen`, or `wb shot --chat`) in Bash, or a row of Claude's in messages.jsonl since; a prompt
// typed in the terminal ends it (the user is back).
type Owed = { at: number; grace: number; nudged: boolean }
const OWED_NOTE =
  '[workbench] The user wrote from the web chat and hasn\'t heard back: answer there with ' +
  '`wb chat reply --text "…"` (the web thread is all they see), briefly. Nothing else to do.'
const OWED_POSTED = 'Claude answered in the terminal; nothing was sent here.'
const REPLIES = /\bwb\b[^\n|;&]*\bchat\s+(reply|listen)\b|\bwb\b[^\n|;&]*\bshot\b[^\n]*--chat\b/
// The follow-up is owed while a message it was queued for is still unanswered: a reply or the
// user's return before it went left it in mem.queued, and it went anyway (#837)
const owedNudged = () => [...mem.chatOwed.values()].some(o => o.nudged)
function owedSettled() {
  if (owedNudged()) return
  for (let i = mem.queued.indexOf(OWED_NOTE); i >= 0; i = mem.queued.indexOf(OWED_NOTE)) mem.queued.splice(i, 1)
}
async function owedAtTurnEnd($: any) {
  if (!mem.chatOwed.size) return owedSettled()
  const tail = await readTail($, `${mem.root}/chat/messages.jsonl`, NOTIFY_TAIL)
  const replied = parseLines(tail?.text ?? '').filter(m => m.from === 'claude').map(m => Number(m.ts ?? 0) * 1000)
  let nudge = false
  for (const [id, o] of [...mem.chatOwed]) {
    if (replied.some(ts => ts >= o.at)) { mem.chatOwed.delete(id); continue }
    if (o.grace > 0) { o.grace--; continue }
    if (!o.nudged) { o.nudged = true; nudge = true; continue }
    mem.chatOwed.delete(id)
    await runWb($, ['chat', 'reply', `--text=${OWED_POSTED}`], 15_000)
  }
  if (nudge && !mem.queued.includes(OWED_NOTE)) mem.queued.push(OWED_NOTE)
  owedSettled()
}

// A queued web message enters at the running turn's next step or as the next turn, so once that
// turn ends Claude has it: its receipt becomes read. The phone said "Queued for Claude" for good
// on messages Claude had read and acted on (2026-11-21).
async function readQueued($: any) {
  for (const [id, by] of [...mem.chatQueued]) {
    mem.chatQueued.delete(id)
    await runWb($, ['chat', 'ack', id, '--by', by, '--how', 'now'])
  }
}

// Notifications nobody has acknowledged yet: one toast each, and, for this session's tasks, a
// turn for Claude if waking. Another session's task is left for its own session (or `wb wait`):
// not acknowledged here.
async function deliver($: any, now: number) {
  const root = mem.root
  const path = `${root}/notify.jsonl`
  // The stat first, as recentEvents does (#739): every poll read the whole file (up to
  // NOTIFY_TAIL, past it a `tail` spawned) before the size@mtime check, which then skipped only
  // the parse; a few weeks of notices are hundreds of KB, read at each status write (#921).
  let key = ''
  try {
    const st = await $.fs.stat(path)
    key = `${path}:${st.size}@${st.mtimeMs}`
  } catch {}
  // While Claude is mid-turn, look every poll (the turn may act on the task) but hold the wake:
  // a prompt submitted now would queue and arrive after the task has moved on.
  if (key && key === mem.lastNotify && !mem.busy) return
  let file = key && key === mem.notifyRows.key ? mem.notifyRows : null // mid-turn: parsed already
  if (!file) {
    const got = await readTail($, path, NOTIFY_TAIL)
    if (!got) {
      warnOnce($, 'notify', `can't read ${path}, so no wake can come: wb doctor`)
      return
    }
    file = { key: got.key && `${path}:${got.key}`, rows: parseLines(got.text) }
    if (file.key) mem.notifyRows = file
  }
  if (file.key === mem.lastNotify && !mem.busy) return
  // Per task, its newest notice and every question: two asked at once (parallel tool calls) are
  // both open, and the newest alone hid the first, its agent blocked (the 2026-11-16 audit).
  const due = new Map<string, Row[]>()
  for (const row of file.rows) {
    // Every notice counts for rewake, however old: a notice delivered before a reload (or by
    // another session) is news Claude had, not a lost one (the 2026-11-16 audit).
    // a batch's notice is news for each task it names (acked with it), or rewake woke for the rest
    for (const n of [row.task, ...(batchOf(row) ?? [])]) mem.noticed.set(n, Math.max(mem.noticed.get(n) ?? 0, row.ts))
    if (row.ts * 1000 < Math.max(mem.startedAt, now) - OLDEST_WAKE_MS) continue
    due.set(row.task, [...(due.get(row.task) ?? []).filter(r => r.kind === 'question'), row])
  }
  // A wake held for the turn leaves the file unseen, so the poll after the turn sends it: a second
  // task's wake held while the first one's turn ran was never sent (the 2026-11-16 audit).
  let held = false
  for (const [name, rows] of due) {
    const ackPath = `${root}/tasks/${name}/acked`
    let acked = Number(await $.fs.read(ackPath).catch(() => '0')) || 0
    if (rows.every(r => r.ts <= acked)) continue
    let spec = await readJson($, `${root}/tasks/${name}/task.json`)
    await noteClaude($, spec, now)
    spec = await claim($, name, spec)
    const own = mine(spec)
    // Only wake for news still true: a review notice for a task since discarded, accepted or
    // sent back is acknowledged and dropped.
    const status = await readJson($, `${root}/tasks/${name}/status.json`)
    for (const row of rows) {
      if (row.ts <= acked) continue
      const current = row.kind === 'checkin'
        ? RUNNING.has(status.phase) // a check-in is news while the task still runs
        : row.kind === 'question' && row.id
          // this question, still unanswered, while the task still asks: a question the runner
          // dropped (timed out, its round ended or stopped) woke Claude for nobody (the 0.90 review)
          ? status.phase === 'asking' && await asking($, name, String(row.id))
          : status.phase === (row.kind === 'question' ? 'asking' : row.kind)
      const batch = batchOf(row)
      const headline = batch ? (batch.length > 1 ? `and ${batch.length - 1} more were interrupted`
        : 'was interrupted') : HEADLINE[row.kind] ?? row.kind
      const key = `${name}:${row.ts}`
      if (current && !mem.toasted.has(key)) {
        mem.toasted.add(key)
        $.ui.toast(`workbench: ${name} ${headline}`)
      }
      if (!own || !mem.wake) continue // the toast only: the notice stays for its session or wb wait
      // a batch's wake ends with its resume, not the failure's next step (#544)
      const next = batch ? BATCH_NEXT(batch) : (NEXT[row.kind] ?? NEXT.failed)(name, row.id ? String(row.id) : undefined)
      const who = batch && batch.length > 1 ? `Tasks ${batch.map(n => `\`${n}\``).join(', ')} were interrupted`
        : `Task \`${name}\` ${headline}`
      const text = `[workbench] ${who}.\n\n${row.text}\n\n${next}`
      if (mem.busy && current) {
        // A question can't wait for the turn to end: its agent is blocked, and after the ask
        // timeout it guesses (a 20-minute review turn, #542). It goes into the running turn, as
        // a web message does; refused, it is held like the rest, which deliver once the turn ends.
        if (row.kind === 'question') {
          if (!(await take($, name, row.ts))) { acked = row.ts; continue } // another session's wake took it
          await raiseAck($, ackPath, row.ts) // acknowledge before sending: never twice
          if (await intoTurn($, text)) {
            acked = row.ts
            continue
          }
          await release($, name, acked, row.ts) // only over this session's own mark (#786)
          mem.heldAsks.add(key)
        }
        held = true
        continue
      }
      const prev = acked
      if (current && !(await take($, name, row.ts))) { acked = row.ts; continue } // taken by another
      await raiseAck($, ackPath, row.ts) // acknowledge before waking: never wake twice
      acked = row.ts
      if (!current) {
        // held through the turn and timed out unseen: said, not acknowledged in silence (#542)
        if (mem.heldAsks.delete(key) && row.id && (ACTIVE.has(status.phase) || NEEDS.has(status.phase))
          && (await $.fs.read(`${root}/tasks/${name}/ask/${row.id}.answer`).catch(() => '')).startsWith(NO_ANSWER)) {
          void wake($, name, `[workbench] Task \`${name}\` asked a question while you were busy.\n\n${row.text}\n\n` +
            MISSED_NOTE(name), prev, row.ts)
        }
        continue
      }
      mem.heldAsks.delete(key)
      void wake($, name, text, prev, row.ts)
    }
  }
  if (!held) mem.lastNotify = file.key
}

// A notice taken for this session's wake, under wb's lock (`wb ack`, a compare-and-set shared with
// `wb wait`): two sessions woken by one `wb events` line each read `acked`, then wrote it, and
// both woke Claude for one review (#687). False only when wb says another took it first; a wb
// that can't run leaves the plain write after it to decide, as before.
async function take($: any, name: string, ts: number): Promise<boolean> {
  try {
    return (await $.process.run([mem.wb, 'ack', name, String(ts)], { timeoutMs: 15_000 })).exitCode !== 3
  } catch {
    return true
  }
}

// The plain write after a take, for a wb that couldn't run: only ever up. Written unchecked, it
// lowered a mark another session or `wb wait` had claimed since `wb ack` wrote this one, and that
// later notice was delivered twice (#786).
async function raiseAck($: any, ackPath: string, ts: number) {
  if ((Number(await $.fs.read(ackPath).catch(() => '0')) || 0) < ts) await $.fs.write(ackPath, String(ts))
}

// A wake taken but not delivered goes back to `prev`, only while the mark is still this session's
// `ts`: a compare-and-set under wb's lock (`wb ack <task> <prev> --if <ts>`); the plain write put
// the old mark back over a notice claimed since, delivered twice then (#786). A wb that can't
// run leaves the check-then-write, as before.
async function release($: any, name: string, prev: number, ts: number) {
  try {
    const r = await $.process.run([mem.wb, 'ack', name, String(prev), '--if', String(ts)], { timeoutMs: 15_000 })
    if (r.exitCode === 0 || r.exitCode === 3) return
  } catch {}
  const ackPath = `${mem.root}/tasks/${name}/acked`
  if (Number(await $.fs.read(ackPath).catch(() => '0')) === ts) await $.fs.write(ackPath, String(prev))
}

// Into the running turn, as a message typed mid-turn would be (`listen` does the same for the web
// chat): whether the engine took it.
async function intoTurn($: any, text: string): Promise<boolean> {
  const r = await $.session.send({ to: { sessionId: await $.session.id() }, text: `${await awayToo($, text)}\n\n${MIDTURN_NOTE}` })
    .catch(() => ({ isDelivered: false }))
  return !!r?.isDelivered
}

// Whether a question is still open: asked (ask/<id>.json) and not answered.
async function asking($: any, name: string, id: string): Promise<boolean> {
  const dir = `${mem.root}/tasks/${name}/ask`
  return (await $.fs.exists(`${dir}/${id}.json`)) && !(await $.fs.exists(`${dir}/${id}.answer`))
}

// A wake whose `acked` mark this load just moved from `prev` to `ts`. A prompt the engine drops (a
// settings hook's block, a Stop, a host's limit) never reached Claude, yet was acknowledged and
// lost for good (the 2026-11-16 audit): the mark goes back, unless something acted on the task
// since, and rewake tries again after a minute.
async function wake($: any, name: string, text: string, prev: number, ts: number) {
  mem.submitted = true
  const r = await $.prompt.submit({ text: await awayToo($, text) }).catch((err: unknown) => ({ drop: String(err) }))
  if (!r?.drop) return
  mem.submitted = false
  mem.dropped.set(name, await $.clock.now())
  await release($, name, prev, ts)
  warnOnce($, `drop:${name}`, `the wake for ${name} was dropped (${r.drop}); trying again in a minute`)
}

// The safety net under deliver: a task of this session's waiting on Claude whose news never
// reached it (a lost or swallowed notice; on 2026-11-16 a failure sat unseen for an hour) wakes
// Claude anyway, once, after a minute of Claude being idle. `acked` past the task's newest notice
// (or, with none, the moment it entered that state) means Claude has had the news.
const REWAKE_MS = 60_000
const REWAKE_MAX_MS = 12 * 3600_000 // older than this, it waited for a session long gone: wb status shows it
async function rewake($: any, now: number, list: WbTask[]) {
  if (mem.busy || !mem.wake) return
  for (const t of list) {
    if (!waitsOnClaude(t) || !mine(t) || now - t.updatedAt < REWAKE_MS || now - t.updatedAt > REWAKE_MAX_MS) continue
    if (now - (mem.dropped.get(t.name) ?? 0) < REWAKE_MS) continue // dropped: once a minute
    const ackPath = `${mem.root}/tasks/${t.name}/acked`
    const acked = Number(await $.fs.read(ackPath).catch(() => '0')) || 0
    // Claude had the news if it acked the task's latest notice: the runner's last status write
    // (its pid cleared) lands just after that notice, so updated_at alone would wake it twice.
    // The task's own `noticed` mark too (Task.notify): after a reload mem.noticed holds only
    // notify.jsonl's last 1 MiB, and a review whose notice had left it woke Claude again (#844)
    const marked = Number(await $.fs.read(`${mem.root}/tasks/${t.name}/noticed`).catch(() => '')) || 0
    const seen = mem.noticed.get(t.name)
    const noticed = seen !== undefined || marked ? Math.max(seen ?? 0, marked) : undefined
    if (noticed !== undefined ? acked >= noticed : acked * 1000 >= t.updatedAt) continue
    await $.fs.write(ackPath, String(now / 1000))
    const kind = t.phase === 'asking' ? 'question' : t.phase
    void wake($, t.name, `[workbench] Task \`${t.name}\` ${HEADLINE[kind] ?? kind}, ${ago(now - t.updatedAt)} ago, ` +
      `and no notice reached Claude. \`wb report ${t.name}\` shows where it is.\n\n` +
      (NEXT[kind] ?? NEXT.failed)(t.name), acked, now / 1000)
  }
}

// The ears and the timers, once a person can be at the session.
function startEars($: any) {
  if (mem.started) return
  mem.started = true
  void ears($)
  $.clock.every(POLL_MS, async () => {
    const now = await $.clock.now()
    if (!mem.eventsPid || mem.hasActive || mem.queued.length || now - mem.lastPoll > SAFETY_MS) void poll($)
  })
  $.clock.every(FRAME_MS, async () => {
    if (!mem.posed) return // not drawn in pixels, or the pane is closed
    const frame = frameOf(mem.posed, ++mem.tick)
    if (frame === mem.shown) return
    mem.shown = frame
    const r = await $.ui.blit({ requestId: PANE, key: APPRENTICE, cells: cells(frame) })
      .catch(() => ({ deny: 'gone' }))
    if (r.deny) mem.posed = '' // the next draw sets it again
  })
}

// Turning workbench mode on or off: the chat listens while it is on. The context block follows
// at the next compaction or /clear, not at once: invalidating it would rewrite the first message
// and cost the whole conversation's cache, and the skill or the quit note says it meanwhile.
// The quit commands close the pane, the mode's sign.
async function workbenchMode($: any, on: boolean) {
  if (on) mem.delegated = true
  if ((await read($, chat)).delegating === on) return
  await update($, chat, c => ({ ...c, delegating: on }))
  await keepMode($, on)
  if (!on) {
    await update($, pane, p => ({ ...p, minimized: false })) // quit: no strip either
    await $.ui.close({ id: PANE }).catch(() => {})
    const path = `${mem.root}/chat/listener.json` // stop listening: the page and other sessions see it now
    const claim = await readJson($, path)
    if (claim.session === (await read($, chat)).key) {
      await $.fs.write(path, '{}').catch(() => {})
      mem.listenerBody = ''
    }
  }
  void poll($) // listen now: a message may already be waiting
}

// Workbench mode by session id, on disk (`$.store` `modes`: id → when it was turned on), so a
// session resumed in a new process (`claude --continue`/`--resume`) comes back in it: the atom
// died with the old process, and until Claude happened to run a delegating command the chat
// didn't listen, the pane and status line didn't show it, and a compaction dropped it (#689).
// Kept MODES_KEEP_MS; a quit clears every id this process has had.
const MODES_KEEP_MS = 30 * 24 * 3600_000
async function keepMode($: any, on: boolean) {
  try {
    const now = await $.clock.now()
    const was = (await $.store.get('modes')) as Record<string, number> | undefined
    const modes: Record<string, number> = {}
    for (const [id, at] of Object.entries(was && typeof was === 'object' ? was : {})) {
      if (typeof at === 'number' && now - at < MODES_KEEP_MS && !mem.ids.has(id)) modes[id] = at
    }
    if (on) for (const id of mem.ids) modes[id] = now
    await $.store.set('modes', modes)
  } catch {} // no store (an older Claude Code, a test without one): the mode lasts this process
}
async function modeKept($: any): Promise<boolean> {
  try {
    const modes = (await $.store.get('modes')) as Record<string, number> | undefined
    return !!modes && typeof modes === 'object' && [...mem.ids].some(id => typeof modes[id] === 'number')
  } catch {
    return false
  }
}

// Opens the pane, or brings it back: a pane the engine still holds but doesn't show (a tab behind
// another, or left undrawn) only retitles on open, so it is closed first.
async function showPane($: any) {
  const held = (await $.ui.panes()).find((p: any) => p.id === PANE)
  if (held && (!held.isShown || !held.isPlaced)) await $.ui.close({ id: PANE }).catch(() => {})
  mem.paneOpened = true
  const opening = $.ui.open({ id: PANE, title: 'Workbench' })
  if ((await read($, pane)).minimized) await update($, pane, p => ({ ...p, minimized: false }))
  void paneBack($, opening)
  return opening
}

// Once an open lands, the Stats tab's history and live view catch up: /workbench again and a
// bring-back from the strip waited for the next poll, up to 30 s with no task (#552), and a
// syncTop before the open resolved could still see the pane hidden
async function paneBack($: any, opening: Promise<unknown>) {
  await Promise.resolve(opening).catch(() => {})
  void refreshStats($)
  void syncTop($)
}

// Brings the pane back from the strip, on the tab asked for. Opened first, while the press is still
// the person's: backseat-driver's opened after its awaits counted as its own, and an open the mod
// makes after a close by hand waits for a wide terminal (2026-10-07).
async function restorePane($: any, tab: string) {
  const opening = $.ui.open({ id: PANE, title: 'Workbench' })
  mem.paneOpened = true
  await update($, pane, p => ({ ...p, tab: tab || p.tab, minimized: false }))
  void paneBack($, opening)
  $.ui.invalidate('ui.render')
  return opening
}

// What the status line and the strip say of the tasks: the running ones, those asking, how many wait.
// Outside workbench mode only this session's: another session's task running opened the pane and
// filled the status line in a session the user kept off workbench, and /workbench-quit couldn't
// clear it (2026-11-17)
function taskParts(list: WbTask[], on: boolean) {
  const shown = on ? list : list.filter(t => mine(t))
  const live = shown.filter(t => ACTIVE.has(t.phase) && t.phase !== 'asking')
  // what waits on Claude is this session's alone, in the mode too: another session's reviews
  // counted in this one's "N awaiting review", as if this Claude had them to do (#693)
  const asking = shown.filter(t => t.phase === 'asking' && mine(t))
  const waiting = shown.filter(t => waitsOnClaude(t) && t.phase !== 'asking' && mine(t))
  return { live, parts: [
    ...live.map(t => `${t.name} ${t.phase} r${t.round}`),
    ...asking.map(t => `${t.name} asks`),
    ...(waiting.length ? [`${waiting.length} awaiting review`] : []),
  ] }
}

// A path variable as wb reads it (store.absolute_env: os.path.abspath(os.path.expanduser(v))):
// `~` expanded, relative to the directory wb runs in (the session's, where $.process.run starts
// it), `.`, `..` and repeated or trailing slashes gone. settings.json's `env` passes WB_HOME
// literally, and the mod took `~/state/wb` as given: the pane stayed empty and no wake came; a
// trailing slash made `…/workbench//tasks/`, and the Claude-coding guard never matched (#454).
export function absolutePath(v: string, home: string, cwd: string): string {
  let p = v === '~' ? home : v.startsWith('~/') ? `${home}${v.slice(1)}` : v
  if (!p.startsWith('/')) p = `${cwd}/${p}`
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }
  return `/${out.join('/')}`
}

// The task /workbench was given, as the skill's text has it after expansion ("**First task:**
// `<arguments>`."): empty when the user typed /workbench alone.
const firstTask = (text: string) => /\*\*First task:\*\* `([\s\S]*?)`\. Empty\?/.exec(text)?.[1].trim() ?? ''

export const register: Register = (on, options) => {
  mem.wake = (options as Row | undefined)?.wake !== 'off'

  on('session.start', async ($, e, next) => {
    const home = await $.env.get('HOME')
    const wbHome = await $.env.get('WB_HOME')
    const real = async (p: string) => (await $.fs.stat(p, { resolve: true }).catch(() => undefined))?.realPath ?? p
    mem.cwd = await real(e.cwd)
    const abs = (v: string) => absolutePath(v, home ?? '', mem.cwd) // as wb reads it (#454)
    mem.root = wbHome ? abs(wbHome) : `${home}/.local/state/workbench`
    // a path as wb reads its own (a `~` or a relative one, settings.json's env passes it as typed:
    // `~/repos/workbench/bin/wb` ran a literal `~`, and the mod couldn't run wb at all, #699); a
    // bare name still goes through PATH
    const bin = await $.env.get('WB_BIN')
    mem.wb = bin ? (bin.includes('/') || bin.startsWith('~') ? abs(bin) : bin) : 'wb'
    const config = await $.env.get('CLAUDE_CONFIG_DIR')
    mem.skill = `${config ? abs(config) : `${home}/.claude`}/skills/workbench/SKILL.md`
    const priced = await $.env.get('WB_SAVINGS')
    mem.savingsFile = priced ? abs(priced) : `${home}/.config/workbench/savings.json`
    mem.startedAt = await $.clock.now()
    // 2026-11-17: /delegate became /workbench. A copy updated across it still has only the old
    // skill link, which now leads nowhere: wb setup makes the new one and drops the old.
    const skills = mem.skill.slice(0, -'/workbench/SKILL.md'.length)
    if (!(await $.fs.stat(mem.skill).catch(() => undefined))
      && (await $.fs.stat(`${skills}/delegate`).catch(() => undefined))?.isLink) {
      const { ok, out } = await runWb($, ['setup'])
      $.ui.toast(ok ? 'workbench: /delegate is now /workbench (wb setup linked it)'
        : `workbench: /delegate is now /workbench, but wb setup failed: ${brief(out)}`)
    }
    if (!(await read($, chat)).key) {
      const key = `${Math.floor(mem.startedAt)}-${Math.random().toString(36).slice(2, 8)}`
      await update($, chat, c => ({ ...c, key }))
    }
    await $.command.register({
      name: MODELS,
      description: 'Check now which local models suit this machine best (weekly on its own)',
    })
    await $.command.register({
      name: UPDATE,
      description: 'Update workbench now: wb, the /workbench skill and this pane (checked weekly)',
    })
    await $.command.register({
      name: QUIT,
      description: 'Stop this session\'s delegated agents now, finishing nothing',
    })
    await $.command.register({
      name: HAND_BACK,
      description: 'Stop this session\'s agents and hand their tasks back to Claude to finish',
    })
    // the file system ignores case when the directory is there with every letter's case swapped
    const swapped = [...mem.cwd].map(c => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()).join('')
    mem.fold = swapped !== mem.cwd && !!(await $.fs.stat(swapped).catch(() => undefined))
    mem.home = home ? await real(home) : ''
    mem.ids = new Set(await read($, sessions))
    mem.said = mem.said ?? await read($, saidState) // a reload: what this conversation was told stands (#697)
    await noteSession($)
    if ((await read($, chat)).delegating) {
      // a reload in the mode (/workbench-update, an option change, /reload-plugins): mem.delegated
      // starts false, so a /clear's new id was never kept and `claude --continue` into it came
      // back with the mode off, #689 again (#840)
      mem.delegated = true
      await keepMode($, true)
    } else if (await modeKept($)) await workbenchMode($, true) // a resume (#689)
    // A `claude -p` run or an SDK session has no person at it until a surface attaches: it took
    // other sessions' wakes, the weekly check and a `wb status` before every prompt (the
    // 2026-11-16 audit). It stays quiet until then.
    mem.person = e.isInteractive || e.surface != null
    if (mem.person) {
      await checkVersion($)
      startEars($)
    }
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    if (!mem.person && mem.root) {
      mem.person = true
      startEars($)
    }
    return next(e)
  })

  // A tool call means a turn is running, even one that began before this module (re)loaded and
  // so never reached turn.start here; turn.complete clears it. Only the model's own (the
  // engine's): another plugin's $.tool.call between turns has no agentId either, and no
  // turn.complete would clear it, holding every wake (the 2026-11-16 audit).
  on('tool.call', async ($, e, next) => {
    if (!mem.busy && !e.agentId && next.origin.plugin === 'engine') { // a subagent's call doesn't hold the main loop
      mem.busy = true
      void poll($)
    }
    // Claude coding (#92): Claude's own edit in a task's worktree waits for the user's choice
    const field = EDIT_TOOLS[e.tool]
    const path = field ? (e as any)[field] : undefined
    if (typeof path === 'string') {
      const why = await codingRefusal($, path)
      if (why) return { deny: why }
    }
    return next(e)
  })

  // A dialog while the user is away on the web chat goes there (askOnChat): the moment it would
  // come up, in the session the chat listens to. A settings hook's own answer stands, and a
  // failed hook leaves the dialog to come up as usual.
  on('classic.PermissionRequest', async ($, e, next) => {
    const r = await next(e)
    if (r.decision) return r
    const st = await read($, chat)
    if (!st.delegating || !(await away($, st))) return r
    const decision = await askOnChat($, e.tool_name, e.tool_input, next.signal)
    return decision ? { ...r, decision } : r
  })

  // Delegating with wb counts as workbench mode too (a session resumed mid-delegation, or one
  // where /workbench ran before this mod could see it)
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (delegates(String(e.command ?? ''))) {
      await workbenchMode($, true)
    }
    if (REPLIES.test(String(e.command ?? ''))) {
      mem.chatOwed.clear() // answered in the chat (#767)
      owedSettled()
    }
    return next(e)
  })

  // /workbench turns workbench mode on for the session, with or without a task, and shows the pane.
  // Run again while it is on, it brings the pane back; alone, that is all it does.
  on('skill.prompt', { skill: SKILL }, async ($, e, next) => {
    if (e.path) mem.skill = e.path
    const again = (await read($, chat)).delegating
    // what the context block doesn't carry yet goes with the skill's text: before the poll the
    // mode starts, which would say it as a row of its own (#540)
    const extra = await unsaid($, true)
    if (extra.length) mem.skillTurn = true
    const add = (text: string) => extra.length ? `${text}\n\n${extra.join('\n\n')}` : text
    mem.paneOpened = true // before the poll workbenchMode starts, which would open it too
    await workbenchMode($, true)
    await showPane($)
    if (again && !firstTask(e.text)) return { text: add(AGAIN_NOTE(mem.skill)) }
    const r = await next(e)
    return { ...r, text: add(r.text) }
  })

  // Typed in the terminal: the user is back, so answers go here again
  on('prompt.submit', async ($, e, next) => {
    if (byUser(e) && !e.text.startsWith(WEB) && !e.text.startsWith('[workbench]')) {
      await back($)
      mem.chatOwed.clear() // back at the terminal: an answer there reaches them (#767)
      owedSettled()
    }
    return next(e)
  })

  // This session's tasks only (`--repo`): another session keeps its own running.
  on('command.run', { command: QUIT }, async $ => {
    await workbenchMode($, false)
    // waiting tasks too, as they stand: a review left at the quit stayed "awaiting review" and in
    // every new conversation's pick-up block (#698)
    const { ok, out } = await runWb($, ['stop', '--all', '--park-waiting', ...(await scope($))])
    $.ui.toast(ok ? 'workbench: this session\'s delegated agents are stopped'
      : `workbench: wb stop --all failed: ${brief(out)}`)
    return { text: ok ? `Delegation stopped. ${out}` : `Delegation not stopped: ${out}`, context: [QUIT_NOTE(out, ok)] }
  })

  on('command.run', { command: MODELS }, async $ => {
    await scoutOffered($, await $.clock.now()) // the weekly check won't raise it again straight after
    mem.queued.push(SCOUT_NOTE) // a command may not start a turn itself: the next poll does
    return { text: 'Claude will check the local models against this machine now.' }
  })

  on('command.run', { command: UPDATE }, async $ => {
    const { ok, out } = await runWb($, ['update'], 600_000)
    if (!ok || !out.startsWith('updated')) {
      return { text: `workbench: ${out}` + (ok ? '' : '\n(If it got as far as updating, /reload-plugins starts using it.)') }
    }
    try {
      await $.command.run({ command: 'reload-plugins', args: '' }) // the new pane, now
      return { text: `workbench: ${out}` }
    } catch {
      return { text: `workbench: ${out}. Run /reload-plugins to start using it.` }
    }
  })

  on('command.run', { command: HAND_BACK }, async $ => {
    await workbenchMode($, false)
    const { ok, out } = await runWb($, ['takeover', '--all', '--user', ...(await scope($))])
    // A refusal (the coding gate) still takes over the rest: a turn for those whenever one was
    // taken, the refusals said with them. Keyed on the exit code alone, one refused task left
    // Claude no turn for the ones whose agents it had just stopped (#918).
    if (!ok && !/^took over /m.test(out)) { // nothing was handed over: no turn telling Claude to finish it
      $.ui.toast(`workbench: wb takeover --all failed: ${brief(out)}`)
      return { text: `wb takeover --all failed; the agents may still be running (wb status):\n${out}` }
    }
    if (!ok) $.ui.toast(`workbench: some tasks weren't taken over: ${brief(out)}`)
    mem.queued.push(DONE_NOTE(out)) // a command may not start a turn itself: the next poll does
    return { text: `Agents stopped; Claude is taking over. ${out}` }
  })

  // Whoever compacts the main conversation, the summary keeps the delegation state: in a session
  // that delegated in this load, with a task of its own open. Any session's compaction got it
  // (the 2026-11-16 audit).
  on('session.compact', async ($, e, next) => {
    if (!e.agentId) mem.skillTurn = false // the blocks computed after it say everything again
    if (e.agentId || !mem.open.size || e.instructions?.includes(KEEP_ON_COMPACT)) return next(e)
    if (!mem.delegated && !(await read($, chat)).delegating) return next(e)
    return next({ ...e, instructions: [e.instructions, KEEP_ON_COMPACT].filter(Boolean).join('\n\n') })
  })

  // A fresh or just-compacted conversation is told which of its tasks are open, from wb itself.
  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    if (!mem.person) return r // a scripted run: no `wb status` before every prompt
    const st = await read($, chat)
    const isAway = await away($, st)
    const blocks = [...r.blocks]
    if (st.delegating) blocks.push({ name: 'workbench-mode', text: MODE_NOTE(mem.skill) })
    const want = await wanted($, st.delegating)
    // /workbench as the first message said them in its text already (#540)
    const had = mem.skillTurn ? mem.said : null
    mem.skillTurn = false
    await setSaid($, want)
    if (want.coding !== 'decide' && had?.coding !== want.coding) blocks.push({ name: 'claude-coding', text: CODING_RULES[want.coding] })
    if (want.notes && !had?.notes) blocks.push({ name: 'user-notes', text: NOTES_NOTE(want.notes) })
    if (isAway) blocks.push({ name: 'web-chat', text: AWAY_NOTE })
    if (want.wakeOff && !had?.wakeOff) blocks.push({ name: 'workbench-wake', text: WAKE_OFF_NOTE })
    const { ok, out: status } = await runWb($, ['status', ...(await scope($))])
    if (!ok) warnOnce($, 'status', `wb status failed: ${brief(status)}; wb doctor`)
    if (!ok || status.startsWith('no open tasks')) return { blocks }
    return {
      blocks: [...blocks, {
        name: 'workbench',
        text: `Tasks delegated to local agents with wb (the /workbench skill) are open:\n${status}\n` +
          'Pick them up from here: `wb report <name>` for one, `wb watch <name>` to follow it.',
      }],
    }
  })

  // Only the main loop's turns: a subagent's run doesn't hold the prompt.
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      mem.busy = true
      mem.submitted = false
      void poll($) // the chat page shows "working" now
    }
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      // An interrupt drops a waiting PermissionRequest hook outright, so its own expiry never
      // runs: the card would wait on the page for ever (seen live, 2026-11-18)
      for (const id of mem.asksOpen) void runWb($, ['chat', 'answer', id, 'expired', '--by', 'interrupted'], 15_000)
      mem.asksOpen.clear()
      mem.busy = false
      mem.skillTurn = false
      if (mem.chatQueued.size) void readQueued($)
      await owedAtTurnEnd($)
      mem.sawTurn = true
      mem.turnEndedAt = await $.clock.now()
      void poll($) // held wakes and chat messages go now, not at the next tick
    }
    return next(e)
  })

  // The person's scrolling decides whether the pane follows: up to read stops it, back down to
  // the end starts it again.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') mem.follow = e.offset + e.bodyRows >= e.contentRows - 1
    return next(e)
  })

  // The user's own close (its mark, Esc) puts the pane away: the strip above the prompt stands in
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin?.kind === 'person') {
      await update($, pane, p => ({ ...p, minimized: true }))
      stopTop($) // put away: the live view ends with it
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // Minimized: the strip, while there is something to bring back (workbench mode, or this session's
  // tasks): its name, what the tasks are doing, and its tabs, each a way back
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!(await read($, pane)).minimized || e.props?.hasSurvey) return next(e)
    const { delegating } = await read($, chat)
    const { parts } = taskParts(await read($, tasks), delegating)
    if (!delegating && !parts.length) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e) as Row
    return (
      <Box flexDirection="row" columnGap={2}>
        <Box flexShrink={0}>
          <Button key="restore" label="▸ Workbench" plain onPress={() => { void restorePane($, '') }} />
        </Box>
        {TABS.map(([tab, label]) => (
          <Box flexShrink={0}>
            <Button key={`restore-${tab}`} label={label} plain dimColor onPress={() => { void restorePane($, tab) }} />
          </Box>
        ))}
        <Text dimColor wrap="truncate-end">{parts.length ? `${parts.join(' · ')} · ${STRIP_HINT}` : STRIP_HINT}</Text>
      </Box>
    )
  })

  // Where the ring is in the pane, so an open settings row shows that option's sentence; let through
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const focus = e.element && SETTING_ROWS.test(e.element) ? e.element : ''
    if (focus !== (await read($, pane)).focus) await update($, pane, p => ({ ...p, focus }))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const kit = $.ui.resolve(e) as Row
    const { Box, Text, Raster, Button } = kit
    const list = await read($, tasks)
    const watched = await read($, live)
    const { url, web, delegating } = await read($, chat)
    const saved = await read($, savings)
    const view = await read($, pane)
    // the web chat's link while it is on, on the Settings tab only (the user, 2026-11-19: never under
    // the tasks), then the tabs: last, since the pane follows its end (a row at the top scrolled away
    // under a long transcript)
    const pinned = web && url ? (
      <Box marginTop={1}>
        <Text>
          <Text bold color="claude">web chat </Text>
          <Text dimColor>{url}</Text>
        </Text>
      </Box>
    ) : null
    const tabs = (
      <Box flexDirection="row" columnGap={2} marginTop={1}>
        {TABS.map(([tab, label, hotkey]) => (
          <Button key={`tab-${tab}`} label={label} hotkey={hotkey} plain dimColor={view.tab !== tab}
            onPress={() => { void update($, pane, p => ({ ...p, tab, open: '', focus: '' })).then(() => { void refreshStats($, true); void syncTop($) }) }} />
        ))}
      </Box>
    )
    // the Settings tab: Claude coding (#93), then the Stats tab's (#406), one row each at rest; the
    // electricity price is typed (an Input: wb checks it). Last, apart under Experimental, the web chat
    // and the probe experiment: settings that may change or go away (the user, 2026-11-21)
    if (view.tab === 'settings') {
      const st = await statsSettings($)
      const probe = await probeStatus($)
      const prog = await progressSettings($)
      const picked = (args: string[]) => runWb($, args).then(() => { void refreshStats($, true); void syncTop($) })
      return (
        <Box flexDirection="column">
          <Text dimColor>{SETTINGS_HINT}</Text>
          <Box flexDirection="column" marginTop={1}>
            {settingRow(kit, $, 'coding', 'Claude coding', CODING_STOPS, await codingMode($), view,
              v => runWb($, ['coding', v]))}
            {settingRow(kit, $, 'record', 'Stats recording', RECORD_STOPS, st.recording ? 'on' : 'off', view,
              v => picked(['stats', 'set', 'recording', v]))}
            {settingRow(kit, $, 'live', 'Live view', LIVE_STOPS, st.live ? 'on' : 'off', view,
              v => picked(['stats', 'set', 'live', v]))}
            {settingRow(kit, $, 'every', 'Live refresh', EVERY_STOPS, String(st.every), view,
              v => picked(['stats', 'set', 'every', v]))}
            {settingRow(kit, $, 'progress', 'Progress checks', progressStops(prog.after), prog.on ? 'on' : 'off', view,
              v => runWb($, ['progress', v]))}
            <kit.Input key="price" label="▸ Electricity price per kWh: " value={mem.price ? String(mem.price) : ''}
              placeholder="not set (energy shows in Wh)" submitLabel="set" onSubmit={(v: string) => { void setPrice($, v) }} />
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text><Text bold>Experimental</Text><Text dimColor> · may change or go away</Text></Text>
            {settingRow(kit, $, 'chat', 'Web chat', CHAT_STOPS, web ? 'on' : 'off', view, v => setWeb($, v))}
            {settingRow(kit, $, 'probe', 'Agent code navigation', probeStops(probe), probe.state === 'off' ? 'off' : 'on', view,
              v => setProbe($, v))}
          </Box>
          {pinned}
          {tabs}
        </Box>
      )
    }
    // the Stats tab: the live view (#408, `wb top --json` while shown, with Live view on), then
    // the history (#406, `wb stats --json`)
    if (view.tab === 'stats') {
      // drawn with no child: the engine shows the pane again (nothing else says so), so the live
      // view starts now, not at the next poll, 30 s off with no task (#552)
      if (!mem.top && !mem.topKids.size) void syncTop($)
      const { feed } = await read($, statsFeed)
      const cols = Math.max(30, Number(((e.props ?? {}) as Row).bodyColumns ?? e.viewport?.columns ?? 60))
      const now = (await statsSettings($)).live ? liveLines(await read($, topNow), mem.topFails >= 2 ? mem.topWhy : '') : []
      return (
        <Box flexDirection="column">
          {now.length ? (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold color="claude">Now</Text>
              {now.flatMap(parts => wrapParts(parts, cols)).map(parts => (
                <Text wrap="truncate-end">{parts.map(p => <Text color={p.color} dimColor={p.dim} bold={p.bold}>{p.text}</Text>)}</Text>
              ))}
            </Box>
          ) : null}
          {statsLines(feed, mem.statsWhy).map(({ label, text }) => (
            <Box flexDirection="column" marginBottom={label ? 0 : 1}>
              {label
                ? wrapWords(`${label}: ${text}`, cols).map((l, i) => i === 0 && l.startsWith(label)
                  ? <Text><Text bold>{label}</Text><Text dimColor>{l.slice(label.length)}</Text></Text>
                  : <Text dimColor>{l}</Text>)
                : <Text dimColor>{text}</Text>}
            </Box>
          ))}
          {tabs}
        </Box>
      )
    }
    const props = (e.props ?? {}) as Row
    const cols = Math.max(30, Number(props.bodyColumns ?? e.viewport?.columns ?? 60))
    const now = await $.clock.now()
    const spin = SPIN[Math.floor(now / 500) % SPIN.length]

    // the followed task's own recent lines are in its transcript below, in full
    const recentOf = (t: WbTask) => (t.name === watched.task ? [] : t.recent)
    const when = (t: WbTask) =>
      ACTIVE.has(t.phase) || NEEDS.has(t.phase) ? `for ${ago(now - t.createdAt)}` : `${ago(now - t.updatedAt)} ago`
    // The history is drawn, newest within HISTORY_CHARS: the engine scrolls the pane (arrows,
    // while focused) and follows the end as lines arrive. What the agent is doing now is the
    // apprentice's to say.
    const all = watched.lines.filter(l => !['activity', 'clock', 'meta'].includes(l.s))
    let from = all.length // (each line was cut to LINE_CHARS when read)
    for (let used = 0; from > 0 && used + (all[from - 1].t?.length ?? 0) + 1 <= HISTORY_CHARS; from--)
      used += (all[from - 1].t?.length ?? 0) + 1
    const history = all.slice(from)
    const doing = watched.lines.find(l => l.s === 'activity')
    const clock = watched.lines.find(l => l.s === 'clock')
    const meta = watched.lines.find(l => l.s === 'meta')

    // The apprentice, in pixels where the pane has the rows for it (it takes six), else its face
    // on the line. Drawing it in pixels arms the timer that animates it. The stage keeps its
    // height beside a long history, and the bubble wraps its words onto more rows rather than
    // cutting them off: the pane can't be made wider.
    const focus = focusOf(list, watched.task)
    const sp = speechOf(focus, doing?.t ?? '', list, delegating)
    const busy = sp.pose === 'work' || sp.pose === 'think'
    const pixels = (e as Row).surface === 'terminal' && Number(props.scroll?.bodyRows ?? 24) >= 20 && cols >= 40
    // The bubble's inner width beside the apprentice (its columns, the mouth's, the border and
    // padding), or beside the face on one line; each line drawn whole, never squeezed.
    const room = Math.max(10, pixels ? cols - COLUMNS - 1 - 4 : cols - 4)
    const lines = (text: string, props: Record<string, unknown>) =>
      wrapWords(text, room).map(l => <Text {...props} wrap="truncate-end">{l}</Text>)
    const said = [
      ...lines(`${busy && doing ? `${spin} ` : ''}${sp.say}`,
        busy ? LINE_STYLE.activity : { color: sp.color, bold: true }),
      ...(sp.more ? lines(sp.more, { dimColor: true }) : []),
      ...(clock && focus?.name === watched.task ? lines(clock.t, { dimColor: true }) : []),
    ]
    let stage
    if (pixels) {
      const frame = frameOf(sp.pose, mem.tick)
      mem.posed = sp.pose
      mem.shown = frame
      stage = (
        <Box flexDirection="row" marginTop={1} flexShrink={0}>
          <Box flexShrink={0}>
            <Raster key={APPRENTICE} columns={COLUMNS} rows={ROWS} cells={cells(frame)} />
          </Box>
          <Box flexDirection="column" flexShrink={0}>
            {Array.from({ length: MOUTH + 1 }, (_, i) => (
              <Text color={sp.color}>{i === MOUTH ? '─' : ' '}</Text>
            ))}
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={0} marginTop={MOUTH - 1} borderStyle="round"
            borderColor={sp.color} paddingX={1}>
            {said}
          </Box>
        </Box>
      )
    } else {
      stage = (
        <Box flexDirection="row" marginTop={list.length ? 1 : 0} flexShrink={0}>
          <Box flexShrink={0}>
            <Text color={sp.color}>{FACE[sp.pose]} </Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>{said}</Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {list.map(t => (
          <Box flexDirection="column" marginBottom={1}>
            <Text>
              <Text color={COLOR[t.phase] ?? 'text'}>
                {t.phase === 'running' ? spin : MARK[t.phase] ?? '•'}{' '}
              </Text>
              <Text bold>{t.name}</Text>
              <Text color={COLOR[t.phase] ?? 'text'}> {t.phase}</Text>
              <Text dimColor>
                {' '}· round {t.round} · {t.label || t.model}
                {t.tests ? ` · tests ${t.tests}` : ''} · {when(t)}
              </Text>
            </Text>
            {recentOf(t).map(line => (
              <Text dimColor>  {clip(line, cols - 2)}</Text>
            ))}
            {t.allowed && wrapWords(t.allowed, cols - 2).map(l => <Text color="claude">  {l}</Text>)}
            {t.name !== watched.task && t.recent.length === 0 && (
              <Text dimColor>  {clip(t.last, cols - 2)}</Text>
            )}
          </Box>
        ))}
        {watched.task && (
          <Box flexDirection="column">
            <Text dimColor>{clip(`── ${watched.task} · ↑↓ scrolls ` + '─'.repeat(cols), cols)}</Text>
            {meta && <Text dimColor>{meta.t}</Text>}
            {from > 0 && <Text dimColor>… {from} earlier lines: `wb watch {watched.task}` has them all</Text>}
            {history.map(l => (
              <Text {...(LINE_STYLE[l.s] ?? {})}>{l.t || ' '}</Text>
            ))}
          </Box>
        )}
        {stage}
        {saved && <Text dimColor>{saved}</Text>}
        {tabs}
      </Box>
    )
  })
}
