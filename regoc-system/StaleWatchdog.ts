#!/usr/bin/env bun
/**
 * StaleWatchdog — odluka "je li in_progress task zaglavljen?" na JEDNOM mjestu.
 *
 * R2 / TASK-2560 (PRJ-030). Modul je JEDINI IZVOR ISTINE za pravilo; koriste ga:
 *   - RegocDaemon.watchdogStaleTasksDryRun()  → alarm (dry-run) / reclaim (live)
 *   - tools/stale-watchdog-report.ts          → izvještaj "što BI resetirao"
 * Ako se pravilo mijenja, mijenja se OVDJE — inače izvještaj laže o ponašanju daemona.
 *
 * Pravilo: task je `stale` ako je >N sati bez task-updatea I bez svježeg checkpointa
 * (`agent_checkpoints` u messages.db), a nije izuzet (tag / assignee / id).
 *
 * Autor: Jelena (Engineer) · 2026-07-28
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { jitteredBackoff } from './Backoff'
import { cwd as cwdProcesa } from './lib/platforma'
import { homedir } from 'os'

import { disanje, lanacVoditelja } from './VoditeljPogon'
import { citajStanje as citajStanjeVoditelja, citajPostavke as citajPostavkeVoditelja } from './VoditeljLanca'

const HOME = process.env.HOME || homedir()
export const STALE_WATCHDOG_CONFIG_PATH = join(HOME, '.claude', 'regoc', 'config', 'stale-watchdog.json')

// ============================================
// KONFIGURACIJA
// ============================================

/**
 * Izuzeća od AUTOMATSKE promjene statusa — zajednička za sve mehanizme koji diraju
 * tuđi task (R2 stale-watchdog, zombie-recovery, stari stale-reaper). Namjerno je
 * izdvojeno u vlastiti tip: `exclusionReason` je jedini kod koji smije reći „ne diraj",
 * pa tag `no-watchdog` znači isto bez obzira koji mehanizam pita. (TASK-3019)
 */
export interface ExclusionConfig {
  /**
   * EXCLUDE (revizija 2026-07-13): interaktivni/inline rad nema `agent_checkpoints`
   * pa bi ga watchdog krivo resetirao. Task s bilo kojim od ovih tagova se NIKAD ne dira.
   */
  excludeTags: string[]
  /** Assignee-whitelist — njihovi taskovi se ne diraju (npr. ljudski vlasnik). */
  excludeAssignees: string[]
  /** Pojedinačni task ID-evi izuzeti ručno. */
  excludeTaskIds: string[]
  /**
   * CANARY opseg: ako lista NIJE prazna, kandidat može biti SAMO task s ove liste —
   * sve ostalo je automatski izuzeto. Allowlist, ne denylist: denylist-snimka zastari
   * čim netko stvori novi task (dokazano 2026-07-28: canary s denylistom resetirao 21
   * tuđi test-task nastao unutar prozora).
   */
  onlyTaskIds: string[]
  /**
   * ADR-0024 O3 (TASK-5677): disanje voditelja lanca (`data/voditelji/<TASK>.json`). Zadano čita
   * datoteku stanja; testovi podmeću. Vrijedi samo za zadatak s `voditelj-lanca` + `lanac:<x>`.
   */
  disanjeVoditelja?: (taskId: string) => { svjez: boolean; razlog: string }
}

/** Zadano: stanje voditelja s diska + interval iz config/voditelj-lanca.json (uživo). */
export function disanjeVoditeljaIzDatoteke(taskId: string, now: number = Date.now()): { svjez: boolean; razlog: string } {
  try { return disanje(citajStanjeVoditelja(taskId), citajPostavkeVoditelja(), now) } catch (e) { return { svjez: false, razlog: `stanje nečitljivo (${e})` } }
}

export interface StaleWatchdogConfig extends ExclusionConfig {
  /** Koliko sati bez updatea I bez checkpointa dok se task ne proglasi zaglavljenim. */
  thresholdHours: number
  /** Razmak između provjera u daemonu (minute). */
  intervalMinutes: number
  /**
   * Sigurnosna brana za live: najviše toliko resetiranja po prolazu. Preko toga se
   * odustaje i šalje alarm — masovni reset je uvijek sumnjiv (kriva konfiguracija).
   */
  maxResetsPerRun: number
}

export const DEFAULT_STALE_WATCHDOG_CONFIG: StaleWatchdogConfig = {
  thresholdHours: 4,
  intervalMinutes: 30,
  // `waiting-for-human` pokriva nalaz iz dry-runa 2026-07-14 (TASK-2585 je čekao
  // Goranov odabir, nije bio mrtav) — čekanje na čovjeka nije zaglavljenost.
  excludeTags: ['no-watchdog', 'waiting-for-human', 'interactive'],
  excludeAssignees: ['user', 'goran'],
  excludeTaskIds: [],
  onlyTaskIds: [],
  maxResetsPerRun: 5,
}

/** Normalizirana lista (trim + lowercase); nešto što nije lista → fallback. Dijele je svi watchdogovi. */
export function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  return value.filter((v): v is string => typeof v === 'string').map(v => v.trim().toLowerCase())
}

/** Pozitivan konačan broj ili fallback — 0/negativno/NaN nikad ne smije postati prag. */
export function asPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Učitaj konfiguraciju; nedostajuća ili neispravna datoteka → defaulti (nikad ne baca).
 * Nepoznata polja se ignoriraju, poznata se normaliziraju (tagovi/assignee lowercase).
 */
export function loadStaleWatchdogConfig(path: string = STALE_WATCHDOG_CONFIG_PATH): StaleWatchdogConfig {
  const d = DEFAULT_STALE_WATCHDOG_CONFIG
  try {
    if (!existsSync(path)) return { ...d }
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (!raw || typeof raw !== 'object') return { ...d }
    return {
      thresholdHours: asPositiveNumber(raw.thresholdHours, d.thresholdHours),
      intervalMinutes: asPositiveNumber(raw.intervalMinutes, d.intervalMinutes),
      excludeTags: asStringArray(raw.excludeTags, d.excludeTags),
      excludeAssignees: asStringArray(raw.excludeAssignees, d.excludeAssignees),
      excludeTaskIds: asStringArray(raw.excludeTaskIds, d.excludeTaskIds),
      onlyTaskIds: asStringArray(raw.onlyTaskIds, d.onlyTaskIds),
      maxResetsPerRun: asPositiveNumber(raw.maxResetsPerRun, d.maxResetsPerRun),
    }
  } catch {
    return { ...d }
  }
}

// ============================================
// TIPOVI ODLUKE
// ============================================

/** Minimum koji trebamo iz TaskManager API-ja — namjerno labavo (API vraća više). */
export interface WatchdogTask {
  id: string
  title?: string
  assignee?: string | null
  status?: string
  tags?: string[]
  updatedAt?: string | null
  startedAt?: string | null
  createdAt?: string | null
}

export type StaleVerdict = 'fresh' | 'excluded' | 'stale'

export interface CheckpointInfo {
  ageMs: number
  /** `task` = checkpoint tog taska, `agent` = bilo koji checkpoint tog agenta. */
  source: 'task' | 'agent'
  createdAt: string
}

export interface StaleDecision {
  taskId: string
  title: string
  assignee: string
  staleMs: number
  staleHours: number
  lastActivity: string | null
  checkpoint: CheckpointInfo | null
  verdict: StaleVerdict
  /** Čitljiv razlog — ide doslovno u izvještaj i u alarm. */
  reason: string
}

export type CheckpointLookup = (taskId: string, assignee: string) => CheckpointInfo | null

// ============================================
// ODLUKA (čista funkcija — testabilna bez baze)
// ============================================

/**
 * Odluči za JEDAN task. Redoslijed je namjeran:
 *   1. svjež task-update  → fresh (najjeftinije, bez izuzeća i bez baze)
 *   2. izuzet             → excluded (nikad se ne dira, ni u live načinu)
 *   3. svjež checkpoint   → fresh (agent živ, samo ne piše u task)
 *   4. inače              → stale
 */
export function decideStaleTask(
  task: WatchdogTask,
  opts: { now: number; config: StaleWatchdogConfig; lookupCheckpoint?: CheckpointLookup }
): StaleDecision {
  const { now, config } = opts
  const thresholdMs = config.thresholdHours * 3_600_000
  const assignee = (task.assignee || '').trim()
  const lastActivity = task.updatedAt || task.startedAt || task.createdAt || null

  const base = {
    taskId: task.id,
    title: task.title || '',
    assignee,
    lastActivity,
    checkpoint: null as CheckpointInfo | null,
  }

  if (!lastActivity) {
    // Bez ijednog vremenskog traga ne možemo tvrditi zaglavljenost → ne diramo.
    return { ...base, staleMs: 0, staleHours: 0, verdict: 'fresh', reason: 'nema vremenskog traga (updatedAt/startedAt/createdAt)' }
  }

  const parsed = new Date(lastActivity).getTime()
  if (Number.isNaN(parsed)) {
    return { ...base, staleMs: 0, staleHours: 0, verdict: 'fresh', reason: `neispravan datum zadnje aktivnosti: ${lastActivity}` }
  }

  const staleMs = Math.max(0, now - parsed)
  const staleHours = Math.floor(staleMs / 3_600_000)

  if (staleMs < thresholdMs) {
    return { ...base, staleMs, staleHours, verdict: 'fresh', reason: `zadnji update prije ${formatAge(staleMs)} (< ${config.thresholdHours}h)` }
  }

  const excluded = exclusionReason(task, assignee, config)
  if (excluded) {
    return { ...base, staleMs, staleHours, verdict: 'excluded', reason: excluded }
  }

  const checkpoint = opts.lookupCheckpoint ? opts.lookupCheckpoint(task.id, assignee) : null
  if (checkpoint && checkpoint.ageMs < thresholdMs) {
    return {
      ...base,
      checkpoint,
      staleMs,
      staleHours,
      verdict: 'fresh',
      reason: `svjež checkpoint (${checkpoint.source}) prije ${formatAge(checkpoint.ageMs)} — agent živ`,
    }
  }

  const cpPart = checkpoint ? `zadnji checkpoint (${checkpoint.source}) prije ${formatAge(checkpoint.ageMs)}` : 'bez ijednog checkpointa'
  return {
    ...base,
    checkpoint,
    staleMs,
    staleHours,
    verdict: 'stale',
    reason: `in_progress ${formatAge(staleMs)} bez updatea, ${cpPart}`,
  }
}

