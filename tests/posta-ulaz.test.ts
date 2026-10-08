/**
 * Provjera e-pošte s obaviješću u grupu i odlukom čovjeka (TASK-5358).
 *
 * Sve bez mreže: IMAP, Telegram i ploča su UBRIZGANI. Pravila koja ovdje moraju stajati:
 *   - prvi prolaz NE šalje staru poštu (samo zapamti UIDVALIDITY + zadnji UID);
 *   - neuspjelo slanje ne pomiče stanje (sljedeći prolaz pokuša ponovno);
 *   - IMAP greška = JEDNA dojava, ne svaki prolaz; oporavak se javi jednom;
 *   - poller nikad ne odgovara pošiljatelju — odgovor ide samo na nalog „odgovori: …".
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  ZADANO_STANJE_POSTE, datotecnoSpremiste, jedanProlazPoste, memorijskoSpremiste, obradiOdgovorPoste,
  sazetakTijela, tekstObavijesti, type ImapKlijent, type Mail, type Obavjestac, type StanjePoste,
} from '../src/PostaUlaz'
import { ZADANE_POSTAVKE as EM_ZADANE, type EmailPostavke } from '../src/EmailConfig'

const CFG: EmailPostavke = {
  ...EM_ZADANE, ukljucen: true, smjer: 'oba',
  imap: { ...EM_ZADANE.imap, host: 'imap.primjer.test', korisnik: 'bot', obavijest: true },
}

function mail(uid: number, over: Partial<Mail> = {}): Mail {
  return {
    uid, od: 'Ana Anić <ana@primjer.test>', odAdresa: 'ana@primjer.test', predmet: `Ponuda ${uid}`,
    datum: '2026-10-08T10:51:03.000Z', privitci: [], tijelo: 'Pozdrav,\nšaljem ponudu.\nLijep pozdrav', ...over,
  }
}

class LazniImap implements ImapKlijent {
  uidValidity = '111'
  posta: Mail[] = []
  greska: Error | null = null
  otvoreno = 0
  async otvori() {
    this.otvoreno++
    if (this.greska) throw this.greska
    return {
      uidValidity: this.uidValidity,
      maxUid: this.posta.reduce((m, x) => Math.max(m, x.uid), 0),
      noviOd: async (zadnji: number, najvise: number) => this.posta.filter(x => x.uid > zadnji).slice(0, najvise),
      zatvori: async () => { /* nista */ },
    }
  }
}

class LazniTg implements Obavjestac {
  poslane: { chatId: string; tekst: string }[] = []
  pada = false
  sljedeciId = 500
  async posalji(chatId: string, tekst: string) {
    if (this.pada) return null
    this.poslane.push({ chatId, tekst })
    return String(this.sljedeciId++)
  }
}

let mapa: string
beforeEach(() => { mapa = mkdtempSync(join(tmpdir(), 'tm-posta-')) })
afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })

function okolina() {
  const imap = new LazniImap()
  const tg = new LazniTg()
  const sp = memorijskoSpremiste()
  const konzola: string[] = []
  const o = { cfg: CFG, chatId: '-100', imap, tg, spremiste: sp, konzola: (r: string) => { konzola.push(r) } }
  return { imap, tg, sp, konzola, o }
}

