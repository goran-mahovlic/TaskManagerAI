/**
 * LoginCreds — JEDINI pisač i jedini parser spremišta tajni čvora (`credentials.env`,
 * v. ConfigModul.datotekaTajni()). ADR-0007 §5.
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
 * POOPĆENJE (TASK-5343, ADR-0007): spremište je bilo `IME=vrijednost` bez navodnika, a
 * petlja maila ga učitava s `. spremište` — vrijednost s `$(…)` postala bi naredba (N1).
 * Pisač sada piše `IME='…'` (ljuska unutar jednostrukih navodnika ništa ne zamjenjuje),
 * pod zaključavanjem, atomično (tmp O_EXCL + rename + fsync), 0600 i bez `.bak` kopija.
 * `ConfigModul.zapisiTajnu`, upis ključa davatelja, odjava i ploča „Tajne" zovu OVO.
 */
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, watch, writeSync, constants as K,
} from 'fs'
import { createHmac, randomBytes } from 'crypto'
import { dirname, join } from 'path'

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const IME_RE = /^[A-Z][A-Z0-9_]{1,63}$/
export const NAJVISE_BAJTOVA = 4096

// ─── Parser (§5.2) ───────────────────────────────────────────────────────────

export interface Redak { ime: string; vrijednost: string; oblik: 'navodnici' | 'dvostruki' | 'stari'; export: boolean }

/** POSIX dekodiranje niza jednostrukih navodnika i `\'` (oblik koji piše `kodirajVrijednost`). */
function dekodirajJednostruke(s: string): string | null {
  let out = '', i = 0
  while (i < s.length) {
    if (s[i] === "'") {
      const kraj = s.indexOf("'", i + 1)
      if (kraj < 0) return null
      out += s.slice(i + 1, kraj); i = kraj + 1
    } else if (s[i] === '\\' && i + 1 < s.length) { out += s[i + 1]; i += 2 }
    else return null
  }
  return out
}

