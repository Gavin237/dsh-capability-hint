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
    const out = defaultInvocationRate([
      e(1, 'applicable', 'good'),
      e(2, 'invoked', 'good'),
      e(3, 'applicable', 'bad'),
      e(4, 'applicable', 'bad'),
    ])
    expect(out.map((r) => r.skill)).toEqual(['bad', 'good'])
  })

  it('clamps the rate at 1 when invoked exceeds applicable', () => {
    const out = defaultInvocationRate([e(1, 'applicable', 'a'), e(2, 'invoked', 'a'), e(3, 'invoked', 'a')])
    expect(out[0].rate).toBe(1)
  })
})
