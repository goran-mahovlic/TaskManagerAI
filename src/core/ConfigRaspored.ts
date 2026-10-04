// Raspored Config stranice (TASK-5170, dizajn TASK-5169: docs/DIZAJN-config-uredivac-rasporeda.md).
//
// Raspored = redoslijed kartica, širina (stupci 1–4) i visina (null = prirodna, inače 160–1200 px
// u koracima od 40). NIKAD ne nosi vrijednosti postavki — za njih postoje vlastite rute
// (/api/config/concurrency, /autonomy, …) s vlastitom validacijom (dizajn §6).
//
// Izvor istine: `settings`, ključ `config.raspored` (JSON). Svaka promjena dobiva redak u
// `settings_history` (source `config-raspored`) U ISTOJ transakciji, kao pragovi autonomije.
// `{zadano:true}` briše ključ (zadani raspored je HTML, u bazi se ne čuva prazan predložak).
//
// Čista logika (validiraj, poredajSkupinu, mjere, spoji, brojIzmjena) je ISTI kod u pregledniku:
// `klijentskaLogikaJS()` je serijalizira za `/config-raspored.js`, pa se pravila ne mogu razići.
// Zato su te funkcije pisane bez tipova u tijelu i bez vanjskih ovisnosti osim konstanti ispod.
import type { Database } from 'bun:sqlite'

export const RASPORED_KLJUC = 'config.raspored'
export const RASPORED_IZVOR = 'config-raspored'

export const VERZIJA = 1
export const STUPACA = 4
export const VIS_MIN = 160
export const VIS_MAX = 1200
export const VIS_KORAK = 40
export const MAX_KARTICA = 64
export const MAX_BAJTOVA = 8192
export const ID_UZORAK = /^info-[a-z0-9-]{1,60}-card$/

export interface Mjere { w: number; h: number | null }
export interface Raspored { v: 1; redoslijed: string[]; kartice: Record<string, Mjere> }
export type Rezultat<T> = { ok: true; value: T } | { ok: false; error: string }

export function stisni(n: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, n)) }
export function zaokruziVisinu(px: number): number { return stisni(Math.round(px / VIS_KORAK) * VIS_KORAK, VIS_MIN, VIS_MAX) }

/** Validacija rasporeda. Strogo: nepoznat ključ ili kriva vrijednost = greška, ništa se ne upisuje. */
export function validiraj(ulaz: any): Rezultat<Raspored> {
  const greska = (error: string) => ({ ok: false as const, error })
  if (!ulaz || typeof ulaz !== 'object' || Array.isArray(ulaz)) return greska('raspored mora biti objekt')
  let bajtova
  try { bajtova = new TextEncoder().encode(JSON.stringify(ulaz)).length } catch (e) { return greska('raspored nije JSON') }
  if (bajtova > MAX_BAJTOVA) return greska('raspored je veći od ' + MAX_BAJTOVA + ' B')
  const visak = Object.keys(ulaz).filter(k => ['v', 'redoslijed', 'kartice'].indexOf(k) < 0)
  if (visak.length) return greska('nepoznato polje: ' + visak.join(', ') + ' (raspored ne nosi vrijednosti postavki)')
  if (ulaz.v !== VERZIJA) return greska('v mora biti ' + VERZIJA)
  if (!Array.isArray(ulaz.redoslijed)) return greska('redoslijed mora biti niz ID-jeva')
  if (ulaz.redoslijed.length > MAX_KARTICA) return greska('najviše ' + MAX_KARTICA + ' kartica')
  const vidjeno = new Set()
  for (const id of ulaz.redoslijed) {
    if (typeof id !== 'string' || !ID_UZORAK.test(id)) return greska('neispravan ID kartice: ' + String(id).slice(0, 80))
    if (vidjeno.has(id)) return greska('ID se ponavlja: ' + id)
    vidjeno.add(id)
  }
  const k = ulaz.kartice
  if (!k || typeof k !== 'object' || Array.isArray(k)) return greska('kartice mora biti objekt')
  const kartice: Record<string, Mjere> = {}
  const ids = Object.keys(k)
  if (ids.length > MAX_KARTICA) return greska('najviše ' + MAX_KARTICA + ' kartica')
  for (const id of ids) {
    if (!ID_UZORAK.test(id)) return greska('neispravan ID kartice: ' + id.slice(0, 80))
    const m = k[id]
    if (!m || typeof m !== 'object' || Array.isArray(m)) return greska(id + ': mjere moraju biti objekt')
    const visakM = Object.keys(m).filter(x => x !== 'w' && x !== 'h')
    if (visakM.length) return greska(id + ': nepoznato polje ' + visakM.join(', '))
    if (!Number.isInteger(m.w) || m.w < 1 || m.w > STUPACA) return greska(id + ': w mora biti cijeli broj 1–' + STUPACA)
    if (m.h !== null && (!Number.isInteger(m.h) || m.h < VIS_MIN || m.h > VIS_MAX || m.h % VIS_KORAK !== 0))
      return greska(id + ': h mora biti null ili ' + VIS_MIN + '–' + VIS_MAX + ' u koracima od ' + VIS_KORAK)
    kartice[id] = { w: m.w, h: m.h }
  }
  return { ok: true, value: { v: VERZIJA as 1, redoslijed: ulaz.redoslijed.slice(), kartice } }
}

