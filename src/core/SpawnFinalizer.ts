// src/core/SpawnFinalizer.ts
//
// ZAVRŠETAK SPAWNA NA JEDNOM MJESTU (ADR-0012, opcija B — implementacija TASK-4827).
//
// ZAŠTO POSTOJI
//   Pod (B) agent više ne zatvara vlastiti zadatak; zatvara ga daemon nakon suda
//   kritičara. Daemona ima DVA (`RegocDaemon` = spawn na zahtjev, `AgentDaemon` =
//   durabilni tim, 4 živa procesa). Ako svaki dobije svoj zatvarač, obećanje
//   „✅ tek nakon kritičara" vrijedi samo na jednom putu — a `AgentDaemon` danas
//   nema NIJEDAN PUT ni ijedan poziv kritičara (ADR-0012 §3.1, §20).
//   Zato je pipeline ovdje, a oba daemona ga zovu (mjera A iz §20).
//
// PIPELINE (redoslijed je dio ugovora):
//   1. `CompletionGuard.evaluateCompletion` — sud o TEKSTU izvještaja (i agentova
//      vlastita `REGOC-STATUS:` deklaracija, koja je pod (B) njegov JEDINI kanal).
//   2. `CriticGate.critiqueSpawnAsync` — netko drugi POKREĆE provjere nad onim što je
//      ostalo na disku. Uvoz `CriticGate` ovdje je i invarijanta iz
//      `tests/critic-coverage.test.ts` (M2): tko zatvara, mora suditi.
//   3. PRED-PROVJERA VRATARA (§12) — `ResearchRagGate`/`GitCommitGate` na API-ju vraćaju
//      HTTP 400. Dosad je taj 400 dobivao AGENT i popravljao ga (mjereno: TASK-4595
//      REJECT → dopuna → ACCEPT). Pod (B) daemon je jedini pozivatelj i nema petlju
//      popravka → zadatak bi ostao `in_progress` ZAUVIJEK. Zato daemon isti sud donosi
//      SAM i zatvara u `blocked` (prijelaz `in_progress → blocked` ne prolazi vratare).
//   4. `TaskCloser.pustiNajam` PA `zatvoriZadatak` — najam se pušta PRIJE zapisa, inače
//      daemon udari u vlastiti `spawnCloseGuard`.
//
// NAČELO: nijedan korak ne baca. Kvar u sudu ne smije spriječiti zapis ishoda —
// zadatak bez zapisa je zombi, a zombi je gori od pogrešnog suda jer nema signal.

import { critiqueSpawnAsync, type CritiqueInput } from './CriticGate'
import { evaluateCompletion, shouldEnforce, formatVerdictLog, type CompletionVerdict } from './CompletionGuard'
import {
  evaluateResearchClosure, shouldEnforceResearch, loadResearchGateConfig, formatResearchLog,
} from './ResearchRagGate'
import {
  evaluateCommitClosure, shouldEnforceCommit, loadGitCommitGateConfig, findTaskCommits, formatCommitLog,
} from './GitCommitGate'
import { zatvoriZadatak, pustiNajam, type ZatvaranjeIshod } from './TaskCloser'
import { isEnabled } from './FeatureFlags'

export type Zapisivac = (poruka: string) => void

// ─── TERMINALAN SKUP (G2/§13) ────────────────────────────────────────────────
// Guard ne čuva „completed" nego TERMINALNO STANJE. `cancelled` je jednako terminalan
// (`ValidStatusTransitions['cancelled'] = []`), a `in_progress → cancelled` je dopušten:
// agent koji pošalje `cancelled` zaključa ploču jednako kao sa `completed`. Skup se
// IZVODI iz tablice prijelaza — prepisan popis bi se razišao s njom pri prvoj izmjeni.

export const SVI_STATUSI = ['pending', 'in_progress', 'blocked', 'completed', 'cancelled'] as const

