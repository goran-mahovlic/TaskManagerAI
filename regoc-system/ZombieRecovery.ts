#!/usr/bin/env bun
/**
 * ZombieRecovery — odluka „je li in_progress task ostao bez izvršitelja?" na JEDNOM mjestu.
 *
 * TASK-3019 (PRJ-030). Modul je JEDINI IZVOR ISTINE za pravilo; koristi ga:
 *   - RegocDaemon.processP1Tasks()          → alarm (dry-run) / promjena statusa (live)
 *   - tools/task-cleaners-report.ts        → izvještaj „što BI dirao" (oba čistača)
 *
 * ZAŠTO POSTOJI FLAG (nalaz TASK-2560, 2026-07-27): zombie-recovery je pri restartu
 * daemona zablokirao TASK-2559/2560/2565 iako su agenti bili ŽIVI — interaktivne sesije
 * nisu spawnovi ovog daemona pa nikad nisu u `activeAgentSpawns`. Mehanizam je mijenjao
 * status bez ijednog dry-run perioda i bez alarma. Goranova odluka (2026-07-29): oba
 * čistača idu pod flag i počinju u dry-runu — `zombieRecovery` (promatranje) i
 * `zombieRecoveryLive` (djelovanje).
 *
 * Pravilo: task je `zombie` ako je in_progress, ima assigneeja, NEMA živog spawna u ovom
 * daemonu, stariji je od praga (default 10 min — 90 s je hvatalo i zdrav rad) i nije izuzet.
 * Prva epizoda → povratak u obradu, druga → BLOCKED (vidljivo neriješen, ne tiho izgubljen).
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
  loadStaleWatchdogConfig,
  STALE_WATCHDOG_CONFIG_PATH,
  type ExclusionConfig,
  type WatchdogTask,
} from './StaleWatchdog'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()
export const ZOMBIE_RECOVERY_CONFIG_PATH = join(HOME, '.claude', 'regoc', 'config', 'zombie-recovery.json')

// ============================================
// KONFIGURACIJA
// ============================================

export interface ZombieRecoveryConfig extends ExclusionConfig {
  /**
   * Koliko minuta bez task-updatea (uz odsutan spawn) dok se task ne proglasi zombijem.
   * Bilo je 90 s — prekratko: hvatalo je i zdrav rad (agent koji misli dulje od minute i pol).
   */
  thresholdMinutes: number
  /** Nakon toliko odvojenih recovery epizoda task ide u BLOCKED umjesto natrag u obradu. */
  blockAfterRecoveries: number
  /** Sigurnosna brana za live: najviše toliko promjena statusa po prolazu, pa alarm i stop. */
  maxActionsPerRun: number
  /**
   * Koliko minuta nakon STARTA DAEMONA mehanizam samo promatra (TASK-3598).
   *
   * Dokaz zašto postoji: `activeAgentSpawns` je in-memory mapa — restart je isprazni, pa
   * SVAKI in_progress task na trenutak izgleda kao „bez živog spawna". Točno tako je
   * 27.07.2026. zombie-recovery zablokirao TASK-2559/2560/2565 dok su agenti radili.
   * Milost daje živim spawnovima vremena da se ponovno prijave prije prve radnje.
   */
  startupGraceMinutes: number
}

export const DEFAULT_ZOMBIE_RECOVERY_CONFIG: ZombieRecoveryConfig = {
  thresholdMinutes: 10,
  blockAfterRecoveries: 2,
  maxActionsPerRun: 5,
  startupGraceMinutes: 10,
  // Ista izuzeća kao R2 watchdog — tag `no-watchdog` mora značiti isto svakom mehanizmu.
  excludeTags: ['no-watchdog', 'waiting-for-human', 'interactive'],
  excludeAssignees: ['user', 'goran'],
  excludeTaskIds: [],
  onlyTaskIds: [],
}

/** Unija dviju lista bez duplikata, stabilnog redoslijeda (prvo `a`, pa novo iz `b`). */
function union(a: string[], b: string[]): string[] {
  const out = [...a]
  for (const v of b) if (!out.includes(v)) out.push(v)
  return out
}

