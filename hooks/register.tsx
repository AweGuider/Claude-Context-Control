import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, SessionCompactResult, SessionContextUsage, SessionMessage, Timer } from 'claude-code'

import { DEFAULTS, TEXT_TONE, TONE, clampPercent, estimatedAvg, fmt, fmtDelta, fmtWindow, growth, levelOf, limitOf, toBreakdown, turnsLeft } from './model'
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
const changedAt = atom({ plugin: 'context-control', key: 'changedAt' } as const, 0)
const breakdownAt = atom({ plugin: 'context-control', key: 'breakdownAt' } as const, 0)
const toggledAt = atom({ plugin: 'context-control', key: 'toggledAt' } as const, 0)
const revealFrame = atom({ plugin: 'context-control', key: 'revealFrame' } as const, 0)
const turnCount = atom({ plugin: 'context-control', key: 'turnCount' } as const, null)
const isAlerted = atom({ plugin: 'context-control', key: 'isAlerted' } as const, false)
const error = atom({ plugin: 'context-control', key: 'error' } as const, '')

// Not `$`: the engine and the directory read that name as the capability object.
type Engine = EngineInterface
type Els = Elements[keyof Elements]

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

const HISTORY_KEY = 'history:'
const KEEP_HISTORIES = 20
/** Longer than the bar's grow and the composition's fade, so only a draw this soon after a change animates. */
const ANIMATE_MS = 1500
const DELTA_COLOR = '#7fa7e0'
/** The breakdown opens in up to four stages: one every STAGE_MS, closing a little faster. */
const STAGE_MS = 55
const CLOSE_STAGE_MS = 40
const STAGES = 4
/** Columns at the strip's right end the click area leaves bare, so Compact and the icons take their own clicks. */
const CLICK_CLEAR_RIGHT = 20

/** Everything a drawing needs, derived once per draw. */
type View = {
  r: Reading
  tokens?: number
  /** `tokens` is the breakdown's estimate: Claude Code has reported no count yet. */
  isEstimate: boolean
  pct?: number
  limit: number
  limitPct?: number
  level: Level
  last?: number
  avg?: number
  isAvgEstimate: boolean
  turns?: number
  b: Breakdown | null
  s: ControlSettings
  /** Where the bar's fill grows from: the last reading's, or `to` once that change has been drawn. */
  from: number
  fadeComposition: boolean
}

async function viewOf($: Engine): Promise<View | null> {
  const r = await read($, reading)
  if (r === null) return null
  const [b, s, points, shown, prompts, readingAt, compositionAt, now] = await Promise.all([
    read($, breakdown),
    read($, settings),
    read($, history),
    read($, shownFill),
    read($, turnCount),
    read($, changedAt),
    read($, breakdownAt),
    $.clock.now(),
  ])
  const limit = limitOf(r, b)
  const isEstimate = r.tokens === undefined && b !== null
  const tokens = r.tokens ?? b?.estimate
  const fill = tokens === undefined ? 0 : (tokens / r.window) * 100
  const pct = tokens === undefined ? undefined : isEstimate ? Math.round((tokens / r.window) * 100) : (r.percent ?? Math.round((tokens / r.window) * 100))
  const measured = growth(points, s.averageOver)
  const avg = measured.avg ?? estimatedAvg(b, prompts)
  return {
    r,
    tokens,
    isEstimate,
    pct,
    limit,
    limitPct: b?.threshold !== undefined ? (b.threshold / r.window) * 100 : undefined,
    level: tokens === undefined ? 'calm' : levelOf(tokens, limit, s),
    last: measured.last,
    avg,
    isAvgEstimate: measured.avg === undefined && avg !== undefined,
    turns: tokens === undefined ? undefined : turnsLeft(tokens, limit, avg),
    b,
    s,
    from: now - readingAt < ANIMATE_MS ? shown : fill,
    fadeComposition: now - compositionAt < ANIMATE_MS,
  }
}

/** The session's history as last saved, so a resume or restart keeps Last turn and Avg. */
async function loadHistory($: Engine): Promise<Point[]> {
  const saved = (await $.store.get(HISTORY_KEY + (await $.session.id()))) as { points?: Point[] } | undefined
  return Array.isArray(saved?.points) ? saved.points : []
}

