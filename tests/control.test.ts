import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionContextBreakdown, SessionMessage } from 'claude-code'

const WINDOW = 1_000_000

const BREAKDOWN: SessionContextBreakdown = {
  categories: [
    { name: 'System prompt', tokens: 6_200, color: 'inactive', isDeferred: false, kind: 'used' },
    { name: 'MCP tools', tokens: 21_300, color: 'inactive', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 72_500, color: 'inactive', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 867_000, color: 'inactive', isDeferred: false, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
  ],
  totalTokens: 100_000,
  maxTokens: WINDOW,
  rawMaxTokens: WINDOW,
  autocompactSource: 'auto',
  percentage: 10,
  gridRows: [],
  model: 'Opus 5.5',
  memoryFiles: [{ path: 'C:/Users/me/.claude/CLAUDE.md', type: 'User', tokens: 2_400 }],
  mcpTools: [
    { name: 'mcp__docs__read', serverName: 'docs', tokens: 6_100, isLoaded: true },
    { name: 'mcp__docs__write', serverName: 'docs', tokens: 1_000, isLoaded: true },
  ],
  agents: [],
  autoCompactThreshold: 967_000,
  isAutoCompactEnabled: true,
  apiUsage: null,
}

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 19 },
  view: {},
}

const ctx = (tokens: number | undefined) => ({ tokens, window: WINDOW, percent: tokens === undefined ? undefined : Math.round((tokens / WINDOW) * 100) })

const SUMMARY: SessionMessage[] = [{ role: 'user', text: 'Summary of the conversation so far', toolUses: [] }]

function engine(on: On, state: { tokens: number | undefined }, o: { saved?: Record<string, unknown>; breakdownAfter?: Promise<void> } = {}) {
  const toasts: string[] = []
  // A store of the test's own, so a test can read what the mod saved.
  const store = new Map<string, unknown>(Object.entries(o.saved ?? {}))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined } as never
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.turns', () => ({ value: 4 }))
  on('session.usage', async ($, e) => {
    if (!e.breakdown) return { value: { startedAt: 0, rateLimits: [], context: ctx(state.tokens) } }
    await o.breakdownAfter
    return { value: { startedAt: 0, rateLimits: [], context: { ...ctx(state.tokens), breakdown: BREAKDOWN } } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('session.messages', () => ({ value: SUMMARY }) as never)
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  return { toasts, store, clock }
}

async function start($: Engine) {
  await $.session.start({ source: 'startup', cwd: 'C:/work', surface: 'desktop', isInteractive: true } as never)
}

/** Starts the session and lets the start hook's unawaited reads finish. */
async function startSettled($: Engine, clock: { settle: () => Promise<void> }) {
  await start($)
  await clock.settle()
}

async function measure($: Engine, tokens: number) {
  await $.session.measure({ context: ctx(tokens), rateLimits: [], changed: ['context'] })
}

test('the band shows fill, growth and turns until auto-compact on both surfaces', async ($, on) => {
  const state = { tokens: 100_000 }
  const { clock } = engine(on, state)
  await start($)
  await measure($, 100_000)
  state.tokens = 110_000
  await measure($, 110_000)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-control', surface, component: 'AbovePrompt', props: BAND })
    expect((await ui.find({ key: 'toggle' }))?.text).toMatch(/11%/)
    expect((await ui.find({ key: 'toggle-tokens' }))?.text).toMatch(/110\.0k \/ 1M/)
    expect((await ui.find({ key: 'toggle-last' }))?.text).toMatch(/\+10\.0k last turn/)
    expect(await ui.find({ text: /auto-compact in ~86 turns/ })).toBeDefined()
    await ui.press({ key: 'toggle' })
    await clock.advance(500)
    expect(await ui.find({ text: /What fills it/ })).toBeDefined()
    expect(await ui.find({ text: /auto-compact at 967\.0k/ })).toBeDefined()
    await ui.press({ key: 'toggle' })
    await clock.advance(500)
    await ui.unmount()
  }
})

test('the band draws from the plain usage before the breakdown arrives', async ($, on) => {
  let release = () => {}
  const breakdownAfter = new Promise<void>(resolve => (release = resolve))
  const { clock } = engine(on, { tokens: 100_000 }, { breakdownAfter })
  await startSettled($, clock)

  const ui = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect((await ui.find({ key: 'toggle' }))?.text).toMatch(/10%/)
  expect((await ui.find({ key: 'toggle-tokens' }))?.text).toMatch(/100\.0k \/ 1M/)
  expect(await ui.find({ text: /What fills it|auto-compact/ }), 'no breakdown yet').toBeUndefined()
  release()
  await ui.unmount()
})

test('before the first reply the band shows the breakdown estimate, marked ~', async ($, on) => {
  const { clock } = engine(on, { tokens: undefined })
  await startSettled($, clock)

  const ui = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect((await ui.find({ key: 'toggle' }))?.text).toMatch(/~10%/)
  expect((await ui.find({ key: 'toggle-tokens' }))?.text).toMatch(/~100\.0k \/ 1M/)
  // Avg ~ 72.5k messages over 4 prompts = 18.1k; (967k - 100k) / 18.1k = 48 turns.
  expect(await ui.find({ text: /auto-compact in ~48 turns/ })).toBeDefined()
  await ui.press({ key: 'toggle' })
  expect(await ui.find({ text: /~18\.1k/ })).toBeDefined()
  await ui.unmount()
})

test('a resumed session keeps its history: Last turn and Avg show at once', async ($, on) => {
  const saved = { 'history:abc': { at: 0, points: [{ tokens: 100_000 }, { tokens: 110_000 }] } }
  const { clock } = engine(on, { tokens: 110_000 }, { saved })
  await startSettled($, clock)

  const ui = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect((await ui.find({ key: 'toggle-last' }))?.text).toMatch(/\+10\.0k last turn/)
  expect(await ui.find({ text: /auto-compact in ~86 turns/ })).toBeDefined()
  await ui.unmount()
})

test('turns the mod did not watch are a gap: no Last turn, Avg kept', async ($, on) => {
  const saved = { 'history:abc': { at: 0, points: [{ tokens: 100_000 }, { tokens: 110_000 }] } }
  const { clock } = engine(on, { tokens: 150_000 }, { saved })
  await startSettled($, clock)

  const ui = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ key: 'toggle-last' }), 'no Last turn after a gap').toBeUndefined()
  expect(await ui.find({ text: /auto-compact in ~82 turns/ })).toBeDefined()
  await ui.unmount()

  await measure($, 160_000)
  const after = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect((await after.find({ key: 'toggle-last' }))?.text).toMatch(/\+10\.0k last turn/)
  await after.unmount()
})

