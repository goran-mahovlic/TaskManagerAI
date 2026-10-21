/**
 * TASK-5509: Šaban odgovara na dolazni mail preko ploče (`POST /api/email/posalji` s `odgovorNa`).
 *
 * Pravila koja ovdje moraju stajati (sve bez mreže — SMTP je ubrizgan):
 *   - primatelj je pošiljatelj (ili Reply-To) STVARNO primljene poruke, nikad adresa iz zahtjeva;
 *   - vlasnik je UVIJEK u CC-u, iz postavke — zahtjev ga ne može izostaviti ni zamijeniti;
 *   - predmet „Re: …", In-Reply-To i References iz spremljenog Message-ID-a;
 *   - privitci samo iz dopuštenih mapa (realpath), bez `..`, bez simboličke poveznice van, uz strop;
 *   - bez jednokratnog naloga poteza (bot-potez, autonomija, agent) nema slanja;
 *   - proba (X-Regoc-Proba) ne šalje stvarni mail vanjskoj adresi;
 *   - trag u Konzoli i u `posta.json`: tko je naložio, kome, CC, privitci, messageId.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { NaloziPoteza, odgovoriNaMail, type OvisnostiOdgovora, type SlanjeOdgovora } from '../src/PostaOdgovor'
import { memorijskoSpremiste, type StanjePoste, type ZapisMaila } from '../src/PostaUlaz'

const CHAT = '-1001234567890'
const COVJEK = { id: '1001', ime: 'Vlasnik' }

function zapis(uid: number, over: Partial<ZapisMaila> = {}): ZapisMaila {
  return {
    uid, chatId: CHAT, od: 'Korisnica K. <korisnica@primjer.test>', odAdresa: 'korisnica@primjer.test',
    predmet: 'Fasada', datum: '2026-10-14T08:00:00.000Z', privitci: [], sazetak: 'Pozdrav', tijelo: 'Pozdrav',
    messageId: '<izvorna-8@primjer.test>', poslano: '2026-10-14T08:00:05.000Z', ...over,
  }
}

let mapa: string, radni: string, privitci: string, van: string
let poslano: SlanjeOdgovora[]
let konzola: string[]
let sat: number
let nalozi: NaloziPoteza

function ovisnosti(stanje: Partial<StanjePoste>, over: Partial<OvisnostiOdgovora> = {}): OvisnostiOdgovora {
  return {
    nalozi,
    spremiste: memorijskoSpremiste({ uidValidity: '1', zadnji: 9, greska: null, zadnjaProvjera: null, obavijesti: 1, poruke: {}, ...stanje }),
    vlasnik: () => 'vlasnik@primjer.test',
    interneAdrese: () => ['vlasnik@primjer.test', 'saban@cvor.test'],
    dopusteneMape: n => [n.radniDir, privitci],
    home: mapa,
    posalji: async x => { poslano.push(x); return { ok: true, detalj: { messageId: '<odgovor-1@cvor.test>' } } },
    konzola: (r) => { konzola.push(r) },
    ...over,
  }
}

function izdaj(over: Partial<Parameters<NaloziPoteza['izdaj']>[0]> = {}) {
  return nalozi.izdaj({ kanal: 'telegram', chatId: CHAT, posiljateljId: COVJEK.id, posiljateljIme: COVJEK.ime, radniDir: radni, rokMs: 60_000, ...over })
}

beforeEach(() => {
  mapa = mkdtempSync(join(tmpdir(), 'tm-odgovor-'))
  radni = join(mapa, 'radni', 'telegram_chat'); mkdirSync(radni, { recursive: true })
  privitci = join(mapa, 'privitci'); mkdirSync(join(privitci, CHAT), { recursive: true })
  van = join(mapa, 'tajno'); mkdirSync(van, { recursive: true })
  writeFileSync(join(privitci, CHAT, 'fasada.xlsx'), 'PK-xlsx-sadrzaj')
  writeFileSync(join(radni, 'nacrt.txt'), 'nacrt')
  writeFileSync(join(van, 'credentials.txt'), 'tajna')
  poslano = []; konzola = []; sat = 1_000_000
  nalozi = new NaloziPoteza(() => sat)
})
afterEach(() => rmSync(mapa, { recursive: true, force: true }))

describe('nalog čovjeka (jednokratni token poteza)', () => {
  test('bez naloga (bot-potez, autonomija, agent) — 403, ništa se ne šalje', async () => {
    const d = ovisnosti({ poruke: { '700': zapis(8) } })
    const r = await odgovoriNaMail({ odgovorNa: '8', tekst: 'Poštovana…', nalog: null }, d)
    expect(r.status).toBe(403)
    expect(String((r.tijelo as any).greska)).toContain('nalog')
    expect(poslano).toHaveLength(0)
  })

  test('izmišljen ili istekao nalog — 403', async () => {
    const d = ovisnosti({ poruke: { '700': zapis(8) } })
    expect((await odgovoriNaMail({ odgovorNa: '8', tekst: 'x', nalog: 'krivotvoren' }, d)).status).toBe(403)
    const t = izdaj({ rokMs: 1000 })
    sat += 1001
    const r = await odgovoriNaMail({ odgovorNa: '8', tekst: 'x', nalog: t }, d)
    expect(r.status).toBe(403)
    expect(String((r.tijelo as any).greska)).toContain('istekao')
    expect(poslano).toHaveLength(0)
  })

  test('nalog je jednokratan: drugo slanje istim nalogom se odbija', async () => {
    const d = ovisnosti({ poruke: { '700': zapis(8) } })
    const t = izdaj()
    expect((await odgovoriNaMail({ odgovorNa: '8', tekst: 'prvi', nalog: t }, d)).status).toBe(200)
    const r = await odgovoriNaMail({ odgovorNa: '8', tekst: 'drugi', nalog: t }, d)
    expect(r.status).toBe(403)
    expect(poslano).toHaveLength(1)
  })

  test('opozvan nalog (kraj poteza) više ne vrijedi', async () => {
    const d = ovisnosti({ poruke: { '700': zapis(8) } })
    const t = izdaj()
    nalozi.opozovi(t)
    expect((await odgovoriNaMail({ odgovorNa: '8', tekst: 'x', nalog: t }, d)).status).toBe(403)
  })

  test('neuspjelo slanje ne troši nalog — model smije ispraviti i pokušati ponovno', async () => {
    let pada = true
    const d = ovisnosti({ poruke: { '700': zapis(8) } }, {
      posalji: async x => { if (pada) return { ok: false, greska: 'SMTP 451' }; poslano.push(x); return { ok: true, detalj: { messageId: '<m@x>' } } },
    })
    const t = izdaj()
    const r1 = await odgovoriNaMail({ odgovorNa: '8', tekst: 'x', nalog: t }, d)
    expect(r1.status).toBe(502)
    expect(String((r1.tijelo as any).greska)).toContain('SMTP 451')
    pada = false
    expect((await odgovoriNaMail({ odgovorNa: '8', tekst: 'x', nalog: t }, d)).status).toBe(200)
  })
})

describe('primatelj, CC, nit', () => {
  test('odgovor ide pošiljatelju, vlasnik u CC, Re: predmet, In-Reply-To/References', async () => {
    const d = ovisnosti({ poruke: { '700': zapis(8) } })
    const r = await odgovoriNaMail({ odgovorNa: '8', tekst: 'Poštovana, u privitku je tablica.', nalog: izdaj() }, d)
    expect(r.status).toBe(200)
    expect(poslano).toHaveLength(1)
    const x = poslano[0]!
    expect(x.prima).toBe('korisnica@primjer.test')
    expect(x.cc).toEqual(['vlasnik@primjer.test'])
    expect(x.predmet).toBe('Re: Fasada')
    expect(x.uOdgovorNa).toBe('<izvorna-8@primjer.test>')
    expect(x.references).toBe('<izvorna-8@primjer.test>')
    expect((r.tijelo as any).poslano.messageId).toBe('<odgovor-1@cvor.test>')
  })

  test('Reply-To ima prednost pred From; References nastavlja postojeći lanac', async () => {
    const d = ovisnosti({ poruke: { '700': zapis(8, { replyTo: 'ured@primjer.test', references: '<a@x> <b@x>', predmet: 'RE: Fasada' }) } })
    await odgovoriNaMail({ odgovorNa: '8', tekst: 'x', nalog: izdaj() }, d)
    expect(poslano[0]!.prima).toBe('ured@primjer.test')
    expect(poslano[0]!.predmet).toBe('RE: Fasada')
    expect(poslano[0]!.references).toBe('<a@x> <b@x> <izvorna-8@primjer.test>')
  })

  test('adresa i CC iz zahtjeva se NE poštuju (nije otvoreni relej, vlasnik se ne može izostaviti)', async () => {
    const d = ovisnosti({ poruke: { '700': zapis(8) } })
    const r = await odgovoriNaMail({ odgovorNa: '8', tekst: 'x', nalog: izdaj(), prima: 'napadac@zlo.test', cc: [] } as any, d)
    expect(r.status).toBe(200)
    expect(poslano[0]!.prima).toBe('korisnica@primjer.test')
    expect(poslano[0]!.cc).toEqual(['vlasnik@primjer.test'])
  })

  test('bez vlasnika u postavkama se ne šalje (CC je obavezan)', async () => {
    const d = ovisnosti({ poruke: { '700': zapis(8) } }, { vlasnik: () => null })
    const r = await odgovoriNaMail({ odgovorNa: '8', tekst: 'x', nalog: izdaj() }, d)
    expect(r.status).toBe(409)
    expect(String((r.tijelo as any).greska)).toContain('vlasnik')
    expect(poslano).toHaveLength(0)
  })

  test('odgovorNa: ključ obavijesti iz posta.json i oblik „uid:N"; nepoznat mail = 404', async () => {
    const d = ovisnosti({ poruke: { '1234': zapis(8), '1300': zapis(9, { odAdresa: 'drugi@primjer.test', od: 'drugi@primjer.test' }) } })
    await odgovoriNaMail({ odgovorNa: '1300', tekst: 'x', nalog: izdaj() }, d)
    expect(poslano[0]!.prima).toBe('drugi@primjer.test')
    await odgovoriNaMail({ odgovorNa: 'uid:8', tekst: 'x', nalog: izdaj() }, d)
    expect(poslano[1]!.prima).toBe('korisnica@primjer.test')
    expect((await odgovoriNaMail({ odgovorNa: '77', tekst: 'x', nalog: izdaj() }, d)).status).toBe(404)
  })

  test('nalog je vezan uz chat: mail obaviješten u DRUGOM chatu se odbija', async () => {
    const d = ovisnosti({ poruke: { '700': zapis(8, { chatId: '-100999' }) } })
    const r = await odgovoriNaMail({ odgovorNa: '8', tekst: 'x', nalog: izdaj() }, d)
    expect(r.status).toBe(403)
    expect(String((r.tijelo as any).greska)).toContain('drugom chatu')
    expect(poslano).toHaveLength(0)
  })

  test('tekst je obavezan', async () => {
    const d = ovisnosti({ poruke: { '700': zapis(8) } })
    expect((await odgovoriNaMail({ odgovorNa: '8', tekst: '  ', nalog: izdaj() }, d)).status).toBe(400)
  })
})

describe('privitci', () => {
  test('datoteka iz privitci/ i iz radne mape chata ide u privitak', async () => {
    const d = ovisnosti({ poruke: { '700': zapis(8) } })
    const r = await odgovoriNaMail({
      odgovorNa: '8', tekst: 'x', nalog: izdaj(),
      privitci: [join(privitci, CHAT, 'fasada.xlsx'), join(radni, 'nacrt.txt')],
    }, d)
    expect(r.status).toBe(200)
    expect(poslano[0]!.privitci.map(p => p.ime)).toEqual(['fasada.xlsx', 'nacrt.txt'])
  })

  test('sadržaj privitka je pročitan pri provjeri (SMTP sloj ne razrješava putanju ponovno)', async () => {
    const d = ovisnosti({ poruke: { '700': zapis(8) } })
    await odgovoriNaMail({ odgovorNa: '8', tekst: 'x', nalog: izdaj(), privitci: [join(privitci, CHAT, 'fasada.xlsx')] }, d)
    expect(poslano[0]!.privitci[0]!.sadrzaj.toString()).toBe('PK-xlsx-sadrzaj')
  })

  test('datoteka izvan dopuštenih mapa, s „..", ili simbolička poveznica van — odbijeno, ništa ne ide', async () => {
    const d = ovisnosti({ poruke: { '700': zapis(8) } })
    symlinkSync(join(van, 'credentials.txt'), join(radni, 'poveznica.txt'))
    for (const put of [join(van, 'credentials.txt'), `${radni}/../../tajno/credentials.txt`, join(radni, 'poveznica.txt'), 'relativno.txt']) {
      const r = await odgovoriNaMail({ odgovorNa: '8', tekst: 'x', nalog: izdaj(), privitci: [put] }, d)
      expect(r.status).toBe(400)
    }
    expect(poslano).toHaveLength(0)
  })

  test('strop veličine (ukupno) i broja privitaka', async () => {
    writeFileSync(join(radni, 'veliko.bin'), Buffer.alloc(2048))
    const d = ovisnosti({ poruke: { '700': zapis(8) } }, { maxBajta: 1024 })
    const r = await odgovoriNaMail({ odgovorNa: '8', tekst: 'x', nalog: izdaj(), privitci: [join(radni, 'veliko.bin')] }, d)
    expect(r.status).toBe(400)
    expect(String((r.tijelo as any).greska)).toContain('prevelik')
    const mnogo = Array.from({ length: 11 }, () => join(radni, 'nacrt.txt'))
    expect((await odgovoriNaMail({ odgovorNa: '8', tekst: 'x', nalog: izdaj(), privitci: mnogo }, ovisnosti({ poruke: { '700': zapis(8) } }))).status).toBe(400)
    expect(poslano).toHaveLength(0)
  })
})

describe('proba (X-Regoc-Proba)', () => {
  test('proba s vanjskom adresom: ništa ne odlazi, ali priprema se vraća (prima, CC, nit, privitci)', async () => {
    const d = ovisnosti({ poruke: { '700': zapis(8, { proba: true }) } })
    const r = await odgovoriNaMail({ odgovorNa: '8', tekst: 'x', nalog: izdaj(), privitci: [join(privitci, CHAT, 'fasada.xlsx')] }, d)
    expect(r.status).toBe(200)
    const t = r.tijelo as any
    expect(t.proba).toBe(true)
    expect(t.poslano).toBeNull()
    expect(t.priprema.prima).toBe('korisnica@primjer.test')
    expect(t.priprema.cc).toEqual(['vlasnik@primjer.test'])
    expect(t.priprema.inReplyTo).toBe('<izvorna-8@primjer.test>')
    expect(t.priprema.privitci).toEqual(['fasada.xlsx'])
    expect(poslano).toHaveLength(0)
  })

  test('proba s internom adresom (vlasnik/popis primatelja) stvarno se šalje — E2E bez vanjskih adresa', async () => {
    const d = ovisnosti({ poruke: { '700': zapis(8, { proba: true, odAdresa: 'vlasnik@primjer.test', od: 'Vlasnik <vlasnik@primjer.test>' }) } })
    const r = await odgovoriNaMail({ odgovorNa: '8', tekst: 'x', nalog: izdaj() }, d)
    expect(r.status).toBe(200)
    expect(poslano).toHaveLength(1)
    // Vlasnik je već primatelj — ne dupla se u CC.
    expect(poslano[0]!.cc).toEqual([])
  })
})

describe('trag', () => {
  test('Konzola i posta.json: tko je naložio, kome, CC, privitci, messageId', async () => {
    const d = ovisnosti({ poruke: { '700': zapis(8) } })
    await odgovoriNaMail({ odgovorNa: '8', tekst: 'Poštovana', nalog: izdaj(), privitci: [join(privitci, CHAT, 'fasada.xlsx')] }, d)
    const z = d.spremiste.ucitaj().poruke['700']!
    const o = z.odgovori!.at(-1)!
    expect(o.tko).toContain('Vlasnik')
    expect(o.tko).toContain(COVJEK.id)
    expect(o.prima).toBe('korisnica@primjer.test')
    expect(o.cc).toEqual(['vlasnik@primjer.test'])
    expect(o.privitci).toEqual(['fasada.xlsx'])
    expect(o.messageId).toBe('<odgovor-1@cvor.test>')
    expect(z.odluka?.radnja).toBe('odgovori')
    const red = konzola.join('\n')
    expect(red).toContain('korisnica@primjer.test')
    expect(red).toContain('vlasnik@primjer.test')
    expect(red).toContain('fasada.xlsx')
    expect(red).toContain('Vlasnik')
  })
})
