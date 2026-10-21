/**
 * ADR-0003 — jezgra kanala bot↔bot (BotKanal.ts): ugovor rute (B1), odlazni prijenos (B4),
 * stop-fraza (B5), strop i skok (B7), vlastita poruka (B8), nastavak (B9), tajna (B11).
 * Bez mreže: drugi kraj je lažni `fetch`, vrijeme je ubrizgano.
 *
 * Autorica: Jelena (Engineer), TASK-5290.
 */

import { describe, expect, test } from 'bun:test'
import {
  BOT_KANAL_ZADANO, PUT_RUTE, ZAGLAVLJE_POTPISA, jeNastavakFraza, jeStopFraza, potpisi, praznoStanje, provjeriPotpis,
  provjeriTijelo, spominje, stvoriBotKanal,
  type BotKanalPostavke, type BotKanalStanje, type Zahtjev, type ZastavicaChata,
} from '../src/razgovor/BotKanal'

/** Tajna PRIMANJA ovog kraja (= tajna slanja drugog kraja) i tajna SLANJA ovog kraja (TASK-5299). */
const TAJNA = 'a'.repeat(48)
const TAJNA_SLANJA = 'c'.repeat(48)
const IP = '::ffff:10.0.0.2'
/** Sat testa: dijele ga jezgra (`sat`) i potpis zahtjeva, pa `pomakni` ne čini potpis zastarjelim. */
let sada = 0
/** Potpisan zahtjev drugog kraja za rutu `put` (TASK-5299): sirovo tijelo + potpis + adresa. */
function pz(raw: unknown, put = '', o: { tajna?: string; ip?: string; pomakS?: number } = {}): Zahtjev {
  const t = JSON.stringify(raw)
  const ts = Math.floor(sada / 1000) + (o.pomakS ?? 0)
  return { ip: o.ip ?? IP, tijelo: t, potpis: potpisi(o.tajna ?? TAJNA, 'POST', `${PUT_RUTE}${put}`, t, ts) }
}
const zStanje = (tajna = TAJNA): Zahtjev => ({ ip: IP, tijelo: '', potpis: potpisi(tajna, 'GET', `${PUT_RUTE}/stanje`, '', Math.floor(sada / 1000)) })
const CHAT = '-5112799687'
const VLASNIK = '100000001'
const DRUGA = '8872962604'

function okolina(o: Partial<BotKanalPostavke> = {}) {
  const postavke: BotKanalPostavke = {
    ...BOT_KANAL_ZADANO, ukljucen: true, chatovi: [CHAT], adrese: ['10.0.0.2'],
    drugi: [{ ime: 'klaudio', korisnickoIme: 'drugiAI_bot', url: 'http://10.0.0.2:17781' }],
    stopKorisnici: [VLASNIK, DRUGA], ...o,
  }
  let stanje: BotKanalStanje = praznoStanje()
  const povijest: { chatId: string; z: ZastavicaChata }[] = []
  const pozivi: { url: string; tijelo: any; potpis: string; authorization?: string; sirovo: string }[] = []
  const grupa: string[] = []
  const prekidi: string[] = []
  sada = Date.parse('2026-10-06T18:41:00Z')
  let fetchStatus = 202
  const bk = stvoriBotKanal({
    ja: 'saban',
    postavke: () => postavke,
    tajnaPrimanja: () => TAJNA, tajnaSlanja: () => TAJNA_SLANJA,
    spremiste: {
      citaj: () => JSON.parse(JSON.stringify(stanje)),
      pisi: (s, pz) => { stanje = JSON.parse(JSON.stringify(s)); if (pz) povijest.push(pz) },
    },
    javiUGrupu: (_c, t) => { grupa.push(t) },
    naStop: c => { prekidi.push(c) },
    sat: () => sada,
    ponoviMs: 0,
    uuid: () => 'lanac-1',
    fetchImpl: (async (url: string, init: any) => {
      pozivi.push({ url, tijelo: JSON.parse(init.body), potpis: init.headers[ZAGLAVLJE_POTPISA], authorization: init.headers.Authorization, sirovo: `${JSON.stringify(init.headers)}${init.body}` })
      if (fetchStatus === 0) throw new Error('ECONNREFUSED')
      return new Response('{}', { status: fetchStatus })
    }) as any,
  })
  return {
    bk, postavke, pozivi, grupa, prekidi, povijest,
    stanje: () => stanje,
    pomakni: (ms: number) => { sada += ms },
    fetchStatus: (s: number) => { fetchStatus = s },
  }
}

const tijelo = (o: Record<string, unknown> = {}) => ({
  izvor: 'klaudio', chatId: CHAT, tekst: 'Šabane, koliko je otvorenih zadataka?', telegramPorukaId: 501,
  lanacId: 'L1', skok: 1, izvornik: { id: VLASNIK, ime: 'Ivan' }, ts: '2026-10-06T18:41:00Z', ...o,
})

describe('B1 ugovor rute', () => {
  test('bez potpisa 401, potpis pogrešnom tajnom 401', () => {
    const { bk } = okolina()
    expect(bk.primi({ ip: IP, tijelo: JSON.stringify(tijelo()) }).status).toBe(401)
    expect(bk.primi(pz(tijelo(), '', { tajna: 'b'.repeat(48) })).status).toBe(401)
  })
  test('adresa izvan allowliste 403 (i s ispravnom tajnom)', () => {
    const { bk } = okolina()
    expect(bk.primi(pz(tijelo(), '', { ip: '10.0.0.99' })).status).toBe(403)
  })
  test('isključen kanal 403 bez obrade; nema tajne na stroju 403', () => {
    const { bk, postavke } = okolina()
    postavke.ukljucen = false
    expect(bk.primi(pz(tijelo())).status).toBe(403)
    const bez = stvoriBotKanal({ ja: 'saban', postavke: () => ({ ...postavke, ukljucen: true }), tajnaPrimanja: () => '', tajnaSlanja: () => TAJNA_SLANJA, spremiste: { citaj: praznoStanje, pisi: () => {} } })
    expect(bez.primi(pz(tijelo(), '', { tajna: '' })).status).toBe(403)
  })
  test('chat izvan popisa 403, izvor izvan popisa 403', () => {
    const { bk } = okolina()
    expect(bk.primi(pz(tijelo({ chatId: '-100' }))).status).toBe(403)
    expect(bk.primi(pz(tijelo({ izvor: 'netko' }))).status).toBe(403)
  })
  test('nepoznato polje 400, tekst > 4000 413, ispravno 202 s porukom', () => {
    const { bk } = okolina()
    const n = bk.primi(pz({ ...tijelo(), ovlasti: 'puno' }))
    expect(n.status).toBe(400)
    expect(String(n.tijelo.error)).toContain('ovlasti')
    expect(bk.primi(pz(tijelo({ tekst: 'x'.repeat(4001) }))).status).toBe(413)
    const ok = bk.primi(pz(tijelo()))
    expect(ok.status).toBe(202)
    expect(ok.poruka).toMatchObject({ izvor: 'klaudio', chatId: CHAT, telegramPorukaId: '501', lanacId: 'L1', skok: 1 })
  })
  test('provjeriTijelo: chatId broj se prima kao tekst; skok 0 odbijen', () => {
    expect(provjeriTijelo(tijelo({ chatId: -5112799687 })).ok).toBe(true)
    expect(provjeriTijelo(tijelo({ skok: 0 })).ok).toBe(false)
  })
})