test('histories are saved per session and only the newest 20 are kept', async ($, on) => {
  const saved = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`history:old${i}`, { at: i, points: [{ tokens: 1 }] }]))
  const { clock, store } = engine(on, { tokens: 100_000 }, { saved })
  await startSettled($, clock)
  await measure($, 120_000)

  const keys = [...store.keys()].filter(k => k.startsWith('history:'))
  expect(keys).toHaveLength(20)
  expect(keys).toContain('history:abc')
  expect(keys).not.toContain('history:old0')
  expect((store.get('history:abc') as { points: unknown[] }).points).toEqual([{ tokens: 100_000 }, { tokens: 120_000 }])
})

test('compact waits while Claude is working, then runs /compact with the focus and records it', async ($, on) => {
  const state = { tokens: 500_000 }
  const { clock, toasts } = engine(on, state)
  let args: string | undefined
  // Core's /compact, run past this plugin's own session.compact hook as the caller's: the button records it.
  on('command.run', { command: 'compact' }, ($, e) => {
    args = e.args
    return {}
  })
  await start($)
  await measure($, 500_000)

  const busy = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: { ...BAND, isWorking: true } })
  expect(await busy.find({ key: 'compact' }), 'no Compact button mid-turn').toBeUndefined()
  expect(await busy.find({ text: 'Compact after this turn' }), 'waiting note').toBeDefined()
  await busy.unmount()

  const ui = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'compact' })
  expect(await ui.find({ key: 'go' }), 'the field holds the one Compact button').toBeUndefined()
  await ui.input({ key: 'focus', text: 'keep the plan', kind: 'change' })
  await ui.input({ key: 'focus', text: 'keep the plan', kind: 'submit' })
  await clock.settle()
  expect(args).toBe('keep the plan')
  expect(await ui.find({ text: /Compacted/ }), JSON.stringify(toasts)).toBeDefined()
  await ui.unmount()
})

test('where /compact cannot run, Compact says so and the band goes back to its figures', async ($, on) => {
  const state = { tokens: 500_000 }
  const { toasts, clock } = engine(on, state)
  on('command.run', { command: 'compact' }, () => {
    throw new Error('no command runner here')
  })
  await start($)
  await measure($, 500_000)

  const ui = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'compact' })
  await ui.input({ key: 'focus', text: 'keep the plan', kind: 'submit' })
  await clock.settle()
  expect(toasts[0]).toMatch(/^Couldn't compact:/)
  expect(await ui.find({ key: 'toggle-tokens' }), 'figures back, not stuck on Compacting').toBeDefined()
  await ui.unmount()
})