/**
 * Redoslijed jedne skupine. `zadano` = ID-jevi kartica skupine kako stoje u HTML-u.
 * Kartice koje raspored poznaje popunjavaju SVOJA mjesta spremljenim redom; nova kartica
 * (nadogradnja) ostaje na zadanom mjestu; spremljeni ID kojeg na stranici nema se preskače.
 */
export function poredajSkupinu(zadano: string[], redoslijed: string[] | null | undefined): string[] {
  const rang = new Map((redoslijed || []).map((id, i) => [id, i] as [string, number]))
  const poznate = zadano.filter(id => rang.has(id)).sort((a, b) => (rang.get(a) as number) - (rang.get(b) as number))
  let i = 0
  return zadano.map(id => (rang.has(id) ? poznate[i++] : id))
}

/** Mjere kartice: spremljene ako postoje, inače zadane (info-full = 4 stupca, ostale 2). */
export function mjere(id: string, raspored: Raspored | null | undefined, puna: boolean): Mjere {
  const m = raspored && raspored.kartice && raspored.kartice[id]
  return m ? { w: m.w, h: m.h } : { w: puna ? STUPACA : 2, h: null }
}

/** Spoji spremljeni raspored s novim — ID-jevi koje ova stranica ne poznaje ostaju sačuvani. */
export function spoji(stari: Raspored | null | undefined, novo: Raspored): Raspored {
  const vidljivi = new Set(novo.redoslijed)
  const redoslijed = novo.redoslijed.concat(((stari && stari.redoslijed) || []).filter(id => !vidljivi.has(id)))
  const kartice = Object.assign({}, (stari && stari.kartice) || {}, novo.kartice)
  return { v: VERZIJA as 1, redoslijed: redoslijed.slice(0, MAX_KARTICA), kartice }
}

/** Broj izmjena između dva rasporeda (širina, visina, svako pomaknuto mjesto) — značka na gumbu. */
export function brojIzmjena(a: Raspored, b: Raspored): number {
  let n = 0
  const ids = new Set(Object.keys(a.kartice).concat(Object.keys(b.kartice)))
  ids.forEach(id => {
    const x: any = a.kartice[id] || {}, y: any = b.kartice[id] || {}
    if (x.w !== y.w) n++
    if (x.h !== y.h) n++
  })
  if (a.redoslijed.join('|') !== b.redoslijed.join('|')) {
    for (let i = 0; i < Math.max(a.redoslijed.length, b.redoslijed.length); i++) if (a.redoslijed[i] !== b.redoslijed[i]) n++
  }
  return n
}

/**
 * Logika za preglednik: ISTE funkcije, serijalizirane (Bun daje prevedeni izvor bez tipova).
 * Rezultat postavlja `window.CfgRasporedLogika`. Test `config-raspored-postavka` je izvodi i
 * uspoređuje s poslužiteljskom.
 */