/** Jedan redak spremišta → ime i vrijednost; `null` za komentar, prazan ili neispravan redak. */
export function parsirajRedak(redak: string): Redak | null {
  const m = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(redak.replace(/\r$/, ''))
  if (!m || !/^[A-Z][A-Z0-9_]{0,63}$/.test(m[2]!)) return null
  const exp = !!m[1], ime = m[2]!, sirovo = m[3]!
  if (sirovo.startsWith("'")) {
    const v = dekodirajJednostruke(sirovo.trimEnd())
    if (v !== null) return { ime, vrijednost: v, oblik: 'navodnici', export: exp }
  }
  const t = sirovo.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return { ime, vrijednost: t.slice(1, -1), oblik: 'dvostruki', export: exp }
  // Stari zapis: kao dosadašnji procitajTajnu (trim + rubni navodnici).
  return { ime, vrijednost: t.replace(/^["']|["']$/g, ''), oblik: 'stari', export: exp }
}

/** Vrijednost imena iz teksta spremišta (zadnji zapis pobjeđuje, kao u ljusci). */
export function procitajIzTeksta(tekst: string, ime: string): string | null {
  let v: string | null = null
  for (const r of tekst.split('\n')) { const p = parsirajRedak(r); if (p && p.ime === ime) v = p.vrijednost }
  return v
}

/** Mjerilo prijavljenosti: TOČNO ime ključa s NEPRAZNOM vrijednošću (svi oblici). */
export function kljucPrisutan(tekst: string, envKey: string): boolean {
  if (!envKey) return false
  return !!procitajIzTeksta(tekst, envKey)
}

export function kljucPrisutanUDatoteci(putanja: string, envKey: string): boolean {
  try {
    return existsSync(putanja) && kljucPrisutan(readFileSync(putanja, 'utf-8'), envKey)
  } catch { return false }
}

/** Za `GET /api/tajne`: stari goli redak s metaznakom ljuske treba ponovo upisati (§5.2). */
export function opisStarogRetka(redak: string): { oblik: 'novi' | 'stari'; opasan: boolean } {
  const p = parsirajRedak(redak)
  if (!p || p.oblik === 'navodnici') return { oblik: 'novi', opasan: false }
  return { oblik: 'stari', opasan: /[$`;()|&<>]/.test(redak.slice(redak.indexOf('=') + 1)) }
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

// ─── Provjere (§5.2, §6) ─────────────────────────────────────────────────────

export const kodirajVrijednost = (v: string): string => "'" + v.replace(/'/g, "'\\''") + "'"

/** Kod greške ili `null`. Vrijednost se NE trim-a (lozinka smije imati razmak na rubu). */
export function provjeriVrijednost(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return 'vrijednost_prazna'
  if (/[\0\r\n]/.test(v)) return 'vrijednost_nedopusten_znak'
  if (Buffer.byteLength(v, 'utf-8') > NAJVISE_BAJTOVA) return 'vrijednost_preduga'
  return null
}

/** §6.2 — vrijedi i kad je ime na popisu: okolina koja mijenja izvršenje ili odredište. */
const ZABRANA = [
  /^(PATH|HOME|SHELL|USER|IFS|ENV|BASH_ENV|PS4|PROMPT_COMMAND|ANTHROPIC_BASE_URL)$/,
  /^(LD|DYLD|NODE|BUN|GIT|SSH|CLAUDE)_/, /^(PYTHON|PERL5|RUBY)/,
  // TM_* su postavke ploče (TM_CREDENTIALS, TM_ALLOW_PRIVATE_HOSTS…); tajna s tim prefiksom
  // (TM_PGVECTOR_PASSWORD) ostaje dopuštena jer nosi tajni sufiks.
  /^TM_(?!.*_(PASSWORD|TOKEN|SECRET|KEY)$)/,
  /_(PROXY|BASE_URL|HOST|URL)$/,
]
export const imeZabranjeno = (ime: string): boolean => ZABRANA.some(r => r.test(ime))

const SUFIKS_DODATNIH = /^[A-Z][A-Z0-9_]{1,63}_(PASSWORD|PASS|TOKEN|SECRET|KEY|API_KEY)$/

export interface DopustenoIme { ime: string; izvor: string }

/** §6.1 — popis iz davatelja, modula, profila čvora i `tajne.dodatnaImena`, bez zabranjenih. */
export function dopustenaImena(izvori: {
  davatelji?: { envKey?: string; izvor: string }[]
  moduli?: DopustenoIme[]
  profil?: string[]
  dodatna?: string[]
}): DopustenoIme[] {
  const out = new Map<string, string>()
  const dodaj = (ime: string | undefined, izvor: string) => {
    if (ime && IME_RE.test(ime) && !imeZabranjeno(ime) && !out.has(ime)) out.set(ime, izvor)
  }
  for (const d of izvori.davatelji || []) dodaj(d.envKey, d.izvor)
  for (const m of izvori.moduli || []) dodaj(m.ime, m.izvor)
  for (const p of izvori.profil || []) dodaj(p, 'profil')
  // TM_* tajna dolazi samo iz modula (pgvector), nikad kao slobodno dodano ime.
  for (const d of izvori.dodatna || []) if (SUFIKS_DODATNIH.test(d) && !d.startsWith('TM_')) dodaj(d, 'dodatno')
  return [...out].map(([ime, izvor]) => ({ ime, izvor }))
}

// ─── Otisak (§7.1) ───────────────────────────────────────────────────────────

export const kljucOtiskaUz = (spremiste: string): string => join(dirname(spremiste), 'tajne-otisak.kljuc')

/**
 * Prvih 8 hex HMAC-SHA256(ključ čvora, vrijednost). Goli SHA-256 prefiks slabe lozinke bio bi
 * proročište za rječnik izvan stroja; s ključem čvora otisak vrijedi samo na čvoru.
 */
export function otisak(vrijednost: string, kljucPut: string): string {
  let kljuc: Buffer
  if (existsSync(kljucPut)) kljuc = readFileSync(kljucPut)
  else {
    mkdirSync(dirname(kljucPut), { recursive: true })
    kljuc = randomBytes(32)
    try {
      const fd = openSync(kljucPut, K.O_WRONLY | K.O_CREAT | K.O_EXCL | K.O_NOFOLLOW, 0o600)
      try { writeSync(fd, kljuc) } finally { closeSync(fd) }
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e
      kljuc = readFileSync(kljucPut) // drugi proces ga je upravo napravio
    }
  }
  return createHmac('sha256', kljuc).update(vrijednost, 'utf-8').digest('hex').slice(0, 8)
}

// ─── Pisač (§5.3) ────────────────────────────────────────────────────────────

export interface OpcijePisaca { spremiste: string; kljucOtiska?: string }
export interface IshodPisaca { ok: boolean; greska?: string; otisakPrije?: string | null; otisak?: string | null; uklonjen?: boolean }

const pidZiv = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' } }

function zakljucaj(spremiste: string): () => void {
  const lock = spremiste + '.lock'
  const rok = Date.now() + 10_000
  for (;;) {
    try {
      const fd = openSync(lock, K.O_WRONLY | K.O_CREAT | K.O_EXCL | K.O_NOFOLLOW, 0o600)
      writeSync(fd, `${process.pid} ${Date.now()}\n`); closeSync(fd)
      return () => { try { unlinkSync(lock) } catch {} }
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e
      // Zastarjela brava: pid mrtav ili starija od 30 s. Brava bez pida je SVJEŽA (vlasnik ju
      // je upravo stvorio i još nije upisao pid) — inače je drugi proces obriše i oba pišu (J4).
      try {
        const starost = Date.now() - statSync(lock).mtimeMs
        const pid = Number(readFileSync(lock, 'utf-8').trim().split(' ')[0])
        if (starost > 30_000 || (Number.isInteger(pid) && pid > 0 && !pidZiv(pid))) { unlinkSync(lock); continue }
      } catch { /* brava nestala između čitanja — pokušaj ponovo */ }
      if (Date.now() > rok) throw Object.assign(new Error('zakljucano'), { code: 'TAJNE_ZAKLJUCANO' })
      Bun.sleepSync(5 + Math.floor(Math.random() * 10))
    }
  }
}

function provjeriMjesto(spremiste: string): string | null {
  const mapa = dirname(spremiste)
  mkdirSync(mapa, { recursive: true, mode: 0o700 })
  const sm = statSync(mapa)
  if (typeof process.getuid === 'function' && sm.uid !== process.getuid()) return 'spremiste_nije_sigurno'
  if ((sm.mode & 0o077) !== 0) { try { chmodSync(mapa, 0o700) } catch {} }
  if (existsSync(spremiste) || (() => { try { lstatSync(spremiste); return true } catch { return false } })()) {
    const s = lstatSync(spremiste)
    if (s.isSymbolicLink() || !s.isFile()) return 'spremiste_nije_sigurno'
    if (typeof process.getuid === 'function' && s.uid !== process.getuid()) return 'spremiste_nije_sigurno'
  }
  return null
}

function zapisiAtomicno(spremiste: string, tekst: string): void {
  const tmp = `${spremiste}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  const fd = openSync(tmp, K.O_WRONLY | K.O_CREAT | K.O_EXCL | K.O_NOFOLLOW, 0o600)
  try {
    try { writeSync(fd, tekst); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, spremiste)
  } catch (e) { try { unlinkSync(tmp) } catch {} ; throw e }
  try { const d = openSync(dirname(spremiste), K.O_RDONLY); try { fsyncSync(d) } finally { closeSync(d) } } catch {}
  chmodSync(spremiste, 0o600)
}

/** Zajednički okvir: mjesto → brava → čitanje → izmjena → atomičan zapis → otključavanje. */
function uredi(ime: string, o: OpcijePisaca, izmijeni: (redovi: string[]) => string[] | null, nova: string | null): IshodPisaca {
  if (!IME_RE.test(ime)) return { ok: false, greska: 'ime_neispravno' }
  const greska = provjeriMjesto(o.spremiste)
  if (greska) return { ok: false, greska }
  const kljucPut = o.kljucOtiska || kljucOtiskaUz(o.spremiste)
  let otkljucaj: () => void
  try { otkljucaj = zakljucaj(o.spremiste) } catch (e: any) { return { ok: false, greska: e?.code === 'TAJNE_ZAKLJUCANO' ? 'zakljucano' : 'spremiste_greska' } }
  try {
    const stari = existsSync(o.spremiste) ? readFileSync(o.spremiste, 'utf-8') : ''
    const prije = procitajIzTeksta(stari, ime)
    const redovi = stari === '' ? [] : stari.replace(/\n$/, '').split('\n')
    const novi = izmijeni(redovi)
    if (novi === null) return { ok: true, uklonjen: false, otisakPrije: null, otisak: null }
    zapisiAtomicno(o.spremiste, novi.length ? novi.join('\n') + '\n' : '')
    return {
      ok: true,
      otisakPrije: prije ? otisak(prije, kljucPut) : null,
      otisak: nova ? otisak(nova, kljucPut) : null,
      uklonjen: nova === null ? true : undefined,
    }
  } catch {
    // Poruka iznimke se ne prenosi: ne smije postati put kojim sadržaj izađe van.
    return { ok: false, greska: 'spremiste_greska' }
  } finally { otkljucaj() }
}

/** Upis ili rotacija. Redak tog imena mijenja se NA MJESTU, ostali ostaju bajt za bajt. */
export function postaviTajnu(ime: string, vrijednost: string, o: OpcijePisaca): IshodPisaca {
  if (!IME_RE.test(String(ime || ''))) return { ok: false, greska: 'ime_neispravno' }
  const g = provjeriVrijednost(vrijednost)
  if (g) return { ok: false, greska: g }
  const redak = `${ime}=${kodirajVrijednost(vrijednost)}`
  return uredi(ime, o, redovi => {
    let zamijenjen = false
    const out: string[] = []
    for (const r of redovi) {
      // `export` se čuva: potrošač bez `set -a` bez njega ne bi vidio varijablu.
      if (redakJeKljuc(r, ime)) { if (!zamijenjen) { out.push((/^\s*export\s/.test(r) ? 'export ' : '') + redak); zamijenjen = true } }
      else out.push(r)
    }
    if (!zamijenjen) out.push(redak)
    return out
  }, vrijednost)
}

/** Brisanje: miče SVE retke tog imena (načelo TASK-4796). */
export function ukloniTajnu(ime: string, o: OpcijePisaca): IshodPisaca {
  if (!existsSync(o.spremiste)) return IME_RE.test(ime) ? { ok: true, uklonjen: false, otisakPrije: null, otisak: null } : { ok: false, greska: 'ime_neispravno' }
  return uredi(ime, o, redovi => {
    const ostatak = redovi.filter(r => !redakJeKljuc(r, ime))
    return ostatak.length === redovi.length ? null : ostatak
  }, null)
}

/** Odjava na disku. Vraća je li ključ doista bio ondje (dvostruki klik je bezopasan). */
export function ukloniKljucIzDatoteke(putanja: string, envKey: string): boolean {
  if (!envKey) return false
  const r = ukloniTajnu(envKey, { spremiste: putanja })
  return r.ok && !!r.uklonjen
}

// ─── Dojava promjene (§7.2) ──────────────────────────────────────────────────

/**
 * `cb` se zove kad se otisak imena promijeni (upis, rotacija, brisanje). Prati se MAPA, jer
 * `rename` mijenja inode spremišta. Vraća funkciju za odjavu.
 */
export function naPromjenuTajne(ime: string, cb: () => void, o: OpcijePisaca): () => void {
  const kljucPut = o.kljucOtiska || kljucOtiskaUz(o.spremiste)
  const trenutni = (): string | null => {
    try { const v = procitajIzTeksta(readFileSync(o.spremiste, 'utf-8'), ime); return v ? otisak(v, kljucPut) : null } catch { return null }
  }
  let zadnji = trenutni()
  let tajmer: ReturnType<typeof setTimeout> | null = null
  const w = watch(dirname(o.spremiste), () => {
    if (tajmer) clearTimeout(tajmer)
    tajmer = setTimeout(() => {
      const sad = trenutni()
      if (sad !== zadnji) { zadnji = sad; try { cb() } catch {} }
    }, 500)
  })
  return () => { if (tajmer) clearTimeout(tajmer); w.close() }
}