describe('B4 odlazni prijenos', () => {
  test('odgovor sa @drugiAI_bot → 1 POST s tajnom, novi lanac skok 1, telegramPorukaId', async () => {
    const { bk, pozivi } = okolina()
    const r = await bk.prenesi({ chatId: CHAT, tekst: '@DrugiAI_bot koja je verzija CLI-ja?', telegramPorukaId: '777', izvornik: { id: VLASNIK, ime: 'Ivan' } })
    expect(r).toBe('poslano')
    expect(pozivi).toHaveLength(1)
    expect(pozivi[0]!.url).toBe('http://10.0.0.2:17781/api/razgovor/od-bota')
    expect(pozivi[0]!.authorization).toBeUndefined()
    expect(pozivi[0]!.potpis).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
    expect(pozivi[0]!.tijelo).toMatchObject({ izvor: 'saban', chatId: CHAT, telegramPorukaId: '777', lanacId: 'lanac-1', skok: 1, izvornik: { id: VLASNIK } })
  })
  test('nastavak lanca: isti lanacId, skok+1, izvornik iz lanca', async () => {
    const { bk, pozivi } = okolina()
    await bk.prenesi({ chatId: CHAT, tekst: 'evo @drugiAI_bot: 3', telegramPorukaId: '9', lanac: { izvor: 'klaudio', lanacId: 'L7', skok: 2, izvornik: { id: DRUGA, ime: 'Ana' } } })
    expect(pozivi[0]!.tijelo).toMatchObject({ lanacId: 'L7', skok: 3, izvornik: { id: DRUGA } })
  })
  test('bez spomena, chat izvan popisa, isključeno, zastavica → 0 POST-ova', async () => {
    const { bk, pozivi, postavke } = okolina()
    expect(await bk.prenesi({ chatId: CHAT, tekst: 'drugiAI_bot bez @', telegramPorukaId: '1' })).toBe('bez-spomena')
    expect(await bk.prenesi({ chatId: CHAT, tekst: '@drugiAI_botx', telegramPorukaId: '1' })).toBe('bez-spomena')
    expect(await bk.prenesi({ chatId: '-1', tekst: '@drugiAI_bot', telegramPorukaId: '1' })).toBe('iskljuceno')
    await bk.zaustavi(CHAT, 'Ivan', 'rucno', false)
    expect(await bk.prenesi({ chatId: CHAT, tekst: '@drugiAI_bot', telegramPorukaId: '1' })).toBe('zaustavljeno')
    postavke.ukljucen = false
    expect(await bk.prenesi({ chatId: CHAT, tekst: '@drugiAI_bot', telegramPorukaId: '1' })).toBe('iskljuceno')
    expect(pozivi).toHaveLength(0)
  })
  test('pad mreže: 2 pokušaja, 1 dojava u grupu u 10 min', async () => {
    const { bk, pozivi, grupa, fetchStatus, pomakni } = okolina()
    fetchStatus(0)
    expect(await bk.prenesi({ chatId: CHAT, tekst: '@drugiAI_bot a', telegramPorukaId: '1' })).toBe('pad')
    expect(pozivi).toHaveLength(2)
    pomakni(60_000)
    await bk.prenesi({ chatId: CHAT, tekst: '@drugiAI_bot b', telegramPorukaId: '2' })
    expect(grupa.filter(g => g.includes('nije dostupan'))).toHaveLength(1)
  })
  test('spominje: točan spomen, bez obzira na velika slova', () => {
    expect(spominje('pitaj @REGOC_saban_bot.', 'regoc_saban_bot')).toBe(true)
    expect(spominje('mail a@regoc_saban_bot', 'regoc_saban_bot')).toBe(false)
    expect(spominje('@regoc_saban_bot2', 'regoc_saban_bot')).toBe(false)
  })
})

