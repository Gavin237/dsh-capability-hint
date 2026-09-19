import { describe, it, expect, vi } from 'vitest'
import type { Context, Events } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { apply, extractText } from '../src/index'
import { Config } from '../src/config'

// ---------------------------------------------------------------------------
// 类型契约（Finding 1）
//
// 上一轮的死因是 `ctx.on('agent/pre-step', ...)` 触发 `TS2345`，而当时的测试
// 用 `as any` 把每一次调用点都抹平了 —— 事件名写错测试照样通过，类型正确性
// 完全落在 `pnpm typecheck` 上。这里把事件名钉死在 `Events` 上：
//
//   `satisfies keyof Events` 在编译期校验事件名，写错即报错；
//   `ctx.on(EVENT, ...)` 与 `ctx.on('agent/pre-step', ...)` 受同一约束；
//   `listeners` 存的是 `Events[typeof EVENT]`（真实监听器签名），
//   `ctx.on` 也按该签名校验 —— 事件名写错时 `apply()` 与 `listeners.get()`
//   两处**同时**编译失败，不再依赖单个校验点。
// ---------------------------------------------------------------------------
const EVENT = 'agent/pre-step' satisfies keyof Events

/**
 * 监听器的真实签名，直接取自 `Events`。
 *
 * 不用 `Parameters<Context['on']>[1]`：`Context` 上 `on` 有多个重载，取到的
 * 是事件派发那个（5 参数）而不是注册那个，会让 `ctx.on` 的伪造绕过检查。
 */
type PreStepListener = Events[typeof EVENT]

