#!/usr/bin/env bun
/**
 * DeadAgentReaper — odluka "je li agent mrtav?" na JEDNOM mjestu.
 *
 * R3 / TASK-2561 (PRJ-030). Modul je JEDINI IZVOR ISTINE za pravilo; koriste ga:
 *   - RegocDaemon.watchdogDeadAgents()      → alarm (dry-run) / reap (live)
 *   - RegocDaemon.delegateToAgent()         → provjera živog izvršnog puta prije rutanja
 *   - tools/dead-agent-report.ts            → izvještaj "koga BI reapao"
 * Ako se pravilo mijenja, mijenja se OVDJE — inače izvještaj laže o ponašanju daemona
 * (ista disciplina kao `StaleWatchdog.ts` za R2).
 *
 * Pravilo (dvije razine, namjerno razdvojene):
 *   `dead`   = status online/busy, heartbeat stariji od praga I proces NE postoji
 *              → status offline + njegovi `in_progress` taskovi idu R2 mehanizmu (/reclaim)
 *   `silent` = status online/busy, heartbeat star, ali PROCES ŽIVI
 *              → samo status offline (invarijanta), taskovi se NE diraju — proces još može javiti
 * Razdvajanje je bitno: brisanje tuđeg rada zbog izostalog heartbeata je skuplje od
 * krivog statusa. Destruktivni dio traži DVA nezavisna dokaza smrti (heartbeat + proces).
 *
 * Autor: Jelena (Engineer) · 2026-07-28
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { formatAge } from './StaleWatchdog'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()
export const DEAD_AGENT_REAPER_CONFIG_PATH = join(HOME, '.claude', 'regoc', 'config', 'dead-agent-reaper.json')

// Statusi koji tvrde "ovaj agent radi" — samo njih uopće provjeravamo.
export const LIVE_STATUSES = ['online', 'busy']

// ============================================
// KONFIGURACIJA
// ============================================

export interface DeadAgentReaperConfig {
  /** Koliko sati bez heartbeata dok se agent ne proglasi sumnjivo mrtvim. */
  thresholdHours: number
  /** Razmak između provjera u daemonu (minute). */
  intervalMinutes: number
  /** Agenti koji se NIKAD ne diraju (ljudski „agenti", vanjski procesi). */
  excludeAgents: string[]
  /**
   * CANARY opseg: ako lista NIJE prazna, kandidat može biti SAMO agent s ove liste.
   * Allowlist, ne denylist — denylist-snimka zastari čim se pojavi novi agent
   * (dokazano na R2 canaryju 2026-07-28: 21 tuđi task resetiran unutar prozora).
   */
  onlyAgents: string[]
  /** Sigurnosna brana za live: najviše toliko reapanja po prolazu. Preko toga → alarm i stop. */
  maxReapsPerRun: number
  /** Live: smije li reaper predati `in_progress` taskove mrtvog agenta R2 mehanizmu. */
  reclaimTasks: boolean
}

export const DEFAULT_DEAD_AGENT_REAPER_CONFIG: DeadAgentReaperConfig = {
  thresholdHours: 2,
  intervalMinutes: 30,
  // 'user'/'goran' nisu procesi — nemaju heartbeat i nemaju što izgubiti reapanjem.
  excludeAgents: ['user', 'goran'],
  onlyAgents: [],
  maxReapsPerRun: 3,
  reclaimTasks: true,
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  return value.filter((v): v is string => typeof v === 'string').map(v => v.trim().toLowerCase())
}

function asPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Učitaj konfiguraciju; nedostajuća ili neispravna datoteka → defaulti (nikad ne baca). */
export function loadDeadAgentReaperConfig(path: string = DEAD_AGENT_REAPER_CONFIG_PATH): DeadAgentReaperConfig {
  const d = DEFAULT_DEAD_AGENT_REAPER_CONFIG
  try {
    if (!existsSync(path)) return { ...d }
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (!raw || typeof raw !== 'object') return { ...d }
    return {
      thresholdHours: asPositiveNumber(raw.thresholdHours, d.thresholdHours),
      intervalMinutes: asPositiveNumber(raw.intervalMinutes, d.intervalMinutes),
      excludeAgents: asStringArray(raw.excludeAgents, d.excludeAgents),
      onlyAgents: asStringArray(raw.onlyAgents, d.onlyAgents),
      maxReapsPerRun: asPositiveNumber(raw.maxReapsPerRun, d.maxReapsPerRun),
      reclaimTasks: asBoolean(raw.reclaimTasks, d.reclaimTasks),
    }
  } catch {
    return { ...d }
  }
}

