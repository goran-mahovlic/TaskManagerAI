/**
 * LoginCreds — JEDINI pisač i jedini parser spremišta tajni čvora (`credentials.env`,
 * v. ConfigModul.datotekaTajni(); redci oblika `IME='vrijednost'`). ADR-0007 §5.
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
 *
 * POOPĆENJE ZA PLOČU (TASK-5343, ADR-0007 §5.3, §6, §7): brava između procesa (ploča + CLI),
 * HMAC otisak s ključem čvora, popis dopuštenih imena, brisanje i dojava promjene. Ploča
 * („Config → Tajne"), `ConfigModul.zapisiTajnu`, upis ključa davatelja i odjava zovu OVO.
 */
import {
  chmodSync, closeSync, constants as K, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, statSync, unlinkSync, watch, writeSync,
} from 'fs'
import { createHmac, randomBytes } from 'crypto'
import { dirname, join } from 'path'

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const IME_TAJNE_RE = /^[A-Z][A-Z0-9_]{1,63}$/
export const TAJNA_MAX_BAJTOVA = 4096
/** Kraća imena za novi kod (TASK-5343); isto pravilo. */
export const IME_RE = IME_TAJNE_RE

export interface RedakTajne { ime: string; vrijednost: string }

// ─── Parser (§5.2) ───────────────────────────────────────────────────────────

/** `IME='…'` — POSIX jednostruki navodnici, jedini oblik koji pisač piše. */
export function kodirajRedak(ime: string, vrijednost: string): string {
  return `${ime}=${kodirajVrijednost(vrijednost)}`
}
export const kodirajVrijednost = (v: string): string => `'${v.split("'").join("'\\''")}'`

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
        if (d === '\\' && i + 1 < s.length && '$`"\\'.includes(s[i + 1]!)) { out += s[i + 1]; i += 2; continue }
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

const DODJELA = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