/** Vrati razlog izuzeća ili null. Tag/assignee usporedba je case-insensitive. */
export function exclusionReason(task: WatchdogTask, assignee: string, config: ExclusionConfig): string | null {
  const id = (task.id || '').toLowerCase()
  // Allowlist ima prednost: dok je onlyTaskIds postavljen, sve izvan njega je izuzeto.
  if (config.onlyTaskIds.length > 0 && !config.onlyTaskIds.includes(id)) {
    return `izuzet: canary opseg (onlyTaskIds) ne uključuje ovaj task`
  }
  if (config.excludeTaskIds.includes(id)) return `izuzet: task ID na excludeTaskIds listi`

  const tags = (task.tags || []).filter(t => typeof t === 'string').map(t => t.toLowerCase())
  const hitTag = tags.find(t => config.excludeTags.includes(t))
  if (hitTag) return `izuzet: tag '${hitTag}' (interaktivni/ljudski rad nema agent_checkpoints)`

  if (assignee && config.excludeAssignees.includes(assignee.toLowerCase())) {
    return `izuzet: assignee '${assignee}' na whitelisti`
  }
  // ADR-0024 O3: voditelj lanca je između buđenja in_progress BEZ procesa — dok diše (svjež
  // sljedeceBudjenje ≤ 2 × interval) nije ni stale, ni zombie, ni siroče. Ne diše → obična pravila
  // (alarm „voditelj ne diše” šalje daemonov tick, jednom).
  if (lanacVoditelja(task.tags || []) && task.id) {
    const d = (config.disanjeVoditelja || disanjeVoditeljaIzDatoteke)(task.id)
    if (d.svjez) return `izuzet: voditelj lanca diše (${d.razlog})`
  }
  return null
}

/** Odluke za sve taskove, stabilno sortirane: stale prvo, pa najduže stajanje. */
export function evaluateStaleTasks(
  tasks: WatchdogTask[],
  opts: { now: number; config: StaleWatchdogConfig; lookupCheckpoint?: CheckpointLookup }
): StaleDecision[] {
  const order: Record<StaleVerdict, number> = { stale: 0, excluded: 1, fresh: 2 }
  return (tasks || [])
    .map(t => decideStaleTask(t, opts))
    .sort((a, b) => order[a.verdict] - order[b.verdict] || b.staleMs - a.staleMs)
}

// ============================================
// CHECKPOINT LOOKUP (messages.db)
// ============================================

/**
 * Lookup nad `agent_checkpoints`. Traži se najsvježiji od dva traga:
 *   - checkpoint VEZAN ZA TASK (task_id) — jak dokaz da se radi baš na njemu
 *   - bilo koji checkpoint AGENTA (agent_id) — slabiji, ali znači da agent živi
 * Starost se računa u SQL-u (`julianday`) pa je neovisna o TZ zapisu u bazi.
 */
export function makeCheckpointLookup(db: { prepare: (sql: string) => { get: (...args: any[]) => any } }): CheckpointLookup {
  const AGE_SQL = `CAST((julianday('now') - julianday(MAX(created_at))) * 86400000 AS INTEGER)`
  // TASK-5793: tablicu stvara AgentDaemon; čvor bez njega (macOS) nema je — tada nema traga,
  // a `prepare` ne smije srušiti cijeli prolaz nadzornika („no such table: agent_checkpoints").
  let byTask: { get: (...args: any[]) => any }
  let byAgent: { get: (...args: any[]) => any }
  try {
    byTask = db.prepare(
      `SELECT ${AGE_SQL} AS age_ms, MAX(created_at) AS created_at FROM agent_checkpoints WHERE task_id = ?`
    )
    byAgent = db.prepare(
      `SELECT ${AGE_SQL} AS age_ms, MAX(created_at) AS created_at FROM agent_checkpoints WHERE agent_id = ?`
    )
  } catch {
    return () => null
  }

  return (taskId: string, assignee: string): CheckpointInfo | null => {
    const candidates: CheckpointInfo[] = []
    try {
      const t = byTask.get(taskId) as any
      if (t?.age_ms != null) candidates.push({ ageMs: t.age_ms, source: 'task', createdAt: t.created_at })
      if (assignee) {
        const a = byAgent.get(assignee) as any
        if (a?.age_ms != null) candidates.push({ ageMs: a.age_ms, source: 'agent', createdAt: a.created_at })
      }
    } catch {
      return null
    }
    if (candidates.length === 0) return null
    // Najsvježiji trag odlučuje; kod izjednačenja task-trag je jači (stabilno).
    return candidates.sort((x, y) => x.ageMs - y.ageMs || (x.source === 'task' ? -1 : 1))[0]!
  }
}

// ============================================
// FORMAT
// ============================================

/** "3h 12min" / "2d 4h" / "45min" — kratko i čitljivo u alarmu i izvještaju. */
export function formatAge(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min}min`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ${min % 60}min`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Jedan redak izvještaja/loga — isti format u daemonu i u alatu. */
export function formatDecisionLine(d: StaleDecision): string {
  const mark = d.verdict === 'stale' ? '🛑' : d.verdict === 'excluded' ? '⏸️' : '✅'
  return `${mark} ${d.taskId.padEnd(10)} ${(d.assignee || '-').padEnd(10)} ${d.reason}`
}

// ════════════════════════════════════════════════════════════════════════════════════════
// NAKNADNA REVIZIJA BLOKIRANIH (TASK-5204, dizajn docs/DIZAJN-revizija-blokiranih.md)
//
// Drugi prolaz istog nadzornika zastoja, ovaj put nad `status=blocked`. Pravila su ovdje
// (SSOT) jer ih čitaju tri mjesta: daemon (`watchdogStaleTasksDryRun` → `revidirajBlokirane`),
// ploča (`/api/blokirani/revizija`, „sljedeća revizija za …”) i izvještaj
// (`tools/stale-watchdog-report.ts --blocked`). Puštanje NIKAD ne ide u `cancelled`.
// ════════════════════════════════════════════════════════════════════════════════════════


export const BLOK_KLASE = ['prolazno', 'kriticar', 'covjek', 'odluka', 'lanac', 'datum', 'deploy',
  'sustav', 'sigurnost', 'novac', 'vanjsko', 'zastarjelo', 'nepoznato'] as const
export type BlokKlasa = typeof BLOK_KLASE[number]

/** Zatvoren popis (§6.1) — dopunjuje se samo Goranovom odlukom. Ove se klase NIKAD ne puštaju. */
export const UVIJEK_GORANU: BlokKlasa[] = ['odluka', 'covjek', 'sustav', 'sigurnost', 'novac', 'vanjsko']
/** Rizik (§6.2): uz `waiting-for-human` dobivaju i `no-autonomy`. */
export const RIZICNE_KLASE: BlokKlasa[] = ['sustav', 'sigurnost', 'novac', 'vanjsko']

const BLOK_TAG = /^blok:(.+)$/
const REDRIVE_TAG = /^redrive:(\d+)$/
const KRITIKA_TAG = /^kritika:(\d+)$/

function listaOznaka(tags: unknown): string[] {
  return Array.isArray(tags) ? tags.map(t => String(t)) : []
}

export function jeBlokKlasa(k: unknown): k is BlokKlasa {
  return typeof k === 'string' && (BLOK_KLASE as readonly string[]).includes(k)
}

/** Klasa iz oznake `blok:<k>`; nepoznata klasa se ignorira (null). */
export function klasaIzOznaka(tags: unknown): BlokKlasa | null {
  for (const t of listaOznaka(tags)) {
    const m = BLOK_TAG.exec(t.trim().toLowerCase())
    if (m && jeBlokKlasa(m[1])) return m[1]
  }
  return null
}

/** Jedina pomoćna funkcija za oznaku klase — stara `blok:*` se ZAMJENJUJE, ne gomila. */
export function withBlokTag(tags: unknown, klasa: BlokKlasa): string[] {
  const out: string[] = []
  for (const t of listaOznaka(tags)) {
    if (BLOK_TAG.test(t)) continue
    if (!out.includes(t)) out.push(t)
  }
  out.push(`blok:${klasa}`)
  return out
}

/** Brojač ponovnih puštanja revizije — odvojen od `pokusaj:` (FailRequeue) i `kritika:`. */
export function redriveIzOznaka(tags: unknown): number {
  let n = 0
  for (const t of listaOznaka(tags)) { const m = REDRIVE_TAG.exec(t); if (m) n = Math.max(n, Number(m[1])) }
  return n
}

export function withRedriveTag(tags: unknown, n: number): string[] {
  const out: string[] = []
  for (const t of listaOznaka(tags)) {
    if (REDRIVE_TAG.test(t)) continue
    if (!out.includes(t)) out.push(t)
  }
  out.push(`redrive:${n}`)
  return out
}

function dodajOznake(tags: string[], ...nove: string[]): string[] {
  const out = [...tags]
  for (const n of nove) if (!out.includes(n)) out.push(n)
  return out
}