describe('B5 stop-fraza', () => {
  const pogoci = ['Prekini komunikaciju', 'PREKINI KOMUNIKACIJU!', 'prekini komunikaciju', 'Ivane, prekini komunikaciju', 'ajde prekini   komunikaciju.']
  for (const f of pogoci) {
    test(`„${f}" od stop-korisnika: zastavica, 1 stop drugom kraju, 1 poruka u grupu`, async () => {
      const { bk, pozivi, grupa, prekidi } = okolina()
      expect(await bk.ljudska({ chatId: CHAT, posiljateljId: DRUGA, posiljateljIme: 'Ana', tekst: f })).toBe('stop')
      expect(bk.jeZaustavljen(CHAT)).toBe(true)
      expect(pozivi).toHaveLength(1)
      expect(pozivi[0]!.url).toBe('http://10.0.0.2:17781/api/razgovor/od-bota/stop')
      expect(pozivi[0]!.tijelo).toMatchObject({ chatId: CHAT, by: 'Ana', razlog: 'fraza' })
      expect(grupa).toHaveLength(1)
      expect(grupa[0]).toContain('⛔')
      expect(prekidi).toEqual([CHAT])
    })
  }
  test('dijakritika i „prekini komunikacijU" bez kvačica', () => {
    expect(jeStopFraza('Prèkini komunikaciju')).toBe(true)
    expect(jeStopFraza('prekinite komunikaciju')).toBe(false)
    expect(jeNastavakFraza('Nastavi komunikaciju!')).toBe(true)
  })
  test('korisnik izvan popisa, isto IME a drugi id → ništa', async () => {
    const { bk, pozivi, grupa } = okolina()
    expect(await bk.ljudska({ chatId: CHAT, posiljateljId: '111', posiljateljIme: 'Netko', tekst: 'prekini komunikaciju' })).toBe(null)
    expect(await bk.ljudska({ chatId: CHAT, posiljateljId: '222', posiljateljIme: 'Ivan', tekst: 'prekini komunikaciju' })).toBe(null)
    expect(bk.jeZaustavljen(CHAT)).toBe(false)
    expect(pozivi).toHaveLength(0)
    expect(grupa).toHaveLength(0)
  })
  test('bot kroz rutu: tekst „prekini komunikaciju" ne mijenja zastavicu', () => {
    const { bk } = okolina()
    expect(bk.primi(pz(tijelo({ tekst: 'prekini komunikaciju' }))).status).toBe(202)
    expect(bk.jeZaustavljen(CHAT)).toBe(false)
  })
  test('prazan popis stop-korisnika = dopušteni koji su brojčani', async () => {
    const postavke = { ...BOT_KANAL_ZADANO, ukljucen: true, chatovi: [CHAT] }
    let s = praznoStanje()
    const bk = stvoriBotKanal({
      ja: 'saban', postavke: () => postavke, tajnaPrimanja: () => TAJNA, tajnaSlanja: () => TAJNA_SLANJA,
      spremiste: { citaj: () => s, pisi: x => { s = x } }, zadaniStopKorisnici: () => [VLASNIK, 'ivan'],
    })
    expect(await bk.ljudska({ chatId: CHAT, posiljateljId: VLASNIK, posiljateljIme: 'Ivan', tekst: 'prekini komunikaciju' })).toBe('stop')
  })
  test('zastavica podignuta: ruta 409 zaustavljeno', async () => {
    const { bk } = okolina()
    await bk.ljudska({ chatId: CHAT, posiljateljId: VLASNIK, posiljateljIme: 'Ivan', tekst: 'prekini komunikaciju' })
    const r = bk.primi(pz(tijelo()))
    expect(r.status).toBe(409)
    expect(r.tijelo.razlog).toBe('zaustavljeno')
  })
  test('stop od drugog kraja (ruta /stop) diže zastavicu i ne vraća stop natrag', async () => {
    const { bk, pozivi, prekidi } = okolina()
    expect(bk.primiStop(pz({ chatId: CHAT, by: 'Ana', razlog: 'fraza' }, '/stop')).status).toBe(200)
    await Bun.sleep(0)
    expect(bk.jeZaustavljen(CHAT)).toBe(true)
    expect(prekidi).toEqual([CHAT])
    expect(pozivi).toHaveLength(0)
    expect(bk.primiStop({ ip: IP, tijelo: JSON.stringify({ chatId: CHAT }) }).status).toBe(401)
  })
})

describe('B7 strop i skok', () => {
  test('6 prijenosa u prozoru bez ljudske poruke → 7. odbijen 409 strop, zastavica strop, 1 poruka', async () => {
    const { bk, grupa, stanje } = okolina()
    for (let i = 0; i < 3; i++) {
      expect(bk.primi(pz(tijelo({ telegramPorukaId: 100 + i, lanacId: `L${100 + i}` }))).status).toBe(202)
      expect(await bk.prenesi({ chatId: CHAT, tekst: '@drugiAI_bot', telegramPorukaId: String(200 + i) })).toBe('poslano')
    }
    const r = bk.primi(pz(tijelo({ telegramPorukaId: 300, lanacId: `L${300}` })))
    expect(r.status).toBe(409)
    expect(r.tijelo.razlog).toBe('strop')
    await Bun.sleep(0)
    expect(stanje().zastavice[CHAT]).toMatchObject({ zaustavljen: true, razlog: 'strop' })
    expect(grupa.filter(g => g.includes('strop'))).toHaveLength(1)
  })
  test('poruka stop-korisnika između prijenosa nulira brojilo', async () => {
    const { bk } = okolina()
    for (let i = 0; i < 6; i++) expect(bk.primi(pz(tijelo({ telegramPorukaId: i, lanacId: `L${i}` }))).status).toBe(202)
    await bk.ljudska({ chatId: CHAT, posiljateljId: VLASNIK, posiljateljIme: 'Ivan', tekst: 'hvala' })
    expect(bk.primi(pz(tijelo({ telegramPorukaId: 50, lanacId: `L${50}` }))).status).toBe(202)
  })
  test('TASK-5291 N5: poruka trećeg člana grupe NE nulira brojilo (nije nadzor)', async () => {
    const { bk } = okolina()
    for (let i = 0; i < 6; i++) expect(bk.primi(pz(tijelo({ telegramPorukaId: i, lanacId: `L${i}` }))).status).toBe(202)
    await bk.ljudska({ chatId: CHAT, posiljateljId: '111', posiljateljIme: 'Netko', tekst: 'hvala' })
    expect(bk.primi(pz(tijelo({ telegramPorukaId: 50, lanacId: `L${50}` }))).status).toBe(409)
  })
  test('izvan prozora se ne broji', () => {
    const { bk, pomakni } = okolina()
    for (let i = 0; i < 6; i++) bk.primi(pz(tijelo({ telegramPorukaId: i, lanacId: `L${i}` })))
    pomakni(11 * 60_000)
    expect(bk.primi(pz(tijelo({ telegramPorukaId: 60, lanacId: `L${60}` }))).status).toBe(202)
  })
  test('skok 7 uz strop 6 → 409 skok i uz prazno brojilo (restart)', () => {
    const { bk } = okolina()
    const r = bk.primi(pz(tijelo({ skok: 7 })))
    expect(r.status).toBe(409)
    expect(r.tijelo.razlog).toBe('skok')
  })
  test('odlazno: skok bi prešao strop → ne šalje se, zastavica strop', async () => {
    const { bk, pozivi } = okolina()
    expect(await bk.prenesi({ chatId: CHAT, tekst: '@drugiAI_bot', telegramPorukaId: '1', lanac: { izvor: 'klaudio', lanacId: 'L', skok: 6, izvornik: null } })).toBe('strop')
    expect(pozivi.filter(p => p.url.endsWith('/od-bota'))).toHaveLength(0)
    expect(bk.jeZaustavljen(CHAT)).toBe(true)
  })
})

