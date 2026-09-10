/**
 * Liveness — je li proces živ, i radi li išta (ADR-0001 O6).
 *
 * Živi orkestrator na dva mjesta čita `/proc` (nalazi L8/L9). To radi na Linuxu i nigdje
 * drugdje — a paket koji na macOS-u tiho proglašava svaki spawn mrtvim gori je od paketa
 * koji kaže da mjeru napretka nema. Zato dvije izvedbe iza istog porta:
 *
 *   ProcLiveness   — Linux: `/proc/<pid>/stat`, uz mjeru napretka (utime+stime).
 *   SignalLiveness — svugdje: `process.kill(pid, 0)` + starost datoteke otkucaja.
 *
 * Izbor je automatski (`existsSync('/proc')`), uz izričito `liveness.mode` u konfiguraciji.
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import type { LivenessProbe } from './Ports'

export class ProcLiveness implements LivenessProbe {
  ime = 'proc'

  alive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false
    return existsSync(`/proc/${pid}`)
  }

  /**
   * Zbroj korisničkog i sistemskog vremena (jiffies). Mijenja se dok proces radi, stoji
   * kad je zaglavljen — po tome se „živ" razlikuje od „napreduje".
   *
   * Ime programa u `stat` može sadržavati razmake i zagrade, pa se polja broje OD zadnje
   * zatvorene zagrade, ne razdvajanjem cijelog retka po razmaku.
   */
  progress(pid: number): number | null {
    try {
      const sadrzaj = readFileSync(`/proc/${pid}/stat`, 'utf-8')
      const iza = sadrzaj.slice(sadrzaj.lastIndexOf(')') + 2).split(' ')
      const utime = Number(iza[11])
      const stime = Number(iza[12])
      if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null
      return utime + stime
    } catch {
      return null
    }
  }
}

export class SignalLiveness implements LivenessProbe {
  ime = 'signal'
  private heartbeatDir: string | null
  private prozorMs: number

  constructor(heartbeatDir: string | null = null, prozorMs = 2 * 3600_000) {
    this.heartbeatDir = heartbeatDir
    this.prozorMs = prozorMs
  }

  /** `kill(pid, 0)` ne šalje signal — samo provjerava postoji li proces i smijemo li mu pisati. */
  alive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (e: any) {
      // EPERM = proces POSTOJI, ali je tuđi. To je i dalje živ proces.
      return e && e.code === 'EPERM'
    }
  }

  /**
   * Napredak se ovdje ne mjeri iz jezgre OS-a nego iz datoteke otkucaja koju piše sam
   * agent. Vraća starost u sekundama (manje = svježije) ili `null` ako otkucaja nema.
   */
  progress(pid: number): number | null {
    if (!this.heartbeatDir) return null
    try {
      const p = join(this.heartbeatDir, `${pid}.json`)
      const st = statSync(p)
      const starost = Date.now() - st.mtimeMs
      return starost > this.prozorMs ? null : Math.round(starost / 1000)
    } catch {
      return null
    }
  }
}

/** Izbor izvedbe: `auto` gleda postoji li `/proc`, ostalo je izričita odluka korisnika. */
export function odaberiLiveness(
  mode: 'auto' | 'proc' | 'signal',
  heartbeatDir: string | null = null,
): LivenessProbe {
  if (mode === 'proc') return new ProcLiveness()
  if (mode === 'signal') return new SignalLiveness(heartbeatDir)
  return existsSync('/proc') ? new ProcLiveness() : new SignalLiveness(heartbeatDir)
}
