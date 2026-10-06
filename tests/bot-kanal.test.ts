/**
 * ADR-0003 — jezgra kanala bot↔bot (BotKanal.ts): ugovor rute (B1), odlazni prijenos (B4),
 * stop-fraza (B5), strop i skok (B7), vlastita poruka (B8), nastavak (B9), tajna (B11).
 * Bez mreže: drugi kraj je lažni `fetch`, vrijeme je ubrizgano.
 *
 * Autorica: Jelena (Engineer), TASK-5290.
 */

import { describe, expect, test } from 'bun:test'
import {
  BOT_KANAL_ZADANO, jeNastavakFraza, jeStopFraza, praznoStanje, provjeriTijelo, spominje, stvoriBotKanal,
  type BotKanalPostavke, type BotKanalStanje, type ZastavicaChata,
} from '../src/razgovor/BotKanal'

const TAJNA = 'a'.repeat(48)
const CHAT = '-5112799687'
const VLASNIK = '5284452279'
const DRUGA = '8872962604'

function okolina(o: Partial<BotKanalPostavke> = {}) {
  const postavke: BotKanalPostavke = {
    ...BOT_KANAL_ZADANO, ukljucen: true, chatovi: [CHAT], adrese: ['10.0.0.2'],
    drugi: [{ ime: 'klaudio', korisnickoIme: 'klaudioAI_bot', url: 'http://drugi:17781' }],
    stopKorisnici: [VLASNIK, DRUGA], ...o,
  }
  let stanje: BotKanalStanje = praznoStanje()
  const povijest: { chatId: string; z: ZastavicaChata }[] = []
  const pozivi: { url: string; tijelo: any; auth: string }[] = []
  const grupa: string[] = []
  const prekidi: string[] = []
  let sada = Date.parse('2026-10-06T18:41:00Z')
  let fetchStatus = 202
  const bk = stvoriBotKanal({
    ja: 'saban',
    postavke: () => postavke,
    token: () => TAJNA,
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
      pozivi.push({ url, tijelo: JSON.parse(init.body), auth: init.headers.Authorization })
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

const auth = { authorization: `Bearer ${TAJNA}`, ip: '::ffff:10.0.0.2' }
const tijelo = (o: Record<string, unknown> = {}) => ({
  izvor: 'klaudio', chatId: CHAT, tekst: 'Šabane, koliko je otvorenih zadataka?', telegramPorukaId: 501,
  lanacId: 'L1', skok: 1, izvornik: { id: VLASNIK, ime: 'Ivan' }, ts: '2026-10-06T18:41:00Z', ...o,
})

describe('B1 ugovor rute', () => {
  test('bez tajne 401, pogrešna tajna 401', () => {
    const { bk } = okolina()
    expect(bk.primi(tijelo(), { ip: auth.ip }).status).toBe(401)
    expect(bk.primi(tijelo(), { ...auth, authorization: `Bearer ${'b'.repeat(48)}` }).status).toBe(401)
    expect(bk.primi(tijelo(), { ...auth, authorization: TAJNA }).status).toBe(401)
  })
  test('adresa izvan allowliste 403 (i s ispravnom tajnom)', () => {
    const { bk } = okolina()
    expect(bk.primi(tijelo(), { ...auth, ip: '10.0.0.99' }).status).toBe(403)
  })
  test('isključen kanal 403 bez obrade; nema tajne na stroju 403', () => {
    const { bk, postavke } = okolina()
    postavke.ukljucen = false
    expect(bk.primi(tijelo(), auth).status).toBe(403)
    const bez = stvoriBotKanal({ ja: 'saban', postavke: () => ({ ...postavke, ukljucen: true }), token: () => '', spremiste: { citaj: praznoStanje, pisi: () => {} } })
    expect(bez.primi(tijelo(), { ...auth, authorization: 'Bearer ' }).status).toBe(403)
  })
  test('chat izvan popisa 403, izvor izvan popisa 403', () => {
    const { bk } = okolina()
    expect(bk.primi(tijelo({ chatId: '-100' }), auth).status).toBe(403)
    expect(bk.primi(tijelo({ izvor: 'netko' }), auth).status).toBe(403)
  })
  test('nepoznato polje 400, tekst > 4000 413, ispravno 202 s porukom', () => {
    const { bk } = okolina()
    const n = bk.primi({ ...tijelo(), ovlasti: 'puno' }, auth)
    expect(n.status).toBe(400)
    expect(String(n.tijelo.error)).toContain('ovlasti')
    expect(bk.primi(tijelo({ tekst: 'x'.repeat(4001) }), auth).status).toBe(413)
    const ok = bk.primi(tijelo(), auth)
    expect(ok.status).toBe(202)
    expect(ok.poruka).toMatchObject({ izvor: 'klaudio', chatId: CHAT, telegramPorukaId: '501', lanacId: 'L1', skok: 1 })
  })
  test('provjeriTijelo: chatId broj se prima kao tekst; skok 0 odbijen', () => {
    expect(provjeriTijelo(tijelo({ chatId: -5112799687 })).ok).toBe(true)
    expect(provjeriTijelo(tijelo({ skok: 0 })).ok).toBe(false)
  })
})

describe('B4 odlazni prijenos', () => {
  test('odgovor sa @klaudioAI_bot → 1 POST s tajnom, novi lanac skok 1, telegramPorukaId', async () => {
    const { bk, pozivi } = okolina()
    const r = await bk.prenesi({ chatId: CHAT, tekst: '@KlaudioAI_bot koja je verzija CLI-ja?', telegramPorukaId: '777', izvornik: { id: VLASNIK, ime: 'Ivan' } })
    expect(r).toBe('poslano')
    expect(pozivi).toHaveLength(1)
    expect(pozivi[0]!.url).toBe('http://drugi:17781/api/razgovor/od-bota')
    expect(pozivi[0]!.auth).toBe(`Bearer ${TAJNA}`)
    expect(pozivi[0]!.tijelo).toMatchObject({ izvor: 'saban', chatId: CHAT, telegramPorukaId: '777', lanacId: 'lanac-1', skok: 1, izvornik: { id: VLASNIK } })
  })
  test('nastavak lanca: isti lanacId, skok+1, izvornik iz lanca', async () => {
    const { bk, pozivi } = okolina()
    await bk.prenesi({ chatId: CHAT, tekst: 'evo @klaudioAI_bot: 3', telegramPorukaId: '9', lanac: { izvor: 'klaudio', lanacId: 'L7', skok: 2, izvornik: { id: DRUGA, ime: 'Ana' } } })
    expect(pozivi[0]!.tijelo).toMatchObject({ lanacId: 'L7', skok: 3, izvornik: { id: DRUGA } })
  })
  test('bez spomena, chat izvan popisa, isključeno, zastavica → 0 POST-ova', async () => {
    const { bk, pozivi, postavke } = okolina()
    expect(await bk.prenesi({ chatId: CHAT, tekst: 'klaudioAI_bot bez @', telegramPorukaId: '1' })).toBe('bez-spomena')
    expect(await bk.prenesi({ chatId: CHAT, tekst: '@klaudioAI_botx', telegramPorukaId: '1' })).toBe('bez-spomena')
    expect(await bk.prenesi({ chatId: '-1', tekst: '@klaudioAI_bot', telegramPorukaId: '1' })).toBe('iskljuceno')
    await bk.zaustavi(CHAT, 'Ivan', 'rucno', false)
    expect(await bk.prenesi({ chatId: CHAT, tekst: '@klaudioAI_bot', telegramPorukaId: '1' })).toBe('zaustavljeno')
    postavke.ukljucen = false
    expect(await bk.prenesi({ chatId: CHAT, tekst: '@klaudioAI_bot', telegramPorukaId: '1' })).toBe('iskljuceno')
    expect(pozivi).toHaveLength(0)
  })
  test('pad mreže: 2 pokušaja, 1 dojava u grupu u 10 min', async () => {
    const { bk, pozivi, grupa, fetchStatus, pomakni } = okolina()
    fetchStatus(0)
    expect(await bk.prenesi({ chatId: CHAT, tekst: '@klaudioAI_bot a', telegramPorukaId: '1' })).toBe('pad')
    expect(pozivi).toHaveLength(2)
    pomakni(60_000)
    await bk.prenesi({ chatId: CHAT, tekst: '@klaudioAI_bot b', telegramPorukaId: '2' })
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
      expect(pozivi[0]!.url).toBe('http://drugi:17781/api/razgovor/od-bota/stop')
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
    expect(bk.primi(tijelo({ tekst: 'prekini komunikaciju' }), auth).status).toBe(202)
    expect(bk.jeZaustavljen(CHAT)).toBe(false)
  })
  test('prazan popis stop-korisnika = dopušteni koji su brojčani', async () => {
    const postavke = { ...BOT_KANAL_ZADANO, ukljucen: true, chatovi: [CHAT] }
    let s = praznoStanje()
    const bk = stvoriBotKanal({
      ja: 'saban', postavke: () => postavke, token: () => TAJNA,
      spremiste: { citaj: () => s, pisi: x => { s = x } }, zadaniStopKorisnici: () => [VLASNIK, 'ivan'],
    })
    expect(await bk.ljudska({ chatId: CHAT, posiljateljId: VLASNIK, posiljateljIme: 'Ivan', tekst: 'prekini komunikaciju' })).toBe('stop')
  })
  test('zastavica podignuta: ruta 409 zaustavljeno', async () => {
    const { bk } = okolina()
    await bk.ljudska({ chatId: CHAT, posiljateljId: VLASNIK, posiljateljIme: 'Ivan', tekst: 'prekini komunikaciju' })
    const r = bk.primi(tijelo(), auth)
    expect(r.status).toBe(409)
    expect(r.tijelo.razlog).toBe('zaustavljeno')
  })
  test('stop od drugog kraja (ruta /stop) diže zastavicu i ne vraća stop natrag', async () => {
    const { bk, pozivi, prekidi } = okolina()
    expect(bk.primiStop({ chatId: CHAT, by: 'Ana', razlog: 'fraza' }, auth).status).toBe(200)
    await Bun.sleep(0)
    expect(bk.jeZaustavljen(CHAT)).toBe(true)
    expect(prekidi).toEqual([CHAT])
    expect(pozivi).toHaveLength(0)
    expect(bk.primiStop({ chatId: CHAT }, { ip: auth.ip }).status).toBe(401)
  })
})

describe('B7 strop i skok', () => {
  test('6 prijenosa u prozoru bez ljudske poruke → 7. odbijen 409 strop, zastavica strop, 1 poruka', async () => {
    const { bk, grupa, stanje } = okolina()
    for (let i = 0; i < 3; i++) {
      expect(bk.primi(tijelo({ telegramPorukaId: 100 + i }), auth).status).toBe(202)
      expect(await bk.prenesi({ chatId: CHAT, tekst: '@klaudioAI_bot', telegramPorukaId: String(200 + i) })).toBe('poslano')
    }
    const r = bk.primi(tijelo({ telegramPorukaId: 300 }), auth)
    expect(r.status).toBe(409)
    expect(r.tijelo.razlog).toBe('strop')
    await Bun.sleep(0)
    expect(stanje().zastavice[CHAT]).toMatchObject({ zaustavljen: true, razlog: 'strop' })
    expect(grupa.filter(g => g.includes('strop'))).toHaveLength(1)
  })
  test('ljudska poruka između prijenosa nulira brojilo', async () => {
    const { bk } = okolina()
    for (let i = 0; i < 6; i++) expect(bk.primi(tijelo({ telegramPorukaId: i }), auth).status).toBe(202)
    await bk.ljudska({ chatId: CHAT, posiljateljId: '111', posiljateljIme: 'Netko', tekst: 'hvala' })
    expect(bk.primi(tijelo({ telegramPorukaId: 50 }), auth).status).toBe(202)
  })
  test('izvan prozora se ne broji', () => {
    const { bk, pomakni } = okolina()
    for (let i = 0; i < 6; i++) bk.primi(tijelo({ telegramPorukaId: i }), auth)
    pomakni(11 * 60_000)
    expect(bk.primi(tijelo({ telegramPorukaId: 60 }), auth).status).toBe(202)
  })
  test('skok 7 uz strop 6 → 409 skok i uz prazno brojilo (restart)', () => {
    const { bk } = okolina()
    const r = bk.primi(tijelo({ skok: 7 }), auth)
    expect(r.status).toBe(409)
    expect(r.tijelo.razlog).toBe('skok')
  })
  test('odlazno: skok bi prešao strop → ne šalje se, zastavica strop', async () => {
    const { bk, pozivi } = okolina()
    expect(await bk.prenesi({ chatId: CHAT, tekst: '@klaudioAI_bot', telegramPorukaId: '1', lanac: { izvor: 'klaudio', lanacId: 'L', skok: 6, izvornik: null } })).toBe('strop')
    expect(pozivi.filter(p => p.url.endsWith('/od-bota'))).toHaveLength(0)
    expect(bk.jeZaustavljen(CHAT)).toBe(true)
  })
})

describe('B8 vlastita poruka', () => {
  test('izvor = vlastito ime → 409 vlastita', () => {
    const { bk } = okolina()
    const r = bk.primi(tijelo({ izvor: 'saban' }), auth)
    expect(r.status).toBe(409)
    expect(r.tijelo.razlog).toBe('vlastita')
  })
  test('vlastiti telegramPorukaId (odjek) → 409 vlastita', async () => {
    const { bk } = okolina()
    await bk.prenesi({ chatId: CHAT, tekst: '@klaudioAI_bot pitanje', telegramPorukaId: '4242' })
    const r = bk.primi(tijelo({ telegramPorukaId: 4242 }), auth)
    expect(r.status).toBe(409)
    expect(r.tijelo.razlog).toBe('vlastita')
  })
})

describe('B9 nastavak', () => {
  test('„Nastavi komunikaciju" od stop-korisnika spušta zastavicu, šalje /nastavi, nulira brojilo; povijest', async () => {
    const { bk, pozivi, povijest, stanje } = okolina()
    for (let i = 0; i < 6; i++) bk.primi(tijelo({ telegramPorukaId: i }), auth)
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
    expect(bk.primi(tijelo({ tekst: 'nastavi komunikaciju' }), auth).status).toBe(409)
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
    expect(bk.stanjeZaDrugog({ ip: auth.ip }).status).toBe(401)
    const r = bk.stanjeZaDrugog(auth)
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
import { botKanalGet, imeUKanalu, odBotaPost, type RazgovorSloj } from '../src/razgovor/RazgovorPloca'
import type { UlaznaPoruka } from '../src/razgovor/Kanal'

describe('BotKanalPostavke', () => {
  test('zadano isključeno; zakrpa se upisuje uz povijest; nepoznato i puno odbijeni', () => {
    const m = mkdtempSync(join(tmpdir(), 'tm-bk-db-'))
    try {
      const db = new Database(join(m, 't.db'))
      expect(getBotKanalPostavke(db).postavke.ukljucen).toBe(false)
      setBotKanalPostavke(db, {
        ukljucen: true, chatovi: [CHAT], adrese: ['10.0.0.2'], stopKorisnici: [VLASNIK, DRUGA],
        drugi: [{ ime: 'klaudio', korisnickoIme: '@klaudioAI_bot', url: 'http://10.0.0.2:17781/' }],
      }, 'ploca')
      const p = getBotKanalPostavke(db).postavke
      expect(p).toMatchObject({ ukljucen: true, chatovi: [CHAT], strop: 6, ovlasti: 'citanje' })
      expect(p.drugi[0]).toEqual({ ime: 'klaudio', korisnickoIme: 'klaudioAI_bot', url: 'http://10.0.0.2:17781' })
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
      const bk = stvoriBotKanal({ ja: 'saban', postavke: () => postavke, token: () => TAJNA, spremiste: spremisteUBazi(put) })
      await bk.ljudska({ chatId: CHAT, posiljateljId: VLASNIK, posiljateljIme: 'Ivan', tekst: 'prekini komunikaciju' })
      const nakon = stvoriBotKanal({ ja: 'saban', postavke: () => postavke, token: () => TAJNA, spremiste: spremisteUBazi(put) })
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
      const r = botKanalGet(put, null, { TM_BOT_KANAL_TOKEN: TAJNA })
      expect((r.tijelo as any).tajna).toBe('postavljena')
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
    const r = odBotaPost(s, tijelo(), auth)
    expect(r.status).toBe(202)
    expect(primljeno).toHaveLength(1)
    expect(primljeno[0]).toMatchObject({
      izvor: 'bot', posiljateljJeBot: true, posiljateljId: 'bot:klaudio', porukaId: '501', chatId: CHAT,
      lanac: { izvor: 'klaudio', lanacId: 'L1', skok: 1 },
    })
  })
  test('401/409 → 0 poziva razgovora', () => {
    const { s, primljeno } = sloj()
    expect(odBotaPost(s, tijelo(), { ip: auth.ip }).status).toBe(401)
    expect(odBotaPost(s, tijelo({ izvor: 'saban' }), auth).status).toBe(409)
    expect(primljeno).toHaveLength(0)
  })
  test('razgovor ne radi → 503', () => {
    const { s } = sloj()
    ;(s.ulaz as any).aktivniKanal = undefined
    expect(odBotaPost(s, tijelo(), auth).status).toBe(503)
  })
})
