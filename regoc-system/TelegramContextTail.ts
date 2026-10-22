/**
 * TelegramContextTail — Opcija B iz istraživanja TASK-4761 (08.09.2026).
 *
 * PROBLEM: kad je zadatak u TaskManageru dodijeljen `regoc` (ili bilo kojem agentu) i treba
 * se javiti natrag u Telegram razgovor iz kojeg je nastao, taj razgovor "ne poznaje" — spawn
 * dobiva potpuno prazan, izoliran kontekst. Dokazan slučaj (TASK-4757/4760, Intergalaktik
 * grupa, 08.09.2026.): agent je ručno prepisao sažetak razgovora u opis zadatka jer sustav to
 * ne radi sam.
 *
 * ZAŠTO NE `--resume` PRAVE SESIJE (odbačena opcija A). TaskManager spawn namjerno dobiva
 * SVAKI PUT nov `--session-id` (RegocDaemon.ts, M6/TASK-4626) jer paralelno vrti do
 * `MAX_AGENT_CONCURRENT` zadataka — dijeljenje jedne sesijske datoteke između procesa bi je
 * pokvarilo (isprepleteni upisi, dva procesa u isti JSONL). Telegram-direktni put
 * (`telegram_agent.ts`) smije `--resume` jer ima red po chatu koji obrađuje JEDNU poruku
 * odjednom — to jamstvo TaskManager spawn nema, i graditi novu cross-process bravu je rizičnije
 * od onoga što ovaj modul radi.
 *
 * RJEŠENJE (opcija B): kontekst putuje TEKSTOM, ne živom sesijom — durabilno, radi i
 * paralelno, radi i nakon restarta (isti princip kao `PromptProjectBlock.buildProjectTail` i
 * `resumeBriefTail`).
 *
 * KAKO ZADATAK DOBIVA CHAT: oznaka `chat:<chatId>` u `tags`. Ulazna vrata (`IngestGateLive`
 * put u RegocDaemon.ts `delegateToAgent`) je upisuju SAME kad zadatak nastaje iz Telegram
 * poruke. Agent koji ručno stvara zadatak (`POST /api/tasks`, npr. REGOČ unutar svoje
 * Telegram-resumed sesije) mora je dodati sam — uputa je u `groupContextPrefix`
 * (telegram_agent.ts), koja agentu govori i vlastiti chatId.
 *
 * Autor: REGOČ, TASK-4761.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()
export const CHAT_SESSIONS_PATH = join(HOME, '.claude/tools/Telegram/chat_sessions.json')
export const MESSAGES_DB_PATH = join(HOME, '.claude/regoc/messages.db')

const RE_CHAT_TAG = /^chat:(-?\d+)$/

/** Izvuci chatId iz oznaka zadatka; `null` kad zadatak nema takvu oznaku. */
export function chatIdFromTags(tags: unknown): string | null {
  if (!Array.isArray(tags)) return null
  for (const t of tags) {
    const m = RE_CHAT_TAG.exec(String(t ?? '').trim())
    if (m) return m[1]
  }
  return null
}

interface ChatSessionInfo {
  sessionId?: string
  lastActivity?: string
  messageCount?: number
  lastTopics?: string
}

function readChatSessionInfo(chatId: string, path: string): ChatSessionInfo | null {
  try {
    if (!existsSync(path)) return null
    const all = JSON.parse(readFileSync(path, 'utf-8'))
    const info = all?.[chatId]
    return info && typeof info === 'object' ? info : null
  } catch {
    return null
  }
}

interface PorukaRedak { from: string; content: string; ts: string }

/** Zadnjih `limit` poruka iz `messages` tablice za taj `chat_id` (stvarni tekst, ne sažetak). */
function readRecentMessages(chatId: string, dbPath: string, limit = 6): PorukaRedak[] {
  const n = Number(chatId)
  if (!Number.isFinite(n)) return []
  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const rows = db.query(`
      SELECT from_agent, content, created_at FROM messages
      WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(n, limit) as any[]
    return rows.reverse().map(r => ({
      from: String(r.from_agent || '?'),
      content: String(r.content || ''),
      ts: String(r.created_at || ''),
    }))
  } catch {
    return []
  } finally {
    try { db?.close() } catch { /* ni zatvaranje ne smije baciti */ }
  }
}

const MAX_TOPICS_CHARS = 1200
const MAX_MSG_CHARS = 400

export interface ChatContextOpcije {
  sessionsPath?: string
  dbPath?: string
  poruka?: number
}

/**
 * Sažetak razgovora iz kojeg je zadatak nastao — dodaje se na kraj prompta agentu.
 * Nikad ne baca; prazan niz kad zadatak nema `chat:<id>` oznaku ili nema podataka (fail-safe,
 * isti princip kao svaki drugi *Tail u RegocDaemon.ts).
 */
export function chatContextTail(tags: unknown, opcije: ChatContextOpcije = {}): string {
  const chatId = chatIdFromTags(tags)
  if (!chatId) return ''
  try {
    const info = readChatSessionInfo(chatId, opcije.sessionsPath || CHAT_SESSIONS_PATH)
    const recent = readRecentMessages(chatId, opcije.dbPath || MESSAGES_DB_PATH, opcije.poruka ?? 6)
    if (!info?.lastTopics && !recent.length) return ''

    const dijelovi: string[] = []
    if (info?.lastTopics) {
      dijelovi.push(`**Zadnje teme razgovora:** ${info.lastTopics.slice(0, MAX_TOPICS_CHARS)}`)
    }
    if (recent.length) {
      const linije = recent.map(m =>
        `- [${m.ts}] ${m.from}: ${m.content.replace(/\n/g, ' ').slice(0, MAX_MSG_CHARS)}`)
      dijelovi.push(`**Zadnjih ${recent.length} poruka u razgovoru:**\n${linije.join('\n')}`)
    }
    if (!dijelovi.length) return ''

    return `\n\n## KONTEKST RAZGOVORA (chat ${chatId}) — odavde je zadatak nastao\n${dijelovi.join('\n\n')}\n\n` +
      `Ovo NIJE ista sesija (svaki zadatak dobiva vlastitu, izoliranu) — ovo je zapis onoga što je ` +
      `prethodilo, da ne moraš pitati iznova. Odgovor i dalje javljaš kroz TaskManager\n` +
      `(\`resultSummary\`), Klaudio/Stribor ga vraćaju u isti razgovor preko \`chat_id\` na poruci.\n`
  } catch {
    return ''
  }
}