export function klijentskaLogikaJS(): string {
  const fje = [stisni, zaokruziVisinu, validiraj, poredajSkupinu, mjere, spoji, brojIzmjena]
  return [
    '// Logika rasporeda Config stranice — generirano iz src/core/ConfigRaspored.ts (TASK-5170).',
    '(function () {',
    '"use strict";',
    'var VERZIJA = ' + VERZIJA + ', STUPACA = ' + STUPACA + ', VIS_MIN = ' + VIS_MIN + ', VIS_MAX = ' + VIS_MAX +
      ', VIS_KORAK = ' + VIS_KORAK + ', MAX_KARTICA = ' + MAX_KARTICA + ', MAX_BAJTOVA = ' + MAX_BAJTOVA + ';',
    'var ID_UZORAK = ' + ID_UZORAK.toString() + ';',
    ...fje.map(f => f.toString()),
    'window.CfgRasporedLogika = { VERZIJA: VERZIJA, STUPACA: STUPACA, VIS_MIN: VIS_MIN, VIS_MAX: VIS_MAX, VIS_KORAK: VIS_KORAK,',
    '  MAX_BAJTOVA: MAX_BAJTOVA, ID_UZORAK: ID_UZORAK, ' + fje.map(f => f.name + ': ' + f.name).join(', ') + ' };',
    '})();',
  ].join('\n')
}

// ─── Zahtjev (PUT /api/config/raspored) ─────────────────────────────────────

export interface RasporedZahtjev {
  raspored: Raspored | null
  zadano: boolean
  /** updated_at viđen pri ulasku u uređivanje; null = tada nije bilo spremljenog rasporeda. */
  osnova: string | null
  /** false = polje `osnova` nije poslano (curl) → bez provjere sukoba. */
  imaOsnovu: boolean
  by: string
  source: string
}

const POLJA_ZAHTJEVA = ['raspored', 'zadano', 'osnova', 'by', 'source']

/** Tijelo PUT-a. Strogo kao i raspored: polje vrijednosti postavke uz raspored = 400 (dizajn §6, sloj 2). */
export function parsirajZahtjev(body: any): Rezultat<RasporedZahtjev> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'tijelo mora biti JSON objekt' }
  const visak = Object.keys(body).filter(k => !POLJA_ZAHTJEVA.includes(k))
  if (visak.length) return { ok: false, error: `nepoznato polje: ${visak.join(', ')} (ova ruta mijenja SAMO raspored; vrijednosti postavki imaju vlastite rute)` }
  const zadano = body.zadano === true
  if (body.zadano !== undefined && typeof body.zadano !== 'boolean') return { ok: false, error: 'zadano mora biti true ili izostavljeno' }
  if (zadano && body.raspored !== undefined) return { ok: false, error: 'pošalji ILI raspored ILI zadano:true, ne oboje' }
  if (!zadano && body.raspored === undefined) return { ok: false, error: 'pošalji raspored {v,redoslijed,kartice} ili zadano:true' }
  let raspored: Raspored | null = null
  if (!zadano) {
    const v = validiraj(body.raspored)
    if (!v.ok) return v
    raspored = v.value
  }
  const imaOsnovu = 'osnova' in body
  if (imaOsnovu && body.osnova !== null && (typeof body.osnova !== 'string' || body.osnova.length > 40))
    return { ok: false, error: 'osnova mora biti null ili updated_at niz' }
  const by = typeof body.by === 'string' && body.by.trim() ? body.by.trim().slice(0, 64) : 'config'
  const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim().slice(0, 32) : RASPORED_IZVOR
  return { ok: true, value: { raspored, zadano, osnova: imaOsnovu ? body.osnova : null, imaOsnovu, by, source } }
}

// ─── Baza ────────────────────────────────────────────────────────────────────