// ─── Rizik (TS prijevod `tools/orkestracija/odlucitelj.py` RIZIK + NIJECNICA) ──────────
// Python `\b` i `\w` su Unicode; JS ih ima samo za ASCII, pa se oba prevode izričito —
// inače „čisti” ili „€” daju drukčiji pogodak nego u odlučitelju (test pariteta, §10.1 t. 2).
const W = '[\\p{L}\\p{N}_]'
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`
function pyRe(src: string): RegExp {
  return new RegExp(src.replace(/\\b/g, B).replace(/\\w/g, W), 'giu')
}

/** Isti redoslijed i isti nazivi kao `RIZIK` u odlucitelj.py (r. 104–115). */
const RIZIK_ODLUCITELJA: Array<[string, RegExp]> = [
  ['novac', pyRe('\\b(eur|usd|€|\\$|kupi|kupnj|plati|plaćanj|placanj|račun|racun|naplat|ponud|' +
    'kredit|pretplat|licenc|narudžb|narudzb)\\w*')],
  ['brisanje', pyRe('\\b(obriši|obrisi|izbriši|izbrisi|briš|bris|delete|drop\\s+table|rm\\s+-rf|' +
    'purge|očisti|ocisti|ukloni|reset)\\w*')],
  ['vanjski učinak', pyRe('\\b(pošalji|posalji|slanje|e-?mail|mail|klijent|naručitelj|narucitelj|' +
    'objavi|push|deploy|produkcij|uživo|uzivo|live|javno|kupac)\\w*')],
  ['tajne', pyRe('\\b(ključ|kljuc|lozink|token|credential|api[\\s_-]?key|tajn)\\w*')],
  ['nepovratno', pyRe('\\b(migracij|selidb|preseli|nadogradnj|upgrade)\\w*')],
]
/** Dodatni uzorci za `sustav` (§6.2) — nisu u odlučitelju, pa nisu dio testa pariteta. */
const RIZIK_SUSTAV = pyRe('\\b(features\\.json|regocdaemon|entrypoint|docker|restart|capguard|settings)\\w*')

const NIJECNICA = new RegExp(`${B}(ne|nemoj|nikad|nikada|bez)${B}[\\s\\p{L}\\p{N}_,„”"'\`()-]{0,24}$`, 'iu')

function stvaranPogodak(tekst: string, uzorak: RegExp): string | null {
  uzorak.lastIndex = 0
  for (const m of tekst.matchAll(uzorak)) {
    const i = m.index ?? 0
    if (!NIJECNICA.test(tekst.slice(Math.max(0, i - 40), i))) return m[0]
  }
  return null
}

/** Doslovni paritet s `odlucitelj.py rizik()` — naslov + opis, vraća Pythonov naziv ili null. */
export function rizikOdlucitelja(title: string, description: string): string | null {
  const tekst = `${title || ''}\n${description || ''}`.toLowerCase()
  for (const [naziv, uzorak] of RIZIK_ODLUCITELJA) if (stvaranPogodak(tekst, uzorak)) return naziv
  return null
}

const RIZIK_U_KLASU: Record<string, BlokKlasa> = {
  'novac': 'novac', 'tajne': 'sigurnost', 'brisanje': 'sustav', 'nepovratno': 'sustav', 'vanjski učinak': 'vanjsko',
}

export interface RizikPogodak { klasa: BlokKlasa; naziv: string; pogodak: string }

/**
 * Prepoznaj rizik (§6.2). Deterministički, preteže nad svim drugim klasama osim
 * `zastarjelo`/`datum` (one se ionako nikad ne puštaju). `blockedReason` ulazi samo kad
 * je ljudski tekst — strojna dijagnostika spawna („…manage.sh restart”) nije namjera zadatka.
 */
export function prepoznajRizik(title: string, description: string, blockedReason: string): RizikPogodak | null {
  const tekst = `${title || ''}\n${description || ''}\n${blockedReason || ''}`.toLowerCase()
  for (const [naziv, uzorak] of RIZIK_ODLUCITELJA) {
    const p = stvaranPogodak(tekst, uzorak)
    if (p) return { klasa: RIZIK_U_KLASU[naziv]!, naziv, pogodak: p }
  }
  const s = stvaranPogodak(tekst, RIZIK_SUSTAV)
  return s ? { klasa: 'sustav', naziv: 'sustav', pogodak: s } : null
}

// ─── Klasifikacija ─────────────────────────────────────────────────────────────────────
export interface BlockedTask extends WatchdogTask {
  blockedReason?: string | null
  description?: string | null
  blockedBy?: string[] | null
  projectId?: string | null
}

/** Dorin prefiks `[revizija TASK-5201] <UZROK>:` (TASK-5201). */
const DORIN_PREFIKS = /^\[revizija TASK-5201\]\s*([A-Z_]+)\s*:/
const DORA_U_KLASU: Record<string, BlokKlasa> = {
  SPAWN_PREKINUT: 'prolazno', NO_TURNS: 'prolazno', BEZ_RAZLOGA: 'nepoznato', DECLARED_HUMAN: 'covjek',
  LANAC: 'lanac', CRITIC: 'kriticar', DATUM: 'datum', ZASTARJELO: 'zastarjelo', DEPLOY: 'deploy', GORAN: 'odluka',
}
/** Strojni kod na početku razloga: `<KLASA>: opis` (§3, „razlog počinje strojnim kodom”). */
const KOD_KLASE = /^(PROLAZNO|KRITICAR|COVJEK|ODLUKA|LANAC|DATUM|DEPLOY|SUSTAV|SIGURNOST|NOVAC|VANJSKO|ZASTARJELO|NEPOZNATO)\s*:/

/** Ime servisa iz „čeka restart <servis>” (deploy klasa); null kad ga nema. */
export function servisIzRazloga(reason: string | null | undefined): string | null {
  const m = /(?:č|c)eka\s+restart\s+([a-z][a-z0-9_-]*)/i.exec(reason || '')
  return m ? m[1]!.toLowerCase() : null
}

/** Klasa samo iz teksta razloga (bez oznaka i rizika). */
function klasaIzRazloga(r: string): { klasa: BlokKlasa; izvor: string } | null {
  const reason = (r || '').trim()
  if (!reason) return null
  const kod = KOD_KLASE.exec(reason)
  if (kod) return { klasa: kod[1]!.toLowerCase() as BlokKlasa, izvor: `strojni kod ${kod[1]}` }
  if (/^(no-turns|session-budget|hook-block)/i.test(reason)) return { klasa: 'prolazno', izvor: `HookBlockGuard ${reason.split(/[\s:]/)[0]}` }
  if (/spawn prekinut/i.test(reason)) return { klasa: 'prolazno', izvor: 'Spawn prekinut (FailRequeue)' }
  if (/zombie-recovery/i.test(reason)) return { klasa: 'prolazno', izvor: 'Zombie-recovery' }
  if (/siro(č|c)e\s*×\s*3/i.test(reason)) return { klasa: 'prolazno', izvor: 'siroče ×3' }
  if (/^(č|c)eka slobodno mjesto/i.test(reason)) return { klasa: 'prolazno', izvor: 'čeka slobodno mjesto' }
  if (/CRITIC_FAILED/.test(reason)) return { klasa: 'kriticar', izvor: 'CRITIC_FAILED' }
  if (servisIzRazloga(reason)) return { klasa: 'deploy', izvor: 'čeka restart servisa' }
  const dora = DORIN_PREFIKS.exec(reason)
  if (dora && DORA_U_KLASU[dora[1]!]) return { klasa: DORA_U_KLASU[dora[1]!]!, izvor: `Dora TASK-5201 ${dora[1]}` }
  if (/^(č|c)eka odluku/i.test(reason) || /ljudska odluka/i.test(reason)) return { klasa: 'odluka', izvor: 'čeka odluku' }
  if (/^(č|c)eka TASK-\d+/i.test(reason)) return { klasa: 'lanac', izvor: 'čeka zadatak' }
  if (/budilica|^vremenski uvjet|^(č|c)eka \d{1,2}\.\s?\d{1,2}\./i.test(reason)) return { klasa: 'datum', izvor: 'nadnevak/budilica' }
  if (/^BLOCKED: Agent je sam deklarirao/i.test(reason) || /^waiting-for-human|^(č|c)eka gorana/i.test(reason)) {
    return { klasa: 'covjek', izvor: 'agent/razlog traži čovjeka' }
  }
  return null
}

const LJUDSKI_RAZLOG: BlokKlasa[] = ['covjek', 'odluka', 'nepoznato']

/**
 * Klasa blokade. Redoslijed (§4.1): rizik* > oznaka `blok:` > needs-decision >
 * waiting-for-human > blockedBy > strojni kod / Dorin prefiks u razlogu > `nepoznato`.
 * `waiting-for-human` je ispred strojnog koda namjerno: zadatak koji je netko predao
 * čovjeku ne smije se pustiti samo zato što je njegov stari razlog bio „Spawn prekinut”.
 *
 * *Rizik: zadano (`rizikPreteze` nije `false`) preteže kao klasa. Revizija ga zove s
 * `rizikPreteze: cfg.rizikPretezeUvijek` (zadano false): klasa ostaje mehanička, a pogodak
 * rizika vraća se u polju `rizik` i provjerava kao BRANA prije svakog puštanja. Izmjereno
 * 04.10.2026. nad 104 blokirana: kao klasa šalje Goranu 59 (npr. „računalo” → novac,
 * „RegocDaemon”/„uživo” u gotovo svakom opisu sustava) i zauvijek drži lance 5170–5172;
 * kao brana daje istu tvrdu garanciju (0 puštanja uz pogodak rizika) bez lažnih predaja.
 */
export function klasificirajBlokadu(
  t: Partial<BlockedTask>,
  opts: { projektiUvijekGoranu?: string[]; rizikPreteze?: boolean } = {},
): { klasa: BlokKlasa; izvor: string; rizik?: RizikPogodak } {
  const tags = listaOznaka(t.tags).map(x => x.toLowerCase())
  const reason = String(t.blockedReason || '')
  const izRazloga = klasaIzRazloga(reason)
  const izOznake = klasaIzOznaka(tags)

  const osnovna = ((): { klasa: BlokKlasa; izvor: string } => {
    if (izOznake) return { klasa: izOznake, izvor: `oznaka blok:${izOznake}` }
    if (tags.includes('needs-decision')) return { klasa: 'odluka', izvor: 'oznaka needs-decision' }
    if (tags.includes('waiting-for-human')) return { klasa: 'covjek', izvor: 'oznaka waiting-for-human' }
    if (Array.isArray(t.blockedBy) && t.blockedBy.length > 0) return { klasa: 'lanac', izvor: `blockedBy ${t.blockedBy.join(',')}` }
    if (izRazloga) return izRazloga
    if (tags.includes('okidac-strojni')) return { klasa: 'datum', izvor: 'oznaka okidac-strojni' }
    return { klasa: 'nepoznato', izvor: reason ? 'razlog bez prepoznatljivog koda' : 'bez razloga' }
  })()

  if (osnovna.klasa === 'zastarjelo' || osnovna.klasa === 'datum') return osnovna

  const projekt = String(t.projectId || '').toLowerCase()
  if (projekt && (opts.projektiUvijekGoranu || []).includes(projekt)) {
    return { klasa: 'vanjsko', izvor: `projekt ${t.projectId} je pod Goranom (projektiUvijekGoranu)` }
  }
  const razlogZaRizik = !izRazloga || LJUDSKI_RAZLOG.includes(izRazloga.klasa) ? reason : ''
  const r = prepoznajRizik(String(t.title || ''), String(t.description || ''), razlogZaRizik)
  if (r && opts.rizikPreteze !== false) return { klasa: r.klasa, izvor: `rizik ${r.naziv} („${r.pogodak}”)`, rizik: r }
  return r ? { ...osnovna, rizik: r } : osnovna
}

// ─── Konfiguracija (odjeljak `blocked` u config/stale-watchdog.json) ────────────────────
export interface BlockedReviewConfig {
  intervalMinutes: number
  klaseUzivo: BlokKlasa[]
  maxRedrive: number
  maxPustanjaPoProlazu: number
  maxUsdPoPustanju: number
  maxUsdPoZadatku: number
  maxUsdDnevno: number
  maxUdioSpawnova: number
  najstarijiZaAutomatskiDana: number
  minSlobodnogDiskaPosto: number
  bez429Minuta: number
  projektiUvijekGoranu: string[]
  podsjetnikCovjekSati: number
  podsjetnikRizikDana: number
  maxKrugovaKriticara: number
  /** true = rizik je klasa koja preteže nad svime (dizajn §6.2 doslovno); false = brana pri puštanju. */
  rizikPretezeUvijek: boolean
}

export const DEFAULT_BLOCKED_REVIEW_CONFIG: BlockedReviewConfig = {
  intervalMinutes: 60,
  // QA-5205 N2 / dizajn §12: `prolazno` tek nakon 48 h uživo za lanac i deploy bez incidenta.
  klaseUzivo: ['lanac', 'deploy'],
  maxRedrive: 3,
  maxPustanjaPoProlazu: 3,
  maxUsdPoPustanju: 5,
  maxUsdPoZadatku: 10,
  maxUsdDnevno: 15,
  maxUdioSpawnova: 0.2,
  najstarijiZaAutomatskiDana: 14,
  minSlobodnogDiskaPosto: 10,
  bez429Minuta: 30,
  projektiUvijekGoranu: [],
  podsjetnikCovjekSati: 24,
  podsjetnikRizikDana: 7,
  maxKrugovaKriticara: 2,
  rizikPretezeUvijek: false,
}

/**
 * Konfiguracija revizije. Nedostajuća datoteka ili odjeljak → zadano.
 * `klaseUzivo` je fail-CLOSED: sve osim ispravnog popisa poznatih klasa → `[]` (ništa uživo),
 * a klase „uvijek Goranu” se izbacuju uvijek — njih ni konfiguracija ne smije pustiti.
 */
export function loadBlockedReviewConfig(path: string = STALE_WATCHDOG_CONFIG_PATH): BlockedReviewConfig {
  const d = DEFAULT_BLOCKED_REVIEW_CONFIG
  let raw: any
  try {
    if (!existsSync(path)) return { ...d, klaseUzivo: [...d.klaseUzivo] }
    raw = JSON.parse(readFileSync(path, 'utf-8'))?.blocked
  } catch {
    return { ...d, klaseUzivo: [] }
  }
  if (!raw || typeof raw !== 'object') return { ...d, klaseUzivo: [...d.klaseUzivo] }
  let klaseUzivo: BlokKlasa[]
  if (raw.klaseUzivo === undefined) klaseUzivo = [...d.klaseUzivo]
  else if (!Array.isArray(raw.klaseUzivo) || !raw.klaseUzivo.every(jeBlokKlasa)) klaseUzivo = []
  else klaseUzivo = (raw.klaseUzivo as BlokKlasa[]).filter(k => !UVIJEK_GORANU.includes(k))
  const udio = typeof raw.maxUdioSpawnova === 'number' && raw.maxUdioSpawnova > 0 && raw.maxUdioSpawnova <= 1 ? raw.maxUdioSpawnova : d.maxUdioSpawnova
  return {
    intervalMinutes: asPositiveNumber(raw.intervalMinutes, d.intervalMinutes),
    klaseUzivo,
    maxRedrive: asPositiveNumber(raw.maxRedrive, d.maxRedrive),
    maxPustanjaPoProlazu: asPositiveNumber(raw.maxPustanjaPoProlazu, d.maxPustanjaPoProlazu),
    maxUsdPoPustanju: asPositiveNumber(raw.maxUsdPoPustanju, d.maxUsdPoPustanju),
    maxUsdPoZadatku: asPositiveNumber(raw.maxUsdPoZadatku, d.maxUsdPoZadatku),
    maxUsdDnevno: asPositiveNumber(raw.maxUsdDnevno, d.maxUsdDnevno),
    maxUdioSpawnova: udio,
    najstarijiZaAutomatskiDana: asPositiveNumber(raw.najstarijiZaAutomatskiDana, d.najstarijiZaAutomatskiDana),
    minSlobodnogDiskaPosto: asPositiveNumber(raw.minSlobodnogDiskaPosto, d.minSlobodnogDiskaPosto),
    bez429Minuta: asPositiveNumber(raw.bez429Minuta, d.bez429Minuta),
    projektiUvijekGoranu: asStringArray(raw.projektiUvijekGoranu, d.projektiUvijekGoranu),
    podsjetnikCovjekSati: asPositiveNumber(raw.podsjetnikCovjekSati, d.podsjetnikCovjekSati),
    podsjetnikRizikDana: asPositiveNumber(raw.podsjetnikRizikDana, d.podsjetnikRizikDana),
    maxKrugovaKriticara: asPositiveNumber(raw.maxKrugovaKriticara, d.maxKrugovaKriticara),
    rizikPretezeUvijek: raw.rizikPretezeUvijek === true,
  }
}

/** Preskočen prolaz revizije (ručna kočnica, pad API-ja) ponavlja se brzo, ne za cijeli interval (QA-5205 N3). */
export const PONOVI_PRESKOCENI_PROLAZ_MS = 5 * 60_000

/**
 * Vrijednost za `lastBlockedReviewCheck` nakon preskočenog prolaza: sljedeći pokušaj za 5 min
 * (ili za interval, ako je kraći). Bez toga se prvi prolaz nakon `restart_kad_mirno.sh`, koji
 * restarta pod kočnicom, gubio na cijelih 60 min.
 */
export function zadnjiProlazZaPonavljanje(now: number, intervalMinutes: number, ponoviZaMs = PONOVI_PRESKOCENI_PROLAZ_MS): number {
  const iv = intervalMinutes * 60_000
  return now - iv + Math.min(ponoviZaMs, iv)
}

export type NacinRevizije = 'off' | 'shadow' | 'on'

/** Prekidač (§8.1): `revizijaBlokiranih` / `revizijaBlokiranihLive` u features.json. */
export function nacinRevizije(isEnabled: (name: string) => boolean): NacinRevizije {
  if (!isEnabled('revizijaBlokiranih')) return 'off'
  return isEnabled('revizijaBlokiranihLive') ? 'on' : 'shadow'
}

// ─── Odgoda (§5.3) ─────────────────────────────────────────────────────────────────────
/** Stabilan [0,1) iz niza — isti zadatak i isti redrive daju isto vrijeme na ploči i u daemonu. */
function stabilanRand(kljuc: string): () => number {
  let h = 2166136261
  for (let i = 0; i < kljuc.length; i++) { h ^= kljuc.charCodeAt(i); h = Math.imul(h, 16777619) }
  const v = (h >>> 0) / 4294967296
  return () => v
}

const H_MS = 3_600_000
const D_MS = 24 * H_MS

/** Sljedeći višekratnik koraka iza `now` (najmanje jedan korak od ulaska). */
function sljedeciKorak(ulazakMs: number, korakMs: number, now?: number): number {
  const k = now === undefined ? 1 : Math.max(1, Math.ceil((now - ulazakMs) / korakMs))
  return ulazakMs + korakMs * k
}

export function sljedecaRevizijaMs(
  klasa: BlokKlasa, redrive: number, ulazakMs: number, cfg: BlockedReviewConfig = DEFAULT_BLOCKED_REVIEW_CONFIG,
  opts: { rand?: () => number; taskId?: string; now?: number } = {},
): number | null {
  switch (klasa) {
    case 'prolazno': {
      const rand = opts.rand ?? stabilanRand(`${opts.taskId || ''}#${redrive}`)
      return ulazakMs + jitteredBackoff(redrive + 1, { stepMs: 6 * H_MS, maxMs: 72 * H_MS, rand })
    }
    case 'kriticar': case 'deploy': case 'lanac': return ulazakMs + H_MS
    case 'covjek': case 'odluka': case 'nepoznato': return sljedeciKorak(ulazakMs, cfg.podsjetnikCovjekSati * H_MS, opts.now)
    case 'sustav': case 'sigurnost': case 'novac': case 'vanjsko': return sljedeciKorak(ulazakMs, cfg.podsjetnikRizikDana * D_MS, opts.now)
    default: return null
  }
}

// ─── Odluka (§5) ───────────────────────────────────────────────────────────────────────
export type BlockedVerdict = 'ceka' | 'izuzet' | 'pusti' | 'otpusti-lanac' | 'popravi-lanac'
  | 'zatvori-deploy' | 'goranu' | 'razina2' | 'strop'
/** Presude koje zadatak vraćaju u rad — samo za njih vrijedi `klaseUzivo` i proračun. */
export const PUSTANJA: BlockedVerdict[] = ['pusti', 'otpusti-lanac', 'zatvori-deploy']

export interface UzrokProvjera { ok: boolean; razlog: string }
export interface RoditeljLanca { id: string; status: string; imaBlocks: boolean }
export interface DeployProvjera { servis: string | null; exit: number | null; izlaz: string }

export interface BlockedReviewInput {
  now: number
  config: BlockedReviewConfig
  /** Trenutak ulaska u `blocked` (zadnji redak `task_history`), ne `updated_at`. */
  ulazakMs: number
  redrive: number
  uzrokNestao: UzrokProvjera
  projektArhiviran: boolean
  /** ID kasnijeg `completed` zadatka koji spominje ovaj (kandidat „riješeno drugdje”). */
  rjesenoDrugdje: string | null
  procjenaUsd: number
  ukupnoUsd: number
  lanac?: RoditeljLanca[]
  deploy?: DeployProvjera
  /** P0a (popravci kritičara) u pogonu i `criticRepairLoopLive` — tek tada kritičar ide dalje. */
  kriticarSpreman?: boolean
}

export interface BlockedDecision {
  taskId: string
  title: string
  assignee: string
  klasa: BlokKlasa
  izvor: string
  presuda: BlockedVerdict
  razlog: string
  redrive: number
  ulazakMs: number
  sljedecaRevizijaMs: number | null
  procjenaUsd: number
  /** Nove oznake kad presuda nešto mijenja (puštanje, Goranu, strop); inače undefined. */
  oznake?: string[]
  /** Roditelji kojima nedostaje `blocks` (popravi-lanac). */
  roditeljiBezBlocks?: string[]
}

const ASSIGNEE_BEZ_AGENTA = ['regoc', 'user', '']

export function decideBlockedTask(task: BlockedTask, u: BlockedReviewInput): BlockedDecision {
  const cfg = u.config
  const assignee = String(task.assignee || '').trim().toLowerCase()
  const tags = listaOznaka(task.tags)
  const { klasa, izvor, rizik } = klasificirajBlokadu(task, { projektiUvijekGoranu: cfg.projektiUvijekGoranu, rizikPreteze: cfg.rizikPretezeUvijek })
  const redrive = Math.max(u.redrive, redriveIzOznaka(tags))
  const sljedeca = sljedecaRevizijaMs(klasa, redrive, u.ulazakMs, cfg, { taskId: task.id, now: u.now })
  const base = {
    taskId: task.id, title: task.title || '', assignee, klasa, izvor, redrive,
    ulazakMs: u.ulazakMs, sljedecaRevizijaMs: sljedeca, procjenaUsd: u.procjenaUsd,
  }
  const odl = (presuda: BlockedVerdict, razlog: string, extra: Partial<BlockedDecision> = {}): BlockedDecision =>
    ({ ...base, presuda, razlog, ...extra })
  const goranu = (k: BlokKlasa, razlog: string, presuda: BlockedVerdict = 'goranu'): BlockedDecision => {
    const potrebne = RIZICNE_KLASE.includes(k) ? ['waiting-for-human', 'no-autonomy'] : ['waiting-for-human']
    const oznake = dodajOznake(withBlokTag(tags, k), ...potrebne)
    return odl(presuda, razlog, { oznake })
  }

  // Izuzeća su ista kao za in_progress, osim `waiting-for-human`: takve revizija broji i
  // podsjeća na njih — samo ih nikad ne pušta (§4.1).
  const excl = exclusionReason(task, assignee, {
    excludeTags: ['no-watchdog', 'interactive'], excludeAssignees: ['user', 'goran'], excludeTaskIds: [], onlyTaskIds: [],
  })
  if (excl) return odl('izuzet', excl)

  const danaUBlocked = (u.now - u.ulazakMs) / D_MS
  const prestar = danaUBlocked > cfg.najstarijiZaAutomatskiDana

  if (UVIJEK_GORANU.includes(klasa)) {
    const potrebne = [`blok:${klasa}`, 'waiting-for-human', ...(RIZICNE_KLASE.includes(klasa) ? ['no-autonomy'] : [])]
    const nedostaje = potrebne.filter(o => !tags.map(t => t.toLowerCase()).includes(o))
    if (nedostaje.length > 0) return goranu(klasa, `uvijek Goranu (${izvor}) — ne puštam sam`)
    if ((klasa === 'covjek' || klasa === 'odluka') && prestar) {
      return odl('razina2', `čeka Gorana ${Math.floor(danaUBlocked)} d (> ${cfg.najstarijiZaAutomatskiDana} d) — razina 2: prijedlog [ARHIVA] ili pitanje`)
    }
    return odl('ceka', `čeka Gorana (${izvor})`)
  }

  switch (klasa) {
    case 'zastarjelo': return odl('ceka', 'zastarjelo — ide u tjedni popis [ARHIVA] za Gorana (nikad cancelled)')
    case 'datum': return odl('ceka', 'čeka nadnevak ili strojni okidač — otpušta budilica/okidač, ne revizija')
    case 'nepoznato': return odl('razina2', 'bez klase — razina 2 dodjeljuje klasu')
    case 'kriticar': {
      let krug = 0
      for (const t of tags) { const m = KRITIKA_TAG.exec(t); if (m) krug = Math.max(krug, Number(m[1])) }
      if (krug >= cfg.maxKrugovaKriticara) return goranu('covjek', `${krug}/${cfg.maxKrugovaKriticara} krugova kritičara potrošeno`, 'strop')
      if (!u.kriticarSpreman) return odl('ceka', 'kritičar: ne puštam dok P0a (popravci kritičara) i criticRepairLoopLive nisu u pogonu')
      return odl('ceka', 'kritičar: put je CriticRepairLoop (kritika:<n>), ne redrive')
    }
    case 'deploy': {
      if (!u.deploy) return odl('ceka', 'deploy: provjera StaleCodeCheck nije izvedena u ovom prolazu')
      if (!u.deploy.servis) return odl('razina2', 'deploy: razlog ne imenuje servis')
      if (u.deploy.exit === 0) return odl('zatvori-deploy', `deploy izveden — StaleCodeCheck ${u.deploy.servis} exit 0: ${u.deploy.izlaz.slice(0, 300)}`)
      return odl('ceka', `deploy: ${u.deploy.servis} još vrti stari kod (exit ${u.deploy.exit})`)
    }
    case 'lanac': {
      const rod = u.lanac || []
      if (rod.length === 0) return odl('razina2', 'lanac: roditelj se ne može odrediti (ni blockedBy ni ID u razlogu)')
      const bez = rod.filter(r => !r.imaBlocks && r.status !== 'completed').map(r => r.id)
      if (bez.length > 0) return odl('popravi-lanac', `roditelju ${bez.join(', ')} nedostaje blocks → ${task.id}`, { roditeljiBezBlocks: bez })
      if (rod.every(r => r.status === 'completed')) {
        if (rizik) return goranu(rizik.klasa, `lanac otpušten, ali rizik ${rizik.naziv} („${rizik.pogodak}”) — uvijek Goranu, ne puštam sam`)
        return odl('otpusti-lanac', `svi roditelji completed (${rod.map(r => r.id).join(', ')})`, { oznake: withBlokTag(tags, 'lanac') })
      }
      return odl('ceka', `lanac: čeka ${rod.filter(r => r.status !== 'completed').map(r => `${r.id} (${r.status})`).join(', ')}`)
    }
  }

  // prolazno — provjera stvarnosti PRIJE svakog puštanja (§5.1, zaštita od Dorinih 37/52)
  if (u.projektArhiviran) return odl('razina2', 'projekt je archived')
  if (/^\s*\[ARHIVA\]/i.test(task.title || '')) return odl('razina2', 'naslov je [ARHIVA]')
  if (prestar) return odl('razina2', `u blocked ${Math.floor(danaUBlocked)} d (> ${cfg.najstarijiZaAutomatskiDana} d) — vjerojatno zastarjelo`)
  if (u.rjesenoDrugdje) return odl('razina2', `kandidat „riješeno drugdje”: ${u.rjesenoDrugdje} (completed) spominje ovaj zadatak`)
  if (ASSIGNEE_BEZ_AGENTA.includes(assignee)) return odl('razina2', `assignee '${assignee || '—'}' nije agent koji se može pustiti`)
  if (redrive >= cfg.maxRedrive) return goranu('covjek', `${redrive}/${cfg.maxRedrive} puštanja potrošeno`, 'strop')
  if (u.ukupnoUsd > cfg.maxUsdPoZadatku) return goranu('novac', `zadatak je već potrošio ${u.ukupnoUsd.toFixed(2)} USD (> ${cfg.maxUsdPoZadatku})`, 'strop')
  if (u.procjenaUsd > cfg.maxUsdPoPustanju) return goranu('novac', `procjena puštanja ${u.procjenaUsd.toFixed(2)} USD > ${cfg.maxUsdPoPustanju} USD`)
  if (sljedeca !== null && u.now < sljedeca) return odl('ceka', `sljedeća revizija za ${formatAge(sljedeca - u.now)} (puštanje ${redrive + 1}/${cfg.maxRedrive})`)
  if (!u.uzrokNestao.ok) return odl('ceka', `uzrok nije nestao: ${u.uzrokNestao.razlog}`)
  if (rizik) return goranu(rizik.klasa, `rizik ${rizik.naziv} („${rizik.pogodak}”) — uvijek Goranu, ne puštam sam`)
  return odl('pusti', `prolazno (${izvor}), uzrok nestao (${u.uzrokNestao.razlog}) — vraćam u red (${redrive + 1}/${cfg.maxRedrive}, ≈${u.procjenaUsd.toFixed(2)} USD)`,
    { oznake: withRedriveTag(withBlokTag(tags, 'prolazno'), redrive + 1) })
}

export interface BlockedBudget {
  /** Zbroj procjena puštenih u zadnja 24 h (iz `revizija_blokiranih.jsonl`, mode live). */
  pustenoUsdDanas: number
  pustenoBrojDanas: number
  /** Spawnova u zadnja 24 h (`run_log.jsonl`). */
  spawnova24h: number
}

/**
 * Presude za sve blokirane + proračun prolaza (§5.4). Puštanja se dijele od najstarijeg
 * ulaska; ono što ne stane u proračun dobiva `ceka` s razlogom „proračun: …”.
 */
export function evaluateBlockedTasks(
  tasks: BlockedTask[],
  opts: { now: number; config: BlockedReviewConfig; ulaz: (t: BlockedTask) => BlockedReviewInput; budzet: BlockedBudget },
): BlockedDecision[] {
  const cfg = opts.config
  const sve = (tasks || []).map(t => decideBlockedTask(t, { ...opts.ulaz(t), now: opts.now, config: cfg }))
  const udioMax = Math.max(2, Math.floor(cfg.maxUdioSpawnova * opts.budzet.spawnova24h))
  let n = 0
  let usd = opts.budzet.pustenoUsdDanas
  const kandidati = sve.filter(d => d.presuda === 'pusti' || d.presuda === 'otpusti-lanac').sort((a, b) => a.ulazakMs - b.ulazakMs)
  for (const d of kandidati) {
    const preko =
      n >= cfg.maxPustanjaPoProlazu ? `${cfg.maxPustanjaPoProlazu} puštanja po prolazu`
      : usd + d.procjenaUsd > cfg.maxUsdDnevno ? `dnevni ${usd.toFixed(2)} + ${d.procjenaUsd.toFixed(2)} > ${cfg.maxUsdDnevno} USD`
      : opts.budzet.pustenoBrojDanas + n >= udioMax ? `udio ${udioMax} od ${opts.budzet.spawnova24h} spawnova u 24 h`
      : null
    if (preko) {
      d.razlog = `proračun: ${preko} — ${d.razlog}`
      d.presuda = 'ceka'
      d.oznake = undefined
      continue
    }
    n++
    usd += d.procjenaUsd
  }
  return sve
}

/** Jedan redak dnevnika — isti u daemonu i u izvještaju. */
export function formatBlockedDecisionLine(d: BlockedDecision): string {
  const mark: Record<BlockedVerdict, string> = {
    ceka: '⏳', izuzet: '⏸️', pusti: '🔁', 'otpusti-lanac': '🔗', 'popravi-lanac': '🔧',
    'zatvori-deploy': '✅', goranu: '🙋', razina2: '🔎', strop: '⛔',
  }
  return `${mark[d.presuda]} ${d.taskId.padEnd(10)} ${(d.assignee || '-').padEnd(9)} ${d.klasa.padEnd(10)} ${d.presuda.padEnd(13)} ${d.razlog}`
}

// ─── Ulazi iz baze i okoline (zajedničko daemonu i izvještaju) ─────────────────────────
// I/O je ovdje, a ne u daemonu, iz istog razloga kao `makeCheckpointLookup`: izvještaj
// „što BI revizija napravila” mora čitati isto što i daemon, inače laže.

type Db = { prepare: (sql: string) => { get: (...args: any[]) => any; all: (...args: any[]) => any[] } }

export const REVIZIJA_BLOKIRANIH_LOG = join(HOME, '.claude', 'regoc', 'data', 'revizija_blokiranih.jsonl')
export const SESSION_USAGE_LOG = join(HOME, '.claude', 'regoc', 'data', 'session_usage.jsonl')
export const RUN_LOG = join(HOME, '.claude', 'regoc', 'data', 'run_log.jsonl')

/** Agenti na Sonnetu (bez podataka o trošku procjena je 1 USD, inače 5 USD — §5.4). */
const SONNET_AGENTI = ['klaudio', 'stribor', 'potjeh', 'gita']

function parseVrijeme(s: unknown): number {
  if (typeof s !== 'string' || !s) return NaN
  // SQLite `datetime('now')` nema zonu, a znači UTC.
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z')
}

/** Zadnji redak u kojem je JSONL stariji od `odMs` se preskače — čita se samo rep datoteke. */
function citajJsonlRep(path: string, maxBajtova = 2_000_000): any[] {
  try {
    if (!existsSync(path)) return []
    const s = readFileSync(path, 'utf-8')
    const rep = s.length > maxBajtova ? s.slice(s.length - maxBajtova) : s
    const out: any[] = []
    for (const l of rep.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)) } catch { /* poluzapis */ } }
    return out
  } catch { return [] }
}

