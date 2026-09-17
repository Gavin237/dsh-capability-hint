import { describe, it, expect } from 'vitest'
import { matchCapabilities } from '../src/matcher'
import type { Rule } from '../src/rules'

const RULES: Rule[] = [
  { skill: 'brainstorming', triggers: ['设计', '方案'] },
  { skill: 'systematic-debugging', triggers: ['报错'] },
]

const opts = { max: 3, exclude: new Set<string>() }

describe('matchCapabilities', () => {
  it('matches a Chinese trigger as a substring', () => {
    const out = matchCapabilities(['帮我做个设计方案'], RULES, opts)
    expect(out).toEqual([{ skill: 'brainstorming', hit: '设计' }])
  })

  it('is case-insensitive for latin triggers', () => {
    const out = matchCapabilities(['PLEASE Debug THIS'], [{ skill: 'x', triggers: ['debug'] }], opts)
    expect(out.map((m) => m.skill)).toEqual(['x'])
  })

  it('returns the first matching trigger per rule', () => {
    const out = matchCapabilities(['方案'], RULES, opts)
    expect(out).toEqual([{ skill: 'brainstorming', hit: '方案' }])
  })

  it('joins multiple texts before matching', () => {
    const out = matchCapabilities(['无关内容', '这里报错了'], RULES, opts)
    expect(out.map((m) => m.skill)).toEqual(['systematic-debugging'])
  })

  it('returns empty for no match', () => {
    expect(matchCapabilities(['今天天气不错'], RULES, opts)).toEqual([])
  })

  it('returns empty for empty input', () => {
    expect(matchCapabilities([], RULES, opts)).toEqual([])
  })

  it('honours the exclude set', () => {
    const out = matchCapabilities(['设计方案'], RULES, { max: 3, exclude: new Set(['brainstorming']) })
    expect(out).toEqual([])
  })

  it('truncates at max', () => {
    const many: Rule[] = [
      { skill: 'a', triggers: ['x'] },
      { skill: 'b', triggers: ['x'] },
      { skill: 'c', triggers: ['x'] },
      { skill: 'd', triggers: ['x'] },
    ]
    expect(matchCapabilities(['x'], many, { max: 2, exclude: new Set() })).toHaveLength(2)
  })

  it('never returns the same skill twice', () => {
    const dup: Rule[] = [
      { skill: 'a', triggers: ['x'] },
      { skill: 'a', triggers: ['y'] },
    ]
    expect(matchCapabilities(['x y'], dup, opts)).toHaveLength(1)
  })

  it('ignores a rule with an empty trigger list', () => {
    expect(matchCapabilities(['anything'], [{ skill: 'a', triggers: [] }], opts)).toEqual([])
  })

  describe('non-finite max', () => {
    const many: Rule[] = [
      { skill: 'a', triggers: ['x'] },
      { skill: 'b', triggers: ['x'] },
      { skill: 'c', triggers: ['x'] },
    ]

    // 归一化选择的是"夹到关闭"：非有限 max 不可能是调用方有意配置的边界，
    // 因此按 0 处理（不出提示），而不是回退到一个猜出来的默认上限。
    it.each([NaN, Infinity, -Infinity])('treats %s as no matches at all', (max) => {
      expect(matchCapabilities(['x'], many, { max, exclude: new Set() })).toEqual([])
    })

    it('still truncates normally for a finite fractional max', () => {
      expect(matchCapabilities(['x'], many, { max: 1.9, exclude: new Set() })).toHaveLength(1)
    })
  })
})