describe('B8 vlastita poruka', () => {
  test('izvor = vlastito ime → 409 vlastita', () => {
    const { bk } = okolina()
    const r = bk.primi(pz(tijelo({ izvor: 'saban' })))
    expect(r.status).toBe(409)
    expect(r.tijelo.razlog).toBe('vlastita')
  })
  test('vlastiti telegramPorukaId (odjek) → 409 vlastita', async () => {
    const { bk } = okolina()
    await bk.prenesi({ chatId: CHAT, tekst: '@drugiAI_bot pitanje', telegramPorukaId: '4242' })
    const r = bk.primi(pz(tijelo({ telegramPorukaId: 4242, lanacId: `L${4242}` })))
    expect(r.status).toBe(409)
    expect(r.tijelo.razlog).toBe('vlastita')
  })
})

describe('B9 nastavak', () => {
  test('„Nastavi komunikaciju" od stop-korisnika spušta zastavicu, šalje /nastavi, nulira brojilo; povijest', async () => {
    const { bk, pozivi, povijest, stanje } = okolina()
    for (let i = 0; i < 6; i++) bk.primi(pz(tijelo({ telegramPorukaId: i, lanacId: `L${i}` })))
    await bk.ljudska({ chatId: CHAT, posiljateljId: VLASNIK, posiljateljIme: 'Ivan', tekst: 'prekini komunikaciju' })
    expect(await bk.ljudska({ chatId: CHAT, posiljateljId: VLASNIK, posiljateljIme: 'Ivan', tekst: 'Nastavi komunikaciju' })).toBe('nastavak')
    expect(bk.jeZaustavljen(CHAT)).toBe(false)
    expect(pozivi.map(p => p.url.split('/').pop())).toEqual(['stop', 'nastavi'])
    expect(stanje().brojilo[CHAT]).toBeUndefined()
    expect(povijest.map(p => p.z.zaustavljen)).toEqual([true, false])
  })
  test('nastavak od nedopuštenog ili od bota kroz rutu ne spušta zastavicu', async () => {
    const { bk } = okolina()
    await bk.zaustavi(CHAT, 'Ivan', 'fraza', false)
    await bk.ljudska({ chatId: CHAT, posiljateljId: '111', posiljateljIme: 'X', tekst: 'nastavi komunikaciju' })
    expect(bk.jeZaustavljen(CHAT)).toBe(true)
    expect(bk.primi(pz(tijelo({ tekst: 'nastavi komunikaciju' }))).status).toBe(409)
    expect(bk.jeZaustavljen(CHAT)).toBe(true)
  })
  test('nema isteka: zastavica ostaje i nakon 24 h', async () => {
    const { bk, pomakni } = okolina()
    await bk.zaustavi(CHAT, 'Ivan', 'fraza', false)
    pomakni(25 * 3600_000)
    expect(bk.jeZaustavljen(CHAT)).toBe(true)
  })
})

describe('B11 tajna', () => {
  test('stanje za drugog ne nosi tajnu i traži tajnu', () => {
    const { bk } = okolina()
    expect(bk.stanjeZaDrugog({ ip: IP }).status).toBe(401)
    const r = bk.stanjeZaDrugog(zStanje())
    expect(r.status).toBe(200)
    expect(JSON.stringify(r.tijelo)).not.toContain(TAJNA)
  })
})

// ─── Postavke u bazi (B1 kartica, B9 povijest, B11) i ruta → razgovor ─────────

import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BOT_KANAL_STANJE_KLJUC, getBotKanalPostavke, parseBotKanalPatch, setBotKanalPostavke, spremisteUBazi,
} from '../src/razgovor/BotKanalPostavke'
import { botKanalGet, botKanalPut, botKanalRucno, imeUKanalu, odBotaPost, odBotaZapis, type RazgovorSloj } from '../src/razgovor/RazgovorPloca'
import type { UlaznaPoruka } from '../src/razgovor/Kanal'

