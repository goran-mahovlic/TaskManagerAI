/**
 * TmpOkolina — kamo idu privremene datoteke kritičara (TASK-5336/5338 glavnog sustava,
 * prijenos u paket TASK-5618).
 *
 * Kritičar naredbe provjere (`bun test` → `mkdtemp(tmpdir())`) vrti s naslijeđenim TMPDIR-om.
 * Na stroju gdje je /tmp mali tmpfs (glavni sustav: 100 MB) to je pun disk i ENOSPC LAŽNI pad —
 * presuda ne smije ovisiti o tome koliko je mjesta ostalo u /tmp. Zato svaka naredba suda dobiva
 * vlastitu mapu pod korijenom paketa, a mapa se nakon suda briše.
 *
 * Raspored (korijen = `TM_TMP_ROOT` ili `<TM_HOME>/tmp`):
 *   kritičar → <korijen>/ispitno/kriticar/<taskId>
 *   pip      → <korijen>/predmemorija/pip
 *
 * Fail-open: ako se mapa ne može stvoriti, vraća se prazna okolina — sud ide dalje s
 * naslijeđenim TMPDIR-om; puni disk ne smije zaustaviti ploču.
 */
import { mkdirSync, rmSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { TM_ROOT } from './paths'

type Env = Record<string, string | undefined>

export function tmpKorijen(env: Env = process.env): string {
  return env.TM_TMP_ROOT || join(TM_ROOT, 'tmp')
}

/** Jedna sastavnica putanje: bez kose crte i bez `..` — ID ne smije izaći iz korijena. */
function sastavnica(s: string): string {
  const t = s.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/\.{2,}/g, '_').replace(/^\.+/, '_')
  return t || '_'
}

/** TASK-5338: TMPDIR koji vodi u /tmp (ili ga nema) — ne nasljeđuje se u naredbu suda. */
export function tmpUTmpu(v: string | undefined): boolean {
  return !v || v === '/tmp' || v === '/tmp/' || v.startsWith('/tmp/')
}

export function tmpMapaKriticara(taskId: string | null | undefined, korijen = tmpKorijen()): string {
  return join(korijen, 'ispitno', 'kriticar', taskId ? sastavnica(String(taskId)) : 'bez-zadatka')
}

/** Korijen stabla iz mape kritičara (<korijen>/ispitno/kriticar/<taskId>). */
export function korijenIzMapeKriticara(dir: string): string {
  return dirname(dirname(dirname(dir)))
}

/**
 * Stvori mapu i vrati varijable koje je usmjeravaju. TMPDIR čitaju bun (`os.tmpdir()`),
 * node, python (`tempfile`), mktemp; BUN_TMPDIR bunx/instalacija; TMP/TEMP ostali alati.
 */
export function tmpOkolina(dir: string, korijen = tmpKorijen()): Record<string, string> {
  try {
    mkdirSync(dir, { recursive: true })
    const pip = join(korijen, 'predmemorija', 'pip')
    mkdirSync(pip, { recursive: true })
    return { TMPDIR: dir, BUN_TMPDIR: dir, TMP: dir, TEMP: dir, PIP_CACHE_DIR: pip }
  } catch {
    return {}
  }
}

/** Obriši privremenu mapu — samo strogo unutar korijena (nikad sam korijen). */
export function pocistiTmp(dir: string, korijen = tmpKorijen()): boolean {
  const k = resolve(korijen)
  const d = resolve(dir)
  if (!d.startsWith(k + sep)) return false
  try {
    rmSync(d, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}