export function terminalniStatusi(
  prijelazi: (status: string) => string[],
  svi: readonly string[] = SVI_STATUSI,
): Set<string> {
  // Ponovno otvaranje (`completed → pending`, `cancelled → pending`) NE čini stanje
  // neterminalnim: povratak u red nije napredak rada. Da se broji samo prazan popis
  // prijelaza, skup bi nakon uvođenja ponovnog otvaranja bio PRAZAN i guard bi utihnuo
  // bez ijedne greške (izmjereno u živoj instalaciji: zadnji sud sjene dan prije izmjene).
  const skup = new Set<string>()
  for (const s of svi) {
    if (s === 'pending') continue
    try {
      if ((prijelazi(s) ?? []).every((cilj) => cilj === 'pending')) skup.add(s)
    } catch { /* nepoznat status nije terminalan */ }
  }
  return skup
}

export function jeTerminalan(status: string, prijelazi: (status: string) => string[]): boolean {
  return terminalniStatusi(prijelazi).has(status)
}

// ─── PRED-PROVJERA VRATARA (§12) ─────────────────────────────────────────────

export interface VratarSud {
  ok: boolean
  /** `ok` | kod vratara (`missing_doc_id`, `no_commit`, …). */
  code: string
  /** Gotov tekst za `blocked_reason` kad `ok === false`. */
  razlog: string
}

export interface VratarUlaz {
  taskId: string
  tags: string[] | null | undefined
  projectId: string | null | undefined
  resultText: string
  log?: Zapisivac
  /** Ubrizgavanje radi testa (inače `findTaskCommits`). */
  gitDokazFn?: (taskId: string, cfg: ReturnType<typeof loadGitCommitGateConfig>) => ReturnType<typeof findTaskCommits>
}

/**
 * Donosi ISTI sud koji bi TaskWebUI donio na PUT-u `completed` (TaskWebUI.ts:10266/10298).
 * Vraća `ok:false` samo kad bi API STVARNO odbio (vratar mora biti `live`), jer inače bi
 * daemon blokirao zadatke koje API pušta — sjena bi postala tvrđa od živog pravila.
 */
export function provjeriVratareZatvaranja(u: VratarUlaz): VratarSud {
  const tags = u.tags || []
  const log = u.log ?? (() => {})

  try {
    const rcfg = loadResearchGateConfig()
    if (rcfg.enabled) {
      const rv = evaluateResearchClosure({
        tags, resultSummary: u.resultText, taskId: u.taskId, projectId: u.projectId ?? null,
      })
      if (rv.research) log(`[pred-vratar] ${formatResearchLog(u.taskId, rv)}`)
      if (!rv.accept && shouldEnforceResearch(rv, rcfg)) {
        return {
          ok: false, code: rv.code,
          razlog: `BLOCKED: vratar istraživanja (${rv.code}) — ${rv.reason}`.slice(0, 500),
        }
      }
    }
  } catch (e) { log(`⚠️ [pred-vratar] istraživanje: sud nije donesen (${e}) — propuštam`) }

  try {
    const gcfg = loadGitCommitGateConfig()
    if (gcfg.enabled) {
      const ulaz = { taskId: u.taskId, tags, resultSummary: u.resultText, scopeTags: gcfg.scopeTags }
      const bez = evaluateCommitClosure(ulaz)
      // `git log` po repozitoriju je jedini skup dio — pokreće se TEK kad je zadatak u
      // dosegu i nema dokaza u tekstu (isti redoslijed kao TaskWebUI.ts:10310).
      const gv = bez.code === 'no_commit'
        ? evaluateCommitClosure({ ...ulaz, gitProof: (u.gitDokazFn ?? findTaskCommits)(u.taskId, gcfg) })
        : bez
      if (gv.inScope) log(`[pred-vratar] ${formatCommitLog(u.taskId, gv)}`)
      if (!gv.accept && shouldEnforceCommit(gv, gcfg)) {
        return {
          ok: false, code: gv.code,
          razlog: `BLOCKED: vratar commita (${gv.code}) — ${gv.reason}`.slice(0, 500),
        }
      }
    }
  } catch (e) { log(`⚠️ [pred-vratar] commit: sud nije donesen (${e}) — propuštam`) }

  return { ok: true, code: 'ok', razlog: '' }
}

// ─── PUNI ZAVRŠETAK SPAWNA ───────────────────────────────────────────────────

export interface KritikaSazetak {
  enforce: boolean
  blockedReason: string
  brief: string
}

