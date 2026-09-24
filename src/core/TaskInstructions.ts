// ─── TaskInstructions ────────────────────────────────────────────────────────
// TASK-5013 (Goran, 24.09.2026.). Dodatne upute agentu DOK RADI.
//
// PROBLEM: spawnani agent (`claude --print`) dobiva opis zadatka JEDNOM, pri spawnu. Bilješke
// koje REGOČ poslije dopiše u zadatak agent ne vidi (TASK-4999: 16 poziva na API, svi PUT
// progressNotes s izlazom u /dev/null). Jedini put je bio pauza + nastavak, što ubija proces
// i gubi kontekst sesije.
//
// RJEŠENJE:
//   1. SPREMIŠTE — tablica `task_instructions`, odvojena od progressNotes (njih piše i sam
//      agent, pa bi se upute izgubile među njegovim bilješkama).
//   2. DOSTAVA — hook `hooks/TaskInstructionsInject.hook.ts` na PostToolUse i
//      SessionStart. Spawn već nosi REGOC_TASK_ID u okolini; hook atomično preuzme
//      nedostavljene upute (`POST /api/tasks/:id/upute/preuzmi`) i vrati ih kao
//      `additionalContext` — model ih vidi uz rezultat sljedećeg alata, u ISTOJ sesiji.
//   3. REZERVA — ako je agent izašao prije dostave, upute ostaju nedostavljene i SessionStart
//      sljedećeg spawna istog zadatka ih ubacuje u početni kontekst (blok „DODATNE UPUTE").
//
// FAIL-OPEN: hook nikad ne blokira alat. Nema zadatka, API ugašen, spor (>300 ms) ili vrati
// smeće → izlaz 0 bez ispisa; uputa ostaje nedostavljena i pokušava se na sljedećem alatu.
//
// Modul je bez putanja i bez okoline po zadanom (baza i fetch se predaju), pa je isti u
// pogonu i u paketu TaskManagerAI. Autorica: Jelena (Engineer) · 2026-09-24 · TASK-5013

import type { Database } from 'bun:sqlite'

export const INSTRUCTION_MAX_CHARS = 4000
export const HOOK_TIMEOUT_MS = 300
/** Događaji na kojima Claude Code prihvaća `hookSpecificOutput.additionalContext`. */
export const HOOK_EVENTS = ['PostToolUse', 'SessionStart'] as const

export interface InstructionRow {
  id: number
  task_id: string
  author: string
  text: string
  created_at: string
  delivered_at: string | null
  delivered_session: string | null
}

export const INSTRUCTIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_instructions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id            TEXT NOT NULL,
  author             TEXT NOT NULL DEFAULT 'user',
  text               TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  delivered_at       TEXT,
  delivered_session  TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_instructions_pending ON task_instructions(task_id, delivered_at);
`

export function ensureInstructionsSchema(db: Database): void {
  db.exec(INSTRUCTIONS_SCHEMA_SQL)
}

// ─── Unos ────────────────────────────────────────────────────────────────────

export type ParsedInstruction =
  | { ok: true; text: string; author: string }
  | { ok: false; error: string }

/** Tijelo `POST /api/tasks/:id/uputa`: `{text|uputa, author|by?}`. */
export function parseInstructionInput(body: unknown): ParsedInstruction {
  const b = (body && typeof body === 'object') ? body as Record<string, unknown> : {}
  const raw = b.text ?? b.uputa
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return { ok: false, error: 'Uputa je prazna — pošalji {"text":"…"}' }
  if (text.length > INSTRUCTION_MAX_CHARS) {
    return { ok: false, error: `Uputa je preduga (${text.length} > ${INSTRUCTION_MAX_CHARS} znakova)` }
  }
  const rawAuthor = b.author ?? b.by
  const author = (typeof rawAuthor === 'string' ? rawAuthor.trim() : '').slice(0, 64) || 'user'
  return { ok: true, text, author }
}

// ─── Spremište ───────────────────────────────────────────────────────────────

export function addInstruction(db: Database, taskId: string, author: string, text: string): InstructionRow {
  return db.query(
    `INSERT INTO task_instructions (task_id, author, text) VALUES (?, ?, ?) RETURNING *`
  ).get(taskId, author, text) as InstructionRow
}

export function listInstructions(db: Database, taskId: string, opts: { undeliveredOnly?: boolean } = {}): InstructionRow[] {
  const where = opts.undeliveredOnly ? 'AND delivered_at IS NULL' : ''
  return db.query(
    `SELECT * FROM task_instructions WHERE task_id = ? ${where} ORDER BY id`
  ).all(taskId) as InstructionRow[]
}

/**
 * Atomično preuzimanje: jedan UPDATE … RETURNING označava i vraća točno one upute koje su
 * bile nedostavljene. Dva usporedna hooka (npr. usporedni alati) ne mogu dostaviti istu
 * uputu dvaput — drugi dobije prazan popis.
 */
export function claimUndelivered(db: Database, taskId: string, session: string | null): InstructionRow[] {
  const now = new Date().toISOString()
  const rows = db.query(
    `UPDATE task_instructions SET delivered_at = ?, delivered_session = ?
     WHERE task_id = ? AND delivered_at IS NULL RETURNING *`
  ).all(now, session || null, taskId) as InstructionRow[]
  return rows.sort((a, b) => a.id - b.id)
}

export function instructionCounts(db: Database, taskId: string): { total: number; undelivered: number } {
  const r = db.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN delivered_at IS NULL THEN 1 ELSE 0 END), 0) AS undelivered
     FROM task_instructions WHERE task_id = ?`
  ).get(taskId) as { total: number; undelivered: number }
  return { total: Number(r.total), undelivered: Number(r.undelivered) }
}

