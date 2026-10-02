/**
 * Rječnici sučelja u paketu — TASK-4719 (prijenos nalaza TASK-4713 u samostalni paket).
 *
 * TASK-4713 je pokazao klasu kvara koja se ne vidi na kodu: mehanizam isporuke prenese
 * `TaskWebUI.ts`, a `locales/` i `config/jezik.json` tiho ispadnu. Ploča se digne, `/health`
 * vrati 200, instalacija javi „U REDU" — a izbornik jezika na čvoru ne postoji.
 *
 * Zato provjera NE gleda tekst skripti nego stanje na disku, i to po istom ugovoru po kojem
 * ga čita `TaskWebUI.ts`:
 *   LOCALES_DIR  = <korijen>/locales           (redak 10286)
 *   zadani jezik = <korijen>/config/jezik.json (redak 10296)
 *   podloga      = <korijen>/locales/en.json   (redak 10332)
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { provjeriRjecnike } from '../src/core/Rjecnici'

const KORIJEN = join(import.meta.dir, '..')

function privremeniKorijen(): string {
  return mkdtempSync(join(tmpdir(), 'tmai-rjecnici-'))
}

function napravi(korijen: string, put: string, sadrzaj: string): void {
  const puna = join(korijen, put)
  mkdirSync(join(puna, '..'), { recursive: true })
  writeFileSync(puna, sadrzaj)
}

describe('provjeriRjecnike — ugovor s TaskWebUI.ts', () => {
  test('potpun raspored prolazi bez greške', () => {
    const k = privremeniKorijen()
    try {
      napravi(k, 'locales/hr.json', JSON.stringify({ a: 'a', b: 'b' }))
      napravi(k, 'locales/en.json', JSON.stringify({ a: 'a', b: 'b' }))
      napravi(k, 'config/jezik.json', JSON.stringify({ zadani: 'en' }))
      const nalaz = provjeriRjecnike(k)
      expect(nalaz.greske).toEqual([])
      expect(nalaz.upozorenja).toEqual([])
      expect(nalaz.jezici).toEqual(['en', 'hr'])
    } finally { rmSync(k, { recursive: true, force: true }) }
  })

  test('mapa locales/ koja je ispala iz prijenosa je GREŠKA (kvar TASK-4713)', () => {
    const k = privremeniKorijen()
    try {
      napravi(k, 'config/jezik.json', JSON.stringify({ zadani: 'hr' }))
      const nalaz = provjeriRjecnike(k)
      expect(nalaz.greske.length).toBeGreaterThan(0)
      expect(nalaz.greske.join(' ')).toContain('locales')
      expect(nalaz.jezici).toEqual([])
    } finally { rmSync(k, { recursive: true, force: true }) }
  })

  test('prazna mapa locales/ je GREŠKA, ne tiho „nula jezika"', () => {
    const k = privremeniKorijen()
    try {
      mkdirSync(join(k, 'locales'), { recursive: true })
      napravi(k, 'config/jezik.json', JSON.stringify({ zadani: 'hr' }))
      expect(provjeriRjecnike(k).greske.join(' ')).toContain('nijedan rječnik')
    } finally { rmSync(k, { recursive: true, force: true }) }
  })

  test('rječnik koji nije ispravan JSON je GREŠKA', () => {
    const k = privremeniKorijen()
    try {
      napravi(k, 'locales/en.json', '{ ovo nije json')
      napravi(k, 'config/jezik.json', JSON.stringify({ zadani: 'en' }))
      expect(provjeriRjecnike(k).greske.join(' ')).toContain('en.json')
    } finally { rmSync(k, { recursive: true, force: true }) }
  })

  test('zadani jezik koji nema svoj rječnik je GREŠKA (izbornik pokaže ključeve)', () => {
    const k = privremeniKorijen()
    try {
      napravi(k, 'locales/hr.json', JSON.stringify({ a: 'a' }))
      napravi(k, 'locales/en.json', JSON.stringify({ a: 'a' }))
      napravi(k, 'config/jezik.json', JSON.stringify({ zadani: 'de' }))
      expect(provjeriRjecnike(k).greske.join(' ')).toContain('de')
    } finally { rmSync(k, { recursive: true, force: true }) }
  })

  test('nedostatak config/jezik.json NIJE greška — TaskWebUI pada na hrvatski', () => {
    const k = privremeniKorijen()
    try {
      napravi(k, 'locales/hr.json', JSON.stringify({ a: 'a' }))
      napravi(k, 'locales/en.json', JSON.stringify({ a: 'a' }))
      const nalaz = provjeriRjecnike(k)
      expect(nalaz.greske).toEqual([])
      expect(nalaz.upozorenja.join(' ')).toContain('jezik.json')
    } finally { rmSync(k, { recursive: true, force: true }) }
  })

  test('en.json bez podloge je GREŠKA — prijevod pada na prazan panel', () => {
    const k = privremeniKorijen()
    try {
      napravi(k, 'locales/hr.json', JSON.stringify({ a: 'a' }))
      napravi(k, 'config/jezik.json', JSON.stringify({ zadani: 'hr' }))
      expect(provjeriRjecnike(k).greske.join(' ')).toContain('en.json')
    } finally { rmSync(k, { recursive: true, force: true }) }
  })

  test('ključ koji postoji u hr a nema ga u en je UPOZORENJE, ne greška', () => {
    const k = privremeniKorijen()
    try {
      napravi(k, 'locales/hr.json', JSON.stringify({ a: 'a', b: 'b' }))
      napravi(k, 'locales/en.json', JSON.stringify({ a: 'a' }))
      napravi(k, 'config/jezik.json', JSON.stringify({ zadani: 'en' }))
      const nalaz = provjeriRjecnike(k)
      expect(nalaz.greske).toEqual([])
      expect(nalaz.upozorenja.join(' ')).toContain('b')
    } finally { rmSync(k, { recursive: true, force: true }) }
  })
})

describe('paket na disku — jesu li TASK-4709/4710/4720 doista stigli', () => {
  test('vlastiti raspored paketa prolazi provjeru', () => {
    const nalaz = provjeriRjecnike(KORIJEN)
    expect(nalaz.greske).toEqual([])
    expect(nalaz.jezici).toContain('hr')
    expect(nalaz.jezici).toContain('en')
  })

  test('rječnici nose i18n ključeve kartice Config (TASK-4710 + TASK-4720)', () => {
    for (const kod of ['hr', 'en']) {
      const put = join(KORIJEN, 'locales', `${kod}.json`)
      const rj = JSON.parse(require('fs').readFileSync(put, 'utf-8')) as Record<string, string>
      const cfg = Object.keys(rj).filter((k) => k.startsWith('cfg_'))
      expect(cfg.length).toBeGreaterThan(100)
    }
  })

  test('ploča i DezurniConfig nose kod TASK-4709/4710/4721 (a ne stari popis)', () => {
    const fs = require('fs')
    const ui = fs.readFileSync(join(KORIJEN, 'src/TaskWebUI.ts'), 'utf-8') as string
    // TASK-4721: prevoditelj više nije po kartici (`_dezT`) nego zajednički za CIJELU ploču
    // (`_T`/`_Tv`). Bez njega su svi tabovi opet tvrdi hrvatski tekst.
    expect(ui).not.toContain('_dezT(')
    expect(ui.split('_T(').length - 1).toBeGreaterThan(200)
    expect(ui.split('_Tv(').length - 1).toBeGreaterThan(50)
    const dez = fs.readFileSync(join(KORIJEN, 'src/DezurniConfig.ts'), 'utf-8') as string
    // TASK-4709: davatelji se IZVODE iz model-config.json, tvrdi popis je samo zadana vrijednost.
    expect(dez).toContain('export function davateljiDezurnog')
    expect(dez).toContain('export function upotrebljiviProvideri')
  })

  // Alat prijenosa je interni i namjerno nije u gitu (.gitignore) — u svježem klonu ga nema,
  // pa se provjera preskače umjesto da padne (TASK-5011).
  test.skipIf(!existsSync(join(KORIJEN, 'scripts/uskladi_s_regocem.sh')))(
    'prijenos iz žive instalacije ne smije ispustiti rječnike (TASK-4713)', () => {
    const skripta = require('fs')
      .readFileSync(join(KORIJEN, 'scripts/uskladi_s_regocem.sh'), 'utf-8') as string
    expect(skripta).toContain('TaskManagerMD/locales/')
    expect(skripta).toContain('config/jezik.json')
  })

  test('instalacija provjerava rječnike prije nego javi „U REDU"', () => {
    const skripta = require('fs')
      .readFileSync(join(KORIJEN, 'scripts/install.sh'), 'utf-8') as string
    expect(skripta).toContain('provjeri-rjecnike.ts')
    expect(existsSync(join(KORIJEN, 'scripts/provjeri-rjecnike.ts'))).toBe(true)
  })
})
