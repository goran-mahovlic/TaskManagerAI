#!/usr/bin/env bun
/**
 * OrphanRecovery — siroče: zadatak `in_progress` s izvršiteljem-agentom, a bez ikoga tko radi.
 *
 * TASK-5140 (REGOC_SYSTEM). Pravilo je OVDJE (čiste funkcije); RegocDaemon samo čita sustav
 * (spawnovi, živi procesi, najmovi) i izvodi plan.
 *
 * Povod (TASK-5134, 02.10.2026.): agent je iz vlastitog spawna restartao RegocDaemon. Novi
 * daemon njegov proces više nije imao u evidenciji („🫀 [zombie] živ proces izvan evidencije …
 * ne diram ih”). Kad je agent izašao, `pocistiNajmove()` je u 20:18Z očistio najam, a zadatak
 * je ostao `in_progress` BEZ procesa dok ga REGOČ nije ručno vratio kroz `/reclaim`.
 * Zombie-recovery (TASK-3019) bi ga uhvatio tek 10 min nakon zadnje bilješke — a očišćen
 * najam s mrtvim pidom je dokaz koji ne treba čekati.
 *
 * Dva okidača:
 *   `najam` — daemon je upravo očistio najam jer je pid mrtav (ili najam prestar) → odmah.
 *   `prag`  — nema živog spawna, procesa ni najma dulje od `pragMinuta` (zadano 10).
 * Radnja ide ISTIM putem kao reclaim (TASK-2560): `POST /api/tasks/:id/reclaim`. Na strop
 * pokušaja (zadano 3) zadatak ide u `blocked` s razlogom „siroče ×3” — vidljivo, ne beskonačno.
 *
 * Brojač pokušaja je u DATOTECI, ne u memoriji: siročad nastaje upravo restartom daemona,
 * pa bi brojač u memoriji svakim restartom krenuo od nule i strop nikad ne bi pao.
 *
 * Autor: Jelena (Engineer) · 2026-10-02
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
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
export const SIROCE_CONFIG_PATH = join(HOME, '.claude', 'regoc', 'config', 'siroce-oporavak.json')
export const SIROCE_BROJAC_PATH = join(HOME, '.claude', 'regoc', 'data', 'siroce_brojac.json')
export const SIROCE_LOG_PATH = join(HOME, '.claude', 'regoc', 'data', 'siroce_oporavak.jsonl')

/** Zapis brojača stariji od ovoga se ne broji (zadatak ponovno otvoren za tjedan = nova priča). */
const BROJAC_VRIJEDI_MS = 7 * 24 * 60 * 60 * 1000

// ============================================
// KONFIGURACIJA
// ============================================

export interface SiroceConfig extends ExclusionConfig {
  /** Koliko minuta bez spawna, procesa i najma dok zadatak ne postane siroče (okidač `prag`). */
  pragMinuta: number
  /** Na koji redni broj siročenja zadatak ide u `blocked` umjesto natrag u obradu. */
  stropPokusaja: number
  /** Brana: najviše toliko promjena statusa po prolazu (masovna promjena = kriva konfiguracija). */
  maxRadnjiPoProlazu: number
}

export const DEFAULT_SIROCE_CONFIG: SiroceConfig = {
  pragMinuta: 10,
  stropPokusaja: 3,
  maxRadnjiPoProlazu: 5,
  excludeTags: ['no-watchdog', 'waiting-for-human', 'interactive'],
  // regoc = orkestrator radi sam (nema spawna koji bi se mogao izgubiti); goran/user = čovjek.
  excludeAssignees: ['regoc', 'goran', 'user'],
  excludeTaskIds: [],
  onlyTaskIds: [],
}

function unija(a: string[], b: string[]): string[] {
  const out = [...a]
  for (const v of b) if (!out.includes(v)) out.push(v)
  return out
}

/**
 * Nedostajuća ili pokvarena datoteka → zadano; nikad ne baca. Izuzeća iz
 * `config/stale-watchdog.json` su POD (kao kod zombie-recoveryja, TASK-3598): `no-watchdog`
 * mora značiti isto svakom mehanizmu. Zadana izuzeća (regoc) se također ne mogu ukinuti.
 */
