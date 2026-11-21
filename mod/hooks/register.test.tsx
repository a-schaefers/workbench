import { expect, mock, test } from 'claude-code/testing'
import { absolutePath, attachedLines, awayNow, cardName, delegates, liveLines, parsePrice, priceOf, quietForJobs, savedLine, spark, statsLines, wrapParts, wrapWords } from './register.js'

const PANE = {
  plugin: 'workbench',
  component: 'Pane',
  requestId: 'workbench',
  props: {
    title: 'Workbench',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('with no tasks the pane says how to start one, on every surface', async ($, on) => {
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /No delegated tasks/ }))?.text)
      .toBe('No delegated tasks.')
    await ui.unmount()
  }
})

test('/workbench run again brings the pane back; alone, it is all it does', async ($, on) => {
  let opened = ''
  let closed = ''
  let held: any[] = []
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('ui.panes', () => ({ value: held }))
  on('ui.close', (_, e) => {
    closed = e.id
    held = []
    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    opened = e.id
    return { value: { isPlaced: true } }
  })
  on('env.get', () => ({ value: '/nonexistent' }))
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  on('fs.exists', () => ({ value: false }))                      // the mode's poll: no state yet
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  const skill = (task: string) => $.skill.prompt({ skill: 'workbench', frontmatter: {}, source: 'userSettings',
    text: `- **First task:** \`${task}\`. Empty? Reply in one line that workbench mode is on.` })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await skill('')).text).toContain('First task')         // the skill, the first time
  expect([closed, opened]).toEqual(['', 'workbench'])
  // closed by accident, the engine still holding it out of sight: /workbench brings it back,
  // and Claude isn't handed the whole skill again to say so (2026-11-17: was /delegate-pane)
  held = [{ id: 'workbench', title: 'Workbench', isShown: false, isFocused: false, isPlaced: true }]
  opened = ''
  expect((await skill('')).text).toContain('The user ran /workbench again')
  expect([closed, opened]).toEqual(['workbench', 'workbench'])
  // with a task, the skill comes as usual
  expect((await skill('add a high-score screen')).text).toContain('add a high-score screen')
})

test('a Claude Code older than the one the mod is tested on is told so once, and the mod still runs', async ($, on) => {
  // the 2026-11-19 audit: installs track main, so an older Claude Code met calls it lacks as bare errors
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'review', { repo: '/home/u/a', cwd: '/home/u/a' })
  notice(files, { ts: ts0, task: 'fix-it', kind: 'review', text: 'REPORT-fix-it' })
  fakeTasks(on, files)
  on('session.id', () => ({ value: 'sess-new' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  try {
    engine.version = { version: '2.1.290', base: '2.1.290' }
    await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
    await clock.advance(3000)
    expect(toasts.filter(t => t.includes('is older than'))).toEqual([
      'workbench: this Claude Code (2.1.290) is older than 2.1.311, which the pane and wake-ups are tested on: `claude update` if they misbehave'])
    expect(woken.filter(t => t.includes('REPORT-fix-it'))).toHaveLength(1)   // it carries on
    engine.version = undefined
    await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
    expect(toasts.filter(t => t.includes('is older than'))).toHaveLength(1)  // once per load
  } finally {
    engine.version = TESTED
  }
})

test('a Claude Code older than $.session.version itself is told so too', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  fakeTasks(on, {}, [])
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  try {
    engine.version = undefined
    await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
    await clock.advance(3000)
  } finally {
    engine.version = TESTED
  }
  expect(toasts).toContain('workbench: this Claude Code is older than 2.1.311, which the pane and wake-ups are tested on: `claude update` if they misbehave')
})

test('the Claude Code the mod is tested on, or a newer one, hears nothing about versions', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  fakeTasks(on, {}, [])
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  try {
    for (const base of ['2.1.311', '2.1.400-dev', '2.2.0', '3.0.1']) {
      engine.version = { version: base, base }
      await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
    }
    await clock.advance(3000)
  } finally {
    engine.version = TESTED
  }
  expect(toasts.join('\n')).not.toContain('older than')
})

test('WB_BIN is read as wb reads its path variables: a ~ expanded, a relative one against the session\'s directory (#699)', async ($, on) => {
  // #699: settings.json's env passes `~/repos/workbench/bin/wb` literally, and the mod ran a `~`
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  const runs: string[][] = []
  on('process.run', (_: any, e: any) => { runs.push(e.argv); return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  on('ui.toast', () => ({ value: undefined }))
  for (const [bin, want] of [['~/repos/workbench/bin/wb', '/home/u/repos/workbench/bin/wb'],
    ['bin/wb', '/home/u/a/bin/wb'], ['wb-dev', 'wb-dev']]) {
    engine.env = { WB_BIN: bin }
    try {
      runs.length = 0
      await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
      await clock.advance(1000)
      await $.command.run({ command: 'workbench-quit', args: '' })
      await clock.advance(1000)
    } finally {
      engine.env = undefined
    }
    expect(runs.find(r => r[1] === 'stop')?.[0]).toBe(want)
  }
})

test('a copy updated from /delegate gets its /workbench link from wb setup', async ($, on) => {
  const ran: string[][] = []
  const toasts: string[] = []
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('env.get', (_: any, e: any) => ({ value: ({ HOME: '/home/u', WB_HOME: '/wb' } as any)[e.name] }))
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.stat', (_: any, e: any) => {
    if (e.path !== '/home/u/.claude/skills/delegate') throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: true } }   // the old link, leading nowhere
  })
  on('process.run', (_: any, e: any) => {
    ran.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.toast', (_: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  expect(ran).toContainEqual(['wb', 'setup'])
  expect(toasts.join('\n')).toContain('/delegate is now /workbench')
})

// A file system in memory: what `wb` and its runner would have written. `ui` records the pane
// opening and closing and each status line.
// The web chat as the user turned it on (`wb chat on`): off by default (the user, 2026-11-19)
function chatOn(files: Record<string, string>) {
  files['/wb/chat/switch.json'] = JSON.stringify({ on: true })
  return files
}

// The Claude Code fakeTasks plays: the one the mod is tested on, unless a test says otherwise
// (undefined: one older than $.session.version itself)
// and its environment past WB_HOME=/wb and HOME=/home/u, unless a test says otherwise
const engine: { version?: { version: string; base: string }; env?: Record<string, string> } = {}
const TESTED = { version: '2.1.311', base: '2.1.311' }
engine.version = TESTED

// A file's mtime where a test sets one (fakeTasks' fs.stat), else 0
const mtimes: Record<string, number> = {}

