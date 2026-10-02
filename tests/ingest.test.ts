/**
 * Testovi generičkog ulaza `POST /api/ingest` (U6).
 *
 * Pišu se PRIJE izvedbe (TDD): svaka tvrdnja ovdje je jedan prihvatni kriterij iz
 * razrade §1 (položaji), §2 (pragovi) i §4 (koraci) — ali bez ijedne riječi o Telegramu.
 * Telegram, e-pošta i konzola su ovdje samo vrijednosti polja `source`.
 *
 *   bun test tests/ingest.test.ts
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  ZADANE_POSTAVKE, loadIngestConfig, saveIngestConfig, validateIngestPatch,
  nacinZaIzvor, projektZaIzvor, kljuceviIzvora,
} from '../src/core/IngestConfig'
import {
  validirajZahtjev, ocistiTekst, jeObicnoPitanje, procijeniIngest, zapisiUlaz,
  MAX_TEKST,
} from '../src/core/Ingest'
import { ucitajKorake, renderirajOpis, PREDLOSCI_DIR } from '../src/core/IngestTemplate'

// ─── pomoćno ────────────────────────────────────────────────────────────────

let tmp = ''
// TASK-5011: na svježem stroju `~/.tmp` ne postoji — mkdtemp ne stvara roditelja.
const TMP_KORIJEN = join(process.env.HOME || '/tmp', '.tmp')
beforeEach(() => { mkdirSync(TMP_KORIJEN, { recursive: true }); tmp = mkdtempSync(join(TMP_KORIJEN, 'ingest-test-')) })
afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* */ } })

const cfg = (over: Record<string, unknown> = {}) => ({
  ...ZADANE_POSTAVKE,
  perSource: { '*': 'on' as const },
  projectBySource: {},
  ...over,
})

// Poruke poznatih razreda — vrijednosti su MJERENE, ne pretpostavljene (v. testove niže).
const PORUKA_E1 = 'bok'
const PORUKA_ZADATAK = 'Popravi grešku u prikazu troška na kartici projekta.'
const PORUKA_LANAC =
  'Napravi novi modul za izvoz izvještaja, dodaj testove, dokumentiraj u docs/API.md ' +
  'i pripremi migraciju baze; treba i analiza postojećih podataka.'

// ─── 1. Postavke: config/ingest-gate.json, generički ključevi ───────────────

describe('IngestConfig — postavke uz TM_HOME/TM_AGENTS', () => {
  test('nepostojeća datoteka daje zadane postavke, ne iznimku', () => {
    const p = loadIngestConfig(join(tmp, 'nema.json'))
    expect(p.pragA).toBe(ZADANE_POSTAVKE.pragA)
    expect(p.enabled).toBe(ZADANE_POSTAVKE.enabled)
  })

  test('pokvaren JSON daje zadane postavke (vrata ne smiju srušiti pozivatelja)', () => {
    const f = join(tmp, 'lose.json')
    writeFileSync(f, '{ ovo nije json')
    expect(loadIngestConfig(f).pragB).toBe(ZADANE_POSTAVKE.pragB)
  })

  test('ključ izvora ide od najužeg prema najširem', () => {
    expect(kljuceviIzvora('telegram', '-1001234567890'))
      .toEqual(['telegram:-1001234567890', '-1001234567890', 'telegram', '*'])
    expect(kljuceviIzvora('email', '')).toEqual(['email', '*'])
  })

  test('način se bira po najužem ključu koji postoji', () => {
    const c = cfg({
      enabled: true,
      perSource: { 'telegram:-1': 'on', telegram: 'shadow', '*': 'off' },
    })
    expect(nacinZaIzvor(c as any, 'telegram', '-1')).toBe('on')
    expect(nacinZaIzvor(c as any, 'telegram', '-2')).toBe('shadow')
    expect(nacinZaIzvor(c as any, 'email', '')).toBe('off')
  })

  test('globalna sklopka enabled=false gasi sve izvore', () => {
    const c = cfg({ enabled: false, perSource: { '*': 'on' } })
    expect(nacinZaIzvor(c as any, 'telegram', '-1')).toBe('off')
  })

  test('stari zapis (perGroup/projectByGroup) i dalje radi', () => {
    const f = join(tmp, 'staro.json')
    writeFileSync(f, JSON.stringify({
      enabled: true,
      perGroup: { '-1001234567890': 'on' },
      projectByGroup: { '-1001234567890': 'PRJ-010' },
    }))
    const p = loadIngestConfig(f)
    expect(nacinZaIzvor(p, 'telegram', '-1001234567890')).toBe('on')
    expect(projektZaIzvor(p, 'telegram', '-1001234567890')).toBe('PRJ-010')
    // Ploča čita `perGroup` — zrcalo mora ostati da sučelje ne pukne.
    expect(p.perGroup['-1001234567890']).toBe('on')
  })

  test('zakrpa odbija nepoznato polje i obrnut poredak pragova', () => {
    expect(validateIngestPatch({ pragovi: 5 }).ok).toBe(false)
    expect(validateIngestPatch({ pragB: 5 }, cfg({ pragA: 16 }) as any).ok).toBe(false)
    expect(validateIngestPatch({ pragB: 40 }, cfg() as any).ok).toBe(true)
  })

  test('spremanje je atomarno i vraća spojene postavke', () => {
    const f = join(tmp, 'ingest-gate.json')
    const p = saveIngestConfig({ pragA: 20 }, f)
    expect(p.pragA).toBe(20)
    expect(JSON.parse(readFileSync(f, 'utf-8')).pragA).toBe(20)
  })
})

