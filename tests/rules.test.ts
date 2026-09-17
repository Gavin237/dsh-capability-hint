import { describe, it, expect } from 'vitest'
import { validateRules, BUILTIN_RULES } from '../src/rules'

const known = new Set(['brainstorming', 'systematic-debugging', 'writing-plans'])

describe('validateRules', () => {
  it('accepts a rule whose skill exists in the catalog', () => {
    expect(validateRules([{ skill: 'brainstorming', triggers: ['设计'] }], known, new Set())).toEqual([])
  })

  it('rejects a rule whose skill is absent from the catalog', () => {
    const errs = validateRules([{ skill: 'no-such-skill', triggers: ['x'] }], known, new Set())
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('no-such-skill')
  })

  it('rejects a rule with no triggers', () => {
    const errs = validateRules([{ skill: 'brainstorming', triggers: [] }], known, new Set())
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('triggers')
  })

  it('rejects duplicate skill entries', () => {
    const errs = validateRules(
      [
        { skill: 'brainstorming', triggers: ['a'] },
        { skill: 'brainstorming', triggers: ['b'] },
      ],
      known,
      new Set(),
    )
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('duplicate')
  })

  it('rejects lint when skill is excluded', () => {
    const errs = validateRules([{ skill: 'brainstorming', triggers: ['a'] }], known, new Set(['brainstorming']))
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('excluded')
  })

  it('rejects an empty-string trigger', () => {
    const errs = validateRules([{ skill: 'brainstorming', triggers: [''] }], known, new Set())
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('empty trigger')
  })

  it('rejects a trigger that is not lowercase', () => {
    const errs = validateRules([{ skill: 'brainstorming', triggers: ['Design'] }], known, new Set())
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('not lowercase')
  })
})

describe('BUILTIN_RULES', () => {
  it('ships non-empty and every trigger is lowercase', () => {
    expect(BUILTIN_RULES.length).toBeGreaterThan(0)
    for (const r of BUILTIN_RULES) {
      for (const t of r.triggers) expect(t).toBe(t.toLowerCase())
    }
  })

  it('has no duplicate skills', () => {
    const seen = new Set<string>()
    for (const r of BUILTIN_RULES) {
      expect(seen.has(r.skill)).toBe(false)
      seen.add(r.skill)
    }
  })
})
