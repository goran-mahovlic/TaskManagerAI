/**
 * HookBlockGuard — klasifikacija ishoda spawna `claude --print` PRIJE upisa rezultata.
 *
 * Problem (TASK-2953, incident 2026-07-27 22:51–22:53):
 *   Kad `UserPromptSubmit` hook blokira sesiju (session_usage.py, prag 97 %), claude CLI
 *   NE pokrene model — ispiše poruku blokade na stdout i izađe s kodom 0. Pozivatelj
 *   (RegocDaemon spawn handler) je exit 0 tretirao kao uspjeh i upisao doslovnu poruku
 *   blokade u `result_summary` uz `status=completed`. TASK-2561/2583/2950 su tako zatvoreni
 *   kao DONE iako agent nije napisao ni jedan token.
 *
 * Doslovni oblik stdouta (arhivirano iz progress_notes tih zadataka):
 *
 *     UserPromptSubmit operation blocked by hook:
 *     ⛔ Potrošnja sesije je 99% (prag 97%). Rad je zaustavljen do resetiranja sesije u …
 *
 *     Original prompt: # Ti si Jelena - Engineer …
 *
 * Zadnji dio je CIJELI prompt vraćen natrag — zato se nikad ne smije proslijediti dalje
 * (`sendResponse`/Telegram), inače je to i vektor echo-petlje (usp. DispatchGuard).
 *
 * Krši pravila #7 (VERIFICATION GATE) i #8 (STRUCTURED STATUS: blokada = BLOCKED, nikad DONE).
 *
 * Modul je čist i bez nuspojava → testira se izolirano od daemona.
 */

import { parseDeclaredStatus } from './CompletionGuard'

/** Koliko prvih nepraznih redaka izlaza se pretražuje za potpis blokade. */
export const HOOK_BLOCK_SCAN_LINES = 5

/** Gornja granica duljine kratkog razloga (ide u blocked_reason / notifikaciju). */
export const MAX_REASON_LEN = 300

/**
 * Potpis koji claude CLI ispisuje kad hook odbije operaciju.
 * Sidren na POČETAK retka namjerno: izvještaj agenta koji samo *spominje* frazu
 * ("popravio sam 'operation blocked by hook' bug") ne smije pasti pod filter.
 */
const HOOK_BLOCK_LINE = /^\s*(?:\[[^\]]{0,40}\]\s*)?([A-Za-z][\w-]{0,40})\s+operation blocked by hook\s*:?\s*(.*)$/u

/** Rep u kojem CLI vraća cijeli originalni prompt — nikad se ne prosljeđuje dalje. */
const ORIGINAL_PROMPT_TAIL = /\n\s*Original prompt:\s[\s\S]*$/u

/**
 * Potpis blokade zbog potrošnje sesije (tools/session_usage.py `hook_prompt`).
 * Razlikuje se od ostalih hookova jer je privremen — prolazi sam od sebe nakon resetiranja.
 */
const SESSION_BUDGET_PATTERNS: RegExp[] = [
  /Potro[šs]nja sesije/iu,
  /BLOCK_THRESHOLD/u,
  /session_usage\.py/u,
  /resetiranj[au] sesije/iu,
]

/**
 * M3/TASK-4625: `blocked_ok` je ČETVRTI ishod — agent je radio i SAM deklarirao
 * `REGOC-STATUS: BLOCKED|NEEDS_CONTEXT`. Razlikuje se od `blocked` (spawn odbijen na
 * ulazu, agent nije napisao ni jedan token) jer se ne popravlja istim mjerama:
 * uredan zastoj je točno ponašanje, hook-blokada je kvar. V. `RunOutcome.ts`.
 */
export type SpawnOutcomeKind = 'completed' | 'blocked_ok' | 'blocked' | 'failed'