// ─── 2. Ulaz: polja source/externalId/replyTo/text/senderName ────────────────

describe('Ingest — provjera zahtjeva', () => {
  test('bez izvora ili bez teksta zahtjev pada', () => {
    expect(validirajZahtjev({ text: 'nešto' }).ok).toBe(false)
    expect(validirajZahtjev({ source: 'email' }).ok).toBe(false)
    expect(validirajZahtjev({ source: 'email', text: '   ' }).ok).toBe(false)
  })

  test('prihvaća bilo koji izvor — ništa nije vezano uz Telegram', () => {
    for (const source of ['telegram', 'email', 'konzola', 'sms', 'web-forma']) {
      const r = validirajZahtjev({ source, text: 'Popravi grešku u izvozu.' })
      expect(r.ok).toBe(true)
      expect(r.zahtjev!.source).toBe(source)
    }
  })

  test('neispravan naziv izvora se odbija (ide u ključ postavki i u oznaku)', () => {
    expect(validirajZahtjev({ source: 'e mail', text: 'x y z' }).ok).toBe(false)
    expect(validirajZahtjev({ source: '../../etc', text: 'x y z' }).ok).toBe(false)
  })

  test('predugačak tekst se odbija s jasnim razlogom', () => {
    const r = validirajZahtjev({ source: 'email', text: 'a'.repeat(MAX_TEKST + 1) })
    expect(r.ok).toBe(false)
    expect(r.greske.join(' ')).toContain('text')
  })

  test('externalId, replyTo i senderName su neobavezni i ne mijenjaju ishod', () => {
    const r = validirajZahtjev({
      source: 'email', text: 'Popravi grešku u izvozu.',
      externalId: 'inbox-42', replyTo: 'korisnik@example.com', senderName: 'Korisnik',
    })
    expect(r.ok).toBe(true)
    expect(r.zahtjev!.replyTo).toBe('korisnik@example.com')
    expect(r.zahtjev!.senderName).toBe('Korisnik')
  })
})

// ─── 3. Čišćenje i prag A ───────────────────────────────────────────────────

