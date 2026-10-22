/**
 * TASK-5728 — kanal bot↔bot s VIŠE drugih botova: zasebne tajne po botu i vezanje bota uz njegove
 * chatove. Prije toga je kraj s dva druga bota (Klaudio: Šaban + Mac) imao jedan par tajni, pa se
 * svaki od njih mogao predstaviti kao onaj drugi, a zapisi iz grupe jednog išli su i drugome.
 *
 * Autorica: Jelena (Engineer), TASK-5728.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BOT_KANAL_ZADANO, PUT_RUTE, TAJNA_PRIMANJA, TAJNA_SLANJA, ZAGLAVLJE_POTPISA, imeTajneZa, imenaTajniKanala, potpisi,
  praznoStanje, provjeriPotpis, stvoriBotKanal, tajnaZaBota,
  type BotKanalPostavke, type BotKanalStanje, type Zahtjev,
} from '../src/razgovor/BotKanal'
import { dopustenaImena, imeZabranjeno } from '../src/LoginCreds'
import { setBotKanalPostavke } from '../src/razgovor/BotKanalPostavke'
import { botKanalGet } from '../src/razgovor/RazgovorPloca'
import { imenaTajniPloce } from '../src/TajnePloca'

const CHAT_S = '-1001234567891' // grupa sa Šabanom
const CHAT_M = '-1001234567892' // grupa s Macom
/** Tajne Klaudijeva kraja: primanje = tajna slanja drugog bota; slanje = njegova tajna primanja. */
const PRIM = { saban: 'p'.repeat(48), mac: 'q'.repeat(48) } as Record<string, string>
const SLAN = { saban: 's'.repeat(48), mac: 't'.repeat(48) } as Record<string, string>
let sada = Date.parse('2026-10-23T08:00:00Z')

function pz(raw: unknown, tajna: string, put = '', ip = '172.24.0.1'): Zahtjev {
  const t = JSON.stringify(raw)
  return { ip, tijelo: t, potpis: potpisi(tajna, 'POST', `${PUT_RUTE}${put}`, t, Math.floor(sada / 1000)) }
}
const poruka = (o: Record<string, unknown> = {}) => ({
  izvor: 'mac', chatId: CHAT_M, tekst: 'Klaudio, stanje?', telegramPorukaId: 11,
  lanacId: `L-${Math.random().toString(36).slice(2)}`, skok: 1, izvornik: null, ts: '2026-10-23T08:00:00Z', ...o,
})

function okolina(o: { prim?: Record<string, string>; slan?: Record<string, string> } = {}) {
  const prim = o.prim ?? PRIM
  const slan = o.slan ?? SLAN
  const postavke: BotKanalPostavke = {
    ...BOT_KANAL_ZADANO, ukljucen: true, chatovi: [CHAT_S, CHAT_M], adrese: ['10.0.0.2', '10.0.0.3'],
    drugi: [
      { ime: 'saban', korisnickoIme: 'sabanAI_bot', url: 'http://10.0.0.2:17781', chatovi: [CHAT_S] },
      { ime: 'mac', korisnickoIme: 'macAI_bot', url: 'http://10.0.0.3:17781', chatovi: [CHAT_M] },
    ],
    stopKorisnici: ['100000011'], provjeraAdrese: false,
  }
  let stanje: BotKanalStanje = praznoStanje()
  const pozivi: { url: string; tijelo: any; potpis: string; body: string }[] = []
  const bk = stvoriBotKanal({
    ja: 'klaudio',
    postavke: () => postavke,
    tajnaPrimanja: ime => prim[ime],
    tajnaSlanja: ime => slan[ime],
    spremiste: { citaj: () => JSON.parse(JSON.stringify(stanje)), pisi: s => { stanje = JSON.parse(JSON.stringify(s)) } },
    sat: () => sada,
    ponoviMs: 0,
    fetchImpl: (async (url: string, init: any) => {
      pozivi.push({ url, tijelo: JSON.parse(init.body), potpis: init.headers[ZAGLAVLJE_POTPISA], body: init.body })
      return new Response('{}', { status: 202 })
    }) as any,
  })
  return { bk, postavke, pozivi, stanje: () => stanje }
}

