#!/usr/bin/env bun
/**
 * StaleReaper — odluka „je li in_progress task napušten?" (stari F3 čistač) na JEDNOM mjestu.
 *
 * TASK-3019 (PRJ-030). Modul je JEDINI IZVOR ISTINE za pravilo; koristi ga:
 *   - RegocDaemon.watchdogStaleTaskReaper()  → alarm (dry-run) / promjena statusa (live)
 *   - tools/task-cleaners-report.ts         → izvještaj „što BI dirao" (oba čistača)
 *
 * ZAŠTO POSTOJI FLAG: ovo je najstariji od TRI čistača nad in_progress taskovima i jedini
 * koji je do 2026-07-29 rezao status bez flaga, bez izuzeća i bez ijednog traga — 24 h bez
 * updatea → `blocked`, 7 dana → `cancelled`. Goranova odluka (2026-07-29): ide pod
 * `staleReaper` (promatranje) / `staleReaperLive` (djelovanje), s izuzećima kao R2.
 *
 * ODNOS PREMA R2 (StaleWatchdog.ts): R2 gleda 4 h I checkpointe (agent živ, samo ne piše u
 * task) i vraća task u obradu preko /reclaim. Ovaj reaper je grublji — ne gleda checkpointe
 * i ne vraća u obradu nego GASI. Zato ostaje na dužim pragovima i u dry-runu dok Goran ne
 * odluči treba li uopće postojati uz R2.
 *
 * Autor: Jelena (Engineer) · 2026-07-29
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  asPositiveNumber,
  asStringArray,
  exclusionReason,
  formatAge,
  type ExclusionConfig,
  type WatchdogTask,
} from './StaleWatchdog'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()
export const STALE_REAPER_CONFIG_PATH = join(HOME, '.claude', 'regoc', 'config', 'stale-reaper.json')

// ============================================
// KONFIGURACIJA
// ============================================

export interface StaleReaperConfig extends ExclusionConfig {
  /** Sati bez updatea (i bez ijedne progress-note) dok task ne ode u `blocked`. */
  blockAfterHours: number
  /** Dani bez updatea dok task ne ode u `cancelled` — gasi se bez obzira na progress-note. */
  cancelAfterDays: number
  /** Razmak između provjera u daemonu (minute). */
  intervalMinutes: number
  /** Sigurnosna brana za live: najviše toliko promjena statusa po prolazu, pa alarm i stop. */
  maxActionsPerRun: number
}

export const DEFAULT_STALE_REAPER_CONFIG: StaleReaperConfig = {
  blockAfterHours: 24,
  cancelAfterDays: 7,
  intervalMinutes: 30,
  maxActionsPerRun: 3,
  // Ista izuzeća kao R2 watchdog — tag `no-watchdog` mora značiti isto svakom mehanizmu.
  excludeTags: ['no-watchdog', 'waiting-for-human', 'interactive'],
  excludeAssignees: ['user', 'goran'],
  excludeTaskIds: [],
  onlyTaskIds: [],
}

/** Učitaj konfiguraciju; nedostajuća ili neispravna datoteka → defaulti (nikad ne baca). */
export function loadStaleReaperConfig(path: string = STALE_REAPER_CONFIG_PATH): StaleReaperConfig {
  const d = DEFAULT_STALE_REAPER_CONFIG
  try {
    if (!existsSync(path)) return { ...d }
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (!raw || typeof raw !== 'object') return { ...d }
    return {
      blockAfterHours: asPositiveNumber(raw.blockAfterHours, d.blockAfterHours),
      cancelAfterDays: asPositiveNumber(raw.cancelAfterDays, d.cancelAfterDays),
      intervalMinutes: asPositiveNumber(raw.intervalMinutes, d.intervalMinutes),
      maxActionsPerRun: asPositiveNumber(raw.maxActionsPerRun, d.maxActionsPerRun),
      excludeTags: asStringArray(raw.excludeTags, d.excludeTags),
      excludeAssignees: asStringArray(raw.excludeAssignees, d.excludeAssignees),
      excludeTaskIds: asStringArray(raw.excludeTaskIds, d.excludeTaskIds),
      onlyTaskIds: asStringArray(raw.onlyTaskIds, d.onlyTaskIds),
    }
  } catch {
    return { ...d }
  }
}

// ============================================
// TIPOVI ODLUKE
// ============================================

export type ReaperVerdict = 'fresh' | 'excluded' | 'block' | 'cancel'

/** Reaper gleda i progress-note, pa mu treba malo više od `WatchdogTask`. */
export interface ReaperTask extends WatchdogTask {
  progressNotes?: unknown[] | null
}

export interface ReaperDecision {
  taskId: string
  title: string
  assignee: string
  staleMs: number
  staleHours: number
  staleDays: number
  lastActivity: string | null
  verdict: ReaperVerdict
  /** Čitljiv razlog — ide doslovno u JSONL, log i alarm. */
  reason: string
  /** Status koji bi live način postavio (null kad se ne dira). */
  targetStatus: 'blocked' | 'cancelled' | null
}

// ============================================
// ODLUKA (čista funkcija — testabilna bez daemona)
// ============================================

