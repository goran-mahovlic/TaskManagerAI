#!/usr/bin/env bun
/**
 * ShutdownResume — M4 „uredno gašenje: spawnovi se ne ubijaju restartom" (TASK-4627).
 *
 * PROBLEM (docs/ISTRAZIVANJE-neuspjesi-i-greske.md §4 M4): od 52 neuspjeha izvan incidenta
 * njih 13 nosi izlazni kod 143/137 — dakle SIGTERM/SIGKILL, naš restart, ne model. D3/TASK-2955
 * je te smrti barem prestao skrivati (svaki spawn od tada prolazi kroz `killAgentSpawn` s
 * razlogom), ali je zadatak i dalje završavao u `cancelled`. `cancelled` je TERMINALNO stanje:
 * posao je time izgubljen i vraća ga samo čovjek. Restart daemona je time postao operacija
 * koja košta onoliko koliko je posla u letu.
 *
 * RJEŠENJE: prije nego se spawnovima pošalje SIGTERM, njihovi zadaci se vrate u `pending` s
 * oznakom `resume:<n>`. Sljedeći prolaz daemona ih pokupi iz reda i posao se nastavi umjesto
 * da se izgubi. Oznaka je ista ona koju koristi automatski nastavak (T2/TASK-3084) — brojač
 * krugova je zajednički, jer je pitanje isto: „koliko je puta ovaj zadatak već nastavljan".
 *
 * ZAŠTO ODVOJEN ULAZ ZA VRAĆANJE: `in_progress -> pending` NAMJERNO nije u
 * `ValidStatusTransitions` (agent ne smije unatrag kroz obični PUT) — ide se kroz
 * `POST /api/tasks/:id/reclaim`, isto kao stale-watchdog. Obični PUT bi vratio 409.
 *
 * UGOVOR (pribijen u tests/shutdown-resume.test.ts):
 *   1. oznaka se upisuje PRIJE vraćanja u red. Ako upis oznake padne, zadatak se NE vraća —
 *      nastavak bez brojača bi restart pretvorio u vječnu petlju, a vidljivo otkazan zadatak
 *      je manja šteta od nebrojivog;
 *   2. strop krugova (`SHUTDOWN_RESUME_MAX_ROUNDS`) — iscrpljen zadatak ide starim putem;
 *   3. dira se SAMO zadatak koji je stvarno `in_progress`;
 *   4. nijedna iznimka ne smije zaglaviti gašenje — svaki zadatak ima vlastiti try/catch,
 *      a pozivatelj cijelu radnju drži pod rokom;
 *   5. shadow (`live=false`) bilježi odluku i ne dira ništa.
 *
 * Sve nuspojave (mreža, disk, dnevnik) ulaze kroz `deps` → testira se bez daemona.
 */

import { appendFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()

/**
 * Strop nastavaka. Isti zadani broj kao `REGOC_AUTO_RESUME_ROUNDS` (T2/TASK-3084) jer se
 * dijeli ista oznaka `resume:<n>` — dva mehanizma, jedan brojač, jedan strop.
 */
export const SHUTDOWN_RESUME_MAX_ROUNDS = Number(
  process.env.REGOC_SHUTDOWN_RESUME_ROUNDS || process.env.REGOC_AUTO_RESUME_ROUNDS || 3
)

/** Dnevnik odluka — ulaz za mjerenje kriterija „nijedan zadatak ne ostaje bez nastavka". */
export function shutdownResumeLogFile(): string {
  return process.env.REGOC_SHUTDOWN_RESUME_LOG || join(HOME, '.claude/regoc/data/shutdown_resume.jsonl')
}

const RESUME_TAG = /^resume:(\d+)$/

/** Koliko je krugova nastavka zadatak već potrošio (0 = nijedan). */
export function resumeRound(tags: unknown): number {
  const list = Array.isArray(tags) ? tags.map(t => String(t)) : []
  let n = 0
  for (const t of list) {
    const m = RESUME_TAG.exec(t)
    if (m) n = Math.max(n, Number(m[1]))
  }
  return n
}

/** Oznake zadatka s postavljenim krugom `round` — stara oznaka se ZAMJENJUJE, ne gomila. */
export function withResumeTag(tags: unknown, round: number): string[] {
  const list = Array.isArray(tags) ? tags.map(t => String(t)) : []
  const out: string[] = []
  for (const t of list) {
    if (RESUME_TAG.test(t)) continue
    if (!out.includes(t)) out.push(t)
  }
  out.push(`resume:${round}`)
  return out
}

// ============================================
// Odluka (čista funkcija)
// ============================================

export type ShutdownResumeVerdict = 'resume' | 'exhausted' | 'no-task'

export interface ShutdownSpawnRef {
  agent: string
  taskId?: string | null
  pid?: number
}

export interface ShutdownResumeDecision {
  agent: string
  taskId: string | null
  round: number
  verdict: ShutdownResumeVerdict
  reason: string
}

export interface PlanOptions {
  /** Oznake po zadatku (dohvaćene prije odluke). Nepoznat zadatak = bez oznaka. */
  tagsByTask?: Record<string, unknown>
  maxRounds?: number
}

/**
 * Odluka za svaki spawn. Zadatak koji nosi dva spawna dobiva JEDNU odluku o nastavku —
 * inače bi drugi prolaz brojač podigao dvaput za isti restart.
 */
export function planShutdownResume(spawns: ShutdownSpawnRef[], opts: PlanOptions = {}): ShutdownResumeDecision[] {
  const maxRounds = opts.maxRounds ?? SHUTDOWN_RESUME_MAX_ROUNDS
  const tagsByTask = opts.tagsByTask || {}
  const seen = new Set<string>()
  const out: ShutdownResumeDecision[] = []

  for (const s of spawns) {
    const taskId = s.taskId ? String(s.taskId) : null
    if (!taskId) {
      out.push({ agent: s.agent, taskId: null, round: 0, verdict: 'no-task', reason: 'spawn nema zadatak' })
      continue
    }
    if (seen.has(taskId)) continue
    seen.add(taskId)

    const round = resumeRound(tagsByTask[taskId])
    if (round >= maxRounds) {
      out.push({
        agent: s.agent, taskId, round, verdict: 'exhausted',
        reason: `iskorišteno ${round}/${maxRounds} krugova nastavka — dalje traži čovjeka`,
      })
      continue
    }
    out.push({
      agent: s.agent, taskId, round: round + 1, verdict: 'resume',
      reason: `vraćam u red, krug ${round + 1}/${maxRounds}`,
    })
  }
  return out
}

// ============================================
// Provedba (nuspojave kroz deps)
// ============================================

export interface ShutdownResumeEvent {
  ts: string
  taskId: string | null
  agent: string
  verdict: ShutdownResumeVerdict | 'failed' | 'not-in-progress'
  round: number
  live: boolean
  reason: string
}

export interface ShutdownResumeDeps {
  /** Dohvat zadatka (status + oznake). `null` = nema ga / API ne odgovara. */
  getTask(taskId: string): Promise<{ status?: string; tags?: unknown } | null>
  /** PUT oznaka (+ bilješka). `false` = nije spremljeno. */
  setTags(taskId: string, tags: string[], note: string): Promise<boolean>
  /** POST /api/tasks/:id/reclaim — jedini dopušten put `in_progress -> pending`. */
  reclaim(taskId: string, reason: string): Promise<boolean>
  /** Zapis odluke u JSONL (pravilo: nijedna promjena statusa bez traga). */
  record(event: ShutdownResumeEvent): void
  log(msg: string): void
}

export interface ShutdownResumeReport {
  /** Zadaci vraćeni u `pending` s oznakom — pozivatelj ih NE smije otkazati. */
  resumed: string[]
  /** Potrošili strop krugova — idu starim putem (`cancelled`). */
  exhausted: string[]
  /** Nešto je puklo — idu starim putem, da ne ostanu u zraku. */
  failed: string[]
  /** Nisu bili `in_progress` (netko ih je već zatvorio) — ne diramo ih. */
  skipped: string[]
}

export interface MarkOptions {
  reason: string
  live: boolean
  maxRounds?: number
}

/**
 * Označi aktivne spawnove i vrati njihove zadatke u red. Vraća izvještaj po zadatku;
 * pozivatelj za sve što NIJE `resumed` zadržava staro ponašanje (otkazivanje), jer je
 * vidljivo otkazan zadatak i dalje bolji od zadatka zaglavljenog u `in_progress`.
 */
export async function markSpawnsForResume(
  spawns: ShutdownSpawnRef[],
  opts: MarkOptions,
  deps: ShutdownResumeDeps,
): Promise<ShutdownResumeReport> {
  const report: ShutdownResumeReport = { resumed: [], exhausted: [], failed: [], skipped: [] }
  if (!spawns.length) return report

  const maxRounds = opts.maxRounds ?? SHUTDOWN_RESUME_MAX_ROUNDS
  const ts = () => new Date().toISOString()

  // Zadatak koji nosi dva spawna obrađujemo jednom (brojač se ne smije podići dvaput).
  const ids: string[] = []
  const agentOf: Record<string, string> = {}
  for (const s of spawns) {
    if (!s.taskId) continue
    const id = String(s.taskId)
    if (!ids.includes(id)) { ids.push(id); agentOf[id] = s.agent }
  }

  for (const taskId of ids) {
    const agent = agentOf[taskId]
    try {
      const task = await deps.getTask(taskId)
      if (!task) {
        report.failed.push(taskId)
        deps.record({ ts: ts(), taskId, agent, verdict: 'failed', round: 0, live: opts.live, reason: 'zadatak nedostupan (API)' })
        deps.log(`  ⚠️ [gašenje→nastavak] ${taskId}: zadatak nedostupan — ide starim putem`)
        continue
      }
      if (task.status !== 'in_progress') {
        report.skipped.push(taskId)
        deps.record({ ts: ts(), taskId, agent, verdict: 'not-in-progress', round: 0, live: opts.live, reason: `status je '${task.status}'` })
        continue
      }

      const [d] = planShutdownResume([{ agent, taskId }], { tagsByTask: { [taskId]: task.tags }, maxRounds })
      deps.record({ ts: ts(), taskId, agent, verdict: d.verdict, round: d.round, live: opts.live, reason: d.reason })

      if (d.verdict !== 'resume') {
        report.exhausted.push(taskId)
        deps.log(`  🛑 [gašenje→nastavak] ${taskId}: ${d.reason}`)
        continue
      }

      deps.log(`${opts.live ? '  ↻ [gašenje→nastavak]' : '  👁️ [gašenje→nastavak SHADOW]'} ${taskId} (${agent}): ${d.reason}`)
      if (!opts.live) continue

      // REDOSLIJED JE UGOVOR: prvo brojač, pa vraćanje u red. Nastavak bez upisanog
      // brojača ne bi imao kraja, a `reclaim` se poslije više ne može poništiti.
      const note = `↻ Nastavak nakon urednog gašenja (krug ${d.round}/${maxRounds}): ${opts.reason}. `
        + `Prethodni prolaz je prekinut NAŠIM restartom, ne kvarom — zadatak se vraća u red i sljedeći prolaz nastavlja od zatečenog stanja na disku.`
      const tagged = await deps.setTags(taskId, withResumeTag(task.tags, d.round), note)
      if (!tagged) {
        report.failed.push(taskId)
        deps.record({ ts: ts(), taskId, agent, verdict: 'failed', round: d.round, live: opts.live, reason: 'upis oznake resume nije prošao' })
        deps.log(`  ⚠️ [gašenje→nastavak] ${taskId}: oznaka nije upisana — NE vraćam u red (ide starim putem)`)
        continue
      }

      const ok = await deps.reclaim(taskId, `uredno gašenje: ${opts.reason} (krug ${d.round}/${maxRounds})`)
      if (!ok) {
        report.failed.push(taskId)
        deps.record({ ts: ts(), taskId, agent, verdict: 'failed', round: d.round, live: opts.live, reason: 'reclaim nije prošao' })
        deps.log(`  ⚠️ [gašenje→nastavak] ${taskId}: reclaim nije prošao — ide starim putem`)
        continue
      }
      report.resumed.push(taskId)
    } catch (e) {
      report.failed.push(taskId)
      try {
        deps.record({ ts: ts(), taskId, agent, verdict: 'failed', round: 0, live: opts.live, reason: String(e) })
        deps.log(`  ⚠️ [gašenje→nastavak] ${taskId}: ${e}`)
      } catch { /* dnevnik ne smije srušiti gašenje */ }
    }
  }
  return report
}

/** Zadani zapisivač u JSONL (daemon ga preda kao `deps.record`). */
export function recordShutdownResume(event: ShutdownResumeEvent): void {
  try {
    const f = shutdownResumeLogFile()
    mkdirSync(dirname(f), { recursive: true })
    appendFileSync(f, JSON.stringify(event) + '\n')
  } catch { /* dnevnik nikad ne ruši gašenje */ }
}
