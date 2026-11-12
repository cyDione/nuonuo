import { describe, expect, it } from 'vitest'
import { npmRegistry } from './plugin-install'

describe('npmRegistry', () => {
  it('prefers NUONUO_NPM_REGISTRY, then npm config, then the public registry', () => {
    expect(npmRegistry({ NUONUO_NPM_REGISTRY: 'https://mirror.example/', npm_config_registry: 'https://other.example' })).toBe('https://mirror.example')
    expect(npmRegistry({ npm_config_registry: 'https://registry.npmmirror.com/' })).toBe('https://registry.npmmirror.com')
    expect(npmRegistry({})).toBe('https://registry.npmjs.org')
  })
})
