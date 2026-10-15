import type { EngineInterface, SessionMessage } from 'claude-code'

import { fmt } from './model'
import type { Reading, ControlSettings } from '../types'

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TASK_TOOLS = new Set(['TodoWrite', 'mcp__ccd_turn__update_plan'])

const pad = (n: number) => String(n).padStart(2, '0')

const isAbsolute = (p: string) => /^([a-zA-Z]:[\\/]|[\\/])/.test(p)

const clean = (text: string) =>
  text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<[a-z-]+-context[^>]*>[\s\S]*?<\/[a-z-]+-context>/g, '')
    .trim()

function promptsOf(messages: readonly SessionMessage[], count: number): string[] {
  return messages
    .filter(m => m.role === 'user' && (m.toolResults?.length ?? 0) === 0)
    .map(m => clean(m.text))
    .filter(t => t.length > 0)
    .slice(-count)
}

function filesOf(messages: readonly SessionMessage[]): { edited: string[]; read: string[] } {
  const edited = new Set<string>()
  const read = new Set<string>()
  for (const m of messages) {
    for (const use of m.toolUses) {
      const path = use.input.file_path ?? use.input.notebook_path
      if (typeof path !== 'string') continue
      if (EDITS.has(use.tool)) edited.add(path)
      else if (use.tool === 'Read') read.add(path)
    }
  }
  for (const p of edited) read.delete(p)
  return { edited: [...edited], read: [...read] }
}

function tasksOf(messages: readonly SessionMessage[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const use = [...messages[i]!.toolUses].reverse().find(u => TASK_TOOLS.has(u.tool) && Array.isArray(u.input.todos ?? u.input.items))
    if (!use) continue
    const list = (use.input.todos ?? use.input.items) as { content?: unknown; status?: unknown }[]
    return list
      .filter(t => t.status !== 'completed')
      .map(t => `- [${t.status === 'in_progress' ? '~' : ' '}] ${String(t.content ?? '')}`)
  }
  return []
}

/** Writes a Markdown handoff of the conversation about to be compacted; returns the file's path. */
export async function writeSnapshot(
  $: EngineInterface,
  o: { messages: readonly SessionMessage[]; trigger: string; focus?: string; reading: Reading | null; settings: ControlSettings },
): Promise<string> {
  const root = await $.session.root()
  const sep = root.includes('\\') ? '\\' : '/'
  const rel = o.settings.snapshotDir.replace(/[\\/]+$/, '')
  const dir = isAbsolute(rel) ? rel : `${root}${sep}${rel.replace(/[\\/]/g, sep)}`
  const now = new Date(await $.clock.now())
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const path = `${dir}${sep}${stamp}.md`

  const [id, model] = await Promise.all([$.session.id(), $.session.model()])
  const r = o.reading
  const size = r?.tokens !== undefined ? `${fmt(r.tokens)} of ${fmt(r.window)} (${r.percent ?? Math.round((r.tokens / r.window) * 100)}%)` : 'unknown'
  const files = filesOf(o.messages)
  const tasks = tasksOf(o.messages)
  const prompts = promptsOf(o.messages, 10)

  const lines = [
    `# Context snapshot — ${stamp.replace('_', ' ')}`,
    '',
    `- Trigger: ${o.trigger}`,
    `- Session: ${id}`,
    `- Model: ${model}`,
    `- Context before compaction: ${size}`,
    ...(o.focus ? [`- Focus: ${o.focus}`] : []),
    '',
    `## Recent prompts (${prompts.length})`,
    '',
    ...prompts.flatMap(p => [p.slice(0, 1200).replace(/^/gm, '> '), '']),
    '## Files touched',
    '',
    ...(files.edited.length ? ['Edited:', ...files.edited.map(f => `- ${f}`), ''] : []),
    ...(files.read.length ? ['Read:', ...files.read.slice(-40).map(f => `- ${f}`), ''] : []),
    ...(files.edited.length + files.read.length === 0 ? ['None recorded.', ''] : []),
    ...(tasks.length ? ['## Open tasks', '', ...tasks, ''] : []),
  ]

  await $.fs.write(path, lines.join('\n'))
  if (o.settings.snapshotGitignore && !(await $.fs.exists(`${dir}${sep}.gitignore`))) {
    await $.fs.write(`${dir}${sep}.gitignore`, '*\n')
  }
  return path
}