/**
 * Učitaj konfiguraciju; nedostajuća ili neispravna datoteka → defaulti (nikad ne baca).
 *
 * IZUZEĆA IMAJU JEDAN IZVOR (TASK-3598): tagovi/assigneeji/ID-evi iz `config/stale-watchdog.json`
 * su POD (floor) i ovdje — tag `no-watchdog` mora značiti isto svakom mehanizmu, a dvije
 * ručno održavane kopije se raziđu čim netko doda izuzeće samo na jedno mjesto. Unija ide
 * samo u smjeru VEĆE zaštite: zombie config može dodati svoja izuzeća, ali ne može ukinuti
 * tuđa. `onlyTaskIds` (canary opseg) se NAMJERNO ne dijeli — canary je po mehanizmu.
 */
export function loadZombieRecoveryConfig(
  path: string = ZOMBIE_RECOVERY_CONFIG_PATH,
  sharedExclusionsPath: string = STALE_WATCHDOG_CONFIG_PATH
): ZombieRecoveryConfig {
  const d = DEFAULT_ZOMBIE_RECOVERY_CONFIG
  const shared = loadStaleWatchdogConfig(sharedExclusionsPath)
  const withShared = (c: ZombieRecoveryConfig): ZombieRecoveryConfig => ({
    ...c,
    excludeTags: union(c.excludeTags, shared.excludeTags),
    excludeAssignees: union(c.excludeAssignees, shared.excludeAssignees),
    excludeTaskIds: union(c.excludeTaskIds, shared.excludeTaskIds),
  })
  try {
    if (!existsSync(path)) return withShared({ ...d })
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (!raw || typeof raw !== 'object') return withShared({ ...d })
    return withShared({
      thresholdMinutes: asPositiveNumber(raw.thresholdMinutes, d.thresholdMinutes),
      blockAfterRecoveries: asPositiveNumber(raw.blockAfterRecoveries, d.blockAfterRecoveries),
      maxActionsPerRun: asPositiveNumber(raw.maxActionsPerRun, d.maxActionsPerRun),
      startupGraceMinutes: asPositiveNumber(raw.startupGraceMinutes, d.startupGraceMinutes),
      excludeTags: asStringArray(raw.excludeTags, d.excludeTags),
      excludeAssignees: asStringArray(raw.excludeAssignees, d.excludeAssignees),
      excludeTaskIds: asStringArray(raw.excludeTaskIds, d.excludeTaskIds),
      onlyTaskIds: asStringArray(raw.onlyTaskIds, d.onlyTaskIds),
    })
  } catch {
    return withShared({ ...d })
  }
}

/**
 * Marker koji REGOČ upisuje u prompt svakog spawna („Tvoj task ID: **TASK-1234**").
 * Pojavljuje se SAMO u naredbenom retku agentske sesije, pa je pouzdaniji od golog
 * traženja `TASK-\d+` — shell naredba koja usput spominje ID nije dokaz da netko radi.
 */
export const SPAWN_TASK_MARKER = /Tvoj task ID:\s*\*\*(TASK-\d+)\*\*/g

/**
 * Zadaci koje netko STVARNO radi, očitani iz naredbenih redaka živih procesa (TASK-3598).
 *
 * `activeAgentSpawns` je in-memory mapa daemona: restart je isprazni, a sesije koje je
 * digla prošla generacija (ili interaktivne sesije koje daemon nikad nije ni spawnao)
 * nastave raditi. Bez ovog očitanja živ agent izgleda kao zombi — dokazano 02.09.2026.:
 * TASK-3597 je imao živ proces (PID 3941660) dok ga daemon nakon restarta nije vidio.
 */
export function extractLiveTaskIds(cmdlines: string[]): Set<string> {
  const out = new Set<string>()
  for (const c of cmdlines || []) {
    if (!c || !c.includes('claude')) continue   // samo agentske sesije, ne shell naredbe s ID-em u tekstu
    for (const m of c.matchAll(SPAWN_TASK_MARKER)) out.add(m[1]!)
  }
  return out
}

/**
 * Je li daemon još u startnoj milosti? Čista funkcija — daemon predaje vlastito vrijeme starta.
 * `true` znači „samo promatraj": presude se i dalje bilježe, ali plan radnji ostaje prazan.
 */
export function withinStartupGrace(now: number, daemonStartedAt: number, config: ZombieRecoveryConfig): boolean {
  return now - daemonStartedAt < config.startupGraceMinutes * 60_000
}

// ============================================
// TIPOVI ODLUKE
// ============================================