export interface HookBlockVerdict {
  blocked: boolean
  /** Ime hook-događaja koji je blokirao (npr. 'UserPromptSubmit'), ako je pročitano. */
  hookEvent: string | null
  /** Strojni kod za blocked_reason / telemetriju. */
  code: 'session-budget' | 'hook-block' | 'no-turns' | 'ok'
  /** Kratak, jednoredni razlog BEZ vraćenog prompta — siguran za blocked_reason i notifikaciju. */
  reason: string
  /** Puni tekst blokade s odsječenim "Original prompt:" repom (za progress_notes). */
  detail: string
}

const NOT_BLOCKED: HookBlockVerdict = {
  blocked: false,
  hookEvent: null,
  code: 'ok',
  reason: '',
  detail: '',
}

/**
 * `num_turns === 0`: CLI je izašao bez ijednog modelskog koraka. Rezultat je prazan ili
 * je poruka blokade, a exit kod, `is_error` i `subtype` izgledaju kao uspjeh — pa je ovo
 * jedini pouzdan potpis. Vrijedi samo uz `--output-format json`.
 */
const NO_TURNS_VERDICT: HookBlockVerdict = {
  blocked: true,
  hookEvent: null,
  code: 'no-turns',
  reason: 'CLI je izašao bez ijednog modelskog koraka (num_turns=0) — agent nije napisao ni jedan token.',
  detail: 'num_turns=0 uz exit 0: ulaz je odbijen prije modela (hook ili odbijen prompt).',
}

/**
 * Odbaci "Original prompt: …" rep koji CLI dodaje na poruku blokade.
 * Bez ovoga bi se cijeli prompt agenta vratio u poruke/Telegram i mogao se reciklirati
 * kao "novi zadatak".
 */
export function stripOriginalPrompt(text: string): string {
  return (text || '').replace(ORIGINAL_PROMPT_TAIL, '').trim()
}

/**
 * Izlaz spawna → tekst koji nosi rezultat.
 * `claude --print --output-format json` (AgentDaemon) rezultat drži u polju `result`;
 * RegocDaemon vrti obični text mode pa je izlaz već sirovi tekst.
 */
export function extractResultText(raw: string): string {
  const s = (raw || '').trim()
  if (!s.startsWith('{')) return s
  try {
    const j = JSON.parse(s)
    if (j && typeof j.result === 'string') return j.result
  } catch {
    /* nije JSON → sirovi tekst */
  }
  return s
}

/** True kad je razlog blokade potrošnja sesijskog budžeta (privremeno, prolazi s resetom). */
export function isSessionBudgetBlock(text: string): boolean {
  return SESSION_BUDGET_PATTERNS.some((p) => p.test(text || ''))
}

