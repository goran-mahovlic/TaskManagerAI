/**
 * LoginCreds — jedan izvor istine za tajne davatelja u sigurnom spremištu
 * (`credentials.env`, v. ConfigModul.datotekaTajni(); redci oblika `IME='vrijednost'`).
 *
 * ZAŠTO POSTOJI (TASK-4796): mjerilo „je li davatelj prijavljen" i radnja „odjavi ga"
 * bile su dva odvojena, ručno prepisana izraza u TaskWebUI.ts. Mjerilo je gledalo ključ u
 * spremištu, a odjava brisala samo OAuth datoteku — pa je „Odjava" za Gemini bila
 * kozmetička: gumb je zauvijek ostajao „prijavljen". Dok obje strane ne dijele isti kod,
 * takav razmak se vrati kod prve sljedeće izmjene.
 *
 * NAČELO: ono što odjava ukloni mora oboriti mjerilo prijavljenosti. Zato je uklanjanje
 * namjerno ŠIRE od mjerila (hvata i `export IME=`, i razmake, i praznu vrijednost) —
 * nikad ne smije ostati redak koji bi mjerilo moglo pročitati kao prijavu.
 *
 * OBLIK RETKA (TASK-5345, ADR-0007 §5.2, nalaz N1): spremište netko učita s
 * `set -a; . spremište` (petlja maila na glavnom). Goli `IME=vrijednost` tada je IZVRŠNI KOD:
 * `$(…)`, backtick i `;` u vrijednosti izvrše se kao naredba, a `\n` u vrijednosti dopiše
 * proizvoljan redak (npr. `BASH_ENV`). Zato pisač piše SAMO `IME='…'` (unutar jednostrukih
 * navodnika ljuska ništa ne zamjenjuje; `'` → `'\''`) i odbija `\0 \r \n`. Čitač razumije
 * taj oblik i stari goli/navodnički, jer postojeći retci ostaju dok ih netko ne prepiše.
 */
import {
  chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeSync,
} from 'fs'
import { randomBytes } from 'crypto'
import { dirname } from 'path'

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const IME_TAJNE_RE = /^[A-Z][A-Z0-9_]{1,63}$/
export const TAJNA_MAX_BAJTOVA = 4096

export interface RedakTajne { ime: string; vrijednost: string }

/** `IME='…'` — POSIX jednostruki navodnici, jedini oblik koji pisač piše. */
export function kodirajRedak(ime: string, vrijednost: string): string {
  return `${ime}='${vrijednost.split("'").join("'\\''")}'`
}

/**
 * Riječ ljuske koja počinje navodnikom (`'…'`, `"…"`, i spojevi poput `'a'\''b'`) → niz.
 * Vraća `null` za nezatvoren navodnik (tada vrijedi stari, tolerantni put).
 * `$…` u dvostrukim navodnicima se NE razvija — čitač nikad ništa ne izvršava.
 */
function dekodirajRijec(s: string): string | null {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === ' ' || c === '\t') break // ostatak je razmak ili `# komentar`
    if (c === "'") {
      const kraj = s.indexOf("'", i + 1)
      if (kraj < 0) return null
      out += s.slice(i + 1, kraj); i = kraj + 1
    } else if (c === '"') {
      i++
      for (;;) {
        if (i >= s.length) return null
        const d = s[i]
        if (d === '"') { i++; break }
        if (d === '\\' && i + 1 < s.length && '$`"\\'.includes(s[i + 1])) { out += s[i + 1]; i += 2; continue }
        out += d; i++
      }
    } else if (c === '\\' && i + 1 < s.length) {
      out += s[i + 1]; i += 2
    } else {
      out += c; i++
    }
  }
  return out
}