export interface OkolinaUlaz {
  diskSlobodnoPosto: number | null
  autonomija: { dopusteno: boolean; razlog: string }
  /** Trenutak zadnje odbijenice kvote (`429`/`rejected`) ili null. */
  zadnjaOdbijenicaMs: number | null
  startupGrace: boolean
}

/** Je li uzrok prolaznog kvara nestao (§5.2, red `prolazno`). Čista funkcija. */
export function provjeriUzrok(o: OkolinaUlaz, now: number, cfg: BlockedReviewConfig): UzrokProvjera {
  if (o.startupGrace) return { ok: false, razlog: 'daemon je u startnoj milosti' }
  if (o.diskSlobodnoPosto === null) return { ok: false, razlog: 'slobodan disk se ne može izmjeriti' }
  if (o.diskSlobodnoPosto < cfg.minSlobodnogDiskaPosto) {
    return { ok: false, razlog: `disk ${o.diskSlobodnoPosto.toFixed(1)} % < ${cfg.minSlobodnogDiskaPosto} %` }
  }
  if (o.zadnjaOdbijenicaMs !== null && now - o.zadnjaOdbijenicaMs < cfg.bez429Minuta * 60_000) {
    return { ok: false, razlog: `odbijenica kvote prije ${formatAge(now - o.zadnjaOdbijenicaMs)} (< ${cfg.bez429Minuta} min)` }
  }
  if (!o.autonomija.dopusteno) return { ok: false, razlog: `vrata autonomije zatvorena: ${o.autonomija.razlog}` }
  return { ok: true, razlog: `disk ${o.diskSlobodnoPosto.toFixed(1)} %, ${o.autonomija.razlog}` }
}