describe('Ingest — prag A', () => {
  test('biljezi pozivatelja se skidaju prije ocjene', () => {
    expect(ocistiTekst('[OD: Korisnik (uid:1)] Popravi  ovo')).toBe('Popravi ovo')
    expect(ocistiTekst('[PRETHODNI KONTEKST xyz] pitanje?')).toBe('pitanje?')
  })

  test('obično pitanje ne otvara zadatak', () => {
    expect(jeObicnoPitanje('Zašto se mora ići u terensku provjeru?')).toBe(true)
    expect(jeObicnoPitanje('Koliko je zadataka otvoreno?')).toBe(true)
  })

  test('nalog s upitnikom NIJE obično pitanje', () => {
    expect(jeObicnoPitanje('Provjeri zašto pada test?')).toBe(false)
    expect(jeObicnoPitanje('gdje smo stali - provjeri i popravi - zašto?')).toBe(false)
    expect(jeObicnoPitanje('Možeš li dodati izvoz u CSV?')).toBe(false)
  })

  test('pozdrav ostaje ispod praga A → odgovor, ploča se ne dira', () => {
    const o = procijeniIngest({ source: 'konzola', text: PORUKA_E1 }, cfg({ enabled: true }) as any)
    expect(o.postupak).toBe('odgovor')
    expect(o.akcija).toBe('odgovor')
    expect(o.zadatak).toBeUndefined()
  })

  test('pravi zahtjev prelazi prag A → prijedlog zadatka', () => {
    const o = procijeniIngest({ source: 'email', text: PORUKA_ZADATAK }, cfg({ enabled: true }) as any)
    expect(o.akcija).toBe('zadatak')
    expect(o.tezina).toBeGreaterThanOrEqual(16)
    expect(o.zadatak!.title.length).toBeGreaterThan(0)
    expect(o.zadatak!.description).toContain('PRIJEM')
  })
})

// ─── 4. Položaji prekidača ──────────────────────────────────────────────────

describe('Ingest — položaji off/shadow/on', () => {
  test('off: zadatak se ne otvara, poziv se preskače', () => {
    const o = procijeniIngest({ source: 'email', text: PORUKA_ZADATAK },
      cfg({ enabled: true, perSource: { '*': 'off' } }) as any)
    expect(o.akcija).toBe('preskoceno')
    expect(o.zadatak).toBeUndefined()
  })

  test('shadow: ocjena postoji, zadatak ne', () => {
    const o = procijeniIngest({ source: 'email', text: PORUKA_ZADATAK },
      cfg({ enabled: true, perSource: { '*': 'shadow' } }) as any)
    expect(o.akcija).toBe('sjena')
    expect(o.zadatak).toBeUndefined()
    expect(o.tezina).toBeGreaterThan(0)
  })

  test('zapis sjene se dopisuje kao jedan redak JSON-a', () => {
    const f = join(tmp, 'ingest.jsonl')
    const o = procijeniIngest({ source: 'email', text: PORUKA_ZADATAK },
      cfg({ enabled: true, perSource: { '*': 'shadow' } }) as any)
    zapisiUlaz(o.zapis, f)
    zapisiUlaz(o.zapis, f)
    const redci = readFileSync(f, 'utf-8').trim().split('\n')
    expect(redci.length).toBe(2)
    expect(JSON.parse(redci[0]!).source).toBe('email')
  })
})

// ─── 5. Projekt (prihvatni kriterij: „zadatak s ispravnim projektom") ───────

describe('Ingest — projekt', () => {
  test('izričit projectId iz zahtjeva ima prednost', () => {
    const o = procijeniIngest(
      { source: 'email', text: PORUKA_ZADATAK, projectId: 'PRJ-099' },
      cfg({ enabled: true, projectBySource: { email: 'PRJ-001' } }) as any)
    expect(o.projectId).toBe('PRJ-099')
    expect(o.projectSource).toBe('zahtjev')
  })

  test('inače zadani projekt izvora, po najužem ključu', () => {
    const c = cfg({
      enabled: true,
      projectBySource: { 'telegram:-1': 'PRJ-010', telegram: 'PRJ-034' },
    })
    expect(procijeniIngest({ source: 'telegram', externalId: '-1', text: PORUKA_ZADATAK }, c as any).projectId)
      .toBe('PRJ-010')
    expect(procijeniIngest({ source: 'telegram', externalId: '-2', text: PORUKA_ZADATAK }, c as any).projectId)
      .toBe('PRJ-034')
  })

  test('bez ijedne postavke zadatak pada u pretinac, ali NIKAD u null', () => {
    const o = procijeniIngest({ source: 'sms', text: PORUKA_ZADATAK }, cfg({ enabled: true }) as any)
    expect(o.projectId).toBe(ZADANE_POSTAVKE.defaultProject)
    expect(o.projectSource).toBe('pretinac')
  })
})