// ============================================
// TIPOVI ODLUKE
// ============================================

/** Minimum koji trebamo iz `agent_status` — namjerno labavo (tablica ima više kolona). */
export interface AgentStatusRow {
  agent_id: string
  status?: string | null
  current_task?: string | null
  pid?: number | null
  last_heartbeat?: string | null
  /** Starost heartbeata u ms; ako je nema, računa se iz `last_heartbeat`. */
  hb_age_ms?: number | null
}

export type DeadVerdict = 'ok' | 'excluded' | 'silent' | 'dead'

export interface AgentDecision {
  agentId: string
  status: string
  pid: number | null
  /** true/false = provjeren proces; null = nije bilo PID-a za provjeru. */
  pidAlive: boolean | null
  hbAgeMs: number | null
  hbHours: number
  lastHeartbeat: string | null
  currentTask: string | null
  verdict: DeadVerdict
  /** Čitljiv razlog — ide doslovno u izvještaj i u alarm. */
  reason: string
  /** Live akcija: postavi `agent_status.status='offline'`. */
  markOffline: boolean
  /** Live akcija: njegove `in_progress` taskove predaj R2 mehanizmu (/reclaim). */
  reclaimTasks: boolean
}

export type ProcessLivenessProbe = (pid: number) => boolean

/**
 * Provjera postojanja procesa preko signala 0. EPERM znači „postoji, ali nije naš" →
 * to je ŽIV proces; tretirati ga kao mrtvog bi značilo reapati tuđi živi daemon.
 */
export const defaultProcessLivenessProbe: ProcessLivenessProbe = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
}

// ============================================
// ODLUKA (čista funkcija — testabilna bez baze)
// ============================================

function ageFromRow(row: AgentStatusRow, now: number): number | null {
  if (typeof row.hb_age_ms === 'number' && Number.isFinite(row.hb_age_ms)) {
    return Math.max(0, row.hb_age_ms)
  }
  if (!row.last_heartbeat) return null
  // SQLite piše 'YYYY-MM-DD HH:MM:SS' u UTC bez sufiksa — bez 'Z' bi Date to čitao kao lokalno
  // vrijeme i heartbeat bi „pomladio/ostario" za offset zone (CEST = 2h = točno naš prag!).
  const raw = String(row.last_heartbeat).trim()
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(raw) ? raw.replace(' ', 'T') + 'Z' : raw
  const parsed = new Date(iso).getTime()
  if (Number.isNaN(parsed)) return null
  return Math.max(0, now - parsed)
}

/**
 * Odluči za JEDNOG agenta. Redoslijed je namjeran:
 *   1. status nije online/busy   → ok (nema laži u tablici, ništa za činiti)
 *   2. svjež heartbeat           → ok (najjeftinije, bez provjere procesa)
 *   3. izuzet konfiguracijom     → excluded (nikad se ne dira, ni u live načinu)
 *   4. proces još živi           → silent (status offline, taskovi OSTAJU njegovi)
 *   5. inače                     → dead (status offline + taskovi na /reclaim)
 */