function fakeTasks(on: any, files: Record<string, string>, dirs = ['fix-it'], scouted = true, ui: string[] = [], ears = true) {
  on('session.version', () => {
    if (!engine.version) throw new Error('no implementation for session.version')
    return { value: engine.version }
  })
  // the weekly model check was done just now, unless the test is about it
  if (scouted) files['/wb/scout.json'] = JSON.stringify({ done_at: 1_800_000_000 })
  on('env.get', (_: any, e: any) => ({ value: ({ WB_HOME: '/wb', HOME: '/home/u', ...engine.env } as any)[e.name] }))
  const reads: string[] = []
  on('fs.read', (_: any, e: any) => {
    reads.push(e.path)
    if (!(e.path in files)) throw new Error(`ENOENT: ${e.path}`)
    return { value: files[e.path] }
  })
  on('fs.write', (_: any, e: any) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.exists', (_: any, e: any) => ({ value: Object.keys(files).some(p => p.startsWith(e.path)) }))
  on('fs.stat', (_: any, e: any) => {
    if (!(e.path in files)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: files[e.path].length, mtimeMs: mtimes[e.path] ?? 0, isLink: false } }
  })
  on('fs.list', () => ({ value: dirs.map(name => ({ name, kind: 'dir' })) }))
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  // the pane is shown from its open until its close
  let shown = false
  on('ui.panes', () => ({ value: shown ? [{ id: 'workbench', title: 'Workbench', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('ui.open', (_: any, e: any) => { ui.push(`open ${e.id}`); shown = true; return { value: { isPlaced: true } } })
  on('ui.close', (_: any, e: any) => { ui.push(`close ${e.id}`); shown = false; return { value: undefined } })
  on('ui.status', (_: any, e: any) => { ui.push(`status ${e.text ?? ''}`); return { value: undefined } })
  // `wb events`: says hello and then stays open, as the real watcher does
  if (ears) on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"hello": 4242}\n' }
    await new Promise(() => {})
    return { code: 0, signal: null }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { show: (is: boolean) => { shown = is }, reads } // the person closing or opening the pane; what was read
}

test('a review notice waits for the turn to end, and is dropped if it went stale', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const ts = 1_800_000_000 // seconds, as the runner writes them
  const files: Record<string, string> = {
    '/wb/notify.jsonl': JSON.stringify({ ts, task: 'fix-it', kind: 'review', text: 'REPORT' }) + '\n',
    '/wb/tasks/fix-it/task.json': JSON.stringify({ name: 'fix-it', model: 'qwen27b', created_at: ts }),
    '/wb/tasks/fix-it/status.json': JSON.stringify({ phase: 'review', round: 1, updated_at: ts }),
  }
  fakeTasks(on, files)
  const woken: string[] = []
  const toasts: string[] = []
  on('prompt.submit', (_: any, e: any) => {
    woken.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', (_: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'busy with something else', turnId: 't1' })
  await clock.advance(3000)
  expect(toasts.length).toBe(1)        // seen at once
  expect(woken.length).toBe(0)         // but no wake while Claude is mid-turn
  expect(files['/wb/tasks/fix-it/acked']).toBe(undefined)

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(3000)
  expect(woken.length).toBe(1)         // delivered once the turn ended
  expect(woken[0]).toContain('REPORT')
  await clock.advance(3000)
  expect(woken.length).toBe(1)         // and only once

  // A second notice the turn acted on (accepted) before it ended: no wake, just acknowledged.
  files['/wb/notify.jsonl'] += JSON.stringify({ ts: ts + 60, task: 'fix-it', kind: 'review', text: 'R2' }) + '\n'
  await $.turn.start({ text: '', turnId: 't2' })
  files['/wb/tasks/fix-it/status.json'] = JSON.stringify({ phase: 'accepted', round: 2, updated_at: ts + 90 })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.advance(3000)
  expect(woken.length).toBe(1)
  expect(files['/wb/tasks/fix-it/acked']).toBe(String(ts + 60))
})

// A task's files as wb writes them: task.json, status.json, and its notices in notify.jsonl.
const ts0 = 1_800_000_000
function task(files: Record<string, string>, name: string, phase: string, extra: Record<string, any> = {}, updated = ts0) {
  files[`/wb/tasks/${name}/task.json`] = JSON.stringify({ name, model: 'm', created_at: ts0 - 60, ...extra })
  files[`/wb/tasks/${name}/status.json`] = JSON.stringify({ phase, round: 1, updated_at: updated })
}
const notice = (files: Record<string, string>, row: Record<string, any>) => {
  files['/wb/notify.jsonl'] = (files['/wb/notify.jsonl'] ?? '') + JSON.stringify(row) + '\n'
}
// `wb ack` as wb runs it, on the test's files: a claim (exit 3 when the mark is there already) or,
// with --if, a rollback only while the mark is still that value (#786); `then` runs after a claim,
// standing in for another session claiming next. Every other command: exit 0.
function wbAck(files: Record<string, string>, then?: (name: string, ts: number) => void) {
  return (_: any, e: any) => {
    if (e.argv[1] !== 'ack') return { value: { exitCode: 0, stdout: '', stderr: '' } }
    const [name, ts] = [e.argv[2], Number(e.argv[3])], path = `/wb/tasks/${e.argv[2]}/acked`
    const now = Number(files[path] ?? 0)
    const i = e.argv.indexOf('--if')
    const ok = i > 0 ? now === Number(e.argv[i + 1]) : now < ts
    if (ok) files[path] = String(ts)
    if (ok && i < 0) then?.(name, ts)
    return { value: { exitCode: ok ? 0 : 3, stdout: '', stderr: '' } }
  }
}
const endTurn = (turnId: string) => ({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' } as const)

test('a session wakes for its own project\'s tasks only: another project\'s are left for their session', async ($, on) => {
  // the 2026-11-16 audit: two projects at once, each session was woken for the other's tasks
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'ours', 'review', { repo: '/home/u/a', cwd: '/home/u/a' })
  task(files, 'sub', 'review', { repo: '/home/u/a/lib', cwd: '/home/u/a/lib' })   // inside this session's dir
  task(files, 'theirs', 'review', { repo: '/home/u/b', cwd: '/home/u/b' })
  // the 0.90 review: started from ~ (or a parent) for another repo, it was every session's below
  task(files, 'fromhome', 'review', { repo: '/home/u/b', cwd: '/home/u' })
  task(files, 'sibling', 'review', { repo: '/home/u/ab', cwd: '/home/u/ab' })     // not inside /home/u/a
  const names = ['ours', 'sub', 'theirs', 'fromhome', 'sibling']
  for (const name of names) notice(files, { ts: ts0, task: name, kind: 'review', text: `REPORT-${name}` })
  fakeTasks(on, files, names)
  const runs: string[][] = []
  on('process.run', (_: any, e: any) => { runs.push(e.argv); return { value: { exitCode: 0, stdout: 'ours  review', stderr: '' } } })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.context', (_: any, e: any) => ({ blocks: e.blocks }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(woken.filter(t => t.includes('REPORT-ours'))).toHaveLength(1)
  expect(woken.filter(t => t.includes('REPORT-sub'))).toHaveLength(1)
  expect(woken.join('\n')).not.toContain('theirs')
  expect(woken.join('\n')).not.toContain('fromhome')
  expect(woken.join('\n')).not.toContain('sibling')
  expect(files['/wb/tasks/theirs/acked']).toBe(undefined)        // its own session (or wb wait) still gets it
  expect(files['/wb/tasks/fromhome/acked']).toBe(undefined)
  await clock.advance(120_000)
  expect(woken.join('\n')).not.toContain('theirs')               // no rewake for it either
  // the open-tasks block asks wb for this session's tasks
  await $.prompt.context({ blocks: [] })
  expect(runs).toContainEqual(['wb', 'status', '--repo', '/home/u/a'])
})

test('a task wb start ran in this session is its own wherever it ran, also after a /clear', async ($, on) => {
  // the 0.90 review: `cd /tmp/scratch && wb start` made a task no session woke for, and a session
  // in ~ woke for every task
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'scratch', 'review', { repo: '/tmp/scratch', cwd: '/tmp/scratch', session: 'sess-1' })
  task(files, 'other', 'review', { repo: '/home/u/a', cwd: '/home/u', session: 'sess-x' })
  task(files, 'byhand', 'review', { repo: '/home/u/a', cwd: '/home/u/a' })   // no session: by directory
  const names = ['scratch', 'other', 'byhand']
  for (const name of names) notice(files, { ts: ts0, task: name, kind: 'review', text: `REPORT-${name}` })
  fakeTasks(on, files, names)
  let id = 'sess-1'
  on('session.id', () => ({ value: id }))
  const runs: string[][] = []
  on('process.run', (_: any, e: any) => { runs.push(e.argv); return { value: { exitCode: 0, stdout: 'stopped: scratch', stderr: '' } } })
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/home/u', surface: 'terminal', isInteractive: true })   // a session in ~
  await clock.advance(3000)
  expect(woken.filter(t => t.includes('REPORT-scratch'))).toHaveLength(1)
  expect(woken.join('\n')).not.toContain('REPORT-other')       // another session's, under ~ too
  expect(woken.join('\n')).not.toContain('REPORT-byhand')      // ~ claims nothing by directory
  expect(files['/wb/tasks/other/acked']).toBe(undefined)
  expect(files['/wb/tasks/byhand/acked']).toBe(undefined)
  // /clear: the process goes on under another id, and the first one's tasks are still its own
  id = 'sess-2'
  task(files, 'scratch', 'review', { repo: '/tmp/scratch', cwd: '/tmp/scratch', session: 'sess-1' }, ts0 + 60)
  notice(files, { ts: ts0 + 60, task: 'scratch', kind: 'review', text: 'REPORT-again' })
  await clock.advance(31_000)                                  // the safety poll reads it
  expect(woken.filter(t => t.includes('REPORT-again'))).toHaveLength(1)
  await $.command.run({ command: 'workbench-quit', args: '' })
  expect(runs.at(-1)).toEqual(['wb', 'stop', '--all', '--park-waiting', '--repo', '/home/u', '--session', 'sess-1', '--session', 'sess-2'])
})

test('a new Claude Code process in the project adopts the tasks of one that is gone', async ($, on) => {
  // the 0.90 review: Claude Code exited (a crash, an update) and plain `claude` in the same repo
  // got a new session id: none of the earlier process's tasks woke it, and its quit skipped them
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'orphan', 'review', { repo: '/home/u/a', cwd: '/home/u/a', session: 'sess-old', claude_pid: 4242 })
  task(files, 'live', 'review', { repo: '/home/u/a', cwd: '/home/u/a', session: 'sess-other', claude_pid: 4343 })
  task(files, 'far', 'review', { repo: '/home/u/b', cwd: '/home/u/b', session: 'sess-old', claude_pid: 4242 })
  const names = ['orphan', 'live', 'far']
  for (const name of names) notice(files, { ts: ts0, task: name, kind: 'review', text: `REPORT-${name}` })
  fakeTasks(on, files, names)
  on('session.id', () => ({ value: 'sess-new' }))
  const kills: string[] = []
  on('process.run', (_: any, e: any) => {
    if (e.argv[0] === 'kill') {
      kills.push(e.argv[2])
      return { value: { exitCode: e.argv[2] === '4242' ? 1 : 0, stdout: '', stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(woken.filter(t => t.includes('REPORT-orphan'))).toHaveLength(1)  // its process is gone
  expect(woken.join('\n')).not.toContain('REPORT-live')       // a live session's stays its own
  expect(woken.join('\n')).not.toContain('REPORT-far')        // another project's: not by directory
  expect(files['/wb/tasks/live/acked']).toBe(undefined)
  const asked = kills.length
  await clock.advance(6000)
  expect(kills.filter(p => p === '4242')).toHaveLength(1)      // gone is final: asked once
  expect(kills.length - asked).toBeLessThanOrEqual(1)          // a live one, not at every poll
})

test('a task whose Claude Code process is gone is claimed by the first session to see it, and the others drop it (#687)', async ($, on) => {
  // #687: nothing recorded an adoption, so once the process that started a task ended, every
  // live session near it owned it for good, and the one back from `claude --resume` too: both
  // woke for its review. Now the first claims it (`wb adopt`, under wb's lock) and task.json names
  // that process; a session that loses the claim leaves the task alone.
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'won', 'review', { repo: '/home/u/a', cwd: '/home/u/a', session: 'sess-old', claude_pid: 4242 })
  task(files, 'lost', 'review', { repo: '/home/u/a', cwd: '/home/u/a', session: 'sess-old', claude_pid: 4242 })
  task(files, 'resumed', 'review', { repo: '/home/u/b', cwd: '/home/u/b', session: 'sess-new', claude_pid: 4141 })
  const names = ['won', 'lost', 'resumed']
  for (const name of names) notice(files, { ts: ts0, task: name, kind: 'review', text: `REPORT-${name}` })
  fakeTasks(on, files, names, true, [], false)
  on('process.spawn', async function* () {     // `wb events`: its parent is this Claude Code, pid 9000
    yield { stream: 'stdout', text: '{"hello": 4242, "parent": 9000, "parent_start": "77"}\n' }
    await new Promise(() => {})
    return { code: 0, signal: null }
  })
  on('session.id', () => ({ value: 'sess-new' }))
  const adopts: string[][] = []
  on('process.run', (_: any, e: any) => {
    const [cmd, ...args] = e.argv
    if (cmd === 'kill') return { value: { exitCode: ['4242', '4141'].includes(args[1]) ? 1 : 0, stdout: '', stderr: '' } }
    if (cmd === 'wb' && args[0] === 'adopt') {
      adopts.push(args)
      const path = `/wb/tasks/${args[1]}/task.json`
      const spec = JSON.parse(files[path])
      if (args[1] === 'lost') {                // another session claimed it a moment before
        files[path] = JSON.stringify({ ...spec, session: 'sess-third', claude_pid: 5151, claude_start: '9' })
        return { value: { exitCode: 1, stdout: '', stderr: 'wb: lost belongs to a live Claude Code session (pid 5151)' } }
      }
      files[path] = JSON.stringify({ ...spec, session: args.includes('sess-old') ? 'sess-old' : 'sess-new', claude_pid: 9000, claude_start: '77' })
      return { value: { exitCode: 0, stdout: `adopted ${args[1]}`, stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(adopts.find(a => a[1] === 'won')).toEqual(['adopt', 'won', '--pid', '9000', '--session', 'sess-new'])
  expect(JSON.parse(files['/wb/tasks/won/task.json']).claude_pid).toBe(9000)
  expect(woken.filter(t => t.includes('REPORT-won'))).toHaveLength(1)
  expect(woken.join('\n')).not.toContain('REPORT-lost')        // the other session's now
  expect(files['/wb/tasks/lost/acked']).toBe(undefined)        // left for it
  // this session's own task, stamped by its earlier process (a resume): stamped with this one
  expect(adopts.find(a => a[1] === 'resumed')).toEqual(['adopt', 'resumed', '--pid', '9000', '--session', 'sess-new'])
  expect(JSON.parse(files['/wb/tasks/resumed/task.json']).claude_pid).toBe(9000)
  const claims = adopts.length
  await clock.advance(31_000)
  expect(adopts.length).toBe(claims)                            // claimed once, not at every poll
})

test('#922: a Claude Code process or chat listener recorded on another machine is never read as gone here', async ($, on) => {
  // on a state directory two machines share, each machine's mod read the other's live session as
  // dead (its pid not in this /proc), adopted its tasks, and the two passed them back and forth
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'theirs', 'review', { repo: '/home/u/a', cwd: '/home/u/a', session: 'sess-a', claude_pid: 4242, claude_machine: 'machine-a' })
  task(files, 'ours', 'review', { repo: '/home/u/a', cwd: '/home/u/a', session: 'sess-old', claude_pid: 4141, claude_machine: 'machine-b' })
  for (const name of ['theirs', 'ours']) notice(files, { ts: ts0, task: name, kind: 'review', text: `REPORT-${name}` })
  fakeTasks(on, files, ['theirs', 'ours'], true, [], false)
  chatOn(files)
  const claim = JSON.stringify({ session: 'other-key', pid: 777, start: '1', machine: 'machine-a' })
  files['/wb/chat/listener.json'] = claim                         // A's listener, its file stale
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"hello": 4343, "parent": 9000, "parent_start": "77", "machine": "machine-b"}\n' }
    await new Promise(() => {})
    return { code: 0, signal: null }
  })
  on('session.id', () => ({ value: 'sess-new' }))
  const adopts: string[] = []
  on('process.run', (_: any, e: any) => {
    const [cmd, ...args] = e.argv
    if (cmd === 'kill') return { value: { exitCode: 1, stdout: '', stderr: '' } }   // no such pid here
    if (cmd === 'wb' && args[0] === 'adopt') {
      adopts.push(args[1])
      const path = `/wb/tasks/${args[1]}/task.json`
      files[path] = JSON.stringify({ ...JSON.parse(files[path]), session: 'sess-new', claude_pid: 9000, claude_machine: 'machine-b' })
      return { value: { exitCode: 0, stdout: `adopted ${args[1]}`, stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })
  await clock.advance(40_000)
  expect(adopts).toEqual(['ours'])                                // this machine's gone process only
  expect(woken.join('\n')).not.toContain('REPORT-theirs')
  expect(files['/wb/chat/listener.json']).toBe(claim)              // A's listener stands
})

test('a session resumed in a new process comes back in workbench mode, and a quit ends it for good (#689)', async ($, on) => {
  // #689: the mode lived in the old process's state: `claude --continue` came back with it off,
  // so the chat didn't listen, the status line didn't show it and a compaction dropped it
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  const ui: string[] = []
  fakeTasks(on, files, [], true, ui)
  const kept: Record<string, unknown> = { modes: { 'sess-1': 1_800_000_000_000 - 3600_000, 'sess-stale': 1_000 } }
  on('store.get', (_: any, e: any) => ({ value: kept[e.key] }))
  on('store.set', (_: any, e: any) => { kept[e.key] = e.value; return { value: undefined } })
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(ui).toContain('status ⚒ wb · workbench mode')
  expect(ui).toContain('open workbench')
  expect(kept.modes).toEqual({ 'sess-1': 1_800_000_000_000 })  // the stale one pruned
  await $.command.run({ command: 'workbench-quit', args: '' })
  expect(kept.modes).toEqual({})
  await clock.advance(3000)                                     // the quit's poll ends inside the test
})

test('after a reload in workbench mode, a /clear\'s new session id is kept in the mode too (#840)', async ($, on) => {
  // #840: a reload started mem.delegated false while the chat atom kept the mode, so a /clear's
  // id was never saved, and `claude --continue` into it came back with the mode off
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  const kept: Record<string, unknown> = { modes: { 'sess-1': 1_800_000_000_000 - 3600_000 } }
  on('store.get', (_: any, e: any) => ({ value: kept[e.key] }))
  on('store.set', (_: any, e: any) => { kept[e.key] = e.value; return { value: undefined } })
  // the chat atom as the earlier load left it, in the mode: it outlives the reload, mem doesn't
  let held: any = { shape: 'chat-4', value: { key: 'k1', delegating: true, url: '', web: false } }
  let version = 1
  const isChat = (e: any) => e.key === 'chat' && e.plugin === 'workbench'
  on('state.get', (_: any, e: any, next: any) => isChat(e) ? { value: { value: held, version } } : next(e))
  on('state.set', (_: any, e: any, next: any) => isChat(e) ? (held = e.value, { value: { isSet: true, version: ++version } }) : next(e))
  let id = 'sess-1'
  on('session.id', () => ({ value: id }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  id = 'sess-2'                                                   // /clear, before any delegating command
  await clock.advance(31_000)
  expect(Object.keys(kept.modes as object).sort()).toEqual(['sess-1', 'sess-2'])
})

test('a session that adopts a task whose process is gone turns workbench mode on with it (#689)', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  const ui: string[] = []
  task(files, 'orphan', 'review', { repo: '/home/u/a', cwd: '/home/u/a', session: 'sess-old', claude_pid: 4242 })
  fakeTasks(on, files, ['orphan'], true, ui, false)
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"hello": 4343, "parent": 9000, "parent_start": "77"}\n' }
    await new Promise(() => {})
    return { code: 0, signal: null }
  })
  on('session.id', () => ({ value: 'sess-new' }))
  on('process.run', (_: any, e: any) => {
    const [cmd, ...args] = e.argv
    if (cmd === 'kill') return { value: { exitCode: args[1] === '4242' ? 1 : 0, stdout: '', stderr: '' } }
    if (args[0] === 'adopt') {
      const path = '/wb/tasks/orphan/task.json'
      files[path] = JSON.stringify({ ...JSON.parse(files[path]), session: 'sess-new', claude_pid: 9000, claude_start: '77' })
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(JSON.parse(files['/wb/tasks/orphan/task.json']).session).toBe('sess-new')
  await clock.advance(3000)
  expect(ui.filter(l => l.startsWith('status')).at(-1)).toBe('status ⚒ wb · 1 awaiting review')
  await $.command.run({ command: 'workbench-quit', args: '' })   // the mode was on: the quit says so
  expect(ui).toContain('close workbench')
  await clock.advance(3000)
})

// #834: /workbench-quit parked the review (or the hand-back took it over), the session ended, and
// the next one in the project adopted it and turned the mode back on against the quit
async function adoptsLeftOver($: any, on: any, extra: Record<string, unknown>, modeOn = false) {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  const ui: string[] = []
  task(files, 'orphan', 'review', { repo: '/home/u/a', cwd: '/home/u/a', session: 'sess-old', claude_pid: 4242 })
  files['/wb/tasks/orphan/status.json'] = JSON.stringify({ phase: 'review', round: 1, updated_at: ts0, ...extra })
  fakeTasks(on, files, ['orphan'], true, ui, false)
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"hello": 4343, "parent": 9000, "parent_start": "77"}\n' }
    await new Promise(() => {})
    return { code: 0, signal: null }
  })
  on('session.id', () => ({ value: 'sess-new' }))
  on('process.run', (_: any, e: any) => {
    const [cmd, ...args] = e.argv
    if (cmd === 'kill') return { value: { exitCode: args[1] === '4242' ? 1 : 0, stdout: '', stderr: '' } }
    if (args[0] === 'adopt') {
      const path = '/wb/tasks/orphan/task.json'
      files[path] = JSON.stringify({ ...JSON.parse(files[path]), session: 'sess-new', claude_pid: 9000, claude_start: '77' })
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(JSON.parse(files['/wb/tasks/orphan/task.json']).session).toBe('sess-new') // still adopted
  await clock.advance(3000)
  if (modeOn) {
    expect(ui.filter(l => l.startsWith('status')).at(-1)).toBe('status ⚒ wb · 1 awaiting review')
    await $.command.run({ command: 'workbench-quit', args: '' })   // the mode was on: the quit says so
    expect(ui).toContain('close workbench')
  } else {
    expect(ui).not.toContain('open workbench')
    expect(ui.some(l => l.includes('workbench mode'))).toBe(false)
    await $.command.run({ command: 'workbench-quit', args: '' })
    expect(ui).not.toContain('close workbench')                    // it was off
  }
  await clock.advance(3000)
}

test('adopting a task the user\'s quit parked leaves workbench mode off (#834)', async ($, on) => {
  await adoptsLeftOver($, on, { parked: true })
})

test('adopting a task handed back to Claude leaves workbench mode off (#834)', async ($, on) => {
  await adoptsLeftOver($, on, { taken_over: true })
})

test('adopting a task taken over, handed back to the agent and in review again turns workbench mode on (#926)', async ($, on) => {
  // the hand-back (wb feedback/next/resume) clears taken_over (spawn_runner): the review is the
  // agent's work again, and a later session adopting it gets the mode and its procedure back
  await adoptsLeftOver($, on, { round: 2, last: 'round 2 done' }, true)
})

test('in workbench mode the status line counts only this session\'s tasks as awaiting review (#693)', async ($, on) => {
  // #693: another session's review counted in this one's "N awaiting review"
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  const ui: string[] = []
  task(files, 'ours', 'review', { repo: '/home/u/a', cwd: '/home/u/a', session: 'sess-new' })
  task(files, 'theirs', 'review', { repo: '/home/u/b', cwd: '/home/u/b', session: 'sess-b' })
  task(files, 'asks', 'asking', { repo: '/home/u/b', cwd: '/home/u/b', session: 'sess-b' })
  fakeTasks(on, files, ['ours', 'theirs', 'asks'], true, ui)
  on('session.id', () => ({ value: 'sess-new' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })
  await clock.advance(3000)
  expect(ui.filter(l => l.startsWith('status')).at(-1)).toBe('status ⚒ wb · 1 awaiting review')
})

test('in a monorepo a session in one package is not woken for another package\'s task (#695)', async ($, on) => {
  // #695: inside the repo was enough, so a session in /mono/pkg-b claimed pkg-a's review
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'pkg', 'review', { repo: '/home/u/mono', subdir: 'pkg-a', cwd: '/home/u/mono' })
  task(files, 'here', 'review', { repo: '/home/u/mono', cwd: '/home/u/mono/pkg-a' })
  task(files, 'ours', 'review', { repo: '/home/u/mono', subdir: 'pkg-b', cwd: '/home/u/mono' })
  const names = ['pkg', 'here', 'ours']
  for (const name of names) notice(files, { ts: ts0, task: name, kind: 'review', text: `REPORT-${name}` })
  fakeTasks(on, files, names)
  on('session.id', () => ({ value: 'sess-new' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/home/u/mono/pkg-b', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(woken.filter(t => t.includes('REPORT-ours'))).toHaveLength(1)
  expect(woken.join('\n')).not.toContain('REPORT-pkg')
  expect(woken.join('\n')).not.toContain('REPORT-here')
})

test('a review the quit parked is out of the status line and wakes no one (#698)', async ($, on) => {
  // #698: the quit parked only running tasks: a review stayed "1 awaiting review" for good
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  const ui: string[] = []
  task(files, 'left', 'review', { repo: '/home/u/a', cwd: '/home/u/a' }, ts0 - 3600)
  files['/wb/tasks/left/status.json'] = JSON.stringify({ phase: 'review', round: 1, updated_at: ts0 - 3600, parked: ts0 - 60 })
  fakeTasks(on, files, ['left'], true, ui)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await clock.advance(120_000)
  expect(ui.filter(l => l.startsWith('status ⚒'))).toEqual([])
  expect(woken).toEqual([])                                     // rewake leaves it too
})

test('a notice another session took under wb\'s lock wakes no one here (#687)', async ($, on) => {
  // #687: two sessions woken by one `wb events` line each read `acked`, then wrote it: both woke
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'review', { repo: '/home/u/a', cwd: '/home/u/a' })
  notice(files, { ts: ts0, task: 'fix-it', kind: 'review', text: 'REPORT-fix-it' })
  fakeTasks(on, files)
  on('session.id', () => ({ value: 'sess-new' }))
  const acks: string[][] = []
  on('process.run', (_: any, e: any) => {
    if (e.argv[1] === 'ack') { acks.push(e.argv.slice(1)); return { value: { exitCode: 3, stdout: '', stderr: 'wb: fix-it: already acknowledged' } } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(acks).toEqual([['ack', 'fix-it', String(ts0)]])
  expect(woken.join('\n')).not.toContain('REPORT-fix-it')
})

test('a task whose Claude Code process\'s pid now belongs to another process is adopted all the same', async ($, on) => {
  // #532: the crashed session's pid was live again under another program, and `kill -0` alone
  // said the old session still ran: the new `claude` in the project never adopted its tasks
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'recycled', 'review', { repo: '/home/u/a', cwd: '/home/u/a', session: 'sess-old',
    claude_pid: 4242, claude_start: '1000' })
  task(files, 'same', 'review', { repo: '/home/u/a', cwd: '/home/u/a', session: 'sess-other',
    claude_pid: 4343, claude_start: '2000' })
  task(files, 'macos', 'review', { repo: '/home/u/a', cwd: '/home/u/a', session: 'sess-mac',
    claude_pid: 4444, claude_start: 'Thu Nov 20 09:00:00 2026' })
  const names = ['recycled', 'same', 'macos']
  for (const name of names) notice(files, { ts: ts0, task: name, kind: 'review', text: `REPORT-${name}` })
  fakeTasks(on, files, names)
  // a stat line whose 22nd field is the start: the comm may hold spaces and parentheses
  const stat = (start: string) => `9 (we (ird) x) S 1 ${'0 '.repeat(17)}${start} 0 0`
  files['/proc/4242/stat'] = stat('5000')                     // started after the task's process
  files['/proc/4343/stat'] = stat('2000')                     // the very process
  on('session.id', () => ({ value: 'sess-new' }))
  on('process.run', (_: any, e: any) => {
    if (e.argv.includes('lstart=')) {                          // no /proc for 4444: ps says
      return { value: { exitCode: 0, stdout: ' Fri Nov 21  10:00:00 2026\n', stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }  // kill -0: every pid is live
  })
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(woken.filter(t => t.includes('REPORT-recycled'))).toHaveLength(1)  // the pid lives, not its process
  expect(woken.filter(t => t.includes('REPORT-macos'))).toHaveLength(1)     // ps's start differs too
  expect(woken.join('\n')).not.toContain('REPORT-same')                    // the same process: still its own
})

test('without /proc, a live Claude Code process reads as alive whatever the time zone (#848)', async ($, on) => {
  // #848: ps's lstart is local time, so after a zone change every live session's process read as
  // recycled and the first session to poll adopted their tasks
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'utc', 'review', { repo: '/home/u/a', cwd: '/home/u/a', session: 'sess-utc',
    claude_pid: 4444, claude_start: 'Fri Nov 21 15:00:00 2026' })
  task(files, 'old', 'review', { repo: '/home/u/a', cwd: '/home/u/a', session: 'sess-old',
    claude_pid: 4545, claude_start: 'Fri Nov 21 10:00:00 2026' })       // local time, before #848
  task(files, 'gone', 'review', { repo: '/home/u/a', cwd: '/home/u/a', session: 'sess-gone',
    claude_pid: 4646, claude_start: 'Thu Nov 20 09:00:00 2026' })
  const names = ['utc', 'old', 'gone']
  for (const name of names) notice(files, { ts: ts0, task: name, kind: 'review', text: `REPORT-${name}` })
  fakeTasks(on, files, names)
  on('session.id', () => ({ value: 'sess-new' }))
  const local: Record<string, string> = { '4444': 'Fri Nov 21 10:00:00 2026', '4545': 'Fri Nov 21 10:00:00 2026', '4646': 'Fri Nov 21 11:00:00 2026' }
  const utc: Record<string, string> = { '4444': 'Fri Nov 21 15:00:00 2026', '4545': 'Fri Nov 21 15:00:00 2026', '4646': 'Fri Nov 21 16:00:00 2026' }
  on('process.run', (_: any, e: any) => {
    if (e.argv.includes('lstart=')) {
      const pid = e.argv[e.argv.length - 1]
      return { value: { exitCode: 0, stdout: ` ${(e.argv.includes('TZ=UTC0') ? utc : local)[pid]}\n`, stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }  // kill -0: every pid is live
  })
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(woken.filter(t => t.includes('REPORT-gone'))).toHaveLength(1)  // recycled: adopted
  expect(woken.join('\n')).not.toContain('REPORT-utc')                 // the same process, in UTC
  expect(woken.join('\n')).not.toContain('REPORT-old')                 // and in an old stamp
})

test('without a kill executable, /proc says which Claude Code processes are gone (#700)', async ($, on) => {
  // #700: `kill -0` threw ENOENT in a container without procps, so no gone process was ever seen
  // and nobody was woken for a crashed session's tasks
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'orphan', 'review', { repo: '/home/u/a', cwd: '/home/u/a', session: 'sess-old', claude_pid: 4242 })
  task(files, 'live', 'review', { repo: '/home/u/a', cwd: '/home/u/a', session: 'sess-other', claude_pid: 4343, claude_start: '2000' })
  for (const name of ['orphan', 'live']) notice(files, { ts: ts0, task: name, kind: 'review', text: `REPORT-${name}` })
  fakeTasks(on, files, ['orphan', 'live'])
  files['/proc/self/stat'] = '1 (x) S 1'
  files['/proc/4343/stat'] = `4343 (claude) S 1 ${'0 '.repeat(17)}2000 0 0`
  on('session.id', () => ({ value: 'sess-new' }))
  on('process.run', (_: any, e: any) => {
    if (e.argv[0] === 'kill') throw new Error('ENOENT: kill')       // no procps
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(woken.filter(t => t.includes('REPORT-orphan'))).toHaveLength(1)
  expect(woken.join('\n')).not.toContain('REPORT-live')
})

test('a listener whose life can\'t be told keeps the chat while its claim is fresh (#700)', async ($, on) => {
  // #700: unknown liveness read as gone, so two listening sessions took listener.json from each
  // other on every poll, each write the other's `wb events` line
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  chatOn(files)
  const claim = JSON.stringify({ session: 'other-key', pid: 777, start: '1' })
  files['/wb/chat/listener.json'] = claim
  mtimes['/wb/chat/listener.json'] = 1_800_000_000_000
  on('process.run', (_: any, e: any) => {
    if (e.argv[0] === 'kill') throw new Error('ENOENT: kill')
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })
  await clock.advance(3000)
  expect(files['/wb/chat/listener.json']).toBe(claim)            // theirs stands
  delete mtimes['/wb/chat/listener.json']                       // stale: gone, by every sign there is
  await clock.advance(31_000)
  expect(JSON.parse(files['/wb/chat/listener.json']).session).not.toBe('other-key')
})

test('without /proc the chat listener spawns no kill or ps for its own claim, and asks of another\'s at most twice a minute (#839)', async ($, on) => {
  // #839: on macOS listen ran `kill -0` and `ps` on every 1.5 s poll, for its own claim too
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'run', 'running', { repo: '/home/u/a', cwd: '/home/u/a' })   // polls every 1.5 s
  fakeTasks(on, files, ['run'])
  chatOn(files)
  const asks: string[][] = []
  on('process.run', (_: any, e: any) => {
    if (e.argv[0] === 'kill' || e.argv.includes('ps')) asks.push(e.argv)
    return { value: { exitCode: 0, stdout: e.argv[1] === 'watch' ? '{}' : '', stderr: '' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })
  await clock.advance(3000)
  const own = files['/wb/chat/listener.json']
  expect(JSON.parse(own).pid).toBe(4242)                           // this session listens
  await clock.advance(30_000)
  expect(files['/wb/chat/listener.json']).toBe(own)
  expect(asks).toEqual([])                                         // its own claim: never asked
  files['/wb/chat/listener.json'] = JSON.stringify({ session: 'other-key', pid: 777, start: '1' })
  await clock.advance(60_000)
  expect(files['/wb/chat/listener.json']).toContain('other-key')  // theirs stands
  expect(asks.filter(a => a[0] === 'kill').length).toBeGreaterThanOrEqual(1)
  expect(asks.filter(a => a[0] === 'kill').length).toBeLessThanOrEqual(3)  // not 40
})

test('on a file system that ignores case, a task under ~/Repos is a session in ~/repos\'s', async ($, on) => {
  // the 2026-11-19 audit (finding 28): by the raw strings it was no one's
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'cased', 'review', { repo: '/Users/u/Repos/a', cwd: '/Users/u/Repos/a' })
  notice(files, { ts: ts0, task: 'cased', kind: 'review', text: 'REPORT-cased' })
  fakeTasks(on, files, ['cased'])
  on('session.id', () => ({ value: 'sess-new' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  files['/uSERS/U/REPOS/A'] = ''  // the directory, every letter's case swapped: APFS finds it
  await $.session.start({ cwd: '/Users/u/repos/a', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(woken.filter(t => t.includes('REPORT-cased'))).toHaveLength(1)
})

test('where case counts, a task under another directory differing only in case is not this session\'s', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'cased', 'review', { repo: '/home/u/Repos/a', cwd: '/home/u/Repos/a' })
  notice(files, { ts: ts0, task: 'cased', kind: 'review', text: 'REPORT-cased' })
  fakeTasks(on, files, ['cased'])
  on('session.id', () => ({ value: 'sess-new' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/home/u/repos/a', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(woken.join('\n')).not.toContain('REPORT-cased')
})

test('a scripted session (claude -p, the SDK) takes no wake and runs no wb, until a person attaches', async ($, on) => {
  // the 2026-11-16 audit: a `claude -p` run took the terminal session's review wake
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'review')
  notice(files, { ts: ts0, task: 'fix-it', kind: 'review', text: 'REPORT' })
  fakeTasks(on, files, ['fix-it'], false)
  const runs: string[][] = []
  on('process.run', (_: any, e: any) => { runs.push(e.argv); return { value: { exitCode: 0, stdout: 'fix-it review', stderr: '' } } })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.context', (_: any, e: any) => ({ blocks: e.blocks }))
  on('session.attach', (_: any, e: any) => ({ clientId: e.clientId }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await $.turn.start({ text: 'scripted', turnId: 't1' })
  await $.turn.complete(endTurn('t1'))
  const ctx = await $.prompt.context({ blocks: [] })
  await clock.advance(120_000)
  expect(woken).toEqual([])
  expect(files['/wb/tasks/fix-it/acked']).toBe(undefined)
  expect(files['/wb/scout.json']).toBe(undefined)               // nor the weekly check
  expect(runs).toEqual([])                                      // no wb status before each prompt
  expect(ctx.blocks.map((b: any) => b.name)).not.toContain('workbench')

  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.advance(3000)
  expect(woken.filter(t => t.includes('REPORT'))).toHaveLength(1)
})

test('a wake the engine drops is not acknowledged, and comes again a minute later', async ($, on) => {
  // the 2026-11-16 audit: a settings hook blocked the wake, the notice was acked, and lost for good
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'review')
  notice(files, { ts: ts0, task: 'fix-it', kind: 'review', text: 'REPORT' })
  fakeTasks(on, files)
  on('process.run', wbAck(files))
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  const tried: string[] = []
  on('prompt.submit', (_: any, e: any) => {
    tried.push(e.text)
    return tried.length === 1 ? { drop: 'blocked by a hook' } : { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(tried).toHaveLength(1)
  expect(Number(files['/wb/tasks/fix-it/acked'] ?? 0)).toBeLessThan(ts0)   // not acknowledged
  expect(toasts.join('\n')).toContain('dropped (blocked by a hook)')
  await clock.advance(70_000)
  expect(tried).toHaveLength(2)                                 // the safety net tries again
  expect(tried[1]).toContain('Task `fix-it` is ready for review')
  await clock.advance(120_000)
  expect(tried).toHaveLength(2)                                 // once it went through
})

test('a mark another session claimed after this one\'s take is never written back lower (#786)', async ($, on) => {
  // #786: after `wb ack` took R1, a later claim of R2 landed, and the mod's plain write of R1
  // lowered the mark under it: its own next poll took R2 again, delivered by both
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'review')
  notice(files, { ts: ts0, task: 'fix-it', kind: 'review', text: 'REPORT' })
  fakeTasks(on, files)
  on('process.run', wbAck(files, name => { files[`/wb/tasks/${name}/acked`] = String(ts0 + 5) }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(files['/wb/tasks/fix-it/acked']).toBe(String(ts0 + 5))
})

test('a question the running turn refused goes back only while the mark is still this session\'s (#786)', async ($, on) => {
  // #786: the refused send wrote the old mark back unconditionally, over a notice another
  // session or wb wait had claimed meanwhile, which was then delivered a second time
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'asking')
  files['/wb/tasks/fix-it/ask/q1.json'] = JSON.stringify({ id: 'q1' })
  notice(files, { ts: ts0, task: 'fix-it', kind: 'question', id: 'q1', text: 'Q: which config?' })
  fakeTasks(on, files)
  const runs: string[][] = []
  const ack = wbAck(files)
  on('process.run', (h: any, e: any) => { runs.push(e.argv.slice(1)); return ack(h, e) })
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.send', () => {                                      // refused, and meanwhile a later
    files['/wb/tasks/fix-it/acked'] = String(ts0 + 7)            // notice was claimed elsewhere
    return { isDelivered: false, reason: 'busy' }
  })
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'a long review', turnId: 't1' })
  await clock.advance(3000)
  expect(runs).toContainEqual(['ack', 'fix-it', '0', '--if', String(ts0)])
  expect(files['/wb/tasks/fix-it/acked']).toBe(String(ts0 + 7))  // not lowered under the claim
})

test('a notice already delivered (before a reload, or by wb wait) is not rewoken as lost', async ($, on) => {
  // the 2026-11-16 audit: after /reload-plugins, "no notice reached Claude" for a review it had
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'review', {}, ts0 + 0.05)               // the runner's last write lands after its notice
  notice(files, { ts: ts0, task: 'fix-it', kind: 'review', text: 'REPORT' })
  files['/wb/tasks/fix-it/acked'] = String(ts0)
  task(files, 'older', 'stuck', {}, ts0 - 7200 + 0.05)          // two hours ago: past the wake's hour
  notice(files, { ts: ts0 - 7200, task: 'older', kind: 'stuck', text: 'STUCK' })
  files['/wb/tasks/older/acked'] = String(ts0 - 7200)
  fakeTasks(on, files, ['fix-it', 'older'])
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(120_000)
  expect(woken).toEqual([])
})

test('a review whose notice left notify.jsonl\'s tail is not rewoken after a reload: its own noticed mark says it was had (#844)', async ($, on) => {
  // #844: mem.noticed came only from the last 1 MiB of notify.jsonl, so a review acknowledged at
  // its notice's ts, its runner's last status write after that, woke Claude a second time
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'review', {}, ts0 + 0.05)               // the runner's last write lands after its notice
  files['/wb/notify.jsonl'] = JSON.stringify({ ts: ts0 + 1, task: 'other', kind: 'checkin', text: 'later news' }) + '\n'
  files['/wb/tasks/fix-it/acked'] = String(ts0)                 // its notice woke Claude
  files['/wb/tasks/fix-it/noticed'] = String(ts0)               // Task.notify's mark of it
  fakeTasks(on, files, ['fix-it'])
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(120_000)
  expect(woken).toEqual([])
  files['/wb/tasks/fix-it/noticed'] = String(ts0 + 30)          // a newer notice it never acknowledged
  await clock.advance(120_000)
  expect(woken.filter(w => w.includes('no notice reached Claude'))).toHaveLength(1)
})

test('one notice for the tasks a restart interrupted wakes once, ending with the resume, not the failure\'s next step', async ($, on) => {
  // #544: the batch's wake ended with "Look at wb log …; feedback or discard" after its own
  // wb resume --all line, and the tasks it named but carried no notice of their own were rewoken
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'a', 'failed', {}, ts0 + 0.05)
  task(files, 'b', 'failed', {}, ts0 + 0.05)                   // its last write lands after the notice
  notice(files, { ts: ts0, task: 'a', kind: 'failed', tasks: ['a', 'b'],
    text: '2 tasks were interrupted by a restart: a, b. wb resume a b continues them' })
  files['/wb/tasks/b/acked'] = String(ts0)                    // acknowledged with a's notice
  fakeTasks(on, files, ['a', 'b'])
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(120_000)
  expect(woken).toHaveLength(1)
  expect(woken[0]).toContain('[workbench] Tasks `a`, `b` were interrupted.')
  expect(woken[0]).toContain('`wb resume a b` continues them all')    // by name (#692)
  expect(woken[0]).not.toContain('wb log')
  expect(woken[0]).not.toContain('wb feedback')
  expect(toasts).toContain('workbench: a and 1 more were interrupted')
})

test('a shutdown\'s notice for one task says to resume it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'a', 'stuck')
  notice(files, { ts: ts0, task: 'a', kind: 'stuck', tasks: ['a'], text: 'task a: the runner was stopped by a signal' })
  fakeTasks(on, files, ['a'])
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(woken).toHaveLength(1)
  expect(woken[0]).toContain('[workbench] Task `a` was interrupted.')
  expect(woken[0]).toContain('`wb resume a` continues it in a fresh session')
  expect(woken[0]).not.toContain('Steer it')
})

test('two wakes due in one turn both arrive, the second after the first one\'s turn', async ($, on) => {
  // the 2026-11-16 audit: the second report never came, only a rewake a minute later
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'a', 'review')
  task(files, 'b', 'review')
  fakeTasks(on, files, ['a', 'b'])
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => {
    woken.push(e.text)
    if (woken.length === 1) void $.turn.start({ text: e.text, turnId: 'w1' }) // the engine starts it at once
    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'busy', turnId: 't1' })
  notice(files, { ts: ts0, task: 'a', kind: 'review', text: 'REPORT-A' })
  notice(files, { ts: ts0 + 1, task: 'b', kind: 'review', text: 'REPORT-B' })
  await clock.advance(3000)
  await $.turn.complete(endTurn('t1'))
  await clock.advance(3000)
  await $.turn.complete(endTurn('w1'))
  await clock.advance(3000)
  expect(woken.filter(t => t.includes('REPORT-A'))).toHaveLength(1)
  expect(woken.filter(t => t.includes('REPORT-B'))).toHaveLength(1)
  expect(woken.join('\n')).not.toContain('no notice reached Claude')
})

test('two questions asked at once both reach Claude, each with its own id', async ($, on) => {
  // the 2026-11-16 audit: the newest alone was delivered, and the first stayed blocked
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'asking')
  for (const id of ['q1', 'q2']) {
    files[`/wb/tasks/fix-it/ask/${id}.json`] = JSON.stringify({ id })
    notice(files, { ts: ts0 + (id === 'q1' ? 0 : 1), task: 'fix-it', kind: 'question', id, text: `Q: ${id}?` })
  }
  fakeTasks(on, files)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(woken.filter(t => t.includes('Q: q1?') && t.includes('wb answer fix-it --id q1'))).toHaveLength(1)
  expect(woken.filter(t => t.includes('Q: q2?') && t.includes('wb answer fix-it --id q2'))).toHaveLength(1)
})

test('a question whose task no longer asks is acknowledged without a wake', async ($, on) => {
  // the 0.90 review: its ask file had no answer, so a question that timed out woke Claude for it
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'running')
  files['/wb/tasks/fix-it/ask/q1.json'] = JSON.stringify({ id: 'q1' })
  notice(files, { ts: ts0, task: 'fix-it', kind: 'question', id: 'q1', text: 'Q: q1?' })
  fakeTasks(on, files)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(woken.filter(t => t.includes('Q: q1?'))).toHaveLength(0)
  expect(Number(files['/wb/tasks/fix-it/acked'])).toBe(ts0)
})

test('an agent\'s question reaches Claude in its running turn, and a review notice still waits for the turn to end (#542)', async ($, on) => {
  // a 20-minute review turn held task B's question until the agent timed out and guessed
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'asking')
  task(files, 'other', 'review')
  files['/wb/tasks/fix-it/ask/q1.json'] = JSON.stringify({ id: 'q1' })
  notice(files, { ts: ts0, task: 'fix-it', kind: 'question', id: 'q1', text: 'PERMISSION to run: `make docs`' })
  notice(files, { ts: ts0, task: 'other', kind: 'review', text: 'REPORT-other' })
  fakeTasks(on, files, ['fix-it', 'other'])
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  const sent: any[] = []
  on('session.send', (_: any, e: any) => { sent.push(e); return { isDelivered: true } })
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'reviewing task A', turnId: 't1' })
  await clock.advance(3000)
  expect(sent.length).toBe(1)                                    // into the running turn
  expect(sent[0].to).toBe('sess-1')
  expect(sent[0].text).toContain('PERMISSION to run: `make docs`')
  expect(sent[0].text).toContain('wb allow fix-it')
  expect(sent[0].text).toContain('delivered this into your running turn')
  expect(Number(files['/wb/tasks/fix-it/acked'])).toBe(ts0)
  expect(woken).toEqual([])                                      // the review waits
  await clock.advance(3000)
  expect(sent.length).toBe(1)                                    // once
  await $.turn.complete(endTurn('t1'))
  await clock.advance(3000)
  expect(woken.filter(t => t.includes('REPORT-other'))).toHaveLength(1)
  expect(woken.filter(t => t.includes('make docs'))).toHaveLength(0)  // not again after the turn
})

test('a question held for a turn that could not take it, which then timed out, is said after the turn, not acknowledged in silence (#542)', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'asking')
  files['/wb/tasks/fix-it/ask/q1.json'] = JSON.stringify({ id: 'q1' })
  notice(files, { ts: ts0, task: 'fix-it', kind: 'question', id: 'q1', text: 'Q: which config?' })
  fakeTasks(on, files)
  on('process.run', wbAck(files))
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.send', () => ({ isDelivered: false, reason: 'busy' }))  // refused: held for the turn
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'a long review', turnId: 't1' })
  await clock.advance(3000)
  expect(files['/wb/tasks/fix-it/acked']).toBe(String(0))       // not acknowledged: held
  // the ask timeout passes mid-turn: the runner answers it itself and the task runs on
  files['/wb/tasks/fix-it/ask/q1.answer'] = 'No answer arrived in time. Make the most reasonable assumption, carry on.'
  task(files, 'fix-it', 'running', {}, ts0 + 1200)
  await $.turn.complete(endTurn('t1'))
  await clock.advance(3000)
  expect(woken).toHaveLength(1)
  expect(woken[0]).toContain('Q: which config?')
  expect(woken[0]).toContain('went on with its own assumption')
  expect(Number(files['/wb/tasks/fix-it/acked'])).toBe(ts0)
  await clock.advance(3000)
  expect(woken).toHaveLength(1)
})

test('another plugin\'s tool call between turns does not hold the wakes', {
  plugins: [{
    name: 'peek',
    register(on) {
      on('session.start', async ($, e, next) => {
        await $.command.register({ name: 'peek', description: 'reads a file' })
        return next(e)
      })
      on('command.run', { command: 'peek' }, async $ => {
        await $.tool.call({ tool: 'Read', file_path: '/x' } as any).catch(() => {})
        return { text: '' }
      })
    },
  }],
}, async ($, on) => {
  // the 2026-11-16 audit: a plugin's $.tool.call marked Claude busy until a turn the user started
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'review')
  fakeTasks(on, files)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {}, text: '' }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'peek', args: '' })
  notice(files, { ts: ts0, task: 'fix-it', kind: 'review', text: 'REPORT' })
  await clock.advance(3000)
  expect(woken.filter(t => t.includes('REPORT'))).toHaveLength(1)
})

test('the weekly update check runs beside the wakes, not in front of them', async ($, on) => {
  // the 2026-11-16 audit: a stalled fetch held every wake for up to two minutes
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'review')
  fakeTasks(on, files)
  on('process.run', async (_: any, e: any) => {
    if (e.argv[1] === 'update') await new Promise(() => {})    // the network hangs
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  notice(files, { ts: ts0, task: 'fix-it', kind: 'review', text: 'REPORT' })
  await $.turn.complete(endTurn('t1'))
  await clock.advance(3000)
  expect(woken.filter(t => t.includes('REPORT'))).toHaveLength(1)
})

test('a notify.jsonl past what one read takes is read from its end, and still wakes Claude', async ($, on) => {
  // the 2026-11-16 audit: past 4 MiB the read failed, deliver read '' and no wake came again
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'review')
  files['/wb/notify.jsonl'] = (JSON.stringify({ ts: ts0 - 86400, task: 'gone', kind: 'review', text: 'old' }) + '\n').repeat(30_000)
  notice(files, { ts: ts0, task: 'fix-it', kind: 'review', text: 'REPORT' })
  fakeTasks(on, files)
  const runs: string[][] = []
  on('process.run', (_: any, e: any) => {
    runs.push(e.argv)
    if (e.argv[0] === 'tail') return { value: { exitCode: 0, stdout: files[e.argv[3]].slice(-Number(e.argv[2])), stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(runs).toContainEqual(['tail', '-c', String(1 << 20), '/wb/notify.jsonl'])
  expect(woken.filter(t => t.includes('REPORT'))).toHaveLength(1)
})

test('a task in review whose events have not changed is not read again on every poll', async ($, on) => {
  // #739 (the 2026-11-21 audit): each poll (every 1.5 s while a task ran) spawned `tail` for every
  // open task's events.jsonl past 64 KB, unchanged since the task went to review
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'waits', 'review')
  task(files, 'runs', 'running')
  const row = (brief: string) => JSON.stringify({ kind: 'tool', tool: 'read', brief, ok: true }) + '\n'
  files['/wb/tasks/waits/events.jsonl'] = row('x'.repeat(200)).repeat(400) + row('last.py')
  files['/wb/tasks/runs/events.jsonl'] = row('a.py')
  fakeTasks(on, files, ['waits', 'runs'])
  const tails: string[] = []
  on('process.run', (_: any, e: any) => {
    if (e.argv[0] === 'tail') {
      tails.push(e.argv[3])
      return { value: { exitCode: 0, stdout: files[e.argv[3]].slice(-Number(e.argv[2])), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(15_000)                                     // ten polls and more
  const waits = () => tails.filter(p => p === '/wb/tasks/waits/events.jsonl').length
  expect(waits()).toBe(1)
  files['/wb/tasks/waits/events.jsonl'] += row('new.py')         // it changed: read once more
  await clock.advance(3000)
  expect(waits()).toBe(2)
})

test('#921: notify.jsonl unchanged is not read again on every poll, mid-turn or not', async ($, on) => {
  // deliver read the whole file (past 1 MiB, a `tail` spawned) before its size@mtime check
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'review')
  task(files, 'runs', 'running')                                  // a task active: a poll each 1.5 s
  notice(files, { ts: ts0 - 7200, task: 'fix-it', kind: 'review', text: 'OLD ' + 'x'.repeat(5000) })
  const { reads } = fakeTasks(on, files, ['fix-it', 'runs'])
  on('process.run', wbAck(files))
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const notify = () => reads.filter(p => p === '/wb/notify.jsonl').length
  await clock.advance(15_000)                                     // ten polls and more
  expect(notify()).toBe(1)
  await $.turn.start({ text: 'busy', turnId: 't1' })
  await clock.advance(15_000)                                     // mid-turn: the rows kept
  expect(notify()).toBe(1)
  notice(files, { ts: ts0, task: 'fix-it', kind: 'review', text: 'NEW' })  // it changed: read once
  await clock.advance(6000)
  expect(notify()).toBe(2)
  await $.turn.complete(endTurn('t1'))
  await clock.advance(6000)
  expect(woken.filter(t => t.includes('NEW'))).toHaveLength(1)     // the held wake still comes
  expect(notify()).toBe(2)
})

test('outside workbench mode another session\'s running task opens no pane and fills no status line', async ($, on) => {
  // 2026-11-17: a session opened in another project showed the pane and the task's status line for
  // a task this session never started, and /workbench-quit couldn't clear it
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'theirs', 'running', { repo: '/home/u/b', cwd: '/home/u/b' })
  const ui: string[] = []
  const dirs = ['theirs']
  fakeTasks(on, files, dirs, true, ui)
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(ui).not.toContain('open workbench')
  expect(ui.filter(u => u.includes('theirs'))).toEqual([])
  // its own task does both
  task(files, 'ours', 'running', { repo: '/home/u/a', cwd: '/home/u/a' })
  dirs.push('ours')
  await clock.advance(6000)
  expect(ui).toContain('open workbench')
  expect(ui.filter(u => u.startsWith('status ')).at(-1)).toBe('status ⚒ wb · ours running r1')
})

test('a task /workbench-quit parked is not counted as awaiting review, nor rewoken', async ($, on) => {
  // #541: a task the quit stopped stayed "1 awaiting review" in the status line for weeks
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'quit', 'stuck', { repo: '/home/u/a', cwd: '/home/u/a' })
  files['/wb/tasks/quit/status.json'] = JSON.stringify({ phase: 'stuck', round: 1, updated_at: ts0 - 300, parked: ts0 - 300 })
  task(files, 'done', 'review', { repo: '/home/u/a', cwd: '/home/u/a' })
  files['/wb/tasks/done/acked'] = String(ts0)
  const ui: string[] = []
  fakeTasks(on, files, ['quit', 'done'], true, ui)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await clock.advance(120_000)
  expect(ui.filter(u => u.startsWith('status ')).at(-1)).toBe('status ⚒ wb · 1 awaiting review')
  expect(woken.join('\n')).not.toContain('quit')                // no "no notice reached Claude" for it
})

test('the pane follows the running task: its whole history, then what it is doing now', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const ts = 1_800_000_000
  const files: Record<string, string> = {
    '/wb/tasks/fix-it/task.json': JSON.stringify({ name: 'fix-it', model: 'm', created_at: ts }),
    '/wb/tasks/fix-it/status.json': JSON.stringify({ phase: 'running', round: 1, updated_at: ts }),
  }
  fakeTasks(on, files)
  const runs: string[][] = []
  on('process.run', (_: any, e: any) => {
    runs.push(e.argv)
    if (e.argv[1] === 'chat' && e.argv[2] === 'url') {
      return { value: { exitCode: 0, stdout: 'https://box.tail.ts.net/#token=abc\n', stderr: '' } }
    }
    const lines = [
      { s: 'claude', t: 'Claude → agent · spec' },
      { s: 'think', t: '  ✻ thought for 2.0s' },
      { s: 'add', t: '    +42' },
      { s: 'meta', t: 'M · reasoning on, default effort' },
      { s: 'activity', t: 'Writing… 3.0s · ↓ 45 tokens · 41 tok/s' },
      { s: 'clock', t: '⏲ task 4m · ~5m left (typically 9m)' },
    ]
    return { value: { exitCode: 0, stdout: lines.map(l => JSON.stringify(l)).join('\n'), stderr: '' } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  const watches = () => runs.filter(r => r[1] === 'watch')
  expect(watches()[0]).toEqual(['wb', 'watch', 'fix-it', '--json', '--last', '2000'])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /── fix-it · ↑↓ scrolls/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'Claude → agent · spec' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: '    +42' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Writing… 3\.0s · ↓ 45 tokens/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /reasoning on/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /~5m left/ })).toBeTruthy()
  await ui.unmount()

  // a running task is re-read every few seconds, since its session moves between status writes
  await clock.advance(6000)
  expect(watches().length).toBeGreaterThan(1)
})

test('a running task writing its status on every tool call is re-read at most every few seconds (#691)', async ($, on) => {
  // #691: each status write made a new key, and each new key ran `wb watch --json` (a Python start
  // and an OpenCode export) at once, back to back for the whole round
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'running', { repo: '/home/u/a', cwd: '/home/u/a' })
  fakeTasks(on, files, ['fix-it'])
  const runs: string[][] = []
  on('process.run', (_: any, e: any) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: JSON.stringify({ s: 'claude', t: `line ${runs.length}` }), stderr: '' } }
  })
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  const watches = () => runs.filter(r => r[1] === 'watch').length
  expect(watches()).toBe(1)
  for (let i = 1; i <= 20; i++) {                               // a tool call every half second, for 10 s
    files['/wb/tasks/fix-it/status.json'] = JSON.stringify({ phase: 'running', round: 1, updated_at: ts0 + i })
    await clock.advance(500)
  }
  expect(watches()).toBeGreaterThanOrEqual(2)                   // it still moves
  expect(watches()).toBeLessThanOrEqual(3)                      // but at most every LIVE_EVERY_MS
  files['/wb/tasks/fix-it/status.json'] = JSON.stringify({ phase: 'review', round: 1, updated_at: ts0 + 30 })
  const n = watches()
  await clock.advance(1600)
  expect(watches()).toBe(n + 1)                                 // done: read at once
})

test('a running task\'s transcript is not read while the pane shows the Stats or Settings tab (#838)', async ($, on) => {
  // #838: refreshLive checked only that the pane was shown, so a round was exported every five
  // seconds on tabs that never draw it
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'running', { repo: '/home/u/a', cwd: '/home/u/a' })
  const pane = fakeTasks(on, files, ['fix-it'], true, [], false)
  const runs: string[][] = []
  on('process.run', (_: any, e: any) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: e.argv[1] === 'watch' ? JSON.stringify({ s: 'claude', t: 'x' }) : '', stderr: '' } }
  })
  on('process.spawn', async function* () {                       // wb events, and wb top for the Stats tab
    yield { stream: 'stdout', text: '{"hello": 4242}\n' }
    await new Promise(() => {})
    return { code: 0, signal: null }
  })
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  pane.show(true)
  await clock.advance(1000)
  const watches = () => runs.filter(r => r[1] === 'watch').length
  expect(watches()).toBe(1)                                      // the Tasks tab: read
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  for (const tab of ['tab-stats', 'tab-settings']) {
    await ui.press({ key: tab })
    const n = watches()
    for (let i = 1; i <= 10; i++) {
      files['/wb/tasks/fix-it/status.json'] = JSON.stringify({ phase: 'running', round: 1, updated_at: ts0 + i + (tab === 'tab-stats' ? 0 : 20) })
      await clock.advance(2000)
    }
    expect(watches()).toBe(n)                                    // 20 s running: never read there
  }
  await ui.press({ key: 'tab-tasks' })
  await clock.advance(1600)
  expect(watches()).toBeGreaterThan(1)                           // back on Tasks: read again
  await ui.unmount()
})

test('/workbench-quit stops everything; /workbench-quit-and-hand-back-claude hands the tasks to Claude', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  fakeTasks(on, {})
  const runs: string[][] = []
  on('process.run', (_: any, e: any) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: e.argv[1] === 'stop' ? 'stopped: fix-it' : 'took over fix-it', stderr: '' } }
  })
  const submitted: string[] = []
  on('prompt.submit', (_: any, e: any) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const quit = await $.command.run({ command: 'workbench-quit', args: '' })
  expect(runs.at(-1)).toEqual(['wb', 'stop', '--all', '--park-waiting', '--repo', '/'])  // this session's tasks
  expect(quit.text).toContain('stopped: fix-it')
  expect(JSON.stringify(quit.context)).toContain("Don't finish, restart")  // Claude is told
  expect(submitted.length).toBe(0)                                         // without a turn

  await $.command.run({ command: 'workbench-quit-and-hand-back-claude', args: '' })
  expect(runs.at(-1)).toEqual(['wb', 'takeover', '--all', '--user', '--repo', '/'])
  await clock.advance(2000)
  expect(submitted.at(-1)).toContain('took over fix-it')                  // Claude starts now
  expect(submitted.at(-1)).toContain('Leave workbench mode')

  // Typed words never stop anything: only the commands do.
  const before = runs.length
  await $.prompt.submit({ text: 'if I said bail out claude, would it stop?' })
  expect(runs.length).toBe(before)
})

