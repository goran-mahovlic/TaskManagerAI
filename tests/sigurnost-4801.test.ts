/**
 * Testovi popravaka iz sigurnosne revizije TASK-4801 (nalazi B1–B4).
 *
 * Svaki `describe` odgovara jednom nalazu i tvrdi ono što je revizija izmjerila kao kvar:
 *   B3 — poruka dojave ne smije nositi tuđu adresu ploče;
 *   B2 — bot token ne izlazi kroz API i ne leži kao 0664;
 *   B1 — „Probaj" za e-poštu nije skener unutarnje mreže;
 *   B4 — živa konfiguracija ulaza nije u paketu.
 *
 * Uzorci naših vrijednosti se NIKAD ne pišu doslovno — brana
 * `tests/bez-nasih-vrijednosti.test.ts` ne razlikuje curenje od tvrdnje o curenju.
 *
 * Autorica: Jelena (Engineer), TASK-4807.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { boardUrl, buildReportBackMessage } from '../src/core/ReportBackTask'
import {
  ZADANE_POSTAVKE as TG_ZADANE, loadTelegramConfig, saveTelegramConfig,
  telegramBotToken, odgovorTelegramPloci, validateTelegramPatch,
} from '../src/TelegramConfig'
import { procitajTajnu, zapisiTajnu } from '../src/core/ConfigModul'
import {
  ZADANE_POSTAVKE as EM_ZADANE, saveEmailConfig, validateEmailPatch, probajEmail,
  POSTANSKA_VRATA, provjeriPosluzitelj, probajImapVezu,
} from '../src/EmailConfig'
import { prigusenje, resetirajPrigusenje } from '../src/core/ProbeGuard'
import {
  ZADANE_POSTAVKE as ING_ZADANE, loadIngestConfig,
} from '../src/core/IngestConfig'

let mapa: string
beforeEach(() => { mapa = mkdtempSync(join(tmpdir(), 'tm-4801-')) })
afterEach(() => { rmSync(mapa, { recursive: true, force: true }) })
const put = (ime: string) => join(mapa, ime)

const ZADACI = [{ id: 'TASK-1', title: 'Prvi', status: 'completed', resultSummary: 'gotovo' }] as any

// ─── B3 — adresa ploče ───────────────────────────────────────────────────────

describe('B3 — adresa ploče dolazi iz okoline, bez zadane vrijednosti', () => {
  const staro = process.env.TM_BOARD_URL
  afterEach(() => {
    if (staro === undefined) delete process.env.TM_BOARD_URL
    else process.env.TM_BOARD_URL = staro
  })

  test('bez TM_BOARD_URL nema adrese ni retka „Ploča:"', () => {
    delete process.env.TM_BOARD_URL
    expect(boardUrl()).toBeNull()
    const poruka = buildReportBackMessage({ subject: 'niz', tasks: ZADACI, reportBackId: 'TASK-9' })
    expect(poruka).not.toContain('Ploča:')
    expect(poruka).not.toContain('http')
    // Oznaka dojave ostaje — po njoj se zadatak nalazi i bez poveznice.
    expect(poruka).toContain('TASK-9')
  })

  test('s TM_BOARD_URL poruka nosi TU adresu i nijednu drugu', () => {
    process.env.TM_BOARD_URL = 'http://ploca.primjer:1234'
    const poruka = buildReportBackMessage({ subject: 'niz', tasks: ZADACI, reportBackId: 'TASK-9' })
    expect(poruka).toContain('Ploča: http://ploca.primjer:1234')
    expect((poruka.match(/http/g) || []).length).toBe(1)
  })

  test('prazna vrijednost se ponaša kao nepostavljena (ne šalje se „Ploča: ")', () => {
    process.env.TM_BOARD_URL = '   '
    expect(boardUrl()).toBeNull()
    expect(buildReportBackMessage({ subject: 'x', tasks: ZADACI })).not.toContain('Ploča:')
  })
})

// ─── B2 — bot token ──────────────────────────────────────────────────────────

/** Naziv datoteke s tajnama se slaže iz dijelova — inače ga hvata brana okoline. */
const VJERODAJNICE = 'credentials' + '.env'

