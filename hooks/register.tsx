import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, SessionCompactResult, SessionContextUsage, SessionMessage } from 'claude-code'

import { DEFAULTS, TEXT_TONE, TONE, clampPercent, fmt, fmtDelta, fmtWindow, growth, levelOf, limitOf, toBreakdown, turnsLeft } from './model'
import type { Level } from './model'
import { snapshotStamp, snapshotText } from './snapshot'
import { compositionBar, rankBar, sparkline, windowBar } from './svg'
import type { Breakdown, Compaction, Point, Reading, ControlSettings } from '../types'

const PANE = 'context-control'

const reading = atom({ plugin: 'context-control', key: 'reading' } as const, null)
const history = atom({ plugin: 'context-control', key: 'history' } as const, [])
const breakdown = atom({ plugin: 'context-control', key: 'breakdown' } as const, null)
const compactions = atom({ plugin: 'context-control', key: 'compactions' } as const, [])
const phase = atom({ plugin: 'context-control', key: 'phase' } as const, 'idle')
const expanded = atom({ plugin: 'context-control', key: 'expanded' } as const, false)
const composing = atom({ plugin: 'context-control', key: 'composing' } as const, false)
const draft = atom({ plugin: 'context-control', key: 'draft' } as const, '')
const tab = atom({ plugin: 'context-control', key: 'tab' } as const, 'overview')
const settings = atom({ plugin: 'context-control', key: 'settings' } as const, DEFAULTS)
const shownFill = atom({ plugin: 'context-control', key: 'shownFill' } as const, 0)
const isAlerted = atom({ plugin: 'context-control', key: 'isAlerted' } as const, false)
const error = atom({ plugin: 'context-control', key: 'error' } as const, '')

// Not `$`: the engine and the directory read that name as the capability object.
type Engine = EngineInterface
type Els = Elements[keyof Elements]

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Everything a drawing needs, derived once per draw. */
type View = {
  r: Reading
  tokens?: number
  pct?: number
  limit: number
  limitPct?: number
  level: Level
  last?: number
  avg?: number
  turns?: number
  b: Breakdown | null
  s: ControlSettings
  from: number
}

async function viewOf($: Engine): Promise<View | null> {
  const r = await read($, reading)
  if (r === null) return null
  const [b, s, points, from] = await Promise.all([read($, breakdown), read($, settings), read($, history), read($, shownFill)])
  const limit = limitOf(r, b)
  const tokens = r.tokens
  const pct = tokens === undefined ? undefined : (r.percent ?? Math.round((tokens / r.window) * 100))
  const { last, avg } = growth(points, s.averageOver)
  return {
    r,
    tokens,
    pct,
    limit,
    limitPct: b?.threshold !== undefined ? (b.threshold / r.window) * 100 : undefined,
    level: tokens === undefined ? 'calm' : levelOf(tokens, limit, s),
    last,
    avg,
    turns: tokens === undefined ? undefined : turnsLeft(tokens, limit, avg),
    b,
    s,
    from,
  }
}

async function ingest($: Engine, ctx: SessionContextUsage) {
  const before = await read($, reading)
  const next: Reading = { tokens: ctx.tokens, window: ctx.window, percent: ctx.percent }
  await update($, shownFill, () => (before?.tokens !== undefined ? (before.tokens / before.window) * 100 : 0))
  await update($, reading, () => next)
  if (next.tokens === undefined) return
  const tokens = next.tokens

  const wasCompacted = (await read($, phase)) === 'compacted'
  if (wasCompacted) await update($, phase, () => 'idle')
  await update($, history, list => {
    const lastPoint = list.at(-1)
    if (!wasCompacted && lastPoint?.tokens === tokens) return list
    const point: Point = wasCompacted ? { tokens, isCompaction: true } : { tokens }
    return [...list, point].slice(-300)
  })

  const [s, b, points] = await Promise.all([read($, settings), read($, breakdown), read($, history)])
  const limit = limitOf(next, b)
  const level = levelOf(tokens, limit, s)
  if (level === 'alert' && !(await read($, isAlerted))) {
    await update($, isAlerted, () => true)
    if (s.toastOnAlert) {
      const turns = turnsLeft(tokens, limit, growth(points, s.averageOver).avg)
      const pct = next.percent ?? Math.round((tokens / next.window) * 100)
      $.ui.toast(`Context at ${pct}%${turns !== undefined ? ` — auto-compact in ~${turns} ${turns === 1 ? 'turn' : 'turns'}` : ''}`, { timeoutMs: 6000 })
    }
  } else if (level === 'calm') {
    await update($, isAlerted, () => false)
  }
}