async function saveHistory($: Engine, points: Point[]) {
  await $.store.set(HISTORY_KEY + (await $.session.id()), { at: await $.clock.now(), points })
}

/** Keeps the newest KEEP_HISTORIES sessions' histories; the store is one file for every session. */
async function pruneHistories($: Engine) {
  const keys = (await $.store.keys()).filter(k => k.startsWith(HISTORY_KEY))
  if (keys.length <= KEEP_HISTORIES) return
  const dated = await Promise.all(keys.map(async k => ({ k, at: Number(((await $.store.get(k)) as { at?: number } | undefined)?.at ?? 0) })))
  dated.sort((a, b) => b.at - a.at)
  for (const { k } of dated.slice(KEEP_HISTORIES)) await $.store.delete(k)
}

/** `isSeed`: the first reading after the mod started watching; turns before it went unseen. */
async function ingest($: Engine, ctx: SessionContextUsage, isSeed = false) {
  const [before, b] = await Promise.all([read($, reading), read($, breakdown)])
  const next: Reading = { tokens: ctx.tokens, window: ctx.window, percent: ctx.percent }
  const shown = before?.tokens ?? b?.estimate
  await update($, shownFill, () => (shown !== undefined && before ? (shown / before.window) * 100 : 0))
  await update($, reading, () => next)
  if (next.tokens !== before?.tokens) {
    const now = await $.clock.now()
    await update($, changedAt, () => now)
  }
  if (next.tokens === undefined) return
  const tokens = next.tokens

  const wasCompacted = (await read($, phase)) === 'compacted'
  if (wasCompacted) await update($, phase, () => 'idle')
  const list = await read($, history)
  const lastPoint = list.at(-1)
  if (!wasCompacted && lastPoint?.tokens === tokens) return
  const point: Point = wasCompacted ? { tokens, isCompaction: true } : isSeed && lastPoint ? { tokens, isGap: true } : { tokens }
  const points = await update($, history, () => [...list, point].slice(-300))
  await saveHistory($, points)
}

async function checkAlert($: Engine) {
  const [r, s, b, points] = await Promise.all([read($, reading), read($, settings), read($, breakdown), read($, history)])
  const tokens = r?.tokens
  if (r === null || tokens === undefined) return
  const limit = limitOf(r, b)
  const level = levelOf(tokens, limit, s)
  if (level === 'alert' && !(await read($, isAlerted))) {
    await update($, isAlerted, () => true)
    if (s.toastOnAlert) {
      const turns = turnsLeft(tokens, limit, growth(points, s.averageOver).avg)
      const pct = r.percent ?? Math.round((tokens / r.window) * 100)
      $.ui.toast(`Context at ${pct}%${turns !== undefined ? ` — auto-compact in ~${turns} ${turns === 1 ? 'turn' : 'turns'}` : ''}`, { timeoutMs: 6000 })
    }
  } else if (level === 'calm') {
    await update($, isAlerted, () => false)
  }
}

/** Stores the breakdown, and when what it shows changed, the time, so that change animates once. */
async function storeBreakdown($: Engine, next: Breakdown) {
  const [prev, r] = await Promise.all([read($, breakdown), read($, reading)])
  await update($, breakdown, () => next)
  const isNew = JSON.stringify(prev?.used) !== JSON.stringify(next.used)
  const isNewEstimate = r?.tokens === undefined && prev?.estimate !== next.estimate
  if (!isNew && !isNewEstimate) return
  const now = await $.clock.now()
  if (isNew) await update($, breakdownAt, () => now)
  if (isNewEstimate && r) {
    await update($, shownFill, () => (prev ? (prev.estimate / r.window) * 100 : 0))
    await update($, changedAt, () => now)
  }
}

/**
 * The plain usage call is free and quick, so the band draws from it first;
 * the breakdown (the slow part) and the prompt count follow.
 */
