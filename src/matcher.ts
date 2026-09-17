import type { Rule } from './rules'

/** 一次命中：哪个技能被哪条触发词命中。 */
export interface Match {
  skill: string
  hit: string
}

/**
 * 纯函数：把本轮任务的文本合并后，用触发规则匹配出该提示的能力。
 *
 * 不读时钟、不写 I/O、不调模型——因此可无 mock 测试（spec §12.9.3）。
 * 匹配策略：合并所有文本 → 小写化 → 对每条 rule 找第一个命中的 trigger。
 *
 * `max` 只在一个表达式里归一化：非有限值（NaN/±Infinity）与非法值一律归零，
 * 即"夹到关闭"——宁可不出提示，也不出一个未按配置截断的提示。
 */
export function matchCapabilities(
  texts: string[],
  rules: Rule[],
  opts: { max: number; exclude: Set<string> },
): Match[] {
  const max = Number.isFinite(opts.max) ? Math.floor(opts.max) : 0

  if (max <= 0 || texts.length === 0) return []

  const hay = texts.join('\n').toLowerCase()
  if (!hay) return []

  const out: Match[] = []
  const seen = new Set<string>()

  for (const rule of rules) {
    if (out.length >= max) break
    if (!rule?.skill || seen.has(rule.skill)) continue
    if (opts.exclude.has(rule.skill)) continue

    for (const trigger of rule.triggers ?? []) {
      if (!trigger) continue
      if (hay.includes(trigger.toLowerCase())) {
        out.push({ skill: rule.skill, hit: trigger })
        seen.add(rule.skill)
        break
      }
    }
  }

  return out
}
