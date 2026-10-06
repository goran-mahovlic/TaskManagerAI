// ─── RazgovorPostavke (ADR-0002 §4) ──────────────────────────────────────────
// Postavke razgovornog načina bota. Žive u tablici `settings` kao i strop agenata
// (`ConcurrencySetting.ts`): mijenjaju se uživo s ploče, svaka promjena je redak u
// `settings_history` u istoj transakciji, čitač ima keš ≤5 s.
//
// Ključevi `memorija.*` su namjerno ZAJEDNIČKI (ne `razgovor.memorija.*`): instalacija koja
// već ima `memorija.banka` ne smije dobiti drugu istinu o banci.
//
// Validacija s ploče ODBIJA (ne stišće) vrijednosti izvan raspona i nepoznata polja.
// Čitač je fail-safe: nečitljiva vrijednost = zadano + upozorenje; ovlasti iznad `citanje`
// bez uvjeta (ručni upis u bazu) spuštaju se na `citanje`.
//
// Autorica: Jelena (Engineer), TASK-5277.

import { Database } from 'bun:sqlite'
import { ensureSettingsSchema } from '../core/ConcurrencySetting'

export type OdgovaraNa = 'sve' | 'spomen' | 'dopusteni' | 'dopusteni-sve'
export type Ovlasti = 'citanje' | 'rad' | 'puno'
export type MemorijaNacin = 'off' | 'shadow' | 'on'

export interface RazgovorPostavke {
  ukljucen: boolean
  ime: string
  odgovaraNa: OdgovaraNa
  dopusteniKorisnici: string[]
  /** Uz `dopusteni-sve`: nedopušteni dobivaju odgovor samo uz obraćanje (true) ili nikad (false). */
  ostaliUzObracanje: boolean
  /** Riječi (ime po korijenu ili @korisničko ime): poruka koja ih sadrži BILO GDJE = samo čita, bez zadatka (TASK-5283). */
  preskociAkoSadrzi: string[]
  /** Svaki tuđi @spomen ili odgovor na tuđu poruku (bot ili čovjek) = tišina i bez zadatka. */
  tisinaKadDrugom: boolean
  model: string
  rokSek: number
  maxUsporednih: number
  sesijaNeaktivnostMin: number
  burstMs: number
  ovlasti: Ovlasti
  radniDir: string
  dokumenti: boolean
  zadrzavanjeDana: number
  memorijaRazgovor: MemorijaNacin
  memorijaBanka: string
  memorijaUrl: string
  memorijaRokMs: number
}

export type Polje = keyof RazgovorPostavke

export const RAZGOVOR_KLJUCEVI: Readonly<Record<Polje, string>> = Object.freeze({
  ukljucen: 'razgovor.ukljucen',
  ime: 'razgovor.ime',
  odgovaraNa: 'razgovor.odgovaraNa',
  dopusteniKorisnici: 'razgovor.dopusteniKorisnici',
  ostaliUzObracanje: 'razgovor.ostaliUzObracanje',
  preskociAkoSadrzi: 'razgovor.preskociAkoSadrzi',
  tisinaKadDrugom: 'razgovor.tisinaKadDrugom',
  model: 'razgovor.model',
  rokSek: 'razgovor.rokSek',
  maxUsporednih: 'razgovor.maxUsporednih',
  sesijaNeaktivnostMin: 'razgovor.sesijaNeaktivnostMin',
  burstMs: 'razgovor.burstMs',
  ovlasti: 'razgovor.ovlasti',
  radniDir: 'razgovor.radniDir',
  dokumenti: 'razgovor.dokumenti',
  zadrzavanjeDana: 'razgovor.zadrzavanjeDana',
  memorijaRazgovor: 'memorija.razgovor',
  memorijaBanka: 'memorija.banka',
  memorijaUrl: 'memorija.url',
  memorijaRokMs: 'memorija.rokMs',
})

