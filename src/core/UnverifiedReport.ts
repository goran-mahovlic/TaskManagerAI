/**
 * UnverifiedReport — vratar koji NIJE ništa provjerio mora se javiti (T10 / TASK-3575).
 *
 * PROBLEM (izmjereno 01.09.2026. na data/critic_gate.jsonl):
 *   pass 49, fail 4, **unverifiable 53** — dakle POLOVICA prolaza kroz vrata nije
 *   provjerila baš ništa, a `decideNextAction` je za sve što nije `fail` vraćao običan
 *   `accept`, bez ijedne dojave. Primjer: TASK-3571 (malik, 6,57 USD, 1328 s) prošao je s
 *   `critic-gate: UNVERIFIABLE ... checks=0 failed=0 akcija=accept live`. Rad je bio dobar,
 *   ali vratar to NIJE ZNAO — nije imao što pokrenuti. Tiho „prošlo" i „nisam imao čime
 *   provjeriti" izgledaju na ploči jednako, a to je upravo laž koju vrata trebaju spriječiti.
 *
 * ŠTO OVAJ MODUL RADI, A ŠTO NE:
 *   • NE blokira. `unverifiable` i `partial` ostaju NEBLOKIRAJUĆI — rad se ne zaustavlja.
 *     Blokira i dalje samo `fail` (determinističan dokaz: naredba + izlazni kod).
 *   • PRIJAVLJUJE, i to imenovanjem onoga što je NEDOSTAJALO (`explainUnverified`), nikad
 *     samo riječi „unverifiable". Dojava bez razloga je šum koji se za tjedan dana isključi.
 *   • ŠTITI OD BUKE: jedna dojava po zadatku (ne po krugu), a preko praga iz
 *     `config/unverified-alert.json` prelazi se na JEDAN dnevni sažetak. Prag je namjerno
 *     u konfiguraciji, ne u kodu: broj se mijenja bez restarta i bez izmjene koda.
 *
 * ZAŠTO STANJE NA DISKU, A NE `Set` U MEMORIJI: daemon se restarta (kill -9 + keeper), a
 *   skup „već sam javio" u memoriji bi se tada ispraznio i isti bi zadaci alarmirali
 *   ponovno. Isti kvar koji je `_alarmedStaleTasks` preživio jer se epizode ne pamte —
 *   ovdje se pamte, u data/unverified_alerts.json.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { konfigPutanja, stanjePutanja } from './paths'
import {
  criticLedgerPath,
  type CriticStatus,
  type LedgerRound,
} from './CriticGate'
import { isTestRuntime } from './LiveDbGuard'


export const UNVERIFIED_CONFIG_PATH = konfigPutanja('unverified-alert.json', 'TM_UNVERIFIED_CONFIG')

/** Zadano stanje dojava — uz bazu (`$TM_HOME/data`), ADR-0001 O1.1. */
const ZADANO_STANJE = stanjePutanja('unverified_alerts.json')

/** `REGOC_UNVERIFIED_STATE` je override SAMO za testove/alat (v. LiveDbGuard, TASK-3020). */
export function unverifiedStatePath(): string {
  return process.env.REGOC_UNVERIFIED_STATE || ZADANO_STANJE
}

// ─── Konfiguracija (prag je OVDJE, ne u kodu) ────────────────────────────────

export interface UnverifiedConfig {
  /** Koliko pojedinačnih dojava dnevno prije prelaska na dnevni sažetak. */
  dailyAlertThreshold: number
  /** Sat (lokalno) u koji se šalje dnevni sažetak odgođenih zadataka. */
  summaryHour: number
  /** Zona za „danas" i za sat sažetka. Kontejner radi u UTC-u, pa se navodi izrijekom. */
  timeZone: string
  /** Najviše razloga po dojavi (ostatak se PREBROJI, ne prešuti). */
  maxReasons: number
  /** Javlja li se i `partial` („ništa nije palo, ali nisam sve stigao"). */
  includePartial: boolean
  /** Najviše zadataka nabrojanih u dnevnom sažetku (ostatak se prebroji). */
  maxSummaryTasks: number
}

