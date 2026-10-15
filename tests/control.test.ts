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

const ctx = (tokens: number) => ({ tokens, window: WINDOW, percent: Math.round((tokens / WINDOW) * 100) })

const SUMMARY: SessionMessage[] = [{ role: 'user', text: 'Summary of the conversation so far', toolUses: [] }]

function engine(on: On, state: { tokens: number }) {
  const toasts: string[] = []
  mock.store(on)
  mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { ...ctx(state.tokens), breakdown: BREAKDOWN } } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('session.messages', () => ({ value: SUMMARY }) as never)
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  return { toasts }
}

async function start($: Engine) {
  await $.session.start({ source: 'startup', cwd: 'C:/work', surface: 'desktop', isInteractive: true } as never)
}

async function measure($: Engine, tokens: number) {
  await $.session.measure({ context: ctx(tokens), rateLimits: [], changed: ['context'] })
}

test('the band shows fill, growth and turns until auto-compact on both surfaces', async ($, on) => {
  const state = { tokens: 100_000 }
  engine(on, state)
  await start($)
  await measure($, 100_000)
  state.tokens = 110_000
  await measure($, 110_000)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-control', surface, component: 'AbovePrompt', props: BAND })
    expect((await ui.find({ key: 'toggle' }))?.text).toMatch(/11%.*110\.0k \/ 1M.*\+10\.0k last turn/)
    expect(await ui.find({ text: /auto-compact in ~86 turns/ })).toBeDefined()
    await ui.press({ key: 'toggle' })
    expect(await ui.find({ text: /What fills it/ })).toBeDefined()
    expect(await ui.find({ text: /auto-compact at 967\.0k/ })).toBeDefined()
    await ui.press({ key: 'toggle' })
    await ui.unmount()
  }
})

test('compact waits while Claude is working, and opens the focus field when idle', async ($, on) => {
  const state = { tokens: 500_000 }
  engine(on, state)
  let asked: string | undefined
  on('session.compact', ($, e) => {
    asked = e.instructions
    return { messages: SUMMARY, tokensBefore: 500_000, tokensAfter: 40_000 }
  })
  await start($)
  await measure($, 500_000)

  const busy = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: { ...BAND, isWorking: true } })
  expect(await busy.find({ key: 'compact' }), 'no Compact button mid-turn').toBeUndefined()
  expect(await busy.find({ text: 'Compact after this turn' }), 'waiting note').toBeDefined()
  await busy.unmount()

  const ui = await $.ui.mount({ plugin: 'context-control', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await ui.press({ key: 'compact' })
  await ui.input({ key: 'focus', text: 'keep the plan', kind: 'change' })
  await ui.press({ key: 'go' })
  expect(asked).toBe('keep the plan')
  expect(await ui.find({ text: /Compacted/ }), JSON.stringify(await ui.drawn()).slice(0, 3000)).toBeDefined()
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
  on('session.root', () => ({ value: 'C:\\work' }))
  on('session.id', () => ({ value: 'abc' }))
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
  expect(file).toMatch(/^C:\\work\\\.claude\\context-snapshots\\2026-10-15_\d{6}\.md$/)
  expect(written.get(file!)).toContain('Build the context control')
  expect(written.get(file!)).toContain('C:\\work\\a.ts')
  expect(written.has('C:\\work\\.claude\\context-snapshots\\.gitignore')).toBe(true)
})