// ─── 6. Predložak koraka iz templates/ ──────────────────────────────────────

describe('IngestTemplate — koraci iz templates/', () => {
  test('predlošci se čitaju iz templates/ mape paketa', () => {
    const koraci = ucitajKorake()
    expect(koraci.length).toBe(10)
    expect(koraci[0]!.key).toBe('prijem')
    expect(koraci[9]!.key).toBe('dojava')
    expect(PREDLOSCI_DIR.endsWith('templates')).toBe(true)
  })

  test('predložak ne spominje Telegram (kanal je postavka, ne kod)', () => {
    const tekst = readFileSync(join(PREDLOSCI_DIR, 'koraci.json'), 'utf-8')
      + readFileSync(join(PREDLOSCI_DIR, 'prvi-zadatak.md'), 'utf-8')
    expect(/telegram/i.test(tekst)).toBe(false)
  })

  test('pokvaren predložak pada na ugrađeni popis, ne ruši ulaz', () => {
    const d = join(tmp, 'prazno')
    const koraci = ucitajKorake(d)
    expect(koraci.length).toBe(10)
  })

  test('opis nosi izvor, težinu, korake i obvezu commita', () => {
    const opis = renderirajOpis({
      message: PORUKA_LANAC, weight: 65, source: 'email', externalId: 'inbox-42',
      senderName: 'Korisnik', projectId: 'PRJ-010', taskId: 'TASK-1', pragB: 36,
    })
    expect(opis).toContain('PRJ-010')
    expect(opis).toContain('email')
    expect(opis).toContain('zadatak/TASK-1')
    expect(opis).toContain('65/100')
  })

  test('„samo tekst" ne traži commit', () => {
    const opis = renderirajOpis({
      message: PORUKA_ZADATAK, weight: 20, source: 'konzola', textOnly: true, taskId: 'TASK-2',
    })
    expect(opis).toContain('samo-tekst')
  })
})

// ─── 7. Pragovi B i C (puni lanac i potvrda) ────────────────────────────────

describe('Ingest — pragovi B i C', () => {
  test('iznad praga B ide u lanac i nosi oznaku lanca', () => {
    const o = procijeniIngest({ source: 'email', text: PORUKA_LANAC },
      cfg({ enabled: true, pragA: 16, pragB: 36, pragC: 81 }) as any)
    expect(o.tezina).toBeGreaterThanOrEqual(36)
    expect(o.postupak.startsWith('lanac')).toBe(true)
    expect(o.zadatak!.tags).toContain('lanac')
  })

  test('spušten prag C traži potvrdu', () => {
    const o = procijeniIngest({ source: 'email', text: PORUKA_LANAC },
      cfg({ enabled: true, pragA: 1, pragB: 2, pragC: 3 }) as any)
    expect(o.trebaPotvrdu).toBe(true)
    expect(o.postupak).toBe('lanac-uz-potvrdu')
  })

  test('svaki zadatak nosi oznaku izvora i težine', () => {
    const o = procijeniIngest({ source: 'email', externalId: 'inbox-42', text: PORUKA_ZADATAK },
      cfg({ enabled: true }) as any)
    expect(o.zadatak!.tags).toContain('izvor:email')
    expect(o.zadatak!.tags.some(t => t.startsWith('tezina:'))).toBe(true)
    expect(o.zadatak!.createdBy).toBe('ingest:email')
  })
})
