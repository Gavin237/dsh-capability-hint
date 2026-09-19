import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { UserMessage } from '@deepseek-ai/dsh-llm/message'
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

// 同理转发 `rate.ts`：`defaultInvocationRate` 是 spec §3 的**唯一成功指标**，
// 而 tarball 只发 `lib/` + `cordis.patch.yml`，深路径 `.../src/rate` 在安装后
// 不可达 —— 不转发的话 README 的停用判据就没有入口可调。
export { defaultInvocationRate } from './rate'
export type { RateReport } from './rate'

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

/** 建立一个实例级台账。纯内存：持久化（`ctx.storage`）到目前为止仍是未做的决定，不在本插件内。 */
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

/**
 * 暴露给 `ctx` 的服务名。
 *
 * I2：`apply()` 的返回值只有**直接调用 `apply` 的人**拿得到，运行中的 harness
 * 不持有它，于是台账被封在 `apply()` 的闭包里 —— `defaultInvocationRate` 导出了
 * 却没有可达的 entries 可喂。把同一份台账再 `ctx.provide` 一次，就让
 * `ctx['dsh-capability-hint'].entries()` 成为**运行期可达**的读取路径，
 * 同时不影响已有的返回值契约（同一个对象，两条路）。
 */
export const LEDGER_SERVICE = 'dsh-capability-hint' as const

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 本插件提供的实例级台账（只读快照语义）。 */
    'dsh-capability-hint': Ledger
  }
}

export function apply(ctx: Context, config: ConfigShape): Ledger {
  const exclude = new Set(config.excludeSkills ?? [])

  // 实例级台账：每次 `apply()` 一份新状态。绝不用模块级 `let` ——
  // 那会跨 Agent 实例泄漏记录，并在插件重载后残留旧数据。
  const ledger = createLedger()

  // I2：把台账注册为 ctx 服务。`ctx.provide` 在插件卸载时自动注销，
  // 因此它与 `apply` 的返回句柄共享同一个生命周期与同一份状态。
  ctx.provide(LEDGER_SERVICE, ledger)

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
  //
  // **通道裁决（C1，显式偏离计划 Global Constraints "不通过 PreStepDecision 改消息"）**：
  // `agent.inject()` 走的是 **next-step** 收件箱（`inject(input) { this.send(input, "next-step", false) }`），
  // 而驱动在 `preStep` 里**已经先 `claim()` 掉了本步批次**，之后才派发 waterfall
  // （官方文档 `docs/subsystems/core.md:139-144` 原文："It may miss a request whose
  // pre-step already claimed its batch."）。因此 inject 出来的提示**必然晚一步**到达：
  // 该用它来选能力的那个模型调用看不到它 —— 插件的前提目的落空。
  // 唯一能落进**本步**的机制就是 `enter` 决策的 `messages`。
  //
  // 这不是替换决策，而是**组合**：先 `await next()` 拿到下游决策，只在
  // `kind === 'enter'` 时把提示追加到 `messages` 末尾；`reject` 与"无提示"
  // 一律**原样透传**（连数组引用都不换）。既有消息一条不丢、不改、不重排。
  //
  // 刻意**不再**调用 `agent.inject()`：那条通道既然必然晚一步，留着只会让
  // "提示到底进没进本步"这件事同时有两种答案。每轮只走一条通道。
  ctx.on(
    'agent/pre-step',
    async (
      payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision> => {
      // 先取下游决策：无论我们是否追加提示，下游都必须被调用一次且只被调用一次。
      const decision = await next()

      let hint: UserMessage | null = null
      try {
        // M3：`lastTurn` 每轮都更新，而不是只在注入了提示时才更新 ——
        // 否则"本轮无命中"之后紧接着的技能调用会被归到上一轮。
        if (config.enabled && typeof payload?.turn === 'number') {
          lastTurn = payload.turn
        }

        if (config.enabled && payload?.step === 1 && Array.isArray(payload.messages)) {
          // C1 防御纵深（两层，独立于通道选择）：
          //   ① `step === 1` 是"每轮第一次 proposal"的**真**判据，且免疫收件箱自喂
          //      （自喂的消息总是出现在后续 step）。工具续步的批次由驱动在
          //      `messages.length === 0` 时提交（spec §12.6），两道闸门互补。
          //   ② 排除 `source.plugin === name` 的消息：插件永不可能匹配自己的输出。
          const texts = payload.messages
            .filter((m) => !isOwnMessage(m))
            .map(extractText)
            .filter(Boolean)

          if (texts.length > 0) {
            const matches = matchCapabilities(texts, BUILTIN_RULES, {
              max: config.maxHintsPerTurn,
              exclude,
            })
            const line = renderHint(matches, config.hintPrefix)
            if (line) {
              ledger.recordApplicable(matches, payload.turn ?? NO_TURN, Date.now())
              hint = createHintMessage(line)
            }
          }
        }
      } catch {
        // 静默失败：提示是增强，不是必需。下游决策已经拿到，不受影响。
      }

      // 只在**已进入**的步骤上追加；`reject` 与"无提示"一律原样返回。
      // 既有消息一条不丢、不改、不重排 —— 提示永远排在末尾。
      if (hint && decision.kind === 'enter') {
        return { kind: 'enter', messages: [...decision.messages, hint] }
      }
      return decision
    },
    { prepend: true },
  )

  return ledger
}

/**
 * 这条消息是不是本插件自己产出的。
 *
 * C1 的第二道闸门：即便 `step === 1` 失效（例如未来驱动改了 step 语义），
 * 插件也不可能靠自己的输出重新触发自己 —— 自喂提示的 `source.plugin`
 * 恒等于 `name`（见 `createHintMessage`）。
 */
function isOwnMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const source = (message as { source?: unknown }).source
  if (!source || typeof source !== 'object') return false
  return (source as { plugin?: unknown }).plugin === name
}

/**
 * 构造注入用的消息体。
 *
 * 用官方工厂 `createUserMessage`（`@deepseek-ai/dsh-llm/message`），返回真正的
 * `UserMessage`：补上 `role: 'user'` 与 `id: MessageId(crypto.randomUUID())`，
 * 并 `deepFreeze` 后返回。
 *
 * Task 5 曾因 `@deepseek-ai/dsh-llm` 未声明为依赖而在调用点抹掉类型检查；
 * Task 8 补上依赖后该断言已删除。**`src/` 全目录现无任何类型断言**
 * （唯一的 `as const` 是 `LEDGER_SERVICE` 的字面量收窄，不掩盖任何类型信息）。
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