export function decideAgent(
  row: AgentStatusRow,
  opts: { now: number; config: DeadAgentReaperConfig; isProcessAlive?: ProcessLivenessProbe }
): AgentDecision {
  const { now, config } = opts
  const probe = opts.isProcessAlive || defaultProcessLivenessProbe
  const thresholdMs = config.thresholdHours * 3_600_000
  const agentId = (row.agent_id || '').trim()
  const status = (row.status || 'offline').trim().toLowerCase()
  const pid = typeof row.pid === 'number' && row.pid > 0 ? row.pid : null
  const hbAgeMs = ageFromRow(row, now)

  const base = {
    agentId,
    status,
    pid,
    pidAlive: null as boolean | null,
    hbAgeMs,
    hbHours: hbAgeMs == null ? 0 : Math.floor(hbAgeMs / 3_600_000),
    lastHeartbeat: row.last_heartbeat ?? null,
    currentTask: row.current_task ?? null,
    markOffline: false,
    reclaimTasks: false,
  }

  if (!LIVE_STATUSES.includes(status)) {
    return { ...base, verdict: 'ok', reason: `status '${status}' ne tvrdi da agent radi — ništa za reapati` }
  }

  if (hbAgeMs != null && hbAgeMs < thresholdMs) {
    return { ...base, verdict: 'ok', reason: `heartbeat prije ${formatAge(hbAgeMs)} (< ${config.thresholdHours}h)` }
  }

  const excluded = exclusionReason(agentId, config)
  if (excluded) return { ...base, verdict: 'excluded', reason: excluded }

  const pidAlive = pid == null ? null : probe(pid)
  // NULL heartbeat uz status online je sam po sebi laž u tablici — takav redak je kandidat,
  // a o taskovima i dalje odlučuje samo dokaz o procesu.
  const hbPart = hbAgeMs == null
    ? `bez ijednog heartbeata (last_heartbeat=${row.last_heartbeat ?? 'NULL'})`
    : `heartbeat star ${formatAge(hbAgeMs)} (≥ ${config.thresholdHours}h)`

  if (pidAlive === true) {
    return {
      ...base,
      pidAlive,
      verdict: 'silent',
      markOffline: true,
      reason: `${hbPart}, ALI proces PID ${pid} živi — status na offline, taskove NE diram`,
    }
  }

  const pidPart = pid == null ? 'bez PID-a u tablici' : `proces PID ${pid} ne postoji`
  return {
    ...base,
    pidAlive,
    verdict: 'dead',
    markOffline: true,
    reclaimTasks: config.reclaimTasks,
    reason: `status '${status}' ali ${hbPart}, ${pidPart} — mrtav`,
  }
}

/** Vrati razlog izuzeća ili null. Usporedba je case-insensitive. */
export function exclusionReason(agentId: string, config: DeadAgentReaperConfig): string | null {
  const id = (agentId || '').toLowerCase()
  // Allowlist ima prednost: dok je onlyAgents postavljen, sve izvan njega je izuzeto.
  if (config.onlyAgents.length > 0 && !config.onlyAgents.includes(id)) {
    return 'izuzet: canary opseg (onlyAgents) ne uključuje ovog agenta'
  }
  if (config.excludeAgents.includes(id)) return `izuzet: agent '${id}' na excludeAgents listi`
  return null
}

/** Odluke za sve agente, stabilno sortirane: dead prvo, pa silent, pa najstariji heartbeat. */
export function evaluateAgents(
  rows: AgentStatusRow[],
  opts: { now: number; config: DeadAgentReaperConfig; isProcessAlive?: ProcessLivenessProbe }
): AgentDecision[] {
  const order: Record<DeadVerdict, number> = { dead: 0, silent: 1, excluded: 2, ok: 3 }
  return (rows || [])
    .map(r => decideAgent(r, opts))
    .sort((a, b) => order[a.verdict] - order[b.verdict] || (b.hbAgeMs ?? Infinity) - (a.hbAgeMs ?? Infinity))
}

// ============================================
// IZVRŠENJE ODLUKA (dry-run / live)
// ============================================

/**
 * Sve nuspojave reapanja iza jednog sučelja. Daemon ubacuje pravu bazu/HTTP,
 * testovi ubacuju stubove — pa se live put može dokazati BEZ dizanja daemona.
 */
export interface ReapEffects {
  /** `agent_status.status='offline'`, `current_task=NULL`. */
  markOffline(agentId: string): void
  /** in_progress taskovi (svi); null = izvor nedostupan → taskovi se NE diraju. */
  listInProgressTasks(): Promise<Array<{ id: string; assignee?: string | null; title?: string }> | null>
  /** R2 ruta: POST /api/tasks/:id/reclaim (PUT status=pending je zabranjen prijelaz → 409). */
  reclaim(taskId: string, reason: string): Promise<boolean>
  log(message: string): void
  alarm(message: string): void
  audit(decision: AgentDecision, live: boolean): void
  event?(name: string, agentId: string, details: string): void
}

