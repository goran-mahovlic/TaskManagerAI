/**
 * TASK-5668 (plan Mac v3 P10 #7): sakupljač stanja čvora ne smije uvoziti paket (izvodi se
 * preko SSH-a sa standardnog ulaza), pa ima ZRCALO `platforma.usluga`/`launchdOznaka`.
 * Ovaj test drži zrcalo i platformu na istom ishodu za Linux i lažni darwin.
 */
import { describe, test, expect } from 'bun:test'
import * as P from '../src/core/platforma'
import { stanjeUsluge, launchdOznakaZrcalo, datotekaTimera } from '../scripts/profil-cvora-stanje'

const MAC: Record<string, string> = {
  'launchctl print system/hr.regoc.voice': 'hr.regoc.voice = {\n\tstate = running\n}',
  'launchctl print system/hr.regoc.taskmanager': 'hr.regoc.taskmanager = {\n\tstate = not running\n}',
  'launchctl print system/hr.regoc.znanje': 'hr.regoc.znanje = {\n\tstate = not running\n\trun interval = 1800 seconds\n}',
}
const IMENA = ['regoc-voice', 'regoc-taskmanager.service', 'regoc-znanje.timer', 'regoc-nema', 'regoc-nema.timer']

describe('zrcalo platforma.usluga u profil-cvora-stanje.ts', () => {
  test('darwin: isti ishod kao platforma.usluga, bez systemctl', () => {
    const pozivi: string[][] = []
    const nar = (a: string[]) => { pozivi.push(a); return MAC[a.join(' ')] ?? null }
    for (const ime of IMENA)
      expect(stanjeUsluge(ime, 'darwin', nar)).toBe(P.usluga(ime, { os: 'darwin', izvrsi: (a) => MAC[a.join(' ')] ?? null }))
    expect(pozivi.every(a => a[0] === 'launchctl')).toBe(true)
  })
  test('Linux: sirovi izlaz is-active (failed ostaje failed), bez systemctl → nepoznato', () => {
    const odg: Record<string, string> = { 'systemctl --user is-active a': 'active', 'systemctl --user is-active b': 'failed' }
    const nar = (a: string[]) => odg[a.join(' ')] ?? null
    expect(stanjeUsluge('a', 'linux', nar)).toBe('active')
    expect(stanjeUsluge('b', 'linux', nar)).toBe('failed')
    expect(stanjeUsluge('c', 'linux', nar)).toBe('nepoznato')
  })
  test('oznaka i datoteka timera = platforma', () => {
    for (const ime of IMENA) expect(launchdOznakaZrcalo(ime)).toBe(P.launchdOznaka(ime))
    expect(datotekaTimera('regoc-znanje', '/Users/r', 'darwin')).toBe(P.launchdPlistPut('regoc-znanje'))
    expect(datotekaTimera('regoc-znanje', '/home/r', 'linux')).toBe('/home/r/.config/systemd/user/regoc-znanje.timer')
  })
  test('sakupljač i dalje nema uvoza iz paketa (SSH stdin)', async () => {
    const kod = await Bun.file(new URL('../scripts/profil-cvora-stanje.ts', import.meta.url)).text()
    expect(kod.match(/^import .* from '(\.\.?\/[^']+)'/gm) ?? []).toEqual([])
  })
})
