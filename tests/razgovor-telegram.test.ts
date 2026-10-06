/**
 * ADR-0002 R6 — spajanje razgovora u Telegram ulaz (J1, J5) i adapter kanala:
 *  - bez razgovora ponašanje je IDENTIČNO današnjem (J1);
 *  - nalog iznad praga → zadatak + potvrda, razgovor se NE zove (J5);
 *  - ulaz off + razgovor on → ingest se ne zove, poruka ide u razgovor;
 *  - obraćanje računa adapter: vlastiti @spomen, ime, reply na bota — tuđi @spomen ne (§5).
 *
 * Bez mreže: `api` je ubrizgan.
 *
 * Autorica: Jelena (Engineer), TASK-5277.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  ZADANO_STANJE, jedanProlaz, propusti, stanjeUlaza, ulaznaPorukaIzTelegrama, uskladiTelegramPoller,
  zaustaviTelegramPoller, type Api, type RazgovorUlaza, type Update,
} from '../src/TelegramPoller'
import { ZADANE_POSTAVKE, ZADANI_ULAZ, type TelegramPostavke } from '../src/TelegramConfig'
import { RAZGOVOR_ZADANO, type RazgovorPostavke } from '../src/razgovor/RazgovorPostavke'
import type { Kanal, UlaznaPoruka } from '../src/razgovor/Kanal'

let mapa: string
beforeEach(() => { mapa = mkdtempSync(join(tmpdir(), 'tm-rtg-')) })
afterEach(() => { zaustaviTelegramPoller(); rmSync(mapa, { recursive: true, force: true }) })
const put = (i: string) => join(mapa, i)

const JA = { id: 900, username: 'cvor_bot' }

function cfg(ulaz: Partial<TelegramPostavke['ulaz']> = {}): TelegramPostavke {
  return { ...ZADANE_POSTAVKE, ukljucen: true, botToken: '123:ABC', ulaz: { ...ZADANI_ULAZ, ukljucen: true, ...ulaz } }
}

function poruka(over: Partial<NonNullable<Update['message']>> = {}, id = 1): Update {
  return {
    update_id: id,
    message: {
      message_id: 100 + id, date: 1_700_000_000, text: 'koliko je zadataka?',
      chat: { id: -100555, title: 'Grupa', type: 'supergroup' },
      from: { id: 42, first_name: 'Ivan', username: 'ivan' },
      ...over,
    },
  }
}

class LazniApi implements Api {
  updates: Update[] = []
  ingesti: Record<string, unknown>[] = []
  odgovorIngest = { status: 200, tijelo: { ok: true, created: false, action: 'odgovor' } as any }
  poslane: string[] = []
  async getUpdates() { return { ok: true, result: this.updates } }
  async ingest(t: Record<string, unknown>) { this.ingesti.push(t); return this.odgovorIngest }
  async odgovori(_c: string | number, tekst: string) { this.poslane.push(tekst); return true }
}

function razgovor(p: Partial<RazgovorPostavke> = {}) {
  const primljeno: UlaznaPoruka[] = []
  const r: RazgovorUlaza = {
    razgovor: { primi: (u: UlaznaPoruka) => { primljeno.push(u) } },
    postavke: () => ({ ...RAZGOVOR_ZADANO, dopusteniKorisnici: [], ukljucen: true, ime: 'Šaban', ...p }),
    ja: JA,
    kanal: { ime: 'telegram' } as Kanal,
  }
  return { r, primljeno }
}

describe('J1 — bez razgovora sve kao danas', () => {
  test('poruka ispod praga bez razgovornog sloja → tišina, ingest jednom', async () => {
    const api = new LazniApi()
    api.updates = [poruka()]
    const i = await jedanProlaz(cfg(), { ...ZADANO_STANJE }, api)
    expect(api.ingesti.length).toBe(1)
    expect(api.poslane.length).toBe(0)
    expect(i.preskoceno).toBe(1)
  })

  test('razgovor isključen u postavkama → razgovor.primi se ne zove', async () => {
    const api = new LazniApi()
    api.updates = [poruka({ text: '@cvor_bot bok', entities: [{ type: 'mention', offset: 0, length: 9 }] })]
    const { r, primljeno } = razgovor({ ukljucen: false })
    await jedanProlaz(cfg(), { ...ZADANO_STANJE }, api, r)
    expect(primljeno.length).toBe(0)
  })
})

describe('J5 — nalog iznad praga', () => {
  test('zadatak + kratka potvrda, razgovor 0 puta', async () => {
    const api = new LazniApi()
    api.odgovorIngest = { status: 201, tijelo: { ok: true, created: true, taskId: 'TASK-7' } }
    api.updates = [poruka({ text: '@cvor_bot napravi zadatak: sredi backup', entities: [{ type: 'mention', offset: 0, length: 9 }] })]
    const { r, primljeno } = razgovor()
    await jedanProlaz(cfg(), { ...ZADANO_STANJE }, api, r)
    expect(api.poslane).toEqual(['📋 Otvoren zadatak TASK-7'])
    expect(primljeno.length).toBe(0)
  })

  test('TASK-5293: potvrda nosi nositelja kad ga je nalog imenovao', async () => {
    const api = new LazniApi()
    api.odgovorIngest = { status: 201, tijelo: { ok: true, created: true, taskId: 'TASK-8', assignee: 'ana' } }
    api.updates = [poruka({ text: '@cvor_bot neka Ana sredi backup', entities: [{ type: 'mention', offset: 0, length: 9 }] })]
    const { r } = razgovor()
    await jedanProlaz(cfg(), { ...ZADANO_STANJE }, api, r)
    expect(api.poslane).toEqual(['📋 Otvoren zadatak TASK-8 → ana'])
  })

  test('ispod praga uz razgovor → ingest pa razgovor', async () => {
    const api = new LazniApi()
    api.updates = [poruka({ text: '@cvor_bot koliko?', entities: [{ type: 'mention', offset: 0, length: 9 }] })]
    const { r, primljeno } = razgovor()
    await jedanProlaz(cfg({ dopusteniChatovi: ['-100555'] }), { ...ZADANO_STANJE }, api, r)
    expect(api.ingesti.length).toBe(1)
    expect(primljeno.length).toBe(1)
    expect(primljeno[0]!.obracanjeBotu).toBe(true)
    expect(primljeno[0]!.kanal).toBe('telegram')
    expect(primljeno[0]!.chatId).toBe('-100555')
  })

  test('odbijenica vratara (429) ostaje kako jest — razgovor se ne zove', async () => {
    const api = new LazniApi()
    api.odgovorIngest = { status: 429, tijelo: { error: 'previše' } }
    api.updates = [poruka()]
    const { r, primljeno } = razgovor()
    await jedanProlaz(cfg(), { ...ZADANO_STANJE }, api, r)
    expect(primljeno.length).toBe(0)
  })
})

describe('ulaz off + razgovor on', () => {
  test('ingest se NE zove; poruka ide u razgovor', async () => {
    const api = new LazniApi()
    api.updates = [poruka()]
    const { r, primljeno } = razgovor()
    await jedanProlaz(cfg({ ukljucen: false, dopusteniChatovi: ['-100555'] }), { ...ZADANO_STANJE }, api, r)
    expect(api.ingesti.length).toBe(0)
    expect(primljeno.length).toBe(1)
  })

  // TASK-5279: korisničko ime bota je javno, privatni chat je uvijek „obraćanje" — bez popisa
  // dopuštenih chatova razgovor sluša samo dopuštene korisnike.
  test('bez popisa dopuštenih chatova: stranac u privatnom chatu → razgovor se ne zove', async () => {
    const api = new LazniApi()
    api.updates = [poruka({ chat: { id: 7, type: 'private' }, from: { id: 7, first_name: 'Stranac' } })]
    const { r, primljeno } = razgovor({ dopusteniKorisnici: ['42'] })
    await jedanProlaz(cfg({ ukljucen: false }), { ...ZADANO_STANJE }, api, r)
    expect(primljeno.length).toBe(0)
  })

  test('bez popisa dopuštenih chatova: dopušteni korisnik → razgovor se zove', async () => {
    const api = new LazniApi()
    api.updates = [poruka({ chat: { id: 42, type: 'private' } })]
    const { r, primljeno } = razgovor({ dopusteniKorisnici: ['42'] })
    await jedanProlaz(cfg({ ukljucen: false }), { ...ZADANO_STANJE }, api, r)
    expect(primljeno.length).toBe(1)
  })

  test('dopušteni chatovi vrijede i za razgovor', async () => {
    const api = new LazniApi()
    api.updates = [poruka()]
    const { r, primljeno } = razgovor()
    await jedanProlaz(cfg({ ukljucen: false, dopusteniChatovi: ['-1'] }), { ...ZADANO_STANJE }, api, r)
    expect(primljeno.length).toBe(0)
  })
})

describe('adapter: obraćanje botu (ADR §5)', () => {
  const m = (o: Partial<NonNullable<Update['message']>>) => poruka(o).message!

  test('tuđi @spomen (drugi bot u grupi) NE budi ovog bota', () => {
    const u = ulaznaPorukaIzTelegrama(m({ text: '@drugi_bot što ima?', entities: [{ type: 'mention', offset: 0, length: 10 }] }), m({}).text!, JA, 'Šaban')
    expect(u.obracanjeBotu).toBe(false)
  })

  test('vlastiti @spomen (bez obzira na velika slova) budi', () => {
    const u = ulaznaPorukaIzTelegrama(m({ text: 'hej @Cvor_Bot što ima?', entities: [{ type: 'mention', offset: 4, length: 9 }] }), 'hej @Cvor_Bot što ima?', JA, '')
    expect(u.obracanjeBotu).toBe(true)
  })

  test('ime na početku budi', () => {
    expect(ulaznaPorukaIzTelegrama(m({ text: 'šaban, bok' }), 'šaban, bok', JA, 'Šaban').obracanjeBotu).toBe(true)
  })

  test('reply na poruku ovog bota budi; reply na tuđu ne', () => {
    expect(ulaznaPorukaIzTelegrama(m({ reply_to_message: { from: { id: 900, is_bot: true } } }), 'a?', JA, '').obracanjeBotu).toBe(true)
    expect(ulaznaPorukaIzTelegrama(m({ reply_to_message: { from: { id: 901, is_bot: true } } }), 'a?', JA, '').obracanjeBotu).toBe(false)
  })

  test('korisničko ime pošiljatelja se prenosi (za dopuštene korisnike po imenu)', () => {
    expect(ulaznaPorukaIzTelegrama(m({}), 'x', JA, '').posiljateljKorisnickoIme).toBe('ivan')
  })

  test('privatni chat i bot-pošiljatelj se prenose', () => {
    const u = ulaznaPorukaIzTelegrama(m({ chat: { id: 42, type: 'private' }, from: { id: 5, is_bot: true, first_name: 'B' } }), 'x', JA, '')
    expect(u.privatno).toBe(true)
    expect(u.posiljateljJeBot).toBe(true)
  })

  test('propusti(sameSpomeni) uz poznato korisničko ime prihvaća SAMO vlastiti spomen', () => {
    const u = { ...ZADANI_ULAZ, sameSpomeni: true }
    const tudji = m({ text: '@drugi_bot x', entities: [{ type: 'mention', offset: 0, length: 10 }] })
    const vlastiti = m({ text: '@cvor_bot x', entities: [{ type: 'mention', offset: 0, length: 9 }] })
    expect(propusti(u, tudji, tudji.text!, JA.username)).toBe(false)
    expect(propusti(u, vlastiti, vlastiti.text!, JA.username)).toBe(true)
    // bez poznatog imena — staro ponašanje (bilo koji spomen)
    expect(propusti(u, tudji, tudji.text!)).toBe(true)
  })
})

describe('petlja: pali se i kad je uključen SAMO razgovor', () => {
  test('ulaz off, razgovor on → uskladi pokreće petlju', async () => {
    writeFileSync(put('telegram.json'), JSON.stringify({
      ...ZADANE_POSTAVKE, ukljucen: true, botToken: '123:ABC', botTokenEnv: 'TM_TEST_5277_NEMA',
      ulaz: { ...ZADANI_ULAZ, ukljucen: false, intervalSek: 3600 },
    }))
    let pozivi = 0
    const api: Api = {
      async getUpdates() { pozivi++; return { ok: true, result: [] } },
      async ingest() { return { status: 200, tijelo: {} } },
      async odgovori() { return true },
    }
    let ukljucen = false
    const o = {
      configPath: put('telegram.json'), stanjePath: put('stanje.json'), bravaPath: put('poller.lock'),
      api, log: () => {},
      razgovor: {
        razgovor: { primi: () => {} },
        postavke: () => ({ ...RAZGOVOR_ZADANO, dopusteniKorisnici: [], ukljucen }),
        ja: JA, kanal: { ime: 'telegram' } as Kanal,
      },
    }
    expect(uskladiTelegramPoller(o).radnja).toBe('nista')
    ukljucen = true
    expect(uskladiTelegramPoller(o).radnja).toBe('pokrenut')
    await Bun.sleep(5)
    expect(pozivi).toBe(1)
    expect(stanjeUlaza(put('stanje.json'), put('poller.lock')).radi).toBe(true)
  })
})
