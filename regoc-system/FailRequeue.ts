#!/usr/bin/env bun
/**
 * FailRequeue — R7 „kraj tihih odustajanja" (TASK-2563, PRJ-030).
 *
 * PROBLEM (JELENA_REGOC_ANALIZA.md §4 R7): kad spawn agenta završi s exit≠0, zadatak je
 * ispadao iz igre bez traga za korisnika. Mjereno 05.09.2026. na regoc.db + messages.db:
 *   • 10 zadataka otkazano iz `killAgentSpawn` (razlog „Prekinuto (…)") — svih 10 IMA poruku;
 *   • 3 zadatka parkirana u `blocked` s razlogom „Spawn prekinut…" — 0 od 3 ima poruku koja
 *     spominje ID zadatka. Poruka koja se šalje glasi samo „❌ Agent X neuspješan (exit 1)",
 *     pa korisnik vidi DA je nešto palo, ali ne i KOJI je zadatak time pokopan.
 * Uz to je `blocked` mjereno groblje (87 zadataka bez razloga, medijan 8,3 dana) — zadatak
 * se odande ne vraća sam.
 *
 * RJEŠENJE: neuspio spawn vraća zadatak u `pending` s oznakom `pokusaj:<n>` (sljedeći prolaz
 * auto-exec-a ga pokupi) i šalje JEDNU poruku korisniku koja NOSI ID zadatka. Kad se strop
 * pokušaja iscrpi, zadatak ide starim putem (`blocked` = traži čovjeka) — ali i tada s
 * porukom, jer je „tiho" ono što se popravlja, ne „blokirano".
 *
 * ZAŠTO ODVOJEN BROJAČ (`pokusaj:` a ne `resume:`): `resume:<n>` broji NASTAVKE nakon urednog
 * gašenja (M4/TASK-4627) — tamo zadatak nije pao, prekinuo ga je naš restart. Ovdje se broje
 * KVAROVI. Kad bi dijelili brojač, jedan restart daemona bi trošio kredit neuspjeha (i obratno),
 * pa bi zadatak koji je samo dvaput preživio restart ostao bez ijednog pokušaja popravka.
 *
 * ZAŠTO `reclaim`: `in_progress -> pending` NAMJERNO nije u `ValidStatusTransitions` — obični
 * PUT vraća 409. Jedini legalan put je `POST /api/tasks/:id/reclaim` (isto kao stale-watchdog
 * i M4 gašenje).
 *
 * UGOVOR (pribijen u tests/fail-requeue.test.ts):
 *   1. oznaka se upisuje PRIJE `reclaim`-a; ako upis padne, zadatak se NE vraća u red;
 *   2. strop pokušaja (`FAIL_REQUEUE_MAX_ATTEMPTS`) — iscrpljen zadatak ide starim putem;
 *   3. dira se SAMO zadatak koji je stvarno `in_progress`;
 *   4. svako odustajanje ima TOČNO JEDNU poruku korisniku i ta poruka sadrži ID zadatka;
 *   5. shadow (`live=false`) samo zapisuje odluku — ne mijenja status i ne šalje poruku;
 *   6. nijedna iznimka ne smije pobjeći: ovo je fail-putanja spawna, ondje se ne ruši.
 *
 * Sve nuspojave (mreža, disk, dnevnik) ulaze kroz `deps` → testira se bez daemona.
 */

import { appendFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()

/** Strop pokušaja po zadatku. Iznad njega zadatak traži čovjeka (stari put: `blocked`). */
export const FAIL_REQUEUE_MAX_ATTEMPTS = Number(process.env.REGOC_FAIL_REQUEUE_ATTEMPTS || 3)

/** Dnevnik odluka — ulaz za mjerenje kriterija „0 tihih odustajanja". */
export function failRequeueLogFile(): string {
  return process.env.REGOC_FAIL_REQUEUE_LOG || join(HOME, '.claude/regoc/data/fail_requeue.jsonl')
}

const ATTEMPT_TAG = /^pokusaj:(\d+)$/

/** Koliko je pokušaja zadatak već potrošio (0 = nijedan). */
export function attemptRound(tags: unknown): number {
  const list = Array.isArray(tags) ? tags.map(t => String(t)) : []
  let n = 0
  for (const t of list) {
    const m = ATTEMPT_TAG.exec(t)
    if (m) n = Math.max(n, Number(m[1]))
  }
  return n
}

/** Oznake zadatka s postavljenim pokušajem `n` — stara oznaka se ZAMJENJUJE, ne gomila. */
export function withAttemptTag(tags: unknown, n: number): string[] {
  const list = Array.isArray(tags) ? tags.map(t => String(t)) : []
  const out: string[] = []
  for (const t of list) {
    if (ATTEMPT_TAG.test(t)) continue
    if (!out.includes(t)) out.push(t)
  }
  out.push(`pokusaj:${n}`)
  return out
}

// ============================================
// Odluka (čista funkcija)
// ============================================

export type FailRequeueVerdict = 'requeue' | 'exhausted' | 'no-task' | 'not-in-progress' | 'failed'

export interface FailRequeueInput {
  agent: string
  taskId?: string | null
  status?: string
  tags?: unknown
  maxAttempts?: number
}

export interface FailRequeueDecision {
  agent: string
  taskId: string | null
  attempt: number
  verdict: FailRequeueVerdict
  reason: string
}

export function planFailRequeue(input: FailRequeueInput): FailRequeueDecision {
  const maxAttempts = input.maxAttempts ?? FAIL_REQUEUE_MAX_ATTEMPTS
  const taskId = input.taskId ? String(input.taskId) : null
  if (!taskId) {
    return { agent: input.agent, taskId: null, attempt: 0, verdict: 'no-task', reason: 'spawn nema zadatak' }
  }
  if (input.status !== 'in_progress') {
    return {
      agent: input.agent, taskId, attempt: 0, verdict: 'not-in-progress',
      reason: `status je '${input.status}' — netko ga je već zatvorio, ne diram`,
    }
  }
  const done = attemptRound(input.tags)
  if (done >= maxAttempts) {
    return {
      agent: input.agent, taskId, attempt: done, verdict: 'exhausted',
      reason: `iskorišteno ${done}/${maxAttempts} pokušaja — dalje traži čovjeka`,
    }
  }
  return {
    agent: input.agent, taskId, attempt: done + 1, verdict: 'requeue',
    reason: `vraćam u red, pokušaj ${done + 1}/${maxAttempts}`,
  }
}

// ============================================
// Poruka korisniku (R1 kanal)
// ============================================

/** Tekst iz R7: „TASK-X vraćen u red nakon Y pokušaja — razlog Z". */
export function requeueUserMessage(taskId: string, attempt: number, maxAttempts: number, cause: string): string {
  return `↻ **${taskId}** vraćen u red nakon ${attempt} pokušaja — razlog: ${cause}. `
    + `Sljedeći prolaz ga pokušava ponovno (strop ${maxAttempts}).`
}

/** Iscrpljen strop: i dalje JEDNA poruka, i dalje s ID-em — samo bez obećanja nastavka. */
export function exhaustedUserMessage(taskId: string, attempt: number, maxAttempts: number, cause: string): string {
  return `🛑 **${taskId}** NIJE vraćen u red — iskorišteno ${attempt}/${maxAttempts} pokušaja. `
    + `Zadnji razlog: ${cause}. Zadatak čeka čovjeka (blocked → pending kad se ukloni uzrok).`
}

// ============================================
// Provedba (nuspojave kroz deps)
// ============================================

export interface FailRequeueEvent {
  ts: string
  taskId: string | null
  agent: string
  verdict: FailRequeueVerdict
  attempt: number
  live: boolean
  exitCode: number | null
  reason: string
}

export interface FailRequeueDeps {
  /** Dohvat zadatka (status + oznake). `null` = nema ga / API ne odgovara. */
  getTask(taskId: string): Promise<{ status?: string; tags?: unknown } | null>
  /** PUT oznaka (+ bilješka). `false` = nije spremljeno. */
  setTags(taskId: string, tags: string[], note: string): Promise<boolean>
  /** POST /api/tasks/:id/reclaim — jedini dopušten put `in_progress -> pending`. */
  reclaim(taskId: string, reason: string): Promise<boolean>
  /** Zapis odluke u JSONL (pravilo: nijedna promjena statusa bez traga). */
  record(event: FailRequeueEvent): void
  log(msg: string): void
}

export interface FailRequeueFacts {
  agent: string
  agentName: string
  taskId: string | null
  exitCode: number | null
  /** Ljudski razlog iz `classifySpawnExit` (npr. „proces pao (exit 1)"). */
  cause: string
}

export interface FailRequeueOptions {
  live: boolean
  maxAttempts?: number
}

export interface FailRequeueResult {
  verdict: FailRequeueVerdict
  attempt: number
  /**
   * `true` = MI smo postavili status zadatka (pending). Pozivatelj tada NE smije
   * pisati stari `blocked` — inače bi odmah poništio vraćanje u red.
   */
  handled: boolean
  /** Poruka za korisnika (R1 kanal) ili `null` = pozivatelj šalje staru poruku. */
  userMessage: string | null
}

/**
 * Neuspio spawn → vraćanje zadatka u red (ili vidljivo odustajanje).
 *
 * Nikad ne baca: pozivatelj je `catch`-blok spawn-handlera i mora ostati na nogama.
 */
export async function requeueFailedTask(
  facts: FailRequeueFacts,
  opts: FailRequeueOptions,
  deps: FailRequeueDeps,
): Promise<FailRequeueResult> {
  const maxAttempts = opts.maxAttempts ?? FAIL_REQUEUE_MAX_ATTEMPTS
  const stari = (verdict: FailRequeueVerdict, attempt = 0, userMessage: string | null = null): FailRequeueResult =>
    ({ verdict, attempt, handled: false, userMessage })
  const ts = () => new Date().toISOString()

  const taskId = facts.taskId ? String(facts.taskId) : null
  if (!taskId) return stari('no-task')

  try {
    const task = await deps.getTask(taskId)
    if (!task) {
      deps.record({ ts: ts(), taskId, agent: facts.agent, verdict: 'failed', attempt: 0, live: opts.live, exitCode: facts.exitCode, reason: 'zadatak nedostupan (API)' })
      deps.log(`  ⚠️ [neuspjeh→red] ${taskId}: zadatak nedostupan — ide starim putem`)
      return stari('failed')
    }

    const d = planFailRequeue({ agent: facts.agent, taskId, status: task.status, tags: task.tags, maxAttempts })
    deps.record({ ts: ts(), taskId, agent: facts.agent, verdict: d.verdict, attempt: d.attempt, live: opts.live, exitCode: facts.exitCode, reason: d.reason })

    if (d.verdict === 'not-in-progress') {
      deps.log(`  ⏭️ [neuspjeh→red] ${taskId}: ${d.reason}`)
      return stari('not-in-progress')
    }
    if (d.verdict === 'exhausted') {
      deps.log(`  🛑 [neuspjeh→red] ${taskId}: ${d.reason}`)
      // Stari put (blocked) OSTAJE, ali odustajanje više nije tiho.
      return stari('exhausted', d.attempt,
        opts.live ? exhaustedUserMessage(taskId, d.attempt, maxAttempts, facts.cause) : null)
    }

    deps.log(`${opts.live ? '  ↻ [neuspjeh→red]' : '  👁️ [neuspjeh→red SHADOW]'} ${taskId} (${facts.agent}): ${d.reason}`)
    if (!opts.live) return stari('requeue', d.attempt)

    // REDOSLIJED JE UGOVOR: prvo brojač, pa vraćanje u red. Vraćanje bez upisanog
    // brojača nema kraja, a `reclaim` se poslije ne može poništiti.
    const note = `↻ Neuspjeh agenta ${facts.agentName} (exit ${facts.exitCode ?? '?'}) — ${facts.cause}. `
      + `Zadatak se vraća u red (pokušaj ${d.attempt}/${maxAttempts}) umjesto da ostane blokiran; `
      + `sljedeći prolaz auto-exec-a ga pokušava ponovno.`
    const tagged = await deps.setTags(taskId, withAttemptTag(task.tags, d.attempt), note)
    if (!tagged) {
      deps.record({ ts: ts(), taskId, agent: facts.agent, verdict: 'failed', attempt: d.attempt, live: opts.live, exitCode: facts.exitCode, reason: 'upis oznake pokusaj nije prošao' })
      deps.log(`  ⚠️ [neuspjeh→red] ${taskId}: oznaka nije upisana — NE vraćam u red (ide starim putem)`)
      return stari('failed', d.attempt)
    }

    const ok = await deps.reclaim(taskId, `neuspjeh agenta: ${facts.cause} (pokušaj ${d.attempt}/${maxAttempts})`)
    if (!ok) {
      deps.record({ ts: ts(), taskId, agent: facts.agent, verdict: 'failed', attempt: d.attempt, live: opts.live, exitCode: facts.exitCode, reason: 'reclaim nije prošao' })
      deps.log(`  ⚠️ [neuspjeh→red] ${taskId}: reclaim nije prošao — ide starim putem`)
      return stari('failed', d.attempt)
    }

    return {
      verdict: 'requeue', attempt: d.attempt, handled: true,
      userMessage: requeueUserMessage(taskId, d.attempt, maxAttempts, facts.cause),
    }
  } catch (e) {
    try {
      deps.record({ ts: ts(), taskId, agent: facts.agent, verdict: 'failed', attempt: 0, live: opts.live, exitCode: facts.exitCode, reason: String(e) })
      deps.log(`  ⚠️ [neuspjeh→red] ${taskId}: ${e} — ide starim putem`)
    } catch { /* dnevnik ne smije srušiti fail-putanju */ }
    return stari('failed')
  }
}

/** Zadani zapisivač u JSONL (daemon ga preda kao `deps.record`). */
export function recordFailRequeue(event: FailRequeueEvent): void {
  try {
    const f = failRequeueLogFile()
    mkdirSync(dirname(f), { recursive: true })
    appendFileSync(f, JSON.stringify(event) + '\n')
  } catch { /* dnevnik nikad ne ruši fail-putanju */ }
}