describe('TASK-5728 dolazno: potpis određuje TKO je pošiljatelj', () => {
  test('Mac potpisuje svojom tajnom a tvrdi da je Šaban → 401 (i u Šabanovoj i u svojoj grupi)', () => {
    const { bk } = okolina()
    const r = bk.primi(pz(poruka({ izvor: 'saban', chatId: CHAT_S }), PRIM.mac!))
    expect(r.status).toBe(401)
    expect(bk.primi(pz(poruka({ izvor: 'saban' }), PRIM.mac!)).status).toBe(401)
    // i obrnuto: Šaban se ne može predstaviti kao Mac
    expect(bk.primi(pz(poruka({ izvor: 'mac' }), PRIM.saban!)).status).toBe(401)
  })
  test('svaki bot svojom tajnom u svojoj grupi → 202', () => {
    const { bk } = okolina()
    expect(bk.primi(pz(poruka(), PRIM.mac!)).status).toBe(202)
    expect(bk.primi(pz(poruka({ izvor: 'saban', chatId: CHAT_S }), PRIM.saban!)).status).toBe(202)
  })
  test('ispravan potpis Maca za Šabanovu grupu → 403 (bot je vezan uz svoje chatove)', () => {
    const { bk } = okolina()
    const r = bk.primi(pz(poruka({ chatId: CHAT_S }), PRIM.mac!))
    expect(r.status).toBe(403)
    expect(bk.primiZapis(pz({ izvor: 'mac', chatId: CHAT_S, tekst: 'x', telegramPorukaId: 3, ts: '' }, PRIM.mac!, '/zapis')).status).toBe(403)
  })
  test('stop s Maca: za Šabanovu grupu 403, za svoju 200', () => {
    const { bk } = okolina()
    expect(bk.primiStop(pz({ chatId: CHAT_S, by: 'x' }, PRIM.mac!, '/stop')).status).toBe(403)
    expect(bk.jeZaustavljen(CHAT_S)).toBe(false)
    expect(bk.primiStop(pz({ chatId: CHAT_M, by: 'Ana' }, PRIM.mac!, '/stop')).status).toBe(200)
  })
  test('stanje za drugog: Mac vidi samo zastavice svoje grupe', async () => {
    const { bk } = okolina()
    await bk.zaustavi(CHAT_S, 'Ivan', 'rucno', false)
    await bk.zaustavi(CHAT_M, 'Ivan', 'rucno', false)
    const g = (tajna: string): Zahtjev => ({ ip: '172.24.0.1', tijelo: '', potpis: potpisi(tajna, 'GET', `${PUT_RUTE}/stanje`, '', Math.floor(sada / 1000)) })
    const m = bk.stanjeZaDrugog(g(PRIM.mac!))
    expect(m.status).toBe(200)
    expect(Object.keys((m.tijelo as any).zastavice)).toEqual([CHAT_M])
    expect(Object.keys((bk.stanjeZaDrugog(g(PRIM.saban!)).tijelo as any).zastavice)).toEqual([CHAT_S])
  })
  test('dva bota s istom tajnom primanja (pogrešna konfiguracija) → nijedan se ne prima', () => {
    const ista = 'z'.repeat(48)
    const { bk } = okolina({ prim: { saban: ista, mac: ista } })
    expect(bk.primi(pz(poruka(), ista)).status).not.toBe(202)
    expect(bk.primi(pz(poruka({ izvor: 'saban', chatId: CHAT_S }), ista)).status).not.toBe(202)
  })
  test('bot bez svoje tajne primanja se ne prima, drugi i dalje radi', () => {
    const { bk } = okolina({ prim: { saban: PRIM.saban! } })
    expect(bk.primi(pz(poruka(), PRIM.mac!)).status).toBe(401)
    expect(bk.primi(pz(poruka({ izvor: 'saban', chatId: CHAT_S }), PRIM.saban!)).status).toBe(202)
  })
})

describe('TASK-5728 odlazno: svaki bot dobiva samo svoje, potpisano svojom tajnom', () => {
  test('zapis iz Šabanove grupe ide SAMO Šabanu, potpisan njegovom tajnom slanja', async () => {
    const { bk, pozivi } = okolina()
    expect(await bk.zapisi({ chatId: CHAT_S, tekst: 'interno za node-A', telegramPorukaId: '5' })).toBe('poslano')
    expect(pozivi.map(p => p.url)).toEqual([`http://10.0.0.2:17781${PUT_RUTE}/zapis`])
    expect(provjeriPotpis(pozivi[0]!.potpis, SLAN.saban!, 'POST', `${PUT_RUTE}/zapis`, pozivi[0]!.body, sada)).toBe('ok')
  })
  test('prijenos u Macovoj grupi ide Macu, potpisan Macovom tajnom (ne Šabanovom)', async () => {
    const { bk, pozivi } = okolina()
    expect(await bk.prenesi({ chatId: CHAT_M, tekst: '@macAI_bot @sabanAI_bot pitanje', telegramPorukaId: '9' })).toBe('poslano')
    expect(pozivi.map(p => p.url)).toEqual([`http://10.0.0.3:17781${PUT_RUTE}`])
    expect(provjeriPotpis(pozivi[0]!.potpis, SLAN.mac!, 'POST', PUT_RUTE, pozivi[0]!.body, sada)).toBe('ok')
    expect(provjeriPotpis(pozivi[0]!.potpis, SLAN.saban!, 'POST', PUT_RUTE, pozivi[0]!.body, sada)).toBe('neispravan')
  })
  test('stop u Macovoj grupi javlja se samo Macu', async () => {
    const { bk, pozivi } = okolina()
    await bk.zaustavi(CHAT_M, 'Ana', 'fraza')
    expect(pozivi.map(p => p.url)).toEqual([`http://10.0.0.3:17781${PUT_RUTE}/stop`])
  })
  test('bot bez tajne slanja ne dobiva ništa', async () => {
    const { bk, pozivi } = okolina({ slan: { saban: SLAN.saban! } })
    expect(await bk.zapisi({ chatId: CHAT_M, tekst: 'x', telegramPorukaId: '1' })).toBe('iskljuceno')
    expect(pozivi).toHaveLength(0)
  })
})