export interface ReapOutcome {
  reaped: string[]
  reclaimedTasks: string[]
  /** true = brana `maxReapsPerRun` je zaustavila prolaz. */
  brakeHit: boolean
}

/**
 * Odradi prolaz nad već donesenim odlukama.
 *   dry-run → log + audit + alarm (ništa se ne mijenja)
 *   live    → markOffline (+ /reclaim za `dead`), uz branu maxReapsPerRun
 * `alarmed` je anti-spam skup (alarm 1× po epizodi); prazni se čim agent ozdravi.
 */
export async function applyDecisions(
  decisions: AgentDecision[],
  opts: { live: boolean; config: DeadAgentReaperConfig; effects: ReapEffects; alarmed?: Set<string> }
): Promise<ReapOutcome> {
  const { live, config, effects } = opts
  const alarmed = opts.alarmed ?? new Set<string>()
  const out: ReapOutcome = { reaped: [], reclaimedTasks: [], brakeHit: false }
  let tasksCache: Awaited<ReturnType<ReapEffects['listInProgressTasks']>> | undefined

  for (const d of decisions || []) {
    if (d.verdict === 'ok') { alarmed.delete(d.agentId); continue }
    if (d.verdict === 'excluded') {
      alarmed.delete(d.agentId)
      effects.log(`  [deadAgent] ${d.agentId} preskočen — ${d.reason}`)
      continue
    }

    effects.log(`  [deadAgent ${live ? 'LIVE' : 'DRY'}] ${formatAgentLine(d)}`)
    effects.audit(d, live)

    if (!alarmed.has(d.agentId)) {
      alarmed.add(d.agentId)
      const akcija = !live
        ? '(dry-run — samo dojava, ne diram)'
        : d.reclaimTasks ? 'Označavam offline + oslobađam njegove in_progress taskove.' : 'Označavam offline (taskove ne diram).'
      effects.alarm(`⚠️ [dead-agent] ${d.agentId} — ${d.reason}. ${akcija}`)
    }

    if (!live) continue

    // Brana: masovni reap je uvijek sumnjiv (kriva konfiguracija, a ne 10 mrtvih agenata).
    if (out.reaped.length >= config.maxReapsPerRun) {
      out.brakeHit = true
      effects.log(`  🛑 [deadAgent] brana: ${config.maxReapsPerRun} reapanja u ovom prolazu — ostatak preskačem`)
      effects.alarm(`🛑 [dead-agent] Reaper je u jednom prolazu htio reapati više od ${config.maxReapsPerRun} agenata — stao je iz sigurnosti. Provjeri config/dead-agent-reaper.json.`)
      break
    }

    if (d.markOffline) {
      effects.markOffline(d.agentId)
      effects.event?.('dead_agent_offline', d.agentId, `${d.verdict} · heartbeat ${d.hbHours}h`)
    }
    out.reaped.push(d.agentId)

    if (!d.reclaimTasks) continue
    if (tasksCache === undefined) tasksCache = await effects.listInProgressTasks()
    if (tasksCache === null) {
      effects.log(`  ⚠️ [deadAgent] popis taskova nedostupan — taskovi ${d.agentId} ostaju zaključani`)
      continue
    }
    for (const t of tasksCache.filter(t => (t.assignee || '').toLowerCase() === d.agentId.toLowerCase())) {
      const ok = await effects.reclaim(t.id, `dead-agent reaper: ${d.reason}`)
      if (ok) {
        out.reclaimedTasks.push(t.id)
        effects.log(`  ♻️ [deadAgent] ${t.id} oslobođen (${d.agentId} mrtav)`)
        effects.event?.('dead_agent_task_reclaimed', d.agentId, t.id)
      }
    }
  }
  return out
}

/** Minimum sučelja baze koji trebamo (bun:sqlite Database ga zadovoljava). */
export interface ReapDb {
  prepare(sql: string): { run: (...args: any[]) => any }
}

/**
 * Prave nuspojave (SQLite + TaskManager HTTP) — JEDNA implementacija za daemon i za
 * verifikacijski harness. Da je daemon imao svoju kopiju, harness bi mogao "proći"
 * a živi put pasti (upravo je tako R3 skelet mjesecima gađao PUT status=pending → 409).
 */
