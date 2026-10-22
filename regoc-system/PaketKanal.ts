/**
 * TASK-5285 (node-A) → glavni sustav TASK-5323: izlazni Telegram kanal TaskManagerAI paketa na
 * istom stroju (Config → Telegram ploče). Izvor je SAMO kad stroj nema vlastitu datoteku bota
 * (`~/.claude/telegram.json`) — glavni je ima, pa se ondje paket ni ne pita.
 * Token ostaje u spremištu tajni paketa; ovdje živi samo u memoriji procesa, nikad u ispisu.
 */
import { join } from 'path'

export type PaketKanal = { token: string; chatId: string; stil: string; oblikuj: (t: string, o?: any) => string }

/** Token za slanje: datoteka stroja ima prednost; paket se pita tek kad datoteke nema. */
export function tokenKanala(tokenDatoteke: string | null, paket: () => PaketKanal | null): string | null {
  return tokenDatoteke || paket()?.token || null
}

/**
 * Chat za poruku. Bez kanala paketa: chat poruke ili fallback grupa (staro ponašanje).
 * S kanalom paketa: fallback grupa glavnog sustava nije naša — poruka bez chata (ili s tim
 * fallbackom) ide u chat koji je vlasnik upisao na ploči.
 */
export function chatZaPoruku(msgChat: unknown, pk: PaketKanal | null, fallback: number): number {
  if (typeof msgChat === 'number' && !(pk && msgChat === fallback)) return msgChat
  if (pk && pk.chatId !== '' && Number.isFinite(Number(pk.chatId))) return Number(pk.chatId)
  return fallback
}

/** Kanal paketa iz `<TM_PAKET_DIR|~/TaskManagerAI>/src/IzlazniKanal.ts` (kanalZaDaemon). */
export function ucitajKanalPaketa(home: string, env: Record<string, string | undefined> = process.env): PaketKanal | null {
  const dir = env.TM_PAKET_DIR || join(home, 'TaskManagerAI')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(join(dir, 'src', 'IzlazniKanal.ts')).kanalZaDaemon() ?? null
}

/** Čita se svježe najviše jednom u minuti, pa isključenje/promjena na ploči vrijedi bez restarta. */
export function createPaketKanalReader(o: {
  ucitaj: () => PaketKanal | null
  sada?: () => number
  log?: (s: string) => void
  ttlMs?: number
}): () => PaketKanal | null {
  const sada = o.sada ?? Date.now
  const ttl = o.ttlMs ?? 60_000
  let kes: { k: PaketKanal | null; t: number } | null = null
  return () => {
    if (kes && sada() - kes.t < ttl) return kes.k
    let k: PaketKanal | null = null
    try { k = o.ucitaj() ?? null } catch (e) {
      o.log?.(`  ⚠️ [user-flush] kanal paketa nedostupan: ${String(e).substring(0, 120)}`)
    }
    kes = { k, t: sada() }
    return k
  }
}
