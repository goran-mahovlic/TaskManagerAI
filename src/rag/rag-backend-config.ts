/**
 * Konfiguracija RAG pozadinskih sustava (ChromaDB / pgvector / dual).
 *
 * JEDNO mjesto koje zna odakle dolaze adrese i lozinka — čitaju ga i tvornica
 * (`rag-backend-factory.ts`) i servis ploče (`RAGBackendService.ts`).
 *
 * Redoslijed (viši pobjeđuje):
 *   1. okolina — TM_RAG_BACKEND, TM_CHROMA_HOST/TM_CHROMA_PORT,
 *      TM_PGVECTOR_HOST/TM_PGVECTOR_PORT/TM_PGVECTOR_DATABASE/TM_PGVECTOR_USER;
 *   2. `rag-backend.json` — `konfigPutanja('rag-backend.json', 'TM_RAG_BACKEND_CONFIG')`;
 *   3. ništa. Adresa NIKAD nije zadana vrijednost u kodu (ADR-0001 O1.2): prazan domaćin
 *      znači „nije podešeno" i nijedan mrežni poziv se ne radi.
 *
 * LOZINKA za pgvector: SAMO `TM_PGVECTOR_PASSWORD` iz okoline ili iz datoteke tajni
 * (`credentials.env`, v. `core/ConfigModul.ts → procitajTajnu`). JSON je nikad ne nosi:
 * `spremiRagBackendKonfig` polje `password` odbija, a učitavanje ga ignorira.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { konfigPutanja, konfigPutanjaZaPisanje, osigurajMapu } from '../core/paths'
import { procitajTajnu, tajnaPostavljena } from '../core/ConfigModul'
import type { BackendType } from './adapters/rag-backend.interface'

export const IME_KONFIGURACIJE = 'rag-backend.json'
export const ENV_KONFIGURACIJE = 'TM_RAG_BACKEND_CONFIG'
/** Ime tajne (okolina ili `credentials.env`). Vrijednost se nikad ne vraća kroz API. */
export const ENV_LOZINKE = 'TM_PGVECTOR_PASSWORD'

export const BACKENDI: readonly BackendType[] = ['chromadb', 'pgvector', 'dual'] as const

/** Zadani port ChromaDB-a — isti kao u `RAGService.ts` (port bez domaćina ne znači ništa). */
const ZADANI_CHROMA_PORT = 8000

/** Oblik datoteke `rag-backend.json` (sve je opcijsko). */
export interface RagBackendDatoteka {
  backend?: BackendType
  /** Smije li „Probaj konekciju" na privatne raspone (ProbeGuard). Zadano `true`. */
  dopustiPrivatneMreze?: boolean
  chroma?: { host?: string; port?: number }
  pgvector?: {
    host?: string
    port?: number
    database?: string
    user?: string
    maxConnections?: number
    dimensions?: number
  }
}

/** Razriješena konfiguracija — BEZ lozinke. */
export interface RagBackendPostavke {
  backend: BackendType
  dopustiPrivatneMreze: boolean
  /** Odakle je pročitano (null ako datoteke nema). */
  izvor: string | null
  chroma: { configured: boolean; host: string; port: number }
  pgvector: {
    configured: boolean
    host: string
    port: number | null
    database: string
    user: string
    maxConnections?: number
    dimensions?: number
  }
}

export function putanjaKonfiguracije(): string {
  return konfigPutanja(IME_KONFIGURACIJE, ENV_KONFIGURACIJE)
}

export function putanjaKonfiguracijeZaPisanje(): string {
  return konfigPutanjaZaPisanje(IME_KONFIGURACIJE, ENV_KONFIGURACIJE)
}

// ─── Provjere ────────────────────────────────────────────────────────────────

/** Domaćin bez sheme, putanje i vjerodajnica: ime, IPv4 ili IPv6 u zagradama. */
const DOMACIN_RE = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/
/** Ime baze / korisnika u PostgreSQL-u — bez navodnika i razmaka. */
const IDENTIFIKATOR_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,62}$/

export function ispravanDomacin(h: unknown): boolean {
  return typeof h === 'string' && DOMACIN_RE.test(h.trim())
}

export function ispravanPort(p: unknown): boolean {
  const n = Number(p)
  return Number.isInteger(n) && n >= 1 && n <= 65535
}

export function ispravanIdentifikator(s: unknown): boolean {
  return typeof s === 'string' && IDENTIFIKATOR_RE.test(s.trim())
}

export function ispravanBackend(b: unknown): b is BackendType {
  return typeof b === 'string' && (BACKENDI as readonly string[]).includes(b)
}

/** Chroma domaćin bez sheme i porta (klijent ih prima zasebno). */
function ocistiChromaDomacin(h: string): string {
  return (h || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/:\d+$/, '')
}

// ─── Čitanje ─────────────────────────────────────────────────────────────────

function procitajDatoteku(): { podatci: RagBackendDatoteka; izvor: string | null } {
  const put = putanjaKonfiguracije()
  if (!existsSync(put)) return { podatci: {}, izvor: null }
  try {
    const j = JSON.parse(readFileSync(put, 'utf-8'))
    return { podatci: j && typeof j === 'object' ? j : {}, izvor: put }
  } catch {
    // Neispravan JSON ne smije srušiti ploču — ponašamo se kao da datoteke nema.
    return { podatci: {}, izvor: null }
  }
}