/** Mjerenje okoline: disk (`statfs`), vrata autonomije, zadnja odbijenica kvote. */
export async function izmjeriOkolinu(now: number, opts: { startupGrace?: boolean } = {}): Promise<OkolinaUlaz> {
  let disk: number | null = null
  try {
    const { statfsSync } = await import('fs')
    const s = statfsSync(join(HOME, '.claude'))
    disk = s.blocks > 0 ? (Number(s.bavail) / Number(s.blocks)) * 100 : null
  } catch { disk = null }
  let autonomija = { dopusteno: false, razlog: 'vrata nisu izmjerena' }
  try {
    const { readSessionUsage } = await import('./SpawnTelemetry')
    const { autonomyTierFromUsage } = await import('./WorkStateJournal')
    const t = autonomyTierFromUsage(readSessionUsage(now))
    autonomija = { dopusteno: t.autonomousQueue, razlog: t.reason }
  } catch (e) { autonomija = { dopusteno: false, razlog: `mjerilo nečitljivo (${e})` } }
  let zadnja: number | null = null
  for (const r of citajJsonlRep(SESSION_USAGE_LOG, 300_000)) {
    if (r?.status === 'rejected' || /\b429\b/.test(String(r?.http_error || ''))) {
      const ms = parseVrijeme(r.ts)
      if (Number.isFinite(ms) && (zadnja === null || ms > zadnja)) zadnja = ms
    }
  }
  return { diskSlobodnoPosto: disk, autonomija, zadnjaOdbijenicaMs: zadnja, startupGrace: !!opts.startupGrace }
}

