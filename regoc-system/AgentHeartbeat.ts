/**
 * AgentHeartbeat.ts — čiste funkcije za heartbeat i higijenu inboxa.
 *
 * Zašto zaseban modul: `AgentDaemon.ts` na importu izvršava svoj entry point
 * (process.exit(1) bez --agent), pa se njegova logika ne može testirati. Ovdje
 * je sve što je čisto (bez I/O), da ima testove i da ga dijele daemon i alati.
 *
 * Sadrži:
 *  - R4/TASK-2564: `buildHeartbeat` — heartbeat koji ne laže (taskRef,
 *    lastDeliveredAt, tasksCompletedToday).
 *  - F3/TASK-2583: `isStaleMessage` — zaštita da start-team ne detonira
 *    zaostali inbox (poruke stare danima) u žive `claude --print` sesije.
 */

/** Koliko stara poruka se više NE izvršava automatski (sati). */
export const STALE_INBOX_MAX_AGE_H = 24

/** Heartbeat stariji od ovoga R3 reaper smatra mrtvim (ms) — mora ostati usklađen s RegocDaemon. */
export const DEAD_AGENT_HEARTBEAT_MS = 2 * 60 * 60 * 1000

export interface HeartbeatInput {
  agentId: string
  model: string
  status: 'idle' | 'executing' | 'stopping'
  /** Interni ID trenutnog posla — može biti i message-UUID. */
  currentTaskId: string | null
  /** Kumulativno od pokretanja procesa. */
  tasksCompleted: number
  /** Resetira se u ponoć (vidi `rollDailyCounter`). */
  tasksCompletedToday: number
  startedAt: string
  /** ISO vrijeme zadnje STVARNO isporučene poruke (ne „pokrenuo sam se"). */
  lastDeliveredAt: string | null
  pid: number
  /** Injektirano zbog testabilnosti. */
  now?: Date
}

export interface Heartbeat {
  agent: string
  task: string
  /** TASK-NNNN ili null — nikad harness-UUID (R4). */
  taskRef: string | null
  ts: string
  status: string
  brief: string
  pid: number
  model: string
  tasksCompleted: number
  tasksCompletedToday: number
  lastDeliveredAt: string | null
  uptime: number
  /** Tko je pisac datoteke — ista putanja koju koriste i efemerne sesije. */
  source: 'AgentDaemon'
}

/**
 * R4: iz internog ID-a izvuci SAMO pravi TASK-NNNN.
 *
 * `current_task` je znao biti harness-UUID ili slobodan tekst ("RGMII timing
 * fix gotov..."), pa se iz heartbeata nije dalo pročitati na čemu agent radi.
 * Sve što nije TASK-NNNN → null (radije prazno nego lažno).
 */
export function normalizeTaskRef(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = String(raw).match(/\bTASK-\d+\b/)
  return m ? m[0] : null
}

/** Lokalni datum (YYYY-MM-DD) — ključ za dnevni brojač. */
export function localDayKey(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/**
 * Reset dnevnog brojača u ponoć. Vraća novo stanje (bez mutacije ulaza).
 * Poziva se prije svakog inkrementa i prije pisanja heartbeata.
 */
export function rollDailyCounter(
  state: { dayKey: string; tasksCompletedToday: number },
  now: Date = new Date()
): { dayKey: string; tasksCompletedToday: number } {
  const today = localDayKey(now)
  if (state.dayKey === today) return state
  return { dayKey: today, tasksCompletedToday: 0 }
}

/**
 * R4/TASK-2564: heartbeat iz kojeg se ČITA „na kojem TASK-u" i „kad je zadnje
 * išta isporučio". Polja su ADITIVNA — stari potrošači (RegocDaemon watchdog,
 * konzola) čitaju iste ključeve kao prije.
 */
export function buildHeartbeat(input: HeartbeatInput): Heartbeat {
  const now = input.now ?? new Date()
  const taskRef = normalizeTaskRef(input.currentTaskId)

  const brief = input.status === 'executing'
    ? `Radi na ${taskRef || input.currentTaskId || 'zadatku'}`
    : `Idle (danas ${input.tasksCompletedToday}, ukupno ${input.tasksCompleted})`

  return {
    agent: input.agentId,
    task: input.currentTaskId || 'idle',
    taskRef,
    ts: now.toISOString(),
    status: input.status,
    brief,
    pid: input.pid,
    model: input.model,
    tasksCompleted: input.tasksCompleted,
    tasksCompletedToday: input.tasksCompletedToday,
    lastDeliveredAt: input.lastDeliveredAt,
    uptime: Math.max(0, Math.floor((now.getTime() - new Date(input.startedAt).getTime()) / 60000)),
    source: 'AgentDaemon'
  }
}

/**
 * F3/TASK-2583: je li poruka prestara za automatsko izvršavanje?
 *
 * Kontekst: pilot `start-team` diže daemone agentima koji imaju zaostali inbox
 * (jelena: 4 poruke stare 9–14 dana). Bez ove provjere daemon bi ih na prvom
 * poll-u pretvorio u žive Opus sesije i odgovorio na zahtjeve koje je korisnik
 * odavno prošao. Stare poruke se PARKIRAJU (nikad tiho ne brišu) — vidi
 * `parkStaleMessage` u AgentDaemon.
 *
 * @param createdAt SQLite timestamp ('YYYY-MM-DD HH:MM:SS', UTC) ili ISO
 */
export function isStaleMessage(
  createdAt: string | null | undefined,
  now: Date = new Date(),
  maxAgeHours: number = STALE_INBOX_MAX_AGE_H
): boolean {
  if (!createdAt) return false // bez vremena ne pogađamo — radije obradi
  const ms = parseDbTimestamp(createdAt)
  if (ms === null) return false
  return (now.getTime() - ms) > maxAgeHours * 3_600_000
}

/**
 * SQLite `datetime('now')` piše UTC bez oznake zone; `new Date(...)` bi ga
 * protumačio kao lokalno vrijeme (u CEST-u 2h pomaka → poruka "iz budućnosti").
 * Zato eksplicitno dodajemo 'Z'.
 */
export function parseDbTimestamp(ts: string): number | null {
  if (!ts) return null
  const s = ts.trim()
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)
    ? s.replace(' ', 'T') + 'Z'
    : s
  const ms = new Date(normalized).getTime()
  return Number.isNaN(ms) ? null : ms
}

/** Sati starosti poruke (za log/izvještaj). */
export function messageAgeHours(createdAt: string, now: Date = new Date()): number {
  const ms = parseDbTimestamp(createdAt)
  if (ms === null) return 0
  return Math.max(0, (now.getTime() - ms) / 3_600_000)
}