describe('BotKanalPostavke', () => {
  test('zadano isključeno; zakrpa se upisuje uz povijest; nepoznato i puno odbijeni', () => {
    const m = mkdtempSync(join(tmpdir(), 'tm-bk-db-'))
    try {
      const db = new Database(join(m, 't.db'))
      expect(getBotKanalPostavke(db).postavke.ukljucen).toBe(false)
      setBotKanalPostavke(db, {
        ukljucen: true, chatovi: [CHAT], adrese: ['10.0.0.2'], stopKorisnici: [VLASNIK, DRUGA],
        drugi: [{ ime: 'klaudio', korisnickoIme: '@drugiAI_bot', url: 'http://10.0.0.2:17781/' }],
      }, 'ploca')
      const p = getBotKanalPostavke(db).postavke
      expect(p).toMatchObject({ ukljucen: true, chatovi: [CHAT], strop: 6, ovlasti: 'citanje' })
      expect(p.drugi[0]).toEqual({ ime: 'klaudio', korisnickoIme: 'drugiAI_bot', url: 'http://10.0.0.2:17781' })
      const n = (db.query(`SELECT COUNT(*) n FROM settings_history WHERE key LIKE 'razgovor.botKanal.%'`).get() as any).n
      expect(n).toBe(5)
      expect(parseBotKanalPatch({ ovlasti: 'puno' }).ok).toBe(false)
      expect(parseBotKanalPatch({ token: 'x' }).ok).toBe(false)
      expect(parseBotKanalPatch({ stopKorisnici: ['ivan'] }).ok).toBe(false)
      expect(parseBotKanalPatch({ strop: 21 }).ok).toBe(false)
      db.close()
    } finally { rmSync(m, { recursive: true, force: true }) }
  })
  test('B9: svaka promjena zastavice = 1 redak u settings_history; preživi novo spremište (restart)', async () => {
    const m = mkdtempSync(join(tmpdir(), 'tm-bk-db-'))
    try {
      const put = join(m, 't.db')
      const postavke = { ...BOT_KANAL_ZADANO, ukljucen: true, chatovi: [CHAT], stopKorisnici: [VLASNIK] }
      const bk = stvoriBotKanal({ ja: 'saban', postavke: () => postavke, tajnaPrimanja: () => TAJNA, tajnaSlanja: () => TAJNA_SLANJA, spremiste: spremisteUBazi(put) })
      await bk.ljudska({ chatId: CHAT, posiljateljId: VLASNIK, posiljateljIme: 'Ivan', tekst: 'prekini komunikaciju' })
      const nakon = stvoriBotKanal({ ja: 'saban', postavke: () => postavke, tajnaPrimanja: () => TAJNA, tajnaSlanja: () => TAJNA_SLANJA, spremiste: spremisteUBazi(put) })
      expect(nakon.jeZaustavljen(CHAT)).toBe(true)
      await nakon.ljudska({ chatId: CHAT, posiljateljId: VLASNIK, posiljateljIme: 'Ivan', tekst: 'nastavi komunikaciju' })
      const db = new Database(put)
      const redovi = db.query(`SELECT new_value, source FROM settings_history WHERE key = ?`).all(BOT_KANAL_STANJE_KLJUC) as any[]
      expect(redovi).toHaveLength(2)
      expect(redovi.map(r => r.source)).toEqual(['bot-kanal:fraza', 'bot-kanal:nastavak'])
      expect(JSON.stringify(db.query(`SELECT * FROM settings`).all())).not.toContain(TAJNA)
      db.close()
    } finally { rmSync(m, { recursive: true, force: true }) }
  })
  test('B11: kartica kaže samo postavljena/nedostaje', () => {
    const m = mkdtempSync(join(tmpdir(), 'tm-bk-db-'))
    try {
      const put = join(m, 't.db')
      new Database(put).close()
      const r = botKanalGet(put, null, { TM_BOT_KANAL_TAJNA_PRIMANJE: TAJNA })
      expect((r.tijelo as any).tajna).toEqual({ slanje: 'nedostaje', primanje: 'postavljena' })
      expect(JSON.stringify(r.tijelo)).not.toContain(TAJNA)
    } finally { rmSync(m, { recursive: true, force: true }) }
  })
  test('imeUKanalu: „Šaban" → saban', () => {
    expect(imeUKanalu('Šaban')).toBe('saban')
    expect(imeUKanalu('')).toBe('bot')
  })
})

describe('ruta → razgovor (B1 202, B3 bez ingesta)', () => {
  function sloj() {
    const { bk } = okolina()
    const primljeno: UlaznaPoruka[] = []
    const s = {
      botKanal: bk,
      jezgra: { primi: (p: UlaznaPoruka) => { primljeno.push(p) } },
      ulaz: { postavke: () => ({ ukljucen: true, ime: 'Šaban' }), aktivniKanal: { ime: 'telegram' } },
    } as unknown as RazgovorSloj
    return { s, primljeno }
  }
  test('202 → točno jedan primi s izvor bot i lancem; reply na vidljivu poruku', () => {
    const { s, primljeno } = sloj()
    const r = odBotaPost(s, pz(tijelo()))
    expect(r.status).toBe(202)
    expect(primljeno).toHaveLength(1)
    expect(primljeno[0]).toMatchObject({
      izvor: 'bot', posiljateljJeBot: true, posiljateljId: 'bot:klaudio', porukaId: '501', chatId: CHAT,
      lanac: { izvor: 'klaudio', lanacId: 'L1', skok: 1 },
    })
  })
  test('401/409 → 0 poziva razgovora', () => {
    const { s, primljeno } = sloj()
    expect(odBotaPost(s, { ip: IP, tijelo: JSON.stringify(tijelo()) }).status).toBe(401)
    expect(odBotaPost(s, pz(tijelo({ izvor: 'saban' }))).status).toBe(409)
    expect(primljeno).toHaveLength(0)
  })
  test('razgovor ne radi → 503', () => {
    const { s } = sloj()
    ;(s.ulaz as any).aktivniKanal = undefined
    expect(odBotaPost(s, pz(tijelo())).status).toBe(503)
  })
})

describe('TASK-5291 sigurnosni pregled', () => {
  test('N2: /od-bota/nastavi s drugog kraja (valjana tajna) NE skida stop', async () => {
    const { bk, povijest } = okolina()
    await bk.ljudska({ chatId: CHAT, posiljateljId: VLASNIK, posiljateljIme: 'Ivan', tekst: 'Prekini komunikaciju' })
    const r = bk.primiNastavak(pz({ chatId: CHAT, by: 'drugi kraj' }, '/nastavi'))
    expect(r.status).toBe(200)
    expect(r.tijelo.zaustavljen).toBe(true)
    await Promise.resolve()
    expect(bk.jeZaustavljen(CHAT)).toBe(true)
    expect(povijest.map(p => p.z.zaustavljen)).toEqual([true])
    expect(bk.primi(pz(tijelo({ telegramPorukaId: 77, lanacId: `L${77}` }))).status).toBe(409)
  })
  test('N2: /od-bota/stop s drugog kraja i dalje zaustavlja (smjer sigurnosti)', async () => {
    const { bk } = okolina()
    expect(bk.primiStop(pz({ chatId: CHAT, by: 'drugi kraj' }, '/stop')).status).toBe(200)
    await Promise.resolve()
    expect(bk.jeZaustavljen(CHAT)).toBe(true)
  })
  test('N3: host adrese ploče izvan popisa adresa → tajna ne ide nikamo (prijenos i stop)', async () => {
    const { bk, pozivi, postavke } = okolina()
    postavke.drugi = [{ ime: 'klaudio', korisnickoIme: 'drugiAI_bot', url: 'http://napadac.example:8080' }]
    expect(await bk.prenesi({ chatId: CHAT, tekst: '@drugiAI_bot pitanje', telegramPorukaId: '9' })).toBe('pad')
    await bk.zaustavi(CHAT, 'Ivan', 'rucno')
    expect(pozivi).toEqual([])
  })
})

