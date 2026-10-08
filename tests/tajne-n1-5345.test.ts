/**
 * N1 (ADR-0007 §1.3, §10; kriteriji J2, J3): vrijednost tajne NE smije postati naredba ljuske.
 *
 * Spremište čita i `set -a; . spremište` (petlja maila na glavnom), pa je jedini siguran oblik
 * retka `IME='…'` (POSIX jednostruki navodnici; `'` → `'\''`). Test piše kroz PRAVI pisač,
 * učita datoteku pravom ljuskom i provjeri: (1) MARKER ne nastaje, (2) ljuska vidi točno upisani
 * niz, (3) `procitajTajnu` (i Python zrcalo) vraća isti niz.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  kljucPrisutan, kodirajRedak, parsirajRedak, postaviTajnu, ukloniKljucIzDatoteke,
} from '../src/LoginCreds'
import { procitajTajnu, tajnaPostavljena, zapisiTajnu } from '../src/core/ConfigModul'

// procitajTajnu daje prednost okolini (N4) — test mjeri datoteku, pa okolina ne smije nositi ta imena
for (const k of ['EMAIL_PASSWORD', 'SMTP_PASSWORD', 'GOLI', 'NAVOD', 'NOVI', 'IZV', 'PRAZAN', 'PRAZAN2', 'NEMA']) delete process.env[k]

const KORIJEN = mkdtempSync(join(tmpdir(), 'tm-n1-5345-'))
afterAll(() => rmSync(KORIJEN, { recursive: true, force: true }))

let mapa = ''
let f = ''
let marker = ''
beforeEach(() => {
  mapa = mkdtempSync(join(KORIJEN, 'm-'))
  f = join(mapa, 'credentials.env')
  marker = join(mapa, 'MARKER')
})

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')

/** Učitaj spremište PRAVOM ljuskom, kao petlja maila, i vrati što ljuska vidi pod imenom. */
function ljuska(putanja: string, ime: string): string {
  const r = Bun.spawnSync(['bash', '-c', `set -a; . "$1"; set +a; printf %s "\${${ime}}"`, '_', putanja],
    { stdout: 'pipe', stderr: 'pipe' })
  return new TextDecoder().decode(r.stdout)
}

function python(putanja: string, ime: string): string {
  const r = Bun.spawnSync(['python3', join(import.meta.dir, '..', 'tools', 'tajna_redak.py'), '--get', ime, '--file', putanja],
    { stdout: 'pipe', stderr: 'pipe' })
  return new TextDecoder().decode(r.stdout)
}

// `@M@` se u testu zamijeni putanjom MARKER-a u svježoj mapi
const MATRICA: [string, string][] = [
  ['$(…)', 'x$(touch @M@)'],
  ['backtick', 'x`touch @M@`'],
  ['; naredba', 'a;touch @M@'],
  ['jednostruki navodnik', "it's'"],
  ['dvostruki navodnik', 'a"b"c"'],
  ['backslash', 'a\\b\\\\c\\'],
  ['# komentar', '#nije-komentar'],
  ['= unutra', 'a=b=c'],
  ['razmak na rubu', '  rub  '],
  ['unicode', 'é€ž😀'],
  ['$VAR i ${x}', '$HOME${PATH}'],
  ['mješavina', `'"\`$(id);\\#= '`],
  ['4096 B', 'k'.repeat(4096)],
]

