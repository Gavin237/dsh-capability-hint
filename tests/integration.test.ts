import { describe, it, expect } from 'vitest'
import { apply, extractText } from '../src/index'
import { Config } from '../src/config'

/** 最小假的 Context：只提供监听器注册能力。 */
function makeCtx() {
  const listeners = new Map<string, Function>()
  const ctx = {
    on: (evt: string, fn: Function) => {
      listeners.set(evt, fn)
      return () => listeners.delete(evt)
    },
    skills: { list: async () => [] },
  }
  return { ctx, listeners }
}

function makePayload(texts: string[]) {
  const injected: unknown[] = []
  return {
    injected,
    payload: {
      agent: { inject: (m: unknown) => injected.push(m) },
      messages: texts.map((t) => ({ content: t })),
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    },
  }
}

const next = async () => ({ kind: 'enter', messages: [] }) as const

// Task 1 的已知坑：`Config({})` 直接调用会让 tsc 因 `Schema<S, T>` 的调用签名
// 需要完整 input 泛型而报错。这里在测试文件内局部放宽入参类型，
// **不动 src/config.ts**。
const cfg = Config as unknown as (input?: Record<string, unknown>) => {
  enabled: boolean
  maxHintsPerTurn: number
  hintPrefix: string
  rulesPath: string
  excludeSkills: string[]
}

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
    apply(ctx as any, cfg({}) as any)
    expect(listeners.has('agent/pre-step')).toBe(true)
  })

  it('injects a hint when the turn text matches a rule', async () => {
    const { ctx, listeners } = makeCtx()
    apply(ctx as any, cfg({}) as any)
    const { injected, payload } = makePayload(['帮我做个设计方案'])
    const decision = await (listeners.get('agent/pre-step') as any)(payload, next)
    expect(injected).toHaveLength(1)
    expect(JSON.stringify(injected[0])).toContain('brainstorming')
    // 决策必须原样透传
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('does not inject when nothing matches', async () => {
    const { ctx, listeners } = makeCtx()
    apply(ctx as any, cfg({}) as any)
    const { injected, payload } = makePayload(['今天天气不错'])
    await (listeners.get('agent/pre-step') as any)(payload, next)
    expect(injected).toHaveLength(0)
  })

  it('does not inject on an empty claimed batch (tool continuation step)', async () => {
    const { ctx, listeners } = makeCtx()
    apply(ctx as any, cfg({}) as any)
    const { injected, payload } = makePayload([])
    await (listeners.get('agent/pre-step') as any)(payload, next)
    expect(injected).toHaveLength(0)
  })

  it('does not inject when disabled', async () => {
    const { ctx, listeners } = makeCtx()
    apply(ctx as any, cfg({ enabled: false }) as any)
    const { injected, payload } = makePayload(['帮我做个设计方案'])
    await (listeners.get('agent/pre-step') as any)(payload, next)
    expect(injected).toHaveLength(0)
  })

  it('fails open: a throwing inject never breaks the turn', async () => {
    const { ctx, listeners } = makeCtx()
    apply(ctx as any, cfg({}) as any)
    const payload = {
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
    await expect((listeners.get('agent/pre-step') as any)(payload, next)).resolves.toEqual({
      kind: 'enter',
      messages: [],
    })
  })
})
