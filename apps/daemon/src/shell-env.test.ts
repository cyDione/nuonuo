import { describe, expect, it } from 'vitest'
import { dockerSockets, extraPathDirs, mergePath } from './shell-env'

describe('shell env', () => {
  it('appends new PATH entries once, keeping the current order first', () => {
    expect(mergePath('/usr/bin:/bin', ['/opt/homebrew/bin', '/usr/bin', ''], ['/usr/local/bin', '/opt/homebrew/bin'])).toBe('/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin')
    expect(mergePath(undefined, ['/a'])).toBe('/a')
  })
  it('knows where Docker Desktop and OrbStack put their CLI and socket', () => {
    expect(extraPathDirs('/Users/me')).toContain('/Users/me/.docker/bin')
    expect(extraPathDirs('/Users/me')).toContain('/usr/local/bin')
    expect(dockerSockets('/Users/me').slice(0, 2)).toEqual(['/Users/me/.docker/run/docker.sock', '/Users/me/.orbstack/run/docker.sock'])
  })
})
