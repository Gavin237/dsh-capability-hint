import { describe, it, expect } from 'vitest'
import { renderHint, HINT_MAX_CHARS } from '../src/hint'

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

  // -------------------------------------------------------------------------
  // M1：先前的预算用例**根本没触发截断**（3 个 `skill-N` 加前缀约 30 字符），
  // 因此一个完全忽略 `HINT_MAX_CHARS` 的实现在它下面照样通过。下面三条把
  // 真正的截断路径与精确边界都钉住。
  // -------------------------------------------------------------------------

  it('actually truncates: long skill names produce exactly HINT_MAX_CHARS chars', () => {
    // 真技能名可以很长（`subagent-driven-development`、`competition-bundle-sourcemap-recovery`
    // 这类），三个 50 字符的名字足以越过 120 的上限。
    const matches = [
      { skill: 'c'.repeat(50), hit: 'x' },
      { skill: 'd'.repeat(50), hit: 'y' },
      { skill: 'e'.repeat(50), hit: 'z' },
    ]
    const line = renderHint(matches, '[能力提示]')

    // 未截断时长这样：
    const untruncated = `[能力提示] 本轮可能适用：${matches.map((m) => m.skill).join(', ')}`
    expect(untruncated.length).toBeGreaterThan(HINT_MAX_CHARS)

    // 截断后：长度**恰好**等于上限，且以省略号结尾（不是把名字砍到一半还假装完整）。
    expect(line.length).toBe(HINT_MAX_CHARS)
    expect(line.endsWith('…')).toBe(true)
    expect(line.startsWith('[能力提示] 本轮可能适用：')).toBe(true)
  })

  it('keeps a line of exactly HINT_MAX_CHARS untruncated (boundary, inclusive)', () => {
    // 构造：前缀 + 分隔 + 名字 = 恰好 HINT_MAX_CHARS。
    const prefix = '[能力提示]'
    const head = `${prefix} 本轮可能适用：`
    const skill = 'a'.repeat(HINT_MAX_CHARS - head.length)
    const line = renderHint([{ skill, hit: 'x' }], prefix)

    expect(line.length).toBe(HINT_MAX_CHARS)
    // `<=` 边界：恰好到达上限时**不得**被截断（不许多出省略号）。
    expect(line.endsWith('…')).toBe(false)
    expect(line).toBe(`${head}${skill}`)
  })

  it('truncates by exactly one char once HINT_MAX_CHARS is exceeded (boundary, exclusive)', () => {
    // 同一构造，名字多一个字符 → 必须落入截断分支。
    const prefix = '[能力提示]'
    const head = `${prefix} 本轮可能适用：`
    const skill = 'a'.repeat(HINT_MAX_CHARS - head.length + 1)
    const line = renderHint([{ skill, hit: 'x' }], prefix)

    expect(line.length).toBe(HINT_MAX_CHARS)
    expect(line.endsWith('…')).toBe(true)
    // 截掉的是最后一个字符，换成省略号；其余逐字一致。
    expect(line).toBe(`${head}${skill}`.slice(0, HINT_MAX_CHARS - 1) + '…')
  })
})
