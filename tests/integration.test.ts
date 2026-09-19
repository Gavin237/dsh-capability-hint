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
  const ctx = {
    // 参数名沿用真实的 `name`，避免用 `string` 之类的宽类型把事件名写放松。
    on: (name: typeof EVENT, fn: PreStepListener) => {
      listeners.set(name, fn)
      return () => listeners.delete(name)
    },
    skills: { list: async () => [] },
  }
  return { ctx, listeners }
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

  it('injects a hint and passes the downstream decision through unchanged', async () => {
    const listener = mount()
    const next = vi.fn(async (): Promise<PreStepDecision> => SENTINEL)
    const { injected, payload } = makePayload(['帮我做个设计方案'])

    const decision = await invoke(listener, payload, next)

    expect(injected).toHaveLength(1)
    expect(JSON.stringify(injected[0])).toContain('brainstorming')

    // waterfall 契约：正好调用一次下游，且返回值原样透传。
    // 断言的是哨兵本身，而不是"一个恰好等于默认值的对象"——
    // 返回硬编码值的实现会在下面两行同时失败。
    expect(next).toHaveBeenCalledTimes(1)
    expect(decision).toBe(SENTINEL)
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('does not inject when nothing matches', async () => {
    const listener = mount()
    const next = vi.fn(async (): Promise<PreStepDecision> => SENTINEL)
    const { injected, payload } = makePayload(['今天天气不错'])
    await invoke(listener, payload, next)
    expect(injected).toHaveLength(0)
  })

  it('does not inject on an empty claimed batch (tool continuation step)', async () => {
    const listener = mount()
    const next = vi.fn(async (): Promise<PreStepDecision> => SENTINEL)
    const { injected, payload } = makePayload([])
    await invoke(listener, payload, next)
    expect(injected).toHaveLength(0)
  })

  it('does not inject when disabled', async () => {
    const listener = mount({ enabled: false })
    const next = vi.fn(async (): Promise<PreStepDecision> => SENTINEL)
    const { injected, payload } = makePayload(['帮我做个设计方案'])
    await invoke(listener, payload, next)
    expect(injected).toHaveLength(0)
  })

  it('fails open: a throwing inject never breaks the turn', async () => {
    const listener = mount()
    const next = vi.fn(async (): Promise<PreStepDecision> => SENTINEL)
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

    await expect(invoke(listener, payload, next)).resolves.toBe(SENTINEL)
    expect(next).toHaveBeenCalledTimes(1)
  })
})
