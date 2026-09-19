import { describe, it, expect, vi } from 'vitest'
import type { Context, Events } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { appendEntry, observeToolCall, recordApplicable } from '../src/ledger'
import type { LedgerEntry } from '../src/ledger'
import { apply } from '../src/index'
import { Config } from '../src/config'

// ---------------------------------------------------------------------------
// 纯函数（Global Constraints：无 I/O、无时钟、无随机）。
// ---------------------------------------------------------------------------

describe('appendEntry', () => {
  it('assigns a monotonic seq', () => {
    let log = appendEntry([], { time: 1, kind: 'applicable', skill: 'a', turn: 1 })
    log = appendEntry(log, { time: 2, kind: 'invoked', skill: 'a', turn: 1 })
    expect(log.map((e) => e.seq)).toEqual([1, 2])
  })

  it('does not mutate the input array', () => {
    const before: any[] = []
    appendEntry(before, { time: 1, kind: 'applicable', skill: 'a', turn: 1 })
    expect(before).toHaveLength(0)
  })

  it('does not mutate a non-empty input array and returns a new one', () => {
    const before = appendEntry([], { time: 1, kind: 'applicable', skill: 'a', turn: 1 })
    const after = appendEntry(before, { time: 2, kind: 'invoked', skill: 'a', turn: 1 })
    expect(after).not.toBe(before)
    expect(before).toHaveLength(1)
    expect(before[0].seq).toBe(1)
  })

  it('keeps the caller-supplied time verbatim (no clock inside)', () => {
    const [e] = appendEntry([], { time: 12345, kind: 'invoked', skill: 's', turn: 7 })
    expect(e).toEqual({ seq: 1, time: 12345, kind: 'invoked', skill: 's', turn: 7 })
  })
})

describe('observeToolCall', () => {
  it('extracts the skill name from a skill tool call', () => {
    expect(observeToolCall('skill', { name: 'brainstorming' })).toBe('brainstorming')
  })

  it('returns null for other tools', () => {
    expect(observeToolCall('pwsh', { command: 'ls' })).toBeNull()
  })

  it('returns null for a malformed skill call', () => {
    expect(observeToolCall('skill', {})).toBeNull()
    expect(observeToolCall('skill', null)).toBeNull()
  })

  // 完全函数契约：任何输入都不抛错。
  it('is total across hostile inputs', () => {
    const hostile = [undefined, null, 0, 1, '', 'brainstorming', [], {}, { name: '' }, { name: 42 }, { name: null }]
    for (const args of hostile) {
      expect(() => observeToolCall('skill', args)).not.toThrow()
      expect(observeToolCall('skill', args)).toBeNull()
    }
  })

  it('ignores a non-string name and a non-skill tool name', () => {
    expect(observeToolCall('skill', { name: { toString: () => 'x' } })).toBeNull()
    expect(observeToolCall('SKILL', { name: 'brainstorming' })).toBeNull()
  })
})

