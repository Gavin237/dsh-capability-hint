import type { LedgerEntry } from './ledger'

/**
 * 一个技能的默认调用率。
 *
 * 注意：本结构的三个字段**不是同一个计数单位**，见 `rate` 字段的说明。
 */
export interface RateReport {
  skill: string
  /**
   * 记到该技能名下的「适用判定」**条目数** —— 是条目数，不是轮次数。
   * `recordApplicable` 每个匹配项追加一条，故一轮里命中 N 个技能就各记 1 条，
   * 同一技能在一轮里匹配两次就记 2 条。它**不是**"判定适用的轮次"。
   */
  applicable: number
  /** 观测到的该技能被调用次数（invoked 条目数）。 */
  invoked: number
  /**
   * `invoked / applicable`，钳在 [0,1]。
   *
   * **这是两个不同计数单位之比，不是"按轮次命中率"。** 分子是工具调用观测数，
   * 分母是匹配条目数，二者不共享单位。因此非零值至少混同了三种情况：
   * ① 每次判定都调用；② 一轮内被调用多次；③ 一轮内被反复匹配。
   * 对退役决策而言三种含义完全不同 —— **只有 0 可以安全解读为"从未被调用"**。
   *
   * 若需要真正的按轮次命中率，那是分母不同的另一个指标，须另立任务论证。
   */
  rate: number
}

/**
 * 纯函数：默认调用率 = 该技能的 invoked 计数 ÷ applicable 计数，钳在 [0,1]。
 *
 * 只看有 applicable 基线的技能——没有基线的 invoked 不入表（否则分母为 0）。
 * 分母是**匹配条目数**（per matching entry），不是轮次数；非零 rate 不可当作
 * "按轮次命中率"解读，详见 `RateReport.rate`。
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
