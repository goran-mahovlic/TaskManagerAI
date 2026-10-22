#!/usr/bin/env bun
/**
 * KlaudioLiveness — JEDINI IZVOR ISTINE za pitanje "vrti li se Klaudio?".
 *
 * Kvar koji ovaj modul zatvara (TASK-3685, 03.09.2026.):
 *   RegocDaemon.isKlaudioRunning() je čitao ISKLJUČIVO watchdogov pid file
 *   (~/.tmp/regoc_pids/klaudio.pid), a telegram_agent.ts piše SVOJ
 *   (~/.tmp/telegram_agent.pid) i na njemu ima single-instance guard.
 *   Svaki start izvan watchdoga (regoc-services.sh, ručni restart, REGOČ sesija)
 *   ostavio bi watchdogov file zastarjelim → lažni "Klaudio is DOWN" → spawn
 *   duplikata → duplikat odmah padne na guardu ("already running (PID: …)") →
 *   "restart FAILED" → petlja svakih 60 s dok netko ne primijeti.
 *   Mjereno: 6 lažnih ciklusa 15:27–15:32 dok je PID 44974 cijelo vrijeme bio živ.
 *
 * Pravila:
 *   1. Agentov pid file je SSOT; watchdogov je samo predmemorija i sam se liječi.
 *   2. Živ PID se PROVJERAVA po cmdline-u — inače PID-reuse laže da Klaudio radi.
 *   3. Ako pid fileovi lažu, sken procesa (platforma) nađe živi proces i posvoji ga.
 *   4. Neuspjeli restart ide u backoff — ne 60-sekundni spam u logu.
 *
 * Autor: Jelena (Engineer) · 2026-09-03
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { cmdline, pidovi } from './lib/platforma'

const HOME = process.env.HOME || homedir()

/** Agentov vlastiti pid file — piše ga telegram_agent.ts (writePidFile), SSOT. */
export const KLAUDIO_AGENT_PID_FILE = join(HOME, '.tmp/telegram_agent.pid')
/** Watchdogov pid file — predmemorija RegocDaemona. */
export const KLAUDIO_WATCHDOG_PID_FILE = join(HOME, '.tmp/regoc_pids/klaudio.pid')

/** Potpis Klaudijevog procesa u cmdlineu (platforma.cmdline). */
export const KLAUDIO_CMDLINE_MARKER = 'telegram_agent.ts'

export interface LivenessDeps {
  readPidFile: (path: string) => number | null
  writePidFile: (path: string, pid: number) => void
  isAlive: (pid: number) => boolean
  cmdlineOf: (pid: number) => string | null
  scanPids: () => number[]
  /** TASK-4894: brisanje pid filea koji laže. Neobavezno — stari pozivatelji ga nemaju. */
  removePidFile?: (path: string) => void
}

export interface PidFilePaths {
  agentPidFile: string
  watchdogPidFile: string
}

export interface RestartState {
  consecutiveFailures: number
  lastAttemptMs: number
}

export const RESTART_BASE_BACKOFF_MS = 60_000
export const RESTART_MAX_BACKOFF_MS = 15 * 60_000

/**
 * Vraća PID živog Klaudija ili null. Usput izliječi watchdogov pid file.
 * null znači "stvarno je mrtav" — tek tada watchdog smije restartati.
 */
export function findKlaudioPid(deps: LivenessDeps, paths: PidFilePaths): number | null {
  const isKlaudio = (pid: number): boolean => isKlaudioProcess(pid, deps)

  // 1) Agentov pid file (SSOT), pa 2) watchdogov (predmemorija).
  for (const path of [paths.agentPidFile, paths.watchdogPidFile]) {
    const pid = deps.readPidFile(path)
    if (pid !== null && isKlaudio(pid)) {
      syncWatchdogPidFile(deps, paths, pid)
      return pid
    }
  }

  // 3) Oba fajla lažu — nađi proces skenom i posvoji ga.
  for (const pid of deps.scanPids()) {
    if (isKlaudio(pid)) {
      syncWatchdogPidFile(deps, paths, pid)
      return pid
    }
  }
  return null
}

function syncWatchdogPidFile(deps: LivenessDeps, paths: PidFilePaths, pid: number): void {
  if (deps.readPidFile(paths.watchdogPidFile) === pid) return
  try { deps.writePidFile(paths.watchdogPidFile, pid) } catch {}
}

/**
 * Backoff: nakon N uzastopnih neuspjelih restarta čekaj N×60 s (max 15 min).
 * Bez ovoga jedan trajni kvar puni daemon.log jednom porukom u minuti.
 */
