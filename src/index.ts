import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { Config } from './config'
import type { Config as ConfigShape } from './config'
import { BUILTIN_RULES } from './rules'
import { matchCapabilities } from './matcher'
import { renderHint } from './hint'
import { appendEntry, observeToolCall, recordApplicable } from './ledger'
import type { LedgerEntry } from './ledger'

export const name = 'dsh-capability-hint'
export const inject = ['skills']

export { Config }

// 台账的公开接口一并从包入口转发：否则 `dsh-capability-hint` 的对外 API
// 会漏掉自己的 `appendEntry` / `observeToolCall` / `recordApplicable`，
// 只能靠深路径 `dsh-capability-hint/src/ledger` 访问。
export { appendEntry, observeToolCall, recordApplicable }
export type { LedgerEntry }

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

/** 一份活的、实例作用域的台账（`apply` 的局部状态，绝不放到模块级）。 */
export interface Ledger {
  /** 当前全部记录（只读快照语义：每次读取返回当时的数组）。 */
  entries(): LedgerEntry[]
  /** 记一条 `applicable`（`turn`/`now` 由调用方给出）。 */
  recordApplicable(matches: Parameters<typeof recordApplicable>[1], turn: number, now: number): void
  /** 记一条 `invoked`（`now` 由调用方给出）。 */
  recordInvoked(skill: string, turn: number, now: number): void
}

/** 建立一个实例级台账。纯内存：持久化（`ctx.storage`）推迟到 Task 8 之后再定。 */
export function createLedger(): Ledger {
  let entries: LedgerEntry[] = []
  return {
    entries: () => entries,
    recordApplicable(matches, turn, now) {
      entries = recordApplicable(entries, matches, turn, now)
    },
    recordInvoked(skill, turn, now) {
      entries = appendEntry(entries, { time: now, kind: 'invoked', skill, turn })
    },
  }
}

export function apply(ctx: Context, config: ConfigShape): Ledger {
  const exclude = new Set(config.excludeSkills ?? [])

  // 实例级台账：每次 `apply()` 一份新状态。绝不用模块级 `let` ——
  // 那会跨 Agent 实例泄漏记录，并在插件重载后残留旧数据。
  const ledger = createLedger()

  // 最近一次已知的轮次。`tools/result` 的载荷里**没有** `turn` 字段
  // （签名 `(exec, result)`，`docs/subsystems/tools.md:714`），因此 invoked 记录
  // 只能沿用本实例最近一次 `agent/pre-step` 观测到的轮次。
  // 初值 `0` 表示"尚未见过任何轮次"（例如插件在轮次中途加载）——不是占位符，
  // 而是一个有定义的哨兵：0 不会与任何真实轮次（从 1 开始）混淆。
  const NO_TURN = 0
  let lastTurn = NO_TURN

  // 观察技能调用。
  //
  // 本任务唯一需要现场核对的签名，核对结论：**`tool/call` 不是 Cordis 事件**。
  // 全部引用均相对 dsh-plugin-guide/references/official-docs/：
  //   - `docs/architecture.md:97` 把 `tool/*` 归为 durable session events；
  //     同文件 `:90` 的流水线图把它画在流水线**之外**（`tool/call* -> ...`）。
  //   - `docs/persistence-catalog.md:859` 把 `tool/call` 标为「log-only」会话事件类型，
  //     载荷是 `{ turn, step, callId, name, arguments }`（`:867`）。
  //   - `docs/user/develop/framework/events.md:106` 明确：`tool/call` / `tool/result`
  //     是持久化会话事件类型，**不是**同名 Cordis 事件；要观察它们必须监听
  //     `session/event` 并检查 `event.type`。
  //   - 真正的实时逐调用扩展点是 `tools/result`（emit），签名在
  //     `docs/subsystems/tools.md:714`（锚点 `toolsresult--emit`，`:702`）：
  //     `'tools/result'(this: Scoped<ToolRuntime>, exec: Readonly<ToolExecution>, result: ...): undefined`
  //   - `guide/quick-reference.md` 的示例同为 `ctx.on('tools/result', (exec, result) => ...)`。
  //
  // 选 `tools/result` 而非 `session/event`：会话事件里 `tool/call.arguments` 是
  // **模型产出的原始 JSON 字符串**（未解析，`docs/subsystems/session.md:86`），
  // 用它就得先 JSON.parse；`tools/result` 直接给出注册表已解析并深冻结的
  // `exec.arguments`（`@deepseek-ai/dsh-tools/lib/types/index.d.ts:204-205`），
  // 无需二次解析，也不会因畸形 JSON 抛错。
  ctx.on('tools/result', (exec) => {
    try {
      const skill = observeToolCall(exec.name, exec.arguments)
      if (skill) ledger.recordInvoked(skill, lastTurn, Date.now())
    } catch {
      // 观察者失败不得影响主流程。
    }
  })

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
            lastTurn = payload.turn ?? NO_TURN
            ledger.recordApplicable(matches, payload.turn ?? NO_TURN, Date.now())
            // `as never` 未被移除 —— 见 createHintMessage 的文档注释：
            // 构造合规 `UserMessage` 需要 `@deepseek-ai/dsh-llm`（非本包声明依赖）。
            // 归属 Task 8；此处保留断言是有意为之，不是遗漏。
            payload.agent.inject(createHintMessage(line) as never)
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

  return ledger
}

/**
 * 构造注入用的消息体。
 *
 * **未解决的类型盲点（如实声明，不是已解决项）**：官方工厂 `createUserMessage`
 * 与让它合规所需的 `MessageId()` 都来自 `@deepseek-ai/dsh-llm`，而该包**不是本包
 * 的声明依赖**。实测探针（构造 import 后跑 `pnpm typecheck`）：
 *   - `import { createUserMessage } from '@deepseek-ai/dsh-llm/message'`
 *     → `TS2307: Cannot find module '@deepseek-ai/dsh-llm/message'`
 *   - `import type { UserMessage } from '@deepseek-ai/dsh-agent'`
 *     → `TS2614: Module '...' has no exported member 'UserMessage'`
 * `@deepseek-ai/dsh-session` 同样不可解析。`@deepseek-ai/dsh-agent` 只在
 * `runtime-types.d.ts:132` 用 `UserMessage` 标注 `inject`，并不转发该类型。
 *
 * 因此本任务**无法**在不动依赖面的前提下构造类型正确的 `UserMessage`——
 * 那需要把 `@deepseek-ai/dsh-llm` 加进 `package.json` 并重装，属于 Task 1 定下的
 * 包契约变更，超出 Task 6「只加台账」的范围。
 *
 * **归属：Task 8（持久化/依赖收口）**引入 `dsh-llm` 后，以
 * `createUserMessage({ role:'user', content:[{type:'text',text:line}], source:{kind:'plugin',plugin:name} })`
 * 替换本函数，并删除 `apply()` 里对应的 `as never`。
 *
 * 注意：`id` 目前缺失，即注入消息在**运行时**并不满足 `UserMessage` 的完整性要求；
 * 这一点被调用点的断言掩盖，尚未验证（见报告「已知风险」）。
 *
 * `content` 保持**字符串**形式（与 Task 5 已交付、且被 integration.test.ts 覆盖的
 * 行为一致）。官方 `UserMessage.content` 是 `ContentBlock[]`，改成块数组属于
 * 未被本任务验证的行为变更，故不做。
 */
export function createHintMessage(line: string): {
  content: string
  source: { kind: 'plugin'; plugin: string }
} {
  return {
    content: line,
    source: { kind: 'plugin', plugin: name },
  }
}