test('wb failing is said as a failure: not open tasks, not agents stopped', async ($, on) => {
  // the 2026-11-16 audit: a broken wb's traceback reached Claude as "Tasks … are open"
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  fakeTasks(on, {})
  const trace = 'Traceback (most recent call last):\n  File "wb"\nSyntaxError: invalid syntax'
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: trace } }))
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('prompt.context', (_: any, e: any) => ({ blocks: e.blocks }))
  const submitted: string[] = []
  on('prompt.submit', (_: any, e: any) => { submitted.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ctx = await $.prompt.context({ blocks: [] })
  expect(ctx.blocks.map((b: any) => b.name)).not.toContain('workbench')
  expect(toasts.join('\n')).toContain('wb status failed: SyntaxError: invalid syntax')

  const quit = await $.command.run({ command: 'workbench-quit', args: '' })
  expect(quit.text).toContain('not stopped')
  expect(JSON.stringify(quit.context)).toContain('failed, so its agents may still be running')
  const back = await $.command.run({ command: 'workbench-quit-and-hand-back-claude', args: '' })
  expect(back.text).toContain('wb takeover --all failed')
  await clock.advance(3000)
  expect(submitted.join('\n')).not.toContain('Leave workbench mode')   // no turn to finish what wasn't handed over
})

test('#918: a hand-back that took over one task and was refused another still gives Claude its turn', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  fakeTasks(on, {})
  on('process.run', (_: any, e: any) => ({ value: e.argv[1] === 'takeover'
    ? { exitCode: 3, stdout: 'took over fix-it: the agent is stopped.', stderr: 'wb: other: report the blocker to the user' }
    : { exitCode: 0, stdout: '', stderr: '' } }))
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  const submitted: string[] = []
  on('prompt.submit', (_: any, e: any) => { submitted.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const back = await $.command.run({ command: 'workbench-quit-and-hand-back-claude', args: '' })
  expect(back.text).not.toContain('failed')
  expect(toasts.join('\n')).toContain("some tasks weren't taken over")
  await clock.advance(2000)
  expect(submitted.at(-1)).toContain('took over fix-it')        // the turn for the one taken
  expect(submitted.at(-1)).toContain('report the blocker')      // and the refusal, said with it
})

test('a closed task compacts Claude early, keeping the delegation state; open tasks come back after', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const ts = 1_800_000_000
  const files: Record<string, string> = {
    '/wb/tasks/fix-it/task.json': JSON.stringify({ name: 'fix-it', model: 'q', created_at: ts }),
    '/wb/tasks/fix-it/status.json': JSON.stringify({ phase: 'running', round: 1, updated_at: ts }),
  }
  fakeTasks(on, files)
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'fix-it   running   1 q', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.context', (_: any, e: any) => ({ blocks: e.blocks }))
  let tokens = 300_000
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: {
    tokens, window: 1_000_000, percent: 30,
    breakdown: { isAutoCompactEnabled: true, autoCompactThreshold: 400_000 } } } }))
  const compactions: (string | undefined)[] = []
  on('session.compact', (_: any, e: any) => {
    compactions.push(e.instructions)
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  })
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })
  await clock.advance(2000)
  expect(compactions.length).toBe(0)              // the task is still running

  // Any compaction meanwhile (here a /compact) is told to keep the delegation state.
  await $.session.compact({ instructions: 'the plan', trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as any)
  expect(compactions.at(-1)).toContain('the plan')
  expect(compactions.at(-1)).toContain('Workbench delegation is in progress')

  // A fresh or compacted conversation is handed the open tasks.
  const ctx = await $.prompt.context({ blocks: [] })
  expect(ctx.blocks.find((b: any) => b.name === 'workbench')?.text).toContain('fix-it   running')

  // The task closes: at 300K of 400K (75%, past the halfway mark) Claude is compacted once.
  files['/wb/tasks/fix-it/status.json'] = JSON.stringify({ phase: 'accepted', round: 1, updated_at: ts + 5 })
  await clock.advance(2000)
  expect(compactions.length).toBe(2)
  expect(compactions.at(-1)).toContain('Drop the diffs')
  await clock.advance(2000)
  expect(compactions.length).toBe(2)              // once per boundary

  // Below the mark, a boundary leaves the context alone.
  tokens = 100_000
  files['/wb/tasks/fix-it/status.json'] = JSON.stringify({ phase: 'running', round: 2, updated_at: ts + 9 })
  await clock.advance(2000)
  files['/wb/tasks/fix-it/status.json'] = JSON.stringify({ phase: 'discarded', round: 2, updated_at: ts + 12 })
  await clock.advance(2000)
  expect(compactions.length).toBe(2)
})

