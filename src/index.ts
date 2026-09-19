import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { Config } from './config'
import type { Config as ConfigShape } from './config'
import { BUILTIN_RULES } from './rules'
import { matchCapabilities } from './matcher'
import { renderHint } from './hint'

export const name = 'dsh-capability-hint'
export const inject = ['skills']

export { Config }

/**
 * 从一条 user 消息里取纯文本。
 *
 * 官方 `UserMessage.content` 的形状在 Task 1 Step 1 核对过；
 * 这里同时兼容 `string` 与块数组，未知形状返回空串——**永不抛错**。
 */
export function extractText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b
        if (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string') {
          return (b as { text: string }).text
        }
        return ''
      })
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

export function apply(ctx: Context, config: ConfigShape): void {
  const exclude = new Set(config.excludeSkills ?? [])

  // 注册即 effect：ctx.on 返回 disposer，插件卸载时自动清理。
  // prepend: true 让我们先于下游观察步骤，但**仍然调用 next()**，
  // 由下游决定消息内容（waterfall 契约）。
  ctx.on(
    'agent/pre-step',
    async (
      payload: { agent: Agent; messages: unknown[]; turn: number; step: number; signal: AbortSignal },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision> => {
      // fail-open：任何异常都不得影响正常对话（Global Constraints）。
      try {
        // 只有带 user 消息的批次才是"每轮首次 proposal"；
        // 工具续步可能提交空批次，必须跳过（spec §12.6）。
        if (config.enabled && Array.isArray(payload?.messages) && payload.messages.length > 0) {
          const texts = payload.messages.map(extractText).filter(Boolean)
          const matches = matchCapabilities(texts, BUILTIN_RULES, {
            max: config.maxHintsPerTurn,
            exclude,
          })
          const line = renderHint(matches, config.hintPrefix)
          if (line) {
            payload.agent.inject({
              content: line,
              source: { kind: 'plugin', plugin: name },
            } as never)
          }
        }
      } catch {
        // 静默失败：提示是增强，不是必需。
      }

      // waterfall 契约：原样透传下游决策，绝不短路。
      return next()
    },
    { prepend: true },
  )
}
