/**
 * RunOutcome — taksonomija ishoda jednog spawna (M3, TASK-4625).
 *
 * PROBLEM (mjereno, docs/ISTRAZIVANJE-neuspjesi-i-greske.md §2 i §4/M3):
 *   `run_log.jsonl` je do sada imao tri vrijednosti — `completed`, `blocked`, `failed` —
 *   a `blocked` je značilo dvije POTPUNO različite stvari:
 *
 *     (a) agent je odradio posao do zida i UREDNO stao ("čekam Goranovu odluku",
 *         "nema mrežne rute", "treba restart ploče") — to nije kvar, nego točan
 *         izvještaj; većina tih zadataka poslije je `completed`;
 *     (b) spawn je odbijen na ULAZU (hook-blokada, `num_turns=0`) ili je rezultat
 *         odbijen jer nije dokaz izvršenja — to JEST kvar koji treba popraviti.
 *
 *   Dok se to ne razdvoji, statistika broji (a) kao neuspjeh i ne zna se što popravljati:
 *   izmjereno je 81 % "neuspjeha", a prava tehnička neuspješnost je 24/202 ≈ 12 %.
 *
 * RJEŠENJE: četvrta vrijednost `blocked_ok` u `run_log.outcome` + tri STUPCA na ploči.
 *
 *   run_log.outcome            stupac na ploči     značenje
 *   ─────────────────────────  ──────────────────  ─────────────────────────────────────
 *   completed                  completed           posao isporučen i prihvaćen
 *   blocked_ok                 blocked_ok          agent je SAM stao pred preprekom
 *   blocked                    failed              spawn/rezultat odbijen (tehnički)
 *   failed                     failed              proces je pao (exit ≠ 0, signal)
 *
 * ZAŠTO `blocked` ide u stupac `failed`, a ne u vlastiti:
 *   hook-blokada ulaza i odbijen rezultat su ono ŠTO SE POPRAVLJA (M1 osigurač, M5
 *   strukturirani izlaz, M6 rana provjera). Uredni zastoj se ne popravlja — on je
 *   ispravno ponašanje. Tri stupca dakle odgovaraju na tri različita pitanja:
 *   "koliko je isporučeno", "koliko je pošteno stalo", "koliko je puklo".
 *   Puna četveročlana raščlamba ostaje u `ishodi` (Counter po sirovoj vrijednosti).
 *
 * NALAZ KOJI ISPRAVLJA ISTRAŽIVANJE (mjereno 04.09.2026. nad `data/run_log.jsonl`):
 *   §2 pripisuje svih ~28 od 30 ne-incidentnih `blocked` redaka agentovoj vlastitoj
 *   deklaraciji. To NIJE točno: 13 tih redaka ima `num_turns = 0` (rafal hook-blokada
 *   29.07.2026., 07:55–09:26, potrošen sesijski budžet) — agent nije napisao ni jedan
 *   token. Zato se `blocked_ok` NIKAD ne izvodi iz same vrijednosti `blocked`, nego iz
 *   dokaza da je agent radio i sam imenovao prepreku.
 *
 * Modul je čist (bez I/O i bez globalnog stanja) → testira se bez daemona i bez baze.
 */

/** Vrijednost polja `outcome` u `data/run_log.jsonl`. */
export type RunOutcome = 'completed' | 'blocked_ok' | 'blocked' | 'failed'

/** Stupac na ploči i u tjednom pregledu (tri, ne četiri — v. objašnjenje gore). */
export type OutcomeColumn = 'completed' | 'blocked_ok' | 'failed'

export const RUN_OUTCOMES: readonly RunOutcome[] = ['completed', 'blocked_ok', 'blocked', 'failed']
export const OUTCOME_COLUMNS: readonly OutcomeColumn[] = ['completed', 'blocked_ok', 'failed']

/**
 * Sirova vrijednost `outcome` → stupac.
 *
 * Nepoznata vrijednost (stariji ili tuđi zapis) pada u `failed`, ne u `completed`:
 * mjerilo koje ne razumije redak ne smije ga proglasiti uspjehom.
 */
export function outcomeColumn(outcome: string | null | undefined): OutcomeColumn {
  const o = String(outcome ?? '').trim()
  if (o === 'completed') return 'completed'
  if (o === 'blocked_ok') return 'blocked_ok'
  return 'failed'
}

/** Prazan brojač stupaca — uvijek sva tri ključa, i kad su nule (nazivnik mora biti vidljiv). */
export function emptyColumnCounts(): Record<OutcomeColumn, number> {
  return { completed: 0, blocked_ok: 0, failed: 0 }
}

/** Zbroji sirove ishode u tri stupca. */
export function countColumns(outcomes: Iterable<string | null | undefined>): Record<OutcomeColumn, number> {
  const out = emptyColumnCounts()
  for (const o of outcomes) out[outcomeColumn(o)]++
  return out
}

// ─── Živa klasifikacija: sud CompletionGuarda → ishod izvođenja ───────────────

/**
 * Kodovi `CompletionGuard`-a kod kojih je agent RADIO i sam imenovao prepreku.
 *
 *   `declared_not_done`    — strojno čitljiv redak `REGOC-STATUS: BLOCKED|NEEDS_CONTEXT`
 *                            (ugovor, ne pogađanje);
 *   `incapacity_admission` — agent u prozi imenuje što ga je zaustavilo.
 *
 * Ostali kodovi (`empty_result`, `trivial_result`, `no_evidence`) NISU uredan zastoj:
 * tamo agent ništa nije isporučio i ništa nije imenovao — to je kvar koji se popravlja.
 */