test('a session that never delegated is not compacted when a task closes', async ($, on) => {
  // the 2026-11-16 audit: a task closing compacted every session's context, delegating or not
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'running')
  fakeTasks(on, files)
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'fix-it   running', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: {
    tokens: 300_000, window: 1_000_000, percent: 30,
    breakdown: { isAutoCompactEnabled: true, autoCompactThreshold: 400_000 } } } }))
  const compactions: (string | undefined)[] = []
  on('session.compact', (_: any, e: any) => {
    compactions.push(e.instructions)
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
  task(files, 'fix-it', 'accepted', {}, ts0 + 5)
  await clock.advance(4000)
  expect(compactions).toEqual([])
  await $.session.compact({ instructions: 'the plan', trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as any)
  expect(compactions).toEqual(['the plan'])                     // a /compact of its own, untouched
})

test('the live header names the followed task', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const ts = 1_800_000_000
  const files: Record<string, string> = {}
  files['/wb/tasks/fix-it/task.json'] = JSON.stringify({ name: 'fix-it', model: 'q27', model_label: 'Qwen 27B', created_at: ts })
  files['/wb/tasks/fix-it/status.json'] = JSON.stringify({ phase: 'running', round: 1, updated_at: ts })
  fakeTasks(on, files, ['fix-it'])
  let n = 0
  on('process.run', () => {
    n += 1  // the transcript grows every poll
    const lines = Array.from({ length: n }, (_, i) => ({ s: 'tool', t: `⏺ Read(f${i}.py)` }))
    return { value: { exitCode: 0, stdout: lines.map(l => JSON.stringify(l)).join('\n'), stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(1600)
  await clock.advance(1600)
  // (the kit has no pane to scroll, so following the end is checked in a real session)
  expect(await ui.find({ type: 'Text', text: /── fix-it/ })).toBeTruthy()
  await ui.unmount()
})

test('the transcript is read only while the pane is shown', async ($, on) => {
  // the 2026-11-16 audit: every session ran OpenCode exports back to back, pane open or not
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'running')
  const pane = fakeTasks(on, files)
  const watches: string[][] = []
  on('process.run', (_: any, e: any) => {
    if (e.argv[1] === 'watch') watches.push(e.argv)
    return { value: { exitCode: 0, stdout: JSON.stringify({ s: 'tool', t: '⏺ Read(f.py)' }), stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(watches.length).toBe(1)
  pane.show(false)                                              // the person closes it
  const before = watches.length
  await clock.advance(30_000)
  expect(watches.length).toBe(before)
  pane.show(true)
  await clock.advance(6000)
  expect(watches.length).toBeGreaterThan(before)
})

test('with two tasks running the pane keeps following the one it follows', async ($, on) => {
  // the 2026-11-16 audit: it swapped to whichever agent made the latest tool call
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'a', 'running')
  task(files, 'b', 'running')
  fakeTasks(on, files, ['a', 'b'])
  const watched: string[] = []
  on('process.run', (_: any, e: any) => {
    if (e.argv[1] === 'watch') watched.push(e.argv[2])
    return { value: { exitCode: 0, stdout: JSON.stringify({ s: 'tool', t: `⏺ ${e.argv[2]}` }), stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 1; i <= 8; i++) {                                // each agent's tool calls in turn
    task(files, i % 2 ? 'a' : 'b', 'running', {}, ts0 + i)
    await clock.advance(1600)
  }
  expect(new Set(watched).size).toBe(1)
  expect(watched.length).toBeGreaterThan(1)
})

test('a transcript cut at the engine\'s limit keeps the lines shown and says so', async ($, on) => {
  // the 2026-11-16 audit: the pane froze on old lines, with no hint why
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'running')
  fakeTasks(on, files)
  let cut = false
  on('process.run', () => ({
    value: { exitCode: 0, stdout: JSON.stringify({ s: 'tool', t: cut ? '⏺ OLD-START' : '⏺ Read(f.py)' }), stderr: '', isStdoutTruncated: cut },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  cut = true
  await clock.advance(6000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '⏺ Read(f.py)' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'transcript too long for the pane: wb watch fix-it' })).toBeTruthy()
  await ui.unmount()
})

test('one very long transcript line is cut, and the lines before it still show', async ($, on) => {
  // the 2026-11-16 audit: a heredoc command took the whole history budget alone
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'running')
  fakeTasks(on, files)
  const lines = [{ s: 'tool', t: '⏺ Read(early.py)' }, { s: 'tool', t: `⏺ Bash(cat > f <<'EOF' ${'x'.repeat(70_000)})` }]
  on('process.run', () => ({ value: { exitCode: 0, stdout: lines.map(l => JSON.stringify(l)).join('\n'), stderr: '' } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: '⏺ Read(early.py)' })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /^⏺ Bash\(cat/ }))?.text.length).toBeLessThanOrEqual(2000)
  await ui.unmount()
})

test('the weekly model check comes once, in a quiet moment of a session in use; /workbench-models asks now', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [], false)
  on('ui.toast', () => ({ value: undefined }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => {
    asked.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.skill.prompt({ skill: 'workbench', text: 'delegate', frontmatter: {}, source: 'userSettings' })  // workbench mode (#919)
  await clock.advance(3000)
  expect(asked.length).toBe(0)                       // nobody has used the session yet

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(2000)
  expect(asked.length).toBe(0)                       // not at once: Claude may have just asked something
  await clock.advance(90_000)                        // a quiet minute later
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('The weekly model check is due')
  expect(asked[0]).toContain('`wb scout`')
  // the audio engines too, licences first: they change (#398)
  expect(asked[0]).toContain('audio and image engines')
  expect(asked[0]).toContain('licence today against its licence text')
  expect(JSON.parse(files['/wb/scout.json']).offered_at).toBeGreaterThan(1_800_000_000)  // raised: not again today

  await clock.advance(10_000)
  expect(asked.length).toBe(1)

  // done this week: nothing more, until the user asks for it
  files['/wb/scout.json'] = JSON.stringify({ done_at: 1_800_000_010 })
  await $.command.run({ command: 'workbench-models', args: '' })
  await clock.advance(2000)
  expect(asked.length).toBe(2)
  expect(asked[1]).toContain('The weekly model check is due')
})

for (const [what, options, mode] of [['a session that never used workbench', {}, false],
  ['a session in workbench mode with wakes off', { wake: 'off' }, true]] as const) {
  test(`#919: the weekly model check never starts a turn in ${what}, and stays due for another`, { options }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_800_000_000_000 })
    const files: Record<string, string> = {}
    fakeTasks(on, files, [], false)
    on('ui.toast', () => ({ value: undefined }))
    on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: 'no open tasks', stderr: '' } }))
    on('prompt.context', (_: any, e: any) => ({ blocks: e.blocks }))
    const asked: string[] = []
    on('prompt.submit', (_: any, e: any) => { asked.push(e.text); return { text: e.text } })
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    if (mode) await $.skill.prompt({ skill: 'workbench', text: 'delegate', frontmatter: {}, source: 'userSettings' })
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.turn.complete(endTurn('t1'))
    await clock.advance(120_000)
    expect(asked.filter(t => t.includes('The weekly model check is due'))).toEqual([])
    expect(files['/wb/scout.json']).toBe(undefined)           // offered_at untouched: still due
  })
}

test('/workbench-models when the weekly check is due raises it once, not twice', async ($, on) => {
  // the 2026-11-16 audit: the weekly check followed at once, burying Claude's question to the user
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [], false)
  on('ui.toast', () => ({ value: undefined }))
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => { asked.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'workbench-models', args: '' })
  await clock.advance(2000)
  await $.turn.start({ text: 'the check', turnId: 't1' })
  await $.turn.complete(endTurn('t1'))                          // Claude asks "shall I pull it?"
  await clock.advance(120_000)
  expect(asked.filter(t => t.includes('The weekly model check is due'))).toHaveLength(1)
})

test('when wb can\'t run the mod says so once, backs off, and raises no model check', async ($, on) => {
  // the 2026-11-16 audit: `wb events` was respawned every 2 s for good, and nobody was told
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [], false, [], false)
  let spawns = 0
  on('process.spawn', async function* () { spawns += 1; throw new Error('spawn wb ENOENT') })
  on('process.run', () => { throw new Error('spawn wb ENOENT') })
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => { asked.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(endTurn('t1'))
  await clock.advance(120_000)
  expect(toasts.filter(t => t.includes("can't run `wb events`"))).toHaveLength(1)
  expect(spawns).toBeLessThan(10)                               // 2 s, 4 s, … up to a minute
  expect(asked).toEqual([])
})

test('an update is checked once a session is in use, and /workbench-update installs it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  fakeTasks(on, {}, [])
  let behind = 3
  const runs: string[][] = []
  const limits: Record<string, number> = {}
  on('process.run', (_: any, e: any) => {
    runs.push(e.argv)
    limits[e.argv.slice(1).join(' ')] = e.init?.timeoutMs
    if (e.argv[1] === 'optimize') return { value: { exitCode: 0, stdout: '', stderr: '' } }  // not due
    const said = e.argv[2] === '--check'
      ? (behind ? `update available: ${behind} new commit(s); /workbench-update (or wb update) installs it` : 'up to date')
      : behind ? 'updated marketplace 1111111..2222222 (3 commit(s))' : 'already up to date'
    return { value: { exitCode: 0, stdout: said, stderr: '' } }
  })
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(runs.some(r => r[1] === 'update')).toBe(false)          // nobody has used the session yet

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(2000)
  expect(runs.filter(r => r[1] === 'update')).toEqual([['wb', 'update', '--check', '--if-due']])  // wb keeps it weekly
  expect(toasts.at(-1)).toContain('/workbench-update')
  await clock.advance(5000)
  expect(runs.filter(r => r[1] === 'update').length).toBe(1)     // once per load
  expect(runs.filter(r => r[1] === 'optimize')).toEqual([['wb', 'optimize', 'start', '--if-due']])
  expect(toasts.some(t => t.includes('measuring'))).toBe(false)  // not due: nothing said

  const out = await $.command.run({ command: 'workbench-update', args: '' })
  expect(runs.at(-1)).toEqual(['wb', 'update'])
  expect(limits.update).toBe(600_000)                            // its steps take up to 300 s each
  expect(out.text).toContain('updated marketplace')
  behind = 0
  expect((await $.command.run({ command: 'workbench-update', args: '' })).text).toContain('already up to date')
})

test('a reply to a pair of screenshots reaches Claude with its task and step (#99)', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  chatOn(files)                                                   // the user turned the web chat on
  on('ui.toast', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/home/u/project' }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'no open tasks', stderr: '' } }))
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => { asked.push(e.text); return { text: e.text } })
  files['/wb/chat/messages.jsonl'] = JSON.stringify({ id: 'm1', ts: 1_800_000_000, from: 'user', text: 'the button moved',
    about: { task: 'fix-nav', n: 2, step: 1, round: 3 } }) + '\n'
  await $.session.start({ cwd: '/home/u/project', surface: 'terminal', isInteractive: true })
  await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })
  await clock.advance(3000)
  // the task and step the screenshots were of, whichever task is active now
  expect(asked).toEqual(['[web chat] (about fix-nav, step 1, screenshots 2) the button moved'])
})

test('a take the user keeps from the shortlist reaches Claude with its number and path (#397)', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  chatOn(files)
  on('ui.toast', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/home/u/project' }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'no open tasks', stderr: '' } }))
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => { asked.push(e.text); return { text: e.text } })
  files['/wb/chat/messages.jsonl'] = JSON.stringify({ id: 'm1', ts: 1_800_000_000, from: 'user', text: 'Keep take 2: door-2.wav',
    about: { audio: '1800000000000-abcdef', n: 2, name: 'door-2.wav', path: '/home/u/project/o/door-2.wav' } }) + '\n'
  await $.session.start({ cwd: '/home/u/project', surface: 'terminal', isInteractive: true })
  await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })
  await clock.advance(3000)
  expect(asked).toEqual(['[web chat] (keeps take 2 of the shortlist: /home/u/project/o/door-2.wav) Keep take 2: door-2.wav'])
})

test('the web chat reaches Claude only in /workbench mode, with a receipt, and one session listens', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  chatOn(files)                                                   // the user turned the web chat on
  on('ui.toast', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/home/u/project' }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))  // the engine's expansion
  const runs: string[][] = []
  on('process.run', (_: any, e: any) => {
    runs.push(e.argv)
    if (e.argv[1] === 'chat' && e.argv[2] === 'ack') {
      files['/wb/chat/receipts.jsonl'] = (files['/wb/chat/receipts.jsonl'] ?? '') +
        JSON.stringify({ id: e.argv[3], by: e.argv[5] }) + '\n'
    }
    return { value: { exitCode: 0, stdout: 'no open tasks', stderr: '' } }
  })
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => {
    asked.push(e.text)
    return { text: e.text }
  })
  files['/wb/chat/messages.jsonl'] = JSON.stringify({ id: 'm1', ts: 1_800_000_000, from: 'user', text: 'status?' }) + '\n'
  await $.session.start({ cwd: '/home/u/project', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(asked.length).toBe(0)                                   // not in workbench mode: nobody listens
  expect(files['/wb/chat/listener.json']).toBeUndefined()

  await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })
  await clock.advance(3000)
  expect(asked.length).toBe(1)
  expect(asked[0]).toBe('[web chat] status?')                    // their words, nothing else
  expect(JSON.parse(files['/wb/chat/listener.json']).cwd).toBe('/home/u/project')
  expect(runs.some(a => a.join(' ').startsWith('wb chat ack m1'))).toBe(true)
  await clock.advance(3000)
  expect(asked.length).toBe(1)                                   // once

  // another session holds the chat: this one stands by
  files['/wb/chat/listener.json'] = JSON.stringify({ session: 'other', cwd: '/x', ts: 1_800_000_009 })
  files['/wb/chat/messages.jsonl'] += JSON.stringify({ id: 'm2', ts: 1_800_000_009, from: 'user', text: 'hi' }) + '\n'
  await clock.advance(2000)
  expect(asked.length).toBe(1)

  // #532: its pid is live, but under a process that started after the claim: nobody listens there
  files['/proc/777/stat'] = `777 (sleep) S 1 ${'0 '.repeat(17)}5000 0 0`
  files['/wb/chat/listener.json'] = JSON.stringify({ session: 'other', cwd: '/x', pid: 777, start: '1000' })
  await clock.advance(31_000)
  expect(asked.at(-1)).toBe('[web chat] hi')                     // this session took the chat

  // /workbench-quit ends workbench mode, and with it the listening
  await $.command.run({ command: 'workbench-quit', args: '' })
  await clock.advance(20_000)
  expect(asked.length).toBe(2)
})

test('a web message wb holds open is delivered past the files tails, and one wb calls expired is named once', async ($, on) => {
  // #329: an unread message behind 4 MiB of replies fell out of the tail the mod read. #536: the
  // expiry is wb's (wb chat claim refuses it), the one the page shows, not the mod's own clock
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  chatOn(files)
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => { toasts.push(String(e.text ?? e.message ?? JSON.stringify(e))); return { value: undefined } })
  on('session.cwd', () => ({ value: '/home/u/project' }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  const claims: string[] = []
  on('process.run', (_: any, e: any) => {
    if (e.argv[1] === 'chat' && e.argv[2] === 'claim') {
      claims.push(e.argv[3])
      if (e.argv[3] === 'm0') return { value: { exitCode: 1, stdout: '', stderr:
        'wb: m0 expired: over 6 hours unread, so not passed to Claude; the page offers to send it again\n' } }
    }
    return { value: { exitCode: 0, stdout: 'no open tasks', stderr: '' } }
  })
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => {
    asked.push(e.text)
    return { text: e.text }
  })
  files['/wb/chat/messages.jsonl'] = JSON.stringify({ id: 'r1', ts: 1_800_000_000, from: 'claude', text: 'x' }) + '\n'
  files['/wb/chat/open.json'] = JSON.stringify({ asks: {}, messages: {
    m1: { id: 'm1', ts: 1_800_000_000, from: 'user', text: 'are you there?' },
    m0: { id: 'm0', ts: 1_800_000_000 - 7 * 3600, from: 'user', text: 'from this morning' } } })
  await $.session.start({ cwd: '/home/u/project', surface: 'terminal', isInteractive: true })
  await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })
  await clock.advance(3000)
  expect(asked).toEqual(['[web chat] are you there?'])              // only in wb's index: delivered
  const named = () => toasts.filter(t => t.includes('a web chat message expired: over 6 hours unread')).length
  expect(named()).toBe(1)                                           // the old one, named once
  await clock.advance(3000)
  expect([named(), claims.filter(c => c === 'm0').length, asked.length]).toEqual([1, 1, 1])  // and not asked again
})

test('a web message another session claimed first is not submitted here', async ($, on) => {
  // #84: two sessions starting together both took the chat and both submitted the message
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  chatOn(files)                                                   // the user turned the web chat on
  on('ui.toast', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/home/u/project' }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  let theirs = true
  on('process.run', (_: any, e: any) => {
    const refused = e.argv[1] === 'chat' && e.argv[2] === 'claim' && theirs
    return { value: { exitCode: refused ? 1 : 0, stdout: refused ? '' : 'no open tasks', stderr: '' } }
  })
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => {
    asked.push(e.text)
    return { text: e.text }
  })
  files['/wb/chat/messages.jsonl'] = JSON.stringify({ id: 'm1', ts: 1_800_000_000, from: 'user', text: 'status?' }) + '\n'
  await $.session.start({ cwd: '/home/u/project', surface: 'terminal', isInteractive: true })
  await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })
  await clock.advance(3000)
  expect(asked.length).toBe(0)                                   // the other session submits it
  theirs = false                                                 // gone, its claim stale
  await clock.advance(61_000)
  expect(asked).toEqual(['[web chat] status?'])
})