export const RAZGOVOR_ZADANO: Readonly<RazgovorPostavke> = Object.freeze({
  ukljucen: false,
  ime: '',
  odgovaraNa: 'spomen',
  dopusteniKorisnici: [],
  ostaliUzObracanje: true,
  preskociAkoSadrzi: [],
  tisinaKadDrugom: false,
  model: '',
  rokSek: 300,
  maxUsporednih: 2,
  sesijaNeaktivnostMin: 30,
  burstMs: 3000,
  ovlasti: 'citanje',
  radniDir: '',
  dokumenti: true,
  zadrzavanjeDana: 30,
  memorijaRazgovor: 'off',
  memorijaBanka: '',
  memorijaUrl: '',
  memorijaRokMs: 1500,
}) as RazgovorPostavke

export const RAZGOVOR_CACHE_MS = 5000

const RASPONI: Partial<Record<Polje, [number, number]>> = {
  rokSek: [30, 1800],
  maxUsporednih: [1, 5],
  sesijaNeaktivnostMin: [5, 1440],
  burstMs: [0, 10000],
  zadrzavanjeDana: [1, 365],
  // Gornja granica = strop memorije izvornog sustava (≤10 s). Izmjereno 06.10.2026.: recall
  // kroz SSH tunel na čvoru traje 6–7,5 s, pa bi 5 s značilo da memorija uvijek istekne.
  memorijaRokMs: [200, 10000],
}
const IZBORI: Partial<Record<Polje, readonly string[]>> = {
  odgovaraNa: ['sve', 'spomen', 'dopusteni', 'dopusteni-sve'],
  ovlasti: ['citanje', 'rad', 'puno'],
  memorijaRazgovor: ['off', 'shadow', 'on'],
}
const BOOL: readonly Polje[] = ['ukljucen', 'dokumenti', 'ostaliUzObracanje', 'tisinaKadDrugom']
const NIZOVI: readonly Polje[] = ['dopusteniKorisnici', 'preskociAkoSadrzi']
const MAX_KORISNIKA = 50
const MAX_DRUGIH = 20

/** Jedno polje s ploče → valjana vrijednost ili tekst greške. */
function provjeriPolje(polje: Polje, v: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (BOOL.includes(polje)) {
    return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, error: `${polje} mora biti true ili false` }
  }
  const raspon = RASPONI[polje]
  if (raspon) {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
    if (typeof n !== 'number' || !Number.isInteger(n) || n < raspon[0] || n > raspon[1]) {
      return { ok: false, error: `${polje} mora biti cijeli broj ${raspon[0]}–${raspon[1]}` }
    }
    return { ok: true, value: n }
  }
  const izbori = IZBORI[polje]
  if (izbori) {
    return typeof v === 'string' && izbori.includes(v)
      ? { ok: true, value: v }
      : { ok: false, error: `${polje} mora biti jedno od: ${izbori.join(', ')}` }
  }
  if (polje === 'dopusteniKorisnici') {
    if (!Array.isArray(v)) return { ok: false, error: 'dopusteniKorisnici mora biti popis' }
    if (v.length > MAX_KORISNIKA) return { ok: false, error: `dopusteniKorisnici: najviše ${MAX_KORISNIKA}` }
    const ids = v.map(x => String(x).trim()).filter(Boolean)
    if (ids.some(x => !/^-?\d{1,20}$|^[\w.+-]{1,64}$/.test(x))) {
      return { ok: false, error: 'dopusteniKorisnici: id ili korisničko ime (slova, brojke, _ . + -), bez razmaka' }
    }
    return { ok: true, value: [...new Set(ids)] }
  }
  if (polje === 'preskociAkoSadrzi') {
    if (!Array.isArray(v)) return { ok: false, error: 'preskociAkoSadrzi mora biti popis' }
    if (v.length > MAX_DRUGIH) return { ok: false, error: `preskociAkoSadrzi: najviše ${MAX_DRUGIH}` }
    const imena = v.map(x => String(x).trim()).filter(Boolean)
    if (imena.some(x => !/^@?[\p{L}\p{N}_.-]{1,64}$/u.test(x))) {
      return { ok: false, error: 'preskociAkoSadrzi: ime ili @korisničko ime, jedna riječ' }
    }
    return { ok: true, value: [...new Set(imena)] }
  }
  if (typeof v !== 'string') return { ok: false, error: `${polje} mora biti tekst` }
  const t = v.trim()
  switch (polje) {
    case 'ime':
      return t.length <= 40 ? { ok: true, value: t } : { ok: false, error: 'ime: najviše 40 znakova' }
    case 'model':
      return t.length <= 100 && !/\s/.test(t) ? { ok: true, value: t } : { ok: false, error: 'model: jedan naziv bez razmaka' }
    case 'radniDir':
      return t === '' || (t.startsWith('/') && !t.split('/').includes('..') && t.length <= 300)
        ? { ok: true, value: t } : { ok: false, error: 'radniDir mora biti apsolutna putanja (ili prazno)' }
    case 'memorijaBanka':
      return /^[\w.-]{0,64}$/.test(t) ? { ok: true, value: t } : { ok: false, error: 'memorijaBanka: slova, brojke, _ . -' }
    case 'memorijaUrl':
      if (t === '') return { ok: true, value: t }
      try {
        const u = new URL(t)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error()
        return { ok: true, value: t.replace(/\/+$/, '') }
      } catch { return { ok: false, error: 'memorijaUrl mora biti http(s) adresa (ili prazno)' } }
  }
  return { ok: false, error: `${polje}: nepoznata vrsta` }
}

