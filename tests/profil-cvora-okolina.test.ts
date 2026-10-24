/**
 * TASK-5663 (Mac K9): sakupljač stanja čvora čita okolinu ISTIM redom kao usluga
 * (scripts/s-okolinom.sh): $TM_HOME/config/instalacija.env, pa $TM_HOME/config/postavke.env
 * (prednost). Prije je čitao samo <paket>/config/postavke.env — na čvoru instaliranom po
 * README-u (Mac) te datoteke nema, pa je profil-cvora vidio TM_PORT… kao null.
 * Stari raspored (node-A: postavke uz paket, bez instalacija.env) ostaje kako je bio.
 *
 * Isto: Claude prijava na macOS-u je token u spremištu (TASK-5754), ne ~/.claude/.credentials.json.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { okolinaCvora, claudePrijavljen } from '../scripts/profil-cvora-stanje'

let d: string, home: string, paket: string, tm: string
beforeEach(() => {
  d = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pc-okolina-'))
  home = join(d, 'home'); paket = join(home, 'TaskManagerAI'); tm = join(home, '.taskmanager')
  mkdirSync(join(paket, 'config'), { recursive: true }); mkdirSync(join(tm, 'config'), { recursive: true })
  mkdirSync(join(home, '.claude'), { recursive: true })
})
afterEach(() => rmSync(d, { recursive: true, force: true }))

describe('okolinaCvora — red kao s-okolinom.sh', () => {
  test('instalacija po README-u: instalacija.env pa postavke.env iz $TM_HOME (postavke imaju prednost)', () => {
    writeFileSync(join(tm, 'config', 'instalacija.env'), `TM_HOME=${tm}\nTM_PORT=17781\nTM_BIND=127.0.0.1\n`)
    writeFileSync(join(tm, 'config', 'postavke.env'), 'TM_BIND=127.0.0.1,100.1.2.3\nTM_ALLOWED_HOSTS=localhost,mac\n')
    const o = okolinaCvora(paket, home)
    expect(o.env).toEqual({ TM_HOME: tm, TM_PORT: '17781', TM_BIND: '127.0.0.1,100.1.2.3', TM_ALLOWED_HOSTS: 'localhost,mac' })
    expect(o.datoteka).toBe(join(tm, 'config', 'postavke.env'))
  })

  test('postavke.env u $TM_HOME bez instalacija.env se i dalje čita i u nju se piše', () => {
    writeFileSync(join(tm, 'config', 'postavke.env'), 'TM_PORT=17790\n')
    const o = okolinaCvora(paket, home)
    expect(o.env.TM_PORT).toBe('17790')
    expect(o.datoteka).toBe(join(tm, 'config', 'postavke.env'))
  })

  test('stari raspored (node-A): postavke uz paket, TM_HOME iz njih', () => {
    const drugi = join(d, 'drugi-tm'); mkdirSync(join(drugi, 'config'), { recursive: true })
    writeFileSync(join(paket, 'config', 'postavke.env'), `TM_HOME=${drugi}\nTM_PORT=17781\n`)
    const o = okolinaCvora(paket, home)
    expect(o.env).toEqual({ TM_HOME: drugi, TM_PORT: '17781' })
    expect(o.datoteka).toBe(join(paket, 'config', 'postavke.env'))
  })

  test('ništa nije instalirano: prazna okolina, piše se uz paket (kao prije)', () => {
    const o = okolinaCvora(paket, home)
    expect(o.env).toEqual({})
    expect(o.datoteka).toBe(join(paket, 'config', 'postavke.env'))
  })
})

describe('claudePrijavljen', () => {
  test('datoteka prijave CLI-ja (Linux)', () => {
    writeFileSync(join(home, '.claude', '.credentials.json'), '{"x":1}')
    expect(claudePrijavljen(home, {})).toBe(true)
  })
  test('token pretplate u spremištu (macOS, Config → Prijava → Claude)', () => {
    expect(claudePrijavljen(home, { CLAUDE_CODE_OAUTH_TOKEN: 'lazni-token' })).toBe(true)
  })
  test('ni jedno ni drugo → nije prijavljen (prazna vrijednost se ne broji)', () => {
    expect(claudePrijavljen(home, { CLAUDE_CODE_OAUTH_TOKEN: '' })).toBe(false)
  })
})