describe('N1 pisač: IME=\'…\' — ljuska ne izvršava vrijednost', () => {
  for (const [opis, vr] of MATRICA) {
    test(`postaviTajnu: ${opis}`, () => {
      const val = vr.split('@M@').join(marker)
      expect(postaviTajnu(f, 'EMAIL_PASSWORD', val)).toEqual({ ok: true })
      expect(ljuska(f, 'EMAIL_PASSWORD')).toBe(val)
      expect(existsSync(marker)).toBe(false)
      expect(procitajTajnu('EMAIL_PASSWORD', f)).toBe(val)
      expect(python(f, 'EMAIL_PASSWORD')).toBe(val)
      expect(kljucPrisutan(readFileSync(f, 'utf-8'), 'EMAIL_PASSWORD')).toBe(true)
      expect(statSync(f).mode & 0o777).toBe(0o600)
    })
  }

  test('zapisiTajnu (ConfigModul) ide kroz isti pisač: x$(touch MARKER) se NE izvrši', () => {
    const val = 'x$(touch ' + marker + ')'
    expect(zapisiTajnu('EMAIL_PASSWORD', val, f).ok).toBe(true)
    expect(readFileSync(f, 'utf-8')).toBe(`EMAIL_PASSWORD='x$(touch ${marker})'\n`)
    ljuska(f, 'EMAIL_PASSWORD')
    expect(existsSync(marker)).toBe(false)
    expect(procitajTajnu('EMAIL_PASSWORD', f)).toBe(val)
  })

  test('kodirajRedak: jednostruki navodnik postaje \'\\\'\'', () => {
    expect(kodirajRedak('A', "x'y")).toBe("A='x'\\''y'")
  })
})

describe('N1 pisač odbija (J3) — spremište ostaje bajt za bajt isto', () => {
  const LOSE: [string, string, string][] = [
    ['prazno', '', 'vrijednost_prazna'],
    ['\\0', 'a\0b', 'vrijednost_nedopusten_znak'],
    ['\\r', 'a\rb', 'vrijednost_nedopusten_znak'],
    ['\\n (dodatni redak BASH_ENV)', 'a\nBASH_ENV=/tmp/x', 'vrijednost_nedopusten_znak'],
    ['>4096 B (višebajtno)', 'é'.repeat(2049), 'vrijednost_preduga'],
  ]
  for (const [opis, vr, kod] of LOSE) {
    test(opis, () => {
      writeFileSync(f, "STARO='x'\n", { mode: 0o600 })
      const prije = sha(f)
      const r = postaviTajnu(f, 'GEMINI_API_KEY', vr)
      expect(r.ok).toBe(false)
      expect(r.greska).toBe(kod)
      expect(sha(f)).toBe(prije)
    })
  }

  test('neispravno ime (i RegExp-znakovi u imenu) se odbija', () => {
    writeFileSync(f, "STARO='x'\n", { mode: 0o600 })
    const prije = sha(f)
    for (const ime of ['mala', 'A.*', 'A=B', '', 'X'.repeat(70)]) {
      expect(postaviTajnu(f, ime, 'v').greska).toBe('ime_neispravno')
    }
    expect(sha(f)).toBe(prije)
  })

  test('zapisiTajnu odbija \\n i \\0 (stari API ostaje ok:false)', () => {
    expect(zapisiTajnu('SMTP_PASSWORD', 'a\nb', f).ok).toBe(false)
    expect(zapisiTajnu('SMTP_PASSWORD', 'a\0b', f).ok).toBe(false)
    expect(existsSync(f)).toBe(false)
  })
})

describe('N1 atomičnost i prava', () => {
  test('mijenja SAMO redak tog imena; ostali retci (i ne-bash smeće) ostaju bajt za bajt', () => {
    const ostalo = '# komentar\nA=goli\nnije redak ljuske\nexport B="x y"\n'
    writeFileSync(f, ostalo + 'EMAIL_PASSWORD=staro\nC=1\nEMAIL_PASSWORD=duplikat\n', { mode: 0o644 })
    expect(postaviTajnu(f, 'EMAIL_PASSWORD', 'novo').ok).toBe(true)
    expect(readFileSync(f, 'utf-8')).toBe(ostalo + "EMAIL_PASSWORD='novo'\nC=1\n")
    expect(statSync(f).mode & 0o777).toBe(0o600) // i kad je prije bila 0644
  })

  test('nema zaostalih tmp ni .bak datoteka nakon upisa', () => {
    postaviTajnu(f, 'A_KEY', '1'); postaviTajnu(f, 'A_KEY', '2'); postaviTajnu(f, 'B_KEY', '3')
    expect(readdirSync(mapa)).toEqual(['credentials.env'])
  })

  test('simbolička poveznica na mjestu spremišta → odbijeno, cilj netaknut', () => {
    const cilj = join(mapa, 'cilj.txt')
    writeFileSync(cilj, 'NETAKNUT\n')
    symlinkSync(cilj, f)
    expect(postaviTajnu(f, 'A_KEY', 'v').greska).toBe('spremiste_nije_sigurno')
    expect(readFileSync(cilj, 'utf-8')).toBe('NETAKNUT\n')
  })

  test('odjava (ukloniKljucIzDatoteke) miče novi oblik i ostavlja 0600', () => {
    postaviTajnu(f, 'GEMINI_API_KEY', "a'b")
    postaviTajnu(f, 'DRUGI_KEY', 'x')
    chmodSync(f, 0o644)
    expect(ukloniKljucIzDatoteke(f, 'GEMINI_API_KEY')).toBe(true)
    expect(readFileSync(f, 'utf-8')).toBe("DRUGI_KEY='x'\n")
    expect(statSync(f).mode & 0o777).toBe(0o600)
    expect(kljucPrisutan(readFileSync(f, 'utf-8'), 'GEMINI_API_KEY')).toBe(false)
  })
})