test('crossing the alert threshold toasts once', async ($, on) => {
  const state = { tokens: 100_000 }
  const { toasts } = engine(on, state)
  await start($)
  await measure($, 100_000)
  await measure($, 850_000)
  await measure($, 860_000)
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/^Context at 85% — auto-compact in ~1 turn$/)
})

test('a snapshot is written before compaction when turned on', async ($, on) => {
  const state = { tokens: 300_000 }
  engine(on, state)
  const written = new Map<string, string>()
  on('session.cwd', () => ({ value: 'C:\\work' }))
  on('session.model', () => ({ value: 'Opus 5.5' }))
  on('fs.exists', ($, e) => ({ value: written.has(e.path) }))
  on('fs.write', ($, e) => {
    written.set(e.path, e.text)
    return { value: undefined } as never
  })
  on('session.compact', () => ({ messages: SUMMARY, tokensBefore: 300_000, tokensAfter: 30_000 }))
  await start($)
  await measure($, 300_000)

  const pane = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'Pane', requestId: 'context-control', props: { title: 'Context', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never })
  await pane.press({ key: 'tab-settings' })
  await pane.press({ key: 'set-snapshot' })
  await pane.unmount()

  const messages: SessionMessage[] = [
    { role: 'user', text: 'Build the context control', toolUses: [] },
    { role: 'assistant', text: 'On it', toolUses: [{ tool_use_id: '1', tool: 'Edit', input: { file_path: 'C:\\work\\a.ts' } }] },
  ]
  await $.session.compact({ trigger: 'manual', instructions: 'keep the plan', messages })
  const file = [...written.keys()].find(p => p.endsWith('.md'))
  expect(file).toMatch(/[\\/]\.claude[\\/]context-snapshots[\\/]2026-10-15_\d{6}\.md$/)
  expect(written.get(file!)).toContain('Build the context control')
  expect(written.get(file!)).toContain('C:\\work\\a.ts')
  const ignore = [...written.keys()].find(p => /[\\/]\.claude[\\/]context-snapshots[\\/]\.gitignore$/.test(p))
  expect(written.get(ignore!)).toBe('*\n')
})

test('a narrow band drops words, then figures, and keeps Compact and the arrow', async ($, on) => {
  const state = { tokens: 100_000 }
  engine(on, state)
  await start($)
  await measure($, 100_000)
  await measure($, 110_000)

  const narrow = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 70 } })
  expect((await narrow.find({ key: 'toggle-tokens' }))?.text).not.toMatch(/1M/)
  expect((await narrow.find({ key: 'toggle-last' }))?.text).not.toMatch(/last turn/)
  expect(await narrow.find({ text: /~86 turns left/ })).toBeDefined()
  expect(await narrow.find({ key: 'compact' })).toBeDefined()
  expect(await narrow.find({ key: 'chevron' })).toBeDefined()
  await narrow.unmount()

  const tiny = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 50 } })
  expect(await tiny.find({ key: 'toggle-last' })).toBeUndefined()
  expect(await tiny.find({ key: 'toggle-right' })).toBeUndefined()
  expect(await tiny.find({ key: 'compact' })).toBeDefined()
  expect(await tiny.find({ key: 'chevron' })).toBeDefined()
  await tiny.unmount()
})

test('any figure in the strip opens the details, and any line in them closes it', async ($, on) => {
  const state = { tokens: 100_000 }
  const { clock } = engine(on, state)
  await start($)
  await measure($, 100_000)
  await measure($, 110_000)

  const ui = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  for (const [open, close] of [['toggle-tokens', 'close-fills'], ['toggle-right', 'close-avg'], ['chevron', 'close-head']] as const) {
    await ui.press({ key: open })
    await clock.advance(500)
    expect(await ui.find({ key: close }), `${open} opens`).toBeDefined()
    await ui.press({ key: close })
    await clock.advance(500)
    expect(await ui.find({ key: close }), `${close} closes`).toBeUndefined()
  }
  await ui.unmount()
})

test('a redraw without a new reading does not replay the animations', async ($, on) => {
  const state = { tokens: 100_000 }
  const { clock } = engine(on, state)
  await start($)
  await measure($, 100_000)
  await measure($, 110_000)

  const fresh = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(JSON.stringify(await fresh.drawn()), 'a new reading grows the bar').toContain('<animate attributeName=\\"width\\"')
  await fresh.unmount()
  await clock.advance(5_000)

  const ui = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'toggle' })
  await clock.advance(500)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('What fills it')
  expect(drawn).not.toContain('<animate attributeName=\\"width\\"')
  expect(drawn).not.toContain('<animate attributeName=\\"opacity\\" values=\\"0;0;1\\"')
  await ui.unmount()
})

const textOf = (node: unknown): string =>
  typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : node && typeof node === 'object' ? textOf((node as { children?: unknown }).children ?? '') : ''

