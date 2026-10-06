/**
 * TASK-5274 — uključivanje ulaza s ploče mora ODMAH pokrenuti poller (prije tek nakon
 * restarta ploče), uz jedan poller po procesu i zamjenu petlje kad se promijeni bot token.
 *
 * Bez mreže: `api` je ubrizgan, konfiguracija/stanje/brava žive u privremenoj mapi.
 *
 * Autorica: Jelena (Engineer), TASK-5274.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  ZADANO_STANJE, pokreniTelegramPoller, stanjeUlaza, ucitajStanje, uskladiTelegramPoller,
  zapisiStanje, zaustaviTelegramPoller, type Api,
} from '../src/TelegramPoller'
import { ZADANE_POSTAVKE, ZADANI_ULAZ } from '../src/TelegramConfig'

let mapa: string
let api: BrojacApi
const put = (i: string) => join(mapa, i)

class BrojacApi implements Api {
  pozivi = 0
  async getUpdates() { this.pozivi++; return { ok: true, result: [] } }
  async ingest() { return { status: 201, tijelo: { ok: true } } }
  async odgovori() { return true }
}

// `botTokenEnv` pokazuje na tajnu koja ne postoji — test ne smije pročitati pravi token stroja.
function zapisiCfg(ulazUkljucen: boolean, botToken = '123:ABC') {
  writeFileSync(put('telegram.json'), JSON.stringify({
    ...ZADANE_POSTAVKE, ukljucen: true, botToken, botTokenEnv: 'TM_TEST_5274_NEMA_TAJNE',
    ulaz: { ...ZADANI_ULAZ, ukljucen: ulazUkljucen, intervalSek: 3600 },
  }))
}

function opcije(prijasnjiToken?: string) {
  return {
    configPath: put('telegram.json'), stanjePath: put('stanje.json'), bravaPath: put('poller.lock'),
    api, log: () => {},
    ...(prijasnjiToken !== undefined ? { prijasnjiToken } : {}),
  }
}

const radi = () => stanjeUlaza(put('stanje.json'), put('poller.lock')).radi

beforeEach(() => {
  mapa = mkdtempSync(join(tmpdir(), 'tm-tgu-'))
  api = new BrojacApi()
})
afterEach(() => {
  zaustaviTelegramPoller()
  rmSync(mapa, { recursive: true, force: true })
})

describe('uključivanje s ploče bez restarta', () => {
  test('ulaz isključen pri startu → uključi → radi:true bez restarta', async () => {
    zapisiCfg(false)
    expect(pokreniTelegramPoller(opcije()).pokrenut).toBe(false)
    expect(radi()).toBe(false)

    zapisiCfg(true) // korisnik je na ploči uključio Ulaz
    const r = uskladiTelegramPoller(opcije())
    expect(r.radnja).toBe('pokrenut')
    expect(radi()).toBe(true)
    await Bun.sleep(5)
    expect(api.pozivi).toBe(1)
  })

  test('dvostruko uključivanje → JEDAN poller', async () => {
    zapisiCfg(true)
    expect(uskladiTelegramPoller(opcije()).radnja).toBe('pokrenut')
    expect(uskladiTelegramPoller(opcije()).radnja).toBe('vec_radi')
    await Bun.sleep(5)
    expect(api.pozivi).toBe(1) // druga petlja bila bi drugi getUpdates
  })

  test('start ploče + kasnije spremanje postavki → i dalje jedan poller', async () => {
    zapisiCfg(true)
    expect(pokreniTelegramPoller(opcije()).pokrenut).toBe(true)
    // Brava prima vlastiti PID, pa bez zaštite u procesu ovo bi bila druga petlja.
    const drugi = pokreniTelegramPoller(opcije())
    expect(drugi.pokrenut).toBe(false)
    expect(drugi.razlog).toContain('već radi')
    expect(uskladiTelegramPoller(opcije()).radnja).toBe('vec_radi')
    await Bun.sleep(5)
    expect(api.pozivi).toBe(1)
  })

  test('isključivanje ne pokreće ništa (petlja se sama zaustavlja)', () => {
    zapisiCfg(false)
    expect(uskladiTelegramPoller(opcije()).radnja).toBe('nista')
    expect(radi()).toBe(false)
  })

  test('nakon zaustavljanja petlje ponovno uključivanje je opet pokreće', () => {
    zapisiCfg(true)
    const p = pokreniTelegramPoller(opcije())
    p.stop?.()
    expect(radi()).toBe(false)
    expect(uskladiTelegramPoller(opcije()).radnja).toBe('pokrenut')
    expect(radi()).toBe(true)
  })
})

describe('promjena bot tokena', () => {
  test('novi token → stara petlja stane, nova krene (i dalje jedna)', () => {
    zapisiCfg(true, '111:STARI')
    const stari = pokreniTelegramPoller(opcije())
    expect(stari.ziv?.()).toBe(true)

    zapisiCfg(true, '222:NOVI')
    const r = uskladiTelegramPoller(opcije('111:STARI'))
    expect(r.radnja).toBe('ponovno')
    expect(stari.ziv?.()).toBe(false)
    expect(radi()).toBe(true)
  })

  test('novi token briše „zaustavljen" i offset staroga bota', () => {
    zapisiStanje({
      ...ZADANO_STANJE, offset: 9000, zaustavljen: true, zaustavljenRazlog: 'bot token nije valjan',
    }, put('stanje.json'))
    zapisiCfg(true, '222:NOVI')
    const r = uskladiTelegramPoller(opcije('111:STARI'))
    expect(r.radnja).toBe('pokrenut')
    const s = ucitajStanje(put('stanje.json'))
    expect(s.zaustavljen).toBe(false)
    expect(s.zaustavljenRazlog).toBeNull()
    expect(s.offset).toBe(0)
    expect(radi()).toBe(true)
  })

  test('isti token ponovno spremljen → petlja se NE dira, offset ostaje', () => {
    zapisiStanje({ ...ZADANO_STANJE, offset: 77 }, put('stanje.json'))
    zapisiCfg(true, '111:ISTI')
    const p = pokreniTelegramPoller(opcije())
    expect(uskladiTelegramPoller(opcije('111:ISTI')).radnja).toBe('vec_radi')
    expect(p.ziv?.()).toBe(true)
    expect(ucitajStanje(put('stanje.json')).offset).toBe(77)
  })

  test('token promijenjen dok je ulaz isključen → stara petlja stane, nova ne krene', () => {
    zapisiCfg(true, '111:STARI')
    const stari = pokreniTelegramPoller(opcije())
    zapisiCfg(false, '222:NOVI')
    expect(uskladiTelegramPoller(opcije('111:STARI')).radnja).toBe('zaustavljen')
    expect(stari.ziv?.()).toBe(false)
    expect(radi()).toBe(false)
  })
})
