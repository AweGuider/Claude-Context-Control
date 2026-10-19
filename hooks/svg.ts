import type { Category, Point } from '../types'

const TRACK = 'rgba(128,128,128,0.22)'
const TICK = '#b8b4aa'
const EASE = 'calcMode="spline" keyTimes="0;1" keySplines="0.2 0.8 0.2 1"'

const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${body}</svg>`

/**
 * The window as one bar: fill grows from `from` to `to` (percent of the window),
 * the hatch past `tick` is the auto-compact reserve, `pulse` breathes the fill,
 * `shimmer` sweeps it while compacting.
 */
export function windowBar(o: {
  from: number
  to: number
  tick?: number
  tone: string
  pulse?: boolean
  shimmer?: boolean
  width?: number
  height?: number
}): string {
  const W = o.width ?? 1600
  const H = o.height ?? 12
  const bh = Math.min(6, H - 4)
  const y = (H - bh) / 2
  const x = (p: number) => (Math.max(0, Math.min(100, p)) / 100) * W
  const to = x(o.to)
  const from = x(o.from)
  const parts: string[] = [
    `<defs><pattern id="h" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="5" fill="rgba(128,128,128,0.5)"/></pattern>`,
    `<clipPath id="c"><rect x="0" y="${y}" width="${to}" height="${bh}" rx="${bh / 2}">${from === to ? '' : `<animate attributeName="width" from="${from}" to="${to}" dur="0.7s" fill="freeze" ${EASE}/>`}</rect></clipPath>`,
    `<linearGradient id="s" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>`,
    `<rect x="0" y="${y}" width="${W}" height="${bh}" rx="${bh / 2}" fill="${TRACK}"/>`,
  ]
  if (o.tick !== undefined && o.tick < 100) {
    parts.push(`<rect x="${x(o.tick)}" y="${y}" width="${W - x(o.tick)}" height="${bh}" fill="url(#h)"/>`)
  }
  const pulse = o.pulse ? `<animate attributeName="opacity" values="1;0.55;1" dur="2.4s" repeatCount="indefinite"/>` : ''
  parts.push(`<rect x="0" y="${y}" width="${W}" height="${bh}" fill="${o.tone}" clip-path="url(#c)">${pulse}</rect>`)
  if (o.shimmer) {
    const sw = Math.max(40, W * 0.15)
    parts.push(
      `<rect x="${-sw}" y="${y}" width="${sw}" height="${bh}" fill="url(#s)" clip-path="url(#c)"><animate attributeName="x" from="${-sw}" to="${Math.max(to, sw)}" dur="1.3s" repeatCount="indefinite"/></rect>`,
    )
  }
  if (o.tick !== undefined && o.tick < 100) {
    parts.push(`<rect x="${x(o.tick) - 1}" y="0" width="2" height="${H}" rx="1" fill="${TICK}"/>`)
  }
  return svg(W, H, parts.join(''))
}

/** What fills the used part, as one stacked bar; with `fade`, segments fade in left to right. */
export function compositionBar(cats: readonly Category[], fade: boolean, width = 1600, height = 8): string {
  const total = cats.reduce((a, c) => a + c.tokens, 0)
  if (total <= 0) return svg(width, height, '')
  const gap = 6
  const minW = 8
  const room = width - gap * Math.max(0, cats.length - 1)
  let x = 0
  const parts = cats.map((c, i) => {
    const w = Math.max(minW, (c.tokens / total) * room)
    const at = Math.min(0.9, i * 0.08).toFixed(2)
    const anim = fade ? `<animate attributeName="opacity" values="0;0;1" keyTimes="0;${at};1" dur="${(0.5 + Number(at)).toFixed(2)}s" fill="freeze"/>` : ''
    const rect = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${height}" rx="2" fill="${c.color}">${anim}</rect>`
    x += w + gap
    return rect
  })
  return svg(Math.max(width, Math.ceil(x - gap)), height, parts.join(''))
}

/** Context over the session: area, line drawn in, compaction markers, the auto-compact line. */
export function sparkline(points: readonly Point[], window: number, limit: number | undefined, width = 360, height = 96): string {
  if (points.length < 2) return svg(width, height, '')
  const pad = 4
  const x = (i: number) => (i / (points.length - 1)) * (width - pad * 2) + pad
  const y = (t: number) => height - pad - (Math.min(t, window) / window) * (height - pad * 2)
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.tokens).toFixed(1)}`).join(' ')
  const area = `${line} L${x(points.length - 1).toFixed(1)},${height - pad} L${pad},${height - pad} Z`
  const parts: string[] = []
  if (limit !== undefined) {
    parts.push(`<line x1="0" x2="${width}" y1="${y(limit).toFixed(1)}" y2="${y(limit).toFixed(1)}" stroke="#a3a097" stroke-width="1" stroke-dasharray="3 3"/>`)
  }
  parts.push(`<path d="${area}" fill="#6f9be0" fill-opacity="0.14"><animate attributeName="fill-opacity" values="0;0.14" dur="0.9s" fill="freeze"/></path>`)
  parts.push(
    `<path d="${line}" fill="none" stroke="#6f9be0" stroke-width="1.8" stroke-linejoin="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="0"><animate attributeName="stroke-dashoffset" from="1" to="0" dur="0.9s" fill="freeze" ${EASE}/></path>`,
  )
  points.forEach((p, i) => {
    if (!p.isCompaction || i === 0) return
    const prev = points[i - 1]!
    parts.push(`<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(prev.tokens).toFixed(1)}" y2="${height - pad}" stroke="#d97757" stroke-width="1" stroke-dasharray="2 3"/>`)
    parts.push(`<circle cx="${x(i - 1).toFixed(1)}" cy="${y(prev.tokens).toFixed(1)}" r="3.5" fill="#d97757"/>`)
  })
  const last = points[points.length - 1]!
  parts.push(`<circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last.tokens).toFixed(1)}" r="3.5" fill="#e8e6dc" stroke="#6f9be0" stroke-width="1.5"/>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`
}

/** A small filled bar for a ranked row: `share` of the row's width. */
export function rankBar(share: number, color: string, width = 600, height = 4): string {
  const w = Math.max(4, Math.min(1, share) * width)
  return svg(
    width,
    height,
    `<rect x="0" y="0" width="${width}" height="${height}" rx="2" fill="${TRACK}"/><rect x="0" y="0" width="${w.toFixed(1)}" height="${height}" rx="2" fill="${color}"><animate attributeName="width" from="0" to="${w.toFixed(1)}" dur="0.6s" fill="freeze" ${EASE}/></rect>`,
  )
}

