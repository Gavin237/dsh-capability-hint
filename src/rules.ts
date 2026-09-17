/**
 * 一条触发规则：把「任务的文字特征」映射到「该被提示的技能」。
 *
 * 设计前提（spec §1.3）：只对「通用方法论」层技能建规则——
 * 任务必需型/业务专用型有硬需求驱动，提示它们是纯噪音。
 */
export interface Rule {
  /** 技能名，必须与技能目录里的名字逐字一致（kebab-case）。 */
  skill: string
  /** 触发词。小写；匹配时对任务文本做小写化后的子串匹配。 */
  triggers: string[]
  /** 为什么要有这条规则——给未来的自己看的注释。 */
  note?: string
}

/**
 * 内置规则表（v1 最小集）。
 * 只覆盖"不调用也能把活干完、所以从来不会被想起来"的方法论技能。
 */
export const BUILTIN_RULES: Rule[] = [
  {
    skill: 'brainstorming',
    triggers: ['设计', '方案', '怎么做', '想做个', '打算做', 'brainstorm'],
    note: '设计类请求——实测被调用过，但只在被显式要求时。',
  },
  {
    skill: 'systematic-debugging',
    triggers: ['报错', '失败', '不工作', '排查', 'debug', '坏掉'],
    note: '排障类请求——先系统性定位再改，避免打补丁式修复。',
  },
  {
    skill: 'writing-plans',
    triggers: ['实施计划', '分步骤', '落地计划', 'plan'],
    note: '需要可执行拆解时。',
  },
]

/** 校验规则表。返回错误信息列表；空数组表示通过。 */
export function validateRules(rules: Rule[], knownSkills: Set<string>, excludes: Set<string>): string[] {
  const errors: string[] = []
  const seen = new Set<string>()

  for (const r of rules) {
    if (!r.skill) {
      errors.push('rule with empty skill name')
      continue
    }
    if (seen.has(r.skill)) {
      errors.push(`duplicate rule for skill "${r.skill}"`)
      continue
    }
    seen.add(r.skill)

    if (!Array.isArray(r.triggers) || r.triggers.length === 0) {
      errors.push(`rule "${r.skill}" has no triggers`)
    }
    if (!knownSkills.has(r.skill)) {
      errors.push(`rule "${r.skill}" references a skill absent from the catalog`)
    }
    if (excludes.has(r.skill)) {
      errors.push(`rule "${r.skill}" is excluded by config`)
    }
    for (const t of r.triggers ?? []) {
      if (t !== t.toLowerCase()) {
        errors.push(`rule "${r.skill}" trigger "${t}" is not lowercase`)
      }
    }
  }

  return errors
}
