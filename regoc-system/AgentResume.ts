/**
 * AgentResume — čista logika izbora checkpointa za nastavak (`tryResume`).
 *
 * TASK-2583 (pilot 2026-07-28): svaki restart AgentDaemona uskrsnuo bi posao
 * koji je VEĆ isporučen. Uzrok: `tryResume` je birao samo među NEZAVRŠENIM
 * fazama (`STARTING/EXECUTING/WAITING_RETRY/SESSION_CAPTURED`) i sortirao po
 * `created_at DESC`. Kako `SESSION_CAPTURED` i `COMPLETED` padnu u ISTU sekundu
 * (mjereno: potjeh 10:41:01 i 10:42:00, manda 10:39:22), `COMPLETED` red je
 * filtru nevidljiv — daemon vidi „nedovršen" SESSION_CAPTURED i potroši novi
 * `claude --print` na poruku na koju je već odgovorio (potjeh: 1 → 6 runova).
 *
 * Pravilo: checkpoint se nastavlja SAMO ako za isti `task_id` ne postoji NOVIJI
 * terminalni checkpoint. Poredak je po `id` (AUTOINCREMENT, monotono), ne po
 * sekundnom `created_at` — vremenski izjednačeni redovi tako dobiju
 * determinističan redoslijed.
 *
 * `STOPPED` NIJE terminalno: graciozno gašenje daemona usred zadatka upisuje
 * STOPPED dok posao još traje, a taj se posao MORA nastaviti nakon restarta.
 */

/** Faze koje znače „posao je započet, nije dovršen". */
export const RESUMABLE_PHASES = ['STARTING', 'EXECUTING', 'WAITING_RETRY', 'SESSION_CAPTURED'] as const

/** Faze koje znače „za ovaj task više nema što nastaviti". */
export const TERMINAL_PHASES = ['COMPLETED', 'FAILED', 'ABANDONED'] as const

export interface CheckpointRow {
  id: number
  task_id: string | null
  phase: string
  session_id?: string | null
  context_summary?: string | null
  created_at?: string
  state_json?: string
}

const isResumable = (phase: string) => (RESUMABLE_PHASES as readonly string[]).includes(phase)
const isTerminal = (phase: string) => (TERMINAL_PHASES as readonly string[]).includes(phase)

/** Ključ po kojem se terminalni checkpoint veže uz nedovršeni. */
const keyOf = (row: CheckpointRow) => row.task_id ?? `__null__:${row.id}`

/**
 * Vrati checkpoint koji se stvarno smije nastaviti, ili `null`.
 *
 * @param rows checkpointi jednog agenta, poredani NAJNOVIJI PRVI (`ORDER BY id DESC`).
 */
export function selectResumableCheckpoint(rows: CheckpointRow[]): CheckpointRow | null {
  const finished = new Set<string>()
  for (const row of rows) {
    if (isTerminal(row.phase)) {
      finished.add(keyOf(row))
      continue
    }
    if (isResumable(row.phase) && !finished.has(keyOf(row))) return row
  }
  return null
}