export function shouldAttemptRestart(state: RestartState, nowMs: number): boolean {
  if (state.consecutiveFailures <= 0) return true
  const wait = Math.min(state.consecutiveFailures * RESTART_BASE_BACKOFF_MS, RESTART_MAX_BACKOFF_MS)
  return nowMs - state.lastAttemptMs >= wait
}

/**
 * JEDINO mjesto na kojem piše što znači „ovaj PID je Klaudio" (TASK-4894).
 *
 * Do pada 16.09.2026. pravilo je živjelo u DVIJE preslike: ovdje (s provjerom cmdline-a,
 * TASK-3685) i u `telegram_agent.ts.getPid()` (samo `kill(pid,0)`). Popravljena je bila
 * samo watchdogova preslika, pa je agentov vlastiti single-instance guard i dalje
 * nasjedao na reciklirani PID. Mjereno: PID 2703 pripao je Klaudiju 15.09. u 10:27:45,
 * poslije restarta kontejnera istim brojem se javio AgentDaemon, a Klaudio je 5 puta
 * izašao s exit 1 uz „already running". Zato je pravilo sada OVDJE, a `telegram_agent.ts`
 * ga uvozi umjesto da ga prepisuje.
 *
 * `cmdline === null` (cmdline nedostupan) namjerno ostaje fail-open: bez cmdlinea je `kill(pid,0)`
 * sve što imamo, a strože ponašanje bi na takvom sustavu ubilo živog Klaudija.
 */
export function isKlaudioProcess(pid: number, deps: LivenessDeps = realDeps): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (!deps.isAlive(pid)) return false
  const cmd = deps.cmdlineOf(pid)
  return cmd === null ? true : cmd.includes(KLAUDIO_CMDLINE_MARKER)
}

/**
 * Obriši pid fileove koji NE pokazuju na živog Klaudija; vrati popis obrisanih.
 *
 * Watchdog ovo mora pozvati prije restarta. U padu 16.09. watchdog je 5 puta pokrenuo
 * `bun telegram_agent.ts`, a svaki put je dijete izašlo s exit 1 jer je na disku ostao
 * pid file s tuđim (recikliranim) PID-om — laž koju nitko nije uklanjao, pa se restart
 * NIKAD nije mogao dovršiti sam od sebe. Poziv je siguran: file živog Klaudija se ne dira.
 */
export function clearStaleKlaudioPidFiles(deps: LivenessDeps, paths: PidFilePaths): string[] {
  const obrisani: string[] = []
  const remove = deps.removePidFile
  if (!remove) return obrisani
  for (const path of [paths.agentPidFile, paths.watchdogPidFile]) {
    const pid = deps.readPidFile(path)
    if (pid === null) continue
    if (isKlaudioProcess(pid, deps)) continue
    try { remove(path); obrisani.push(path) } catch {}
  }
  return obrisani
}

// ============================================
// Produkcijske ovisnosti (stvarni procesi kroz platformni sloj i disk)
// ============================================

export const realDeps: LivenessDeps = {
  readPidFile(path: string): number | null {
    try {
      if (!existsSync(path)) return null
      const pid = parseInt(readFileSync(path, 'utf-8').trim(), 10)
      return Number.isNaN(pid) ? null : pid
    } catch { return null }
  },
  writePidFile(path: string, pid: number): void {
    writeFileSync(path, String(pid))
  },
  removePidFile(path: string): void {
    try { if (existsSync(path)) unlinkSync(path) } catch {}
  },
  isAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true } catch { return false }
  },
  cmdlineOf(pid: number): string | null {
    return cmdline(pid)
  },
  scanPids(): number[] {
    return pidovi()
  },
}

/** Praktični omotač za RegocDaemon: koristi stvarne putanje i stvarne procese (platforma). */
export function isKlaudioAlive(): boolean {
  return findKlaudioPid(realDeps, {
    agentPidFile: KLAUDIO_AGENT_PID_FILE,
    watchdogPidFile: KLAUDIO_WATCHDOG_PID_FILE,
  }) !== null
}

/** Omotač za RegocDaemon: očisti lažne pid fileove na stvarnom disku. */
export function clearStaleKlaudioPidFilesReal(): string[] {
  return clearStaleKlaudioPidFiles(realDeps, {
    agentPidFile: KLAUDIO_AGENT_PID_FILE,
    watchdogPidFile: KLAUDIO_WATCHDOG_PID_FILE,
  })
}
