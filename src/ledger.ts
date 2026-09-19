import type { Match } from './matcher'

/**
 * 台账的一条记录。append-only，不改历史。
 *
 * 纯数据：不含时间戳来源、不含 I/O —— 落账时刻由调用方传入（Global Constraints）。
 */
export interface LedgerEntry {
  /** 单调序号，从 1 开始。 */
  seq: number
  /** Unix epoch ms，由调用方给出。 */
  time: number
  /** applicable = 判定该能力适用；invoked = 该能力真的被调用了。 */
  kind: 'applicable' | 'invoked'
  skill: string
  /** 该记录所属轮次。 */
  turn: number
}

/** 纯函数：追加一条记录并赋序号，返回新数组（不修改入参）。 */
export function appendEntry(entries: LedgerEntry[], e: Omit<LedgerEntry, 'seq'>): LedgerEntry[] {
  return [...entries, { ...e, seq: entries.length + 1 }]
}

/**
 * 从一次工具调用里识别「技能被调用」事件。
 *
 * 只认官方 `skill` 加载器工具：其模型可见名与 schema 在本机
 * `dsh-tool-skill/lib/index.js:60-66` 核实为 `name: 'skill'` +
 * `parameters: { name: { type: 'string', required: true } }`。
 *
 * 完全函数（total）：任何输入都不抛错，认不出就返回 `null`。
 */
export function observeToolCall(toolName: string, args: unknown): string | null {
  if (toolName !== 'skill') return null
  if (!args || typeof args !== 'object') return null
  const n = (args as { name?: unknown }).name
  return typeof n === 'string' && n ? n : null
}

/**
 * 批量把命中结果记为 applicable。
 *
 * 纯函数：`turn` / `now` 由调用方给出，逐条走 `appendEntry`，返回新数组。
 */
export function recordApplicable(
  entries: LedgerEntry[],
  matches: Match[],
  turn: number,
  now: number,
): LedgerEntry[] {
  let out = entries
  for (const m of matches) {
    out = appendEntry(out, { time: now, kind: 'applicable', skill: m.skill, turn })
  }
  return out
}
