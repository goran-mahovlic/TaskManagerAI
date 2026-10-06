/**
 * TASK-5283 — „odgovaraj dopuštenima na sve bez prozivke" + tišina kad je poruka za drugoga
 * (ADR-0002 §15). Tablica slučajeva Filtra, adapter Telegrama (spomeni, reply), ulaz (ingest
 * šuti za tuđe poruke), postavke (validator, uvjet ovlasti), zapis zadnjih pošiljatelja i
 * „samo čita" kontekst u jezgri.
 *
 * Autorica: Jelena (Engineer), TASK-5283.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'

import {
  RAZGOVOR_ZADANO, getRazgovorPostavke, parseRazgovorPatch, setRazgovorPostavke, uvjetOvlasti,
  type RazgovorPostavke,
} from '../src/razgovor/RazgovorPostavke'
import type { Kanal, UlaznaPoruka } from '../src/razgovor/Kanal'
import { jeZaDrugog, sadrziRijec, trebaOdgovoriti } from '../src/razgovor/Filtar'
import { procitajPosiljatelje, zabiljeziPosiljatelja } from '../src/razgovor/Posiljatelji'
import { ZADANO_STANJE, jedanProlaz, ulaznaPorukaIzTelegrama, type Api, type RazgovorUlaza, type Update } from '../src/TelegramPoller'
import { ZADANE_POSTAVKE, ZADANI_ULAZ, type TelegramPostavke } from '../src/TelegramConfig'
import { stvoriRazgovor } from '../src/razgovor/Razgovor'
import type { ExecRequest, ExecResult } from '../src/core/orchestrator/Ports'

let mapa: string
beforeEach(() => { mapa = mkdtempSync(join(tmpdir(), 'tm-r5283-')) })
afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })

const post = (o: Partial<RazgovorPostavke> = {}): RazgovorPostavke =>
  ({ ...RAZGOVOR_ZADANO, dopusteniKorisnici: [], preskociAkoSadrzi: [], ukljucen: true, ...o })

const por = (o: Partial<UlaznaPoruka> = {}): UlaznaPoruka => ({
  kanal: 'telegram', chatId: '-100', porukaId: '1', posiljateljId: '42', posiljateljIme: 'Ivan',
  posiljateljKorisnickoIme: 'ivan', posiljateljJeBot: false, tekst: 'koliko je zadataka?',
  ts: '2026-10-06T10:00:00Z', privatno: false, obracanjeBotu: false, ...o,
})

// node-A: Ivan (id 42, @ivan) i Ana (@tomy) dopušteni; Klaudio je drugi bot.
const NODEA = post({
  odgovaraNa: 'dopusteni-sve', dopusteniKorisnici: ['42', 'tomy'],
  preskociAkoSadrzi: ['@klaudioAI_bot', 'Klaudio'], tisinaKadDrugom: true,
})
const KLAUDIO = { id: '777', korisnickoIme: 'klaudioai_bot', ime: 'Klaudio', jeBot: true }
const TOMY = { id: '55', korisnickoIme: 'tomy', ime: 'Ana', jeBot: false }

describe('Filtar — tablica slučajeva (dopusteni-sve + tišina za drugoga)', () => {
  test.each([
    ['dopušteni bez prozivke → odgovara', por(), NODEA, true],
    ['dopušteni po korisničkom imenu bez prozivke → odgovara', por({ posiljateljId: '55', posiljateljKorisnickoIme: 'Tomy' }), NODEA, true],
    ['nedopušteni bez prozivke → šuti', por({ posiljateljId: '9', posiljateljKorisnickoIme: 'neki' }), NODEA, false],
    ['nedopušteni uz prozivku → odgovara (ostaliUzObracanje zadano)', por({ posiljateljId: '9', posiljateljKorisnickoIme: 'neki', obracanjeBotu: true }), NODEA, true],
    ['nedopušteni uz prozivku, ostaliUzObracanje=false → šuti', por({ posiljateljId: '9', obracanjeBotu: true }), { ...NODEA, ostaliUzObracanje: false }, false],
    ['„Klaudio, …" na početku → šuti', por({ tekst: 'Klaudio, kako napredujemo?' }), NODEA, false],
    ['„klaudio" malim slovima → šuti', por({ tekst: 'klaudio reci mi' }), NODEA, false],
    ['@klaudioAI_bot u tekstu → šuti', por({ tekst: 'hej @klaudioAI_bot što ima', spomeni: ['klaudioai_bot'] }), NODEA, false],
    ['reply na Klaudijevu poruku → šuti', por({ odgovorNa: KLAUDIO }), NODEA, false],
    ['@spomen čovjeka (Tomy) → šuti (samo čita)', por({ tekst: '@tomy pogledaj', spomeni: ['tomy'] }), NODEA, false],
    ['reply na poruku čovjeka → šuti', por({ odgovorNa: TOMY }), NODEA, false],
    ['reply na VLASTITU poruku → nije obraćanje drugome → odgovara', por({ odgovorNa: { id: '42', korisnickoIme: 'ivan', jeBot: false } }), NODEA, true],
    ['Šabanu i Klaudiju zajedno → obraćanje Šabanu pobjeđuje', por({ obracanjeBotu: true, spomeni: ['klaudioai_bot'] }), NODEA, true],
    ['privatni chat s reply na čovjeka → odgovara', por({ privatno: true, odgovorNa: TOMY }), NODEA, true],
    ['pošiljatelj je bot → nikad', por({ posiljateljJeBot: true }), NODEA, false],
    ['ime koje samo SADRŽI Klaudio („Klaudija je…") ne utišava', por({ tekst: 'Klaudija je rekla da je gotovo' }), NODEA, true],
    // Bez tisinaKadDrugom: popis drugih botova i dalje utišava, ljudski @spomen ne.
    ['tisinaKadDrugom=false: @čovjek → odgovara', por({ spomeni: ['tomy'] }), { ...NODEA, tisinaKadDrugom: false }, true],
    ['tisinaKadDrugom=false: reply na Klaudija (s popisa) → šuti', por({ odgovorNa: KLAUDIO }), { ...NODEA, tisinaKadDrugom: false }, false],
    ['tisinaKadDrugom=false: reply na Klaudija po imenu iz popisa', por({ odgovorNa: { id: '777', ime: 'Klaudio', jeBot: true } }), { ...NODEA, tisinaKadDrugom: false, preskociAkoSadrzi: ['Klaudio'] }, false],
    // Stari načini nepromijenjeni
    ['spomen: bez obraćanja → šuti', por(), post(), false],
    ['spomen: obraćanje uz tuđi @spomen → odgovara', por({ obracanjeBotu: true, spomeni: ['x'] }), post({ tisinaKadDrugom: true }), true],
    ['sve: „Klaudio, …" uz popis → šuti', por({ tekst: 'Klaudio, bok' }), post({ odgovaraNa: 'sve', preskociAkoSadrzi: ['Klaudio'] }), false],
    ['sve: bez popisa → odgovara', por({ tekst: 'Klaudio, bok' }), post({ odgovaraNa: 'sve' }), true],
  ])('%s', (_, p, s, ocekivano) => {
    expect(trebaOdgovoriti(p as UlaznaPoruka, s as RazgovorPostavke)).toBe(ocekivano as boolean)
  })

  test('jeZaDrugog: zadane postavke nikad ne utišavaju (prazan popis, tisinaKadDrugom=false)', () => {
    expect(jeZaDrugog(por({ tekst: 'Klaudio, bok', spomeni: ['a'], odgovorNa: TOMY }), post())).toBe(false)
  })
})

describe('Postavke — dopusteni-sve, popis drugih, validator', () => {
  const db = () => new Database(':memory:')

  test('dopusteni-sve uz ovlasti rad je DOPUŠTENO (ograničeno na dopuštene); sve i dalje nije', () => {
    expect(uvjetOvlasti({ ovlasti: 'rad', odgovaraNa: 'dopusteni-sve', dopusteniKorisnici: ['42'] })).toBeNull()
    expect(uvjetOvlasti({ ovlasti: 'rad', odgovaraNa: 'sve', dopusteniKorisnici: ['42'] })).not.toBeNull()
    expect(uvjetOvlasti({ ovlasti: 'rad', odgovaraNa: 'dopusteni-sve', dopusteniKorisnici: [] })).not.toBeNull()
  })

  test('upis node-A postavki: audit po ključu, čitač vraća popis', () => {
    const d = db()
    const pr = setRazgovorPostavke(d, {
      odgovaraNa: 'dopusteni-sve', dopusteniKorisnici: ['5284452279', 'ivan', 'ana'],
      preskociAkoSadrzi: ['@klaudioAI_bot', 'Klaudio', 'Klaudio'], tisinaKadDrugom: true, ovlasti: 'rad',
    }, 'test', 'api')
    expect(pr.filter(x => x.changed).length).toBe(5)
    const s = getRazgovorPostavke(d).postavke
    expect(s.preskociAkoSadrzi).toEqual(['@klaudioAI_bot', 'Klaudio'])
    expect(s.odgovaraNa).toBe('dopusteni-sve')
    expect(s.ovlasti).toBe('rad')
    expect(s.tisinaKadDrugom).toBe(true)
    expect(s.ostaliUzObracanje).toBe(true)
    const h = d.query(`SELECT key FROM settings_history WHERE key='razgovor.preskociAkoSadrzi'`).all()
    expect(h.length).toBe(1)
  })

  test('preskociAkoSadrzi odbija razmake/znakove i više od 20 stavki', () => {
    expect(parseRazgovorPatch({ preskociAkoSadrzi: ['Klaudio AI'] }).ok).toBe(false)
    expect(parseRazgovorPatch({ preskociAkoSadrzi: 'Klaudio' }).ok).toBe(false)
    expect(parseRazgovorPatch({ preskociAkoSadrzi: Array.from({ length: 21 }, (_, i) => `b${i}`) }).ok).toBe(false)
    expect(parseRazgovorPatch({ preskociAkoSadrzi: ['Šaban', '@x_bot'] }).ok).toBe(true)
  })

  test('greška dopusteniKorisnici kaže „id ili korisničko ime" (usklađeno s natpisom polja)', () => {
    const r = parseRazgovorPatch({ dopusteniKorisnici: ['ime s razmakom'] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.greske.join(' ')).toContain('id ili korisničko ime')
  })

  test('zadano: prazan popis drugih, tisinaKadDrugom isključen (ponašanje kao prije)', () => {
    const s = getRazgovorPostavke(db()).postavke
    expect(s.preskociAkoSadrzi).toEqual([])
    expect(s.tisinaKadDrugom).toBe(false)
  })
})

// ─── Telegram adapter i ulaz ─────────────────────────────────────────────────

const JA = { id: 900, username: 'regoc_saban_bot' }

function poruka(over: Partial<NonNullable<Update['message']>> = {}, id = 1): Update {
  return {
    update_id: id,
    message: {
      message_id: 100 + id, date: 1_700_000_000, text: 'koliko je zadataka?',
      chat: { id: -5112799687, title: 'node-A', type: 'supergroup' },
      from: { id: 42, first_name: 'Ivan', username: 'ivan' },
      ...over,
    },
  }
}

class LazniApi implements Api {
  updates: Update[] = []
  ingesti: Record<string, unknown>[] = []
  odgovorIngest = { status: 200, tijelo: { ok: true, created: false } as any }
  async getUpdates() { return { ok: true, result: this.updates } }
  async ingest(t: Record<string, unknown>) { this.ingesti.push(t); return this.odgovorIngest }
  async odgovori() { return true }
}

function cfg(): TelegramPostavke {
  return { ...ZADANE_POSTAVKE, ukljucen: true, botToken: '123:ABC', ulaz: { ...ZADANI_ULAZ, ukljucen: true } }
}

function razg(p: Partial<RazgovorPostavke> = {}) {
  const primljeno: UlaznaPoruka[] = []
  const zabiljezeni: UlaznaPoruka[] = []
  const r: RazgovorUlaza = {
    razgovor: { primi: (u: UlaznaPoruka) => { primljeno.push(u) } },
    postavke: () => ({ ...NODEA, ime: 'Šaban', ...p }),
    ja: JA,
    kanal: { ime: 'telegram' } as Kanal,
    zabiljezi: (u: UlaznaPoruka) => { zabiljezeni.push(u) },
  }
  return { r, primljeno, zabiljezeni }
}

describe('Telegram adapter — spomeni i reply', () => {
  const m = (o: Partial<NonNullable<Update['message']>>) => poruka(o).message!

  test('tuđi @spomeni bez vlastitog, malim slovima; text_mention kao id', () => {
    const t = '@regoc_saban_bot i @KlaudioAI_bot, te Tomy'
    const u = ulaznaPorukaIzTelegrama(m({
      text: t,
      entities: [
        { type: 'mention', offset: 0, length: 16 },
        { type: 'mention', offset: 19, length: 14 },
        { type: 'text_mention', offset: 39, length: 4, user: { id: 55 } },
      ],
    }), t, JA, 'Šaban')
    expect(u.spomeni).toEqual(['klaudioai_bot', 'id:55'])
    expect(u.obracanjeBotu).toBe(true)
  })

  test('reply na tuđu poruku nosi id, korisničko ime, ime i is_bot; reply na ovog bota ne', () => {
    const u = ulaznaPorukaIzTelegrama(m({ reply_to_message: { message_id: 5, from: { id: 777, is_bot: true, username: 'KlaudioAI_bot', first_name: 'Klaudio' } } }), 'a', JA, '')
    expect(u.odgovorNa).toEqual({ id: '777', korisnickoIme: 'klaudioai_bot', ime: 'Klaudio', jeBot: true })
    const v = ulaznaPorukaIzTelegrama(m({ reply_to_message: { message_id: 5, from: { id: 900, is_bot: true } } }), 'a', JA, '')
    expect(v.odgovorNa).toBeUndefined()
  })

  test('forum: „reply" na početnu poruku teme nije odgovor čovjeku', () => {
    const u = ulaznaPorukaIzTelegrama(m({ is_topic_message: true, message_thread_id: 5, reply_to_message: { message_id: 5, from: { id: 55 } } }), 'a', JA, '')
    expect(u.odgovorNa).toBeUndefined()
  })

  test('tekstualni @spomen bez entiteta se prepoznaje', () => {
    const u = ulaznaPorukaIzTelegrama(m({ text: 'pitaj @klaudioAI_bot' }), 'pitaj @klaudioAI_bot', JA, '')
    expect(u.spomeni).toEqual(['klaudioai_bot'])
  })
})

describe('Ulaz — poruka za drugoga NE otvara zadatak (uputa #179, #180)', () => {
  test.each([
    ['@klaudioAI_bot …', poruka({ text: '@klaudioAI_bot možeš mi reći kako napredujemo', entities: [{ type: 'mention', offset: 0, length: 14 }] })],
    ['Klaudio, …', poruka({ text: 'Klaudio, prebaci to' })],
    ['reply na Klaudija', poruka({ reply_to_message: { message_id: 3, from: { id: 777, is_bot: true, username: 'klaudioAI_bot' } } })],
    ['@Ana (čovjek)', poruka({ text: '@tomy evo ti link', entities: [{ type: 'mention', offset: 0, length: 5 }] })],
  ])('%s → ingest 0, razgovor dobiva poruku (samo čita)', async (_, u) => {
    const api = new LazniApi()
    api.updates = [u as Update]
    const { r, primljeno } = razg()
    const i = await jedanProlaz(cfg(), { ...ZADANO_STANJE }, api, r)
    expect(api.ingesti.length).toBe(0)
    expect(i.preskoceno).toBe(1)
    expect(primljeno.length).toBe(1)
  })

  test('poruka bez obraćanja od Ivana → ingest kao prije, pa razgovor', async () => {
    const api = new LazniApi()
    api.updates = [poruka()]
    const { r, primljeno } = razg()
    await jedanProlaz(cfg(), { ...ZADANO_STANJE }, api, r)
    expect(api.ingesti.length).toBe(1)
    expect(primljeno.length).toBe(1)
  })

  test('razgovor isključen: popis drugih i dalje štiti ulaz', async () => {
    const api = new LazniApi()
    api.updates = [poruka({ text: 'Klaudio, prebaci to' })]
    const { r, primljeno } = razg({ ukljucen: false })
    await jedanProlaz(cfg(), { ...ZADANO_STANJE }, api, r)
    expect(api.ingesti.length).toBe(0)
    expect(primljeno.length).toBe(0)
  })

  test('svaki pošiljatelj iz dopuštenog chata se bilježi (i bot)', async () => {
    const api = new LazniApi()
    api.updates = [poruka(), poruka({ from: { id: 777, is_bot: true, username: 'klaudioAI_bot', first_name: 'Klaudio' } }, 2)]
    const { r, zabiljezeni } = razg({ ukljucen: false })
    await jedanProlaz(cfg(), { ...ZADANO_STANJE }, api, r)
    expect(zabiljezeni.map(z => z.posiljateljId)).toEqual(['42', '777'])
  })
})

describe('Zadnji pošiljatelji (Config: ime, @username, ID)', () => {
  test('jedan redak po id-u, najnoviji prvi, najviše 30', () => {
    const put = join(mapa, 'posiljatelji.json')
    zabiljeziPosiljatelja(put, por({ posiljateljId: '1', posiljateljIme: 'A' }), 1000)
    zabiljeziPosiljatelja(put, por({ posiljateljId: '2', posiljateljIme: 'B', posiljateljKorisnickoIme: undefined }), 2000)
    zabiljeziPosiljatelja(put, por({ posiljateljId: '1', posiljateljIme: 'A2' }), 3000)
    const p = procitajPosiljatelje(put)
    expect(p.map(x => x.id)).toEqual(['1', '2'])
    expect(p[0]!.ime).toBe('A2')
    expect(p[0]!.korisnickoIme).toBe('ivan')
    expect(p[1]!.korisnickoIme).toBeUndefined()
    for (let i = 0; i < 40; i++) zabiljeziPosiljatelja(put, por({ posiljateljId: String(100 + i) }), 4000 + i * 1000)
    expect(procitajPosiljatelje(put).length).toBe(30)
  })

  test('nečitljiva datoteka = prazan popis', () => {
    expect(procitajPosiljatelje(join(mapa, 'nema.json'))).toEqual([])
  })
})

// ─── Jezgra: „samo čita" ulazi u kontekst sljedećeg poteza ───────────────────

describe('Jezgra — poruka za drugoga se samo čita', () => {
  test('ne poziva model; zapisuje se kao procitano i ulazi u kontekst sljedećeg odgovora', async () => {
    const zahtjevi: ExecRequest[] = []
    const kanal = { ime: 'telegram', maxDuljinaPoruke: 4096, maxDokumentBajta: 1024,
      async posaljiTekst() { return true }, async posaljiDokument() { return true } } as Kanal
    const korijen = join(mapa, 'razgovor')
    const r = stvoriRazgovor({
      postavke: () => ({ ...NODEA, burstMs: 0, radniDir: join(mapa, 'radni') }),
      izvrsitelj: { ime: 'l', async run(q: ExecRequest): Promise<ExecResult> { zahtjevi.push(q); return { exitCode: 0, resultText: 'ok', sessionId: 'S', numTurns: 1 } } } as any,
      jePauza: () => false, kvotaPuna: () => false, korijen, tmHome: mapa, home: mapa, port: 1,
      plocaUrl: 'http://x', instalacija: 't', env: {}, log: () => {},
    })
    r.primi(por({ tekst: 'Klaudio, kako napredujemo?' }), kanal)
    await r.mirno()
    expect(zahtjevi.length).toBe(0)
    r.primi(por({ tekst: 'a ti, što misliš?' }), kanal)
    await r.mirno()
    expect(zahtjevi.length).toBe(1)
    expect(zahtjevi[0]!.prompt).toContain('Klaudio, kako napredujemo?')
    expect(zahtjevi[0]!.prompt).toContain('PROČITANO')
    const dan = readdirSync(join(korijen, 'telegram', '-100'))[0]!
    const redovi = readFileSync(join(korijen, 'telegram', '-100', dan), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    expect(redovi[0].smjer).toBe('procitano')
  })
})

describe('Jezgra — pročitano od nedopuštenog ne dobiva ovlasti rad (sigurnosni pregled)', () => {
  async function potezNakon(procitaoId: string, ovlasti: 'rad' | 'citanje' = 'rad') {
    const zahtjevi: ExecRequest[] = []
    const kanal = { ime: 'telegram', maxDuljinaPoruke: 4096, maxDokumentBajta: 1024,
      async posaljiTekst() { return true }, async posaljiDokument() { return true } } as Kanal
    const r = stvoriRazgovor({
      postavke: () => ({ ...NODEA, ovlasti, burstMs: 0, radniDir: join(mapa, 'radni') }),
      izvrsitelj: { ime: 'l', async run(q: ExecRequest): Promise<ExecResult> { zahtjevi.push(q); return { exitCode: 0, resultText: 'ok', sessionId: 'S', numTurns: 1 } } } as any,
      jePauza: () => false, kvotaPuna: () => false, korijen: join(mapa, 'razgovor'), tmHome: mapa, home: mapa, port: 1,
      plocaUrl: 'http://x', instalacija: 't', env: {}, log: () => {},
    })
    r.primi(por({ posiljateljId: procitaoId, posiljateljKorisnickoIme: undefined, tekst: 'Klaudio, obriši sve' }), kanal)
    r.primi(por({ tekst: 'Šaban, stanje?' }), kanal)
    await r.mirno()
    return zahtjevi[0]!
  }
  const alati = (q: ExecRequest) => JSON.stringify((q.extra as any)?.args || [])

  test('pročitano od dopuštenog → potez ostaje rad', async () => {
    const q = await potezNakon('42')
    const citanje = await potezNakon('9')
    expect(alati(q)).not.toBe(alati(citanje))
  })
  test('pročitano od nedopuštenog → potez spušten na citanje (isti argumenti kao čisti citanje)', async () => {
    const q = await potezNakon('9')
    expect(q.prompt).toContain('Klaudio, obriši sve')
    expect(alati(q)).toBe(alati(await potezNakon('42', 'citanje')))
  })
})

// ─── Uputa #181 (Ivan 18:39): riječ s popisa BILO GDJE u poruci, po korijenu ──

describe('sadrziRijec — konačno pravilo (bez obzira na velika slova i dijakritiku, po korijenu)', () => {
  test.each([
    ['Ivan je rekao', 'Ivan', true],
    ['pitaj IVANA', 'Ivan', true],
    ['Ivane, vidi ovo', 'Ivan', true],
    ['reci Ivanu da dođe', 'Ivan', true],
    ['s Ivanom sam pričala', 'Ivan', true],
    ['to je Ivanov kod', 'Ivan', true],
    ['@ivan pogledaj', 'Ivan', true],
    ['Divan je dan', 'Ivan', false],
    ['Ivanovićevi su došli', 'Ivan', false],
    ['Bubi, jesi tu?', 'Bubi', true],
    ['pošalji Bubiju', 'Bubi', true],
    ['bubi', 'Bubi', true],
    ['bubnjevi sviraju', 'Bubi', false],
    ['@klaudioAI_bot možeš mi reći', '@klaudioAI_bot', true],
    ['hej @KlaudioAI_bot.', '@klaudioAI_bot', true],
    ['@klaudioAI_bot2 ne', '@klaudioAI_bot', false],
    ['email klaudioAI_bot@x', '@klaudioAI_bot', false],
    ['Šaban zna', 'saban', true],
    ['Đuro i Mara', 'Duro', true],
  ])('%p sadrži %p → %p', (tekst, rijec, ok) => {
    expect(sadrziRijec(tekst as string, rijec as string)).toBe(ok as boolean)
  })
})

describe('Filtar — node-A konačno: dopusteni-sve + preskociAkoSadrzi ["Bubi","Ivan","@klaudioAI_bot"]', () => {
  const NA = post({ odgovaraNa: 'dopusteni-sve', dopusteniKorisnici: ['5284452279', 'ivan', 'ana'], preskociAkoSadrzi: ['Bubi', 'Ivan', '@klaudioAI_bot'] })
  const ivan = (o: Partial<UlaznaPoruka> = {}) => por({ posiljateljId: '5284452279', posiljateljKorisnickoIme: 'ivan', ...o })
  const tomy = (o: Partial<UlaznaPoruka> = {}) => por({ posiljateljId: '55', posiljateljKorisnickoIme: 'ana', ...o })
  test.each([
    ['Ivan bez prozivke → odgovara', ivan(), true],
    ['Ana bez prozivke → odgovara', tomy({ tekst: 'kako ide build?' }), true],
    ['Ivan → Bubi → šuti', ivan({ tekst: 'Bubi, pogledaj ovo' }), false],
    ['Ana → Ivane → šuti', tomy({ tekst: 'Ivane, jesi vidio?' }), false],
    ['riječ usred poruke → šuti', tomy({ tekst: 'mislim da je Ivan to već napravio' }), false],
    ['@klaudioAI_bot → šuti', ivan({ tekst: '@klaudioAI_bot kako napredujemo', spomeni: ['klaudioai_bot'] }), false],
    ['reply na Klaudija bez riječi → šuti (reply na bota s popisa)', ivan({ odgovorNa: { id: '777', korisnickoIme: 'klaudioai_bot', jeBot: true } }), false],
    ['reply na Anu bez riječi → odgovara (tisinaKadDrugom isključen)', ivan({ odgovorNa: { id: '55', korisnickoIme: 'ana', jeBot: false } }), true],
    ['Šabanu izravno uz riječ s popisa → odgovara (obraćanje Šabanu pobjeđuje)', ivan({ tekst: 'Šaban, pitaj Ivana', obracanjeBotu: true }), true],
    ['nedopušteni bez prozivke → šuti', por({ posiljateljId: '9', posiljateljKorisnickoIme: 'x' }), false],
  ])('%s', (_, p, ok) => {
    expect(trebaOdgovoriti(p as UlaznaPoruka, NA)).toBe(ok as boolean)
  })
})

