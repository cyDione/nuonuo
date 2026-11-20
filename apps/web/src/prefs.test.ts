import { describe, expect, it } from 'vitest'
import { comboOf, DEFAULT_KEYS, keyLabel, matchesKey, MOD } from './prefs'

const isMac = MOD === '⌘'

function fakeKeyEvent(init: { key: string; code?: string; mod?: boolean; shift?: boolean; alt?: boolean; ctrl?: boolean }): KeyboardEvent {
  return {
    key: init.key,
    code: init.code ?? '',
    metaKey: isMac ? Boolean(init.mod) : false,
    ctrlKey: isMac ? Boolean(init.ctrl) : Boolean(init.mod || init.ctrl),
    shiftKey: Boolean(init.shift),
    altKey: Boolean(init.alt),
  } as KeyboardEvent
}

describe('web shortcut helpers (prefs)', () => {
  it('matches Mod+key shortcuts case-insensitively and via physical Key/Digit codes', () => {
    expect(matchesKey(fakeKeyEvent({ key: 'k', mod: true }), DEFAULT_KEYS.search)).toBe(true)
    expect(matchesKey(fakeKeyEvent({ key: 'K', mod: true }), DEFAULT_KEYS.search)).toBe(true)
    expect(matchesKey(fakeKeyEvent({ key: '˚', code: 'KeyK', mod: true }), DEFAULT_KEYS.search)).toBe(true)
    expect(matchesKey(fakeKeyEvent({ key: 'k', mod: false }), DEFAULT_KEYS.search)).toBe(false)
    expect(matchesKey(fakeKeyEvent({ key: 'k', mod: true, shift: true }), DEFAULT_KEYS.search)).toBe(false)
    expect(matchesKey(fakeKeyEvent({ key: '1', code: 'Digit1', mod: true }), DEFAULT_KEYS.mainChat)).toBe(true)
    expect(matchesKey(fakeKeyEvent({ key: 'k', mod: true }), '')).toBe(false)
  })

  it('formats shortcut labels for the active platform', () => {
    expect(keyLabel('')).toEqual([])
    expect(keyLabel('Mod+k')).toEqual([MOD, 'K'])
    expect(keyLabel('Mod+Shift+Space')).toEqual([MOD, isMac ? '⇧' : 'Shift', 'Space'])
    expect(keyLabel('CommandOrControl+Alt+1')).toEqual([MOD, isMac ? '⌥' : 'Alt', '1'])
  })

  it('captures shortcut strings only when a modifier plus a non-modifier key are pressed', () => {
    expect(comboOf(fakeKeyEvent({ key: 'Meta', mod: true }))).toBeNull()
    expect(comboOf(fakeKeyEvent({ key: 'Shift', shift: true }))).toBeNull()
    expect(comboOf(fakeKeyEvent({ key: 'k' }))).toBeNull()
    expect(comboOf(fakeKeyEvent({ key: 'k', code: 'KeyK', mod: true }))).toBe('Mod+K')
    expect(comboOf(fakeKeyEvent({ key: ' ', code: 'Space', mod: true, shift: true }))).toBe('Mod+Shift+Space')
    expect(comboOf(fakeKeyEvent({ key: '1', code: 'Digit1', mod: true }))).toBe('Mod+1')
  })
})