export interface FinalizacijaUlaz {
  apiBase: string
  taskId: string
  agentId: string
  resultText: string
  /** Trenutak starta spawna — granica „što je ovaj agent dirao". */
  sinceMs: number
  /**
   * TASK-5235: session-id spawna (`claude --session-id`). Kritičar iz transkripta zna što je
   * OVAJ spawn dirao i ne pokreće tuđe testove ni snimke koda u docs/. Neobavezno.
   */
  spawnSessionId?: string
  log?: Zapisivac
  fetchFn?: typeof fetch
  /** Ubrizgavanje suda kritičara (test / drukčiji izvor). */
  kritikaFn?: (ulaz: CritiqueInput) => Promise<KritikaSazetak>
  /** Dohvat oznaka i projekta zadatka (za pred-provjeru vratara). */
  dohvatiZadatakFn?: (taskId: string) => Promise<{ tags: string[]; projectId: string | null } | null>
}

export interface FinalizacijaIshod {
  status: 'completed' | 'blocked'
  razlog: string
  verdict: CompletionVerdict
  kritika: KritikaSazetak | null
  zatvaranje: ZatvaranjeIshod
}

/** Dohvat zadatka preko HTTP-a (AgentDaemon nema izravan pristup bazi u ovom putu). */
export async function dohvatiZadatakHttp(
  apiBase: string, taskId: string, fetchFn: typeof fetch = fetch,
): Promise<{ tags: string[]; projectId: string | null } | null> {
  try {
    const res = await fetchFn(`${apiBase}/${taskId}`)
    if (!res.ok) return null
    const t: any = await res.json()
    return { tags: Array.isArray(t?.tags) ? t.tags : [], projectId: t?.projectId ?? t?.project_id ?? null }
  } catch { return null }
}

/** Postavi zadatak u `in_progress` (daemon to radi UMJESTO agenta — ADR-0012 §4.3). */
export async function postaviUProgress(
  apiBase: string, taskId: string, opts: { log?: Zapisivac; fetchFn?: typeof fetch } = {},
): Promise<ZatvaranjeIshod> {
  return zatvoriZadatak(apiBase, taskId, { status: 'in_progress' }, {
    log: opts.log, fetchFn: opts.fetchFn,
    // `in_progress` na zadatku koji je već `in_progress` prolazi (TaskManagerSQL.ts:658),
    // ali `completed → in_progress` je 409 i to NIJE kvar zatvaranja — ne puni dnevnik neuspjeha.
    zapisiNeuspjeh: false,
  })
}

/**
 * Zaključi spawn: sudi, pa ZAPIŠI ishod. Nikad ne baca i uvijek pokuša zapisati —
 * zadatak bez zapisa je zombi (baseline 12.09.2026: 0 zadataka `in_progress` > 6 h).
 */