export function ucitajSiroceConfig(
  path: string = SIROCE_CONFIG_PATH,
  sharedPath: string = STALE_WATCHDOG_CONFIG_PATH,
): SiroceConfig {
  const d = DEFAULT_SIROCE_CONFIG
  const shared = loadStaleWatchdogConfig(sharedPath)
  let raw: any = null
  try { if (existsSync(path)) raw = JSON.parse(readFileSync(path, 'utf-8')) } catch { raw = null }
  if (!raw || typeof raw !== 'object') raw = {}
  return {
    pragMinuta: asPositiveNumber(raw.pragMinuta, d.pragMinuta),
    stropPokusaja: asPositiveNumber(raw.stropPokusaja, d.stropPokusaja),
    maxRadnjiPoProlazu: asPositiveNumber(raw.maxRadnjiPoProlazu, d.maxRadnjiPoProlazu),
    excludeTags: unija(unija(d.excludeTags, asStringArray(raw.excludeTags, [])), shared.excludeTags),
    excludeAssignees: unija(unija(d.excludeAssignees, asStringArray(raw.excludeAssignees, [])), shared.excludeAssignees),
    excludeTaskIds: unija(asStringArray(raw.excludeTaskIds, []), shared.excludeTaskIds),
    onlyTaskIds: asStringArray(raw.onlyTaskIds, []),
  }
}

// ============================================
// DURABILAN BROJAČ
// ============================================

/** Broj dosadašnjih siročenja po zadatku. Pokvarena/nepostojeća datoteka → prazno. */
export function ucitajBrojac(path: string = SIROCE_BROJAC_PATH, now: number = Date.now()): Map<string, number> {
  const out = new Map<string, number>()
  try {
    if (!existsSync(path)) return out
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (!raw || typeof raw !== 'object') return out
    for (const [id, v] of Object.entries(raw as Record<string, any>)) {
      const broj = Number(v?.broj)
      const t = Date.parse(v?.zadnji)
      if (!Number.isFinite(broj) || broj <= 0) continue
      if (Number.isFinite(t) && now - t > BROJAC_VRIJEDI_MS) continue
      out.set(id, broj)
    }
  } catch { /* pokvaren brojač → kreće od nule, nikad ne ruši daemon */ }
  return out
}

/** Upiši broj siročenja za zadatak. Atomično (tmp + rename); greška se guta. */
export function zabiljeziPokusaj(path: string, taskId: string, broj: number, now: number = Date.now()): void {
  try {
    let raw: Record<string, any> = {}
    try { if (existsSync(path)) raw = JSON.parse(readFileSync(path, 'utf-8')) || {} } catch { raw = {} }
    for (const [id, v] of Object.entries(raw)) {
      const t = Date.parse(v?.zadnji)
      if (!Number.isFinite(t) || now - t > BROJAC_VRIJEDI_MS) delete raw[id]
    }
    raw[taskId] = { broj, zadnji: new Date(now).toISOString() }
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(raw, null, 2))
    renameSync(tmp, path)
  } catch { /* brojač je pomoćni zapis */ }
}

// ============================================
// ODLUKA (čista funkcija)
// ============================================

export interface SiroceZadatak extends WatchdogTask {
  /** Zastavica ručne kočnice po zadatku (TASK-3047); iz baze stiže kao 0/1. */
  paused?: boolean | number | null
}

/**
 * `nije`     = nije in_progress ili nema izvršitelja — nije naš posao
 * `ziv`      = živ spawn, proces ili najam → netko radi
 * `izuzet`   = regoc / no-watchdog / pauziran / konfiguracija
 * `ceka`     = bez znakova života, ali kraće od praga
 * `vrati`    = natrag u obradu (reclaim)
 * `blokiraj` = strop pokušaja → blocked „siroče ×N”
 */
export type SirocePresuda = 'nije' | 'ziv' | 'izuzet' | 'ceka' | 'vrati' | 'blokiraj'

export interface SiroceOdluka {
  taskId: string
  title: string
  assignee: string
  presuda: SirocePresuda
  okidac: 'najam' | 'prag' | null
  /** Redni broj siročenja koji bi radnja zabilježila (0 kad se ne djeluje). */
  pokusaj: number
  strop: number
  odsutanMs: number
  razlog: string
}

export interface SiroceUlaz {
  now: number
  config: SiroceConfig
  /** Zadaci sa živim spawnom u OVOM daemonu (uključuje spawn koji se upravo zatvara). */
  tracked: Set<string>
  /** Zadaci sa živim procesom (platforma; sesije prošle generacije daemona). */
  ziviProcesi: Set<string>
  /** Zadaci s DOKAZIVO živim najmom. */
  ziviNajmovi: Set<string>
  /** Zadaci kojima je daemon upravo očistio najam (mrtav pid / prestar). */
  ocisceniNajmovi: Set<string>
  /** Zadnji trenutak kad je zadatak pokazao znak života (spawn/proces/najam/update/start daemona). */
  zadnjiZivotMs: number
  /** Koliko je siročenja zadatak već imao (durabilan brojač). */
  dosadasnjih: number
}