describe('recordApplicable', () => {
  it('appends one applicable entry per match, sharing turn and time', () => {
    const log = recordApplicable([], [{ skill: 'a', hit: 'x' }, { skill: 'b', hit: 'y' }], 3, 99)
    expect(log).toEqual([
      { seq: 1, time: 99, kind: 'applicable', skill: 'a', turn: 3 },
      { seq: 2, time: 99, kind: 'applicable', skill: 'b', turn: 3 },
    ])
  })

  it('does not mutate the input and continues an existing seq', () => {
    const before = appendEntry([], { time: 1, kind: 'invoked', skill: 'z', turn: 1 })
    const after = recordApplicable(before, [{ skill: 'a', hit: 'x' }], 2, 50)
    expect(before).toHaveLength(1)
    expect(after.map((e) => e.seq)).toEqual([1, 2])
  })

  it('returns the input unchanged for no matches', () => {
    const before = appendEntry([], { time: 1, kind: 'invoked', skill: 'z', turn: 1 })
    expect(recordApplicable(before, [], 2, 50)).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// 接线（Step 5）。
//
// `tool/call` **不是 Cordis 事件**：architecture.md:97 与
// persistence-catalog.md:859 把它归类为持久化 session-event *类型*。真正的
// 实时逐调用扩展点是 `tools/result` emit 事件（tools.md:702），其监听器签名
// 为 `(exec, result)` —— docs/subsystems/tools.md:714。
//
// 事件名用 `satisfies keyof Events` 钉死，与 integration.test.ts 的既有做法一致：
// 写错事件名会**同时**在 `apply()` 与 `listeners.get()` 两处编译失败。
// ---------------------------------------------------------------------------

const PRE_STEP = 'agent/pre-step' satisfies keyof Events
const TOOLS_RESULT = 'tools/result' satisfies keyof Events

type PreStepListener = Events[typeof PRE_STEP]
type ResultListener = Events[typeof TOOLS_RESULT]

/**
 * 最小假的 Context：同时提供 `on` 与 `tools`，并记录全部注册。
 *
 * `on` 用**方法简写**声明：方法签名让参数列表按双变（bivariance）判定，`this`
 * 也不受约束，因此真实的 `this: Scoped<Agent>` 与 `this: Scoped<ToolRuntime>`
 * 都能通过 —— 这正是 `agent/pre-step` 注册当前依赖的机制。参数名沿用真实的
 * `name`，避免用 `string` 之类的宽类型把事件名写放松。
 */
function makeCtx() {
  const listeners = new Map<string, unknown>()
  const provided = new Map<string, unknown>()
  const tools = { register: vi.fn() }
  // `on` 用方法简写 + 泛型参数：事件名仍是 `keyof Events`（写错即编译失败），
  // 监听器按该事件**真实的**签名校验 —— 与 integration.test.ts 的做法一致。
  // 换名时 apply() 与 listeners.get() 两处同时失败。
  const on = <K extends keyof Events>(name: K, fn: Events[K]) => {
    listeners.set(name, fn)
    return () => listeners.delete(name)
  }
  // I2：`apply()` 把台账注册为 ctx 服务；假 Context 一并提供。
  const provide = (name: string, value?: unknown) => {
    provided.set(name, value)
    return () => provided.delete(name)
  }
  const ctx = { on, provide, tools, skills: { list: async () => [] } }
  return { ctx, listeners, tools, provided }
}

function mount(config?: Record<string, unknown>) {
  const { ctx, listeners, tools, provided } = makeCtx()
  // 桥接一次：只有 `on()`/`provide()`/`tools`/`skills` 的假 Context → 真实的 `Context`。
  // `ctx.on` 本身不接受任意 string，所以这层桥接不会掩盖事件名写错。
  const cfg = Config as unknown as (i?: Record<string, unknown>) => Parameters<typeof apply>[1]
  const ledger = apply(ctx as unknown as Context, cfg(config))

  const preStep = listeners.get(PRE_STEP) as PreStepListener | undefined
  const result = listeners.get(TOOLS_RESULT) as ResultListener | undefined
  if (!preStep) throw new Error(`no listener registered for ${PRE_STEP}`)
  if (!result) throw new Error(`no listener registered for ${TOOLS_RESULT}`)
  return { preStep, result, tools, listeners, ledger, provided }
}

type PreStepPayload = {
  agent: { inject: (m: unknown) => void }
  messages: unknown[]
  turn: number
  step: number
  signal: AbortSignal
}

function makePayload(texts: string[], turn = 1) {
  const injected: unknown[] = []
  const payload: PreStepPayload = {
    agent: { inject: (m: unknown) => injected.push(m) },
    messages: texts.map((t) => ({ content: t })),
    turn,
    step: 1,
    signal: new AbortController().signal,
  }
  return { injected, payload }
}

/**
 * 调用 waterfall 监听器。
 *
 * 假 payload 缺 `UserMessage` 的 id/role/source 等字段（构造合规消息属于
 * `src/index.ts` 的内部职责）；事件签名还带 `this: Scoped<Agent>`，而
 * `Function.prototype.call` 的 `this` 类型是 `void`。**只桥接调用入口** ——
 * 返回类型与全部断言都不经过断言。
 */
function invokePreStep(listener: PreStepListener, payload: PreStepPayload, next: () => Promise<PreStepDecision>) {
  return (listener as (this: void, ...args: unknown[]) => Promise<PreStepDecision>).call(undefined, payload, next)
}

/**
 * 构造 `tools/result` 的 `exec` 实参。
 *
 * 在调用边界桥接一次：`ToolExecution` 带注册表私有的 callId/token（含 branded
 * id）与必需 signal，测试无法伪造。插件真正读取的 `name` / `arguments` 在桥接
 * 之后仍是完整类型。
 */
function execution(name: string, args: unknown): ToolExecution {
  return { name, arguments: args } as unknown as ToolExecution
}

function emitResult(listener: ResultListener, name: string, args: unknown) {
  const fn = listener as (this: void, ...a: unknown[]) => void
  fn.call(undefined, execution(name, args), { content: [] })
}

describe('ledger wiring', () => {
  it('registers a tools/result observer', () => {
    const { result } = mount()
    expect(result).toBeTypeOf('function')
  })

  it('records an invoked entry when the skill tool runs, and ignores other tools', () => {
    const { ledger, result } = mount()
    expect(ledger.entries()).toHaveLength(0)

    emitResult(result, 'pwsh', { command: 'ls' })
    emitResult(result, 'skill', { name: 'brainstorming' })
    emitResult(result, 'skill', { name: 'test-driven-development' })
    emitResult(result, 'skill', {}) // malformed → no entry

    expect(ledger.entries()).toEqual([
      { seq: 1, time: expect.any(Number), kind: 'invoked', skill: 'brainstorming', turn: 0 },
      { seq: 2, time: expect.any(Number), kind: 'invoked', skill: 'test-driven-development', turn: 0 },
    ])
  })
  it('records applicable entries when a hint is injected', async () => {
    const { ledger, preStep } = mount()
    const enter = { kind: 'enter', messages: [] } as unknown as PreStepDecision
    const next = vi.fn(async (): Promise<PreStepDecision> => enter)
    const { payload } = makePayload(['帮我做个设计方案'], 4)

    const decision = await invokePreStep(preStep, payload, next)

    // C1 之后提示走 enter 决策的 messages 通道。
    expect(decision.kind).toBe('enter')
    const entries = ledger.entries()
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      expect(e.kind).toBe('applicable')
      expect(e.turn).toBe(4)
    }
    expect(entries.map((e) => e.skill)).toContain('brainstorming')
  })

  it('records nothing when no hint is injected', async () => {
    const { ledger, preStep } = mount()
    const enter = { kind: 'enter', messages: [] } as unknown as PreStepDecision
    const next = vi.fn(async (): Promise<PreStepDecision> => enter)
    await invokePreStep(preStep, makePayload(['今天天气不错'], 1).payload, next)
    await invokePreStep(preStep, makePayload([], 2).payload, next)
    await invokePreStep(preStep, makePayload(['帮我做个设计方案'], 3).payload, next)
    const beforeDisabled = ledger.entries().length
    expect(beforeDisabled).toBeGreaterThan(0)

    const { ledger: off, preStep: offPreStep } = mount({ enabled: false })
    await invokePreStep(offPreStep, makePayload(['帮我做个设计方案'], 1).payload, next)
    expect(off.entries()).toHaveLength(0)
  })

  it('exposes the same ledger through the ctx service (I2: a reachable path)', () => {
    // I2：`apply()` 的返回值只有直接调用者拿得到；运行中的 harness 通过
    // ctx 服务名读取同一份台账。两条路径必须是**同一个对象**，否则
    // `defaultInvocationRate(ctx['dsh-capability-hint'].entries())` 会读到空。
    const { provided, ledger, result } = mount()
    const viaCtx = provided.get('dsh-capability-hint')
    expect(viaCtx).toBe(ledger)

    emitResult(result, 'skill', { name: 'brainstorming' })
    const fromCtx = (viaCtx as typeof ledger).entries()
    expect(fromCtx).toHaveLength(1)
    expect(fromCtx[0].skill).toBe('brainstorming')
  })

  it('is instance-scoped: a second apply() does not see the first ledger', () => {
    const a = mount()
    const b = mount()
    emitResult(a.result, 'skill', { name: 'brainstorming' })

    expect(a.ledger.entries()).toHaveLength(1)
    expect(b.ledger.entries()).toHaveLength(0)
    expect(a.ledger.entries()).not.toBe(b.ledger.entries())
  })

  // -------------------------------------------------------------------------
  // Finding 2：`entries()` 文档承诺「只读快照语义」，实现却把内部数组交了出去。
  // 下面这条测试把承诺钉住 —— 调用方改到的只能是副本，内部状态与 `seq`
  // 都不会被带偏。改成 `entries: () => entries`（泄漏内部引用）时它必须失败。
  // -------------------------------------------------------------------------
  it('returns a snapshot: a caller mutating it cannot corrupt internal state or seq', () => {
    const { ledger, result } = mount()
    emitResult(result, 'skill', { name: 'brainstorming' })

    const snapshot = ledger.entries() as LedgerEntry[]
    expect(snapshot).toHaveLength(1)

    // 恶意/误用的调用方：清空、倒序、并塞入伪造记录。
    snapshot.length = 0
    snapshot.push(
      { seq: 999, time: 0, kind: 'invoked', skill: 'forged', turn: 999 },
      { seq: 998, time: 0, kind: 'invoked', skill: 'forged', turn: 998 },
    )
    snapshot.sort((a, b) => b.seq - a.seq)

    // 内部状态未被污染。
    expect(ledger.entries()).toEqual([
      { seq: 1, time: expect.any(Number), kind: 'invoked', skill: 'brainstorming', turn: 0 },
    ])

    // 每次读取都是**不同的**副本（快照语义），且内容一致。
    expect(ledger.entries()).not.toBe(ledger.entries())
    expect(ledger.entries()).toEqual(ledger.entries())

    // `seq` 仍由**内部** entries.length 推导：下一条必须是 2，不是 4、不是 1000。
    emitResult(result, 'skill', { name: 'test-driven-development' })
    const after = ledger.entries()
    expect(after.map((e) => e.seq)).toEqual([1, 2])
    expect(after.map((e) => e.skill)).toEqual(['brainstorming', 'test-driven-development'])
  })

  it('hands out a fresh array per call, so a stale snapshot cannot be written through', () => {
    const { ledger, result } = mount()
    const stale = ledger.entries() as LedgerEntry[]
    expect(stale).toHaveLength(0)

    emitResult(result, 'skill', { name: 'brainstorming' })

    // 旧快照保持在取用时的状态（它是副本，不是内部数组的别名）。
    expect(stale).toHaveLength(0)
    expect(ledger.entries()).toHaveLength(1)
  })

  it('runs the seq monotonically across both kinds', async () => {
    const { ledger, preStep, result } = mount()
    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'reject' }))
    await invokePreStep(preStep, makePayload(['帮我做个设计方案'], 1).payload, next)
    emitResult(result, 'skill', { name: 'brainstorming' })

    const seqs = ledger.entries().map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(seqs[0]).toBe(1)
  })

  it('carries the last observed turn onto an invoked entry', async () => {
    const { ledger, preStep, result } = mount()
    const next = vi.fn(async (): Promise<PreStepDecision> => ({ kind: 'reject' }))
    await invokePreStep(preStep, makePayload(['帮我做个设计方案'], 9).payload, next)
    emitResult(result, 'skill', { name: 'brainstorming' })

    const invoked = ledger.entries().filter((e) => e.kind === 'invoked')
    expect(invoked).toHaveLength(1)
    expect(invoked[0].turn).toBe(9)
  })

  it('uses the documented NO_TURN sentinel before any turn is seen', () => {
    const { ledger, result } = mount()
    emitResult(result, 'skill', { name: 'brainstorming' })
    // 0 不与任何真实轮次（从 1 开始）混淆，是有定义的哨兵而非占位符。
    expect(ledger.entries()[0].turn).toBe(0)
  })

  it('never throws on malformed observed calls', () => {
    const { result } = mount()
    for (const [name, args] of [
      ['skill', null],
      ['skill', undefined],
      ['skill', 42],
      ['', {}],
    ] as [string, unknown][]) {
      expect(() => emitResult(result, name, args)).not.toThrow()
    }
  })
})