export const DEFAULT_UNVERIFIED_CONFIG: UnverifiedConfig = {
  dailyAlertThreshold: 3,
  summaryHour: 20,
  timeZone: 'Europe/Zagreb',
  maxReasons: 6,
  includePartial: true,
  maxSummaryTasks: 25,
}

const CONFIG_TTL_MS = 30_000
let _cfgCache: UnverifiedConfig | null = null
let _cfgLoadedAt = 0
let _cfgFrom = ''

/** Učitaj konfiguraciju (keš 30 s ⇒ promjena praga djeluje bez restarta daemona). */
export function loadUnverifiedConfig(path = UNVERIFIED_CONFIG_PATH, force = false): UnverifiedConfig {
  const now = Date.now()
  if (!force && _cfgCache && path === _cfgFrom && now - _cfgLoadedAt < CONFIG_TTL_MS) return _cfgCache
  const cfg: UnverifiedConfig = { ...DEFAULT_UNVERIFIED_CONFIG }
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf-8'))
      for (const key of Object.keys(DEFAULT_UNVERIFIED_CONFIG) as Array<keyof UnverifiedConfig>) {
        const v = (raw as any)?.[key]
        if (v === undefined || v === null) continue
        const def = DEFAULT_UNVERIFIED_CONFIG[key]
        if (typeof def === 'number' && typeof v === 'number' && Number.isFinite(v)) (cfg as any)[key] = v
        else if (typeof def === 'string' && typeof v === 'string' && v) (cfg as any)[key] = v
        else if (typeof def === 'boolean' && typeof v === 'boolean') (cfg as any)[key] = v
      }
    }
  } catch {
    // Neispravan JSON → defaulti. Dojava nikad ne smije srušiti poziv koji je zove.
  }
  // Prag 0 bi značio „sve odmah u sažetak", što je legitimno; negativan je besmislen.
  if (cfg.dailyAlertThreshold < 0) cfg.dailyAlertThreshold = DEFAULT_UNVERIFIED_CONFIG.dailyAlertThreshold
  if (cfg.summaryHour < 0 || cfg.summaryHour > 23) cfg.summaryHour = DEFAULT_UNVERIFIED_CONFIG.summaryHour
  if (cfg.maxReasons < 1) cfg.maxReasons = DEFAULT_UNVERIFIED_CONFIG.maxReasons
  if (cfg.maxSummaryTasks < 1) cfg.maxSummaryTasks = DEFAULT_UNVERIFIED_CONFIG.maxSummaryTasks
  _cfgCache = cfg
  _cfgLoadedAt = now
  _cfgFrom = path
  return cfg
}

// ─── Vrijeme: „danas" je LOKALNI dan, ne UTC dan ─────────────────────────────

/**
 * Lokalni dan (YYYY-MM-DD). Kontejner nema `TZ` i radi u UTC-u, pa bi bez izričite zone
 * „danas" počinjalo u 02:00 po Zagrebu — isti kvar koji je A7/TASK-3006 već platio na
 * traci za reset kvote (pisala je 02:40 umjesto 04:40).
 */
export function localDay(ms: number, timeZone = DEFAULT_UNVERIFIED_CONFIG.timeZone): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}

/** Lokalni sat (0–23) u istoj zoni. */
export function localHour(ms: number, timeZone = DEFAULT_UNVERIFIED_CONFIG.timeZone): number {
  try {
    const h = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(new Date(ms))
    const n = Number(h)
    return Number.isFinite(n) ? n : new Date(ms).getUTCHours()
  } catch {
    return new Date(ms).getUTCHours()
  }
}

// ─── 1. RAZLOG: što je točno nedostajalo ─────────────────────────────────────

/**
 * `explainUnverified` živi u `CriticGate.ts` (uz sud iz čijih polja i nastaje) i ovdje se
 * samo prosljeđuje. Zašto ne ovdje: `CriticGate` ga zove pri pisanju traga, pa bi obrnut
 * smjer napravio kružni uvoz i razlog bi u tragu ovisio o redoslijedu učitavanja modula.
 */