function jePauziran(p: unknown): boolean {
  return p === true || p === 1 || p === '1' || p === 'true'
}

export function odluciSiroce(task: SiroceZadatak, u: SiroceUlaz): SiroceOdluka {
  const assignee = String(task.assignee || '').trim()
  const strop = u.config.stropPokusaja
  const base = { taskId: task.id, title: task.title || '', assignee, okidac: null, pokusaj: 0, strop, odsutanMs: 0 }

  if (task.status && task.status !== 'in_progress') return { ...base, presuda: 'nije', razlog: `status ${task.status}` }
  if (!assignee) return { ...base, presuda: 'nije', razlog: 'bez izvršitelja' }

  // Znakovi života imaju prednost pred svime: spawn koji se upravo zatvara (proces je izašao,
  // daemon još piše presudu) je u `tracked` dok ne pusti najam — njega se ne smije oteti.
  if (u.tracked.has(task.id)) return { ...base, presuda: 'ziv', razlog: 'daemon ima živ spawn' }
  if (u.ziviProcesi.has(task.id)) return { ...base, presuda: 'ziv', razlog: 'živ proces izvan evidencije' }
  if (u.ziviNajmovi.has(task.id)) return { ...base, presuda: 'ziv', razlog: 'živ najam' }

  if (jePauziran(task.paused)) return { ...base, presuda: 'izuzet', razlog: 'pauziran zadatak (ručna kočnica)' }
  const izuzece = exclusionReason(task, assignee, u.config)
  if (izuzece) return { ...base, presuda: 'izuzet', razlog: izuzece }

  const odsutanMs = Math.max(0, u.now - (u.zadnjiZivotMs || 0))
  let okidac: 'najam' | 'prag' | null = null
  if (u.ocisceniNajmovi.has(task.id)) okidac = 'najam'
  else if (odsutanMs >= u.config.pragMinuta * 60_000) okidac = 'prag'
  if (!okidac) {
    return { ...base, odsutanMs, presuda: 'ceka', razlog: `bez znakova života ${formatAge(odsutanMs)} (< ${u.config.pragMinuta}min)` }
  }

  const pokusaj = (u.dosadasnjih || 0) + 1
  const zasto = okidac === 'najam'
    ? 'najam očišćen (proces mrtav), nema živog spawna ni procesa'
    : `nema živog spawna, procesa ni najma ${formatAge(odsutanMs)}`
  if (pokusaj >= strop) {
    return { ...base, odsutanMs, okidac, pokusaj, presuda: 'blokiraj', razlog: `siroče ×${pokusaj}: ${zasto} — strop ${strop} pokušaja, treba pogledati zašto agent ne završava` }
  }
  return { ...base, odsutanMs, okidac, pokusaj, presuda: 'vrati', razlog: `siroče (pokušaj ${pokusaj}/${strop}): ${zasto} → natrag u obradu` }
}

// ============================================
// PLAN RADNJE
// ============================================

export interface SiroceRadnja {
  taskId: string
  method: 'POST' | 'PUT'
  /** Relativno na TASK_MANAGER_API (`/TASK-1/reclaim` ili `/TASK-1`). */
  path: string
  body: Record<string, unknown>
  targetStatus: 'pending' | 'blocked'
  odluka: SiroceOdluka
}

/** Jedini put do promjene statusa. `null` = ništa se ne dira. */
export function planSiroce(d: SiroceOdluka): SiroceRadnja | null {
  if (d.presuda === 'vrati') {
    return {
      taskId: d.taskId, method: 'POST', path: `/${d.taskId}/reclaim`, targetStatus: 'pending', odluka: d,
      // isti ulaz kao ručni reclaim (TASK-2560); `reason` je obavezan i ide u audit trail
      body: { reason: `Siroče-oporavak (TASK-5140): ${d.razlog}`, by: 'siroce-oporavak' },
    }
  }
  if (d.presuda === 'blokiraj') {
    return {
      taskId: d.taskId, method: 'PUT', path: `/${d.taskId}`, targetStatus: 'blocked', odluka: d,
      body: {
        status: 'blocked',
        blockedReason: `Siroče-oporavak: ${d.razlog}`.slice(0, 500),
        progressNotes: [`♻️ Auto (siroče-oporavak): ${d.razlog}. Ručno vrati u obradu kad je uzrok riješen.`],
      },
    }
  }
  return null
}

export function jeRadnja(p: SirocePresuda): boolean {
  return p === 'vrati' || p === 'blokiraj'
}