test('a permission prompt while the user is away goes to the web chat, and their answer settles it', async ($, on) => {
  // the dialog would wait for nobody (the user, 2026-11-18)
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  chatOn(files)                                                   // the user turned the web chat on
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('session.cwd', () => ({ value: '/home/u/project' }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  let said: any = { answer: 'allow' }, posted = 'ask-1-ab open'
  const runs: string[][] = []
  on('process.run', (_: any, e: any) => {
    runs.push(e.argv)
    const [, cmd, act] = e.argv
    if (cmd === 'chat' && act === 'ask') return { value: { exitCode: 0, stdout: posted + '\n', stderr: '' } }
    if (cmd === 'chat' && act === 'wait') return { value: { exitCode: said ? 0 : 1, stdout: JSON.stringify(said), stderr: '' } }
    return { value: { exitCode: 0, stdout: 'no open tasks', stderr: '' } }
  })
  on('classic.PermissionRequest', () => ({}))                 // no settings hook decides: the dialog
  const ask = (tool_name: string, tool_input: unknown) =>
    $.classic.PermissionRequest({ tool_name, tool_input } as any) as Promise<any>
  await $.session.start({ cwd: '/home/u/project', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect((await ask('Bash', { command: 'git push' })).decision).toBeUndefined()  // at the terminal: the dialog
  expect(runs.some(a => a[2] === 'ask')).toBe(false)

  await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })
  files['/wb/chat/messages.jsonl'] = JSON.stringify({ id: 'm1', ts: 1_800_000_003, from: 'user', text: 'hi' }) + '\n'
  await clock.advance(3000)                                     // a web message: the user is away
  expect((await ask('Bash', { command: 'git push origin main', description: 'Push the fix' })).decision).toEqual({ behavior: 'allow' })
  expect(runs.find(a => a[2] === 'ask')).toEqual(['wb', 'chat', 'ask', '--tool=Bash', '--kind=permission',
    '--text=git push origin main', '--pid=4242', '--detail={"purpose":"Push the fix"}'])  // the card leads with it (#103);
  // the pid is this session's `wb events`: once it's gone wb expires the ask (#538)
  expect(runs.find(a => a[2] === 'wait')?.slice(0, 4)).toEqual(['wb', 'chat', 'wait', 'ask-1-ab'])
  expect(toasts.some(t => t.includes('waiting for you in the web chat'))).toBe(true)

  said = { answer: 'deny', note: 'not on main' }
  const no = (await ask('Write', { file_path: '/etc/hosts', content: 'x' })).decision
  expect(no.behavior).toBe('deny')
  expect(no.message).toContain('wb chat reply')                  // Claude asks the user what instead
  expect(no.message).toContain('not on main')                    // with their words
  expect(runs.filter(a => a[2] === 'ask').at(-1)).toContain('--text=/etc/hosts')

  // a finished plan: approved, or sent back with a note
  said = { answer: 'allow' }
  expect((await ask('ExitPlanMode', {})).decision).toEqual({ behavior: 'allow' })
  expect(runs.filter(a => a[2] === 'ask').at(-1)?.slice(3, 5)).toEqual(['--tool=ExitPlanMode', '--kind=plan'])
  said = { answer: 'deny', note: 'split step 2' }
  const back = (await ask('ExitPlanMode', {})).decision
  expect([back.behavior, back.message.includes('split step 2'), back.message.includes('Revise the plan')]).toEqual(['deny', true, true])
  // #253 (the audit of 1.2): the card is this session's plan, by its file, never the newest of any
  // project's; one wb can't read is answered in the terminal, so the dialog comes up there
  said = { answer: 'allow' }
  await ask('ExitPlanMode', { planFilePath: '/home/u/.claude/plans/a-b-c.md' })
  const plan = runs.filter(a => a[2] === 'ask').at(-1)!
  expect(plan.find(a => a.startsWith('--detail='))).toBe('--detail={"plan_file":"/home/u/.claude/plans/a-b-c.md"}')
  expect(plan.slice(-2)).toEqual(['--repo', '/home/u/project'])     // whose plan it is
  posted = 'ask-3-ef expired'
  const waited = runs.filter(a => a[2] === 'wait').length
  expect((await ask('ExitPlanMode', {})).decision).toBeUndefined()
  expect(runs.filter(a => a[2] === 'wait').length).toBe(waited)    // nothing to wait for on the page
  posted = 'ask-1-ab open'

  // a question: the options they picked become the tool's answers
  const questions = [{ question: 'Which DB?', header: 'DB', options: [{ label: 'SQLite', description: '' }, { label: 'Postgres', description: '' }], multiSelect: false }]
  said = { answer: 'allow', answers: { 'Which DB?': 'SQLite' } }
  const picked = (await ask('AskUserQuestion', { questions })).decision
  expect(picked).toEqual({ behavior: 'allow', updatedInput: { questions, answers: { 'Which DB?': 'SQLite' } } })
  expect(JSON.parse(runs.filter(a => a[2] === 'ask').at(-1)!.at(-1)!.slice('--detail='.length))).toEqual({ questions })

  // their setting says go ahead while away: allowed at once, no wait, no toast
  posted = 'ask-2-cd allow'
  const [waits, toastsBefore] = [runs.filter(a => a[2] === 'wait').length, toasts.length]
  expect((await ask('Bash', { command: 'make' })).decision).toEqual({ behavior: 'allow' })
  expect([runs.filter(a => a[2] === 'wait').length, toasts.length]).toEqual([waits, toastsBefore])
  posted = 'ask-1-ab open'

  said = ''                                                     // wb can't wait: it expires, the dialog comes
  expect((await ask('Bash', { command: 'rm -rf build' })).decision).toBeUndefined()
  expect(runs.at(-1)).toEqual(['wb', 'chat', 'answer', 'ask-1-ab', 'expired', '--by', 'timeout'])

  await $.prompt.submit({ text: 'back now' } as any)            // typed in the terminal: back
  const n = runs.length
  said = { answer: 'allow' }
  expect((await ask('Bash', { command: 'git push' })).decision).toBeUndefined()
  expect(runs.slice(n).some(a => a[2] === 'ask')).toBe(false)
})

test('a session that isn\'t listening treats the user as away too, relaying its dialogs and saying so in its wakes (#688)', async ($, on) => {
  // #688: only the listening session set its own `webAt`, so another session's overnight backlog
  // left its permission dialogs in the empty terminal (#110 again) and its wakes never said
  // to answer in the chat
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'review', { repo: '/home/u/project', cwd: '/home/u/project' })
  fakeTasks(on, files)
  chatOn(files)
  files['/wb/chat/listener.json'] = JSON.stringify({ session: 'other-key', pid: 777, start: '1' }) // another session listens
  files['/proc/777/stat'] = `777 (wb) S 1 ${'0 '.repeat(17)}1 0 0`
  on('ui.toast', () => ({ value: undefined }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  const woken: string[] = []
  on('prompt.submit', (_: any, e: any) => { woken.push(e.text); return { text: e.text } })
  const runs: string[][] = []
  on('process.run', (_: any, e: any) => {
    runs.push(e.argv)
    const [, cmd, act] = e.argv
    if (cmd === 'chat' && act === 'ask') return { value: { exitCode: 0, stdout: 'ask-1-ab open\n', stderr: '' } }
    if (cmd === 'chat' && act === 'wait') return { value: { exitCode: 0, stdout: JSON.stringify({ answer: 'allow' }), stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('classic.PermissionRequest', () => ({}))
  const ask = (tool_name: string, tool_input: unknown) =>
    $.classic.PermissionRequest({ tool_name, tool_input } as any) as Promise<any>
  await $.session.start({ cwd: '/home/u/project', surface: 'terminal', isInteractive: true })
  await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })
  await clock.advance(3000)
  expect(files['/wb/chat/listener.json']).toContain('other-key')   // still the other's
  files['/wb/chat/away.json'] = JSON.stringify({ at: 1_800_000_000, by: 'other-key' }) // it took a web message
  expect((await ask('Bash', { command: 'git push' })).decision).toEqual({ behavior: 'allow' })
  expect(runs.some(a => a[2] === 'ask')).toBe(true)
  notice(files, { ts: ts0 + 5, task: 'fix-it', kind: 'review', text: 'REPORT-fix-it' })
  await clock.advance(31_000)                                   // the safety poll reads it
  expect(woken.find(t => t.includes('REPORT-fix-it'))).toContain('wb chat reply')  // AWAY_NOTE
  await $.prompt.submit({ text: 'back now' } as any)             // typed here: back, for every session
  expect(JSON.parse(files['/wb/chat/away.json']).at).toBe(0)
  const n = runs.length
  expect((await ask('Bash', { command: 'git push' })).decision).toBeUndefined()
  expect(runs.slice(n).some(a => a[2] === 'ask')).toBe(false)
})

test('a dialog wb chat ask refuses is announced on the phone, and a long plan or preview is cut to fit', async ($, on) => {
  // #535 (the 2026-11-20 audit): a long or CJK plan was refused, and the dialog sat in the
  // terminal with nothing posted and nothing said
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  chatOn(files)
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('session.cwd', () => ({ value: '/home/u/project' }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  let refuse = true
  const runs: string[][] = []
  on('process.run', (_: any, e: any) => {
    runs.push(e.argv)
    const [, cmd, act] = e.argv
    if (cmd === 'chat' && act === 'ask') return { value: refuse
      ? { exitCode: 1, stdout: '', stderr: 'wb: wb chat ask: detail too long\n' }
      : { exitCode: 0, stdout: 'ask-1-ab open\n', stderr: '' } }
    if (cmd === 'chat' && act === 'wait') return { value: { exitCode: 0, stdout: JSON.stringify({ answer: 'deny' }), stderr: '' } }
    return { value: { exitCode: 0, stdout: 'no open tasks', stderr: '' } }
  })
  on('classic.PermissionRequest', () => ({}))
  const ask = (tool_name: string, tool_input: unknown) =>
    $.classic.PermissionRequest({ tool_name, tool_input } as any) as Promise<any>
  await $.session.start({ cwd: '/home/u/project', surface: 'terminal', isInteractive: true })
  await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })
  files['/wb/chat/messages.jsonl'] = JSON.stringify({ id: 'm1', ts: 1_800_000_003, from: 'user', text: 'hi' }) + '\n'
  await clock.advance(3000)                                     // a web message: the user is away
  const plan = '計画'.repeat(30_000)
  expect((await ask('ExitPlanMode', { plan })).decision).toBeUndefined()  // refused: the dialog, here
  const sent = runs.filter(a => a[2] === 'ask').at(-1)!
  expect(JSON.parse(sent.find(a => a.startsWith('--detail='))!.slice(9)).plan).toBe(plan.slice(0, 40_001))
  expect(runs.find(a => a[2] === 'reply')).toEqual(['wb', 'chat', 'reply',
    "--text=Claude is waiting on a plan in the terminal: it couldn't be shown here."])
  expect(toasts.some(t => t.includes("a plan couldn't go to the web chat (wb: wb chat ask: detail too long)"))).toBe(true)
  refuse = false
  const long = { label: 'A', description: '', preview: 'p'.repeat(5000) }
  await ask('AskUserQuestion', { questions: [{ question: 'Which?', options: [long, { label: 'B' }] }] })
  const q = JSON.parse(runs.filter(a => a[2] === 'ask').at(-1)!.at(-1)!.slice(9))
  expect(q.questions[0].options[0].preview).toBe('p'.repeat(2000) + ' (cut: the rest is in the terminal)')
  expect(q.questions[0].options[1]).toEqual({ label: 'B' })
  await ask('Bash', { command: '--version' })                   // a value that starts with `-`
  expect(runs.filter(a => a[2] === 'ask').at(-1)).toContain('--text=--version')
})

test('a task\'s wake while the user is away on the web chat tells Claude to answer them there, and stops once they type in the terminal (#540)', async ($, on) => {
  // the web-chat block comes once per conversation: a user who went to the web chat after the
  // first message was never said to be away, and a task's news reached only the terminal
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files)
  chatOn(files)
  task(files, 'fix-it', 'running', { repo: '/home/u/project', cwd: '/home/u/project' })
  on('ui.toast', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/home/u/project' }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'no open tasks', stderr: '' } }))
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => { asked.push(e.text); return { text: e.text } })
  const wakes = () => asked.filter(t => t.startsWith('[workbench] Task'))
  await $.session.start({ cwd: '/home/u/project', surface: 'terminal', isInteractive: true })
  await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })
  await clock.advance(3000)
  files['/wb/chat/messages.jsonl'] = JSON.stringify({ id: 'm1', ts: ts0 + 3, from: 'user', text: 'on my phone' }) + '\n'
  await clock.advance(3000)
  expect(asked).toContain('[web chat] on my phone')            // the user is away now

  task(files, 'fix-it', 'review', { repo: '/home/u/project', cwd: '/home/u/project' }, ts0 + 6)
  notice(files, { ts: ts0 + 6, task: 'fix-it', kind: 'review', text: 'REPORT-1' })
  await clock.advance(3000)
  expect(wakes()).toHaveLength(1)
  expect(wakes()[0]).toContain('REPORT-1')
  expect(wakes()[0]).toContain('last wrote from the web chat')
  expect(wakes()[0]).toContain('wb chat reply')

  await $.prompt.submit({ text: 'back now' } as any)            // typed in the terminal: back
  notice(files, { ts: ts0 + 12, task: 'fix-it', kind: 'review', text: 'REPORT-2' })
  await clock.advance(31_000)                                   // nothing runs: the safety poll reads it
  expect(wakes()).toHaveLength(2)
  expect(wakes()[1]).toContain('REPORT-2')
  expect(wakes()[1]).not.toContain('web chat')
})

test('running wb counts as workbench mode, and a web message reaches a running turn', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  chatOn(files)                                                   // the user turned the web chat on
  on('ui.toast', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/home/u/project' }))
  on('session.id', () => ({ value: 'sess-1' }))
  const sent: any[] = []
  on('session.send', (_: any, e: any) => { sent.push(e); return { isDelivered: true } })
  const runs: string[][] = []
  on('process.run', (_: any, e: any) => { runs.push(e.argv); return { value: { exitCode: 0, stdout: 'no open tasks', stderr: '' } } })
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => { asked.push(e.text); return { text: e.text } })
  on('tool.call', (_: any, e: any) => ({ result: { stdout: '' }, text: '' }))  // the engine's Bash
  files['/wb/chat/messages.jsonl'] = JSON.stringify({ id: 'm1', ts: 1_800_000_000, from: 'user', text: 'still there?' }) + '\n'
  await $.session.start({ cwd: '/home/u/project', surface: 'terminal', isInteractive: true })
  // no turn.start: the module loaded mid-turn; the tool call itself says a turn runs
  await $.tool.call({ tool: 'Bash', command: 'cd ~ && wb start step-2 --spec s.md --repo .' })
  await clock.advance(3000)
  expect(asked).toEqual([])                                     // mid-turn: not a queued prompt…
  expect(sent.length).toBe(1)                                   // …but into the running turn
  expect(sent[0].to).toBe('sess-1')                              // its own session
  expect(sent[0].text).toContain('[web chat] still there?')
  expect(sent[0].text).toContain('wb chat reply')               // framed as a peer's: one line says whose
  expect(runs.some(a => a.join(' ') === 'wb chat ack m1 --by ' + a[5] + ' --how now')).toBe(true)
})

test('a web message queued behind a running turn reads as read once that turn ends', async ($, on) => {
  // 2026-11-21: three messages Claude had read and acted on said "Queued for Claude" on the phone for good
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  chatOn(files)
  on('ui.toast', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/home/u/project' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.send', () => ({ isDelivered: false, reason: 'busy' }))  // refused: a queued prompt instead
  const runs: string[] = []
  on('process.run', (_: any, e: any) => { runs.push(e.argv.join(' ')); return { value: { exitCode: 0, stdout: 'no open tasks', stderr: '' } } })
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => { asked.push(e.text); return { text: e.text } })
  on('tool.call', () => ({ result: { stdout: '' }, text: '' }))  // the engine's Bash
  await $.session.start({ cwd: '/home/u/project', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'a long review', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'wb start t --spec s.md' })  // workbench mode: the chat listens
  files['/wb/chat/messages.jsonl'] = JSON.stringify({ id: 'm1', ts: 1_800_000_000, from: 'user', text: 'status?' }) + '\n'
  await clock.advance(3000)
  expect(asked.some(a => a.startsWith('[web chat] status?'))).toBe(true)
  const acks = () => runs.filter(r => r.includes('chat ack m1'))
  expect(acks().length).toBe(1)
  expect(acks()[0]).toMatch(/--how queued$/)
  await $.turn.complete(endTurn('t1'))
  await clock.advance(3000)
  expect(acks().length).toBe(2)
  expect(acks()[1]).toMatch(/--how now$/)                          // the page's "Read by Claude"
  expect(acks()[1].split(' --by ')[1]).toBe(acks()[0].split(' --by ')[1].replace(/ --how queued$/, ' --how now'))
  await $.turn.start({ text: 'next', turnId: 't2' })
  await $.turn.complete(endTurn('t2'))
  await clock.advance(3000)
  expect(acks().length).toBe(2)                                    // once
})

test('a web message the turn didn\'t answer in the chat gets one follow-up, then a note on the phone (#767)', async ($, on) => {
  // #767: Claude answered "Status" from the phone in the terminal only, release after release,
  // and the phone heard nothing
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  chatOn(files)
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  const runs: string[][] = []
  on('process.run', (_: any, e: any) => { runs.push(e.argv); return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => { asked.push(e.text); return { text: e.text } })
  on('tool.call', () => ({ result: { stdout: '' }, text: '' }))  // the engine's Bash
  const posted = () => runs.filter(r => r[1] === 'chat' && r[2] === 'reply')
  const followUps = () => asked.filter(a => a.includes("hasn't heard back"))
  await $.session.start({ cwd: '/home/u/project', surface: 'terminal', isInteractive: true })
  const say = async (id: string, text: string, ts: number) => {
    files['/wb/chat/messages.jsonl'] = (files['/wb/chat/messages.jsonl'] ?? '') + JSON.stringify({ id, ts, from: 'user', text }) + '\n'
    await clock.advance(31_000)
  }
  const turn = async (id: string, command?: string) => {
    await $.turn.start({ text: '', turnId: id })
    if (command) await $.tool.call({ tool: 'Bash', command })
    await $.turn.complete(endTurn(id))
    await clock.advance(3000)
  }
  await turn('t0', 'wb start t --spec s.md')                     // workbench mode: the chat listens
  await say('m1', 'Status', 1_800_000_000)
  expect(asked.filter(a => a.startsWith('[web chat] Status'))).toHaveLength(1)
  await turn('t1')                                               // answered in the terminal only
  expect(followUps()).toHaveLength(1)
  expect(followUps()[0]).toContain('wb chat reply --text')
  await turn('t2')                                               // the follow-up's turn: no reply either
  expect(posted()).toEqual([['wb', 'chat', 'reply', '--text=Claude answered in the terminal; nothing was sent here.']])
  await turn('t3')
  expect([followUps().length, posted().length]).toEqual([1, 1])  // once per message

  await say('m2', 'And now?', 1_800_000_100)
  await turn('t4', 'wb chat reply --text "Two tasks run; done by six."')
  await turn('t5')
  expect([followUps().length, posted().length]).toEqual([1, 1])  // answered there: no follow-up, no note
})

test('a web message queued behind a task\'s wake is owed from its own turn, not the wake\'s (#837)', async ($, on) => {
  // #837: the wake and the web message went in one poll; the wake's turn ended without a reply
  // (Claude hadn't seen the message yet), so a follow-up went for a message Claude then answered
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'review', { repo: '/home/u/project', cwd: '/home/u/project', session: 'sess-1' })
  fakeTasks(on, files)
  chatOn(files)
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => { asked.push(e.text); return { text: e.text } })
  on('tool.call', () => ({ result: { stdout: '' }, text: '' }))  // the engine's Bash
  const followUps = () => asked.filter(a => a.includes("hasn't heard back"))
  await $.session.start({ cwd: '/home/u/project', surface: 'terminal', isInteractive: true })
  const turn = async (id: string, command?: string) => {
    await $.turn.start({ text: '', turnId: id })
    if (command) await $.tool.call({ tool: 'Bash', command })
    await $.turn.complete(endTurn(id))
    await clock.advance(3000)
  }
  await turn('t0', 'wb start t --spec s.md')                     // workbench mode: the chat listens
  notice(files, { ts: ts0 + 40, task: 'fix-it', kind: 'review', text: 'REPORT-fix-it' })
  files['/wb/chat/messages.jsonl'] = JSON.stringify({ id: 'm1', ts: ts0 + 40, from: 'user', text: 'Status' }) + '\n'
  await clock.advance(31_000)                                    // one poll: the wake, then the message
  const at = (needle: string) => asked.findIndex(a => a.includes(needle))
  expect(at('REPORT-fix-it')).toBeGreaterThanOrEqual(0)
  expect(at('[web chat] Status')).toBeGreaterThan(at('REPORT-fix-it'))
  await turn('t1')                                               // the wake's turn: no reply yet
  await turn('t2', 'wb chat reply --text "One task in review."') // the message's turn answers it
  await turn('t3')
  expect(followUps()).toHaveLength(0)
})

test('a follow-up the engine dropped is not sent again once Claude answered in the chat (#837)', async ($, on) => {
  // #837: only chatOwed was cleared on a reply; OWED_NOTE stayed in the queue and went anyway
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  chatOn(files)
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  const asked: string[] = []
  let drop = true
  on('prompt.submit', (_: any, e: any) => {
    asked.push(e.text)
    if (drop && e.text.includes("hasn't heard back")) { drop = false; return { drop: 'a settings hook' } }
    return { text: e.text }
  })
  on('tool.call', () => ({ result: { stdout: '' }, text: '' }))  // the engine's Bash
  const followUps = () => asked.filter(a => a.includes("hasn't heard back"))
  await $.session.start({ cwd: '/home/u/project', surface: 'terminal', isInteractive: true })
  const turn = async (id: string, command?: string) => {
    await $.turn.start({ text: '', turnId: id })
    if (command) await $.tool.call({ tool: 'Bash', command })
    await $.turn.complete(endTurn(id))
    await clock.advance(3000)
  }
  await turn('t0', 'wb start t --spec s.md')
  files['/wb/chat/messages.jsonl'] = JSON.stringify({ id: 'm1', ts: 1_800_000_000, from: 'user', text: 'Status' }) + '\n'
  await clock.advance(31_000)
  await turn('t1')                                               // answered in the terminal only
  expect(followUps()).toHaveLength(1)                            // tried, and dropped
  await turn('t2', 'wb chat reply --text "All quiet."')          // then answered there after all
  await clock.advance(61_000)                                    // past the retry
  expect(followUps()).toHaveLength(1)
})

test('a /loop firing, another plugin\'s prompt or a channel message leaves the user away and the follow-up owed; the user\'s Enter ends it (#835)', async ($, on) => {
  // #835: any prompt that wasn't isMeta counted as the user back at the terminal, so a /loop
  // firing ended away for every session and cancelled the #767 follow-up
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  chatOn(files)
  on('ui.toast', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => { asked.push(e.text); return { text: e.text } })
  on('tool.call', () => ({ result: { stdout: '' }, text: '' }))  // the engine's Bash
  const followUps = () => asked.filter(a => a.includes("hasn't heard back"))
  const awayAt = () => JSON.parse(files['/wb/chat/away.json'] ?? '{"at": 0}').at
  await $.session.start({ cwd: '/home/u/project', surface: 'terminal', isInteractive: true })
  const turn = async (id: string, command?: string) => {
    await $.turn.start({ text: '', turnId: id })
    if (command) await $.tool.call({ tool: 'Bash', command })
    await $.turn.complete(endTurn(id))
    await clock.advance(3000)
  }
  await turn('t0', 'wb start t --spec s.md')                     // workbench mode: the chat listens
  files['/wb/chat/messages.jsonl'] = JSON.stringify({ id: 'm1', ts: 1_800_000_000, from: 'user', text: 'Status' }) + '\n'
  await clock.advance(31_000)
  expect(asked.filter(a => a.startsWith('[web chat] Status'))).toHaveLength(1)
  expect(awayAt()).toBeGreaterThan(0)
  for (const origin of [{ kind: 'scheduled-trigger' }, { kind: 'plugin', name: 'other' }, { kind: 'channel', server: 'slack' },
    { kind: 'peer' }, { kind: 'task-notification' }])
    await $.prompt.submit({ text: 'check on the tasks', origin } as any)
  expect(awayAt()).toBeGreaterThan(0)                            // still away
  await turn('t1')                                               // answered in the terminal only
  expect(followUps()).toHaveLength(1)                            // the follow-up still comes
  await $.prompt.submit({ text: 'back now', origin: { kind: 'composer' } } as any)
  expect(awayAt()).toBe(0)                                       // the user's own Enter: back
})

test('only wb run as a command counts as delegating, read as bash reads it, not wb written in a string, a heredoc or a comment (#409, #560)', () => {
  // 2026-11-20: a Python patch whose string held "split it (wb next)" turned workbench mode on
  for (const run of ['wb start t --spec s.md', 'cd ~ && wb start step-2 --spec s.md --repo .', 'wb next t',
    'git add -A; wb feedback t --text x', 'true || wb steer t "go"', 'WB_HOME=/x wb answer t q1 yes',
    'env WB_HOME=/x wb next t', '~/repos/workbench/bin/wb start t', 'out=$(wb start t --spec s.md)',
    'cat <<EOF > s.md\nwrite it\nEOF\nwb start t --spec s.md', '(cd repo; wb next t)',
    // #560: each checked against bash running a marker wb
    '"/home/u/repos/workbench/bin/wb" start t', "'wb' start t", '"/mnt/c/Users/A B/wb" next t',
    'if wb start t --spec s; then echo ok; fi', 'while ! wb answer t "x"; do sleep 1; done', '! wb start t',
    'echo "$(wb start t)"', 'echo "`wb next t`"', 'until wb steer t --text go; do :; done',
    'if true; then wb next t; fi', '{ wb start t; }', 'wb resume t', 'timeout 60 wb start t',
    'timeout -s KILL 5m wb start t', 'nice -n 5 wb start t', 'stdbuf -oL wb next t', 'ionice -c 3 wb next t',
    'env -u X WB_HOME=/x wb next t', 'cat <<< hello; wb start t',
    'wb \\\nstart t', 'cat <<EOF\n$(wb start t)\nEOF', "python3 - <<'EOF'\nx = 1\nEOF\nwb next t", 'cat <<"X" | sort\nwb start t\nX\nwb next t'])
    expect([run, delegates(run)]).toEqual([run, true])
  for (const data of ['python3 - <<\'EOF\'\ns = "split it (wb next) or take it over"\nEOF',
    'python3 -c "print(\'(wb next)\')"', 'git commit -m "wb start now records the session"',
    'grep -n "wb (start|next)" ARCHITECTURE.md', 'echo done # then wb next t', "echo 'wb answer t q1'",
    'wb status', 'wb accept t', 'cat <<-X\n\twb start t\n\tX', 'awb next t', 'wb nextstep',
    // #560: bash runs only echo, which prints "foo ; wb start t"
    'echo foo \\; wb start t', 'echo foo \\& wb start t', 'echo a \\| wb next t', '"wb start" t',
    "echo 'it ran $(wb start t)'", 'echo x # "$(wb start t)"', "cat <<'EOF'\n$(wb start t)\nEOF",
    'cat <<< "wb start t"', 'echo wb start t', 'if grep -q x f; then echo wb next; fi'])
    expect([data, delegates(data)]).toEqual([data, false])
})

test('a heredoc that mentions wb leaves workbench mode off; running it turns it on (#409)', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  const ui: string[] = []
  fakeTasks(on, files, [], true, ui)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('tool.call', () => ({ result: { stdout: '' }, text: '' }))  // the engine's Bash
  await $.session.start({ cwd: '/home/u/project', surface: 'terminal', isInteractive: true })
  const mode = async () => ui.includes('status ⚒ wb · workbench mode')   // the mode's sign on the status line
  await $.tool.call({ tool: 'Bash', command: 'python3 - <<\'EOF\'\nmsg = "split it (wb next) or take it over"\nEOF' })
  await clock.advance(1000)
  expect(await mode()).toBe(false)
  expect(ui).not.toContain('open workbench')
  await $.tool.call({ tool: 'Bash', command: 'cd ~ && wb next t' })
  await clock.advance(1000)
  expect(await mode()).toBe(true)
})

test('a task left waiting with no notice reaching Claude wakes it anyway, once', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const ts = 1_800_000_000 - 600  // failed ten minutes ago
  const files: Record<string, string> = {
    '/wb/tasks/lost/task.json': JSON.stringify({ name: 'lost', model: 'm', created_at: ts - 60 }),
    '/wb/tasks/lost/status.json': JSON.stringify({ phase: 'failed', round: 3, updated_at: ts }),
    '/wb/tasks/lost/acked': String(ts - 1),             // a note ran just before the failure
    '/wb/tasks/seen/task.json': JSON.stringify({ name: 'seen', model: 'm', created_at: ts - 60 }),
    '/wb/tasks/seen/status.json': JSON.stringify({ phase: 'review', round: 1, updated_at: ts }),
    '/wb/tasks/seen/acked': String(ts),                 // Claude had this one
  }
  fakeTasks(on, files, ['lost', 'seen'])
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => { asked.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(asked.filter(t => t.includes('no notice reached Claude'))).toHaveLength(1)
  expect(asked.join('\n')).toContain('Task `lost` failed')
  expect(asked.join('\n')).not.toContain('`seen`')
  await clock.advance(10_000)
  expect(asked.filter(t => t.includes('no notice reached Claude'))).toHaveLength(1)
})

test('a bench replay is no one\'s: not shown, and no wake even when it waits with no notice', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'bench-case-1', 'failed', { bench: { case: 'case', run: 'r1' } }, ts0 - 600)
  fakeTasks(on, files, ['bench-case-1'])
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => { asked.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  await clock.advance(120_000)
  expect(asked.join('\n')).not.toContain('bench-case-1')
})

test('a task closed long ago is not read again', async ($, on) => {
  // the 2026-11-16 audit: every poll read both files of every task ever created
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'old', 'accepted', {}, ts0 - 7200)
  task(files, 'waits', 'review', {}, ts0 - 7200)                // waiting on Claude: shown however old
  const { reads } = fakeTasks(on, files, ['old', 'waits'])
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(70_000)
  expect(reads.filter(r => r === '/wb/tasks/old/status.json')).toHaveLength(1)
  expect(reads.filter(r => r === '/wb/tasks/old/task.json')).toHaveLength(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'waits' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'old' })).toBeFalsy()
  await ui.unmount()
})