/** Uvjet za ovlasti iznad `citanje` (ADR §7) nad SPOJENIM stanjem. `null` = u redu. */
export function uvjetOvlasti(s: Pick<RazgovorPostavke, 'ovlasti' | 'dopusteniKorisnici' | 'odgovaraNa'>): string | null {
  if (s.ovlasti === 'citanje') return null
  if (!s.dopusteniKorisnici.length) return `ovlasti „${s.ovlasti}" traže barem jednog dopuštenog korisnika`
  // `dopusteni-sve` je dopušten: ovlasti iznad čitanja ionako vrijede samo za potez u kojem je
  // svaki pošiljatelj dopušten (Razgovor.potez), a odgovor bez prozivke dobivaju samo oni.
  if (s.odgovaraNa === 'sve') return `ovlasti „${s.ovlasti}" nisu dopuštene uz odgovaraNa=sve`
  return null
}

export type RazgovorPatch = Partial<RazgovorPostavke>

/**
 * Stroga provjera zakrpe s ploče. `trenutno` (ako je dano) služi za provjeru uvjeta ovlasti
 * nad spojenim stanjem — zakrpa `{ovlasti:'rad'}` vrijedi samo ako u bazi već ima korisnika.
 */
export function parseRazgovorPatch(raw: unknown, trenutno?: RazgovorPostavke):
  { ok: true; value: RazgovorPatch } | { ok: false; greske: string[]; dopustena: string[] } {
  const dopustena = Object.keys(RAZGOVOR_KLJUCEVI)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, greske: ['tijelo mora biti objekt'], dopustena }
  }
  const greske: string[] = []
  const value: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === 'by' || k === 'source') continue
    if (!dopustena.includes(k)) { greske.push(`Nepoznato polje: ${k}`); continue }
    const p = provjeriPolje(k as Polje, v)
    if (!p.ok) greske.push(p.error)
    else value[k] = p.value
  }
  if (!greske.length && trenutno) {
    const u = uvjetOvlasti({ ...trenutno, ...value } as RazgovorPostavke)
    if (u) greske.push(u)
  }
  return greske.length ? { ok: false, greske, dopustena } : { ok: true, value: value as RazgovorPatch }
}