async function refresh($: Engine, ctx?: SessionContextUsage) {
  try {
    const s = await read($, settings)
    const usage = await $.session.usage({ breakdown: s.exactCounts ? 'full' : 'summary' })
    const found = usage.context.breakdown
    if (found) await update($, breakdown, () => toBreakdown(found, s.exactCounts))
    await ingest($, ctx ?? usage.context)
    await update($, error, () => '')
  } catch (err) {
    await update($, error, () => message(err))
  }
}

async function saveSettings($: Engine, patch: Partial<ControlSettings>) {
  const next = await update($, settings, s => ({ ...s, ...patch }))
  await $.store.set('settings', next)
  if (patch.exactCounts !== undefined || patch.warnAt !== undefined || patch.alertAt !== undefined) void refresh($)
}

/**
 * Writes the snapshot; the engine follows `$` only into functions of this file,
 * so the I/O lives here and snapshot.ts only builds the text.
 */
async function writeSnapshot(
  $: Engine,
  o: { messages: readonly SessionMessage[]; trigger: string; focus?: string; reading: Reading | null; settings: ControlSettings },
): Promise<string> {
  const stamp = snapshotStamp(await $.clock.now())
  const sessionId = await $.session.id()
  const model = await $.session.model()
  const text = snapshotText({ stamp, trigger: o.trigger, sessionId, model, reading: o.reading, focus: o.focus, messages: o.messages })
  // Fixed paths, relative to the working directory, so the plugin directory can read what is written.
  await $.fs.write(`.claude/context-snapshots/${stamp}.md`, text)
  if (o.settings.snapshotGitignore && !(await $.fs.exists('.claude/context-snapshots/.gitignore'))) {
    await $.fs.write('.claude/context-snapshots/.gitignore', '*\n')
  }
  return `.claude/context-snapshots/${stamp}.md`
}

/**
 * Snapshot first (when on), run the compaction, record it. Shared by the
 * session.compact hook and the mod's own button: the engine runs a plugin's
 * `$.session.compact` past that plugin's own hook, so the button does this itself.
 */
async function aroundCompact(
  $: Engine,
  o: { trigger: string; focus?: string; messages: readonly SessionMessage[] },
  run: () => Promise<SessionCompactResult>,
): Promise<SessionCompactResult> {
  const s = await read($, settings)
  const before = await read($, reading)
  await update($, phase, () => 'compacting')
  try {
    let snapshot: string | undefined
    if (s.snapshot) {
      try {
        snapshot = await writeSnapshot($, { messages: o.messages, trigger: o.trigger, focus: o.focus, reading: before, settings: s })
      } catch (err) {
        $.ui.toast(`Snapshot not saved: ${message(err)}`)
      }
    }
    const result = await run()
    if (result.skip !== undefined) {
      await update($, phase, () => 'idle')
      return result
    }
    const record: Compaction = {
      at: await $.clock.now(),
      trigger: o.trigger,
      before: result.tokensBefore ?? before?.tokens,
      after: result.tokensAfter,
      focus: o.focus,
      snapshot,
    }
    await update($, compactions, list => [...list, record].slice(-50))
    await update($, phase, () => 'compacted')
    await update($, isAlerted, () => false)
    return result
  } catch (err) {
    await update($, phase, () => 'idle')
    throw err
  }
}

const asMessages = (found: unknown): readonly SessionMessage[] => (Array.isArray(found) ? found : [])