/** Razriješi postavke (okolina > datoteka > ništa). Čita se pri SVAKOM pozivu. */
export function ucitajRagBackendKonfig(): RagBackendPostavke {
  const { podatci: d, izvor } = procitajDatoteku()
  const e = process.env

  const backendSirovi = e.TM_RAG_BACKEND || d.backend
  const backend: BackendType = ispravanBackend(backendSirovi) ? backendSirovi : 'chromadb'

  const chromaHost = ocistiChromaDomacin(e.TM_CHROMA_HOST || d.chroma?.host || '')
  const chromaPort = Number(e.TM_CHROMA_PORT || d.chroma?.port) || ZADANI_CHROMA_PORT

  const pg = d.pgvector || {}
  const pgHost = String(e.TM_PGVECTOR_HOST || pg.host || '').trim()
  const pgPortSirovi = e.TM_PGVECTOR_PORT || pg.port
  const pgPort = ispravanPort(pgPortSirovi) ? Number(pgPortSirovi) : null
  const pgDatabase = String(e.TM_PGVECTOR_DATABASE || pg.database || '').trim()
  const pgUser = String(e.TM_PGVECTOR_USER || pg.user || '').trim()

  const out: RagBackendPostavke = {
    backend,
    dopustiPrivatneMreze: d.dopustiPrivatneMreze !== false,
    izvor,
    chroma: { configured: !!chromaHost, host: chromaHost, port: chromaPort },
    pgvector: {
      configured: !!(pgHost && pgPort && pgDatabase && pgUser),
      host: pgHost,
      port: pgPort,
      database: pgDatabase,
      user: pgUser,
    },
  }
  if (Number(pg.maxConnections) > 0) out.pgvector.maxConnections = Number(pg.maxConnections)
  if (Number(pg.dimensions) > 0) out.pgvector.dimensions = Number(pg.dimensions)
  return out
}

/** Lozinka za KONEKCIJU (nikad za prikaz). `null` ako nije postavljena. */
export function pgLozinka(): string | null {
  return procitajTajnu(ENV_LOZINKE)
}

/** Je li lozinka postavljena — samo da/ne, bez vrijednosti. */
export function pgLozinkaPostavljena(): boolean {
  return tajnaPostavljena(ENV_LOZINKE)
}

// ─── Pisanje ─────────────────────────────────────────────────────────────────

export interface ZakrpaKonfiga {
  backend?: BackendType
  pgvector?: { host?: string; port?: number; database?: string; user?: string }
}

/**
 * Upiši (djelomičnu) konfiguraciju u `rag-backend.json` — atomski, preko privremene datoteke.
 * Piše SAMO datoteku; okolina ostaje stvar okoline. Lozinka se odbija.
 */
export function spremiRagBackendKonfig(zakrpa: ZakrpaKonfiga & Record<string, any>):
  { ok: true; postavke: RagBackendPostavke } | { ok: false; greska: string } {
  if (!zakrpa || typeof zakrpa !== 'object') return { ok: false, greska: 'prazna zakrpa' }
  if ('password' in zakrpa || (zakrpa.pgvector && 'password' in zakrpa.pgvector)) {
    return { ok: false, greska: `lozinka ne ide u konfiguraciju — postavi ${ENV_LOZINKE} (okolina ili credentials.env)` }
  }
  if (zakrpa.backend !== undefined && !ispravanBackend(zakrpa.backend)) {
    return { ok: false, greska: `nepoznat backend: ${String(zakrpa.backend).slice(0, 40)} (chromadb | pgvector | dual)` }
  }
  const p = zakrpa.pgvector
  if (p) {
    if (p.host !== undefined && !ispravanDomacin(p.host)) return { ok: false, greska: 'neispravan domaćin (bez sheme, putanje i vjerodajnica)' }
    if (p.port !== undefined && !ispravanPort(p.port)) return { ok: false, greska: 'port mora biti cijeli broj 1–65535' }
    if (p.database !== undefined && !ispravanIdentifikator(p.database)) return { ok: false, greska: 'neispravno ime baze' }
    if (p.user !== undefined && !ispravanIdentifikator(p.user)) return { ok: false, greska: 'neispravno korisničko ime' }
  }

  const put = putanjaKonfiguracijeZaPisanje()
  let naDisku: any = {}
  if (existsSync(put)) {
    try { naDisku = JSON.parse(readFileSync(put, 'utf-8')) || {} } catch { naDisku = {} }
  }
  // Staro polje lozinke (ako ga je netko ručno upisao) se pri zapisu briše.
  if (naDisku.pgvector && typeof naDisku.pgvector === 'object') delete naDisku.pgvector.password
  delete naDisku.password

  const sljedeci: any = { ...naDisku }
  if (zakrpa.backend !== undefined) sljedeci.backend = zakrpa.backend
  if (p) {
    const cist: Record<string, unknown> = {}
    if (p.host !== undefined) cist.host = String(p.host).trim()
    if (p.port !== undefined) cist.port = Number(p.port)
    if (p.database !== undefined) cist.database = String(p.database).trim()
    if (p.user !== undefined) cist.user = String(p.user).trim()
    sljedeci.pgvector = { ...(naDisku.pgvector || {}), ...cist }
  }
  sljedeci.updated_at = new Date().toISOString()

  try {
    osigurajMapu(put)
    const tmp = `${put}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(sljedeci, null, 2) + '\n', 'utf-8')
    renameSync(tmp, put)
  } catch (e: any) {
    return { ok: false, greska: `zapis nije uspio: ${String(e?.message || e)}` }
  }
  return { ok: true, postavke: ucitajRagBackendKonfig() }
}
