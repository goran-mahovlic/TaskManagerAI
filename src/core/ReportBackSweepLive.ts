/**
 * ReportBackSweepLive — pogonske ovisnosti za pometnju dojava (U4 / TASK-4264).
 *
 * `ReportBackTask.runReportBackSweep` je čista logika s ubrizganim ovisnostima; ovdje su te
 * ovisnosti spojene na stvarni svijet: ploču (TaskManagerSQL), Telegram i dnevnik poslanih.
 * JEDNA izvedba, dva pozivatelja — TaskWebUI (poslije svakog zatvaranja zadatka) i
 * `tools/lanac-otvori.ts --provjeri` (ručno/cron dohvaćanje). Pravilo koje živi u dvije
 * preslike prestaje biti isto pravilo (ADR-0004).
 *
 * ZAŠTO `curl`, A NE `fetch`: pometnja je sinkrona (sud i slanje moraju biti u istom koraku
 * da dnevnik ne zaostane za slanjem), a `Bun.spawnSync` s `--data-urlencode` je i jedini
 * oblik slanja koji je Malik odobrio (TASK-2565): goli `-d` pušta korisnički tekst da ubaci
 * dodatne parametre u Telegram API poziv (`&chat_id=…` preusmjeri poruku u drugu grupu).
 *
 * Autorica: Kosjenka (Architect), TASK-4264.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import {
  CLOSED_STATUSES, isReportBackTask, runReportBackSweep,
  type ReportBackTaskView, type SweepDeps, type SweepResult,
} from './ReportBackTask'

const HOME = process.env.HOME || homedir()

/** Dnevnik isporučenih poruka — jedini izvor istine o tome je li korisnik nešto DOBIO. */
export function sentLogPath(): string {
  return process.env.REGOC_REPORT_BACK_LOG || join(HOME, '.claude/regoc/data/report_back_sent.jsonl')
}

/** Postavke bota čita samo ova funkcija; vrijednost nikad ne izlazi iz modula. */
function telegramToken(): string | null {
  try {
    const cfg = JSON.parse(readFileSync(join(HOME, '.claude', 'telegram.json'), 'utf-8'))
    return cfg?.botToken || null
  } catch { return null }
}

/**
 * Pošalji poruku. `true` SAMO na potvrđenu isporuku (`ok:true` iz Telegram API-ja) —
 * neisporučena poruka koja se knjiži kao poslana je tiši gubitak od nikakve.
 */
export function sendTelegramSync(chatId: number, text: string): boolean {
  const token = telegramToken()
  if (!token) return false
  try {
    const r = Bun.spawnSync([
      'curl', '-m', '15', '-s', `https://api.telegram.org/bot${token}/sendMessage`,
      '-d', `chat_id=${chatId}`,
      '--data-urlencode', `text=${text}`,
    ], { stdout: 'pipe', stderr: 'ignore', timeout: 20000 })
    const out = new TextDecoder().decode(r.stdout || new Uint8Array())
    return JSON.parse(out || '{}')?.ok === true
  } catch { return false }
}

/** Minimalno sučelje ploče — koliko pometnji treba i ništa više. */
export interface BoardLike {
  getTasks(filter?: any): any[]
  getTask(id: string): any
  updateTask(id: string, updates: any): any
}

export interface LiveSweepOptions {
  log?: (m: string) => void
  /** Za probu: ne šalji stvarno, nego zabilježi (nadjačava pogonsko slanje). */
  send?: (chatId: number, text: string) => boolean
}

export function buildLiveDeps(board: BoardLike, opts: LiveSweepOptions = {}): SweepDeps {
  const log = opts.log ?? (m => console.warn(`[report-back] ${m}`))
  const path = sentLogPath()
  return {
    listOpenReportBacks: () => {
      const svi = board.getTasks({ status: ['pending', 'in_progress', 'blocked'] }) || []
      return svi.filter((t: any) => isReportBackTask(t?.tags)) as ReportBackTaskView[]
    },
    getTask: id => board.getTask(id),
    send: opts.send ?? sendTelegramSync,
    close: (id, resultSummary) => {
      // `blocked` → `completed` je zabranjen prijelaz (ValidStatusTransitions), pa ide
      // preko `in_progress`. Isti korak koji agenti moraju raditi ručno (v. memoriju
      // `taskmanager-put-state-quirk`) — ovdje je izveden jednom, na jednom mjestu.
      const t = board.getTask(id)
      if (t && t.status !== 'in_progress') board.updateTask(id, { status: 'in_progress' })
      board.updateTask(id, { status: 'completed', resultSummary })
    },
    alreadySent: id => {
      try {
        if (!existsSync(path)) return false
        const txt = readFileSync(path, 'utf-8')
        for (const line of txt.split('\n')) {
          if (!line.trim()) continue
          try { if (JSON.parse(line)?.id === id) return true } catch { /* neispravan redak */ }
        }
        return false
      } catch { return false }
    },
    markSent: (id, chatId, text) => {
      try {
        mkdirSync(dirname(path), { recursive: true })
        appendFileSync(path, JSON.stringify({ id, chatId, ts: new Date().toISOString(), len: text.length }) + '\n')
      } catch (e) { log(`dnevnik poslanih nije zapisan (${String(e).slice(0, 120)}) — moguća druga poruka!`) }
    },
    log,
  }
}

/** Jedan prolaz pometnje nad pravom pločom. Nikad ne baca — pometnja ne smije rušiti PUT. */
export function sweepReportBack(board: BoardLike, opts: LiveSweepOptions = {}): SweepResult {
  try {
    return runReportBackSweep(buildLiveDeps(board, opts))
  } catch (e) {
    ;(opts.log ?? (m => console.warn(`[report-back] ${m}`)))(`pometnja pala: ${String(e).slice(0, 300)}`)
    return { fired: [], held: [] }
  }
}

/** Je li status zatvoren — za pozivatelje koji ne uvoze `ReportBackTask` izravno. */
export function isClosedStatus(s?: string | null): boolean {
  return CLOSED_STATUSES.has(String(s || '').trim().toLowerCase())
}