/** Jedan parser retka spremišta (ADR-0007 §5.2). Komentar i ne-dodjela → `null`. */
export function parsirajRedak(redak: string): RedakTajne | null {
  const m = DODJELA.exec(redak.replace(/\r$/, ''))
  if (!m) return null
  const sirovo = m[2]!.trim()
  if (sirovo.startsWith("'") || sirovo.startsWith('"')) {
    const v = dekodirajRijec(sirovo)
    if (v !== null) return { ime: m[1]!, vrijednost: v }
  }
  // stari goli zapis: kao dosad — obrubni razmaci i rubni navodnici se skidaju
  return { ime: m[1]!, vrijednost: sirovo.replace(/^["']|["']$/g, '') }
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

/**
 * Za `GET /api/tajne` (§5.2): `novi` = redak koji je napisao pisač (`IME='…'`). Stari goli ili
 * dvostruko-navodnički redak s metaznakom ljuske je `opasan` — treba ga ponovo upisati.
 */
export function opisStarogRetka(redak: string): { oblik: 'novi' | 'stari'; opasan: boolean } {
  const m = DODJELA.exec(redak.replace(/\r$/, ''))
  if (!m) return { oblik: 'novi', opasan: false }
  const sirovo = m[2]!.trim()
  if (sirovo.startsWith("'") && dekodirajRijec(sirovo) !== null && !sirovo.includes('"')) return { oblik: 'novi', opasan: false }
  return { oblik: 'stari', opasan: /[$`;()|&<>]/.test(sirovo) }
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

/** Zašto vrijednost ne smije u spremište (kod greške), ili `null` ako smije. Ne trim-a. */
export function provjeriVrijednostTajne(vrijednost: unknown): string | null {
  if (typeof vrijednost !== 'string' || vrijednost.length === 0) return 'vrijednost_prazna'
  if (/[\0\r\n]/.test(vrijednost)) return 'vrijednost_nedopusten_znak'
  if (Buffer.byteLength(vrijednost, 'utf-8') > TAJNA_MAX_BAJTOVA) return 'vrijednost_preduga'
  return null
}
export const provjeriVrijednost = provjeriVrijednostTajne

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
    if (ime && IME_TAJNE_RE.test(ime) && !imeZabranjeno(ime) && !out.has(ime)) out.set(ime, izvor)
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

export interface OpcijePisaca {
  spremiste: string
  kljucOtiska?: string
  /**
   * Stegni mapu spremišta na 0700 ako je šira (ADR-0007 §5.3). Zadano da — na čvoru je to
   * `$TM_HOME/config/`. Glavni stroj drži spremište u zajedničkoj mapi sustava, čija se
   * prava ne smiju mijenjati usput (`false`).
   */
  stegniMapu?: boolean
}
export interface IshodPisaca { ok: boolean; greska?: string; otisakPrije?: string | null; otisak?: string | null; uklonjen?: boolean }

const pidZiv = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' } }

/** Brava između procesa (ploča + CLI): `<spremište>.lock` s O_EXCL. */
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

/** Spremište mora biti obična datoteka korisnika — ne poveznica (bacila bi upis u tuđu datoteku). */
function provjeriMjesto(spremiste: string, stegni: boolean): string | null {
  const mapa = dirname(spremiste)
  mkdirSync(mapa, { recursive: true, mode: 0o700 })
  const sm = statSync(mapa)
  const uid = typeof process.getuid === 'function' ? process.getuid() : sm.uid
  if (sm.uid !== uid) return 'spremiste_nije_sigurno'
  if (stegni && (sm.mode & 0o077) !== 0) { try { chmodSync(mapa, 0o700) } catch {} }
  let st
  try { st = lstatSync(spremiste) } catch { return null } // još ne postoji — stvorit će se
  if (st.isSymbolicLink() || !st.isFile() || st.uid !== uid) return 'spremiste_nije_sigurno'
  return null
}

/**
 * Atomičan upis: `tmp` s nasumičnim imenom (`O_EXCL|O_NOFOLLOW`, 0600) + `fsync` + `rename`,
 * `fsync` mape, pa `chmod 0600` (i kad je spremište ranije bilo 0644). Bez kopija (`.bak`) —
 * rotacija mora ugasiti staru vrijednost (ADR-0007 N2). Pad usred upisa ostavlja staro spremište.
 */
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
function uredi(
  ime: string, o: OpcijePisaca & { bezOtiska?: boolean },
  izmijeni: (redovi: string[]) => string[] | null, nova: string | null,
): IshodPisaca {
  if (!IME_TAJNE_RE.test(ime)) return { ok: false, greska: 'ime_neispravno' }
  let greska: string | null
  try { greska = provjeriMjesto(o.spremiste, o.stegniMapu !== false) } catch { greska = 'spremiste_nije_sigurno' }
  if (greska) return { ok: false, greska }
  const kljucPut = o.kljucOtiska || kljucOtiskaUz(o.spremiste)
  let otkljucaj: () => void
  try { otkljucaj = zakljucaj(o.spremiste) } catch (e: any) { return { ok: false, greska: e?.code === 'TAJNE_ZAKLJUCANO' ? 'zakljucano' : 'upis_nije_uspio' } }
  try {
    const stari = existsSync(o.spremiste) ? readFileSync(o.spremiste, 'utf-8') : ''
    const prije = procitajIzTeksta(stari, ime)
    const redovi = stari === '' ? [] : stari.replace(/\n$/, '').split('\n')
    const novi = izmijeni(redovi)
    if (novi === null) return { ok: true, uklonjen: false, otisakPrije: null, otisak: null }
    zapisiAtomicno(o.spremiste, novi.length ? novi.join('\n') + '\n' : '')
    if (o.bezOtiska) return { ok: true, uklonjen: nova === null ? true : undefined }
    return {
      ok: true,
      otisakPrije: prije ? otisak(prije, kljucPut) : null,
      otisak: nova ? otisak(nova, kljucPut) : null,
      uklonjen: nova === null ? true : undefined,
    }
  } catch {
    // Poruka iznimke se ne prenosi: ne smije postati put kojim sadržaj izađe van.
    return { ok: false, greska: 'upis_nije_uspio' }
  } finally { otkljucaj() }
}

/**
 * Upis ili rotacija s otiskom (ploča, CLI). Mijenja SAMO redak tog imena (svi oblici, i
 * `export` — koji se čuva; duplikati se miču), ostale retke ostavlja bajt za bajt; nema li ga,
 * dopisuje na kraj. Vrijednost se NE trim-a (lozinka smije imati razmak na rubu).
 */
export function upisiTajnu(ime: string, vrijednost: string, o: OpcijePisaca & { bezOtiska?: boolean }): IshodPisaca {
  if (typeof ime !== 'string' || !IME_TAJNE_RE.test(ime)) return { ok: false, greska: 'ime_neispravno' }
  const g = provjeriVrijednostTajne(vrijednost)
  if (g) return { ok: false, greska: g }
  const redak = kodirajRedak(ime, vrijednost)
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

/**
 * JEDINI pisač tajne (TASK-5345 sučelje): `{ok}` ili `{ok:false, greska}`. Ne dira prava mape
 * (zove ga i glavni stroj, v. `stegniMapu`).
 */
export function postaviTajnu(putanja: string, ime: string, vrijednost: string): { ok: boolean; greska?: string } {
  const r = upisiTajnu(ime, vrijednost, { spremiste: putanja, bezOtiska: true, stegniMapu: false })
  return r.ok ? { ok: true } : { ok: false, greska: r.greska }
}

/** Brisanje: miče SVE retke tog imena (načelo TASK-4796). */
export function ukloniTajnu(ime: string, o: OpcijePisaca & { bezOtiska?: boolean }): IshodPisaca {
  if (!IME_TAJNE_RE.test(ime)) return { ok: false, greska: 'ime_neispravno' }
  if (!existsSync(o.spremiste)) return { ok: true, uklonjen: false, otisakPrije: null, otisak: null }
  return uredi(ime, o, redovi => {
    const ostatak = redovi.filter(r => !redakJeKljuc(r, ime))
    return ostatak.length === redovi.length ? null : ostatak
  }, null)
}

/** Odjava na disku. Vraća je li ključ doista bio ondje (dvostruki klik je bezopasan). */
export function ukloniKljucIzDatoteke(putanja: string, envKey: string): boolean {
  if (!envKey || !existsSync(putanja)) return false
  const r = ukloniTajnu(envKey, { spremiste: putanja, bezOtiska: true, stegniMapu: false })
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