// ─── Baza ────────────────────────────────────────────────────────────────────

function uNiz(polje: Polje, v: unknown): string {
  if (NIZOVI.includes(polje)) return JSON.stringify(v)
  return String(v)
}

function izNiza(polje: Polje, s: string): { ok: true; value: unknown } | { ok: false } {
  let v: unknown = s
  if (BOOL.includes(polje)) {
    if (s !== 'true' && s !== 'false') return { ok: false }
    v = s === 'true'
  } else if (NIZOVI.includes(polje)) {
    try { v = JSON.parse(s) } catch { return { ok: false } }
  }
  const p = provjeriPolje(polje, v)
  return p.ok ? { ok: true, value: p.value } : { ok: false }
}

export interface RazgovorStanje {
  postavke: RazgovorPostavke
  /** Polja koja dolaze iz baze (ostala su zadana). */
  izBaze: Polje[]
  upozorenja: string[]
}

/**
 * `dopustiPuno`: razinu `puno` otključava SAMO vlasnik na stroju (`TM_RAZGOVOR_PUNO=1` u
 * okolini ploče), ne polje u tijelu zahtjeva — API ploče nema prijavu, pa `source`/`by`
 * može poslati bilo tko (sigurnosni pregled TASK-5277).
 */
export interface OpcijeOvlasti { dopustiPuno?: boolean }

export function puniDopusten(env: Record<string, string | undefined> = process.env): boolean {
  return env.TM_RAZGOVOR_PUNO === '1'
}

export function getRazgovorPostavke(db: Database, opcije: OpcijeOvlasti = {}): RazgovorStanje {
  const kljucevi = Object.values(RAZGOVOR_KLJUCEVI)
  let redovi: Array<{ key: string; value: string }> = []
  try {
    redovi = db.query(`SELECT key, value FROM settings WHERE key IN (${kljucevi.map(() => '?').join(',')})`)
      .all(...kljucevi) as Array<{ key: string; value: string }>
  } catch { /* tablica ne postoji = sve zadano */ }
  const poKljucu = new Map(redovi.map(r => [r.key, r.value]))
  const postavke: Record<string, unknown> = { ...RAZGOVOR_ZADANO, dopusteniKorisnici: [], preskociAkoSadrzi: [] }
  const izBaze: Polje[] = []
  const upozorenja: string[] = []
  for (const [polje, kljuc] of Object.entries(RAZGOVOR_KLJUCEVI) as [Polje, string][]) {
    const s = poKljucu.get(kljuc)
    if (s === undefined) continue
    const r = izNiza(polje, s)
    if (r.ok) { postavke[polje] = r.value; izBaze.push(polje) }
    else upozorenja.push(`${kljuc}: nečitljiva vrijednost u bazi — vrijedi zadano`)
  }
  const p = postavke as unknown as RazgovorPostavke
  const u = uvjetOvlasti(p)
  if (u) {
    upozorenja.push(`${u} — spušteno na citanje`)
    p.ovlasti = 'citanje'
  } else if (p.ovlasti === 'puno' && !opcije.dopustiPuno) {
    upozorenja.push('ovlasti „puno" traže TM_RAZGOVOR_PUNO=1 na stroju — spušteno na citanje')
    p.ovlasti = 'citanje'
  }
  return { postavke: p, izBaze, upozorenja }
}

export interface RazgovorPromjena {
  kljuc: string
  staro: string | null
  novo: string
  changedBy: string
  source: string
  changed: boolean
}

/**
 * Upis zakrpe. Baca na nevaljanu zakrpu ili neispunjen uvjet ovlasti — ništa se ne upisuje.
 * `puno` traži izvor `ploca` (ADR §7: odobrenje vlasnika, ne agent preko API-ja).
 * Redak u `settings_history` nastaje SAMO za ključ čija se vrijednost doista promijenila.
 */
