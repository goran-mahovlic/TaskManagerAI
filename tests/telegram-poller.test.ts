/**
 * Testovi Telegram pollera (DIZAJN-telegram-poller §8 — uvjet gotovosti).
 *
 * Sve bez mreže: `getUpdates` i poziv prema ploči su UBRIZGANI (`api`), pa je `jedanProlaz`
 * čista funkcija nad ulaznim podatcima.
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  ZADANO_STANJE, jedanProlaz, preslikaj, propusti, ucitajStanje, uzmiBravu, zapisiStanje,
  type Api, type StanjePollera, type Update,
} from '../src/TelegramPoller'
import {
  ZADANE_POSTAVKE, ZADANI_ULAZ, loadTelegramConfig, saveTelegramConfig, validateTelegramPatch,
  type TelegramPostavke,
} from '../src/TelegramConfig'

let mapa: string
beforeEach(() => { mapa = mkdtempSync(join(tmpdir(), 'tm-tgp-')) })
afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })
const put = (i: string) => join(mapa, i)

function cfg(ulaz: Partial<TelegramPostavke['ulaz']> = {}): TelegramPostavke {
  return {
    ...ZADANE_POSTAVKE, ukljucen: true, botToken: '123:ABC',
    ulaz: { ...ZADANI_ULAZ, ukljucen: true, ...ulaz },
  }
}

function poruka(over: Partial<NonNullable<Update['message']>> = {}, id = 1): Update {
  return {
    update_id: id,
    message: {
      message_id: 100 + id,
      date: 1_700_000_000,
      text: 'treba napraviti nešto',
      chat: { id: -1001234567890, title: 'Grupa', type: 'supergroup' },
      from: { id: 42, first_name: 'Ivan', username: 'ivan' },
      ...over,
    },
  }
}

class LazniApi implements Api {
  updates: Update[] = []
  odgovorGet: any = null
  ingesti: Record<string, unknown>[] = []
  odgovoriIngest: { status: number; tijelo: any }[] = []
  poslane: { chatId: string | number; tekst: string; replyTo?: number }[] = []
  trazeniOffset: number[] = []

  async getUpdates(offset: number) {
    this.trazeniOffset.push(offset)
    if (this.odgovorGet) return this.odgovorGet
    return { ok: true, result: this.updates }
  }
  async ingest(tijelo: Record<string, unknown>) {
    this.ingesti.push(tijelo)
    return this.odgovoriIngest.shift() || { status: 201, tijelo: { ok: true, created: true, taskId: 'TASK-1' } }
  }
  async odgovori(chatId: string | number, tekst: string, replyTo?: number) {
    this.poslane.push({ chatId, tekst, replyTo })
    return true
  }
}

const stanje = (): StanjePollera => ({ ...ZADANO_STANJE })

// ─── 1. i 2. Najviše jednom ──────────────────────────────────────────────────

describe('offset — „najviše jednom" (§5.1)', () => {
  test('update bez teksta se preskoči, ali offset se IPAK pomakne', async () => {
    const api = new LazniApi()
    api.updates = [{ update_id: 7 }, poruka({ text: '' }, 8)]
    const s = stanje()
    const i = await jedanProlaz(cfg(), s, api)
    expect(i.poslano).toBe(0)
    expect(s.offset).toBe(9)
  })

  test('offset se pomiče i kad ploča odbije zahtjev (bez toga bi ista poruka ušla dvaput)', async () => {
    const api = new LazniApi()
    api.updates = [poruka({}, 5)]
    api.odgovoriIngest = [{ status: 500, tijelo: { error: 'baza ne radi' } }]
    const s = stanje()
    await jedanProlaz(cfg(), s, api)
    expect(s.offset).toBe(6)
  })

  test('drugi prolaz traži updates OD novog offseta', async () => {
    const api = new LazniApi()
    api.updates = [poruka({}, 3)]
    const s = stanje()
    await jedanProlaz(cfg(), s, api)
    api.updates = []
    await jedanProlaz(cfg(), s, api)
    expect(api.trazeniOffset).toEqual([0, 4])
  })
})

// ─── 3. Filtri ───────────────────────────────────────────────────────────────

describe('filtri (§4.2)', () => {
  test('chat izvan dopuštenih ne šalje ništa na ploču', async () => {
    const api = new LazniApi()
    api.updates = [poruka()]
    const i = await jedanProlaz(cfg({ dopusteniChatovi: ['-100999'] }), stanje(), api)
    expect(api.ingesti.length).toBe(0)
    expect(i.preskoceno).toBe(1)
  })

  test('okidač: poruka bez njega ne prolazi, s njim prolazi', async () => {
    const api = new LazniApi()
    api.updates = [poruka({ text: 'obična poruka' })]
    await jedanProlaz(cfg({ okidac: '/zadatak' }), stanje(), api)
    expect(api.ingesti.length).toBe(0)

    const api2 = new LazniApi()
    api2.updates = [poruka({ text: '/zadatak napravi X' })]
    await jedanProlaz(cfg({ okidac: '/zadatak' }), stanje(), api2)
    expect(api2.ingesti.length).toBe(1)
  })

  test('korisnik izvan popisa ne prolazi', () => {
    const m = poruka().message!
    expect(propusti({ ...ZADANI_ULAZ, dopusteniKorisnici: ['999'] }, m, m.text!)).toBe(false)
    expect(propusti({ ...ZADANI_ULAZ, dopusteniKorisnici: ['42'] }, m, m.text!)).toBe(true)
  })

  test('sameSpomeni traži spomen bota', () => {
    const m = poruka().message!
    expect(propusti({ ...ZADANI_ULAZ, sameSpomeni: true }, m, m.text!)).toBe(false)
    const sSpomenom = poruka({ entities: [{ type: 'mention' }] }).message!
    expect(propusti({ ...ZADANI_ULAZ, sameSpomeni: true }, sSpomenom, sSpomenom.text!)).toBe(true)
  })

  test('predugačka poruka se REŽE, ne odbacuje', async () => {
    const api = new LazniApi()
    api.updates = [poruka({ text: 'x'.repeat(5000) })]
    await jedanProlaz(cfg({ maxDuljina: 100 }), stanje(), api)
    expect(String(api.ingesti[0]!.text).length).toBe(100)
  })
})

// ─── 4. Preslikavanje ────────────────────────────────────────────────────────

describe('preslikavanje na /api/ingest (§6)', () => {
  test('externalId je chat.id:message_id, source je telegram', () => {
    const m = poruka().message!
    const t = preslikaj(m, m.text!)
    expect(t.externalId).toBe('-1001234567890:101')
    expect(t.source).toBe('telegram')
    expect(t.replyTo).toBe('-1001234567890')
    expect(t.senderName).toBe('Ivan (@ivan)')
  })

  test('poller NE šalje projectId, assignee ni tags (o tome odlučuje IngestConfig)', () => {
    const m = poruka().message!
    const t = preslikaj(m, m.text!)
    expect('projectId' in t).toBe(false)
    expect('assignee' in t).toBe(false)
    expect('tags' in t).toBe(false)
  })

  test('caption se koristi kad teksta nema (poruka sa slikom)', async () => {
    const api = new LazniApi()
    api.updates = [poruka({ text: undefined, caption: 'opis slike' })]
    await jedanProlaz(cfg(), stanje(), api)
    expect(api.ingesti[0]!.text).toBe('opis slike')
  })
})

// ─── 5. i 6. Odgovor ploče ───────────────────────────────────────────────────

describe('što poller radi s odgovorom ploče (§4)', () => {
  test('201 + potvrdaUChat → točno jedna poruka natrag, sadrži broj zadatka', async () => {
    const api = new LazniApi()
    api.updates = [poruka()]
    const i = await jedanProlaz(cfg({ potvrdaUChat: true }), stanje(), api)
    expect(i.poslano).toBe(1)
    expect(api.poslane.length).toBe(1)
    expect(api.poslane[0]!.tekst).toContain('TASK-1')
    expect(api.poslane[0]!.replyTo).toBe(101)
  })

  test('200 created:false → TIŠINA (bot ne komentira svaku poruku)', async () => {
    const api = new LazniApi()
    api.updates = [poruka()]
    api.odgovoriIngest = [{ status: 200, tijelo: { ok: true, created: false, action: 'shadow' } }]
    const i = await jedanProlaz(cfg({ potvrdaUChat: true }), stanje(), api)
    expect(api.poslane.length).toBe(0)
    expect(i.poslano).toBe(0)
  })

  test('422 (vratar ploče) se zapisuje kao greška, bez otvorenog zadatka', async () => {
    const api = new LazniApi()
    api.updates = [poruka()]
    api.odgovoriIngest = [{ status: 422, tijelo: { error: 'reciklirani izvještaj' } }]
    const s = stanje()
    const i = await jedanProlaz(cfg(), s, api)
    expect(i.greske.join(' ')).toContain('422')
    expect(s.zadnjaGreska).toContain('reciklirani')
  })

  test('potvrda isključena → nema poruke natrag ni na 201', async () => {
    const api = new LazniApi()
    api.updates = [poruka()]
    await jedanProlaz(cfg({ potvrdaUChat: false }), stanje(), api)
    expect(api.poslane.length).toBe(0)
  })
})

// ─── 7. Backoff i trajna stanja ──────────────────────────────────────────────

describe('429 / 409 / 401 (§5.3)', () => {
  test('429 s retry_after: 7 → sljedeći prolaz ne prije 7 s', async () => {
    const api = new LazniApi()
    api.odgovorGet = { ok: false, status: 429, retryAfter: 7 }
    const s = stanje()
    const i = await jedanProlaz(cfg(), s, api)
    expect(i.cekajMs).toBe(7000)
    expect(s.cekajDo).toBeGreaterThan(Date.now() + 6000)
  })

  test('409 (webhook) zaustavlja petlju i stanje nosi razlog', async () => {
    const api = new LazniApi()
    api.odgovorGet = { ok: false, status: 409 }
    const s = stanje()
    const i = await jedanProlaz(cfg(), s, api)
    expect(i.zaustavljen).toBe(true)
    expect(s.zaustavljenRazlog).toContain('webhook')
  })

  test('401 (token) zaustavlja petlju — ponavljanje ne liječi trajno stanje', async () => {
    const api = new LazniApi()
    api.odgovorGet = { ok: false, status: 401 }
    const s = stanje()
    await jedanProlaz(cfg(), s, api)
    expect(s.zaustavljen).toBe(true)
    expect(s.zaustavljenRazlog).toContain('token')
  })

  test('zaustavljena petlja ne zove Telegram uopće', async () => {
    const api = new LazniApi()
    const s = { ...stanje(), zaustavljen: true, zaustavljenRazlog: 'webhook' }
    await jedanProlaz(cfg(), s, api)
    expect(api.trazeniOffset.length).toBe(0)
  })

  test('mrežni kvar se zapisuje, ali petlju ne zaustavlja', async () => {
    const api = new LazniApi()
    api.odgovorGet = { ok: false, description: 'veza prekinuta' }
    const s = stanje()
    const i = await jedanProlaz(cfg(), s, api)
    expect(i.zaustavljen).toBe(false)
    expect(s.zadnjaGreska).toBe('veza prekinuta')
  })
})

// ─── 8. Brava ────────────────────────────────────────────────────────────────

describe('brava (§5.2)', () => {
  test('drugi poller uz živi PID u bravi se ne pokreće i kaže zašto', () => {
    const p = put('poller.lock')
    writeFileSync(p, String(process.pid + 0), 'utf-8')
    // Simuliramo tuđi živi proces: PID 1 postoji na svakom sustavu.
    writeFileSync(p, '1', 'utf-8')
    const b = uzmiBravu(p)
    expect(b.ok).toBe(false)
    expect(b.razlog).toContain('već radi')
  })

  test('brava mrtvog procesa se preuzima', () => {
    const p = put('poller.lock')
    writeFileSync(p, '999999', 'utf-8')
    const b = uzmiBravu(p)
    expect(b.ok).toBe(true)
    b.osloboditi?.()
  })
})

// ─── 9. Stanje i konfiguracija ───────────────────────────────────────────────

describe('stanje i konfiguracija', () => {
  test('stanje se zapisuje i čita, a NE živi u konfiguraciji', () => {
    const p = put('stanje.json')
    const s = { ...stanje(), offset: 55, obradeno: 3 }
    zapisiStanje(s, p)
    const procitano = ucitajStanje(p)
    expect(procitano.offset).toBe(55)
    expect(procitano.obradeno).toBe(3)
    expect(Object.keys(ZADANE_POSTAVKE)).not.toContain('offset')
  })

  test('ulaz je zadano ISKLJUČEN i popisi su prazni', () => {
    expect(ZADANE_POSTAVKE.ulaz.ukljucen).toBe(false)
    expect(ZADANE_POSTAVKE.ulaz.dopusteniChatovi).toEqual([])
    expect(ZADANE_POSTAVKE.ulaz.okidac).toBe('')
  })

  test('nepoznato polje UNUTAR ulaza se odbija imenom (prije je prolazilo)', () => {
    const r = validateTelegramPatch({ ulaz: { ukljucenn: true } })
    expect(r.ok).toBe(false)
    expect(r.greske.join(' ')).toContain('ulaz.ukljucenn')
  })

  test('granice ulaza se poštuju', () => {
    expect(validateTelegramPatch({ ulaz: { timeoutSek: 90 } }).ok).toBe(false)
    expect(validateTelegramPatch({ ulaz: { intervalSek: 0 } }).ok).toBe(false)
    expect(validateTelegramPatch({ ulaz: { intervalSek: 5 } }).ok).toBe(true)
  })

  test('zakrpa jednog polja ulaza ne pregazi ostala', () => {
    const p = put('telegram.json')
    saveTelegramConfig({ ulaz: { ...ZADANI_ULAZ, okidac: '/zadatak' } }, p)
    saveTelegramConfig({ ulaz: { ukljucen: true } as any }, p)
    const cfg = loadTelegramConfig(p)
    expect(cfg.ulaz.okidac).toBe('/zadatak')
    expect(cfg.ulaz.ukljucen).toBe(true)
  })

  test('stara datoteka bez „ulaz" dobiva zadani ulaz, ne undefined', () => {
    const p = put('telegram.json')
    writeFileSync(p, JSON.stringify({ ukljucen: true, botToken: 'x' }), 'utf-8')
    expect(loadTelegramConfig(p).ulaz.intervalSek).toBe(ZADANI_ULAZ.intervalSek)
  })
})