describe('TASK-5291 N1b: Config rute s adrese drugog bota', () => {
  test('PUT postavki i „nastavi" s adrese drugog kraja → 403; „zaustavi" prolazi; s druge adrese PUT radi', async () => {
    const m = mkdtempSync(join(tmpdir(), 'tm-bk-db-'))
    try {
      const put = join(m, 't.db')
      const db = new Database(put)
      setBotKanalPostavke(db, {
        ukljucen: true, chatovi: [CHAT], adrese: ['10.0.0.2'], stopKorisnici: [VLASNIK],
        drugi: [{ ime: 'klaudio', korisnickoIme: 'drugiAI_bot', url: 'http://10.0.0.2:17781' }],
      }, 'ploca')
      db.close()
      const postavke = { ...BOT_KANAL_ZADANO, ukljucen: true, chatovi: [CHAT], stopKorisnici: [VLASNIK] }
      const bk = stvoriBotKanal({ ja: 'saban', postavke: () => postavke, tajnaPrimanja: () => TAJNA, tajnaSlanja: () => TAJNA_SLANJA, spremiste: spremisteUBazi(put) })
      const sloj = { botKanal: bk } as unknown as RazgovorSloj
      expect(botKanalPut(put, { stopKorisnici: [] }, '::ffff:10.0.0.2').status).toBe(403)
      expect(botKanalPut(put, { ukljucen: true }, '10.0.0.2').status).toBe(403)
      expect((await botKanalRucno(sloj, { chatId: CHAT, radnja: 'zaustavi' }, '10.0.0.2', put)).status).toBe(200)
      expect(bk.jeZaustavljen(CHAT)).toBe(true)
      expect((await botKanalRucno(sloj, { chatId: CHAT, radnja: 'nastavi' }, '10.0.0.2', put)).status).toBe(403)
      expect(bk.jeZaustavljen(CHAT)).toBe(true)
      expect((await botKanalRucno(sloj, { chatId: CHAT, radnja: 'nastavi' }, '192.168.1.50', put)).status).toBe(200)
      expect(bk.jeZaustavljen(CHAT)).toBe(false)
      expect(botKanalPut(put, { strop: 5 }, '192.168.1.50').status).toBe(200)
    } finally { rmSync(m, { recursive: true, force: true }) }
  })
  test('N3: kartica upozorava kad host adrese ploče nije u popisu adresa', () => {
    const m = mkdtempSync(join(tmpdir(), 'tm-bk-db-'))
    try {
      const db = new Database(join(m, 't.db'))
      setBotKanalPostavke(db, { adrese: ['10.0.0.2'], drugi: [{ ime: 'klaudio', korisnickoIme: 'drugiAI_bot', url: 'http://10.9.9.9:17781' }] }, 'x')
      expect(getBotKanalPostavke(db).upozorenja.join(' ')).toContain('nije u popisu adresa')
      db.close()
    } finally { rmSync(m, { recursive: true, force: true }) }
  })
})

// ─── TASK-5299: HMAC potpis umjesto tajne na žici (ADR-0003 §13 (a)) ─────────