/**
 * Odluči za JEDAN task. Redoslijed je namjeran:
 *   1. mlađi od praga blokiranja → fresh (najjeftinije)
 *   2. izuzet                    → excluded (nikad se ne dira, ni u live načinu)
 *   3. stariji od praga gašenja  → cancel
 *   4. bez ijedne progress-note  → block (s progress-notama ostaje fresh do praga gašenja)
 */
export function decideReaperTask(
  task: ReaperTask,
  opts: { now: number; config: StaleReaperConfig }
): ReaperDecision {
  const { now, config } = opts
  const assignee = (task.assignee || '').trim()
  const lastActivity = task.updatedAt || task.startedAt || task.createdAt || null
  const base = { taskId: task.id, title: task.title || '', assignee, lastActivity, targetStatus: null as null }

  if (!lastActivity) {
    return { ...base, staleMs: 0, staleHours: 0, staleDays: 0, verdict: 'fresh', reason: 'nema vremenskog traga (updatedAt/startedAt/createdAt)' }
  }
  const parsed = new Date(lastActivity).getTime()
  if (Number.isNaN(parsed)) {
    return { ...base, staleMs: 0, staleHours: 0, staleDays: 0, verdict: 'fresh', reason: `neispravan datum zadnje aktivnosti: ${lastActivity}` }
  }

  const staleMs = Math.max(0, now - parsed)
  const staleHours = Math.floor(staleMs / 3_600_000)
  const staleDays = Math.floor(staleMs / 86_400_000)
  const metrics = { staleMs, staleHours, staleDays }
  const blockMs = config.blockAfterHours * 3_600_000
  const cancelMs = config.cancelAfterDays * 86_400_000

  if (staleMs < blockMs) {
    return { ...base, ...metrics, verdict: 'fresh', reason: `zadnji update prije ${formatAge(staleMs)} (< ${config.blockAfterHours}h)` }
  }

  const excluded = exclusionReason(task, assignee, config)
  if (excluded) return { ...base, ...metrics, verdict: 'excluded', reason: excluded }

  if (staleMs >= cancelMs) {
    return { ...base, ...metrics, verdict: 'cancel', targetStatus: 'cancelled', reason: `napušteno — bez napretka ${staleDays} dana (≥ ${config.cancelAfterDays}d)` }
  }

  // Postojeće pravilo (zadržano): ijedna progress-note znači „netko je nešto zapisao" i
  // štedi task od blokiranja, ali NE od gašenja nakon `cancelAfterDays`.
  const hasProgressNotes = Array.isArray(task.progressNotes) && task.progressNotes.length > 0
  if (hasProgressNotes) {
    return { ...base, ...metrics, verdict: 'fresh', reason: `bez updatea ${formatAge(staleMs)}, ali ima progress-note — ne blokiram (gašenje tek nakon ${config.cancelAfterDays}d)` }
  }

  return { ...base, ...metrics, verdict: 'block', targetStatus: 'blocked', reason: `nema napretka ${staleHours}h i nijedne progress-note — potrebna provjera` }
}

/** Odluke za sve taskove, stabilno sortirane: djelujuće prvo, pa najduže stajanje. */
export function evaluateReaperTasks(
  tasks: ReaperTask[],
  opts: { now: number; config: StaleReaperConfig }
): ReaperDecision[] {
  const order: Record<ReaperVerdict, number> = { cancel: 0, block: 1, excluded: 2, fresh: 3 }
  return (tasks || [])
    .map(t => decideReaperTask(t, opts))
    .sort((a, b) => order[a.verdict] - order[b.verdict] || b.staleMs - a.staleMs)
}

/** Djeluje li odluka na status? Jedno mjesto istine za „ovo mijenja tuđi task". */
export function isActionable(verdict: ReaperVerdict): boolean {
  return verdict === 'block' || verdict === 'cancel'
}

// ============================================
// PLAN RADNJI (jedini put do promjene statusa)
// ============================================

/** Jedna promjena statusa: točno ono što daemon pošalje kao PUT body. */
export interface ReaperAction {
  taskId: string
  assignee: string
  targetStatus: 'blocked' | 'cancelled'
  body: Record<string, unknown>
  decision: ReaperDecision
}

/**
 * Pretvori odluke u radnje. OVO JE JEDINI put kojim reaper mijenja tuđi task — daemon nema
 * drugog PUT-a, pa `live=false → []` doslovno znači „dry-run ne dira ništa".
 * Brana `maxActionsPerRun`: masovno gašenje je uvijek sumnjivo (kriva konfiguracija).
 */
export function planReaperActions(
  decisions: ReaperDecision[],
  opts: { live: boolean; config: StaleReaperConfig }
): { actions: ReaperAction[]; capped: boolean } {
  if (!opts.live) return { actions: [], capped: false }
  const actionable = (decisions || []).filter(d => isActionable(d.verdict))
  const capped = actionable.length > opts.config.maxActionsPerRun
  const actions = actionable.slice(0, opts.config.maxActionsPerRun).map((d): ReaperAction => (
    d.verdict === 'cancel'
      ? { taskId: d.taskId, assignee: d.assignee, targetStatus: 'cancelled', decision: d, body: { status: 'cancelled', resultSummary: `Stale-reaper: ${d.reason}` } }
      : { taskId: d.taskId, assignee: d.assignee, targetStatus: 'blocked', decision: d, body: { status: 'blocked', blockedReason: `Stale-reaper: ${d.reason}` } }
  ))
  return { actions, capped }
}