function firstLine(text: string, maxLen = MAX_REASON_LEN): string {
  const line = (text || '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) || ''
  return line.length > maxLen ? line.slice(0, maxLen - 1).trimEnd() + '…' : line
}

/**
 * Prepoznaj poruku hook-blokade u izlazu spawna.
 *
 * @param stdout  standardni izlaz procesa (text ili `--output-format json`)
 * @param stderr  standardna greška (neki CLI-jevi poruku šalju ovamo)
 */
export function detectHookBlock(stdout: string, stderr: string = ''): HookBlockVerdict {
  for (const raw of [stdout, stderr]) {
    const text = extractResultText(raw || '')
    if (!text) continue

    const lines = text.split('\n').filter((l) => l.trim().length > 0)
    for (let i = 0; i < Math.min(lines.length, HOOK_BLOCK_SCAN_LINES); i++) {
      const m = HOOK_BLOCK_LINE.exec(lines[i])
      if (!m) continue

      const hookEvent = m[1]
      // Sve iza retka s potpisom je obrazloženje hooka; rep s promptom odlazi.
      const afterHeader = [m[2], ...lines.slice(i + 1)].join('\n')
      const detail = stripOriginalPrompt(afterHeader)
      const sessionBudget = isSessionBudgetBlock(detail) || isSessionBudgetBlock(text)

      return {
        blocked: true,
        hookEvent,
        code: sessionBudget ? 'session-budget' : 'hook-block',
        reason:
          firstLine(detail) ||
          `Hook '${hookEvent}' je blokirao operaciju bez obrazloženja.`,
        detail,
      }
    }
  }
  return NOT_BLOCKED
}

export interface SpawnOutcome {
  kind: SpawnOutcomeKind
  /** Verdikt hook-guarda (blocked=false kad blokade nema). */
  block: HookBlockVerdict
  /**
   * Točno tijelo PUT-a prema TaskManageru, ili null kad ga zove postojeća grana.
   * Za `blocked`: NIKAD ne sadrži `result_summary` — poruka blokade nije rezultat rada.
   */
  taskUpdate: Record<string, unknown> | null
  /** Kratka poruka za pošiljatelja (bez vraćenog prompta). */
  notice: string
}

/**
 * Jedinstvena odluka "što je spawn zapravo napravio" — SSOT za sve pozivatelje
 * (`RegocDaemon`, `AgentDaemon`, `AgentWorker`).
 *
 * Ključno: exit 0 NIJE dovoljan dokaz uspjeha. Ako izlaz nosi potpis hook-blokade,
 * agent nije ni krenuo → ishod je `blocked`, a ne `completed`.
 */
export interface SpawnMeta {
  /**
   * `num_turns` iz `--output-format json`. Vrijednost 0 znači da CLI nije napravio
   * NIJEDAN modelski korak — jedini pouzdan potpis hook-blokade (blokirani spawn inače
   * izlazi s exit 0, `is_error:false`, `subtype:"success"`). Bez ovoga bi takav run
   * prošao kao `completed` s praznim rezultatom.
   */
  numTurns?: number | null
}

export function classifySpawnOutcome(
  exitCode: number,
  stdout: string,
  stderr: string = '',
  meta: SpawnMeta = {},
): SpawnOutcome {
  const block = meta.numTurns === 0 ? NO_TURNS_VERDICT : detectHookBlock(stdout, stderr)

  if (block.blocked) {
    const scope =
      block.code === 'session-budget'
        ? 'Potrošen je sesijski budžet — zadatak čeka reset sesije.'
        : block.code === 'no-turns'
          ? 'CLI je izašao bez ijednog modelskog koraka (num_turns=0) — ulaz je odbijen prije modela.'
          : `Hook '${block.hookEvent}' je zaustavio spawn na ulazu.`
    return {
      kind: 'blocked',
      block,
      taskUpdate: {
        status: 'blocked',
        // blocked_reason je strojni kod, ne doslovna poruka blokade.
        blockedReason:
          block.code === 'session-budget' ? 'session-budget'
          : block.code === 'no-turns' ? 'no-turns'
          : `hook-block:${block.hookEvent}`,
        progressNotes: [
          `Agent NIJE započeo rad — ${block.hookEvent ? `${block.hookEvent} hook je blokirao ulaz` : 'ulaz je odbijen'} (${block.code}). ` +
            `${scope} Poruka hooka: ${block.reason} ` +
            `Zadatak ostaje neodrađen; vrati ga u pending kad blokada prođe.`,
        ],
      },
      notice: `⛔ Zadatak nije započet — ${block.reason}`,
    }
  }

  if (exitCode === 0) {
    // M3/TASK-4625: agent je radio i sam deklarirao da staje. To NIJE `completed`
    // (posao nije isporučen) ni `blocked` (spawn je uredno prošao) — to je `blocked_ok`.
    // `taskUpdate` ostaje null: status zadatka i dalje odlučuje CompletionGuard u
    // pozivatelju, ovdje se samo imenuje ishod IZVOĐENJA za telemetriju.
    const declared = parseDeclaredStatus(stdout)
    if (declared && declared.status !== 'DONE') {
      return {
        kind: 'blocked_ok',
        block,
        taskUpdate: null,
        notice: `⏸️ Agent je sam deklarirao ${declared.status}${declared.reason ? `: ${declared.reason}` : ''}`,
      }
    }
    return { kind: 'completed', block, taskUpdate: null, notice: '' }
  }
  return { kind: 'failed', block, taskUpdate: null, notice: '' }
}