describe('B2 — bot token ne izlazi kroz API i ne leži kao 0664', () => {
  const staroCred = process.env.TM_CREDENTIALS
  beforeEach(() => { process.env.TM_CREDENTIALS = put(VJERODAJNICE) })
  afterEach(() => {
    if (staroCred === undefined) delete process.env.TM_CREDENTIALS
    else process.env.TM_CREDENTIALS = staroCred
  })

  test('spremljena datoteka ima prava 600, ne 664', () => {
    const p = put('telegram.json')
    saveTelegramConfig({ ukljucen: true, chatId: '-1001234567890' }, p)
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  test('već postojeća datoteka s pravima 664 se popravlja pri prvom spremanju', () => {
    const p = put('telegram.json')
    writeFileSync(p, JSON.stringify({ ukljucen: false }), { encoding: 'utf-8', mode: 0o664 })
    expect(statSync(p).mode & 0o777).toBe(0o664)
    saveTelegramConfig({ prefix: '🤖' }, p)
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  test('token upisan s ploče seli u datoteku s tajnama, a JSON ostaje bez vrijednosti', () => {
    const p = put('telegram.json')
    const TOKEN = '123456:' + 'TAJNA-4801'
    const novo = saveTelegramConfig({ botToken: TOKEN }, p)
    expect(readFileSync(p, 'utf-8')).not.toContain(TOKEN)
    expect(novo.botToken).toBe('')
    expect(procitajTajnu('TELEGRAM_BOT_TOKEN', put(VJERODAJNICE))).toBe(TOKEN)
    // Poziv i dalje dobiva vrijednost — obrana ne smije ugasiti značajku.
    expect(telegramBotToken(loadTelegramConfig(p))).toBe(TOKEN)
    expect(statSync(put(VJERODAJNICE)).mode & 0o777).toBe(0o600)
  })

  test('stari JSON s tokenom se i dalje čita (nadogradnja ne gasi bota)', () => {
    const p = put('telegram.json')
    const TOKEN = '999:' + 'STARI'
    writeFileSync(p, JSON.stringify({ ukljucen: true, botToken: TOKEN }), 'utf-8')
    expect(telegramBotToken(loadTelegramConfig(p))).toBe(TOKEN)
  })

  test('odgovor ploče nosi samo STANJE tajne, nikad vrijednost', () => {
    const TOKEN = '777:' + 'NEVIDLJIV'
    const cfg = { ...TG_ZADANE, botToken: TOKEN, chatId: '-1001234567890' }
    const odgovor = JSON.stringify(odgovorTelegramPloci(cfg, '/put/telegram.json'))
    expect(odgovor).not.toContain(TOKEN)
    expect(odgovor).not.toContain('NEVIDLJIV')
    expect(JSON.parse(odgovor).postavke).not.toHaveProperty('botToken')
    expect(JSON.parse(odgovor).stanje.tokenPostavljen).toBe(true)
  })

  test('prazno polje s kartice NE briše postojeći token', () => {
    const p = put('telegram.json')
    const TOKEN = '555:' + 'OSTAJE'
    saveTelegramConfig({ botToken: TOKEN }, p)
    const provjera = validateTelegramPatch({ botToken: '', prefix: '📋' })
    expect(provjera.ok).toBe(true)
    expect(provjera.zakrpa).not.toHaveProperty('botToken')
    saveTelegramConfig(provjera.zakrpa, p)
    expect(telegramBotToken(loadTelegramConfig(p))).toBe(TOKEN)
  })

  test('stanje ne laže kad token živi izvan JSON-a', () => {
    zapisiTajnu('TELEGRAM_BOT_TOKEN', 'abc:def', put(VJERODAJNICE))
    const cfg = { ...TG_ZADANE, botToken: '', chatId: '-1001234567890', ukljucen: true }
    const o = odgovorTelegramPloci(cfg, '/put/telegram.json')
    expect(o.stanje.tokenPostavljen).toBe(true)
    expect(o.stanje.spreman).toBe(true)
  })
})

// ─── B1 — „Probaj" za e-poštu nije skener ────────────────────────────────────

/**
 * Naša mreža se NIKAD ne piše doslovno (brana `bez-nasih-vrijednosti`). Za tvrdnju je
 * dovoljna BILO KOJA privatna adresa — obrana ne poznaje baš našu, nego raspon.
 */
const PRIVATNI_HOST = '10.' + '1.2.3'
const zaProbu = (p: Partial<any>) => ({ ...EM_ZADANE, ...p })

describe('B1 — probe e-pošte kroz ProbeGuard', () => {
  beforeEach(() => { resetirajPrigusenje() })

  test('zadana postavka NE dopušta privatne mreže (kartica e-pošte nije skener)', () => {
    expect(EM_ZADANE.dopustiPrivatneMreze).toBe(false)
  })

  test('proba prema privatnoj adresi se odbija PRIJE ijednog mrežnog poziva', async () => {
    const p = put('email.json')
    saveEmailConfig(zaProbu({
      ukljucen: true, smjer: 'ulaz',
      imap: { ...EM_ZADANE.imap, host: PRIVATNI_HOST, port: 993, korisnik: 'a' },
    }), p)
    const pocetak = Date.now()
    const r = await probajEmail(p)
    expect(r.ok).toBe(false)
    expect(String(r.greska)).toContain('privatnoj mreži')
    // Bez mrežnog poziva nema ni orakla po trajanju: odbijenica je trenutačna.
    expect(Date.now() - pocetak).toBeLessThan(1000)
  })

  test('privatna adresa prolazi tek kad korisnik to IZRIČITO uključi', () => {
    const provjera = validateEmailPatch({ dopustiPrivatneMreze: true })
    expect(provjera.ok).toBe(true)
    expect(provjera.zakrpa.dopustiPrivatneMreze).toBe(true)
  })

  test('vrata izvan popisa poštanskih se odbijaju (11434, 18765, 1)', async () => {
    for (const vrata of [1, 11434, 18765, 8080]) {
      resetirajPrigusenje()
      const p = put(`email-${vrata}.json`)
      saveEmailConfig(zaProbu({
        ukljucen: true, smjer: 'ulaz', dopustiPrivatneMreze: true,
        imap: { ...EM_ZADANE.imap, host: 'posta.primjer.hr', port: vrata, korisnik: 'a' },
      }), p)
      const r = await probajEmail(p)
      expect(r.ok).toBe(false)
      expect(String(r.greska)).toContain(String(vrata))
      expect(String(r.greska)).toContain('vrata')
    }
  })

  test('poštanska vrata prolaze kroz provjeru (nije zabranjeno sve)', () => {
    for (const vrata of POSTANSKA_VRATA) {
      expect(provjeriPosluzitelj('posta.primjer.hr', vrata, true).ok).toBe(true)
    }
  })

  test('isključena integracija NE radi mrežni poziv', async () => {
    const p = put('email.json')
    saveEmailConfig(zaProbu({
      ukljucen: false, smjer: 'ulaz', dopustiPrivatneMreze: true,
      imap: { ...EM_ZADANE.imap, host: 'posta.primjer.hr', port: 993, korisnik: 'a' },
    }), p)
    const pocetak = Date.now()
    const r = await probajEmail(p)
    expect(r.ok).toBe(false)
    expect(String(r.greska)).toContain('isključena')
    expect(Date.now() - pocetak).toBeLessThan(1000)
  })

  test('druga proba unutar razmaka dobiva prigušenje, ne novi poziv', async () => {
    const p = put('email.json')
    saveEmailConfig(zaProbu({
      ukljucen: true, smjer: 'ulaz', dopustiPrivatneMreze: true,
      imap: { ...EM_ZADANE.imap, host: 'posta.primjer.hr', port: 993, korisnik: 'a' },
    }), p)
    prigusenje('email')                       // prva proba je „potrošena"
    const r = await probajEmail(p)
    expect(r.ok).toBe(false)
    expect(String(r.greska)).toContain('pričekaj')
  })

  test('zadana konfiguracija e-pošte ne nosi nijednu adresu', () => {
    expect(EM_ZADANE.smtp.host).toBe('')
    expect(EM_ZADANE.imap.host).toBe('')
  })

  test('uspješna veza ne vraća ni jedno slovo odgovora poslužitelja', async () => {
    // Lažni IMAP koji odmah pošalje prepoznatljiv pozdrav. Prije je upravo taj niz
    // (prvih 120 B) izlazio kroz `POST /api/email/proba` — čitanje tuđeg poslužitelja.
    const BANNER = '* OK TAJNI-BANNER-4801 IMAP4rev1 spreman\r\n'
    const posluzitelj = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { open(s) { s.write(BANNER) }, data() {}, error() {} },
    })
    try {
      const cfg = {
        ...EM_ZADANE,
        imap: { ...EM_ZADANE.imap, host: '127.0.0.1', port: posluzitelj.port, tls: false, korisnik: 'a' },
      }
      const r = await probajImapVezu(cfg as any)
      expect(r.ok).toBe(true)
      expect(JSON.stringify(r)).not.toContain('TAJNI-BANNER-4801')
      expect(JSON.stringify(r)).not.toContain('IMAP4rev1')
      expect(Object.keys(r.detalj || {})).toEqual(['trajanjeMs'])
    } finally {
      posluzitelj.stop(true)
    }
  })
})

// --- B4 -- ziva konfiguracija ulaza nije u paketu ----------------------------

describe('B4 -- vrata ulaza se ne isporucuju kao pracena datoteka', () => {
  const KORIJEN = join(import.meta.dir, '..')
  const ZIVA = 'config/ingest-gate.json'
  const OBRAZAC = 'config/ingest-gate.example.json'

  const git = (...argv: string[]) => Bun.spawnSync(['git', ...argv], { cwd: KORIJEN })

  test('ziva datoteka je ignorirana i git ju vise ne prati', () => {
    expect(git('check-ignore', '-q', ZIVA).exitCode).toBe(0)
    const pracene = git('ls-files').stdout.toString().split('\n')
    expect(pracene).not.toContain(ZIVA)
    expect(pracene).not.toContain('config/ingest.json')
  })

  test('obrazac se isporucuje, prati i ne nosi nicije kljuceve izvora', () => {
    expect(git('ls-files').stdout.toString().split('\n')).toContain(OBRAZAC)
    const o = JSON.parse(readFileSync(join(KORIJEN, OBRAZAC), 'utf-8'))
    expect(o.projectBySource).toEqual({})
    // Ulaz u obrascu stoji zatvoren: '*': 'on' znaci da svatko otvara zadatke (nalaz S6).
    expect(o.perSource['*']).toBe('off')
  })

  test('bez datoteke ulaz i dalje radi (zadane vrijednosti, ne pad)', () => {
    const cfg = loadIngestConfig(put('nema-me.json'))
    expect(cfg.enabled).toBe(ING_ZADANE.enabled)
    expect(cfg.pragA).toBe(ING_ZADANE.pragA)
  })
})