describe('TASK-5299 HMAC potpis', () => {
  test('potpis: HMAC-SHA256 nad (ts, metoda, put, tijelo); svaka promjena ga ruši', () => {
    const t0 = 1_791_330_000
    const h = potpisi(TAJNA, 'POST', '/api/razgovor/od-bota', '{"a":1}', t0)
    expect(h).toMatch(/^t=1791330000,v1=[0-9a-f]{64}$/)
    // Neovisno izračunat HMAC (node:crypto) — format poruke je ugovor dva kraja.
    const { createHmac } = require('node:crypto')
    const v1 = createHmac('sha256', TAJNA).update(`${t0}\nPOST\n/api/razgovor/od-bota\n{"a":1}`).digest('hex')
    expect(h).toBe(`t=${t0},v1=${v1}`)
    const ok = (o: Partial<{ metoda: string; put: string; tijelo: string; tajna: string; sadaS: number }> = {}) =>
      provjeriPotpis(h, o.tajna ?? TAJNA, o.metoda ?? 'POST', o.put ?? '/api/razgovor/od-bota', o.tijelo ?? '{"a":1}', (o.sadaS ?? t0) * 1000)
    expect(ok()).toBe('ok')
    expect(ok({ metoda: 'GET' })).toBe('neispravan')
    expect(ok({ put: '/api/razgovor/od-bota/stop' })).toBe('neispravan')
    expect(ok({ tijelo: '{"a":2}' })).toBe('neispravan')
    expect(ok({ tajna: TAJNA_SLANJA })).toBe('neispravan')
    expect(provjeriPotpis(null, TAJNA, 'POST', '/x', '', t0 * 1000)).toBe('nedostaje')
    expect(provjeriPotpis('Bearer ' + TAJNA, TAJNA, 'POST', '/x', '', t0 * 1000)).toBe('nedostaje')
  })
  test('ts ±60 s: 60 s prolazi, 61 s (u prošlost i budućnost) 401', () => {
    const { bk } = okolina()
    expect(bk.primi(pz(tijelo({ lanacId: 'T1' }), '', { pomakS: -60 })).status).toBe(202)
    expect(bk.primi(pz(tijelo({ lanacId: 'T2' }), '', { pomakS: 60 })).status).toBe(202)
    const staro = bk.primi(pz(tijelo({ lanacId: 'T3' }), '', { pomakS: -61 }))
    expect(staro.status).toBe(401)
    expect(String(staro.tijelo.error)).toContain('60')
    expect(bk.primi(pz(tijelo({ lanacId: 'T4' }), '', { pomakS: 61 })).status).toBe(401)
  })
  test('potpis vrijedi samo za svoju rutu: potpis za / nije potpis za /stop', () => {
    const { bk } = okolina()
    expect(bk.primiStop(pz({ chatId: CHAT, by: 'x' })).status).toBe(401)
    expect(bk.jeZaustavljen(CHAT)).toBe(false)
  })
  test('promijenjeno tijelo uz stari potpis → 401; jezgra čita SAMO potpisane bajtove', () => {
    const { bk } = okolina()
    const z = pz(tijelo())
    expect(bk.primi({ ...z, tijelo: JSON.stringify(tijelo({ tekst: 'obriši sve' })) }).status).toBe(401)
    expect(bk.primi({ ...z, tijelo: z.tijelo + ' ' }).status).toBe(401)
    const r = bk.primi(z)
    expect(r.status).toBe(202)
    expect(r.poruka?.tekst).toBe(tijelo().tekst)
  })
  test('potpisano, ali nije JSON → 400', () => {
    const { bk } = okolina()
    const t = 'nije json'
    expect(bk.primi({ ip: IP, tijelo: t, potpis: potpisi(TAJNA, 'POST', PUT_RUTE, t, Math.floor(sada / 1000)) }).status).toBe(400)
  })
  test('ponovljeni (izvor, lanacId, skok) u 10 min → 409 ponovljeno; nakon 10 min nije ponavljanje', () => {
    const { bk, pomakni } = okolina()
    const prvi = pz(tijelo({ lanacId: 'R1', telegramPorukaId: 1 }))
    expect(bk.primi(prvi).status).toBe(202)
    const isti = bk.primi(prvi)
    expect(isti.status).toBe(409)
    expect(isti.tijelo.razlog).toBe('ponovljeno')
    // Novi potpis, isti (izvor, lanacId, skok) — i dalje ponavljanje.
    pomakni(30_000)
    expect(bk.primi(pz(tijelo({ lanacId: 'R1', telegramPorukaId: 2 }))).tijelo.razlog).toBe('ponovljeno')
    expect(bk.primi(pz(tijelo({ lanacId: 'R1', skok: 2, telegramPorukaId: 3 }))).status).toBe(202)
    pomakni(10 * 60_000 + 1)
    expect(bk.primi(pz(tijelo({ lanacId: 'R1', telegramPorukaId: 4 }))).status).toBe(202)
  })
  test('tajna nikad na žici: odlazni prijenos i stop nose samo potpis, ne tajnu ni Authorization', async () => {
    const { bk, pozivi } = okolina()
    expect(await bk.prenesi({ chatId: CHAT, tekst: '@drugiAI_bot verzija?', telegramPorukaId: '7' })).toBe('poslano')
    await bk.zaustavi(CHAT, 'Ivan', 'rucno')
    expect(pozivi).toHaveLength(2)
    for (const p of pozivi) {
      expect(p.authorization).toBeUndefined()
      expect(p.sirovo).not.toContain(TAJNA)
      expect(p.sirovo).not.toContain(TAJNA_SLANJA)
    }
    // Potpisano tajnom SLANJA, nad točno onim putem i tijelom koje je otišlo.
    const tijeloStopa = JSON.stringify(pozivi[1]!.tijelo)
    expect(provjeriPotpis(pozivi[1]!.potpis, TAJNA_SLANJA, 'POST', `${PUT_RUTE}/stop`, tijeloStopa, sada)).toBe('ok')
    expect(provjeriPotpis(pozivi[1]!.potpis, TAJNA, 'POST', `${PUT_RUTE}/stop`, tijeloStopa, sada)).toBe('neispravan')
  })
  test('po jedna tajna po smjeru: poruka potpisana mojom tajnom slanja (odraz) → 401; iste tajne → 403', () => {
    const { bk } = okolina()
    expect(bk.primi(pz(tijelo(), '', { tajna: TAJNA_SLANJA })).status).toBe(401)
    const postavke = { ...BOT_KANAL_ZADANO, ukljucen: true, chatovi: [CHAT], adrese: ['10.0.0.2'],
      drugi: [{ ime: 'klaudio', korisnickoIme: 'drugiAI_bot', url: 'http://10.0.0.2:17781' }] }
    const ista = stvoriBotKanal({ ja: 'saban', postavke: () => postavke, tajnaPrimanja: () => TAJNA, tajnaSlanja: () => TAJNA,
      spremiste: { citaj: praznoStanje, pisi: () => {} }, sat: () => sada })
    const r = ista.primi(pz(tijelo()))
    expect(r.status).toBe(403)
    expect(String(r.tijelo.error)).toContain('smjer')
  })
  test('prekratka tajna (< 32 znaka) = nije postavljena', () => {
    const postavke = { ...BOT_KANAL_ZADANO, ukljucen: true, chatovi: [CHAT], adrese: ['10.0.0.2'],
      drugi: [{ ime: 'klaudio', korisnickoIme: 'drugiAI_bot', url: 'http://10.0.0.2:17781' }] }
    const kratka = stvoriBotKanal({ ja: 'saban', postavke: () => postavke, tajnaPrimanja: () => 'kratko', tajnaSlanja: () => TAJNA_SLANJA,
      spremiste: { citaj: praznoStanje, pisi: () => {} }, sat: () => sada })
    expect(kratka.primi(pz(tijelo(), '', { tajna: 'kratko' })).status).toBe(403)
  })
  test('provjeraAdrese=false (glavna ploča iza docker-proxyja): adresa se ne gleda, potpis i dalje obavezan', () => {
    const { bk, postavke } = okolina()
    postavke.provjeraAdrese = false
    expect(bk.primi(pz(tijelo({ lanacId: 'D1' }), '', { ip: '172.24.0.1' })).status).toBe(202)
    expect(bk.primi({ ip: '172.24.0.1', tijelo: JSON.stringify(tijelo({ lanacId: 'D2' })) }).status).toBe(401)
    expect(bk.primi(pz(tijelo({ lanacId: 'D3' }), '', { ip: '172.24.0.1', tajna: 'b'.repeat(48) })).status).toBe(401)
    // Tajna/potpis i dalje idu samo hostu iz `adrese` (N3) — `adrese` ostaje popis drugog kraja.
    postavke.provjeraAdrese = true
    expect(bk.primi(pz(tijelo({ lanacId: 'D4' }), '', { ip: '172.24.0.1' })).status).toBe(403)
  })
  test('stanje za drugog: GET potpisan za /stanje; potpis za POST / ne vrijedi', () => {
    const { bk } = okolina()
    expect(bk.stanjeZaDrugog(zStanje()).status).toBe(200)
    expect(bk.stanjeZaDrugog(zStanje(TAJNA_SLANJA)).status).toBe(401)
    expect(bk.stanjeZaDrugog(pz({})).status).toBe(401)
  })
})