/** Jedan parser retka spremišta (ADR-0007 §5.2). Komentar i ne-dodjela → `null`. */
export function parsirajRedak(redak: string): RedakTajne | null {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(redak.replace(/\r$/, ''))
  if (!m) return null
  const sirovo = m[2].trim()
  if (sirovo.startsWith("'") || sirovo.startsWith('"')) {
    const v = dekodirajRijec(sirovo)
    if (v !== null) return { ime: m[1], vrijednost: v }
  }
  // stari goli zapis: kao dosad — obrubni razmaci i rubni navodnici se skidaju
  return { ime: m[1], vrijednost: sirovo.replace(/^["']|["']$/g, '') }
}

/** Vrijednost imena iz teksta spremišta; zadnji redak pobjeđuje (kao u ljusci). Prazno → `null`. */
export function procitajIzTeksta(tekst: string, envKey: string): string | null {
  if (!envKey) return null
  let v: string | null = null
  for (const r of tekst.split('\n')) {
    const p = parsirajRedak(r)
    if (p && p.ime === envKey) v = p.vrijednost
  }
  return v ? v : null
}

/** Mjerilo prijavljenosti: TOČNO ime ključa s NEPRAZNOM vrijednošću (bilo kojeg oblika). */
export function kljucPrisutan(tekst: string, envKey: string): boolean {
  return procitajIzTeksta(tekst, envKey) !== null
}

export function kljucPrisutanUDatoteci(putanja: string, envKey: string): boolean {
  try {
    return existsSync(putanja) && kljucPrisutan(readFileSync(putanja, 'utf-8'), envKey)
  } catch { return false }
}

/** Je li redak zapis TOG ključa (šire od mjerila: `export`, razmaci, prazna vrijednost). */
export function redakJeKljuc(redak: string, envKey: string): boolean {
  return new RegExp('^\\s*(export\\s+)?' + escapeRe(envKey) + '\\s*=').test(redak)
}

/** Miče CIJELI redak ključa (ne prazni vrijednost — prazan `IME=` je i dalje trag tajne). */
export function ukloniKljuc(tekst: string, envKey: string): { tekst: string; uklonjen: boolean } {
  if (!envKey) return { tekst, uklonjen: false }
  const redovi = tekst.split('\n')
  const ostatak = redovi.filter(r => !redakJeKljuc(r, envKey))
  return { tekst: ostatak.join('\n'), uklonjen: ostatak.length !== redovi.length }
}

/** Zašto vrijednost ne smije u spremište (kod greške), ili `null` ako smije. */
export function provjeriVrijednostTajne(vrijednost: unknown): string | null {
  if (typeof vrijednost !== 'string' || vrijednost.length === 0) return 'vrijednost_prazna'
  if (/[\0\r\n]/.test(vrijednost)) return 'vrijednost_nedopusten_znak'
  if (Buffer.byteLength(vrijednost, 'utf-8') > TAJNA_MAX_BAJTOVA) return 'vrijednost_preduga'
  return null
}

/** Spremište mora biti obična datoteka korisnika — ne poveznica (bacila bi upis u tuđu datoteku). */
function provjeriSpremiste(putanja: string): void {
  let st
  try { st = lstatSync(putanja) } catch { return } // još ne postoji — stvorit će se
  const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid
  if (st.isSymbolicLink() || !st.isFile() || st.uid !== uid) throw new Error('spremiste_nije_sigurno')
}

/**
 * Atomičan upis: `tmp` s nasumičnim imenom (`O_EXCL|O_NOFOLLOW`, 0600) + `fsync` + `rename`,
 * pa `chmod 0600` (i kad je spremište ranije bilo 0644). Bez kopija (`.bak`) — rotacija
 * mora ugasiti staru vrijednost (ADR-0007 N2). Pad usred upisa ostavlja staro spremište.
 */
function zapisiAtomicno(putanja: string, tekst: string): void {
  provjeriSpremiste(putanja)
  mkdirSync(dirname(putanja), { recursive: true, mode: 0o700 })
  const tmp = `${putanja}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    try { writeSync(fd, tekst); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, putanja)
  } catch (e) {
    try { unlinkSync(tmp) } catch {}
    throw e
  }
  try { chmodSync(putanja, 0o600) } catch {}
}

/**
 * JEDINI pisač tajne (ADR-0007 §5.3). Mijenja SAMO redak tog imena (svi oblici, i `export`;
 * duplikati se miču), ostale retke ostavlja bajt za bajt; nema li ga, dopisuje na kraj.
 * Vrijednost se NE trim-a (lozinka smije imati razmak na rubu).
 */
export function postaviTajnu(putanja: string, ime: string, vrijednost: string): { ok: boolean; greska?: string } {
  if (typeof ime !== 'string' || !IME_TAJNE_RE.test(ime)) return { ok: false, greska: 'ime_neispravno' }
  const zasto = provjeriVrijednostTajne(vrijednost)
  if (zasto) return { ok: false, greska: zasto }
  try {
    provjeriSpremiste(putanja)
    const stari = existsSync(putanja) ? readFileSync(putanja, 'utf-8') : ''
    const novi = kodirajRedak(ime, vrijednost)
    let upisan = false
    const redovi: string[] = []
    for (const r of stari.split('\n')) {
      if (!redakJeKljuc(r, ime)) { redovi.push(r); continue }
      if (!upisan) { redovi.push(novi); upisan = true }
    }
    let tekst = redovi.join('\n')
    if (!upisan) tekst = (tekst && !tekst.endsWith('\n') ? tekst + '\n' : tekst) + novi + '\n'
    zapisiAtomicno(putanja, tekst)
    return { ok: true }
  } catch (e: any) {
    const p = String(e?.message || e)
    return { ok: false, greska: p === 'spremiste_nije_sigurno' ? p : 'upis_nije_uspio: ' + p }
  }
}

/** Odjava na disku. Vraća je li ključ doista bio ondje (dvostruki klik je bezopasan). */
export function ukloniKljucIzDatoteke(putanja: string, envKey: string): boolean {
  if (!envKey || !existsSync(putanja)) return false
  const { tekst, uklonjen } = ukloniKljuc(readFileSync(putanja, 'utf-8'), envKey)
  if (!uklonjen) return false
  zapisiAtomicno(putanja, tekst)
  return true
}
