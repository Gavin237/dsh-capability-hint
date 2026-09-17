import { describe, it, expect } from 'vitest'
import type Schema from '@deepseek-ai/schemastery'
import { Config } from '../src/config'
import type { Config as ConfigShape } from '../src/config'

// `src/config.ts` declares the schema as `Schema<Config>` per the DSH plugin
// convention: the loader validates a fully-normalized config, so the schema's
// input type is the resolved shape. Every key in this schema has a default,
// which means callers legitimately pass a partial (or empty) object and get the
// defaults filled in. Widen only the *input* type here, in the test, so the
// defaults are exercised the way a real caller uses them. The implementation
// and its declared export stay exactly as specified.
const ConfigInput = Config as unknown as Schema<Partial<ConfigShape>, ConfigShape>

describe('Config schema', () => {
  it('fills every default so no key is required', () => {
    const v = ConfigInput({})
    expect(v.enabled).toBe(true)
    expect(v.maxHintsPerTurn).toBe(3)
    expect(v.hintPrefix).toBe('[能力提示]')
    expect(v.rulesPath).toBe('hermes-intake-rules.json')
    expect(v.excludeSkills).toEqual([])
  })

  it('accepts explicit values', () => {
    const v = ConfigInput({ enabled: false, maxHintsPerTurn: 5, excludeSkills: ['a'] })
    expect(v.enabled).toBe(false)
    expect(v.maxHintsPerTurn).toBe(5)
    expect(v.excludeSkills).toEqual(['a'])
  })

  it('leaves untouched keys at their defaults', () => {
    const v = ConfigInput({ enabled: false })
    expect(v.hintPrefix).toBe('[能力提示]')
    expect(v.rulesPath).toBe('hermes-intake-rules.json')
  })

  it('rejects a wrong type loudly', () => {
    expect(() => ConfigInput({ enabled: 'yes' } as never)).toThrow()
  })

  it('returns a fresh array default per call so callers cannot share state', () => {
    const a = ConfigInput({})
    const b = ConfigInput({})
    expect(a.excludeSkills).not.toBe(b.excludeSkills)
  })
})