/**
 * Every Button in a drawn tree whose `label` differs from its children's text.
 * The engine fills `label` from the children, but the desktop draws a given label in their place.
 */
function labelledWithChildren(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) labelledWithChildren(n, found)
  } else if (node && typeof node === 'object') {
    const o = node as { type?: unknown; props?: { label?: unknown; key?: unknown }; children?: unknown }
    if (o.type === 'Button' && o.children !== undefined && o.props?.label !== textOf(o.children)) found.push(String(o.props?.key))
    for (const v of Object.values(node)) labelledWithChildren(v, found)
  }
  return found
}

test('no band Button draws a label other than its own text, collapsed or expanded', async ($, on) => {
  const state = { tokens: 100_000 }
  engine(on, state)
  await start($)
  await measure($, 100_000)
  await measure($, 110_000)

  const ui = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  const collapsed = await ui.drawn()
  expect(JSON.stringify(collapsed)).toContain('toggle-tokens')
  expect(labelledWithChildren(collapsed)).toEqual([])
  await ui.press({ key: 'toggle' })
  expect(labelledWithChildren(await ui.drawn())).toEqual([])
  await ui.unmount()
})

/** The pane's Settings tab reads these; register them before the test's first call. */
function paneMocks(on: On) {
  on('session.cwd', () => ({ value: 'C:\work' }))
  on('session.model', () => ({ value: 'Opus 5.5' }))
}

async function turnOn($: Engine, key: string) {
  const pane = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'Pane', requestId: 'context-control', props: { title: 'Context', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } } as never })
  await pane.press({ key: 'tab-settings' })
  await pane.press({ key: `set-${key}` })
  await pane.unmount()
}

test('a click anywhere opens the breakdown in stages from the strip, and a click on any row closes it', async ($, on) => {
  const state = { tokens: 100_000 }
  const { clock } = engine(on, state)
  paneMocks(on)
  await start($)
  await measure($, 100_000)
  await measure($, 110_000)

  const ui = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ key: 'toggle-tokens' }), 'the band draws its own figures').toBeDefined()
  expect(await ui.find({ key: 'compact' }), 'Compact stays a Button').toBeDefined()

  await ui.pointer({ type: 'down', x: 20, y: 0, button: 'left', in: 'click-strip' })
  await clock.advance(10)
  expect(await ui.find({ key: 'close-avg' }), 'the stage beside the strip shows first').toBeDefined()
  expect(await ui.find({ key: 'close-head' }), 'the top stage not yet').toBeUndefined()
  await clock.advance(500)
  expect(await ui.find({ key: 'close-head' }), 'every stage once it has run').toBeDefined()
  expect(await ui.find({ key: 'open-pane' }), 'the pane icon sits beside the arrow').toBeDefined()

  // A row in the middle of the panel, not the header.
  await ui.pointer({ type: 'down', x: 5, y: 0, button: 'left', in: 'click-row-6' })
  await clock.advance(500)
  expect(await ui.find({ key: 'close-avg' }), 'closed again').toBeUndefined()
  await ui.unmount()
})

test('the open breakdown fits the band without scrolling: spacing goes first, then legend rows', async ($, on) => {
  const state = { tokens: 100_000 }
  const { clock } = engine(on, state)
  await start($)
  await measure($, 100_000)
  await measure($, 110_000)

  const roomy = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await roomy.press({ key: 'toggle' })
  await clock.advance(500)
  expect(await roomy.find({ text: /more · \/context-control/ }), 'room for every row').toBeUndefined()
  await roomy.unmount()

  const tight = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: { ...BAND, maxRows: 8, bodyColumns: 60 } })
  expect(await tight.find({ key: 'close-head' }), 'still open').toBeDefined()
  expect(await tight.find({ key: 'close-avg' })).toBeDefined()
  expect(await tight.find({ text: /\+\d+ more · \/context-control for all/ })).toBeDefined()
  const outer = (await tight.drawn()) as { children?: unknown[] }
  const details = outer.children?.[0] as { children?: unknown[] }
  expect(details.children?.length ?? 0, 'rows above the strip').toBeLessThanOrEqual(7)
  await tight.unmount()
})

test('the arrow names itself on hover, small and dim, unless that is turned off', async ($, on) => {
  const state = { tokens: 100_000 }
  engine(on, state)
  paneMocks(on)
  await start($)
  await measure($, 100_000)

  const ui = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"size":"footnote"')
  expect(drawn).toContain('Show details')
  await ui.unmount()

  await turnOn($, 'arrowTooltip')
  const off = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(JSON.stringify(await off.drawn())).not.toContain('Show details')
  await off.unmount()
})