describe('prolaz pošte', () => {
  test('prvi prolaz zapamti stanje i NE šalje staru poštu', async () => {
    const { imap, tg, sp, o } = okolina()
    imap.posta = [mail(5), mail(9)]
    const r = await jedanProlazPoste(o)
    expect(r.init).toBe(true)
    expect(tg.poslane).toHaveLength(0)
    expect(sp.ucitaj()).toMatchObject({ uidValidity: '111', zadnji: 9 })
  })

  test('nova pošta → jedna obavijest s detaljima i uputom, stanje se pomiče', async () => {
    const { imap, tg, sp, konzola, o } = okolina()
    imap.posta = [mail(9)]
    await jedanProlazPoste(o)
    imap.posta.push(mail(10, { privitci: ['ponuda.pdf', 'cjenik.xlsx'] }))
    const r = await jedanProlazPoste(o)
    expect(r.poslano).toBe(1)
    expect(tg.poslane).toHaveLength(1)
    const t = tg.poslane[0].tekst
    expect(tg.poslane[0].chatId).toBe('-100')
    expect(t).toContain('Od: Ana Anić <ana@primjer.test>')
    expect(t).toContain('Predmet: Ponuda 10')
    expect(t).toContain('Vrijeme: 08.10.2026.')
    expect(t).toContain('Privitci: ponuda.pdf, cjenik.xlsx')
    expect(t).toContain('šaljem ponudu.')
    expect(t).toMatch(/zadatak/)
    expect(t).toMatch(/ignoriraj/)
    expect(t).toMatch(/odgovori:/)
    const s = sp.ucitaj()
    expect(s.zadnji).toBe(10)
    expect(s.poruke['500']).toMatchObject({ uid: 10, chatId: '-100', odAdresa: 'ana@primjer.test' })
    expect(konzola.join('\n')).toContain('Ponuda 10')
  })

  test('slanje u grupu palo → stanje se NE pomiče, sljedeći prolaz šalje', async () => {
    const { imap, tg, sp, o } = okolina()
    imap.posta = [mail(1)]
    await jedanProlazPoste(o)
    imap.posta.push(mail(2))
    tg.pada = true
    await jedanProlazPoste(o)
    expect(sp.ucitaj().zadnji).toBe(1)
    tg.pada = false
    await jedanProlazPoste(o)
    expect(tg.poslane).toHaveLength(1)
    expect(sp.ucitaj().zadnji).toBe(2)
  })

  test('promijenjen UIDVALIDITY → ponovno zapamti, bez slanja', async () => {
    const { imap, tg, sp, o } = okolina()
    imap.posta = [mail(3)]
    await jedanProlazPoste(o)
    imap.uidValidity = '222'
    imap.posta = [mail(1), mail(2)]
    const r = await jedanProlazPoste(o)
    expect(r.init).toBe(true)
    expect(tg.poslane).toHaveLength(0)
    expect(sp.ucitaj()).toMatchObject({ uidValidity: '222', zadnji: 2 })
  })

  test('IMAP greška → JEDNA dojava; ista greška ponovno → tišina; oporavak → jedna poruka', async () => {
    const { imap, tg, sp, o } = okolina()
    imap.posta = [mail(1)]
    await jedanProlazPoste(o)
    imap.greska = Object.assign(new Error('Command failed'), { authenticationFailed: true })
    const a = await jedanProlazPoste(o)
    const b = await jedanProlazPoste(o)
    const c = await jedanProlazPoste(o)
    expect(a.dojava).toBe(true)
    expect(b.dojava).toBe(false)
    expect(c.dojava).toBe(false)
    expect(tg.poslane).toHaveLength(1)
    expect(tg.poslane[0].tekst).toMatch(/prijava/i)
    expect(sp.ucitaj().greska).not.toBeNull()
    imap.greska = null
    await jedanProlazPoste(o)
    expect(tg.poslane).toHaveLength(2)
    expect(tg.poslane[1].tekst).toMatch(/ponovno radi/)
    expect(sp.ucitaj().greska).toBeNull()
  })

  test('nema lozinke → jedna dojava s uputom za upis kroz ploču', async () => {
    const { tg, o } = okolina()
    const r1 = await jedanProlazPoste({ ...o, imap: null, bezLozinke: 'IMAP_PASSWORD' })
    const r2 = await jedanProlazPoste({ ...o, imap: null, bezLozinke: 'IMAP_PASSWORD' })
    expect(r1.dojava).toBe(true)
    expect(r2.dojava).toBe(false)
    expect(tg.poslane).toHaveLength(1)
    expect(tg.poslane[0].tekst).toContain('IMAP_PASSWORD')
    expect(tg.poslane[0].tekst).toMatch(/Tajne/)
  })

  test('najviše N mailova po prolazu — ostatak sljedeći put', async () => {
    const { imap, tg, sp, o } = okolina()
    imap.posta = [mail(1)]
    await jedanProlazPoste(o)
    for (let i = 2; i <= 14; i++) imap.posta.push(mail(i))
    await jedanProlazPoste({ ...o, najviseUProlazu: 5 })
    expect(tg.poslane).toHaveLength(5)
    expect(sp.ucitaj().zadnji).toBe(6)
  })
})