export { explainUnverified } from './CriticGate'

// ─── 2. Stanje dojava (preživljava restart daemona) ──────────────────────────

export interface UnverifiedState {
  /** Lokalni dan na koji se odnose `alerted`/`deferred`. */
  day: string
  /** Zadaci koji su dobili POJEDINAČNU dojavu (jedna po zadatku, ne po krugu). */
  alerted: string[]
  /** Zadaci koji čekaju dnevni sažetak (prag je premašen). */
  deferred: string[]
  /** Kad je zadnji sažetak poslan (ISO) — sprječava dva sažetka u istom danu. */
  summarySentAt: string | null
}

export function emptyUnverifiedState(day: string): UnverifiedState {
  return { day, alerted: [], deferred: [], summarySentAt: null }
}

export function readUnverifiedState(path = unverifiedStatePath(), nowMs = Date.now(), timeZone = DEFAULT_UNVERIFIED_CONFIG.timeZone): UnverifiedState {
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf-8'))
      if (raw && typeof raw === 'object' && typeof raw.day === 'string') {
        return {
          day: raw.day,
          alerted: Array.isArray(raw.alerted) ? raw.alerted.filter((x: any) => typeof x === 'string') : [],
          deferred: Array.isArray(raw.deferred) ? raw.deferred.filter((x: any) => typeof x === 'string') : [],
          summarySentAt: typeof raw.summarySentAt === 'string' ? raw.summarySentAt : null,
        }
      }
    }
  } catch { /* pokvarena datoteka ⇒ počinjemo od danas, nikad iznimka */ }
  return emptyUnverifiedState(localDay(nowMs, timeZone))
}

/**
 * Smije li se OVDJE pisati? Isti razlog i isti detektor kao `ledgerWriteAllowed` u
 * `CriticGate` (LiveDbGuard, TASK-3020): kraj-do-kraja harness (`mode-classify-e2e`)
 * pokreće PRAVI `processMessage`, pa je pri prvom pokretanju ovog modula u živo stanje
 * upisao lažni „javljeno: TASK-TEST-2559". Da je ostalo tako, prva bi prava dojava tog
 * dana bila prešućena kao duplikat. Izlaz za nuždu: REGOC_UNVERIFIED_STATE.
 */
export function stateWriteAllowed(path: string): boolean {
  if (!isTestRuntime()) return true
  return path !== ZADANO_STANJE
}

export function writeUnverifiedState(state: UnverifiedState, path = unverifiedStatePath()): boolean {
  if (!stateWriteAllowed(path)) return false
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(state, null, 2))
    return true
  } catch { return false }
}

// ─── 3. Odluka: javiti, prešutjeti (već javljeno) ili odgoditi u sažetak ─────

export type UnverifiedAction =
  /** Pošalji pojedinačnu dojavu sada. */
  | 'alert'
  /** Ovaj zadatak je danas već prijavljen — šuti (dojava po zadatku, ne po krugu). */
  | 'skip-duplicate'
  /** Prag je premašen — zadatak ide u dnevni sažetak. */
  | 'defer'
  /** Sud nije `unverifiable`/`partial` (ili je `partial` isključen konfiguracijom). */
  | 'ignore'

export interface UnverifiedDecision {
  action: UnverifiedAction
  reason: string
  /** Stanje nakon odluke — pozivatelj ga zapisuje SAMO ako je i dojavu stvarno obavio. */
  state: UnverifiedState
}

/** Javlja li se uopće ovaj sud? `fail` ide svojim (blokirajućim) putem. */
export function reportableStatus(status: CriticStatus, cfg: UnverifiedConfig): boolean {
  if (status === 'unverifiable') return true
  if (status === 'partial') return cfg.includePartial
  return false
}

