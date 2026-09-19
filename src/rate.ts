import type { LedgerEntry } from './ledger'

/** 一个技能的默认调用率。 */
export interface RateReport {
  skill: string
  applicable: number
  invoked: number
  /** invoked / applicable，钳在 [0,1]。 */
  rate: number
}

/**
 * 纯函数：默认调用率 = 判定适用的轮次里，真的被调用的比例。
 *
 * 只看有 applicable 基线的技能——没有基线的 invoked 不入表（否则分母为 0）。
 * 升序排列：**最死的排最前**，便于直接看该退役什么。
 */
export function defaultInvocationRate(entries: LedgerEntry[]): RateReport[] {
  const acc = new Map<string, { applicable: number; invoked: number }>()

  for (const e of entries) {
    if (e.kind === 'applicable') {
      const cur = acc.get(e.skill) ?? { applicable: 0, invoked: 0 }
      cur.applicable += 1
      acc.set(e.skill, cur)
    }
  }
  for (const e of entries) {
    if (e.kind !== 'invoked') continue
    const cur = acc.get(e.skill)
    if (!cur) continue // 无基线，忽略
    cur.invoked += 1
  }

  return [...acc.entries()]
    .map(([skill, v]) => ({
      skill,
      applicable: v.applicable,
      invoked: v.invoked,
      rate: v.applicable === 0 ? 0 : Math.min(1, v.invoked / v.applicable),
    }))
    .sort((a, b) => a.rate - b.rate || a.skill.localeCompare(b.skill))
}
