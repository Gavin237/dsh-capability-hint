import Schema from '@deepseek-ai/schemastery'

// 所有可调参数在此声明；harness 在加载期校验，非法值响亮失败。
export interface Config {
  /** 总开关。关掉后监听器仍在，但从不注入。 */
  enabled: boolean
  /** 单轮最多提示几个能力（防止提示本身变成噪音）。 */
  maxHintsPerTurn: number
  /** 提示行的前缀标记。 */
  hintPrefix: string
  /** 触发规则表路径（绝对路径或相对包根）。 */
  rulesPath: string
  /** 永不提示的技能名（黑名单，优先级高于规则表）。 */
  excludeSkills: string[]
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('Master switch for hint injection.'),
  maxHintsPerTurn: Schema.number().default(3).description('Maximum capabilities hinted per turn.'),
  hintPrefix: Schema.string().default('[能力提示]').description('Prefix of the injected hint line.'),
  rulesPath: Schema.string().default('hermes-intake-rules.json').description('Path to the trigger rule table.'),
  excludeSkills: Schema.array(Schema.string()).default([]).description('Skill names never hinted.'),
})