test('the apprentice says how the followed task stands: in pixels in a terminal, by its face elsewhere', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const ts = 1_800_000_000
  const files: Record<string, string> = {
    '/wb/tasks/fix-it/task.json': JSON.stringify({ name: 'fix-it', model: 'm', created_at: ts }),
    '/wb/tasks/fix-it/status.json': JSON.stringify({ phase: 'running', round: 1, updated_at: ts }),
  }
  fakeTasks(on, files)
  on('process.run', () => ({
    value: { exitCode: 0, stdout: JSON.stringify({ s: 'activity', t: 'Writing… 3.0s' }), stderr: '' },
  }))
  const blits: string[] = []
  on('ui.blit', (_: any, e: any) => { blits.push(e.key); return { value: {} } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1600)

  // at work: the wrench swings now and then between draws, not on every frame
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Raster' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Writing… 3\.0s/ })).toBeTruthy()
  await clock.advance(5400) // twelve frames: two strokes, up and down
  expect(blits).toContain('apprentice')
  expect(blits.length).toBeLessThanOrEqual(5)
  await ui.unmount()

  // done: it says so, and the task's mark says so too
  files['/wb/tasks/fix-it/status.json'] = JSON.stringify({ phase: 'review', round: 1, updated_at: ts + 5 })
  await clock.advance(1600)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'fix-it is done.' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'Claude reviews next.' })).toBeTruthy()  // who acts next (#103)
  expect(await ui.find({ type: 'Text', text: /^◆/ })).toBeTruthy()
  await ui.unmount()

  // no Raster on the desktop: the face on the line instead
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Raster' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /\[\^_\^\]/ })).toBeTruthy()
  await ui.unmount()
})

test('/workbench alone turns workbench mode on for the session: the pane opens, and a quit ends it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  const ui: string[] = []
  fakeTasks(on, files, [], true, ui)
  on('ui.toast', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/home/u/project' }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'no open tasks', stderr: '' } }))
  on('prompt.context', (_: any, e: any) => ({ blocks: e.blocks }))
  const panes = () => ui.filter(l => !l.startsWith('status'))
  const status = () => ui.filter(l => l.startsWith('status')).at(-1)
  await $.session.start({ cwd: '/home/u/project', surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
  expect(panes()).toEqual([])                                    // not delegating: no pane
  expect((await $.prompt.context({ blocks: [] })).blocks.map((b: any) => b.name)).not.toContain('workbench-mode')

  await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings',
    path: '/home/u/.claude/skills/workbench/SKILL.md' })
  await clock.advance(2000)
  expect(panes()).toEqual(['open workbench'])                    // the mode's sign
  expect(status()).toBe('status ⚒ wb · workbench mode')
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: 'Workbench mode is on.' })).toBeTruthy()
  await pane.unmount()
  // a compacted or cleared conversation is told the mode is on, and where the skill is
  const block = (await $.prompt.context({ blocks: [] })).blocks.find((b: any) => b.name === 'workbench-mode')
  expect(block?.text).toContain('/home/u/.claude/skills/workbench/SKILL.md')
  // what Claude learned about the user, in any project, comes with the mode
  expect((await $.prompt.context({ blocks: [] })).blocks.map((b: any) => b.name)).not.toContain('user-notes')
  files['/wb/notes.md'] = '- Review strictly: reject any diff without tests\n'
  const notes = (await $.prompt.context({ blocks: [] })).blocks.find((b: any) => b.name === 'user-notes')
  expect(notes?.text).toContain('reject any diff without tests')

  await $.command.run({ command: 'workbench-quit', args: '' })
  await clock.advance(2000)
  expect(panes()).toEqual(['open workbench', 'close workbench'])
  expect(status()).toBe('status ')
  expect((await $.prompt.context({ blocks: [] })).blocks.map((b: any) => b.name)).not.toContain('workbench-mode')
  expect((await $.prompt.context({ blocks: [] })).blocks.map((b: any) => b.name)).not.toContain('user-notes')
})

test('with wakes off, Claude is told no wake will come', { options: { wake: 'off' } }, async ($, on) => {
  // the 2026-11-16 audit: the skill said to end the turn and wait for a wake that never came
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  fakeTasks(on, {}, [])
  on('ui.toast', () => ({ value: undefined }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'no open tasks', stderr: '' } }))
  on('prompt.context', (_: any, e: any) => ({ blocks: e.blocks }))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect((await $.prompt.context({ blocks: [] })).blocks.map((b: any) => b.name)).not.toContain('workbench-wake')
  // the context was computed before the mode: the skill's text says it (#540)
  const r = await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })
  expect(r.text).toContain('Wakes are off')
  await clock.advance(2000)
  // and a compacted conversation is told again
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as any)
  const block = (await $.prompt.context({ blocks: [] })).blocks.find((b: any) => b.name === 'workbench-wake')
  expect(block?.text).toContain('Wakes are off')
})

test('a session that enters workbench mode after its first message gets the notes, the wake-off note and the coding rule, and a coding change mid-session reaches it (#540)', { options: { wake: 'off' } }, async ($, on) => {
  // prompt.context fires once per conversation: computed with the mode off, the blocks never came
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {
    '/wb/notes.md': '- merge only when asked',
    '/wb/coding.json': JSON.stringify({ mode: 'ask' }),
  }
  fakeTasks(on, files, [])
  on('ui.toast', () => ({ value: undefined }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'no open tasks', stderr: '' } }))
  on('prompt.context', (_: any, e: any) => ({ blocks: e.blocks }))
  const rows: string[] = []
  on('session.append', (_: any, e: any, next: any) => { rows.push(e.message.content[0].text); return next(e) })
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => { asked.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const names = (await $.prompt.context({ blocks: [] })).blocks.map((b: any) => b.name)
  expect(names).not.toContain('user-notes')                       // the mode is off at the first message
  const r = await $.skill.prompt({ skill: 'workbench', text: '**First task:** `add X`. Empty?', frontmatter: {}, source: 'userSettings' })
  expect(r.text).toContain('add X')
  expect(r.text).toContain('merge only when asked')
  expect(r.text).toContain('Wakes are off')
  expect(r.text).toContain('"Ask me first"')
  await clock.advance(2000)
  expect(rows).toEqual([])                                         // said once, in the skill's text
  // the user picks "Only when I say" in the pane: a row the model reads, and no turn of its own
  files['/wb/coding.json'] = JSON.stringify({ mode: 'only' })
  await clock.advance(31_000)                                      // the poll a change in the files starts
  expect(rows.length).toBe(1)
  expect(rows[0]).toContain('"Only when I say"')
  expect(rows[0]).not.toContain('merge only when asked')           // the notes aren't said again
  // back to "Let Claude decide": the stale rule is taken back
  files['/wb/coding.json'] = JSON.stringify({ mode: 'decide' })
  await clock.advance(31_000)
  expect(rows.length).toBe(2)
  expect(rows[1]).toContain('no longer applies')
  await clock.advance(31_000)
  expect(rows.length).toBe(2)                                      // once per change
  expect(asked).toEqual([])
})

test('after a reload the mod still tells the conversation of a rule change, such as wakes turned off (#697)', { options: { wake: 'off' } }, async ($, on) => {
  // #697: what the conversation was told lived in `mem`, which a reload (here the wake option
  // turned off) emptied, and prompt.context doesn't fire again: WAKE_OFF_NOTE was never said
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  task(files, 'fix-it', 'running', { repo: '/home/u/a', cwd: '/home/u/a' })
  fakeTasks(on, files)
  let reloaded = false
  on('state.get', (_: any, e: any, next: any) => e.key === 'said' && e.plugin === 'workbench' && !reloaded   // the earlier load's
    ? (reloaded = true, { value: { value: { shape: 'said-1', value: { notes: '', wakeOff: false, coding: 'decide' } }, version: 0 } }) : next(e))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  const rows: string[] = []
  on('session.append', (_: any, e: any, next: any) => { rows.push(e.message.content[0].text); return next(e) })
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(rows.filter(r => r.includes('Wakes are off'))).toHaveLength(1)
  await clock.advance(31_000)
  expect(rows.filter(r => r.includes('Wakes are off'))).toHaveLength(1)   // once
})

test('a wb start that turns workbench mode on mid-session brings the notes as a row, or a turn when the row is refused (#540)', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = { '/wb/notes.md': '- merge only when asked' }
  fakeTasks(on, files, [])
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'no open tasks', stderr: '' } }))
  on('prompt.context', (_: any, e: any) => ({ blocks: e.blocks }))
  on('tool.call', () => ({ result: { stdout: '' }, text: '' }))
  let refuse = false
  const rows: string[] = []
  on('session.append', (_: any, e: any, next: any) => {
    if (refuse) return { deny: 'policy' }
    rows.push(e.message.content[0].text)
    return next(e)
  })
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => { asked.push(e.text); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.context({ blocks: [] })
  await $.tool.call({ tool: 'Bash', command: 'wb start t --spec s.md' })
  await clock.advance(2000)
  expect(rows.length).toBe(1)
  expect(rows[0]).toContain('merge only when asked')
  await $.turn.complete(endTurn('t1'))
  // refused (an older Claude Code, a policy): a turn of its own once Claude is free
  refuse = true
  files['/wb/coding.json'] = JSON.stringify({ mode: 'only' })
  await clock.advance(31_000)
  await clock.advance(2000)
  expect(rows.length).toBe(1)
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('"Only when I say"')
})

test('/workbench as the first message says its rules once, in the context blocks or the skill, not both (#540)', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {
    '/wb/notes.md': '- merge only when asked',
    '/wb/coding.json': JSON.stringify({ mode: 'only' }),
  }
  fakeTasks(on, files, [])
  on('ui.toast', () => ({ value: undefined }))
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'no open tasks', stderr: '' } }))
  on('prompt.context', (_: any, e: any) => ({ blocks: e.blocks }))
  const rows: string[] = []
  on('session.append', (_: any, e: any, next: any) => { rows.push(e.message.content[0].text); return next(e) })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r = await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })
  const blocks = (await $.prompt.context({ blocks: [] })).blocks
  const said = [r.text, ...blocks.map((b: any) => b.text)].join('\n')
  expect(said.split('merge only when asked').length).toBe(2)       // once
  expect(said.split('"Only when I say"').length).toBe(2)
  expect(blocks.map((b: any) => b.name)).toContain('workbench-mode')
  await clock.advance(2000)
  expect(rows).toEqual([])
})

test("the Stats tab's live rows wrap at spaces instead of losing their end to the pane's edge", () => {
  // 2026-11-21: "GPU 0 Radeon RX 9070/9070 XT/9070 GRE █░░… 1.3/15.9 GiB · busy …": the busy bar,
  // the watts and the sparkline were cut off in a 70-column pane
  const gpu = [{ bold: true, text: 'GPU 0 ' }, { dim: true, text: 'Radeon RX 9070/9070 XT/9070 GRE ' },
    { color: 'success', text: '█░░░░░░░░░░░' }, { text: ' 1.3/15.9 GiB ' }, { dim: true, text: '· busy ' },
    { color: 'success', text: '░░░░░░░░' }, { text: ' 3% ' }, { text: '· 21 W ' }, { dim: true, text: '▁▁▂▁▁▁' }]
  const lines = wrapParts(gpu, 70)
  expect(lines.length).toBe(2)
  for (const l of lines) expect(l.map(p => p.text).join('').length).toBeLessThanOrEqual(70)
  const flat = (ls: typeof lines) => ls.map(l => l.map(p => p.text).join('')).join(' ').replace(/\s+/g, ' ')
  expect(flat(lines)).toBe(gpu.map(p => p.text).join('').replace(/\s+/g, ' ').trim())  // nothing lost
  expect(lines[1][0].text).toBe('  ')                                   // the rest indented under it
  expect(lines[1].find(p => p.text.includes('░░░░░░░░'))?.color).toBe('success')  // colours kept
  expect(wrapParts([{ text: 'Nothing running.' }], 70)).toEqual([[{ text: 'Nothing running.' }]])
  const model = [{ text: '○ ' }, { text: 'Qwen3.8 27B UD-Q3_K_XL (Ollama) (40K) ' }, { dim: true, text: 'idle' },
    { dim: true, text: ' · writes ~35 · reads ~602 · loads ~12s' }]
  expect(flat(wrapParts(model, 70))).toContain('loads ~12s')
})

test('the bubble wraps its words into lines that fit, never cutting a line short', () => {
  const said = 'read /home/me/.local/state/workbench/tasks/fix-parser/worktree/src/parser.c and then the tests'
  const lines = wrapWords(said, 30)
  expect(lines.every(l => l.length <= 30)).toBe(true)
  expect(lines.join(' ').replace(/\s+/g, '')).toBe(said.replace(/\s+/g, ''))  // nothing lost
  expect(wrapWords('All caught up.', 30)).toEqual(['All caught up.'])
  expect(wrapWords('', 30)).toEqual([''])
})

test('the Tasks tab ends with the week\'s saving, read from wb savings; the web chat link is the Settings tab\'s', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  fakeTasks(on, chatOn({}))
  const week = { period: 'week', tasks: 3, claude: 160000, self_est: 1390000, saved: 1230000, wh: 900, cost: null }
  on('process.run', (_: any, e: any) => {
    if (e.argv[1] === 'savings') return { value: { exitCode: 0, stdout: JSON.stringify(week), stderr: '' } }
    if (e.argv[1] === 'chat' && e.argv[2] === 'url')
      return { value: { exitCode: 0, stdout: 'https://box.tail.ts.net/#token=abc\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  const at = texts.indexOf('this week: saved ~1.2M Claude tokens (88%, estimate) · 900 Wh')
  expect(at).toBeGreaterThan(-1)
  expect(texts.slice(at + 1)).toEqual([])                                     // never under the tasks (the user, 2026-11-19)
  await ui.press({ key: 'tab-settings' })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).slice(-3)).toEqual(['web chat https://box.tail.ts.net/#token=abc',
    'web chat ', 'https://box.tail.ts.net/#token=abc'])
  await ui.press({ key: 'tab-tasks' })
  await ui.unmount()
})

test('the saving reads in thousands or millions, says when it cost more, and is empty with nothing to show', () => {
  const t = (o: object) => JSON.stringify({ tasks: 1, claude: 50000, self_est: 80000, saved: 30000, wh: 0, ...o })
  expect(savedLine(t({}))).toBe('this week: saved ~30K Claude tokens (38%, estimate)')
  expect(savedLine(t({ wh: 1500 }))).toBe('this week: saved ~30K Claude tokens (38%, estimate) · 1.5 kWh')
  expect(savedLine(t({ wh: 1500, cost: 0.45 }))).toBe('this week: saved ~30K Claude tokens (38%, estimate) · 1.5 kWh, cost 0.45')
  expect(savedLine(t({ saved: -4000 }))).toBe('this week: cost ~4K more Claude tokens (estimate)')
  expect(savedLine(t({ tasks: 0 }))).toBe('')
  expect(savedLine('usage: wb …')).toBe('')
})

test('a night\'s backlog keeps the user away past six hours; without one, away lapses', () => {
  // #110 (2026-11-18): away lapsed after 6 h, and an overnight batch's permission prompts then
  // waited in the terminal until morning
  const t0 = 1_800_000_000_000, hour = 3600_000
  const night = (phase: string, backlog = 'night-1') => ({ name: 'n', phase, backlog } as any)
  const ours = () => true
  expect(awayNow(t0, t0 + 5 * hour, [], ours)).toBe(true)                          // within six hours
  expect(awayNow(t0, t0 + 7 * hour, [], ours)).toBe(false)                         // lapsed
  expect(awayNow(t0, t0 + 7 * hour, [night('running')], ours)).toBe(true)          // the batch runs on
  expect(awayNow(t0, t0 + 7 * hour, [night('review')], ours)).toBe(true)           // or waits on Claude
  expect(awayNow(t0, t0 + 7 * hour, [night('accepted')], ours)).toBe(false)        // done: lapsed
  expect(awayNow(t0, t0 + 7 * hour, [night('running', '')], ours)).toBe(false)     // not a backlog task
  expect(awayNow(t0, t0 + 7 * hour, [night('running')], () => false)).toBe(false)  // another session's
  expect(awayNow(0, t0, [night('running')], ours)).toBe(false)                     // never wrote from the web
})

test('a leftover task waiting on Claude stops neither the weekly check nor the optimize for good', () => {
  // #541: any open task at any age gated both, so one stuck task left by /workbench-quit, or
  // another session's in review, stopped them for weeks
  const now = 1_800_000_000_000, hour = 3600_000
  const t = (phase: string, idle: number) => ({ name: 'x', phase, updatedAt: now - idle } as any)
  const ours = () => true, theirs = () => false
  expect(quietForJobs([], now, ours)).toBe(true)
  expect(quietForJobs([t('running', 0)], now, theirs)).toBe(false)     // the GPU's, anyone's
  expect(quietForJobs([t('queued', 30 * 24 * hour)], now, theirs)).toBe(false)
  expect(quietForJobs([t('review', hour)], now, ours)).toBe(false)     // this session's, lately
  expect(quietForJobs([t('review', hour)], now, theirs)).toBe(true)    // another session's
  expect(quietForJobs([t('stuck', 13 * hour)], now, ours)).toBe(true)  // left for a session long gone
  expect(quietForJobs([t('accepted', 0)], now, ours)).toBe(true)
  // #541: one /workbench-quit parked waits on no one, this session's or not
  expect(quietForJobs([{ ...t('stuck', hour), parked: true }], now, ours)).toBe(true)
})

test('Claude coding: its own edit in a task\'s worktree waits for the user\'s yes, unless Claude decides', async ($, on) => {
  // #92: the user's choice of when Claude writes a delegated task's code
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const ts = 1_800_000_000
  const files: Record<string, string> = {
    '/wb/tasks/fix-it/task.json': JSON.stringify({ name: 'fix-it', model: 'm', created_at: ts }),
    '/wb/tasks/fix-it/status.json': JSON.stringify({ phase: 'review', round: 1, updated_at: ts }),
  }
  fakeTasks(on, files)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('tool.call', () => ({ result: {}, text: '' }))                // the engine's own tool
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  const edit = (path = '/wb/tasks/fix-it/worktree/power.py') =>
    $.tool.call({ tool: 'Edit', file_path: path, old_string: 'w', new_string: 'w / 1000' } as any) as Promise<any>
  expect((await edit()).deny).toBeUndefined()                      // no saved choice: as before
  files['/wb/coding.json'] = JSON.stringify({ mode: 'ask' })
  expect((await edit()).deny).toContain('"Ask me first"')
  expect((await edit('/home/u/project/power.py')).deny).toBeUndefined()   // not a task's: Claude's own
  files['/wb/tasks/fix-it/coding.json'] = JSON.stringify({ allowed: [{ edit: 'w / 1000', used: null }] })
  expect((await edit()).deny).toBeUndefined()                      // the user said yes
  files['/wb/tasks/fix-it/coding.json'] = JSON.stringify({ allowed: [{ edit: 'w / 1000', used: ts }] })
  files['/wb/coding.json'] = JSON.stringify({ mode: 'only' })
  expect((await edit()).deny).toContain('report the blocker to the user')   // handed back: spent
  const w = await $.tool.call({ tool: 'Write', file_path: '/wb/tasks/fix-it/worktree/new.py', content: '' } as any) as any
  expect(w.deny).toContain('"Only when I say"')
  // a worktree nested for a sibling two levels up (#261, the audit of 1.2) is the task's too
  expect((await edit('/wb/tasks/fix-it/tree/apps/worktree/power.py')).deny).toContain('"Only when I say"')
  expect((await edit('/wb/tasks/fix-it/tree/shared/lib/power.py')).deny).toBeUndefined()   // a sibling's link
})

test('a WB_HOME given with ~, relative or with a trailing slash is read where wb reads it (#454)', async ($, on) => {
  // settings.json's env passes WB_HOME literally: the mod took `~/state/wb/` as given
  expect(absolutePath('~/state/wb/', '/home/u', '/home/u/a')).toBe('/home/u/state/wb')
  expect(absolutePath('~', '/home/u', '/x')).toBe('/home/u')
  expect(absolutePath('state//wb/./', '/home/u', '/home/u/a')).toBe('/home/u/a/state/wb')
  expect(absolutePath('../wb', '/home/u', '/home/u/a')).toBe('/home/u/wb')
  expect(absolutePath('/wb/', '/home/u', '/')).toBe('/wb')
  expect(absolutePath('~u/wb', '/home/u', '/x')).toBe('/x/~u/wb')        // as expanduser leaves another user's
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {
    '/home/u/wb/coding.json': JSON.stringify({ mode: 'only' }),
  }
  fakeTasks(on, files)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('tool.call', () => ({ result: {}, text: '' }))
  try {
    engine.env = { WB_HOME: '~/wb/' }
    await $.session.start({ cwd: '/home/u/a', surface: 'terminal', isInteractive: true })
    await clock.advance(1000)
    const r = await $.tool.call({ tool: 'Write', file_path: '/home/u/wb/tasks/fix-it/worktree/x.py', content: '' } as any) as any
    expect(r.deny).toContain('"Only when I say"')                  // the Claude-coding guard applies
    await clock.advance(1000)                                      // the poll the call started ends here
  } finally {
    engine.env = undefined
  }
})

test('the probe row says whether it works, and turned on without probe it asks Claude to offer the setup', async ($, on) => {
  // the user, 2026-11-20: the row read "On" while wb said it changed nothing yet; say whether it
  // works, and let Claude offer to set probe up
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  const asked: string[] = []
  on('prompt.submit', (_: any, e: any) => { asked.push(e.text); return { text: e.text } })
  let found = false
  let checks = 0
  const missing = 'probe: on, but not set up: no probe with `symbols` is on PATH, so it changes nothing yet (probe, a code-search tool: github.com/probelabs/probe; its release binary from github.com/probelabs/probe/releases, not crates.io\'s probe-code 0.6.0)'
  on('process.run', (_: any, e: any) => {
    if (e.argv[1] !== 'experiment') return { value: { exitCode: 0, stdout: '', stderr: '' } }
    if (e.argv[3]) files['/wb/experiments.json'] = JSON.stringify({ probe: e.argv[3] })
    else checks++
    const state = JSON.parse(files['/wb/experiments.json'] ?? '{}').probe
    const said = state !== 'on' ? 'probe: off (wb experiment probe on)'
      : found ? 'probe: on and working (probe-code 0.6.0)' : missing
    return { value: { exitCode: 0, stdout: `${said}${e.argv[3] ? '; tasks already started keep theirs' : ''}\n`, stderr: '' } }
  })
  const row = async (ui: any) => (await ui.findAll({ type: 'Button' })).map((b: any) => b.props.label)
    .find((l: string) => l.includes('Agent code navigation'))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-settings' })
  expect(await row(ui)).toBe('▸ Agent code navigation: Off (default)')
  expect(checks).toBe(0)                                            // off: wb isn't asked
  await ui.press({ key: 'probe' })
  await ui.press({ key: 'probe:on' })
  expect(toasts.filter(t => t.includes('code navigation'))).toEqual([
    "workbench: Agent code navigation is on but not set up: probe isn't installed. Claude will offer to set it up."])
  expect(await row(ui)).toBe('▸ Agent code navigation: On, not set up')
  await clock.advance(5000)                                         // the next poll starts Claude's turn
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('The user just turned on Agent code navigation')
  expect(asked[0]).toContain(missing)
  expect(asked[0]).toContain('github.com/probelabs/probe/releases')
  expect(asked[0]).toContain('install nothing without their yes')

  found = true                                                      // Claude installed it
  await clock.advance(31_000)
  await ui.press({ key: 'tab-tasks' })
  await ui.press({ key: 'tab-settings' })
  expect(await row(ui)).toBe('▸ Agent code navigation: On, working')
  await ui.press({ key: 'probe' })
  await ui.press({ key: 'probe:off' })
  expect(await row(ui)).toBe('▸ Agent code navigation: Off (default)')
  await ui.press({ key: 'probe' })
  await ui.press({ key: 'probe:on' })
  expect(toasts.filter(t => t.includes('code navigation'))).toHaveLength(2)
  expect(toasts.at(-1)).toBe('workbench: Agent code navigation is on and working (probe-code 0.6.0): tasks started from now use it.')
  await clock.advance(5000)
  expect(asked).toHaveLength(1)                                     // working: nothing for Claude
  await ui.unmount()
})

test('turning the web chat on from the pane says why wb couldn\'t, and pins no link (#690)', async ($, on) => {
  // #690: setWeb ignored wb's failure; the row read On and the pane pinned a link that gave a 401
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('process.run', (_: any, e: any) => {
    if (e.argv[1] === 'chat' && e.argv[2] === 'on') {             // wb leaves the switch off
      return { value: { exitCode: 1, stdout: '', stderr: 'wb: web chat left off: another account\'s chat answers on port 1337: wb chat on --port <free port>\n' } }
    }
    if (e.argv[1] === 'chat' && e.argv[2] === 'url') return { value: { exitCode: 0, stdout: 'http://localhost:1337/#token=abc\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-settings' })
  await ui.press({ key: 'chat' })
  await ui.press({ key: 'chat:on' })
  expect(toasts.some(t => t.includes("another account's chat answers on port 1337"))).toBe(true)
  expect((await ui.find({ key: 'chat' }))?.props.label).toBe('▸ Web chat: Off (default)')
  expect(await ui.find({ type: 'Text', text: /token=abc/ })).toBeUndefined()
  await ui.unmount()
})

test('the settings rows open to Buttons, pick through wb, and say the sentence of the option the ring is on', async ($, on) => {
  // #93, and the user, 2026-11-19: a Select's sentence followed only the saved choice, and the options
  // should take a click or the keys
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  const runs: string[][] = []
  const ring: any[] = []
  on('ui.focus', (_: any, e: any) => { ring.push(e); return { value: {} } })   // the engine, beneath: the ring moves
  on('process.run', (_: any, e: any) => {
    runs.push(e.argv)
    if (e.argv[1] === 'chat' && e.argv[2] === 'on') files['/wb/chat/switch.json'] = JSON.stringify({ on: true })
    if (e.argv[1] === 'coding') files['/wb/coding.json'] = JSON.stringify({ mode: e.argv[2] })  // what wb writes
    if (e.argv[1] === 'experiment') files['/wb/experiments.json'] = JSON.stringify({ [e.argv[2]]: e.argv[3] })
    if (e.argv[1] === 'chat' && e.argv[2] === 'url')
      return { value: { exitCode: 0, stdout: 'http://localhost:1337/#token=abc\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  for (const rows of [24, 8]) {                                      // the apprentice in pixels, then its face
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset: 0, bodyRows: rows } } })
    expect(await ui.find({ key: 'coding' })).toBeUndefined()                                           // a tab of their own
    expect((await ui.findAll({ type: 'Button' })).slice(-3).map(b => b.props.label)).toEqual(['Tasks', 'Stats', 'Settings'])  // last
    await ui.press({ key: 'tab-settings' })
    expect((await ui.find({ key: 'coding' }))?.props.label).toBe('▸ Claude coding: Let Claude decide (default)')  // no saved choice
    expect((await ui.find({ key: 'chat' }))?.props.label).toBe('▸ Web chat: Off (default)')                      // off by default
    expect((await ui.find({ key: 'probe' }))?.props.label).toBe('▸ Agent code navigation: Off (default)')  // opt-in
    expect(await ui.find({ key: 'coding:ask' })).toBeUndefined()                                       // one row each at rest
    const labels = (await ui.findAll({ type: 'Button' })).map(b => String(b.props.label)).filter(l => l.startsWith('▸ '))
    expect(labels.slice(-2)).toEqual(['▸ Web chat: Off (default)', '▸ Agent code navigation: Off (default)'])  // last, apart (the user, 2026-11-21)
    expect(await ui.find({ type: 'Text', text: /^Experimental · may change or go away$/ })).toBeDefined()   // under their own heading
    expect(await ui.find({ type: 'Text', text: /web chat / })).toBeUndefined()                         // and no link
    await ui.press({ key: 'tab-tasks' })
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-settings' })
  await ui.press({ key: 'coding' })
  expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label).filter((l: string) => / {2}[❯ ] /.test(l)))
    .toEqual(['    Only when I say', '    Ask me first', '  ❯ Let Claude decide (default)'])
  const says = async () => ((await ui.find({ key: 'coding-says' })) as any)?.children?.[0]?.children?.[0]?.trim()
  expect(await says()).toBe('Claude uses its judgment to guide the local agent or make a fix itself.')  // the chosen one's
  await $.ui.focus({ component: 'Pane', requestId: 'workbench', element: 'coding:only', origin: { kind: 'person' } } as any)  // the person's Tab, as the engine raises it
  expect(await says()).toBe('You tell Claude when to write code.')                                         // the ring's
  await ui.press({ key: 'coding:ask' })
  expect(runs.at(-1)).toEqual(['wb', 'coding', 'ask'])
  expect((await ui.find({ key: 'coding' }))?.props.label).toBe('▸ Claude coding: Ask me first')
  expect(await ui.find({ key: 'coding:ask' })).toBeUndefined()
  await ui.press({ key: 'chat' })
  await ui.press({ key: 'chat:on' })
  expect(runs.some(r => r.join(' ') === 'wb chat on')).toBe(true)
  expect((await ui.find({ key: 'chat' }))?.props.label).toBe('▸ Web chat: On')
  await ui.press({ key: 'probe' })
  await ui.press({ key: 'probe:on' })
  expect(runs.some(r => r.join(' ') === 'wb experiment probe on')).toBe(true)   // then the row asks how it came out
  expect((await ui.find({ key: 'probe' }))?.props.label).toBe('▸ Agent code navigation: On')
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.at(-1)).toBe('http://localhost:1337/#token=abc')                                   // the link, at once
  await ui.press({ key: 'tab-tasks' })
  expect(await ui.find({ type: 'Text', text: /token=abc/ })).toBeUndefined()                    // not under the tasks
  await ui.press({ key: 'tab-settings' })
  await ui.unmount()
  const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })    // the same rows there
  expect((await phone.find({ key: 'coding' }))?.props.label).toBe('▸ Claude coding: Ask me first')
  await phone.unmount()
})