// ── TASK-5394: zapis-samo — odgovor drugog bota u grupi ide u zapis/konzolu ovog čvora ──────────
// Telegram botovima ne dostavlja poruke drugih botova, pa node-A Klaudijeve odgovore ne vidi.
// Ruta `/od-bota/zapis` ih prima kao ZAPIS: nikad ne pokreće model, ne broji se u strop.
describe('TASK-5394 zapis drugog bota (/od-bota/zapis)', () => {
  const zapis = (o: Record<string, unknown> = {}) => ({
    izvor: 'klaudio', chatId: CHAT, tekst: 'Odgovor Klaudija vlasniku', telegramPorukaId: 777, ts: '2026-10-09T08:00:00Z', ...o,
  })
  test('potpisan za /zapis → 202 sa zapisom; brojilo stropa se ne mijenja', () => {
    const { bk, stanje } = okolina()
    const r = bk.primiZapis(pz(zapis(), '/zapis'))
    expect(r.status).toBe(202)
    expect(r.zapis).toEqual({ izvor: 'klaudio', chatId: CHAT, tekst: 'Odgovor Klaudija vlasniku', telegramPorukaId: '777', ts: '2026-10-09T08:00:00Z' })
    expect(stanje().brojilo[CHAT] ?? []).toHaveLength(0)
  })
  test('bez potpisa 401; potpis za / (prijenos) ne vrijedi za /zapis; chat/izvor izvan popisa 403; vlastiti 409', () => {
    const { bk } = okolina()
    expect(bk.primiZapis({ ip: IP, tijelo: JSON.stringify(zapis()) }).status).toBe(401)
    expect(bk.primiZapis(pz(zapis(), '')).status).toBe(401)
    expect(bk.primiZapis(pz(zapis({ chatId: '-1' }), '/zapis')).status).toBe(403)
    expect(bk.primiZapis(pz(zapis({ izvor: 'netko' }), '/zapis')).status).toBe(403)
    expect(bk.primiZapis(pz(zapis({ izvor: 'saban' }), '/zapis')).status).toBe(409)
  })
  test('nepoznato polje 400, prazan tekst 400, predug 413; ponovljena poruka 409', () => {
    const { bk } = okolina()
    expect(bk.primiZapis(pz(zapis({ lanacId: 'L1' }), '/zapis')).status).toBe(400)
    expect(bk.primiZapis(pz(zapis({ tekst: ' ' }), '/zapis')).status).toBe(400)
    expect(bk.primiZapis(pz(zapis({ tekst: 'x'.repeat(4001) }), '/zapis')).status).toBe(413)
    expect(bk.primiZapis(pz(zapis({ telegramPorukaId: 900 }), '/zapis')).status).toBe(202)
    expect(bk.primiZapis(pz(zapis({ telegramPorukaId: 900 }), '/zapis')).status).toBe(409)
  })
  test('zapis prolazi i kad je razmjena zaustavljena (nije potez, model se ne pokreće)', async () => {
    const { bk } = okolina()
    await bk.zaustavi(CHAT, 'Korisnik A', 'fraza', false)
    expect(bk.primiZapis(pz(zapis(), '/zapis')).status).toBe(202)
  })
  test('odlazno zapisi(): POST na /od-bota/zapis svakom drugom botu, bez spomena, bez brojila; potpis za /zapis', async () => {
    const { bk, pozivi, stanje } = okolina()
    expect(await bk.zapisi({ chatId: CHAT, tekst: 'moj odgovor bez spomena', telegramPorukaId: '55' })).toBe('poslano')
    expect(pozivi).toHaveLength(1)
    expect(pozivi[0]!.url).toBe('http://10.0.0.2:17781/api/razgovor/od-bota/zapis')
    expect(pozivi[0]!.tijelo).toMatchObject({ izvor: 'saban', chatId: CHAT, tekst: 'moj odgovor bez spomena', telegramPorukaId: '55' })
    expect(provjeriPotpis(pozivi[0]!.potpis, TAJNA_SLANJA, 'POST', `${PUT_RUTE}/zapis`, JSON.stringify(pozivi[0]!.tijelo), sada)).toBe('ok')
    expect(stanje().brojilo[CHAT] ?? []).toHaveLength(0)
  })
  test('odlazno: isključeno / chat izvan popisa → 0 POST-ova; pad → pad bez dojave u grupu', async () => {
    const { bk, pozivi, postavke, grupa, fetchStatus } = okolina()
    expect(await bk.zapisi({ chatId: '-1', tekst: 'x', telegramPorukaId: null })).toBe('iskljuceno')
    postavke.ukljucen = false
    expect(await bk.zapisi({ chatId: CHAT, tekst: 'x', telegramPorukaId: null })).toBe('iskljuceno')
    expect(pozivi).toHaveLength(0)
    postavke.ukljucen = true
    fetchStatus(0)
    expect(await bk.zapisi({ chatId: CHAT, tekst: 'x', telegramPorukaId: null })).toBe('pad')
    expect(grupa).toHaveLength(0)
  })
  test('ruta → razgovor: 202 → jezgra.zapisDrugogBota (bez primi); 401 → ništa', () => {
    const { bk } = okolina()
    const zapisano: unknown[] = []
    const primljeno: unknown[] = []
    const s = {
      botKanal: bk,
      jezgra: { primi: (p: unknown) => { primljeno.push(p) }, zapisDrugogBota: (z: unknown) => { zapisano.push(z) } },
      ulaz: { postavke: () => ({ ukljucen: true, ime: 'Šaban' }), aktivniKanal: { ime: 'telegram' } },
    } as unknown as RazgovorSloj
    expect(odBotaZapis(s, pz(zapis(), '/zapis')).status).toBe(202)
    expect(odBotaZapis(s, { ip: IP, tijelo: JSON.stringify(zapis({ telegramPorukaId: 5 })) }).status).toBe(401)
    expect(zapisano).toEqual([{ kanal: 'telegram', chatId: CHAT, izvor: 'klaudio', tekst: 'Odgovor Klaudija vlasniku', porukaId: '777', ts: '2026-10-09T08:00:00Z' }])
    expect(primljeno).toHaveLength(0)
  })
})
