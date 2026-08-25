import { TM_ROOT } from './paths'
import os from 'os'
/**
 * PauseControl — ručna kočnica nad radom REGOČ-a (TASK-3047).
 *
 * ZAŠTO: Goranov zahtjev 29.07.2026. — „ako vidim da nešto nije kako treba, hoću u
 * TaskManageru kliknuti pauzu i to zaustavlja rad; naravno, treba i gumb nastavi."
 * Do sada je jedini način zaustavljanja bio ubiti daemon, a to zadatke ostavlja u
 * `cancelled` (terminalno, bez povratka) i pobije SVE spawnove, i one ispravne.
 *
 * DVIJE RAZINE:
 *   • GLOBALNA pauza — zaustavlja auto-exec u cjelini i prekida sve tekuće spawnove.
 *     Živi u datoteci jer je čitaju TRI procesa (RegocDaemon, TaskWebUI, alati) i mora
 *     preživjeti restart bilo kojeg od njih.
 *   • PAUZA ZADATKA — `tasks.paused` u regoc.db; zadatak zadržava svoj status
 *     (`pending`/`in_progress`), samo ga auto-exec preskače, a tekući spawn se prekida.
 *
 * ZAŠTO NE NOVI STATUS `paused`: status je konačni automat s provjerom prijelaza i
 * `cancelled`/`completed` su terminalni. Pauza je ortogonalna dimenzija — zadatak koji je
 * bio `in_progress` mora se moći vratiti u `in_progress`, a kroz automat bi taj povratak
 * bio ili zabranjen ili bi tražio nova pravila prijelaza. Zastavica uz status čuva
 * povijest i ne dira ničiju logiku statusa.
 *
 * FAIL-OPEN: neispravna/nečitljiva datoteka stanja = NIJE pauzirano. Kočnica koja se
 * sama zaglavi zbog pokvarenog JSON-a gora je od kočnice koja se ne aktivira.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

const HOME = process.env.HOME || os.homedir()

/** Testni harnessi preusmjeravaju stanje da ne diraju živu kočnicu. */
export const PAUSE_STATE_FILE =
  process.env.REGOC_PAUSE_STATE || join(TM_ROOT, 'data/pause.state.json')

export interface PauseState {
  paused: boolean
  /** Tko je zadnji pritisnuo pauzu/nastavak. */
  by: string
  /** ISO vrijeme zadnje promjene. */
  at: string
  /** Slobodan tekst — zašto je zaustavljeno (ide u log i u zapis zadatka). */
  reason: string
}

const NOT_PAUSED: PauseState = { paused: false, by: '', at: '', reason: '' }

export function readPauseState(file: string = PAUSE_STATE_FILE): PauseState {
  try {
    if (!existsSync(file)) return { ...NOT_PAUSED }
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    return {
      paused: raw?.paused === true,
      by: typeof raw?.by === 'string' ? raw.by : '',
      at: typeof raw?.at === 'string' ? raw.at : '',
      reason: typeof raw?.reason === 'string' ? raw.reason : '',
    }
  } catch {
    return { ...NOT_PAUSED }   // fail-open
  }
}

/** Zapiši stanje atomično (tmp + rename) — čitatelj nikad ne vidi pola JSON-a. */
export function writePauseState(
  next: { paused: boolean; by?: string; reason?: string },
  file: string = PAUSE_STATE_FILE,
): PauseState {
  const state: PauseState = {
    paused: next.paused === true,
    by: next.by || 'user',
    at: new Date().toISOString(),
    reason: next.reason || '',
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
    renameSync(tmp, file)
  } catch (e) {
    throw new Error(`Zapis stanja pauze nije uspio (${file}): ${e}`)
  }
  return state
}

export function isGloballyPaused(file: string = PAUSE_STATE_FILE): boolean {
  return readPauseState(file).paused
}

/** Kratki opis za log/UI: „PAUZA (goran, 14:02) — razlog". */
export function describePause(s: PauseState): string {
  if (!s.paused) return 'rad teče'
  const when = s.at ? new Date(s.at).toLocaleString('hr-HR') : '?'
  return `PAUZA (${s.by || '?'}, ${when})${s.reason ? ` — ${s.reason}` : ''}`
}
