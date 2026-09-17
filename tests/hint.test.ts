import { describe, it, expect } from 'vitest'
import { renderHint } from '../src/hint'

describe('renderHint', () => {
  it('renders one short line with the skill names', () => {
    const line = renderHint([{ skill: 'brainstorming', hit: '设计' }], '[能力提示]')
    expect(line).toBe('[能力提示] 本轮可能适用：brainstorming')
  })

  it('joins multiple skills with a comma', () => {
    const line = renderHint(
      [
        { skill: 'a', hit: 'x' },
        { skill: 'b', hit: 'y' },
      ],
      '[H]',
    )
    expect(line).toBe('[H] 本轮可能适用：a, b')
  })

  it('returns an empty string for no matches (caller must skip injection)', () => {
    expect(renderHint([], '[能力提示]')).toBe('')
  })

  it('stays within a small character budget', () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ skill: `skill-${i}`, hit: 'x' }))
    expect(renderHint(many, '[能力提示]').length).toBeLessThanOrEqual(120)
  })
})