/**
 * `tracked`  = ovaj daemon ima živ spawn za task → nije zombi
 * `skipped`  = nema assigneeja (nema koga vratiti u obradu)
 * `fresh`    = mlađi od praga
 * `excluded` = izuzet konfiguracijom (nikad se ne dira, ni u live načinu)
 * `recover`  = vrati u obradu (live) / prijavi (dry-run)
 * `block`    = ponovljena epizoda → BLOCKED
 */
export type ZombieVerdict = 'tracked' | 'skipped' | 'fresh' | 'excluded' | 'recover' | 'block'

export interface ZombieDecision {
  taskId: string
  title: string
  assignee: string
  ageMs: number
  /** Redni broj epizode koju bi ova odluka izazvala (1 = prva). 0 kad se ne djeluje. */
  recoveryCount: number
  verdict: ZombieVerdict
  /** Čitljiv razlog — ide doslovno u JSONL, log i alarm. */
  reason: string
}

// ============================================
// ODLUKA (čista funkcija — testabilna bez daemona)
// ============================================

/**
 * Odluči za JEDAN task. Redoslijed je namjeran:
 *   1. bez assigneeja        → skipped
 *   2. živ spawn             → tracked (najjači dokaz da agent radi)
 *   3. mlađi od praga        → fresh
 *   4. izuzet                → excluded (nikad se ne dira)
 *   5. inače                 → recover / block, ovisno o broju dosadašnjih epizoda
 *
 * `priorRecoveries` je broj VEĆ ODRAĐENIH epizoda za taj task (daemon ga pamti).
 */
export function decideZombieTask(
  task: WatchdogTask,
  opts: { now: number; config: ZombieRecoveryConfig; tracked?: Set<string>; priorRecoveries?: number; delegated?: Set<string> }
): ZombieDecision {
  const { now, config } = opts
  const assignee = (task.assignee || '').trim()
  const base = { taskId: task.id, title: task.title || '', assignee, recoveryCount: 0 }

  if (!assignee) {
    return { ...base, ageMs: 0, verdict: 'skipped', reason: 'bez assigneeja — nema koga vratiti u obradu' }
  }
  if (opts.tracked?.has(task.id)) {
    return { ...base, ageMs: 0, verdict: 'tracked', reason: 'daemon ima živ spawn za ovaj task' }
  }
  // TASK-5140: zadatak koji je preuzeo siroče-oporavak (OrphanRecovery.ts) ovdje se ne dira —
  // dva mehanizma nad istim zadatkom imala bi dva brojača i dva stropa (2 vs 3).
  if (opts.delegated?.has(task.id)) {
    return { ...base, ageMs: 0, verdict: 'excluded', reason: 'prepušten siroče-oporavku (TASK-5140)' }
  }

  const lastActivity = task.updatedAt || task.createdAt || null
  const parsed = lastActivity ? new Date(lastActivity).getTime() : NaN
  if (!lastActivity || Number.isNaN(parsed)) {
    // Bez ijednog vremenskog traga ne možemo tvrditi napuštenost → ne diramo.
    return { ...base, ageMs: 0, verdict: 'fresh', reason: `nema upotrebljivog vremenskog traga (updatedAt/createdAt: ${lastActivity ?? 'null'})` }
  }

  const ageMs = Math.max(0, now - parsed)
  const thresholdMs = config.thresholdMinutes * 60_000
  if (ageMs < thresholdMs) {
    return { ...base, ageMs, verdict: 'fresh', reason: `zadnji update prije ${formatAge(ageMs)} (< ${config.thresholdMinutes}min)` }
  }

  const excluded = exclusionReason(task, assignee, config)
  if (excluded) return { ...base, ageMs, verdict: 'excluded', reason: excluded }

  const recoveryCount = (opts.priorRecoveries || 0) + 1
  if (recoveryCount >= config.blockAfterRecoveries) {
    return {
      ...base,
      ageMs,
      recoveryCount,
      verdict: 'block',
      reason: `in_progress ${formatAge(ageMs)} bez živog spawna, prekinut ${recoveryCount}× bez čistog završetka → BLOCKED (vidljivo neriješen)`,
    }
  }
  return {
    ...base,
    ageMs,
    recoveryCount,
    verdict: 'recover',
    reason: `in_progress ${formatAge(ageMs)} bez živog spawna (epizoda ${recoveryCount}) → natrag u obradu`,
  }
}