const FEED = {
  ts: 1_800_000_000, tasks: 9, settings: { recording: true, live: true, every: 2 },
  periods: {
    week: { tasks: 4, landed: 3, accepted_pct: 75, savings: { saved: 1_230_000, wh: 600, cost: null }, score: { score: 62 },
      energy: { wh: 900 } },
    all: { tasks: 9, landed: 8, accepted_pct: 89 },
  },
  streak: { current: 0, best: 3, days: 5 },
  absorbed: { auto_fixes: 7, auto_fixed_tasks: 3 },
  questions: { asked: 2, answered: 1 },
  models: { 'ollama/m': { tasks: 9, accepted_pct: 89, rounds: 1.4, minutes: 14, speed: { write: 38 },
    write_trend: [[1, 30], [2, 40]], write_change_pct: 12 } },
  days: [{ day: '2026-11-19', tasks: 0 }, { day: '2026-11-20', tasks: 2 }],
  guards: { silence: 1, repeat: 2 },
}

test('the Stats tab draws the history, read from wb stats only while it is shown and again when a task closes', async ($, on) => {
  // #406: no timer, and nothing at all while another tab, or no pane, is shown
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = { '/wb/results.jsonl': '{}\n' }
  const pane = fakeTasks(on, files, [])
  const reads: string[][] = []
  on('process.run', (_: any, e: any) => {
    if (e.argv[1] === 'stats' && e.argv[2] === '--json') {
      reads.push(e.argv)
      return { value: { exitCode: 0, stdout: JSON.stringify(FEED), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  pane.show(true)                                                        // the pane open, on its Tasks tab
  await clock.advance(31_000)
  expect(reads.length).toBe(0)                                           // the Tasks tab: never read
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 200 } })
  await ui.press({ key: 'tab-stats' })
  await clock.advance(10)
  expect(reads.length).toBe(1)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('This week: score 62/100 · saved ~1.2M Claude tokens (estimate) · 4 tasks · 3 landed (75%) · 900 Wh')
  expect(texts).toContain('Streak: best: 3 days in a row with a task landed')          // a run that ended isn't said
  expect(texts.some(t => t.includes('the same call repeated 2 · silence 1'))).toBe(true)
  expect(texts.some(t => t.includes('writes ~38 tok/s ▆█ (+12%)'))).toBe(true)
  await clock.advance(31_000)
  expect(reads.length).toBe(1)                                           // nothing changed: not read again
  files['/wb/results.jsonl'] = '{}\n{}\n'                                // a task closed
  await clock.advance(31_000)
  expect(reads.length).toBe(2)
  pane.show(false)                                                       // put away
  files['/wb/results.jsonl'] = '{}\n{}\n{}\n'
  await clock.advance(31_000)
  expect(reads.length).toBe(2)
  await ui.press({ key: 'tab-tasks' })
  await ui.unmount()
})

test('the Stats tab reads the history again once its day has ended, with nothing on disk changed', async ($, on) => {
  // #575: an ended streak, last week's "This week" and a 30-day chart ending days ago stayed until
  // a task closed: the feed says when its day ends (until), and a load reads it once anyway
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = { '/wb/results.jsonl': '{}\n' }
  const pane = fakeTasks(on, files, [])
  const reads: string[][] = []
  on('process.run', (_: any, e: any) => {
    if (e.argv[1] === 'stats' && e.argv[2] === '--json') {
      reads.push(e.argv)
      return { value: { exitCode: 0, stdout: JSON.stringify({ ...FEED, until: clock.now() / 1000 + 60 }), stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  pane.show(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 200 } })
  await ui.press({ key: 'tab-stats' })
  await clock.advance(10)
  expect(reads.length).toBe(1)
  await clock.advance(31_000)
  expect(reads.length).toBe(1)                                           // the same day: not read again
  await clock.advance(62_000)
  expect(reads.length).toBe(2)                                           // past midnight: read again
  await ui.press({ key: 'tab-tasks' })
  await ui.unmount()
})

test('a load reads the history once even when the feed an earlier load kept still matches the files', async ($, on) => {
  // #575: the stats atom, key included, survives /reload-plugins, so a reload never re-read it
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = { '/wb/results.jsonl': '{}\n' }
  const pane = fakeTasks(on, files, [])
  const kept = { key: `${files['/wb/results.jsonl'].length}@0 - - - - -`, feed: { ...FEED, until: 1_900_000_000 } }
  on('state.get', (_: any, e: any, next: any) => e.key === 'stats' && e.plugin === 'workbench'
    ? { value: { value: { shape: 'stats-1', value: kept }, version: 1 } } : next(e))
  const reads: string[][] = []
  on('process.run', (_: any, e: any) => {
    if (e.argv[1] === 'stats' && e.argv[2] === '--json') reads.push(e.argv)
    return { value: { exitCode: 0, stdout: e.argv[1] === 'stats' ? JSON.stringify(FEED) : '', stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  pane.show(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 200 } })
  await ui.press({ key: 'tab-stats' })
  await clock.advance(10)
  expect(reads.length).toBe(1)
  await ui.press({ key: 'tab-tasks' })
  await ui.unmount()
})

test('the Stats tab reads the history again after wb optimize, a bench run, a price, and on its press', async ($, on) => {
  // #549: the key stamped results.jsonl and stats.json alone, so the tab kept a feed without the
  // optimized windows, the bench result or the new price until a task closed, pressed or not
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = { '/wb/results.jsonl': '{}\n' }
  const pane = fakeTasks(on, files, [])
  const reads: string[][] = []
  on('process.run', (_: any, e: any) => {
    if (e.argv[1] === 'stats' && e.argv[2] === '--json') reads.push(e.argv)
    return { value: { exitCode: 0, stdout: e.argv[1] === 'stats' ? JSON.stringify({ ...FEED, until: 1_900_000_000 }) : '', stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  pane.show(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 200 } })
  await ui.press({ key: 'tab-stats' })
  await clock.advance(10)
  expect(reads.length).toBe(1)
  await clock.advance(31_000)
  expect(reads.length).toBe(1)                                           // nothing changed
  const steps: [string, string][] = [['/wb/optimize.json', '{"models": {}}'], ['/wb/bench/runs.jsonl', '{}\n'],
    ['/home/u/.config/workbench/savings.json', '{"kwh_price": 0.3}']]
  for (const [i, [path, text]] of steps.entries()) {
    files[path] = text
    await clock.advance(31_000)
    expect(reads.length).toBe(2 + i)
  }
  await ui.press({ key: 'tab-tasks' })
  await ui.press({ key: 'tab-stats' })                                   // pressed: read, files unchanged
  await clock.advance(10)
  expect(reads.length).toBe(5)
  await ui.press({ key: 'tab-tasks' })
  await ui.unmount()
})

test('the Stats tab reads the history again after a machine of a network home measures (#894)', async ($, on) => {
  // #894: on a network home each machine keeps optimize.json and speed.json in machines/<id>/,
  // which the key never stamped: the tab kept a feed without the machine's new measurements
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = { '/wb/results.jsonl': '{}\n' }
  const pane = fakeTasks(on, files, ['m-a'])                     // fs.list: machines/m-a (no tasks/)
  const reads: string[][] = []
  on('process.run', (_: any, e: any) => {
    if (e.argv[1] === 'stats' && e.argv[2] === '--json') reads.push(e.argv)
    return { value: { exitCode: 0, stdout: e.argv[1] === 'stats' ? JSON.stringify({ ...FEED, until: 1_900_000_000 }) : '', stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  pane.show(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 200 } })
  await ui.press({ key: 'tab-stats' })
  await clock.advance(10)
  expect(reads.length).toBe(1)
  await clock.advance(31_000)
  expect(reads.length).toBe(1)                                           // nothing changed
  for (const [i, f] of ['optimize.json', 'speed.json'].entries()) {
    files[`/wb/machines/m-a/${f}`] = '{}'
    await clock.advance(31_000)
    expect(reads.length).toBe(2 + i)
  }
  await ui.press({ key: 'tab-tasks' })
  await ui.unmount()
})

test('the Stats tab\'s settings pick through wb, progress checks stay off by default, and the price is typed', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  fakeTasks(on, files, [])
  const runs: string[][] = []
  on('process.run', (_: any, e: any) => {
    runs.push(e.argv)
    if (e.argv[1] === 'stats' && e.argv[2] === 'set')
      files['/wb/stats.json'] = JSON.stringify({ [e.argv[3]]: e.argv[3] === 'every' ? Number(e.argv[4]) : e.argv[4] === 'on' })
    if (e.argv[1] === 'savings' && e.argv[2] === '--price')
      return { value: { exitCode: 0, stdout: JSON.stringify(e.argv[3] === 'off' ? { tasks: 0, price: null } :
        { tasks: 1, claude: 50000, self_est: 80000, saved: 30000, wh: 1500, cost: 0.45, price: Number(e.argv[3]) }), stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-settings' })
  expect((await ui.find({ key: 'record' }))?.props.label).toBe('▸ Stats recording: On (default)')
  expect((await ui.find({ key: 'live' }))?.props.label).toBe('▸ Live view: On (default)')
  expect((await ui.find({ key: 'every' }))?.props.label).toBe('▸ Live refresh: 2 s (default)')
  expect((await ui.find({ key: 'progress' }))?.props.label).toBe('▸ Progress checks: Off (default)')
  await ui.press({ key: 'record' })
  await ui.press({ key: 'record:off' })
  expect(runs.some(r => r.join(' ') === 'wb stats set recording off')).toBe(true)
  expect((await ui.find({ key: 'record' }))?.props.label).toBe('▸ Stats recording: Off')
  await ui.press({ key: 'every' })
  await ui.press({ key: 'every:5' })
  expect(runs.some(r => r.join(' ') === 'wb stats set every 5')).toBe(true)
  await ui.press({ key: 'progress' })
  await ui.press({ key: 'progress:on' })
  expect(runs.some(r => r.join(' ') === 'wb progress on')).toBe(true)
  await ui.input({ key: 'price', text: 'cheap' })                        // not a number: wb isn't asked
  expect(runs.some(r => r[2] === '--price')).toBe(false)
  await ui.input({ key: 'price', text: '$0.30' })
  expect(runs.some(r => r.join(' ') === 'wb savings --price 0.3 --json')).toBe(true)
  expect((await ui.find({ key: 'price' }))?.props.value).toBe('0.3')
  runs.length = 0
  await ui.input({ key: 'price', text: '0,30' })                         // #609: a decimal comma
  expect(runs.some(r => r.join(' ') === 'wb savings --price 0.3 --json')).toBe(true)
  await ui.press({ key: 'tab-tasks' })                                  // the footer shows the cost
  expect((await ui.findAll({ type: 'Text' })).some(t => String(t.text).includes('1.5 kWh, cost 0.45'))).toBe(true)
  await ui.press({ key: 'tab-settings' })
  runs.length = 0
  await ui.input({ key: 'price', text: '' })                             // an empty submit clears it
  expect(runs.some(r => r.join(' ') === 'wb savings --price off --json')).toBe(true)
  expect((await ui.find({ key: 'price' }))?.props.value).toBe('')
  await ui.press({ key: 'tab-tasks' })
  await ui.unmount()
})

test('the Progress checks row names a set --after threshold, and picking the option already chosen runs nothing (#578)', async ($, on) => {
  // #578: the row's On said "its typical length" while `wb progress on --after 30` held, and
  // picking On again ran a bare `wb progress on`, which then dropped the threshold
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = { '/wb/progress.json': JSON.stringify({ on: true, after: 30.0, ts: 1_800_000_000 }) }
  fakeTasks(on, files, [])
  const runs: string[][] = []
  on('process.run', (_: any, e: any) => {
    runs.push(e.argv)
    if (e.argv[1] === 'progress' && e.argv[2]) {
      const was = JSON.parse(files['/wb/progress.json'] ?? '{}')
      files['/wb/progress.json'] = JSON.stringify({ ...was, on: e.argv[2] === 'on' })   // wb keeps after
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  const label = async (ui: any) => (await ui.find({ key: 'progress' }))?.props.label
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-settings' })
  expect(await label(ui)).toBe('▸ Progress checks: On, after 30 min')
  await ui.press({ key: 'progress' })
  expect((await ui.find({ key: 'progress:on' }))?.props.label).toBe('  ❯ On, after 30 min')
  expect(JSON.stringify(await ui.findAll({ type: 'Text' }))).toContain('A task past 30 min of active work gets a check')
  await ui.press({ key: 'progress:on' })                               // the one already chosen
  expect(runs.filter(r => r[1] === 'progress')).toEqual([])            // folds the row, runs nothing
  expect(await label(ui)).toBe('▸ Progress checks: On, after 30 min')
  await ui.press({ key: 'progress' })
  await ui.press({ key: 'progress:off' })
  expect(runs.filter(r => r[1] === 'progress').map(r => r.join(' '))).toEqual(['wb progress off'])
  expect(await label(ui)).toBe('▸ Progress checks: Off (default)')

  files['/wb/progress.json'] = JSON.stringify({ on: true, ts: 1_800_000_000 })  // --after 0 cleared it
  await ui.press({ key: 'tab-tasks' })
  await ui.press({ key: 'tab-settings' })
  expect(await label(ui)).toBe('▸ Progress checks: On')
  await ui.unmount()
})

const TICK = {
  ts: 1_800_000_000, every: 2,
  gpus: [{ index: 0, name: 'Advanced Micro Devices, Inc. [AMD/ATI] Navi 48 [Radeon RX 9070 XT]', used: 2 ** 33, total: 2 ** 34, busy: 40, watts: 120 }],
  running: [{ task: 'fix-it', model: 'ollama/m', label: 'Model M', phase: 'running', round: 2, round_s: 75, tok_s: 41.2, tok_s_from: 'live', context_pct: 31 }],
  rack: [{ model: 'ollama/m', label: 'Model M', state: 'resident', gpu_bytes: 2 ** 33, write_tok_s: 40, read_tok_s: 900, load_s: 9, tasks: ['fix-it'] },
    { model: 'ollama/n', label: 'Model N', state: 'idle', write_tok_s: 20 }],
  queue: [{ task: 'later', model: 'ollama/n', waited_s: 30 }],
}

test('the live view runs wb top only while the Stats tab is on screen with Live view on, and ends it when left', { timeoutMs: 20_000 }, async ($, on) => {
  // the kit's 5 s default timed it out on a loaded machine (#546)
  // #408: hidden, minimized, another tab or Live view off: no child at all
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = { '/wb/results.jsonl': '' }
  const pane = fakeTasks(on, files, [], true, [], false)
  let starts = 0, ends = 0
  on('process.spawn', async function* (_: any, e: any) {
    if (e.argv[1] !== 'top') {                                           // wb events, as fakeTasks's
      yield { stream: 'stdout', text: '{"hello": 4242}\n' }
      await new Promise(() => {})
    }
    starts += 1
    try {
      for (;;) {
        yield { stream: 'stdout', text: JSON.stringify(TICK) + '\n' }
        await new Promise(r => setTimeout(r, 5))
      }
    } finally {
      ends += 1
    }
  })
  on('process.run', (_: any, e: any) => ({ value: { exitCode: 0, stdout: e.argv[1] === 'stats' ? JSON.stringify({ tasks: 0 }) : '', stderr: '' } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  pane.show(true)
  await clock.advance(31_000)
  expect(starts).toBe(0)                                                 // the Tasks tab
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 200 } })
  await ui.press({ key: 'tab-stats' })
  await new Promise(r => setTimeout(r, 30))
  expect(starts).toBe(1)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.some(t => t.startsWith('GPU 0 Radeon RX 9070 XT ██████░░░░░░ 8.0/16.0 GiB · busy ███▎░░░░ 40% · 120 W'))).toBe(true)
  expect(texts.some(t => t.includes('fix-it Model M · running · round 2 · 1m15s · 41 tok/s · context 31%'))).toBe(true)
  expect(texts.some(t => t.includes('● Model M resident 8.0 GiB on the GPU · writes ~40 · reads ~900 · loads ~9s ← fix-it'))).toBe(true)
  expect(texts.some(t => t.includes('◌ later waits for the GPU (30s)'))).toBe(true)
  await clock.advance(31_000)
  expect(starts).toBe(1)                                                 // one child, not one a poll
  await ui.press({ key: 'tab-tasks' })
  await new Promise(r => setTimeout(r, 30))
  expect(ends).toBe(1)                                                   // left: ended
  files['/wb/stats.json'] = JSON.stringify({ live: false })
  await ui.press({ key: 'tab-stats' })
  await clock.advance(31_000)
  await new Promise(r => setTimeout(r, 30))
  expect(starts).toBe(1)                                                 // Live view off: never started
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text === 'Now')).toBe(false)
  await ui.press({ key: 'tab-tasks' })
  await ui.unmount()
})

test('a failing wb stats or wb top is tried again after a while, not at every poll, and says why', async ($, on) => {
  // #553: a failed full-history read ran again at every 1.5 s poll while a task ran, and the tab
  // said "Reading…" forever; a wb top that ended at once was restarted every 30 s, its stderr dropped
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = { '/wb/results.jsonl': '{}\n' }
  task(files, 'fix-it', 'running')                                        // polls every 1.5 s
  const pane = fakeTasks(on, files, ['fix-it'], true, [], false)
  let stats = 0, tops = 0
  on('process.run', (_: any, e: any) => {
    if (e.argv[1] === 'stats' && e.argv[2] === '--json') {
      stats += 1
      return { value: { exitCode: 1, stdout: '', stderr: 'Traceback (most recent call last):\nValueError: a bad row\n' } }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('process.spawn', async function* (_: any, e: any) {
    if (e.argv[1] !== 'top') {                                           // wb events, as fakeTasks's
      yield { stream: 'stdout', text: '{"hello": 4242}\n' }
      await new Promise(() => {})
    }
    tops += 1
    yield { stream: 'stderr', text: "wb: invalid choice: 'top'\n" }        // an older wb on PATH
    return { value: { code: 2, signal: null } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  pane.show(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 200 } })
  await ui.press({ key: 'tab-stats' })
  await clock.advance(29_000)
  expect(stats).toBe(1)                                                   // not twenty
  let texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('History unavailable: ValueError: a bad row (wb stats --json)')
  expect(tops).toBe(1)
  expect(texts.some(t => t.includes("can't be read"))).toBe(false)        // once may be a blip
  await clock.advance(2_000)
  expect(tops).toBe(2)
  texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain("This machine can't be read: wb: invalid choice: 'top' (wb top --json)")
  await clock.advance(30_000)                                             // 61 s in
  expect(tops).toBe(2)                                                    // its wait doubled
  expect(stats).toBe(2)                                                   // 60 s after the first
  await clock.advance(117_000)
  expect(stats).toBe(2)                                                   // and then 120 s
  await clock.advance(3_000)
  expect(stats).toBe(3)
  await ui.press({ key: 'tab-tasks' })
  await ui.unmount()
})

test('the history keeps its last feed when a read fails, and says it is not updated', () => {
  expect(statsLines(null, 'timed out')).toEqual([{ label: '', text: 'History unavailable: timed out (wb stats --json)' }])
  expect(statsLines({ tasks: 1, periods: { week: { tasks: 1, landed: 1 } } }, 'timed out'))
    .toEqual([{ label: '', text: 'Not updated: timed out (wb stats --json)' }, { label: 'This week', text: '1 task · 1 landed' }])
})

test('a poll and tab presses at once start one wb top, and leaving ends every one started (#546)', { timeoutMs: 20_000 }, async ($, on) => {
  // two syncTops at once both saw no child across the clock's await and both spawned; only the
  // second was ended by a close, the first ran on beside the next one, and both fed the sparkline
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = { '/wb/results.jsonl': '' }
  const pane = fakeTasks(on, files, [], true, [], false)
  let starts = 0, ends = 0, most = 0
  on('process.spawn', async function* (_: any, e: any) {
    if (e.argv[1] !== 'top') {
      yield { stream: 'stdout', text: '{"hello": 4242}\n' }
      await new Promise(() => {})
    }
    starts += 1
    most = Math.max(most, starts - ends)
    const stall = starts === 2                                           // the second is slow to print
    try {
      for (;;) {
        yield { stream: 'stdout', text: JSON.stringify(TICK) + '\n' }
        await new Promise(r => setTimeout(r, stall ? 60 : 5))
      }
    } finally {
      ends += 1
    }
  })
  on('process.run', (_: any, e: any) => ({ value: { exitCode: 0, stdout: e.argv[1] === 'stats' ? JSON.stringify({ tasks: 0 }) : '', stderr: '' } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  pane.show(true)
  await clock.advance(31_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 200 } })
  await Promise.all([ui.press({ key: 'tab-stats' }), ui.press({ key: 'tab-stats' }), clock.advance(31_000)])
  await new Promise(r => setTimeout(r, 40))
  expect(starts).toBe(1)
  for (let i = 0; i < 3; i++) {                                          // away and back at once, over and over
    await Promise.all([ui.press({ key: 'tab-tasks' }), ui.press({ key: 'tab-stats' })])
    await Promise.all([ui.press({ key: 'tab-stats' }), clock.advance(31_000)])
    await new Promise(r => setTimeout(r, 150))
    expect(starts - ends).toBeLessThanOrEqual(1)                         // never one left running beside it
  }
  await ui.press({ key: 'tab-tasks' })
  await new Promise(r => setTimeout(r, 150))
  expect(starts - ends).toBe(0)                                          // each one started is ended
  expect(most).toBeLessThanOrEqual(2)                                    // one ending as the next starts, no more
  await ui.unmount()
})

test('a live view the engine put away starts again as soon as the pane is back, without its old tick (#552)', { timeoutMs: 20_000 }, async ($, on) => {
  // its own loop's break was booked as a crash: no wb top for 30 s, and the last tick drawn as Now
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = { '/wb/results.jsonl': '' }
  const pane = fakeTasks(on, files, [], true, [], false)
  let starts = 0, ends = 0
  on('process.spawn', async function* (_: any, e: any) {
    if (e.argv[1] !== 'top') {
      yield { stream: 'stdout', text: '{"hello": 4242}\n' }
      await new Promise(() => {})
    }
    starts += 1
    const first = starts === 1
    try {
      if (!first) await new Promise(r => setTimeout(r, 100))           // later ones are slow to their first line
      for (;;) {
        yield { stream: 'stdout', text: JSON.stringify(first ? TICK : { ...TICK, running: [] }) + '\n' }
        await new Promise(r => setTimeout(r, 5))
      }
    } finally {
      ends += 1
    }
  })
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  on('process.run', (_: any, e: any) => ({ value: { exitCode: 0, stdout: e.argv[1] === 'stats' ? JSON.stringify({ tasks: 0 }) : '', stderr: '' } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })  // workbench mode on
  await clock.advance(31_000)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 200 } })
  await ui.press({ key: 'tab-stats' })
  await new Promise(r => setTimeout(r, 30))
  expect(starts).toBe(1)
  const said = async () => (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect((await said()).some(t => t.includes('fix-it Model M · running'))).toBe(true)
  pane.show(false)                                                       // the engine puts it away
  await new Promise(r => setTimeout(r, 30))
  expect(ends).toBe(1)                                                   // ended within a tick
  expect((await said()).some(t => t.includes('fix-it'))).toBe(false)      // and its tick forgotten
  await ui.unmount()
  await clock.advance(5_000)
  pane.show(true)                                                        // and draws it again 5 s on
  ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 200 } })
  await clock.settle()
  expect(starts).toBe(2)                                                 // at once, not 30 s later
  expect((await said()).some(t => t.includes('fix-it'))).toBe(false)      // the old tick isn't Now
  expect((await said())).toContain('Reading this machine…')
  pane.show(false)
  await new Promise(r => setTimeout(r, 150))
  expect(ends).toBe(2)
  await ui.unmount()
  // /workbench again while in workbench mode (no poll of its own) brings the pane back, and the
  // live view with it
  await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })
  await clock.settle()
  expect(starts).toBe(3)
  await new Promise(r => setTimeout(r, 30))
  ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 200 } })
  await ui.press({ key: 'tab-tasks' })
  await new Promise(r => setTimeout(r, 150))
  expect(ends).toBe(3)
  await ui.unmount()
})

test('a card wb top knows but has no reading for says so, not nothing (#547)', () => {
  const text = (gpus: any[]) => liveLines({ snap: { ts: 0, every: 2, gpus, running: [], rack: [], queue: [] }, busy: {} } as any)
    .map(r => r.map(p => p.text).join(''))
  expect(text([{ index: 0, name: 'NVIDIA GeForce RTX 4090', driver: 'nvidia', stale: true }])[0]).toBe('GPU 0 NVIDIA GeForce RTX 4090 no reading ')
})

test('an idle Apple silicon Mac draws its RAM in use against all its RAM and names the GPU limit beside it (#701)', () => {
  const lines = liveLines({ snap: { ts: 0, every: 2, running: [], rack: [], queue: [],
    gpus: [{ name: 'Apple M2 (10-core GPU)', unified: true, total: 16 * 2 ** 30, used: 11.12 * 2 ** 30,
      limit: 10.67 * 2 ** 30 }] }, busy: {} } as any)
  const row = lines[0]
  expect(row[2].color).toBe('success')  // under 80%: the GPU isn't full
  expect(row.map(p => p.text).join('')).toContain(' 11.1/16.0 GiB · GPU may wire 10.7 GiB ')
})

test('a model all in RAM on a machine with no GPU memory is in RAM, not split (#551)', () => {
  const lines = liveLines({ snap: { ts: 0, every: 2, gpus: [], running: [], queue: [],
    rack: [{ model: 'ollama/m', label: 'M', state: 'cpu', cpu_bytes: 2 ** 33 }] }, busy: {} } as any)
  const row = lines.find(r => r.some(p => p.text.startsWith('M ')))!
  expect(row.map(p => p.text).join('')).toBe('● M cpu 8.0 GiB in RAM')
  expect(row[0].color).toBe('success')
})

test('a card is named by its product, never the vendor tag, as wb top names it (#576)', () => {
  const amd = 'Advanced Micro Devices, Inc. [AMD/ATI]'
  expect(cardName(`${amd} Phoenix1 (rev c4)`)).toBe('Phoenix1')
  expect(cardName(`${amd} Device 1586 (rev c1)`)).toBe('Device 1586')
  expect(cardName(`${amd} Navi 48 [Radeon RX 9070 XT] (rev c0)`)).toBe('Radeon RX 9070 XT')
  expect(cardName('NVIDIA GeForce RTX 4090')).toBe('NVIDIA GeForce RTX 4090')
})

test('the history says nothing it has no data for, and a new install how to begin', () => {
  expect(statsLines(null)).toEqual([{ label: '', text: 'Reading the history…' }])
  expect(statsLines({ tasks: 0 })[0].text).toMatch(/^No finished tasks yet/)
  // #549: optimized and benched before the first judged task, the tab said only the placeholder
  const early = statsLines({ ts: 1, until: 2, settings: {}, tasks: 0,
    optimized: { 'ollama/x': { window: 32768, fits: true } }, bench: { 'ollama/x': { run: 'r1', day: '2026-11-20', passed: 3, of: 4 } } })
  expect(early).toEqual([{ label: 'Bench', text: 'ollama/x 3/4 (2026-11-20)' },
    { label: 'Optimized', text: 'ollama/x 32K all on the GPU' }])
  // #609: the energy's cost labelled as the footer and `wb savings` label it, no bare "(0.27)"
  expect(statsLines({ tasks: 1, periods: { week: { tasks: 1, landed: 1, energy: { wh: 900, cost: 0.27 } } } })[0].text)
    .toContain('900 Wh, cost 0.27')
  const lines = statsLines({ tasks: 1, periods: { week: { tasks: 1, landed: 1, accepted_pct: 100 } } })
  expect(lines).toEqual([{ label: 'This week', text: '1 task · 1 landed (100%)' }])   // no savings, no zeros
  expect(spark([0, 0])).toBe('')
  expect(spark([1, 4, 8])).toBe('▂▅█')
  expect(priceOf('{"price": 0.3}')).toBe(0.3)
  // #609: a decimal comma and a currency sign or code before or after; empty clears; no hex
  for (const typed of ['0,30', '€0.30', '0.30 EUR', '$0.3', ' 0.3 ', '0.30€', 'kr 0,3', '.3'])
    expect(parsePrice(typed)).toBe(0.3)
  expect(parsePrice('')).toBe('off')
  for (const typed of ['0x10', '1e3', 'cheap', '0', '-0.3', '1,000.50', '0.3.1'])
    expect(parsePrice(typed)).toBe(null)
  expect(priceOf('{"price": null}')).toBe(null)
  expect(priceOf('not json')).toBe(null)
})

test('the history claims no more fixed or answered than the feed confirms', () => {
  // #562: two failed auto-fix rounds read "fixed by the agent", a timed-out question "answered"
  const said = (f: any) => statsLines({ tasks: 1, ...f }).map(l => `${l.label}: ${l.text}`)
  const lines = said({ absorbed: { auto_fixes: 2 }, questions: { asked: 1 } })
  expect(lines).toContain('Without waking Claude: 2 test failures sent back to the agent')
  expect(lines).toContain('Questions: 1 asked mid-task')
  expect(lines.join('\n')).not.toMatch(/fixed|answered/)
  expect(said({ absorbed: { auto_fixes: 3, auto_fixed_tasks: 1 }, questions: { asked: 3, answered: 1 } }))
    .toEqual(['Without waking Claude: 3 test failures sent back to the agent (1 task then green)',
      'Questions: 3 asked mid-task · 1 answered'])
})

test('a period says the spec-gap discards its saving counts beside its task count', () => {
  // #569: "cost ~115K more Claude tokens · 0 tasks · 0 landed" for a period of one such discard
  const lines = statsLines({ tasks: 0, periods: { week: { tasks: 0, landed: 0, spec_gaps: 1,
    savings: { saved: -115_000, tasks: 1 } } } })
  expect(lines[0]).toEqual({ label: 'This week',
    text: 'cost ~115K more Claude tokens (estimate) · 0 tasks · 0 landed · and 1 discard put down to the spec' })
})

test('a period\'s energy is every task\'s, compared by the saving or not', () => {
  // #568: three tasks used 287 Wh and the tab said 12, the one task the saving could compare
  const week = (p: any) => statsLines({ tasks: 3, periods: { week: { tasks: 3, landed: 3, accepted_pct: 100, ...p } } })[0].text
  expect(week({ savings: { saved: 5000, wh: 12, cost: 0 }, energy: { wh: 287, cost: 0.09 } }))
    .toBe('saved ~5K Claude tokens (estimate) · 3 tasks · 3 landed (100%) · 287 Wh, cost 0.09')
  expect(week({ energy: { wh: 1500 } })).toBe('3 tasks · 3 landed (100%) · 1.5 kWh')  // nothing compared
})

test('a bench run still going or cut short shows beside the last finished one, never in its place', () => {
  // #570: the newest run's first graded case read "M 1/1" as the model's result
  const bench = (b: any) => statsLines({ tasks: 1, bench: { M: b } }).find(l => l.label === 'Bench')?.text
  expect(bench({ run: 'r1', day: '2026-11-18', passed: 8, of: 10,
    partial: { run: 'r2', day: '2026-11-20', passed: 1, of: 1, planned: 10, running: true } }))
    .toBe('M 8/10 (2026-11-18), newer run 1 of 10 so far, 1 passed')
  expect(bench({ partial: { run: 'r2', day: '2026-11-20', passed: 0, of: 2, planned: 10, running: false } }))
    .toBe('M newer run 2 of 10 before it stopped, 0 passed')
  expect(bench({ run: 'r1', day: '2026-11-18', passed: 8, of: 10 })).toBe('M 8/10 (2026-11-18)')
})

test('a one-task exception shows beside its task and is under way from Claude\'s first edit', async ($, on) => {
  // #94: the next hand-back spends it once Claude has started on it
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const ts = 1_800_000_000
  const files: Record<string, string> = {
    '/wb/coding.json': JSON.stringify({ mode: 'only' }),
    '/wb/tasks/fix-it/task.json': JSON.stringify({ name: 'fix-it', model: 'm', created_at: ts }),
    '/wb/tasks/fix-it/status.json': JSON.stringify({ phase: 'review', round: 2, updated_at: ts }),
    '/wb/tasks/fix-it/coding.json': JSON.stringify({ allowed: [
      { edit: 'divide by 1000', said: 'ok', when: 'the next try still shows kW as W', used: null }] }),
  }
  fakeTasks(on, files)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('tool.call', () => ({ result: {}, text: '' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const said = (await ui.findAll({ type: 'Text' })).map(t => t.text.trim()).join(' ')
  expect(said).toContain('Claude may, once, if the next try still shows kW as W: divide by 1000')  // whole, wrapped
  await ui.unmount()
  const r = await $.tool.call({ tool: 'Edit', file_path: '/wb/tasks/fix-it/worktree/power.py', old_string: 'w', new_string: 'w / 1000' } as any) as any
  expect(r.deny).toBeUndefined()
  expect(JSON.parse(files['/wb/tasks/fix-it/coding.json']).allowed[0].started).toBe(1_800_000_003)
  await clock.advance(1000)                                        // the poll the call started settles
})

test('the strip above the prompt stays the engine\'s until the user closes the pane', async ($, on) => {
  // the user, 2026-11-19: closed by hand the pane minimizes to a strip, as backseat-driver's. A test
  // can't raise the person's ui.close, so this holds the other half: no strip while it is up
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  fakeTasks(on, {}, [])
  on('skill.prompt', (_: any, e: any) => ({ text: e.text }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  const BAND = { plugin: 'workbench', component: 'AbovePrompt', requestId: 'above-prompt', props: { bodyColumns: 120 } } as any
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.skill.prompt({ skill: 'workbench', text: 'x', frontmatter: {}, source: 'userSettings' })
  await clock.advance(1000)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'restore' })).toBeUndefined()
  expect((await band.find({ type: 'Text' }))?.text).toBe('engine')
  await band.unmount()
})

test("a web message's attachments reach Claude as one path each, with size and type (#623)", () => {
  expect(attachedLines(undefined)).toBe('')
  expect(attachedLines([{ id: 'a', name: 'p.jpg', size: 2_202_009, type: 'image/jpeg', path: '/s/chat/uploads/a/p.jpg' },
    { id: 'b', name: 'n.txt', size: 300, type: 'text/plain', path: '/s/chat/uploads/b/n.txt' }, { id: 'c' }]))
    .toBe('\n[attached: /s/chat/uploads/a/p.jpg (2.1 MB, image/jpeg)]\n[attached: /s/chat/uploads/b/n.txt (300 B, text/plain)]')
})

test('the stats tab folds a model with its window variants, newest first, and sums up the older ones', () => {
  // #638: every model that ever ran a task, forever, each wb optimize window on its own line
  const said = (f: any) => statsLines({ tasks: 40, ...f }).map(l => `${l.label}: ${l.text}`)
  const lines = said({
    models: { 'ollama/q': { tasks: 1, accepted_pct: 0 }, 'strata/strata': { tasks: 1, accepted_pct: 0 } },
    model_lines: {
      lines: [{ model: 'ollama/q', windows: [32768, 40960, 65536], tasks: 37, accepted_pct: 94 },
        { model: 'ollama/small', windows: [32768], tasks: 2, accepted_pct: 50 }],
      older: { models: 2, tasks: 4 },
    },
  })
  expect(lines).toContain('ollama/q (32K, 40K, 64K): 37 tasks · 94% landed')
  expect(lines).toContain('ollama/small: 2 tasks · 50% landed')
  expect(lines).toContain('Other models: 2 older models: 4 tasks (wb stats --all)')
  expect(lines.join('\n')).not.toMatch(/strata/)
  expect(lines.indexOf('ollama/q (32K, 40K, 64K): 37 tasks · 94% landed'))
    .toBeLessThan(lines.indexOf('ollama/small: 2 tasks · 50% landed'))
  expect(said({ models: { 'ollama/old': { tasks: 3, accepted_pct: 67 } } }))  // an older wb's feed
    .toContain('ollama/old: 3 tasks · 67% landed')
})

// The owner, 2026-11-21: "some people experiment a lot and have a ton of models on their boxes
// ... they'd have to scroll a lot down to find the menu and get back to Tasks or Settings again.
// I just really don't want this to be the first impression users face."
const MANY = (n: number) => Array.from({ length: n }, (_, i) => `ollama/m${i}`)
const tabFeed = (ids: string[], more?: any) => ({
  ts: 1, until: 2, settings: {}, tasks: 400,
  periods: { week: { tasks: 12, landed: 10, accepted_pct: 83 }, all: { tasks: 400, landed: 330, accepted_pct: 83 } },
  streak: { current: 3, best: 9 }, absorbed: { auto_fixes: 4, auto_fixed_tasks: 2 }, questions: { asked: 2 },
  models: Object.fromEntries(ids.map(m => [m, { tasks: 13, accepted_pct: 80 }])),
  model_lines: { lines: ids.slice(0, 3).map((m, i) => ({ model: m, variants: [m], windows: [32768], last: 100 - i, tasks: 13, accepted_pct: 80 })),
    ...(more ? { more } : {}) },
  sizes: { trivial: { tasks: 300, accepted_pct: 90 }, small: { tasks: 100, accepted_pct: 60 } },
  days: [{ day: '2026-11-20', tasks: 3, landed: 2 }, { day: '2026-11-21', tasks: 5, landed: 4 }],
  bests: { fastest: { minutes: 2, task: 'quick' } }, milestones: [{ kind: 'landed', n: 300, day: '2026-11-19' }],
  guards: { repeat: 3 },
  helps: Object.fromEntries(ids.map(m => [m, { hint: [2, 3] }])),
  bench: Object.fromEntries(ids.map(m => [m, { run: 'r1', day: '2026-11-20', passed: 7, of: 10 }])),
  optimized: Object.fromEntries(ids.map(m => [m, { window: 32768, fits: true }])),
})
const tabTop = (ids: string[]) => ({ busy: {}, snap: { ts: 0, every: 2, queue: [],
  gpus: [{ index: 0, name: 'GPU', used: 2 ** 33, total: 2 ** 34 }],
  running: [{ task: 'fix-it', label: ids[0], phase: 'working', round: 1 }],
  rack: ids.map((m, i) => ({ model: m, label: m, state: i === 0 ? 'resident' : ["idle", "can't run", 'remote'][i % 3],
    ...(i === 0 ? { tasks: ['fix-it'] } : {}) })) } }) as any
const text = (rows: any[][]) => rows.map(r => r.map(p => p.text).join(''))

test('the stats tab stays under 25 rows with 30 models, the rest folded and counted (2026-11-21)', () => {
  const ids = MANY(30)
  const now = text(liveLines(tabTop(ids)))
  const history = statsLines(tabFeed(ids, { models: 27, tasks: 351 })).map(l => `${l.label}: ${l.text}`)
  expect(now.length + history.length).toBeLessThanOrEqual(25)
  expect(now).toContain("+29 more models idle, can't run or remote (wb top)")
  expect(now.some(r => r.includes('ollama/m0 resident') && r.includes('← fix-it'))).toBe(true)
  expect(now.some(r => r.startsWith('○ ollama/m1 '))).toBe(false)
  expect(history).toContain('Other models: 27 more models: 351 tasks (wb stats --all)')
  expect(history.filter(l => /^ollama\/m\d+/.test(l))).toHaveLength(3)
  expect(history.find(l => l.startsWith('Optimized:'))).toBe('Optimized: ' +
    ['m0', 'm1', 'm2'].map(m => `ollama/${m} 32K all on the GPU`).join(' · ') + ' · 27 more (wb optimize report)')
  expect(history.find(l => l.startsWith('Bench:'))).toMatch(/ollama\/m2 7\/10 \(2026-11-20\) · 27 more \(wb bench report\)$/)
  // the rest of What helps on a row of its own, not on m2's
  expect(history.filter(l => l.startsWith('What helps'))).toEqual([...['m0', 'm1', 'm2'].map(m =>
    `What helps (ollama/${m}): a hint helped 2 of 3`), 'What helps: 27 more models (wb stats --json)'])
  // none of the shown models has an entry: the others counted, with where to see them
  const others = statsLines({ ...tabFeed(ids, { models: 27, tasks: 351 }), helps: { 'ollama/m9': { hint: [1, 2] } },
    bench: { 'ollama/m9': { run: 'r1', day: '2026-11-20', passed: 1, of: 2 } }, optimized: { 'ollama/m9': { window: 32768 } } })
    .map(l => `${l.label}: ${l.text}`)
  expect(others).toContain('Bench: 1 model (wb bench report)')
  expect(others).toContain('Optimized: 1 model (wb optimize report)')
  expect(others.filter(l => l.startsWith('What helps'))).toEqual(['What helps: 1 model (wb stats --json)'])
  // the recent and the older ones on one row, a part that is 0 left out
  const both = statsLines({ tasks: 40, model_lines: { lines: [], more: { models: 2, tasks: 36 }, older: { models: 3, tasks: 4 } } })
  expect(both).toContainEqual({ label: 'Other models', text: '2 more · 3 older models: 40 tasks (wb stats --all)' })
})

test("an older wb's feed of 30 model lines still draws 3 of them and counts the rest (2026-11-21)", () => {
  // the mod tracks main's commits, wb runs from the user's clone: a wb from before the cap sends
  // every line and no `more`, an older one only `models`
  const ids = MANY(30)
  const uncapped = { ...tabFeed(ids), model_lines: { lines: ids.map((m, i) =>
    ({ model: m, variants: [m], windows: [32768], last: 100 - i, tasks: 13, accepted_pct: 80 })) } }
  const { model_lines: _, ...bare } = tabFeed(ids)
  for (const f of [uncapped, bare]) {
    const history = statsLines(f).map(l => `${l.label}: ${l.text}`)
    expect(history.filter(l => /^ollama\/m\d+/.test(l))).toHaveLength(3)
    expect(history).toContain('Other models: 27 more models: 351 tasks (wb stats --all)')
    expect(history.find(l => l.startsWith('Optimized:'))).toMatch(/ollama\/m2 32K all on the GPU · 27 more \(wb optimize report\)$/)
    expect(history).toContain('What helps: 27 more models (wb stats --json)')
    expect(history.length).toBeLessThanOrEqual(20)
  }
})

test('a machine with two models draws the stats tab as before the fold (2026-11-21)', () => {
  const ids = MANY(2)
  const now = text(liveLines({ ...tabTop(ids), snap: { ...tabTop(ids).snap, running: [],
    rack: ids.map(m => ({ model: m, label: m, state: 'idle' })) } }))
  expect(now).toEqual(['GPU 0 GPU ██████░░░░░░ 8.0/16.0 GiB ', 'Nothing running.', '○ ollama/m0 idle', '○ ollama/m1 idle'])
  const history = statsLines(tabFeed(ids)).map(l => `${l.label}: ${l.text}`)
  expect(history.some(l => /more|older|wb (bench|optimize) report|wb top/.test(l))).toBe(false)
  expect(history).toContain('Optimized: ollama/m0 32K all on the GPU · ollama/m1 32K all on the GPU')
  expect(history).toContain('Bench: ollama/m0 7/10 (2026-11-20) · ollama/m1 7/10 (2026-11-20)')
  expect(history.filter(l => l.startsWith('What helps'))).toHaveLength(2)
})