export function decideUnverifiedAlert(
  state: UnverifiedState,
  input: { taskId: string; status: CriticStatus; nowMs: number },
  cfg: UnverifiedConfig = loadUnverifiedConfig(),
): UnverifiedDecision {
  const day = localDay(input.nowMs, cfg.timeZone)
  const base = state.day === day ? state : emptyUnverifiedState(day)
  if (!reportableStatus(input.status, cfg)) {
    return { action: 'ignore', reason: `sud=${input.status} ne ide u dojavu`, state: base }
  }
  const id = input.taskId || 'bez-zadatka'
  if (base.alerted.includes(id) || base.deferred.includes(id)) {
    return { action: 'skip-duplicate', reason: `${id} je danas već prijavljen`, state: base }
  }
  if (base.alerted.length >= cfg.dailyAlertThreshold) {
    return {
      action: 'defer',
      reason: `prag ${cfg.dailyAlertThreshold} pojedinačnih dojava je premašen — ide u dnevni sažetak`,
      state: { ...base, deferred: [...base.deferred, id] },
    }
  }
  return {
    action: 'alert',
    reason: `${base.alerted.length + 1}. dojava danas (prag ${cfg.dailyAlertThreshold})`,
    state: { ...base, alerted: [...base.alerted, id] },
  }
}

// ─── 4. Dnevni sažetak ───────────────────────────────────────────────────────

export interface SummaryDue {
  due: boolean
  /** Dan na koji se sažetak odnosi (može biti JUČER, kad je dojava stigla nakon ponoći). */
  day: string
  taskIds: string[]
  reason: string
}

export function summaryDue(
  state: UnverifiedState,
  nowMs: number,
  cfg: UnverifiedConfig = loadUnverifiedConfig(),
): SummaryDue {
  const today = localDay(nowMs, cfg.timeZone)
  const none = { due: false, day: state.day, taskIds: state.deferred, reason: '' }
  if (!state.deferred.length) return { ...none, reason: 'nema odgođenih zadataka' }
  if (state.day !== today) {
    return { due: true, day: state.day, taskIds: state.deferred, reason: `novi dan (${today}) — šaljem sažetak za ${state.day}` }
  }
  if (localHour(nowMs, cfg.timeZone) >= cfg.summaryHour && !state.summarySentAt) {
    return { due: true, day: state.day, taskIds: state.deferred, reason: `dnevni termin (${cfg.summaryHour}:00)` }
  }
  return { ...none, reason: 'sažetak još nije na redu' }
}

/**
 * Stanje NAKON poslanog sažetka. Odgođeni se brišu (prijavljeni su); ako je sažetak bio
 * za jučer, dan se prevrće. Bez brisanja bi isti zadaci ušli i u sutrašnji sažetak.
 */
export function afterSummary(state: UnverifiedState, nowMs: number, cfg: UnverifiedConfig = loadUnverifiedConfig()): UnverifiedState {
  const today = localDay(nowMs, cfg.timeZone)
  if (state.day !== today) return emptyUnverifiedState(today)
  return { ...state, deferred: [], summarySentAt: new Date(nowMs).toISOString() }
}

// ─── 5. Tekstovi dojava ──────────────────────────────────────────────────────

export interface UnverifiedAlertInput {
  taskId: string
  agentId: string
  status: CriticStatus
  /** Trošak spawna u USD (iz JSON omotnice CLI-ja); `null` kad ga nema. */
  costUsd?: number | null
  durationS?: number | null
  reasons: string[]
  live?: boolean
  /**
   * TASK-4833/4834 §5.3: razina doc-provjere koja je PROŠLA. Kad je postavljena, tvrdnja
   * „vratar NIJE mogao provjeriti NIŠTA" postaje neistinita — nešto JEST provjereno (oblik
   * dokumenta), samo ne ono najvažnije (sadržaj). Dojava koja laže u prvoj rečenici gubi
   * povjerenje jednako brzo kao dojava koje nema.
   */
  razina?: 'L0' | 'L1' | null
  /** Dokumenti koji su ušli u doc-provjeru (imena ili putovi) — imenuju se u dojavi. */
  docChecked?: string[]
}