describe('sažetak i tekst', () => {
  test('sažetak: najviše 3 retka, bez citata i potpisa', () => {
    const s = sazetakTijela('Bok,\n\nprvi red\ndrugi red\ntreći red\nčetvrti red\n\nOn Mon, X wrote:\n> staro')
    expect(s.split('\n').length).toBeLessThanOrEqual(3)
    expect(s).not.toContain('staro')
    expect(s).not.toContain('četvrti')
    expect(sazetakTijela('Kratko.\n-- \nPotpis')).toBe('Kratko.')
    expect(sazetakTijela('')).toBe('')
    // zaglavlje citata na hrvatskom (stvarni mail, 07.10.2026.) — nije sadržaj
    expect(sazetakTijela('7.10.2026. u 12:42, Netko (Firma) piše:\n> staro')).toBe('')
    expect(sazetakTijela('Potpisano.\nOn 7 Oct 2026, at 12:42, Netko <a@b.c> wrote:\n> x')).toBe('Potpisano.')
  })

  test('obavijest bez privitaka kaže „nema"; predmet prazan → (bez predmeta)', () => {
    const t = tekstObavijesti(mail(4, { predmet: '' }), 'bot@primjer.test', 'Europe/Zagreb')
    expect(t).toContain('Privitci: nema')
    expect(t).toContain('(bez predmeta)')
    expect(t).toContain('bot@primjer.test')
  })
})

describe('odgovor u grupi (odluka čovjeka)', () => {
  async function s1(): Promise<{ sp: ReturnType<typeof memorijskoSpremiste> }> {
    const { imap, o, sp } = okolina()
    imap.posta = [mail(1)]
    await jedanProlazPoste(o)
    imap.posta.push(mail(2, { tijelo: 'Molim ponudu za 10 komada.', messageId: '<abc@primjer.test>' }))
    await jedanProlazPoste(o)
    return { sp }
  }
  function ovisnosti() {
    const zadaci: any[] = []
    const odgovori: any[] = []
    const biljeske: any[] = []
    return {
      zadaci, odgovori, biljeske,
      d: {
        stvoriZadatak: async (t: any) => { zadaci.push(t); return { taskId: `TASK-${zadaci.length}` } },
        posaljiOdgovor: async (x: any) => { odgovori.push(x); return { ok: true } },
        dodajBiljesku: async (id: string, tekst: string) => { biljeske.push({ id, tekst }) },
        zadaniIzvrsitelj: 'inzenjer',
      },
    }
  }
  const p = (tekst: string, over: any = {}) => ({ chatId: '-100', tekst, replyTo: '500', tko: 'Vlasnik (uid:7)', dopusten: true, ...over })

  test('„zadatak" kao odgovor na obavijest → zadatak na ploči s mailom; drugi put → već otvoren', async () => {
    const { sp } = await s1()
    const { d, zadaci } = ovisnosti()
    const r = await obradiOdgovorPoste(sp, p('zadatak'), d)
    expect(r).toContain('TASK-1')
    expect(zadaci).toHaveLength(1)
    expect(zadaci[0].title).toContain('Ponuda 2')
    expect(zadaci[0].description).toContain('ana@primjer.test')
    expect(zadaci[0].description).toContain('Molim ponudu za 10 komada.')
    expect(zadaci[0].tags).toContain('email')
    expect(zadaci[0].assignee).toBe('inzenjer')
    expect(sp.ucitaj().poruke['500'].odluka).toMatchObject({ radnja: 'zadatak', taskId: 'TASK-1' })
    const r2 = await obradiOdgovorPoste(sp, p('Zadatak'), d)
    expect(r2).toContain('TASK-1')
    expect(zadaci).toHaveLength(1)
  })

  test('„ignoriraj" → zabilježeno, bez zadatka i bez slanja', async () => {
    const { sp } = await s1()
    const { d, zadaci, odgovori } = ovisnosti()
    const r = await obradiOdgovorPoste(sp, p('ignoriraj'), d)
    expect(r).toMatch(/ignorir/i)
    expect(zadaci).toHaveLength(0)
    expect(odgovori).toHaveLength(0)
    expect(sp.ucitaj().poruke['500'].odluka?.radnja).toBe('ignoriraj')
  })

  test('„odgovori: …" → odgovor pošiljatelju (Re: predmet, In-Reply-To), trag u zadatku ako postoji', async () => {
    const { sp } = await s1()
    const { d, odgovori, biljeske } = ovisnosti()
    await obradiOdgovorPoste(sp, p('zadatak'), d)
    const r = await obradiOdgovorPoste(sp, p('odgovori: Hvala, javljamo se sutra.'), d)
    expect(r).toMatch(/poslan/)
    expect(odgovori).toEqual([{ prima: 'ana@primjer.test', predmet: 'Re: Ponuda 2', tekst: 'Hvala, javljamo se sutra.', uOdgovorNa: '<abc@primjer.test>' }])
    expect(biljeske[0]).toMatchObject({ id: 'TASK-1' })
    expect(biljeske[0].tekst).toContain('Hvala, javljamo se sutra.')
  })

  test('nedopušten korisnik ne odlučuje — ni zadatka ni slanja', async () => {
    const { sp } = await s1()
    const { d, zadaci, odgovori } = ovisnosti()
    const r = await obradiOdgovorPoste(sp, p('odgovori: bok', { dopusten: false }), d)
    expect(r).toMatch(/⛔/)
    expect(await obradiOdgovorPoste(sp, p('zadatak', { dopusten: false }), d)).toMatch(/⛔/)
    expect(zadaci).toHaveLength(0)
    expect(odgovori).toHaveLength(0)
  })

  test('poruka koja nije odgovor na obavijest o pošti → null (ide dalje svojim putem)', async () => {
    const { sp } = await s1()
    const { d } = ovisnosti()
    expect(await obradiOdgovorPoste(sp, p('zadatak', { replyTo: '999' }), d)).toBeNull()
    expect(await obradiOdgovorPoste(sp, p('zadatak', { replyTo: undefined }), d)).toBeNull()
  })

  test('bez reply-a: „mail 2 zadatak" pogađa mail po UID-u', async () => {
    const { sp } = await s1()
    const { d, zadaci } = ovisnosti()
    const r = await obradiOdgovorPoste(sp, p('mail 2 zadatak', { replyTo: undefined }), d)
    expect(r).toContain('TASK-1')
    expect(zadaci).toHaveLength(1)
  })

  test('nepoznata naredba na obavijest → kratka pomoć, ništa se ne izvršava', async () => {
    const { sp } = await s1()
    const { d, zadaci } = ovisnosti()
    const r = await obradiOdgovorPoste(sp, p('što je ovo?'), d)
    expect(r).toMatch(/zadatak/)
    expect(zadaci).toHaveLength(0)
  })

  test('slanje odgovora palo → poruka s razlogom, odluka nije „poslano"', async () => {
    const { sp } = await s1()
    const { d } = ovisnosti()
    const r = await obradiOdgovorPoste(sp, p('odgovori: x'), { ...d, posaljiOdgovor: async () => ({ ok: false, greska: 'SMTP pao' }) })
    expect(r).toContain('SMTP pao')
    expect(sp.ucitaj().poruke['500'].odluka?.radnja).not.toBe('odgovori')
  })
})