export interface RasporedStanje {
  raspored: Raspored | null
  /** updated_at retka; null = nema spremljenog rasporeda (vrijedi zadani iz HTML-a). */
  osnova: string | null
  updatedBy: string | null
  /** Razlog zašto je zapis u bazi odbačen (ručno pokvaren JSON) — ploča tada crta zadano. */
  invalid?: string
}

export function getRaspored(db: Database): RasporedStanje {
  const r = db.query('SELECT value, updated_by, updated_at FROM settings WHERE key = ?').get(RASPORED_KLJUC) as
    { value: string; updated_by: string; updated_at: string } | null
  if (!r) return { raspored: null, osnova: null, updatedBy: null }
  let json: unknown
  try { json = JSON.parse(r.value) } catch { return { raspored: null, osnova: r.updated_at, updatedBy: r.updated_by, invalid: 'zapis nije JSON' } }
  const v = validiraj(json)
  if (!v.ok) return { raspored: null, osnova: r.updated_at, updatedBy: r.updated_by, invalid: v.error }
  return { raspored: v.value, osnova: r.updated_at, updatedBy: r.updated_by }
}

export type RasporedIshod =
  | { ok: true; promjena: boolean; novo: Raspored | null; staro: Raspored | null; zadano: boolean }
  | { ok: false; status: 400 | 409; error: string }

/** Što BI se zapisalo — bez upisa (x-regoc-proba i prvi korak `setRaspored`). */
export function pripremiRaspored(db: Database, z: RasporedZahtjev): RasporedIshod {
  const cur = getRaspored(db)
  if (z.imaOsnovu && z.osnova !== cur.osnova) {
    return { ok: false, status: 409, error: 'Raspored je u međuvremenu promijenjen na drugom uređaju — Odustani pa uredi ponovo.' }
  }
  const postoji = cur.osnova !== null
  if (z.zadano) return { ok: true, promjena: postoji, novo: null, staro: cur.raspored, zadano: true }
  const novo = spoji(cur.raspored, z.raspored as Raspored)
  const promjena = !cur.raspored || JSON.stringify(novo) !== JSON.stringify(cur.raspored) || !!cur.invalid
  return { ok: true, promjena, novo, staro: cur.raspored, zadano: false }
}

/** Upis s auditom u istoj transakciji. Bez promjene → ništa (ni redak povijesti). */
export function setRaspored(db: Database, z: RasporedZahtjev): RasporedIshod {
  let ishod: RasporedIshod | null = null
  db.transaction(() => {
    const p = pripremiRaspored(db, z)
    ishod = p
    if (!p.ok || !p.promjena) return
    const staro = (db.query('SELECT value FROM settings WHERE key = ?').get(RASPORED_KLJUC) as { value: string } | null)?.value ?? null
    if (p.zadano) {
      db.query('DELETE FROM settings WHERE key = ?').run(RASPORED_KLJUC)
    } else {
      db.query(
        `INSERT INTO settings(key, value, updated_by, updated_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      ).run(RASPORED_KLJUC, JSON.stringify(p.novo), z.by)
    }
    db.query('INSERT INTO settings_history(key, old_value, new_value, changed_by, source) VALUES (?, ?, ?, ?, ?)')
      .run(RASPORED_KLJUC, staro, p.zadano ? 'zadano' : JSON.stringify(p.novo), z.by, z.source)
  })()
  return ishod!
}

export interface RasporedPovijestRed {
  key: string
  oldValue: string | null
  newValue: string
  changedBy: string
  source: string
  changedAt: string
}

/** Povijest promjena rasporeda, najnovija prva. */
export function rasporedPovijest(db: Database, limit = 10): RasporedPovijestRed[] {
  const rows = db.query(
    `SELECT key, old_value, new_value, changed_by, source, changed_at FROM settings_history
     WHERE key = ? ORDER BY id DESC LIMIT ?`,
  ).all(RASPORED_KLJUC, limit) as Array<{ key: string; old_value: string | null; new_value: string; changed_by: string; source: string; changed_at: string }>
  return rows.map(r => ({ key: r.key, oldValue: r.old_value, newValue: r.new_value, changedBy: r.changed_by, source: r.source, changedAt: r.changed_at }))
}