/** Proračun za danas iz vlastitog dnevnika (puštanja uživo) i `run_log.jsonl` (spawnovi). */
export function procitajBudzet(now: number, logPath = REVIZIJA_BLOKIRANIH_LOG, runLog = RUN_LOG): BlockedBudget {
  const od = now - 24 * 3_600_000
  let usd = 0, broj = 0
  for (const r of citajJsonlRep(logPath)) {
    if (r?.nacin !== 'live' || !r?.izvedeno) continue
    if (r.presuda !== 'pusti' && r.presuda !== 'otpusti-lanac') continue
    if (parseVrijeme(r.ts) < od) continue
    usd += Number(r.usd_procjena) || 0
    broj++
  }
  let spawnova = 0
  for (const r of citajJsonlRep(runLog)) if (parseVrijeme(r?.ts) >= od) spawnova++
  return { pustenoUsdDanas: usd, pustenoBrojDanas: broj, spawnova24h: spawnova }
}

const TASK_ID = /\bTASK-\d+\b/g
/** Zadatak koji spominje više od ovoliko ID-eva je skupni izvještaj (npr. Dorina revizija) — nije „riješeno drugdje”. */
const SKUPNI_IZVJESTAJ_ID = 10

/**
 * Lookup ulaza za `decideBlockedTask` nad regoc.db. Skupi upiti se rade jednom po prolazu
 * (troškovi, projekti), a po zadatku samo indeksirani `get`.
 */
