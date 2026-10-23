// ─── Antigravity (`agy`) na disku čvora — Config → Prijava (TASK-5738) ───────────────────────
// Način (ključ / Google prijava) živi u ~/.gemini/antigravity-cli/settings.json; token Google
// prijave u datoteci iste mape (SSH oznaka, src/core/Antigravity.ts). Ploča i čarobnjak ne
// čitaju ni ne ispisuju vrijednosti — samo postoji li ključ ili datoteka tokena.
//
// Autorica: Jelena (Engineer), TASK-5738.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  AGY_MAPA, AGY_POSTAVKE, agyDatotekePrijave, agyPrijavljen, nacinAgyja, postaviNacinAgyja, stanjeAgyja,
  type NacinAgyja,
} from './Antigravity'

function citajPostavke(home: string): any {
  try { return JSON.parse(readFileSync(join(home, AGY_POSTAVKE), 'utf-8')) } catch { return null }
}

/** Zapiši način u settings.json agy-ja (ostala polja ostaju; 0600). */
export function zapisiNacinAgyja(home: string, nacin: NacinAgyja): void {
  const mapa = join(home, AGY_MAPA)
  if (!existsSync(mapa)) mkdirSync(mapa, { recursive: true })
  const put = join(home, AGY_POSTAVKE)
  writeFileSync(put, JSON.stringify(postaviNacinAgyja(citajPostavke(home), nacin), null, 2) + '\n', { mode: 0o600 })
  chmodSync(put, 0o600)
}

/** Stanje prijave na disku; `kljuc` = postoji li GEMINI_API_KEY u spremištu (bez vrijednosti). */
export function stanjeAgyjaNaDisku(home: string, kljuc: boolean): { prijavljen: boolean; kako: string; nacin: NacinAgyja } {
  const nacin = nacinAgyja(citajPostavke(home))
  return { ...stanjeAgyja({ nacin, kljuc, token: agyPrijavljen(home, readdirSync) }), nacin }
}

/**
 * Odjava: briše SAMO datoteke tokena (zapisi, razgovori i postavke agy-ja ostaju) i vraća način
 * Googlea. GEMINI_API_KEY se NE dira — dijele ga geminicli i google.
 */
export function odjaviAgy(home: string): void {
  for (const f of agyDatotekePrijave(home, readdirSync)) rmSync(f, { force: true })
  if (existsSync(join(home, AGY_POSTAVKE))) zapisiNacinAgyja(home, 'google')
}