function money(costUsd?: number | null): string {
  return typeof costUsd === 'number' && Number.isFinite(costUsd)
    ? `${costUsd.toFixed(2).replace('.', ',')} USD`
    : 'trošak nepoznat'
}

function trajanje(s?: number | null): string {
  return typeof s === 'number' && Number.isFinite(s) ? `${Math.round(s)} s` : 'trajanje nepoznato'
}

export function formatUnverifiedAlert(i: UnverifiedAlertInput, cfg: UnverifiedConfig = loadUnverifiedConfig()): string {
  // Kad je doc-provjera prošla, glava IMENUJE razinu umjesto da tvrdi da nije provjereno
  // ništa (TASK-4833 §6: ishod se imenuje razinom, nikad golim „pass" ni golim „ništa").
  const glava = i.razina
    ? `vratar je provjerio SAMO ${i.razina === 'L1' ? 'oblik i traženu strukturu' : 'oblik'} dokumenta (${i.razina})`
    : i.status === 'partial'
      ? 'vratar NIJE stigao provjeriti sve'
      : 'vratar NIJE mogao provjeriti NIŠTA'
  const shown = i.reasons.slice(0, cfg.maxReasons)
  const rest = i.reasons.length - shown.length
  const lines = [
    `🔎 [neprovjereno] ${i.taskId} (${i.agentId}) — ${glava} (${i.status}). ${money(i.costUsd)}, ${trajanje(i.durationS)}. Rad NIJE zaustavljen.`,
  ]
  if (i.razina) {
    const docs = (i.docChecked || []).map((p) => p.split('/').pop() || p)
    lines.push(`Provjereno (${i.razina}): ${docs.length ? docs.join(', ') : 'dokument'} — tvar, naslovi, ograde, ostavljene rupe${i.razina === 'L1' ? ' i traženi odsjeci' : ''}.`)
    lines.push('NIJE provjereno: točnost tvrdnji, postojanje i vjerodostojnost izvora, ispravnost zaključaka — to je razina L2 (W5) i ona je ugašena do kalibracije.')
  }
  lines.push('Što je nedostajalo:')
  lines.push(...shown.map((r) => `  • ${r}`))
  if (rest > 0) lines.push(`  • (+ još ${rest} razloga)`)
  lines.push(`Provjeri ručno: bun src/core/CriticGate.ts ledger --task ${i.taskId}`)
  return lines.join('\n')
}

export interface SummaryRow {
  taskId: string
  agentId: string
  status: CriticStatus
  reasons: string[]
}

export function formatUnverifiedSummary(day: string, rows: SummaryRow[], cfg: UnverifiedConfig = loadUnverifiedConfig()): string {
  const shown = rows.slice(0, cfg.maxSummaryTasks)
  const rest = rows.length - shown.length
  const lines = [
    `🔎 [neprovjereno — dnevni sažetak ${day}] ${rows.length} zadataka je prošlo, a vratar ih nije mogao provjeriti (prag pojedinačnih dojava: ${cfg.dailyAlertThreshold}). Nijedan nije zaustavljen.`,
  ]
  for (const r of shown) {
    lines.push(`  • ${r.taskId} (${r.agentId}, ${r.status}) — ${r.reasons[0] || 'razlog nije zapisan'}`)
  }
  if (rest > 0) lines.push(`  • (+ još ${rest} zadataka)`)
  lines.push('Popis i razlozi: ploča → „Danas neprovjereno"')
  return lines.join('\n')
}

// ─── 6. Čitanje traga: ploča i sažetak koriste ISTI izvor ────────────────────

export interface UnverifiedTaskRow {
  taskId: string
  agentId: string
  status: CriticStatus
  ts: string
  reasons: string[]
}

export interface UnverifiedBoardState {
  day: string
  /** Koliko je RAZLIČITIH zadataka danas prošlo bez ijedne provjere. */
  todayCount: number
  /** Zadnji sud po zadatku — samo oni koji NISU provjereni (ulaz za oznaku na kartici). */
  tasks: Record<string, UnverifiedTaskRow>
}