/** Odluke za sve taskove, stabilno sortirane: djelujuće prvo, pa najduže stajanje. */
export function evaluateZombieTasks(
  tasks: WatchdogTask[],
  opts: { now: number; config: ZombieRecoveryConfig; tracked?: Set<string>; priorRecoveries?: Map<string, number>; delegated?: Set<string> }
): ZombieDecision[] {
  const order: Record<ZombieVerdict, number> = { block: 0, recover: 1, excluded: 2, tracked: 3, fresh: 4, skipped: 5 }
  return (tasks || [])
    .map(t => decideZombieTask(t, { now: opts.now, config: opts.config, tracked: opts.tracked, priorRecoveries: opts.priorRecoveries?.get(t.id), delegated: opts.delegated }))
    .sort((a, b) => order[a.verdict] - order[b.verdict] || b.ageMs - a.ageMs)
}

/** Djeluje li odluka na status? Jedno mjesto istine za „ovo mijenja tuđi task". */
export function isActionable(verdict: ZombieVerdict): boolean {
  return verdict === 'recover' || verdict === 'block'
}

// ============================================
// PLAN RADNJI (jedini put do promjene statusa)
// ============================================

/**
 * Kojim ulazom se mijenja status (TASK-3598):
 *   `reclaim` = POST /api/tasks/:id/reclaim — JEDINI legalan put za in_progress→pending.
 *               Obični PUT status=pending je zabranjen prijelaz i vraća 409, pa je live
 *               način do 02.09.2026. bio mrtvo slovo: plan je postojao, a API ga je odbijao.
 *   `put`     = PUT /api/tasks/:id — za in_progress→blocked, koji JEST dopušten prijelaz.
 */
export type ZombieRoute = 'reclaim' | 'put'

/** Jedna promjena statusa: točno ono što daemon pošalje, uključujući i KOJIM ulazom. */
export interface ZombieAction {
  taskId: string
  assignee: string
  targetStatus: 'pending' | 'blocked'
  /** Ruta i metoda su dio PLANA, ne daemonove improvizacije — inače se 409 vrati na mala vrata. */
  route: ZombieRoute
  method: 'POST' | 'PUT'
  /** Put relativan na `TASK_MANAGER_API` (npr. `/TASK-1/reclaim` ili `/TASK-1`). */
  path: string
  body: Record<string, unknown>
  decision: ZombieDecision
}

/**
 * Pretvori odluke u radnje. OVO JE JEDINI put kojim zombie-recovery mijenja tuđi task —
 * daemon nema drugog PUT-a, pa `live=false → []` doslovno znači „dry-run ne dira ništa".
 * Brana `maxActionsPerRun`: masovna promjena statusa je uvijek sumnjiva (kriva konfiguracija).
 */
export function planZombieActions(
  decisions: ZombieDecision[],
  opts: { live: boolean; config: ZombieRecoveryConfig; startupGrace?: boolean }
): { actions: ZombieAction[]; capped: boolean } {
  // Startna milost je namjerno OVDJE, a ne u daemonu: plan je jedini put do promjene
  // statusa, pa je i jedino mjesto na kojem se „ne diraj još" ne može zaobići.
  if (!opts.live || opts.startupGrace) return { actions: [], capped: false }
  const actionable = (decisions || []).filter(d => isActionable(d.verdict))
  const capped = actionable.length > opts.config.maxActionsPerRun
  const actions = actionable.slice(0, opts.config.maxActionsPerRun).map((d): ZombieAction => (
    d.verdict === 'block'
      ? {
          taskId: d.taskId, assignee: d.assignee, targetStatus: 'blocked', decision: d,
          route: 'put', method: 'PUT', path: `/${d.taskId}`,
          body: {
            status: 'blocked',
            blockedReason: `Zombie-recovery: ${d.reason}`,
            progressNotes: [`Auto (zombie-recovery): ${d.reason}. Ručno vrati u obradu kad želiš.`],
          },
        }
      : {
          taskId: d.taskId, assignee: d.assignee, targetStatus: 'pending', decision: d,
          route: 'reclaim', method: 'POST', path: `/${d.taskId}/reclaim`,
          // `reason` je OBAVEZAN — bez njega ruta vraća 400 (ide u audit trail taska).
          body: { reason: `Zombie-recovery: ${d.reason}`, by: 'zombie-recovery' },
        }
  ))
  return { actions, capped }
}
