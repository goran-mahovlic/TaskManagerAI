/**
 * PravilaSustava — gdje daemon nalazi pravila sustava (GEMINI.md), TASK-5793.
 *
 * Putanja je bila samo `~/app/regoc_system/GEMINI.md` — raspored glavnog čvora. Na čvoru paketa
 * (macOS) te mape nema, pa je daemon pri svakom startu javljao „GEMINI.md not found" i radio bez
 * pravila. Komplet sad nosi vlastiti GEMINI.md (u `$TM_SUSTAV_DIR`, iz instalacija.env), a
 * redoslijed čuva glavni čvor kakav jest:
 *   1. `TM_PRAVILA` — izričita putanja;
 *   2. `~/app/regoc_system/GEMINI.md` — glavni čvor;
 *   3. `$TM_SUSTAV_DIR/GEMINI.md` — instalirani komplet;
 *   4. `GEMINI.md` uz sam modul kompleta.
 */
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export function nadjiPravila(
  env: Record<string, string | undefined> = process.env, mapaKompleta: string = import.meta.dir,
): string | null {
  const home = env.HOME || homedir()
  const kandidati = [
    env.TM_PRAVILA,
    join(home, 'app', 'regoc_system', 'GEMINI.md'),
    env.TM_SUSTAV_DIR ? join(env.TM_SUSTAV_DIR, 'GEMINI.md') : undefined,
    join(mapaKompleta, 'GEMINI.md'),
  ]
  for (const p of kandidati) if (p && existsSync(p)) return p
  return null
}
