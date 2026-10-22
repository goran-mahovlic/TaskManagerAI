/**
 * ZadatakKanal — u koju grupu idu izvještaji zadatka (TASK-5420).
 *
 * Zadatak koji je nastao iz telegramske grupe nosi oznaku `chat:<chatId>` (ulazna vrata,
 * REGOČ pri razlaganju, lanac pomoćnika — TASK-4761). Auto-exec ga pokreće BEZ origin-a,
 * pa je izvještaj o završetku dobivao `messages.chat_id = NULL` i user-flush ga je slao na
 * zadanu REGOČ grupu (TASK-5416, 09.10.2026.). Ovdje se origin izvodi iz te oznake.
 *
 * Pravilo: postojeći origin (glas iz Mumblea, ulazna vrata) uvijek ima prednost; bez oznake
 * vraća se `undefined`, dakle sadašnje ponašanje. Čisto, bez I/O-a.
 */
import { oznakeOd } from './TijekPosla'

export interface ZadatakOrigin { chatId: number; voiceRelay: boolean }

const RE_CHAT = /^chat:(-?\d+)$/

/** Chat iz oznake `chat:<id>`; prima JSON niz, pravi niz ili zarezima odvojen tekst. */
export function chatIzOznaka(tags: unknown): number | null {
  let oz: string[]
  try { oz = oznakeOd(tags as any) } catch { return null }
  for (const o of oz) {
    const m = RE_CHAT.exec(o)
    if (!m) continue
    const n = Number(m[1])
    if (Number.isSafeInteger(n) && n !== 0) return n
  }
  return null
}

/** Origin za izvještaje zadatka: zadani origin, inače tekstualni origin grupe iz oznake. */
export function originZaZadatak<T extends ZadatakOrigin>(origin: T | undefined, tags: unknown): T | ZadatakOrigin | undefined {
  if (origin) return origin
  const chatId = chatIzOznaka(tags)
  return chatId === null ? undefined : { chatId, voiceRelay: false }
}

/** Chat za operativni alarm o zadatku (siroče, pozadina-povrat): grupa iz oznake ili zadana. */
export function chatZaAlarm(tags: unknown, zadani: number): number {
  return chatIzOznaka(tags) ?? zadani
}