export function makeReapEffects(
  db: ReapDb,
  deps: {
    taskApi: string
    log: (msg: string) => void
    alarm: (msg: string) => void
    audit: (d: AgentDecision, live: boolean) => void
    event?: (name: string, agentId: string, details: string) => void
  }
): ReapEffects {
  const { taskApi, log } = deps
  return {
    // current_task se briše zajedno sa statusom — 'offline' uz zadatak u ruci je ista laž kao prije.
    markOffline: (agentId) => {
      try {
        db.prepare(`UPDATE agent_status SET status='offline', current_task=NULL, updated_at=CURRENT_TIMESTAMP WHERE agent_id=?`).run(agentId)
      } catch (e) { log(`  ⚠️ [deadAgent] offline ${agentId} pao: ${e}`) }
    },
    listInProgressTasks: async () => {
      try {
        const r = await fetch(`${taskApi}?status=in_progress`)
        if (!r.ok) { log(`  ⚠️ [deadAgent] TaskManager API ${r.status}`); return null }
        return await r.json() as any[]
      } catch (e) { log(`  ⚠️ [deadAgent] TaskManager API: ${e}`); return null }
    },
    reclaim: async (taskId, reason) => {
      try {
        // R2 ruta — PUT status=pending je zabranjen prijelaz (409) i tiho bi ostavio task zaključan.
        const r = await fetch(`${taskApi}/${taskId}/reclaim`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason, by: 'dead-agent-reaper' })
        })
        if (!r.ok) log(`  ⚠️ [deadAgent] reclaim ${taskId} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
        return r.ok
      } catch (e) { log(`  ⚠️ [deadAgent] reclaim ${taskId} pao: ${e}`); return false }
    },
    log,
    alarm: deps.alarm,
    audit: deps.audit,
    event: deps.event,
  }
}

// ============================================
// RUTANJE PRIJE SPAWNA (delegateToAgent)
// ============================================

export type SpawnRoute = 'persistent' | 'fallback'

export interface SpawnRouteDecision {
  route: SpawnRoute
  /** true = zatečen je LAŽAN trag živog daemona → počisti ga (reap), ne samo zaobiđi. */
  reap: boolean
  reason: string
}

/**
 * Odluka „kojim putem ide delegacija" PRIJE spawna (R3, drugi dio taska).
 *
 * Stari put je rutao u `messages` inbox čim je `persistentAgents` imao zapis — a taj je
 * zapis in-memory i preživi smrt daemona. Poruka bi tada trunula u inboxu koji nitko ne
 * čita („task dodijeljen agentu bez živog izvršnog puta"). Sada se PID provjerava, a
 * lažni zapis se REAPA (miče se iz mape + agent_status→offline), pa fallback
 * spawn-on-demand — koji uvijek radi — preuzima posao.
 */
export function decideSpawnRoute(opts: {
  persistentEnabled: boolean
  entryPid: number | null | undefined
  isProcessAlive?: ProcessLivenessProbe
}): SpawnRouteDecision {
  const probe = opts.isProcessAlive || defaultProcessLivenessProbe
  if (!opts.persistentEnabled) {
    return { route: 'fallback', reap: false, reason: 'perzistentni način isključen za ovog agenta' }
  }
  const pid = typeof opts.entryPid === 'number' && opts.entryPid > 0 ? opts.entryPid : null
  if (pid == null) {
    return { route: 'fallback', reap: false, reason: 'nema zapisa o perzistentnom daemonu' }
  }
  if (probe(pid)) {
    return { route: 'persistent', reap: false, reason: `perzistentni daemon PID ${pid} živ` }
  }
  return {
    route: 'fallback',
    reap: true,
    reason: `perzistentni daemon PID ${pid} NE postoji — lažan zapis, reapam ga i idem na spawn-on-demand`,
  }
}

// ============================================
// FORMAT
// ============================================

/** Jedan redak izvještaja/loga — isti format u daemonu i u alatu. */
export function formatAgentLine(d: AgentDecision): string {
  const mark = d.verdict === 'dead' ? '💀' : d.verdict === 'silent' ? '🔇' : d.verdict === 'excluded' ? '⏸️' : '✅'
  return `${mark} ${d.agentId.padEnd(10)} ${d.status.padEnd(7)} ${d.reason}`
}