/** Zadnji zapis po zadatku (trag je kronološki: kasniji krug nadjačava raniji). */
export function lastRoundPerTask(rows: LedgerRound[]): Map<string, LedgerRound> {
  const m = new Map<string, LedgerRound>()
  for (const r of rows) if (r && typeof r.taskId === 'string') m.set(r.taskId, r)
  return m
}

/** Cijeli trag (bez filtra po zadatku, za razliku od `readLedger`). Strop čuva od rasta. */
export function readLedgerAll(path = criticLedgerPath(), maxLines = 20_000): LedgerRound[] {
  try {
    if (!existsSync(path)) return []
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean)
    return lines
      .slice(-maxLines)
      .map((l) => { try { return JSON.parse(l) as LedgerRound } catch { return null } })
      .filter((r): r is LedgerRound => !!r)
  } catch { return [] }
}

/**
 * Stanje za ploču 17781. Namjerno se čita POSTOJEĆI `critic_gate.jsonl` — druga bi baza
 * značila da ploča i vrata mogu tvrditi suprotno o istom zadatku.
 */
export function unverifiedBoardState(
  path = criticLedgerPath(),
  nowMs = Date.now(),
  cfg: UnverifiedConfig = loadUnverifiedConfig(),
): UnverifiedBoardState {
  const day = localDay(nowMs, cfg.timeZone)
  const last = lastRoundPerTask(readLedgerAll(path))
  const tasks: Record<string, UnverifiedTaskRow> = {}
  const todayIds = new Set<string>()
  for (const [taskId, r] of last) {
    if (!reportableStatus(r.status, cfg)) continue
    if (taskId === 'bez-zadatka') continue
    const row: UnverifiedTaskRow = {
      taskId,
      agentId: r.agentId || 'nepoznat',
      status: r.status,
      ts: r.ts || '',
      reasons: Array.isArray((r as any).reasons) ? (r as any).reasons : (r.unrunnable || []),
    }
    tasks[taskId] = row
    const t = Date.parse(r.ts)
    if (Number.isFinite(t) && localDay(t, cfg.timeZone) === day) todayIds.add(taskId)
  }
  return { day, todayCount: todayIds.size, tasks }
}

/** Redci za dnevni sažetak — razlozi se čitaju iz traga, ne pamte u memoriji daemona. */
export function summaryRows(taskIds: string[], path = criticLedgerPath()): SummaryRow[] {
  const last = lastRoundPerTask(readLedgerAll(path))
  return taskIds.map((id) => {
    const r = last.get(id)
    return {
      taskId: id,
      agentId: r?.agentId || 'nepoznat',
      status: (r?.status || 'unverifiable') as CriticStatus,
      reasons: (r && (Array.isArray((r as any).reasons) ? (r as any).reasons : r.unrunnable)) || [],
    }
  })
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const cfg = loadUnverifiedConfig()
  const board = unverifiedBoardState(criticLedgerPath(), Date.now(), cfg)
  const state = readUnverifiedState()
  console.log(`Neprovjereno danas (${board.day}, zona ${cfg.timeZone}): ${board.todayCount}`)
  console.log(`Prag pojedinačnih dojava: ${cfg.dailyAlertThreshold}, sažetak u ${cfg.summaryHour}:00`)
  console.log(`Stanje dojava: dan=${state.day} javljeno=${state.alerted.length} odgođeno=${state.deferred.length} sažetak=${state.summarySentAt || 'nije slan'}`)
  const rows = Object.values(board.tasks).sort((a, b) => (a.ts < b.ts ? 1 : -1))
  for (const r of rows.slice(0, 40)) {
    console.log(`  ${r.ts}  ${r.taskId.padEnd(10)} ${r.agentId.padEnd(10)} ${r.status.padEnd(12)} ${r.reasons[0] || '(razlog nije zapisan)'}`)
  }
  if (rows.length > 40) console.log(`  … (+ ${rows.length - 40})`)
}