/** Brojači za cijelu ploču u jednom upitu: `{TASK-1: {total, undelivered}}`. */
export function instructionSummary(db: Database): Record<string, { total: number; undelivered: number }> {
  const rows = db.query(
    `SELECT task_id, COUNT(*) AS total, SUM(CASE WHEN delivered_at IS NULL THEN 1 ELSE 0 END) AS undelivered
     FROM task_instructions GROUP BY task_id`
  ).all() as { task_id: string; total: number; undelivered: number }[]
  const out: Record<string, { total: number; undelivered: number }> = {}
  for (const r of rows) out[r.task_id] = { total: Number(r.total), undelivered: Number(r.undelivered) }
  return out
}

// ─── Tekst za agenta ─────────────────────────────────────────────────────────

function localTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleString('hr-HR', {
    timeZone: 'Europe/Zagreb', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

export function formatForAgent(taskId: string, rows: InstructionRow[]): string {
  if (!rows.length) return ''
  const lines = [
    `📨 DODATNE UPUTE ZA ${taskId} — stigle su DOK RADIŠ (od korisnika/REGOČ-a, preko TaskManagera).`,
    'Imaju prednost pred ranijim dijelom opisa zadatka ako mu proturječe. Postupi po njima.',
    '',
  ]
  for (const r of rows) {
    lines.push(`• Uputa #${r.id} (${r.author}, ${localTime(r.created_at)}):`)
    lines.push(r.text.split('\n').map(l => `  ${l}`).join('\n'))
  }
  const ids = rows.map(r => `#${r.id}`).join(', ')
  lines.push('')
  lines.push(`POTVRDI PRIMITAK u sljedećoj bilješci (PUT progressNotes): „uputa ${ids} primljena" + što mijenjaš.`)
  lines.push(`Primjer: uputa #${rows[0].id} primljena — …`)
  return lines.join('\n')
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function hookOutput(eventName: string, text: string): string | null {
  if (!text || !(HOOK_EVENTS as readonly string[]).includes(eventName)) return null
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } })
}

export interface HookDeps {
  env: Record<string, string | undefined>
  stdin: string
  fetchFn?: typeof fetch
  baseUrl?: string
  timeoutMs?: number
}

/**
 * Cijela logika hooka, bez I/O-a procesa (stdin/stdout/exit predaje ljuska hooka).
 * Vraća JSON za stdout ili `null` (ništa za ispis). NIKAD ne baca.
 */
export async function runInstructionHook(deps: HookDeps): Promise<string | null> {
  try {
    // REGOČ spawn nosi REGOC_TASK_ID; samostalni paket (TaskManagerAI) TM_TASK_ID.
    const taskId = (deps.env.REGOC_TASK_ID || deps.env.TM_TASK_ID || '').trim()
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) return null

    let input: Record<string, unknown> = {}
    try { input = JSON.parse(deps.stdin || '{}') } catch { /* pokvaren stdin ne smije ugasiti dostavu */ }
    const eventName = typeof input.hook_event_name === 'string' ? input.hook_event_name : 'PostToolUse'
    // Nepodržan događaj NE preuzima: uputa bi bila označena kao dostavljena, a model je ne bi vidio.
    if (!(HOOK_EVENTS as readonly string[]).includes(eventName)) return null
    const session = typeof input.session_id === 'string' ? input.session_id : null

    const base = (deps.baseUrl || deps.env.REGOC_TASKS_URL || deps.env.TM_URL
      || `http://localhost:${deps.env.TM_PORT || '17781'}`).replace(/\/+$/, '')
    const f = deps.fetchFn || fetch
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? HOOK_TIMEOUT_MS)
    let data: any
    try {
      const res = await f(`${base}/api/tasks/${encodeURIComponent(taskId)}/upute/preuzmi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-regoc-hook': 'task-instructions' },
        body: JSON.stringify({ session }),
        signal: ctl.signal,
      })
      if (!res.ok) return null
      data = await res.json()
    } finally {
      clearTimeout(timer)
    }
    const rows: InstructionRow[] = Array.isArray(data?.instructions) ? data.instructions : []
    return hookOutput(eventName, formatForAgent(taskId, rows))
  } catch {
    return null
  }
}