describe('TASK-5728 imena tajni po botu', () => {
  test('imeTajneZa: sufiks je ime bota velikim slovima', () => {
    expect(imeTajneZa(TAJNA_SLANJA, 'mac')).toBe('TM_BOT_KANAL_TAJNA_SLANJE_MAC')
    expect(imeTajneZa(TAJNA_PRIMANJA, 'node-a.2')).toBe('TM_BOT_KANAL_TAJNA_PRIMANJE_NODE_A_2')
  })
  test('tajnaZaBota: najprije tajna bota, zajednički par samo kad ga bot smije koristiti', () => {
    const env: Record<string, string> = { TM_BOT_KANAL_TAJNA_SLANJE: 'zajednicka', TM_BOT_KANAL_TAJNA_SLANJE_SABAN: 'sabanova' }
    const c = (ime: string) => env[ime]
    expect(tajnaZaBota(c, TAJNA_SLANJA, 'saban', true)).toBe('sabanova')
    expect(tajnaZaBota(c, TAJNA_SLANJA, 'mac', false)).toBeUndefined()
    expect(tajnaZaBota(c, TAJNA_SLANJA, 'mac', true)).toBe('zajednicka')
  })
  test('imenaTajniKanala: zajednički par + par po svakom drugom botu', () => {
    expect(imenaTajniKanala(['klaudio']).map(x => x.ime)).toEqual([
      'TM_BOT_KANAL_TAJNA_SLANJE', 'TM_BOT_KANAL_TAJNA_PRIMANJE',
      'TM_BOT_KANAL_TAJNA_SLANJE_KLAUDIO', 'TM_BOT_KANAL_TAJNA_PRIMANJE_KLAUDIO',
    ])
  })
  test('imena kanala nisu zabranjena (TM_* iznimka samo za njih) i prolaze dopustenaImena', () => {
    for (const x of imenaTajniKanala(['klaudio'])) expect(imeZabranjeno(x.ime)).toBe(false)
    expect(imeZabranjeno('TM_CREDENTIALS')).toBe(true)
    expect(imeZabranjeno('TM_BOT_KANAL_DRUGI')).toBe(true)
    const d = dopustenaImena({ moduli: imenaTajniKanala(['klaudio']) }).map(x => x.ime)
    expect(d).toContain('TM_BOT_KANAL_TAJNA_PRIMANJE_KLAUDIO')
  })
})

describe('TASK-5728 paket: Tajne čvora i kartica kanala', () => {
  let mapa: string
  let db: string
  beforeEach(() => {
    mapa = mkdtempSync(join(tmpdir(), 'bk5728-'))
    db = join(mapa, 'tasks.db')
    const d = new Database(db)
    setBotKanalPostavke(d, { drugi: [{ ime: 'klaudio', korisnickoIme: 'klaudioAI_bot', url: 'http://100.64.0.1:17781' }] }, 'test')
    d.close()
  })
  afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })

  test('stranica Tajne čvora nudi imena tajni kanala (vlasnik čvora ih upisuje sam)', () => {
    const imena = imenaTajniPloce([], db)
    const k = imena.filter(x => x.ime.startsWith('TM_BOT_KANAL_TAJNA_'))
    expect(k.map(x => x.ime)).toEqual([
      'TM_BOT_KANAL_TAJNA_SLANJE', 'TM_BOT_KANAL_TAJNA_PRIMANJE',
      'TM_BOT_KANAL_TAJNA_SLANJE_KLAUDIO', 'TM_BOT_KANAL_TAJNA_PRIMANJE_KLAUDIO',
    ])
    expect(k.every(x => x.izvor.startsWith('botKanal'))).toBe(true)
  })
  test('kartica kanala: stanje tajni po botu (bez vrijednosti)', () => {
    const v = 'x'.repeat(48)
    const r = botKanalGet(db, null, { TM_BOT_KANAL_TAJNA_PRIMANJE_KLAUDIO: v, TM_BOT_KANAL_TAJNA_SLANJE: 'y'.repeat(48) })
    const pb = (r.tijelo as any).tajna.poBotu
    expect(pb).toEqual([{ ime: 'klaudio', slanje: 'postavljena', primanje: 'postavljena', imeSlanja: 'TM_BOT_KANAL_TAJNA_SLANJE_KLAUDIO', imePrimanja: 'TM_BOT_KANAL_TAJNA_PRIMANJE_KLAUDIO' }])
    expect(JSON.stringify(r.tijelo)).not.toContain(v)
  })
})