describe('N1 čitači: novi oblik + stari goli/navodnički (kompatibilnost)', () => {
  test('parsirajRedak', () => {
    expect(parsirajRedak("A='x'\\''y'")).toEqual({ ime: 'A', vrijednost: "x'y" })
    expect(parsirajRedak('export B="p \\"q\\" \\\\ r"')).toEqual({ ime: 'B', vrijednost: 'p "q" \\ r' })
    expect(parsirajRedak('C=goli')).toEqual({ ime: 'C', vrijednost: 'goli' })
    expect(parsirajRedak('D= s razmakom \r')).toEqual({ ime: 'D', vrijednost: 's razmakom' })
    expect(parsirajRedak("E='a b'  # komentar")).toEqual({ ime: 'E', vrijednost: 'a b' })
    expect(parsirajRedak('# F=x')).toBeNull()
    expect(parsirajRedak('nije redak')).toBeNull()
  })

  test('procitajTajnu / tajnaPostavljena / kljucPrisutan / Python zrcalo na mješovitom spremištu', () => {
    writeFileSync(f, [
      'GOLI=abc123', 'NAVOD="x y"', "NOVI='q'\\''r \\$x'", "PRAZAN=''", 'PRAZAN2=', 'export IZV=\'e\'', '',
    ].join('\n'), { mode: 0o600 })
    const t = readFileSync(f, 'utf-8')
    const ocekivano: Record<string, string | null> = {
      GOLI: 'abc123', NAVOD: 'x y', NOVI: "q'r \\$x", IZV: 'e', PRAZAN: null, PRAZAN2: null, NEMA: null,
    }
    for (const [ime, v] of Object.entries(ocekivano)) {
      expect(procitajTajnu(ime, f)).toBe(v)
      expect(tajnaPostavljena(ime, f)).toBe(v !== null)
      expect(kljucPrisutan(t, ime)).toBe(v !== null)
      expect(python(f, ime)).toBe(v ?? '')
    }
  })

  test('ime s RegExp znakovima u čitaču ne baca i ne pogađa tuđi redak', () => {
    expect(kljucPrisutan('AXB=1\n', 'A.B')).toBe(false)
  })
})

describe('N1 ploča: handleLoginApikey i odlučitelj idu kroz LoginCreds (izvor)', () => {
  const izvor = readFileSync(join(import.meta.dir, '..', 'src', 'TaskWebUI.ts'), 'utf-8')
  const tijelo = (ime: string) => {
    const i = izvor.indexOf(`function ${ime}(`)
    return izvor.slice(i, izvor.indexOf('\n}\n', i))
  }
  test('handleLoginApikey piše SAMO kroz postaviTajnu', () => {
    const t = tijelo('handleLoginApikey')
    expect(t).toContain('postaviTajnu(')
    expect(t).not.toMatch(/\$\{def\.envKey\}=/)
    expect(t).not.toMatch(/new RegExp\('\^' \+ def\.envKey/)
  })
  test('odluciteljDavatelji mjeri kroz kljucPrisutan (parser), ne regex =\\S', () => {
    const t = tijelo('odluciteljDavatelji')
    expect(t).toContain('kljucPrisutan(')
    expect(t).not.toContain("'=\\\\S'")
  })
})
