/**
 * DaemonSingleton.ts — cross-process singleton brava za RegocDaemon (TASK-4895).
 *
 * Nalaz TASK-4880 (16.09.2026.): dva RegocDaemona istovremeno — kanonski (keeper) i
 * ručni `bun RegocDaemon.ts` iz agentskog spawna. Provjera „već radi" postojala je samo
 * u grani `--daemon`, a keeper diže goli `bun RegocDaemon.ts`. Oba su vukla iz istog
 * execution_queue, pa je strop konkurentnosti bio zaobiđen (1 + 3 umjesto 1).
 *
 * A) flock(LOCK_EX|LOCK_NB) na `daemon.lock`. Jezgra bravu oslobađa smrću procesa, pa
 *    zaostala datoteka nakon kill -9 ne smeta: keeper odmah može dići novi daemon.
 *    Datoteka se NIKAD ne briše (brisanje + novo stvaranje = dva inodea = dvije brave).
 *    Uz to: živ PID iz `daemon.pid` čiji je cmdline RegocDaemon.ts → odbij (prijelaz:
 *    daemon pokrenut starim kodom ne drži flock). Provjera cmdlinea štiti od ponovne
 *    uporabe PID-a.
 *    Ako flock nije dostupan (nema libc preko bun:ffi), pada se na provjeru živosti
 *    PID-a zapisanog u bravi — slabije (utrka dvaju istovremenih startova), ali ne gore
 *    od stanja prije.
 * B) REGOC_TASK_ID u okolini = start iz agentskog spawna → odbij (pravilo 24): takav
 *    daemon umire sa spawnom i ostavlja djecu bez finalizatora.
 */
import { openSync, readFileSync, writeSync, ftruncateSync, existsSync } from 'fs'
import { cmdline, libc } from './lib/platforma'

export const SPAWN_ENV_EXIT_CODE = 4
const DAEMON_CMD_RE = /RegocDaemon\.ts/

const LOCK_EX = 2
const LOCK_NB = 4

type FlockFn = (fd: number, op: number) => number
let flockFn: FlockFn | null | undefined

function loadFlock(): FlockFn | null {
  if (flockFn !== undefined) return flockFn
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { dlopen, FFIType } = require('bun:ffi')
    const lib = dlopen(libc(), { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
    flockFn = (fd, op) => lib.symbols.flock(fd, op) as number
  } catch {
    flockFn = null
  }
  return flockFn
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}

/** Živ proces čiji cmdline pokreće RegocDaemon.ts (ne samo „neki živ PID"). */
export function isDaemonProcess(pid: number): boolean {
  if (!isAlive(pid)) return false
  const cmd = cmdline(pid)
  return cmd !== null && DAEMON_CMD_RE.test(cmd)
}

function readPidFrom(path: string): number | null {
  try {
    if (!existsSync(path)) return null
    const n = parseInt(readFileSync(path, 'utf-8').trim(), 10)
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** B) Odbijenica za start iz agentskog spawna; null kad start smije dalje. */
export function spawnEnvRefusal(env: Record<string, string | undefined> = process.env): string | null {
  const taskId = env.REGOC_TASK_ID
  if (!taskId) return null
  return [
    `⛔ RegocDaemon odbija start: pokrenut iz spawna agenta (REGOC_TASK_ID=${taskId}).`,
    '   Takav daemon umire sa spawnom i ostavlja djecu bez finalizatora (TASK-4880, pravilo 24).',
    '   Daemon diže daemon-keeper; isporuku u pogon zakaži odgođeno:',
    `     setsid nohup bash ~/.claude/regoc/tools/servisi/restart_kad_mirno.sh ${taskId} >/dev/null 2>&1 &`,
  ].join('\n')
}

export type SingletonResult =
  | { ok: true; mode: 'flock' | 'pid'; fd: number }
  | { ok: false; holderPid: number | null; message: string }

export interface SingletonOptions {
  lockPath: string
  /** Stari pidfile (daemon.pid) — za daemon pokrenut kodom bez brave. */
  pidFile?: string
  selfPid?: number
}

// Drži fd-ove žive do kraja procesa (zatvoren fd = otpuštena brava).
const heldFds: number[] = []

function refused(pid: number | null): SingletonResult {
  return {
    ok: false,
    holderPid: pid,
    message: `daemon već radi (PID ${pid ?? '?'}) — drugi primjerak izlazi i ne dira execution_queue`,
  }
}

/** A) Uzmi bravu. Uspjeh: brava ostaje držana dok proces živi. */
export function acquireDaemonSingleton(opts: SingletonOptions): SingletonResult {
  const self = opts.selfPid ?? process.pid

  if (opts.pidFile) {
    const legacy = readPidFrom(opts.pidFile)
    if (legacy && legacy !== self && isDaemonProcess(legacy)) return refused(legacy)
  }

  const fd = openSync(opts.lockPath, 'a+')
  const flock = loadFlock()
  let mode: 'flock' | 'pid' = 'flock'
  if (flock) {
    if (flock(fd, LOCK_EX | LOCK_NB) !== 0) return refused(readPidFrom(opts.lockPath))
  } else {
    mode = 'pid'
    const holder = readPidFrom(opts.lockPath)
    if (holder && holder !== self && isDaemonProcess(holder)) return refused(holder)
  }

  ftruncateSync(fd, 0)
  writeSync(fd, `${self}\n`, 0)
  heldFds.push(fd)
  return { ok: true, mode, fd }
}