export function setRazgovorPostavke(
  db: Database, zakrpa: RazgovorPatch, by: string, source = 'api', opcije: OpcijeOvlasti = {},
): RazgovorPromjena[] {
  ensureSettingsSchema(db)
  const trenutno = getRazgovorPostavke(db, opcije).postavke
  const p = parseRazgovorPatch(zakrpa, trenutno)
  if (!p.ok) throw new Error(p.greske.join('; '))
  if (p.value.ovlasti === 'puno' && !opcije.dopustiPuno) {
    throw new Error('ovlasti „puno" uključuje samo vlasnik na stroju (TM_RAZGOVOR_PUNO=1 u okolini ploče)')
  }
  const who = (by || 'unknown').slice(0, 64)
  const promjene: RazgovorPromjena[] = []
  db.transaction(() => {
    for (const [polje, v] of Object.entries(p.value) as [Polje, unknown][]) {
      const kljuc = RAZGOVOR_KLJUCEVI[polje]
      const novo = uNiz(polje, v)
      const red = db.query(`SELECT value FROM settings WHERE key = ?`).get(kljuc) as { value: string } | null
      const staro = red ? red.value : null
      const changed = staro !== novo
      if (changed) {
        db.query(
          `INSERT INTO settings(key, value, updated_by, updated_at)
           VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
        ).run(kljuc, novo, who)
        db.query(`INSERT INTO settings_history(key, old_value, new_value, changed_by, source) VALUES (?, ?, ?, ?, ?)`)
          .run(kljuc, staro, novo, who, source)
      }
      promjene.push({ kljuc, staro, novo, changedBy: who, source, changed })
    }
  })()
  return promjene
}

export interface RazgovorPovijestRed {
  kljuc: string
  staro: string | null
  novo: string
  changedBy: string
  source: string
  changedAt: string
}

export function razgovorPovijest(db: Database, limit = 30): RazgovorPovijestRed[] {
  const kljucevi = Object.values(RAZGOVOR_KLJUCEVI)
  try {
    const rows = db.query(
      `SELECT key, old_value, new_value, changed_by, source, changed_at FROM settings_history
       WHERE key IN (${kljucevi.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`,
    ).all(...kljucevi, limit) as Array<{ key: string; old_value: string | null; new_value: string; changed_by: string; source: string; changed_at: string }>
    return rows.map(r => ({
      kljuc: r.key, staro: r.old_value, novo: r.new_value,
      changedBy: r.changed_by, source: r.source, changedAt: r.changed_at,
    }))
  } catch { return [] }
}

/**
 * Čitač za dugotrajni proces (poller, razgovor): baza najviše jednom u `ttlMs` (≤5 s).
 * Nečitljiva baza → zadnje dobro stanje → zadano (razgovor isključen).
 */
export function createRazgovorReader(o: { dbPath: string; ttlMs?: number; now?: () => number; dopustiPuno?: boolean }): () => RazgovorStanje {
  const ttl = Math.min(o.ttlMs ?? RAZGOVOR_CACHE_MS, RAZGOVOR_CACHE_MS)
  const now = o.now ?? Date.now
  let kes: RazgovorStanje | null = null
  let procitano = -Infinity
  return () => {
    const t = now()
    if (kes && t - procitano < ttl) return kes
    procitano = t
    let db: Database | null = null
    try {
      db = new Database(o.dbPath, { readonly: true })
      kes = getRazgovorPostavke(db, { dopustiPuno: o.dopustiPuno ?? puniDopusten() })
    } catch {
      if (!kes) kes = { postavke: { ...RAZGOVOR_ZADANO, dopusteniKorisnici: [], preskociAkoSadrzi: [] }, izBaze: [], upozorenja: ['baza nije čitljiva'] }
    } finally {
      try { db?.close() } catch { /* ništa */ }
    }
    return kes
  }
}