/** 最小假的 Context：只提供监听器注册能力。 */
function makeCtx() {
  const listeners = new Map<string, PreStepListener>()
  const provided = new Map<string, unknown>()
  const ctx = {
    // 参数名沿用真实的 `name`，避免用 `string` 之类的宽类型把事件名写放松。
    on: (name: typeof EVENT, fn: PreStepListener) => {
      listeners.set(name, fn)
      return () => listeners.delete(name)
    },
    // I2：`apply()` 现在把台账注册为 ctx 服务，假 Context 必须一并提供，
    // 否则用例会在 `ctx.provide is not a function` 上失败 —— 与插件无关的噪音。
    provide: (name: string, value?: unknown) => {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    skills: { list: async () => [] },
  }
  return { ctx, listeners, provided }
}

/** 注册监听器并取回唯一那一个；取代原先每个用例里的 `as any` 调用。 */
function mount(config?: Record<string, unknown>) {
  const { ctx, listeners } = makeCtx()
  // 唯一保留的断言：把「只有 on()/skills 的假 Context」桥接成真实的 Context。
  // ctx.on 本身不接受 string，所以这里不会掩盖事件名写错。
  apply(ctx as unknown as Context, cfg(config))
  const listener = listeners.get(EVENT)
  if (!listener) throw new Error(`no listener registered for ${EVENT}`)
  return listener
}

type PreStepPayload = {
  agent: { inject: (m: unknown) => void }
  messages: unknown[]
  turn: number
  step: number
  signal: AbortSignal
}

function makePayload(texts: string[]) {
  const injected: unknown[] = []
  const payload: PreStepPayload = {
    agent: { inject: (m: unknown) => injected.push(m) },
    messages: texts.map((t) => ({ content: t })),
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }
  return { injected, payload }
}

/**
 * 调用监听器。假 payload 缺 `UserMessage` 的 id/role/source 等字段，
 * 构造一条合规的 durable 消息属于 Task 6（ledger）的范围，故此处桥接一次。
 *
 * 事件签名还带 `this: Scoped<Agent>`（scope 过滤用），而 `Function.prototype.call`
 * 的 `this` 类型是 `void`，故同时桥接 this 参数。**只桥接调用入口** ——
 * 返回类型与全部断言都不经过任何断言。
 */
function invoke(listener: PreStepListener, payload: PreStepPayload, next: () => Promise<PreStepDecision>) {
  return (listener as (this: void, ...args: unknown[]) => Promise<PreStepDecision>).call(undefined, payload, next)
}

/**
 * 下游决策哨兵（Finding 2）。
 *
 * 必须是一个**合法**的 `PreStepDecision` 成员，且与"什么都不做"的默认值可
 * 区分 —— 否则断言 `decision === SENTINEL` 无法证明监听器真的调用了 `next()`
 * 并原样透传。
 */
const SENTINEL: PreStepDecision = { kind: 'reject' }

/**
 * 下游「进入本步」的哨兵 —— C1 之后，提示走的就是这条通道。
 *
 * 与 `SENTINEL` 同理：必须是**合法且可区分**的 `PreStepDecision`。这里刻意
 * 预置六条消息（含一条非文本块），用来钉住「既有消息一条不丢、不改、不重排」。
 */
function makeEnterDecision(): PreStepDecision {
  return {
    kind: 'enter',
    messages: [
      { id: 'm1', role: 'user', content: [] },
      { id: 'm2', role: 'user', content: [{ type: 'text', text: '第二条' }] },
      { id: 'm3', role: 'user', content: [{ type: 'text', text: '第三条' }] },
      { id: 'm4', role: 'user', content: [] },
      { id: 'm5', role: 'user', content: [{ type: 'text', text: '第五条' }] },
      { id: 'm6', role: 'user', content: [] },
    ],
  } as unknown as PreStepDecision
}

/** 从决策里取回追加的那条提示文本（拿不到就返回空串）。 */
function hintTextOf(decision: PreStepDecision): string {
  if (decision.kind !== 'enter') return ''
  const messages = decision.messages as unknown[]
  return JSON.stringify(messages[messages.length - 1] ?? {})
}

// Task 1 的已知坑：`Config({})` 直接调用会让 tsc 因 `Schema<S, T>` 的调用签名
// 需要完整 input 泛型而报错。这里在测试文件内局部放宽入参类型，
// **不动 src/config.ts**。
const cfg = Config as unknown as (input?: Record<string, unknown>) => Parameters<typeof apply>[1]

describe('extractText', () => {
  it('reads a plain string content', () => {
    expect(extractText({ content: 'hello' })).toBe('hello')
  })

  it('reads a block-array content', () => {
    expect(extractText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a b')
  })

  it('returns empty string for unknown shapes', () => {
    expect(extractText({})).toBe('')
    expect(extractText(null)).toBe('')
    expect(extractText(42)).toBe('')
  })
})

describe('pre-step listener', () => {
  it('registers exactly one listener', () => {
    const { ctx, listeners } = makeCtx()
    apply(ctx as unknown as Context, cfg({}))
    expect(listeners.has(EVENT)).toBe(true)
  })

  it('appends the hint to an enter decision and preserves every existing message', async () => {
    const listener = mount()
    const enter = makeEnterDecision()
    const next = vi.fn(async (): Promise<PreStepDecision> => enter)
    const { payload } = makePayload(['帮我做个设计方案'])

    const decision = await invoke(listener, payload, next)

    // waterfall 契约：正好调用一次下游。
    expect(next).toHaveBeenCalledTimes(1)
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('unreachable')

    // 原样保留下游的**每一条**消息，顺序不变（前 6 条逐一同一引用）。
    const original = (enter as { messages: unknown[] }).messages
    expect(decision.messages).toHaveLength(original.length + 1)
    for (let i = 0; i < original.length; i += 1) {
      expect(decision.messages[i]).toBe(original[i])
    }

    // 提示排在**末尾**，且内容正确。
    expect(hintTextOf(decision)).toContain('brainstorming')
    expect(hintTextOf(decision)).toContain('本轮可能适用')
  })

  it('returns a reject decision unchanged, never appending to it', async () => {
    // C1 组合规则第 3 条：`reject` 说明本步不进入，追加消息既无意义也无位置。
    const listener = mount()
    const next = vi.fn(async (): Promise<PreStepDecision> => SENTINEL)
    const { payload } = makePayload(['帮我做个设计方案'])

    const decision = await invoke(listener, payload, next)

    expect(decision).toBe(SENTINEL)
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('does not inject when nothing matches', async () => {
    const listener = mount()
    const enter = makeEnterDecision()
    const next = vi.fn(async (): Promise<PreStepDecision> => enter)
    const { payload } = makePayload(['今天天气不错'])
    const decision = await invoke(listener, payload, next)
    // 无提示 → 决策原样透传（连数组都不是新的）。
    expect(decision).toBe(enter)
  })

  it('does not inject on an empty claimed batch (tool continuation step)', async () => {
    const listener = mount()
    const enter = makeEnterDecision()
    const next = vi.fn(async (): Promise<PreStepDecision> => enter)
    const { payload } = makePayload([])
    const decision = await invoke(listener, payload, next)
    expect(decision).toBe(enter)
  })

  it('does not inject when disabled', async () => {
    const listener = mount({ enabled: false })
    const enter = makeEnterDecision()
    const next = vi.fn(async (): Promise<PreStepDecision> => enter)
    const { payload } = makePayload(['帮我做个设计方案'])
    const decision = await invoke(listener, payload, next)
    expect(decision).toBe(enter)
  })

  it('fails open: a throwing inject never breaks the turn', async () => {
    const listener = mount()
    const enter = makeEnterDecision()
    const next = vi.fn(async (): Promise<PreStepDecision> => enter)
    const payload: PreStepPayload = {
      agent: {
        inject: () => {
          throw new Error('boom')
        },
      },
      messages: [{ content: '帮我做个设计方案' }],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }

    // 提示现在走决策通道，`inject` 的异常不再可能中断本步；下游决策仍被调用一次。
    const decision = await invoke(listener, payload, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(decision.kind).toBe('enter')
  })
})

// ---------------------------------------------------------------------------
// C1 —— 真实步骤序列（本仓最高价值的测试）。
//
// 为什么先前 8 个任务全绿的套件漏掉了 C1：**每个用例都自己手搓
// `payload.messages`**，于是 `messages` 永远是"人写的"，从不含插件自己的输出。
// 真实的驱动并非如此 —— `inject()` 写的是 `next-step` 收件箱，被**下一步**claim，
// 于是从 step 2 起，`payload.messages` 里就躺着插件上一步注入的那行提示。
// 那时 `messages.length > 0` 依然成立，如果提示文本里恰好有触发词
// （例如技能名 `brainstorming` 里的 "brainstorm"，或提示前缀之外的任何词），
// 插件就会**每步重新触发自己**，无界地往下追加消息。
//
// 因此本用例不再手搓第二步的 payload：把它**上一步真正追加/注入的消息**
// 原样喂回去。断言只有一条 —— 第二步不得再产出任何东西。
// ---------------------------------------------------------------------------
describe('C1: no self-retrigger across the real step sequence', () => {
  /**
   * 模拟驱动的「第 N 步」。
   *
   * `humanTexts` 是人/工具产出的消息；`appendedFromLastStep` 是**上一步真正
   * 进入本步的消息**（即上一步决策里被追加的那条提示）—— 原样喂回，不重写、
   * 不伪造。`step` 递增，因为只有递增的 step 才复现"上一步的输出出现在下一步"。
   */
  function makeStepPayload(humanTexts: string[], appendedFromLastStep: unknown[], turn: number, step: number) {
    const injected: unknown[] = []
    const payload: PreStepPayload = {
      agent: { inject: (m: unknown) => injected.push(m) },
      messages: [...humanTexts.map((t) => ({ content: t })), ...appendedFromLastStep],
      turn,
      step,
      signal: new AbortController().signal,
    }
    return { injected, payload }
  }

  /** 取出决策里**新增**的提示消息（与下游决策的长度相同则说明什么都没加）。 */
  function appendedHint(decision: PreStepDecision, downstream: PreStepDecision): unknown {
    if (decision.kind !== 'enter' || downstream.kind !== 'enter') return undefined
    const before = downstream.messages as unknown[]
    const after = decision.messages as unknown[]
    return after.length > before.length ? after[after.length - 1] : undefined
  }

  it('does not inject again on step 2 when step 2 carries the plugin own hint', async () => {
    const listener = mount()
    let downstream = makeEnterDecision()
    const next = vi.fn(async (): Promise<PreStepDecision> => downstream)

    // --- step 1：人的消息，命中 → 决策被追加一行提示 ------------------------
    const step1 = makeStepPayload(['帮我做个设计方案'], [], 1, 1)
    downstream = makeEnterDecision()
    const d1 = await invoke(listener, step1.payload, next)
    const carriedOver = appendedHint(d1, downstream)
    expect(carriedOver).toBeDefined()

    // 驱动的真实行为：上一步追加的消息成为**下一步** payload.messages 的一员。
    // 这是唯一能暴露自喂的形态 —— 也是过去所有用例都手搓掉的那一步。
    const step2 = makeStepPayload([], [carriedOver], 1, 2)
    downstream = makeEnterDecision()
    const d2 = await invoke(listener, step2.payload, next)

    // 核心断言：第二步不得再产出任何东西（既不加消息，也不走 inject）。
    expect(appendedHint(d2, downstream)).toBeUndefined()
    expect(step2.injected).toHaveLength(0)
  })

  it('does not re-record applicable on step 2 (the denominator cannot inflate)', async () => {
    const { ctx, listeners } = makeCtx()
    const ledger = apply(ctx as unknown as Context, cfg({}))
    const listener = listeners.get(EVENT)
    if (!listener) throw new Error(`no listener registered for ${EVENT}`)
    let downstream = makeEnterDecision()
    const next = vi.fn(async (): Promise<PreStepDecision> => downstream)

    const step1 = makeStepPayload(['帮我做个设计方案'], [], 1, 1)
    downstream = makeEnterDecision()
    const d1 = await invoke(listener, step1.payload, next)
    const afterStep1 = ledger.entries().length
    expect(afterStep1).toBeGreaterThan(0)
    const carriedOver = appendedHint(d1, downstream)
    expect(carriedOver).toBeDefined()

    const step2 = makeStepPayload([], [carriedOver], 1, 2)
    await invoke(listener, step2.payload, next)

    // 分母（applicable 条目数）在第二步之后不得增长。
    expect(ledger.entries().length).toBe(afterStep1)
  })

  it('is immune even if a step-1 batch already contains the plugin own message', async () => {
    // `step === 1` 是主闸门，`source.plugin === name` 是第二道：即便第一道
    // 因某种原因不再成立（例如未来驱动复用了 step 语义），插件也不可能
    // 靠自己的输出来触发自己。
    const listener = mount()
    const enter = makeEnterDecision()
    const next = vi.fn(async (): Promise<PreStepDecision> => enter)
    const own = { content: 'brainstorm 设计 方案', source: { kind: 'plugin', plugin: 'dsh-capability-hint' } }

    const step1 = makeStepPayload([], [own], 1, 1)
    const decision = await invoke(listener, step1.payload, next)

    // 整批只有插件自己的输出 → 无文本可匹配 → 决策原样透传。
    expect(decision).toBe(enter)
    expect(step1.injected).toHaveLength(0)
  })

  it('still injects on the next turn (the gate is step, not turn)', async () => {
    // 反向对照：闸门是 `step === 1`，所以同一轮里 step 1 之后不再重复注入；
    // 但**下一轮**的 step 1 必须照常工作 —— 否则"修好了自喂"会退化成"永不注入"。
    const listener = mount()
    const next = vi.fn(async (): Promise<PreStepDecision> => makeEnterDecision())

    const turn1 = makeStepPayload(['帮我做个设计方案'], [], 1, 1)
    const d1 = await invoke(listener, turn1.payload, next)
    expect(hintTextOf(d1)).toContain('brainstorming')

    const turn2 = makeStepPayload(['这个报错怎么排查'], [], 2, 1)
    const d2 = await invoke(listener, turn2.payload, next)
    expect(hintTextOf(d2)).toContain('systematic-debugging')
  })
})
