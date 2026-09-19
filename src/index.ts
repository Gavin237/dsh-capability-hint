import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
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
  /**
   * 当前全部记录的**只读快照**：每次读取返回当时的数组。
   *
   * 返回的是副本，且类型为 `readonly LedgerEntry[]` —— 调用方既在编译期无法
   * `push`/`sort`，在运行期改到的也只是副本，**不可能**把内部状态或 `seq`
   * （由 `entries.length` 推导，`src/ledger.ts:22`）改坏。
   */
  entries(): readonly LedgerEntry[]
  /** 记一条 `applicable`（`turn`/`now` 由调用方给出）。 */
  recordApplicable(matches: Parameters<typeof recordApplicable>[1], turn: number, now: number): void
  /** 记一条 `invoked`（`now` 由调用方给出）。 */
  recordInvoked(skill: string, turn: number, now: number): void
}

/** 建立一个实例级台账。纯内存：持久化（`ctx.storage`）推迟到 Task 8 之后再定。 */
export function createLedger(): Ledger {
  let entries: LedgerEntry[] = []
  return {
    // 逐个复制（不是 `entries.slice()` 的等价省略）：`entries` 是 append-only 的，
    // 复制一份既兑现「快照语义」，也把内部数组与调用方彻底隔离开。
    entries: () => [...entries],
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
            payload.agent.inject(createHintMessage(line))
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
 * **类型盲点已关闭（Task 8）**：官方工厂 `createUserMessage` 来自
 * `@deepseek-ai/dsh-llm/message`，该包原**不是**本包的声明依赖，因此 Task 5 只能
 * 在调用点用 `as never` 抹掉检查。Task 8 把它加进 `devDependencies` +
 * `peerDependencies` 后，断言已删除，此处返回真正的 `UserMessage`。
 *
 * 关闭前的实测探针（保留作为回归依据）：
 *   - 未声明依赖时 `import ... from '@deepseek-ai/dsh-llm/message'`
 *     → `TS2307: Cannot find module`（Task 8 复现，隐藏 link 后仍为 TS2307）。
 *   - 声明依赖、但仍返回旧的 `{content: string, source}` 形状
 *     → `TS2345: Argument of type '{ content: string; ... }' is not assignable to
 *        parameter of type 'UserMessage'` —— 证明 `inject` 确实要求完整消息，
 *        断言不是"多余的防御"，而是在掩盖两个真实的缺字段。
 *
 * 旧形状在**运行时**也是残的：缺 `id` 与 `role`。`createUserMessage` 补上
 * `role: 'user'` 与 `id: MessageId(crypto.randomUUID())`，并 `deepFreeze` 后返回。
 *
 * `source.form: 'notice'` 是有意选择：注入的是一行「这里 X 适用」的一次性提示，
 * 既不是 `snapshot`（不会被后续快照取代），也不是 `catalog`/`instructions`，
 * 正是 `ContextForm` 里 `notice` 的语义（"a one-off account of something that
 * just happened; it supersedes nothing"）。`summary` 同取该行，供折叠行显示。
 */
export function createHintMessage(line: string) {
  return createUserMessage({
    content: [{ type: 'text', text: line }],
    source: { kind: 'plugin', plugin: name, form: 'notice', summary: line },
  })
}
