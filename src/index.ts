import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config'
import type { Config as ConfigShape } from './config'

export const name = 'dsh-capability-hint'
export const inject = ['skills']

export { Config }

export function apply(_ctx: Context, _config: ConfigShape): void {
  // Task 5 在此注册 agent/pre-step 监听器。
}