export function makeBlockedReviewLookup(db: Db, opts: {
  now: number; config: BlockedReviewConfig; uzrok: UzrokProvjera
  deploy?: (servis: string) => DeployProvjera
  kriticarSpreman?: boolean
}): (t: BlockedTask) => BlockedReviewInput {
  const arhivirani = new Set<string>()
  try { for (const r of db.prepare("SELECT id FROM projects WHERE status = 'archived'").all()) arhivirani.add(String(r.id)) } catch { /* bez projekata */ }

  const ukupno = new Map<string, number>()
  const poAgentu = new Map<string, number[]>()
  try {
    for (const r of db.prepare('SELECT task_id, SUM(cost_usd) s FROM cost_log WHERE task_id IS NOT NULL GROUP BY task_id').all()) {
      ukupno.set(String(r.task_id), Number(r.s) || 0)
    }
    for (const r of db.prepare(
      "SELECT agent_id, task_id, SUM(cost_usd) s FROM cost_log WHERE task_id IS NOT NULL AND timestamp > datetime('now', '-14 days') GROUP BY agent_id, task_id",
    ).all()) {
      const a = String(r.agent_id || '').toLowerCase()
      if (!poAgentu.has(a)) poAgentu.set(a, [])
      poAgentu.get(a)!.push(Number(r.s) || 0)
    }
  } catch { /* bez cost_log → zadane procjene */ }
  const medijan = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2 }

  const ulazakQ = db.prepare("SELECT MAX(changed_at) t FROM task_history WHERE task_id = ? AND field = 'status' AND new_value = 'blocked'")
  const zadatakQ = db.prepare('SELECT id, status, blocks, project_id FROM tasks WHERE id = ?')
  const kandidatiQ = db.prepare(
    "SELECT id, description, result_summary FROM tasks WHERE status = 'completed' AND id != ? AND completed_at > ? " +
    "AND (description LIKE '%' || ? || '%' OR result_summary LIKE '%' || ? || '%') ORDER BY completed_at LIMIT 20",
  )

  return (t: BlockedTask): BlockedReviewInput => {
    const id = t.id
    const zapis = (() => { try { return zadatakQ.get(id) } catch { return null } })()
    let ulazakMs = NaN
    try { ulazakMs = parseVrijeme(ulazakQ.get(id)?.t) } catch { /* bez povijesti */ }
    if (!Number.isFinite(ulazakMs)) ulazakMs = parseVrijeme(t.updatedAt) || parseVrijeme(t.createdAt) || opts.now
    const projekt = String(t.projectId || zapis?.project_id || '')

    let rjeseno: string | null = null
    // Skupi LIKE upit (≈10 ms po zadatku) samo ondje gdje ga presuda čita: mladi `prolazno` (§5.1).
    // Ploča zove lookup svake minute; za ostale klase i prestare zadatke ishod je isti bez njega.
    const trebaRjeseno = (opts.now - ulazakMs) / D_MS <= opts.config.najstarijiZaAutomatskiDana &&
      klasificirajBlokadu(t, { projektiUvijekGoranu: opts.config.projektiUvijekGoranu, rizikPreteze: opts.config.rizikPretezeUvijek }).klasa === 'prolazno'
    if (trebaRjeseno) try {
      const odIso = new Date(ulazakMs).toISOString()
      const re = new RegExp(`\\b${id}\\b`)
      for (const k of kandidatiQ.all(id, odIso, id, id)) {
        const tekst = `${k.description || ''}\n${k.result_summary || ''}`
        if (!re.test(tekst)) continue                                   // TASK-50 ≠ TASK-5000
        if (new Set(tekst.match(TASK_ID) || []).size > SKUPNI_IZVJESTAJ_ID) continue
        rjeseno = String(k.id); break
      }
    } catch { /* heuristika — bez nje se ne pušta ništa manje sigurno */ }

    const agent = String(t.assignee || '').toLowerCase()
    const uzorak = poAgentu.get(agent) || []
    const procjena = uzorak.length >= 3 ? medijan(uzorak) : (SONNET_AGENTI.includes(agent) ? 1 : 5)

    let lanac: RoditeljLanca[] | undefined
    const roditelji = Array.isArray(t.blockedBy) && t.blockedBy.length > 0
      ? t.blockedBy
      : Array.from(new Set((String(t.blockedReason || '').replace(DORIN_PREFIKS, '').match(TASK_ID) || []))).filter(x => x !== id)
    if (roditelji.length > 0) {
      lanac = roditelji.map(pid => {
        const r = (() => { try { return zadatakQ.get(pid) } catch { return null } })()
        let blocks: string[] = []
        try { blocks = JSON.parse(r?.blocks || '[]') } catch { /* prazno */ }
        return { id: pid, status: String(r?.status || 'nepostoji'), imaBlocks: blocks.includes(id) }
      })
    }

    const servis = servisIzRazloga(t.blockedReason)
    const deploy = servis && opts.deploy ? opts.deploy(servis) : (servis ? undefined : { servis: null, exit: null, izlaz: '' })

    return {
      now: opts.now, config: opts.config, ulazakMs, redrive: redriveIzOznaka(t.tags), uzrokNestao: opts.uzrok,
      projektArhiviran: arhivirani.has(projekt), rjesenoDrugdje: rjeseno, procjenaUsd: Math.round(procjena * 100) / 100,
      ukupnoUsd: ukupno.get(id) || 0, lanac, deploy, kriticarSpreman: !!opts.kriticarSpreman,
    }
  }
}

/** Redak dnevnika revizije (§3) — isti oblik u sjeni i uživo. */
export function zapisRevizije(d: BlockedDecision, nacin: NacinRevizije, izvedeno: boolean, now = Date.now()): Record<string, unknown> {
  return {
    ts: new Date(now).toISOString(), taskId: d.taskId, klasa: d.klasa, pravilo: d.izvor, presuda: d.presuda,
    razlog: d.razlog, nacin: nacin === 'on' ? 'live' : 'shadow', izvedeno, redrive: d.redrive,
    usd_procjena: d.procjenaUsd, sljedeca: d.sljedecaRevizijaMs ? new Date(d.sljedecaRevizijaMs).toISOString() : null,
  }
}

/** Entry i PID servisa koji se imenuje u „čeka restart <servis>”. Nepoznat servis → null. */
function servisProces(servis: string): { entry: string; pid: number | null } | null {
  const R = join(HOME, '.claude', 'regoc')
  const pgrepCwd = (uzorak: string, cwd: string): number | null => {
    try {
      const r = Bun.spawnSync(['pgrep', '-f', uzorak])
      for (const p of r.stdout.toString().split(/\s+/).filter(Boolean)) {
        if (cwdProcesa(Number(p)) === cwd) return Number(p)
      }
    } catch { /* bez pgrep */ }
    return null
  }
  switch (servis) {
    case 'daemon': case 'regoc': case 'regocdaemon': {
      let pid: number | null = null
      try { pid = Number(readFileSync(join(R, 'daemon.pid'), 'utf-8').trim()) || null } catch { /* nema datoteke */ }
      if (!pid) { try { pid = Number(Bun.spawnSync(['pgrep', '-of', 'bun .*RegocDaemon\\.ts']).stdout.toString().trim()) || null } catch { /* */ } }
      return { entry: join(R, 'RegocDaemon.ts'), pid }
    }
    case 'taskwebui': case 'ploca': case 'ploča':
      return { entry: join(R, 'TaskManagerMD', 'src', 'TaskWebUI.ts'), pid: pgrepCwd('^bun src/TaskWebUI\\.ts$', join(R, 'TaskManagerMD')) }
    case 'klaudio': {
      let pid: number | null = null
      try { pid = Number(readFileSync(join(HOME, '.tmp', 'regoc_pids', 'klaudio.pid'), 'utf-8').trim()) || null } catch { /* */ }
      return { entry: join(HOME, '.claude', 'tools', 'Telegram', 'telegram_agent.ts'), pid }
    }
    default: return null
  }
}

/** `StaleCodeCheck` nad imenovanim servisom (deploy klasa, §5.2). exit 0 = kod u pogonu svjež. */
export function provjeriDeployServisa(servis: string): DeployProvjera {
  const p = servisProces(servis)
  if (!p) return { servis: null, exit: null, izlaz: `nepoznat servis '${servis}'` }
  if (!p.pid) return { servis, exit: 3, izlaz: `${servis}: nema živog procesa` }
  try {
    const r = Bun.spawnSync(['bun', join(HOME, '.claude', 'regoc', 'StaleCodeCheck.ts'), '--entry', p.entry, '--pid', String(p.pid), '--label', servis, '--json'],
      { timeout: 60_000 } as any)
    let izlaz = ''
    try {
      const j = JSON.parse(r.stdout.toString())
      izlaz = j.is_stale
        ? `STALE: ${(j.stale || []).map((x: any) => String(x.path).split('/').pop()).join(', ')} novije od procesa (start ${j.started_at})`
        : `OK: ${j.file_count} datoteka, nijedna novija od procesa (start ${j.started_at})`
    } catch { izlaz = r.stdout.toString().trim().slice(-200) }
    return { servis, exit: r.exitCode ?? null, izlaz: `StaleCodeCheck ${servis} PID ${p.pid} exit ${r.exitCode}: ${izlaz}` }
  } catch (e) {
    return { servis, exit: null, izlaz: `StaleCodeCheck pao: ${e}` }
  }
}

// ─── Pregled za ploču (§9): tri skupine koje Goran traži ───────────────────────────────
/** `ponovno` = sustav će ponovno pokušati · `goranu` = čeka Gorana · `istroseno` = pokušaji potrošeni · `ostalo`. */
export type SkupinaBlokade = 'ponovno' | 'goranu' | 'istroseno' | 'ostalo'

