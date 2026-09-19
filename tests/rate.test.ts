import { describe, it, expect } from 'vitest'
import { defaultInvocationRate } from '../src/rate'
import type { LedgerEntry } from '../src/ledger'

const e = (seq: number, kind: 'applicable' | 'invoked', skill: string): LedgerEntry => ({
  seq,
  time: 0,
  kind,
  skill,
  turn: 1,
})

describe('defaultInvocationRate', () => {
  it('computes invoked / applicable per skill', () => {
    const out = defaultInvocationRate([e(1, 'applicable', 'a'), e(2, 'applicable', 'a'), e(3, 'invoked', 'a')])
    expect(out).toEqual([{ skill: 'a', applicable: 2, invoked: 1, rate: 0.5 }])
  })

  it('reports 0 for a skill that was never invoked', () => {
    const out = defaultInvocationRate([e(1, 'applicable', 'ghost')])
    expect(out[0].rate).toBe(0)
  })

  it('ignores invoked entries with no applicable baseline', () => {
    expect(defaultInvocationRate([e(1, 'invoked', 'x')])).toEqual([])
  })

  it('sorts by ascending rate so the dead ones surface first', () => {
    // 名字序与 rate 序**相反**：'zzz' 是 applicable-only（rate 0，最死，应排最前），
    // 'aaa' 每次都被调用（rate 1，应排最后）。
    // 若实现退化为纯 localeCompare 排序而丢掉 rate，本用例必然失败。
    const out = defaultInvocationRate([
      e(1, 'applicable', 'aaa'),
      e(2, 'invoked', 'aaa'),
      e(3, 'applicable', 'zzz'),
    ])
    expect(out.map((r) => r.skill)).toEqual(['zzz', 'aaa'])
  })

  it('orders three skills inversely to their names, not lexicographically', () => {
    // rate 升序 = ['ccc'(0), 'bbb'(0.5), 'aaa'(1)]，恰好是名字序的逆序。
    // 分母取 2 以免撞上 clamp：'aaa' 用 2/2=1 而不是 2/1（后者会被钳成 1 与 'bbb' 并列）。
    const out = defaultInvocationRate([
      e(1, 'applicable', 'ccc'),
      e(2, 'applicable', 'bbb'),
      e(3, 'applicable', 'bbb'),
      e(4, 'invoked', 'bbb'),
      e(5, 'applicable', 'aaa'),
      e(6, 'applicable', 'aaa'),
      e(7, 'invoked', 'aaa'),
      e(8, 'invoked', 'aaa'),
    ])
    expect(out.map((r) => r.skill)).toEqual(['ccc', 'bbb', 'aaa'])
    expect(out.map((r) => r.rate)).toEqual([0, 0.5, 1])
  })

  it('still breaks ties by name when rates are equal', () => {
    const out = defaultInvocationRate([
      e(1, 'applicable', 'b'),
      e(2, 'applicable', 'a'),
      e(3, 'applicable', 'c'),
    ])
    expect(out.map((r) => r.skill)).toEqual(['a', 'b', 'c'])
  })

  it('clamps the rate at 1 when invoked exceeds applicable', () => {
    const out = defaultInvocationRate([e(1, 'applicable', 'a'), e(2, 'invoked', 'a'), e(3, 'invoked', 'a')])
    expect(out[0].rate).toBe(1)
  })

  it('does not mutate the input array or its entries', () => {
    const entries: LedgerEntry[] = [
      e(1, 'applicable', 'good'),
      e(2, 'invoked', 'good'),
      e(3, 'applicable', 'bad'),
    ]
    const snapshot = structuredClone(entries)
    const identities = entries.map((o) => o)

    defaultInvocationRate(entries)

    expect(entries).toEqual(snapshot)
    expect(entries).toHaveLength(3)
    // 条目对象本身未被替换/重排
    expect(entries).toEqual(identities)
  })

  it('does not mutate a frozen input', () => {
    const entries: LedgerEntry[] = Object.freeze([
      Object.freeze(e(1, 'applicable', 'b')),
      Object.freeze(e(2, 'applicable', 'a')),
      Object.freeze(e(3, 'invoked', 'a')),
    ]) as LedgerEntry[]

    // 在冻结输入上排序会抛 TypeError，故能同时抓住「原地排序」与「写回字段」两类变异
    expect(() => defaultInvocationRate(entries)).not.toThrow()
    // 'a' 被调用过（rate 1），'b' 从未（rate 0）——升序即使死的排前
    expect(defaultInvocationRate(entries).map((r) => r.skill)).toEqual(['b', 'a'])
  })

  it('returns fresh objects that do not alias the input entries', () => {
    const entries = [e(1, 'applicable', 'a')]
    const out = defaultInvocationRate(entries)
    expect(out[0]).not.toBe(entries[0] as unknown)
    expect(Object.keys(out[0])).toEqual(['skill', 'applicable', 'invoked', 'rate'])
  })
})