const ORDERLY_STOP_CODES = new Set(['declared_not_done', 'incapacity_admission'])

/**
 * Ishod izvođenja iz suda `CompletionGuard`-a.
 *
 * @param accepted     smije li se zadatak zatvoriti kao `completed`
 * @param verdictCode  `CompletionVerdict.code`
 */
export function outcomeFromCompletionVerdict(accepted: boolean, verdictCode: string): RunOutcome {
  if (accepted) return 'completed'
  return ORDERLY_STOP_CODES.has(verdictCode) ? 'blocked_ok' : 'blocked'
}

// ─── Povijesni preračun iz `blocked_reason` ──────────────────────────────────

/**
 * Potpisi TEHNIČKOG zastoja u `tasks.blocked_reason` — spawn nije ni krenuo ili je
 * ubijen. Sidreni na početak niza jer su svi strojno generirani (HookBlockGuard,
 * classifySpawnExit, killAgentSpawn).
 */
const TECHNICAL_REASON_PATTERNS: RegExp[] = [
  /^no-turns\b/i,                     // CLI izašao bez ijednog modelskog koraka
  /^session-budget\b/i,               // hook je odbio ulaz zbog potrošnje sesije
  /^hook-block:/i,                    // bilo koji drugi hook na ulazu
  /^Spawn prekinut:/i,                // classifySpawnExit (signal, exit ≠ 0)
  /^Prekinuto \(/i,                   // shutdown daemona, ručna pauza, globalna kočnica
]

/**
 * Potpisi odbijenog REZULTATA (`CompletionGuard`) — agent je izašao s 0, ali nije
 * isporučio ni dokaz ni imenovanu prepreku. Doslovni početci rečenica iz
 * `CompletionGuard.evaluateCompletion`; provjeravaju se PRIJE općeg prefiksa
 * `NEEDS_CONTEXT:` jer nose isti prefiks, a nisu uredan zastoj.
 */
const REJECTED_RESULT_PATTERNS: RegExp[] = [
  /^NEEDS_CONTEXT:\s*Zadatak se ne mo/i,        // empty_result
  /^NEEDS_CONTEXT:\s*Rezultat je gola potvrda/i, // trivial_result
  /^NEEDS_CONTEXT:\s*Rezultat je prekratak/i,    // trivial_result (duljina)
  /^NEEDS_CONTEXT:\s*Rezultat tvrdi uspjeh/i,    // no_evidence
]

/**
 * Potpisi UREDNOG zastoja koje agent (ili čovjek) upiše bez guarda — protokol iz
 * prompta agenta doslovno propisuje prefikse `BLOCKED:` i `NEEDS_CONTEXT:`, a
 * čekanje na drugi zadatak / na Gorana se piše prozom.
 */
const ORDERLY_REASON_PATTERNS: RegExp[] = [
  /^(BLOCKED|NEEDS[-_ ]?CONTEXT)\s*:/i,
  /^waiting-for-human\b/i,
  /^(Čeka|Ceka|Cekam|Čekam)\b/i,
  /^Serijalizacija:\s*(čeka|ceka)/i,
]

/**
 * Povijesni redak → stupac, isključivo iz `tasks.blocked_reason`.
 *
 * Vraća `null` kad razlog ne prepoznaje nijedno pravilo. Pozivatelj tada ZADRŽAVA
 * izvorni ishod — nagađanje bi napuhalo `blocked_ok` i mjerilo bi lagalo u drugom
 * smjeru nego dosad. Preračun smije samo ono što može dokazati.
 */
export function columnFromBlockedReason(reason: string | null | undefined): OutcomeColumn | null {
  const r = String(reason ?? '').trim()
  if (!r) return null
  for (const re of TECHNICAL_REASON_PATTERNS) if (re.test(r)) return 'failed'
  for (const re of REJECTED_RESULT_PATTERNS) if (re.test(r)) return 'failed'
  for (const re of ORDERLY_REASON_PATTERNS) if (re.test(r)) return 'blocked_ok'
  return null
}

/**
 * Preračunaj JEDAN povijesni redak `run_log`-a.
 *
 * Pravila (fail-safe, redom):
 *   1. `completed` se nikad ne dira — uspjeh nije predmet preračuna;
 *   2. redak koji je već `blocked_ok` ostaje;
 *   3. samo `blocked` može postati `blocked_ok`. `failed` NIKAD — proces koji je pao
 *      (exit ≠ 0, signal) je tehnički kvar bez obzira gdje je ZADATAK poslije završio.
 *      Mjereno 04.09.2026.: bez ovog pravila su se preračunavala i dva izvođenja s
 *      exit 1 i exit 137 (SIGKILL) samo zato što je zadatak kasnije čekao Gorana —
 *      to je brkanje stanja zadatka sa stanjem izvođenja;
 *   4. `exit_code` različit od 0 (ili nepoznat) također isključuje preračun — isti
 *      razlog, drugi dokaz;
 *   5. `num_turns === 0` je tvrd dokaz da agent NIJE radio → ostaje tehnički `blocked`,
 *      bez obzira što piše u `blocked_reason` (nalaz iz zaglavlja modula);
 *   6. bez prepoznatog razloga → bez promjene.
 */
export function recomputeHistoricalOutcome(
  row: { outcome?: string | null; num_turns?: number | null; exit_code?: number | null },
  blockedReason: string | null | undefined,
): RunOutcome | null {
  if (String(row.outcome ?? '') !== 'blocked') return null
  if (row.exit_code !== 0) return null
  if (row.num_turns === 0) return null

  const column = columnFromBlockedReason(blockedReason)
  if (column !== 'blocked_ok') return null
  return 'blocked_ok'
}