const LJUDSKE_OZNAKE = ['waiting-for-human', 'needs-decision', 'no-autonomy']

/**
 * Skupina na ploči iz PRESUDE `decideBlockedTask` — iste funkcije kojom sudi daemon (QA-5205 N1).
 * Ranije je skupina išla samo iz klase, pa su izuzeti (`no-watchdog`), prestari (> najstarijiZaAutomatskiDana,
 * razina 2) i lanci sa zapetim roditeljem stajali pod „sustav će ponovno pokušati”, a daemon ih nikad ne pušta.
 * `ceka` i puštanje su ista skupina: razlika (uzrok nestao, StaleCodeCheck, proračun) je mjerenje
 * okoline u trenutku prolaza, ne pravilo koje bi ploča smjela drugačije pokazati.
 */
export function skupinaBlokade(
  t: BlockedTask, d: Pick<BlockedDecision, 'klasa' | 'presuda'>, cfg: BlockedReviewConfig, rizik: RizikPogodak | null = null,
): SkupinaBlokade {
  const klasa = d.klasa
  if (d.presuda === 'strop') return 'istroseno'
  if (d.presuda === 'goranu') return 'goranu'
  const tags = listaOznaka(t.tags).map(x => x.toLowerCase())
  let krug = 0
  for (const x of tags) { const m = KRITIKA_TAG.exec(x); if (m) krug = Math.max(krug, Number(m[1])) }
  if (redriveIzOznaka(tags) >= cfg.maxRedrive || (klasa === 'kriticar' && krug >= cfg.maxKrugovaKriticara)) return 'istroseno'
  if (UVIJEK_GORANU.includes(klasa) || tags.some(x => LJUDSKE_OZNAKE.includes(x))) return 'goranu'
  // Pogodak rizika: revizija ga u trenutku puštanja predaje Goranu, pa „sustav će pokušati” bi lagao.
  if (rizik && (klasa === 'prolazno' || klasa === 'lanac')) return 'goranu'
  // Izuzet i razina 2: daemon ih ne pušta sam. „Čeka tebe” ostaje (ljudski rad se ne skriva),
  // ali „sustav će ponovno pokušati” bi lagao.
  if (d.presuda === 'izuzet' || d.presuda === 'razina2') return 'ostalo'
  if (['prolazno', 'lanac', 'deploy', 'kriticar'].includes(klasa)) return 'ponovno'
  return 'ostalo'
}

/** Status roditelja iz kojeg lanac nikad sam ne kreće (otkazan ili ga nema). */
const MRTVI_RODITELJ = ['cancelled', 'nepostoji']

/** Ljudski opis onoga na što zadatak čeka — bez strojnih prefiksa. */
export function cekaNa(reason: string | null | undefined): string {
  return String(reason || '').replace(DORIN_PREFIKS, '').replace(KOD_KLASE, '')
    .replace(/^BLOCKED: Agent je sam deklarirao BLOCKED:\s*/i, '').trim().slice(0, 240)
}

export interface PregledZadatak {
  id: string; title: string; assignee: string; klasa: BlokKlasa; skupina: SkupinaBlokade
  /** Presuda `decideBlockedTask` nad istim ulazima kao daemon (okolinu ploča ne mjeri). */
  presuda: BlockedVerdict; razlog: string
  /** Samo za skupinu „ponovno” — za ono što se ne pušta nema roka (QA-5205 N1). */
  redrive: number; maxRedrive: number; sljedecaRevizija: string | null; cekaNa: string
  rizik: string | null; zadnjaPresuda: { ts: string; presuda: string; razlog: string; nacin: string } | null
}

/** Ulaz bez baze (stari pozivatelji, testovi): okolina se ne mjeri, roditelji su iz popisa blokiranih. */
function ulazBezBaze(t: BlockedTask, ul: number, now: number, cfg: BlockedReviewConfig, blokirani: Set<string>): BlockedReviewInput {
  const rod = Array.isArray(t.blockedBy) ? t.blockedBy.filter(x => x && x !== t.id) : []
  return {
    now, config: cfg, ulazakMs: ul, redrive: redriveIzOznaka(t.tags),
    uzrokNestao: { ok: false, razlog: 'ploča ne mjeri okolinu' },
    projektArhiviran: false, rjesenoDrugdje: null, procjenaUsd: 0, ukupnoUsd: 0,
    lanac: rod.length ? rod.map(id => ({ id, status: blokirani.has(id) ? 'blocked' : 'nepoznato', imaBlocks: true })) : undefined,
  }
}

export function pregledBlokiranih(tasks: BlockedTask[], o: {
  now: number; config: BlockedReviewConfig; nacin: NacinRevizije
  ulazak: (id: string) => number | null
  zadnja: Map<string, any>
  budzet: BlockedBudget
  /** Ulaz za `decideBlockedTask` (ploča: `makeBlockedReviewLookup` bez StaleCodeCheck i bez mjerenja okoline). */
  ulaz?: (t: BlockedTask) => BlockedReviewInput
}) {
  const poKlasi: Record<string, number> = Object.fromEntries(BLOK_KLASE.map(k => [k, 0]))
  const skupine: Record<SkupinaBlokade, number> = { ponovno: 0, goranu: 0, istroseno: 0, ostalo: 0 }
  const blokirani = new Set((tasks || []).map(t => t.id))
  const rows: Array<{ z: PregledZadatak; d: BlockedDecision; roditelji: RoditeljLanca[] }> = []
  for (const t of tasks || []) {
    const ul = o.ulazak(t.id) ?? (Date.parse(String(t.updatedAt || '')) || o.now)
    const u0 = o.ulaz ? o.ulaz(t) : ulazBezBaze(t, ul, o.now, o.config, blokirani)
    const u: BlockedReviewInput = { ...u0, now: o.now, config: o.config, ulazakMs: ul }
    const d = decideBlockedTask(t, u)
    const k = klasificirajBlokadu(t, { projektiUvijekGoranu: o.config.projektiUvijekGoranu, rizikPreteze: o.config.rizikPretezeUvijek })
    const z = o.zadnja.get(t.id)
    rows.push({
      d, roditelji: d.klasa === 'lanac' ? (u.lanac || []) : [],
      z: {
        id: t.id, title: t.title || '', assignee: String(t.assignee || ''), klasa: d.klasa,
        skupina: skupinaBlokade(t, d, o.config, k.rizik ?? null), presuda: d.presuda, razlog: d.razlog,
        redrive: d.redrive, maxRedrive: o.config.maxRedrive,
        sljedecaRevizija: d.sljedecaRevizijaMs ? new Date(d.sljedecaRevizijaMs).toISOString() : null,
        cekaNa: cekaNa(t.blockedReason), rizik: k.rizik ? `${k.rizik.naziv} („${k.rizik.pogodak}”)` : null,
        zadnjaPresuda: z ? { ts: z.ts, presuda: z.presuda, razlog: z.razlog, nacin: z.nacin } : null,
      },
    })
  }
  // Lanac je „ponovno” samo ako mu roditelj može krenuti: roditelj otkazan/nepostojeći ili sam
  // blokiran izvan „ponovno” (razina 2, izuzet, čeka Gorana) → ni dijete se neće pomaknuti samo.
  // Ponavlja se do ustaljenja, jer zapinjanje putuje niz lanac (unuk zapetog roditelja).
  const poId = new Map(rows.map(r => [r.z.id, r]))
  for (let promjena = true, krug = 0; promjena && krug <= rows.length; krug++) {
    promjena = false
    for (const r of rows) {
      if (r.z.skupina !== 'ponovno' || r.roditelji.length === 0) continue
      const zapeo = r.roditelji.find(p => MRTVI_RODITELJ.includes(p.status) || (poId.has(p.id) && poId.get(p.id)!.z.skupina !== 'ponovno'))
      if (!zapeo) continue
      const rp = poId.get(zapeo.id)
      const zasto = rp ? (rp.z.presuda === 'razina2' ? 'na razini 2' : rp.z.presuda === 'izuzet' ? 'izuzet iz revizije'
        : rp.z.skupina === 'goranu' ? 'čeka Gorana' : rp.z.skupina === 'istroseno' ? 'pokušaji potrošeni' : 'ne kreće sam') : zapeo.status
      r.z.skupina = 'ostalo'
      r.z.cekaNa = `čeka ${zapeo.id} (${zasto}) — sustav ga neće sam pokrenuti`
      promjena = true
    }
  }
  const zadaci: PregledZadatak[] = []
  for (const { z } of rows) {
    if (z.skupina !== 'ponovno') z.sljedecaRevizija = null
    poKlasi[z.klasa] = (poKlasi[z.klasa] || 0) + 1
    skupine[z.skupina]++
    zadaci.push(z)
  }
  return {
    nacin: o.nacin, klaseUzivo: o.config.klaseUzivo, poKlasi, skupine, zadaci,
    proracun: {
      danasUsd: Math.round(o.budzet.pustenoUsdDanas * 100) / 100, danasBroj: o.budzet.pustenoBrojDanas,
      maxUsdDnevno: o.config.maxUsdDnevno, maxPustanjaPoProlazu: o.config.maxPustanjaPoProlazu, maxRedrive: o.config.maxRedrive,
    },
  }
}

/** Zadnja presuda po zadatku iz dnevnika (za ploču i detalje). */
export function zadnjePresude(logPath = REVIZIJA_BLOKIRANIH_LOG): Map<string, any> {
  const m = new Map<string, any>()
  for (const r of citajJsonlRep(logPath)) if (r?.taskId) m.set(r.taskId, r)
  return m
}

/** Povijest presuda za jedan zadatak (detalji zadatka). */
export function povijestPresuda(taskId: string, limit = 30, logPath = REVIZIJA_BLOKIRANIH_LOG): any[] {
  return citajJsonlRep(logPath).filter(r => r?.taskId === taskId).slice(-limit)
}