export async function finalizirajSpawn(u: FinalizacijaUlaz): Promise<FinalizacijaIshod> {
  const log = u.log ?? (() => {})
  const resultText = u.resultText || ''

  // 1. Sud o tekstu (uklj. agentovu REGOC-STATUS deklaraciju).
  // W3b/TASK-4879: `izvor: 'agent'` — iza ovog teksta JE spawn, dakle prompt je nosio blok
  // sheme. Izuzeća iz `izuzetOdNedostajuceSheme` ovdje namjerno ne vrijede: ona postoje za
  // zatvaranja koja blok nikad nisu nosila, a ovo nije jedno od njih.
  const verdict = evaluateCompletion(resultText, { izvor: 'agent' })
  let treatAsDone = verdict.accept || !shouldEnforce(verdict)
  log(`${formatVerdictLog(verdict)} (task ${u.taskId}, agent ${u.agentId})`)
  let razlog = verdict.accept ? '' : verdict.blockedReason

  // 2. Nezavisni kritičar. Bez njega ovaj modul postaje „zatvarač bez suca" (§20 C).
  let kritika: KritikaSazetak | null = null
  if (u.kritikaFn || isEnabled('criticGate')) {
    try {
      const ulaz: CritiqueInput = {
        taskId: u.taskId, agentId: u.agentId, sinceMs: u.sinceMs,
        resultText, live: isEnabled('criticGateLive'),
        ...(u.spawnSessionId ? { spawnSessionId: u.spawnSessionId } : {}),
      }
      kritika = u.kritikaFn
        ? await u.kritikaFn(ulaz)
        : await (async () => {
            const o = await critiqueSpawnAsync(ulaz)
            return { enforce: o.enforce, blockedReason: o.blockedReason, brief: o.verdict.summary || '' }
          })()
      if (kritika.enforce) {
        treatAsDone = false
        razlog = kritika.blockedReason || 'BLOCKED: CRITIC_FAILED'
        log(`⛔ [kritičar] ${u.taskId}: provjere padaju — zadatak NE ide u completed`)
      }
    } catch (e) {
      // Kvar kritičara ne smije zaustaviti zapis ishoda — to bi bio zombi bez signala.
      log(`⚠️ [kritičar] ${u.taskId}: sud nije donesen (${e}) — zatvaranje ide po sudu o tekstu`)
    }
  }

  // 3. Pred-provjera vratara (§12) — samo kad bismo inače pisali `completed`.
  if (treatAsDone) {
    const kontekst = u.dohvatiZadatakFn
      ? await u.dohvatiZadatakFn(u.taskId).catch(() => null)
      : await dohvatiZadatakHttp(u.apiBase, u.taskId, u.fetchFn)
    const sud = provjeriVratareZatvaranja({
      taskId: u.taskId, tags: kontekst?.tags ?? [], projectId: kontekst?.projectId ?? null,
      resultText, log,
    })
    if (!sud.ok) {
      treatAsDone = false
      razlog = sud.razlog
      log(`⛔ [pred-vratar] ${u.taskId}: ${sud.code} — zatvaram kao blocked (inače bi zadatak ostao in_progress)`)
    }
  }

  // 4. Najam se pušta PRIJE zapisa, pa tek onda zapis.
  pustiNajam(u.taskId)

  const body = treatAsDone
    ? { status: 'completed', result_summary: resultText.slice(0, 20000) }
    : {
        status: 'blocked',
        blocked_reason: (razlog || 'BLOCKED: nije utvrđen dokaz izvršenja').slice(0, 500),
        progressNotes: [
          `Auto: zadatak NIJE zatvoren kao completed.${kritika?.brief ? `\n${kritika.brief}` : ''}\nOdgovor agenta:\n${resultText.slice(0, 4000)}`,
        ],
      }

  const zatvaranje = await zatvoriZadatak(u.apiBase, u.taskId, body, { log, fetchFn: u.fetchFn })
  return {
    status: treatAsDone ? 'completed' : 'blocked',
    razlog: treatAsDone ? '' : String(body.blocked_reason ?? ''),
    verdict, kritika, zatvaranje,
  }
}

// ─── spawnCloseGuard (§6.2, G2, G4) ──────────────────────────────────────────
// Guard NE pita „tko si" (`task_history.changed_by` je assignee, TaskManagerSQL.ts:666 —
// agentov i daemonov PUT su ondje identični), nego „radi li upravo sada spawn na ovom
// zadatku". Daemon najam pušta PRIJE svog zapisa, pa njegov PUT prolazi bez ijednog
// zaglavlja ili tajne. Tajna u zaglavlju i ne bi bila brana: agent ima Bash i može je
// pročitati (§6.1).

export interface GuardUlaz {
  status: string
  prijelazi: (status: string) => string[]
  najamAktivan: boolean
  force: boolean
}

export interface GuardOdluka {
  odbij: boolean
  code: 'SPAWN_ACTIVE' | 'ok'
  razlog: string
  hint: string
}

/** Poruka odbijanja. G4: govori ŠTO učiniti i NE spominje `force`/`X-REGOC-Force`. */
export const GUARD_HINT =
  'Status zadatka postavlja REGOČ nakon što nezavisni kritičar pokrene provjere nad onim što si ostavio na disku. ' +
  'Ishod deklariraj zadnjim retkom odgovora: REGOC-STATUS: DONE|BLOCKED|NEEDS_CONTEXT — <razlog>.'

export function odlukaGuarda(u: GuardUlaz): GuardOdluka {
  const terminalan = jeTerminalan(u.status, u.prijelazi)
  const odbij = terminalan && u.najamAktivan && !u.force
  return {
    odbij,
    code: odbij ? 'SPAWN_ACTIVE' : 'ok',
    razlog: odbij
      ? `Na zadatku upravo radi spawn — prijelaz u terminalno stanje '${u.status}' ne dolazi od sustava.`
      : '',
    hint: GUARD_HINT,
  }
}