describe('spremište', () => {
  test('datotečno spremište: zapis pa čitanje, pokvarena datoteka = zadano stanje', () => {
    const sp = datotecnoSpremiste(join(mapa, 'posta.json'))
    expect(sp.ucitaj()).toEqual({ ...ZADANO_STANJE_POSTE, poruke: {} })
    const s: StanjePoste = { ...sp.ucitaj(), uidValidity: '5', zadnji: 7 }
    sp.zapisi(s)
    expect(sp.ucitaj()).toMatchObject({ uidValidity: '5', zadnji: 7 })
  })
})

describe('sposobnosti → neobavezne ovisnosti (uputa #200)', () => {
  const { potrebneOvisnosti, nedostaju } = require('../src/Sposobnosti')
  test('e-pošta oba smjera traži nodemailer + imapflow + mailparser; isključena ne traži ništa', () => {
    const sve = potrebneOvisnosti({ email: { ...CFG, smjer: 'oba' } }).flatMap((p: any) => p.paketi)
    expect(sve).toEqual(['nodemailer', 'imapflow', 'mailparser'])
    expect(potrebneOvisnosti({ email: { ...CFG, ukljucen: false } })).toEqual([])
    expect(potrebneOvisnosti({ email: { ...CFG, smjer: 'izlaz' } }).flatMap((p: any) => p.paketi)).toEqual(['nodemailer'])
  })
  test('nedostaju: samo ono što se ne razrješava', () => {
    const p = [{ sposobnost: 'x', paketi: ['a', 'b'] }]
    expect(nedostaju(p, '/', (ime: string) => ime === 'a')).toEqual(['b'])
  })
  test('u ovom paketu su sve tri knjižnice razrješive (optionalDependencies + bun.lock)', () => {
    expect(nedostaju(potrebneOvisnosti({ email: { ...CFG, smjer: 'oba' } }), join(import.meta.dir, '..'))).toEqual([])
  })
})