// ── Malikov pregled (TASK-5728), uvjeti 1 i 2 ──────────────────────────────────────────────────
describe('TASK-5728 Malik: tajne kanala ne idu modelu; paket veže bota uz chatove', () => {
  test('okolinaRazgovora ne propušta TM_BOT_KANAL_TAJNA_* (ni zajednički par ni par po botu)', async () => {
    const { okolinaRazgovora } = await import('../src/razgovor/Ovlasti')
    const env = okolinaRazgovora({
      TM_BOT_KANAL_TAJNA_SLANJE: 'a'.repeat(48), TM_BOT_KANAL_TAJNA_PRIMANJE_KLAUDIO: 'b'.repeat(48),
      TM_NEKA_LOZINKA: 'c', TM_PORT: '17781',
    }, 'test')
    expect(Object.keys(env).filter(k => k.startsWith('TM_')).sort()).toEqual(['TM_PORT', 'TM_RAZGOVOR'])
  })
  test('postavke paketa: drugi[].chatovi se čuva; dva druga bota bez chatova se odbijaju', async () => {
    const { parseBotKanalPatch } = await import('../src/razgovor/BotKanalPostavke')
    const jedan = parseBotKanalPatch({ drugi: [{ ime: 'klaudio', korisnickoIme: 'klaudioAI_bot', url: 'http://10.0.0.1:17781', chatovi: [CHAT_M] }] })
    expect(jedan.ok && jedan.value.drugi![0]!.chatovi).toEqual([CHAT_M])
    const dva = parseBotKanalPatch({ drugi: [
      { ime: 'klaudio', korisnickoIme: 'klaudioAI_bot', url: 'http://10.0.0.1:17781' },
      { ime: 'saban', korisnickoIme: 'sabanAI_bot', url: 'http://10.0.0.2:17781', chatovi: [CHAT_S] },
    ] })
    expect(dva.ok).toBe(false)
    expect(parseBotKanalPatch({ drugi: [{ ime: 'klaudio', korisnickoIme: 'klaudioAI_bot', url: 'http://10.0.0.1:17781', chatovi: ['x'] }] }).ok).toBe(false)
  })
  test('postavke paketa iz baze: chatovi bota vrijede u vratima kanala', () => {
    const mapa = mkdtempSync(join(tmpdir(), 'bk5728b-'))
    try {
      const put = join(mapa, 'tasks.db')
      const d = new Database(put)
      setBotKanalPostavke(d, { ukljucen: true, chatovi: [CHAT_S, CHAT_M], adrese: ['10.0.0.1', '10.0.0.2'], drugi: [
        { ime: 'klaudio', korisnickoIme: 'klaudioAI_bot', url: 'http://10.0.0.1:17781', chatovi: [CHAT_M] },
        { ime: 'saban', korisnickoIme: 'sabanAI_bot', url: 'http://10.0.0.2:17781', chatovi: [CHAT_S] },
      ] }, 'test')
      const { getBotKanalPostavke } = require('../src/razgovor/BotKanalPostavke')
      const p = getBotKanalPostavke(d).postavke as BotKanalPostavke
      d.close()
      const bk = stvoriBotKanal({ ja: 'mac', postavke: () => ({ ...p, provjeraAdrese: false }), tajnaPrimanja: ime => PRIM[ime === 'klaudio' ? 'mac' : 'saban'], tajnaSlanja: ime => SLAN[ime === 'klaudio' ? 'mac' : 'saban'],
        spremiste: { citaj: praznoStanje, pisi: () => {} }, sat: () => sada })
      expect(bk.primi(pz(poruka({ izvor: 'klaudio', chatId: CHAT_S }), PRIM.mac!)).status).toBe(403)
      expect(bk.primi(pz(poruka({ izvor: 'klaudio' }), PRIM.mac!)).status).toBe(202)
    } finally { rmSync(mapa, { recursive: true, force: true }) }
  })
})
