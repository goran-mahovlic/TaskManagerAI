// ─── Zapis razgovora po chatu (ADR-0002 §8) ──────────────────────────────────
// `<korijen>/<kanal>/<chatId>/<YYYY-MM-DD>.jsonl`, jedan redak po smjeru poteza. Bez tajni i
// bez sadržaja memorije (samo broj činjenica). Zapis nikad ne ruši razgovor.
//
// Autorica: Jelena (Engineer), TASK-5277.

import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'

/** Ime mape iz id-a chata — nikad `..` ni kosa crta. */
function sigurnoIme(s: string): string {
  return String(s).replace(/[^\w.-]/g, '_').replace(/^\.+/, '_').slice(0, 80) || '_'
}

export function zapisiPotez(korijen: string, kanal: string, chatId: string, red: Record<string, unknown> & { ts: string }): void {
  try {
    const mapa = join(korijen, sigurnoIme(kanal), sigurnoIme(chatId))
    mkdirSync(mapa, { recursive: true })
    appendFileSync(join(mapa, `${red.ts.slice(0, 10)}.jsonl`), JSON.stringify(red) + '\n', 'utf-8')
  } catch { /* zapis nije vrijedan rušenja odgovora */ }
}

const KANALI = ['telegram', 'signal']

/** Obriši dnevne datoteke starije od `dana`. Vraća broj obrisanih. */
export function ocistiStareZapise(korijen: string, dana: number, sada = Date.now()): number {
  const granica = sada - dana * 86_400_000
  let n = 0
  const popis = (m: string) => { try { return readdirSync(m) } catch { return [] } }
  // Samo mape kanala — u istom korijenu žive i `radni/` i `sesije.json`.
  for (const kanal of popis(korijen).filter(k => KANALI.includes(k))) {
    const mk = join(korijen, kanal)
    try { if (!statSync(mk).isDirectory()) continue } catch { continue }
    for (const chat of popis(mk)) {
      const mc = join(mk, chat)
      for (const f of popis(mc)) {
        if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue
        const p = join(mc, f)
        try {
          if (statSync(p).mtimeMs < granica) { rmSync(p); n++ }
        } catch { /* nestala u međuvremenu */ }
      }
    }
  }
  return n
}