async function refresh($: Engine, ctx?: SessionContextUsage, isSeed = false) {
  try {
    await ingest($, ctx ?? (await $.session.usage()).context, isSeed)
    const s = await read($, settings)
    const found = (await $.session.usage({ breakdown: s.exactCounts ? 'full' : 'summary' })).context.breakdown
    if (found) await storeBreakdown($, toBreakdown(found, s.exactCounts))
    await checkAlert($)
    const prompts = await $.session.turns()
    await update($, turnCount, () => prompts)
    await update($, error, () => '')
  } catch (err) {
    await update($, error, () => message(err))
  }
}

async function startWatching($: Engine) {
  try {
    const saved = await loadHistory($)
    await update($, history, () => saved)
  } catch (err) {
    await update($, error, () => message(err))
  }
  await refresh($, undefined, true)
  await pruneHistories($).catch(() => {})
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

/** `focus` when the person asked for it, so the pane's first click presses a tab instead of only focusing the pane. */
function openPane($: Engine, focus = false) {
  return $.ui.open(focus ? { id: PANE, title: 'Context', focus: true } : { id: PANE, title: 'Context' })
}

const textBar = (pct: number, cells: number) => {
  const filled = Math.round((clampPercent(pct) / 100) * cells)
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

const share = (part: number, whole: number) => {
  const p = whole > 0 ? (part / whole) * 100 : 0
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
}

const approx = (isEstimate: boolean) => (isEstimate ? '~' : '')

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
  const alt = `${v.isEstimate ? 'About ' : ''}${v.pct ?? 0}% of the context window used${v.b?.threshold !== undefined ? `; auto-compact at ${fmt(v.b.threshold)}` : ''}`
  return o.width !== undefined ? <Svg source={source} alt={alt} width={o.width} height={o.height} /> : <Svg source={source} alt={alt} height={o.height} />
}

function compositionSvg(els: Els, b: Breakdown, fade: boolean) {
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
  return <Svg source={compositionBar(b.used, fade)} alt={`Used context by category: ${b.used.map(c => `${c.name} ${fmt(c.tokens)}`).join(', ')}`} height={8} />
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

/** The legend as rows of one or two categories, so the breakdown can reveal it row by row. */
function legendRows(els: Els, b: Breakdown, columns: 1 | 2 | 3) {
  const { Box, Text } = els
  const total = b.used.reduce((a, c) => a + c.tokens, 0)
  const rows = []
  for (let i = 0; i < b.used.length; i += columns) {
    rows.push(
      <Box flexDirection="row">
        {b.used.slice(i, i + columns).map(c => (
          <Box flexDirection="row" width={columns === 3 ? '33%' : columns === 2 ? '50%' : '100%'} paddingRight={columns > 1 ? 3 : 0}>
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
      </Box>,
    )
  }
  return rows
}

let revealTimer: Timer | undefined

/** Opens or closes the breakdown; with `animate`, redraws once per stage until every stage has shown. */
async function toggleDetails($: Engine, animate: boolean) {
  const isOpen = await update($, expanded, x => !x)
  if (!animate) return
  const start = await $.clock.now()
  const step = isOpen ? STAGE_MS : CLOSE_STAGE_MS
  await update($, toggledAt, () => start)
  revealTimer?.cancel()
  revealTimer = undefined
  const timer = $.clock.every(step, () => {
    void (async () => {
      await update($, revealFrame, n => n + 1)
      if ((await $.clock.now()) - start >= step * STAGES) {
        timer.cancel()
        if (revealTimer === timer) revealTimer = undefined
      }
    })()
  })
  revealTimer = timer
}

function composeOf($: Engine, els: Els, v: View, s: ControlSettings, text: string, show: boolean) {
  if (!show) return null
  const { Box, Text, Button } = els
  return (
    <Box flexDirection="column" rowGap={1} paddingBottom={1}>
      <Text>
        <Text bold>Compact conversation</Text>
        <Text dimColor>{v.tokens !== undefined ? `  ·  ${approx(v.isEstimate)}${fmt(v.tokens)} now; older messages become a summary, recent ones stay` : ''}</Text>
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
    void startWatching($)
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

  on('ui.message', async ($, e, next) => {
    if (!e.element.startsWith('click-')) return next(e)
    if ((e.data as { type?: unknown } | null)?.type === 'toggle') await toggleDetails($, true)
    return {}
  })

  on('command.run', { command: 'context-control' }, async $ => {
    await openPane($, true)
    return { text: 'Opened the Context Control pane.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, settings)
    if (!s.showBand || e.props.hasSurvey) return next(e)
    const v = await viewOf($)
    if (v === null) return next(e)
    const [ph, isOpen, isComposing, text, compacts, toggled, now] = await Promise.all([
      read($, phase),
      read($, expanded),
      read($, composing),
      read($, draft),
      read($, compactions),
      read($, toggledAt),
      $.clock.now(),
      // Read only so each frame of a reveal draws again.
      read($, revealFrame),
    ])
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const tone = TEXT_TONE[v.level]
    const win = fmtWindow(v.r.window)
    const toggle = () => toggleDetails($, 'Client' in els)
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
    }

    // Narrower bands drop words first, then whole figures, so Compact and the arrow always fit.
    const isNarrow = e.props.bodyColumns < 90
    const isTiny = e.props.bodyColumns < 60
    const canToggle = v.tokens !== undefined && ph === 'idle'
    const toggleLabel = isOpen ? 'Hide details' : 'Show details'
    const a = approx(v.isEstimate)
    const turnsWord = v.turns === 1 ? 'turn' : 'turns'

    const right =
      !canToggle || isTiny
        ? ''
        : v.b?.threshold === undefined
          ? v.b && !v.b.isAutoCompactEnabled
            ? 'auto-compact off'
            : ''
          : v.turns !== undefined
            ? isNarrow
              ? `~${v.turns} ${turnsWord} left`
              : `auto-compact in ~${v.turns} ${turnsWord}`
            : isNarrow
              ? ''
              : `auto-compact at ${fmt(v.b.threshold)}`

    let compactControl
    if (ph === 'compacting') compactControl = null
    else if (e.props.isWorking) compactControl = <Text dimColor>Compact after this turn</Text>
    else if (isComposing) compactControl = null
    else
      compactControl = (
        <Button key="compact" label="Compact" variant={v.level === 'alert' ? 'primary' : undefined} onPress={() => update($, composing, () => true)} />
      )

    // An icon Button that names itself in a small dim line beside it while hovered.
    const icon = (key: string, glyph: string, name: string, onPress: () => unknown) => (
      <Box key={`${key}-box`} flexDirection="row" alignItems="center" columnGap={1}>
        {s.arrowTooltip ? (
          <Box display="none" hover={{ display: 'flex' }}>
            <Text size="footnote" dimColor>
              {name}
            </Text>
          </Box>
        ) : null}
        <Button key={key} plain dimColor hover={{ dimColor: false }} onPress={onPress}>
          {glyph}
        </Button>
      </Box>
    )
    const paneIcon = icon('open-pane', '↗', 'Open pane', () => openPane($, true))
    const chevron = icon('chevron', isOpen ? '▼' : '▲', toggleLabel, toggle)

    // A Box can't be pressed and a Button holds only text, so each text piece is its own toggle.
    const strip = canToggle ? (
      <Box key="strip" flexDirection="row" alignItems="center" columnGap={2}>
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          {windowSvg(els, v, { width: 72, height: 10, compacting: false })}
          <Button key="toggle" plain onPress={toggle}>
            <Text bold color={tone}>{`${a}${v.pct}%`}</Text>
          </Button>
        </Box>
        <Button key="toggle-tokens" plain onPress={toggle}>
          <Text>{`${a}${fmt(v.tokens!)}${isNarrow ? '' : ` / ${win}`}`}</Text>
        </Button>
        {v.last !== undefined && !isTiny ? (
          <Button key="toggle-last" plain onPress={toggle}>
            <Text bold color={DELTA_COLOR}>{fmtDelta(v.last)}</Text>
            {isNarrow ? null : <Text dimColor> last turn</Text>}
          </Button>
        ) : null}
        <Box flexGrow={1} />
        {right ? (
          <Button key="toggle-right" plain onPress={toggle}>
            <Text color={v.level === 'calm' ? undefined : tone} dimColor={v.level === 'calm'}>
              {right}
            </Text>
          </Button>
        ) : null}
        {compactControl}
        {paneIcon}
        {chevron}
      </Box>
    ) : (
      <Box flexDirection="row" alignItems="center" columnGap={2}>
        {windowSvg(els, v, { width: 72, height: 10, compacting: ph === 'compacting' })}
        {summary}
        <Box flexGrow={1} />
        {compactControl}
        {paneIcon}
      </Box>
    )

    const hasClickArea = canToggle && !isComposing && 'Client' in els
    const Client = hasClickArea && 'Client' in els ? els.Client : undefined
    // One click layer per row: a single layer stretched over the panel reached only its top row on desktop.
    const clickable = (node: unknown, key: string) =>
      Client ? (
        <Box flexDirection="column" position="relative">
          {node}
          <Box position="absolute" top={0} bottom={0} left={0} width="100%">
            <Client key={key} module="./click-area.tsx" width="100%" height="100%" />
          </Box>
        </Box>
      ) : (
        node
      )

    // `gap`: 'inner' sits within a section, 'section' between sections; inner spacing is given up first.
    type Row = { node: unknown; gap?: 'inner' | 'section'; isLegend?: true }
    const gap = (kind: 'inner' | 'section' = 'section'): Row => ({ node: <Box height={1} />, gap: kind })
    const legendColumns = e.props.bodyColumns >= 100 ? 3 : e.props.bodyColumns >= 70 ? 2 : 1
    const threshold = v.b?.threshold !== undefined ? `auto-compact at ${fmt(v.b.threshold)}` : v.b && !v.b.isAutoCompactEnabled ? 'auto-compact off' : ''
    // Stages, bottom first: revealed one at a time, nearest the strip first.
    const stages: Row[][] = canToggle
      ? [
          [
            {
              node: (
                <Box flexDirection="row" columnGap={4} flexWrap="wrap">
                  <Button key="close-last" plain onPress={toggle}>
                    <Text dimColor>Last turn </Text>
                    <Text bold>{fmtDelta(v.last)}</Text>
                  </Button>
                  <Button key="close-avg" plain onPress={toggle}>
                    <Text dimColor>Avg / turn </Text>
                    <Text bold>{v.avg !== undefined ? `${approx(v.isAvgEstimate)}${fmt(v.avg)}` : '—'}</Text>
                  </Button>
                  <Button key="close-turns" plain onPress={toggle}>
                    <Text dimColor>Auto-compact in </Text>
                    <Text bold color={tone}>{v.turns !== undefined ? `~${v.turns} ${turnsWord}` : '—'}</Text>
                  </Button>
                  <Box flexGrow={1} />
                </Box>
              ),
            },
            gap(),
          ],
          v.b && v.b.used.length > 0 ? [...legendRows(els, v.b, legendColumns).map(node => ({ node, isLegend: true as const })), gap()] : [],
          v.b && v.b.used.length > 0
            ? [
                {
                  node: (
                    <Box flexDirection="row" justifyContent="space-between">
                      <Button key="close-fills" plain onPress={toggle}>
                        <Text dimColor>What fills it</Text>
                      </Button>
                      <Button key="close-accuracy" plain onPress={toggle}>
                        <Text dimColor>{v.b.isExact ? 'exact counts' : 'local estimate'}</Text>
                      </Button>
                    </Box>
                  ),
                },
                gap('inner'),
                { node: compositionSvg(els, v.b, v.fadeComposition) },
                gap('inner'),
              ]
            : [],
          [
            {
              node: (
                <Box flexDirection="row" justifyContent="space-between">
                  <Button key="close-head" plain onPress={toggle}>
                    <Text bold color={tone}>{`${a}${v.pct}%`}</Text>
                    <Text dimColor>{` of ${win}  ·  ${a}${fmt(v.tokens!)} tokens`}</Text>
                  </Button>
                  {threshold ? (
                    <Button key="close-threshold" plain onPress={toggle}>
                      <Text dimColor>{threshold}</Text>
                    </Button>
                  ) : null}
                </Box>
              ),
            },
            gap('inner'),
            { node: windowSvg(els, v, { height: 12, compacting: false }) },
            gap(),
          ],
        ].filter(stage => stage.length > 0)
      : []

    // The band scrolls past maxRows: the open panel gives up inner spacing, then lower legend rows, then section spacing.
    const budget = Math.max(0, e.props.maxRows - 1)
    const count = () => stages.reduce((n, stage) => n + stage.length, 0)
    const dropGaps = (kind: 'inner' | 'section') => {
      for (const stage of stages) if (count() > budget) stage.splice(0, stage.length, ...stage.filter(r => r.gap !== kind))
    }
    const trimLegend = (minKeep: number) => {
      const legendStage = stages.find(stage => stage.some(r => r.isLegend))
      if (!legendStage || count() <= budget) return
      const legend = legendStage.filter(r => r.isLegend)
      const rest = legendStage.filter(r => !r.isLegend)
      const keep = legend.length - (count() - budget) - 1
      if (keep >= minKeep && keep < legend.length) {
        const more = v.b!.used.length - keep * legendColumns
        legendStage.splice(0, legendStage.length, ...legend.slice(0, keep), { node: <Text dimColor>{`+${more} more · /context-control for all`}</Text> }, ...rest)
      } else if (minKeep === 0) {
        legendStage.splice(0, legendStage.length, ...rest)
      }
    }
    if (count() > budget) dropGaps('inner')
    trimLegend(1)
    if (count() > budget) dropGaps('section')
    trimLegend(0)

    const shownStages = !('Client' in els) || toggled === 0
      ? isOpen ? stages.length : 0
      : isOpen
        ? Math.min(stages.length, 1 + Math.floor((now - toggled) / STAGE_MS))
        : Math.max(0, stages.length - 1 - Math.floor((now - toggled) / CLOSE_STAGE_MS))
    const visible = stages.slice(0, shownStages).reverse().flat().slice(-budget || stages.length)
    const details = visible.length > 0 ? <Box flexDirection="column">{visible.map((r, i) => clickable(r.node, `click-row-${i}`))}</Box> : null

    const compose = composeOf($, els, v, s, text, isComposing && ph === 'idle' && !e.props.isWorking)

    if (Client) {
      return (
        <Box flexDirection="column">
          {details}
          <Box flexDirection="column" position="relative">
            {strip}
            {/* The strip's right end stays bare so Compact and the arrow take their own clicks. */}
            <Box position="absolute" top={0} bottom={0} left={0} width={Math.max(1, e.props.bodyColumns - CLICK_CLEAR_RIGHT)}>
              <Client key="click-strip" module="./click-area.tsx" width="100%" height="100%" />
            </Box>
          </Box>
        </Box>
      )
    }

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
          // The Input draws its own label before the field; wrapping keeps the suffix off it in a narrow pane.
          <Box flexDirection="row" alignItems="center" columnGap={2} flexWrap="wrap">
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
          {toggleRow('arrowTooltip', 'Name the band’s ↗ and ▲ icons on hover', s.arrowTooltip)}
          {heading('Alerts')}
          {numberRow('warnAt', 'Warn at', '% of auto-compact', 1, 100)}
          {numberRow('alertAt', 'Alert at', '% of auto-compact', 1, 100)}
          {toggleRow('toastOnAlert', 'Toast once when crossing Alert', s.toastOnAlert)}
          {numberRow('averageOver', 'Average over', 'turns for turns left', 1, 50)}
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
          <Text bold color={tone}>{`${approx(v.isEstimate)}${v.pct}%`}</Text>
          <Text dimColor>{`  ${approx(v.isEstimate)}${fmt(v.tokens)} of ${fmtWindow(v.r.window)} tokens`}</Text>
        </Text>
        {windowSvg(els, v, { height: 12, compacting: false })}
        <Text dimColor>{v.b?.threshold !== undefined ? `auto-compact at ${fmt(v.b.threshold)}` : 'auto-compact off'}</Text>
        <Box flexDirection="row" columnGap={3} flexWrap="wrap">
          <Text dimColor>
            Last turn <Text bold>{fmtDelta(v.last)}</Text>
          </Text>
          <Text dimColor>
            Avg <Text bold>{v.avg !== undefined ? `${approx(v.isAvgEstimate)}${fmt(v.avg)}` : '—'}</Text>
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
            {compositionSvg(els, v.b, v.fadeComposition)}
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