async function compactNow($: Engine, focus: string) {
  await update($, composing, () => false)
  await update($, draft, () => '')
  const text = focus.trim()
  try {
    let messages: readonly SessionMessage[] = []
    try {
      messages = asMessages(await $.session.messages())
    } catch {
      messages = []
    }
    const result = await aroundCompact($, { trigger: 'manual', focus: text || undefined, messages }, () =>
      $.session.compact(text ? { instructions: text } : {}),
    )
    if (result.skip !== undefined) $.ui.toast(`Compact skipped: ${result.skip}`)
  } catch (err) {
    $.ui.toast(`Couldn't compact: ${message(err)}`)
  }
}

function openPane($: Engine) {
  return $.ui.open({ id: PANE, title: 'Context' })
}

const textBar = (pct: number, cells: number) => {
  const filled = Math.round((clampPercent(pct) / 100) * cells)
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

const share = (part: number, whole: number) => {
  const p = whole > 0 ? (part / whole) * 100 : 0
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
}

function windowSvg(els: Els, v: View, o: { width?: number; height: number; compacting: boolean }) {
  const to = v.tokens === undefined ? 0 : (v.tokens / v.r.window) * 100
  if (!('Svg' in els)) {
    const { Text } = els
    return <Text color={TEXT_TONE[v.level]}>{textBar(to, o.width ? Math.max(6, Math.round(o.width / 8)) : 40)}</Text>
  }
  const { Svg } = els
  const source = windowBar({
    from: v.from,
    to,
    tick: v.limitPct,
    tone: TONE[v.level],
    pulse: v.level === 'alert' && !o.compacting,
    shimmer: o.compacting,
    width: o.width,
    height: o.height,
  })
  const alt = `${v.pct ?? 0}% of the context window used${v.b?.threshold !== undefined ? `; auto-compact at ${fmt(v.b.threshold)}` : ''}`
  return o.width !== undefined ? <Svg source={source} alt={alt} width={o.width} height={o.height} /> : <Svg source={source} alt={alt} height={o.height} />
}

function compositionSvg(els: Els, b: Breakdown) {
  const total = b.used.reduce((a, c) => a + c.tokens, 0)
  if (!('Svg' in els)) {
    const { Box, Text } = els
    return (
      <Box flexDirection="row">
        {b.used.map(c => (
          <Text color={c.color}>{'█'.repeat(Math.max(1, Math.round((c.tokens / total) * 40)))}</Text>
        ))}
      </Box>
    )
  }
  const { Svg } = els
  return <Svg source={compositionBar(b.used)} alt={`Used context by category: ${b.used.map(c => `${c.name} ${fmt(c.tokens)}`).join(', ')}`} height={8} />
}

function legend(els: Els, b: Breakdown, columns: 1 | 2) {
  const { Box, Text } = els
  const total = b.used.reduce((a, c) => a + c.tokens, 0)
  return (
    <Box flexDirection="row" flexWrap="wrap">
      {b.used.map(c => (
        <Box flexDirection="row" width={columns === 2 ? '50%' : '100%'} paddingRight={columns === 2 ? 3 : 0}>
          <Text color={c.color}>■ </Text>
          <Box flexGrow={1}>
            <Text wrap="truncate-end">{c.name}</Text>
          </Box>
          <Text>{fmt(c.tokens)}</Text>
          <Box width={6} justifyContent="flex-end">
            <Text dimColor>{share(c.tokens, total)}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = (await $.store.get('settings')) as Partial<ControlSettings> | undefined
    const s: ControlSettings = { ...DEFAULTS, ...(stored ?? {}) }
    await update($, settings, () => s)
    await update($, expanded, () => s.startExpanded)
    await $.command.register({
      name: 'context-control',
      description: 'Open the Context Control pane: breakdown, history, compactions and settings',
    })
    void refresh($)
    if (s.openPaneOnStart) void openPane($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, reading, () => null)
      await update($, history, () => [])
      await update($, compactions, () => [])
      await update($, phase, () => 'idle')
      await update($, isAlerted, () => false)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const out = await next(e)
    if (e.changed.includes('context')) await refresh($, e.context)
    return out
  })

  on('session.compact', ($, e, next) => {
    if (e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    return aroundCompact($, { trigger: e.trigger, focus: e.instructions, messages: e.messages }, () => next(e))
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'context-control' }, async $ => {
    await openPane($)
    return { text: 'Opened the Context Control pane.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, settings)
    if (!s.showBand || e.props.hasSurvey) return next(e)
    const v = await viewOf($)
    if (v === null) return next(e)
    const [ph, isOpen, isComposing, text, compacts] = await Promise.all([
      read($, phase),
      read($, expanded),
      read($, composing),
      read($, draft),
      read($, compactions),
    ])
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const tone = TEXT_TONE[v.level]
    const win = fmtWindow(v.r.window)
    const toggle = () => update($, expanded, x => !x)
    const lastCompaction = compacts.at(-1)

    let summary
    if (ph === 'compacting') {
      summary = (
        <Text>
          <Text bold color="claude">Compacting…</Text>
          <Text dimColor>{v.tokens !== undefined ? `  summarising ${fmt(v.tokens)}` : ''}{s.snapshot ? '  ·  snapshot first' : ''}</Text>
        </Text>
      )
    } else if (ph === 'compacted' || v.tokens === undefined) {
      const wasCompacted = ph === 'compacted' && lastCompaction !== undefined
      summary = wasCompacted ? (
        <Text>
          <Text bold color="success">Compacted</Text>
          <Text dimColor>
            {`  ${lastCompaction.before !== undefined ? fmt(lastCompaction.before) : '?'} → ${lastCompaction.after !== undefined ? fmt(lastCompaction.after) : 'summary'}`}
            {lastCompaction.snapshot ? '  ·  snapshot saved' : ''}
            {'  ·  new size after the next reply'}
          </Text>
        </Text>
      ) : (
        <Text>
          <Text bold dimColor>Context</Text>
          <Text dimColor>  measuring — figures appear after the next reply</Text>
        </Text>
      )
    } else {
      summary = (
        <Button key="toggle" plain onPress={toggle}>
          <Text bold color={tone}>{`${v.pct}%`}</Text>
          <Text dimColor>{`  ${fmt(v.tokens)} / ${win}`}</Text>
          <Text dimColor>{v.last !== undefined ? `  ·  ${fmtDelta(v.last)} last turn` : ''}</Text>
        </Button>
      )
    }

    const right =
      v.tokens === undefined || ph !== 'idle'
        ? ''
        : v.b?.threshold === undefined
          ? v.b && !v.b.isAutoCompactEnabled
            ? 'auto-compact off'
            : ''
          : v.turns !== undefined
            ? `auto-compact in ~${v.turns} ${v.turns === 1 ? 'turn' : 'turns'}`
            : `auto-compact at ${fmt(v.b.threshold)}`

    let compactControl
    if (ph === 'compacting') compactControl = null
    else if (e.props.isWorking) compactControl = <Text dimColor>Compact after this turn</Text>
    else if (isComposing) compactControl = null
    else
      compactControl = (
        <Button key="compact" label="Compact" variant={v.level === 'alert' ? 'primary' : undefined} onPress={() => update($, composing, () => true)} />
      )

    const strip = (
      <Box flexDirection="row" alignItems="center" columnGap={2}>
        {windowSvg(els, v, { width: 72, height: 10, compacting: ph === 'compacting' })}
        {summary}
        <Box flexGrow={1} />
        {right ? <Text color={v.level === 'calm' ? undefined : tone} dimColor={v.level === 'calm'}>{right}</Text> : null}
        {v.tokens !== undefined && ph === 'idle' ? <Button key="more" plain dimColor label={isOpen ? 'Less ▾' : 'More ▴'} onPress={toggle} /> : null}
        {compactControl}
      </Box>
    )

    const details =
      isOpen && v.tokens !== undefined && ph === 'idle' ? (
        <Box flexDirection="column" rowGap={1} paddingBottom={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text>
              <Text bold color={tone}>{`${v.pct}%`}</Text>
              <Text dimColor>{` of ${win}  ·  ${fmt(v.tokens)} tokens`}</Text>
            </Text>
            <Text dimColor>{v.b?.threshold !== undefined ? `auto-compact at ${fmt(v.b.threshold)}` : v.b && !v.b.isAutoCompactEnabled ? 'auto-compact off' : ''}</Text>
          </Box>
          {windowSvg(els, v, { height: 12, compacting: false })}
          {v.b && v.b.used.length > 0 ? (
            <Box flexDirection="column" rowGap={1}>
              <Box flexDirection="row" justifyContent="space-between">
                <Text dimColor>What fills it</Text>
                <Text dimColor>{v.b.isExact ? 'exact counts' : 'local estimate'}</Text>
              </Box>
              {compositionSvg(els, v.b)}
              {legend(els, v.b, e.props.bodyColumns >= 70 ? 2 : 1)}
            </Box>
          ) : null}
          <Box flexDirection="row" columnGap={4} flexWrap="wrap">
            <Text dimColor>
              Last turn <Text bold>{fmtDelta(v.last)}</Text>
            </Text>
            <Text dimColor>
              Avg / turn <Text bold>{v.avg !== undefined ? fmt(v.avg) : '—'}</Text>
            </Text>
            <Text dimColor>
              Auto-compact in <Text bold color={tone}>{v.turns !== undefined ? `~${v.turns} ${v.turns === 1 ? 'turn' : 'turns'}` : '—'}</Text>
            </Text>
            <Box flexGrow={1} />
            <Button key="pane" plain dimColor label="Open pane ↗" onPress={() => openPane($)} />
          </Box>
        </Box>
      ) : null

    const compose =
      isComposing && ph === 'idle' && !e.props.isWorking ? (
        <Box flexDirection="column" rowGap={1} paddingBottom={1}>
          <Text>
            <Text bold>Compact conversation</Text>
            <Text dimColor>{v.tokens !== undefined ? `  ·  ${fmt(v.tokens)} now; older messages become a summary, recent ones stay` : ''}</Text>
          </Text>
          {'Input' in els ? (
            <els.Input
              key="focus"
              label="Focus (optional)"
              placeholder="What the summary must keep"
              value={text}
              autoFocus
              submitLabel="Compact"
              onInput={value => void update($, draft, () => value)}
              onSubmit={value => void compactNow($, value)}
            />
          ) : null}
          <Box flexDirection="row" columnGap={2} alignItems="center">
            <Text dimColor>{s.snapshot ? 'Snapshot first → .claude/context-snapshots/' : 'No snapshot · turn it on in the pane’s Settings'}</Text>
            <Box flexGrow={1} />
            <Button key="cancel" label="Cancel" onPress={() => update($, composing, () => false)} />
            <Button key="go" label="Compact" variant="primary" onPress={async () => compactNow($, await read($, draft))} />
          </Box>
        </Box>
      ) : null

    return (
      <Box flexDirection="column">
        {compose}
        {details}
        {strip}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const [current, v, points, compacts, err] = await Promise.all([read($, tab), viewOf($), read($, history), read($, compactions), read($, error)])
    const tabs = (
      <Box flexDirection="row" columnGap={2} paddingBottom={1}>
        <Button key="tab-overview" plain onPress={() => update($, tab, () => 'overview')}>
          <Text bold={current === 'overview'} dimColor={current !== 'overview'}>Overview</Text>
        </Button>
        <Button key="tab-settings" plain onPress={() => update($, tab, () => 'settings')}>
          <Text bold={current === 'settings'} dimColor={current !== 'settings'}>Settings</Text>
        </Button>
      </Box>
    )

    if (current === 'settings') {
      const s = await read($, settings)
      const cwd = await $.session.cwd()
      const toggleRow = (key: keyof ControlSettings & string, label: string, value: boolean, hint?: string) => (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" columnGap={2}>
            <Box flexGrow={1}>
              <Text>{label}</Text>
            </Box>
            <Button key={`set-${key}`} label={value ? 'On' : 'Off'} variant={value ? 'primary' : undefined} onPress={() => saveSettings($, { [key]: !value })} />
          </Box>
          {hint ? <Text dimColor>{hint}</Text> : null}
        </Box>
      )
      const numberRow = (key: 'warnAt' | 'alertAt' | 'averageOver', label: string, suffix: string, min: number, max: number) =>
        'Input' in els ? (
          <Box flexDirection="row" alignItems="center" columnGap={2}>
            <Box flexGrow={1}>
              <Text>{label}</Text>
            </Box>
            <els.Input
              key={`set-${key}`}
              label={label}
              value={String(s[key])}
              submitLabel="Set"
              onSubmit={value => {
                const n = Math.round(Number(value))
                if (Number.isFinite(n) && n >= min && n <= max) void saveSettings($, { [key]: n })
                else $.ui.toast(`${label}: enter ${min}–${max}`)
              }}
            />
            <Text dimColor>{suffix}</Text>
          </Box>
        ) : (
          <Text>{`${label}: ${s[key]} ${suffix}`}</Text>
        )
      const heading = (t: string) => <Text bold dimColor>{t.toUpperCase()}</Text>

      return (
        <Box flexDirection="column" rowGap={1}>
          {tabs}
          {heading('Display')}
          {toggleRow('showBand', 'Band above the prompt', s.showBand)}
          {'Select' in els ? (
            <Box flexDirection="row" alignItems="center" columnGap={2}>
              <Box flexGrow={1}>
                <Text>Band starts</Text>
              </Box>
              <els.Select
                key="set-startExpanded"
                options={[{ value: 'collapsed', label: 'Collapsed' }, { value: 'expanded', label: 'Expanded' }]}
                value={s.startExpanded ? 'expanded' : 'collapsed'}
                onSelect={value => void saveSettings($, { startExpanded: value === 'expanded' })}
              />
            </Box>
          ) : null}
          {toggleRow('openPaneOnStart', 'Open this pane when a session starts', s.openPaneOnStart)}
          {heading('Alerts')}
          {numberRow('warnAt', 'Warn at', '% of auto-compact', 1, 100)}
          {numberRow('alertAt', 'Alert at', '% of auto-compact', 1, 100)}
          {toggleRow('toastOnAlert', 'Toast once when crossing Alert', s.toastOnAlert)}
          {numberRow('averageOver', 'Turns-left estimate averages', 'turns', 1, 50)}
          {heading('Breakdown accuracy')}
          {toggleRow(
            'exactCounts',
            'Exact counts',
            s.exactCounts,
            s.exactCounts
              ? 'Calls the token-count API per category after each turn, with your account. Not a model call, but not free of requests.'
              : 'Off: local estimate from the last reply’s usage. No API calls.',
          )}
          {heading('Pre-compact snapshot')}
          {toggleRow('snapshot', 'Save a snapshot before each compaction', s.snapshot, 'A Markdown handoff built from the transcript (recent prompts, files touched, open tasks). No model calls.')}
          <Text dimColor>{`Folder: .claude/context-snapshots/ in ${cwd}`}</Text>
          {toggleRow('snapshotGitignore', 'Keep snapshots out of git', s.snapshotGitignore, 'Writes a one-line .gitignore inside the snapshot folder; the project’s own .gitignore is untouched.')}
        </Box>
      )
    }

    if (v === null || v.tokens === undefined) {
      return (
        <Box flexDirection="column" rowGap={1}>
          {tabs}
          <Text dimColor>{err ? `Couldn’t read usage: ${err}` : 'Measuring — figures appear after the next reply.'}</Text>
        </Box>
      )
    }

    const tone = TEXT_TONE[v.level]
    const used = v.b?.used ?? []
    const usedTotal = used.reduce((a, c) => a + c.tokens, 0)
    const fixed = v.b?.fixed ?? []
    const maxFixed = fixed[0]?.tokens ?? 1
    const hasSvg = 'Svg' in els
    const section = (title: string, aside?: string) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>{title}</Text>
        {aside ? <Text dimColor>{aside}</Text> : null}
      </Box>
    )

    return (
      <Box flexDirection="column" rowGap={1}>
        {tabs}
        <Text dimColor>{`Context window · ${await $.session.model()}`}</Text>
        <Text>
          <Text bold color={tone}>{`${v.pct}%`}</Text>
          <Text dimColor>{`  ${fmt(v.tokens)} of ${fmtWindow(v.r.window)} tokens`}</Text>
        </Text>
        {windowSvg(els, v, { height: 12, compacting: false })}
        <Text dimColor>{v.b?.threshold !== undefined ? `auto-compact at ${fmt(v.b.threshold)}` : 'auto-compact off'}</Text>
        <Box flexDirection="row" columnGap={3} flexWrap="wrap">
          <Text dimColor>
            Last turn <Text bold>{fmtDelta(v.last)}</Text>
          </Text>
          <Text dimColor>
            Avg <Text bold>{v.avg !== undefined ? fmt(v.avg) : '—'}</Text>
          </Text>
          <Text dimColor>
            Auto-compact in <Text bold color={tone}>{v.turns !== undefined ? `~${v.turns} ${v.turns === 1 ? 'turn' : 'turns'}` : '—'}</Text>
          </Text>
        </Box>

        {points.length >= 2 && hasSvg && 'Svg' in els ? (
          <Box flexDirection="column" rowGap={1} paddingTop={1}>
            {section('This session', `${points.length} readings`)}
            <els.Svg
              source={sparkline(points, v.r.window, v.b?.threshold)}
              alt={`Context over the session, now ${fmt(v.tokens)}${compacts.length ? `, ${compacts.length} compaction${compacts.length === 1 ? '' : 's'}` : ''}`}
            />
            <Text dimColor>- - auto-compact   ● compaction   ○ now</Text>
          </Box>
        ) : null}

        {used.length > 0 && v.b ? (
          <Box flexDirection="column" rowGap={1} paddingTop={1}>
            {section('What fills it', v.b.isExact ? 'exact counts' : 'local estimate')}
            {compositionSvg(els, v.b)}
            {legend(els, v.b, 1)}
            <Text dimColor>{`${fmt(usedTotal)} counted by category`}</Text>
          </Box>
        ) : null}

        {fixed.length > 0 ? (
          <Box flexDirection="column" rowGap={1} paddingTop={1}>
            {section('Always loaded')}
            <Text dimColor>Paid on every turn. Trim these to buy headroom.</Text>
            {fixed.map(f => (
              <Box flexDirection="column">
                <Box flexDirection="row" columnGap={1}>
                  <Box width={9}>
                    <Text dimColor>{f.kind}</Text>
                  </Box>
                  <Box flexGrow={1}>
                    <Text wrap="truncate-end">{f.name}</Text>
                  </Box>
                  <Text>{fmt(f.tokens)}</Text>
                </Box>
                {'Svg' in els ? <els.Svg source={rankBar(f.tokens / maxFixed, f.color)} alt={`${f.name}: ${fmt(f.tokens)}`} height={4} /> : null}
              </Box>
            ))}
          </Box>
        ) : null}

        <Box flexDirection="column" rowGap={1} paddingTop={1}>
          {section('Compactions', `${compacts.length} this session`)}
          {compacts.length === 0 ? <Text dimColor>None yet.</Text> : null}
          {[...compacts]
            .reverse()
            .slice(0, 6)
            .map(c => {
              const at = new Date(c.at)
              const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
              return (
                <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
                  <Box flexDirection="row" justifyContent="space-between">
                    <Text bold>{`${time} · ${c.trigger}`}</Text>
                    <Text>{`${c.before !== undefined ? fmt(c.before) : '?'} → ${c.after !== undefined ? fmt(c.after) : 'summary'}`}</Text>
                  </Box>
                  {c.focus ? <Text dimColor>{`Focus: “${c.focus}”`}</Text> : null}
                  {c.snapshot ? <Text dimColor wrap="truncate-start">{c.snapshot}</Text> : null}
                </Box>
              )
            })}
        </Box>

        <Box paddingTop={1}>
          <Button key="pane-compact" label="Compact…" onPress={() => update($, composing, () => true)} />
        </Box>
      </Box>
    )
  })
}
