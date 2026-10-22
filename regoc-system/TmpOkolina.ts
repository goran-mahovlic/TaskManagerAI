/**
 * TmpOkolina — kamo idu privremene datoteke daemona, spawnova i kritičara (TASK-5336).
 *
 * /tmp je tmpfs od 100 MB i nestaje s kontejnerom (CLAUDE.md pravilo 26). Daemon nije
 * postavljao TMPDIR, pa su spawnani agenti i kritičar (`bun test` → `mkdtemp(tmpdir())`)
 * pisali u /tmp. 07.10.2026. bio je 100 % pun i kritičar je rušio TASK-5331, 5327 i 5306
 * s ENOSPC — ne zbog pravih kvarova.
 *
 * Raspored (korijen = `REGOC_TMP_ROOT` ili `~/app/tmp`; stablo ADR-0020 §3.1, TASK-5397):
 *   spawn     → <korijen>/zadaci/<taskId>_<kratko-ime>/tmp   (bez zadatka: servisi/spawn-<agent>/tmp)
 *               kratko ime iz naslova (§9.2, TASK-5408); postojeća mapa TASK-<n> ili TASK-<n>_… ima prednost
 *   kritičar  → <korijen>/ispitno/kriticar/<taskId>      (briše se nakon suda; ostatak čisti tmp_red > 24 h)
 *   servis    → <korijen>/servisi/<servis>/tmp           (daemon: servisi/daemon/tmp)
 *   pip       → <korijen>/predmemorija/pip              (zamjenjivo; briše se samo kod crvenog alarma)
 * Do 09.10.2026. spawn je pisao u <korijen>/<taskId>/, kritičar u <korijen>/kriticar/, pip u
 * <korijen>/pip-cache — zato je na vrhu ~/app/tmp bilo 2803 stavke. Stare mape seli korak 6 ADR-0020.
 *
 * Fail-open: ako se mapa ne može stvoriti, vraća se prazna okolina — spawn i sud idu
 * dalje s naslijeđenim TMPDIR-om; puni disk ne smije zaustaviti ploču.
 */
import { mkdirSync, readdirSync, rmSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { homedir } from 'os'

type Env = Record<string, string | undefined>

export function tmpKorijen(env: Env = process.env): string {
  return env.REGOC_TMP_ROOT || join(env.HOME || homedir(), 'app', 'tmp')
}

/** Jedna sastavnica putanje: bez kose crte i bez `..` — ID ne smije izaći iz korijena. */
function sastavnica(s: string): string {
  const t = s.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/\.{2,}/g, '_').replace(/^\.+/, '_')
  return t || '_'
}

/** TASK-5338: TMPDIR koji vodi u /tmp (ili ga nema) — tmpfs od 100 MB, ne smije se naslijediti. */
export function tmpUTmpu(v: string | undefined): boolean {
  return !v || v === '/tmp' || v === '/tmp/' || v.startsWith('/tmp/')
}

/**
 * ADR-0020 §9.2: kratko ime mape zadatka iz naslova — bez „Agent:” na početku, mala slova, bez
 * dijakritika, crtice, ≤ 30 znakova (reže se na granici riječi). Isto ime na SSD-u i na RAID-u.
 */
const DIJAKRITIKA: Record<string, string> = { č: 'c', ć: 'c', đ: 'd', š: 's', ž: 'z' }
export function slugNaslova(naslov: string, max = 30): string {
  const bez = (naslov || '').replace(/^\s*[\p{L}]+(?:\s[\p{L}]+)?\s*:\s*/u, '')     // „Jelena: …”, „Dorada: Grga — …”
  const s = bez.toLowerCase().replace(/[čćđšž]/g, (c) => DIJAKRITIKA[c]).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (s.length <= max) return s
  const rez = s.slice(0, max + 1)
  const i = rez.lastIndexOf('-')
  return (i > 0 ? rez.slice(0, i) : s.slice(0, max)).replace(/-+$/, '')
}

/** Mapa zadatka u korijenu (zadaci/ ili raid/zadaci/<GGGG>): postojeća s prefiksom `<id>_` ili točno `<id>` ima prednost. */
export function mapaZadatka(korijen: string, id: string, naslov: string): string {
  try {
    // TASK-5414: imenovana TASK-<n>_<ime> ima prednost pred golom TASK-<n> (gola je ostatak agenta)
    const sve = readdirSync(korijen)
    const i = sve.find((x) => x.startsWith(`${id}_`)) ?? sve.find((x) => x === id)
    if (i) return join(korijen, i)
  } catch { /* korijen još ne postoji */ }
  const s = slugNaslova(naslov)
  return join(korijen, s ? `${id}_${s}` : id)
}

export function tmpMapaSpawna(taskId: string | null | undefined, agentId: string, korijen = tmpKorijen(), naslov = ''): string {
  return taskId
    ? join(mapaZadatka(join(korijen, 'zadaci'), sastavnica(String(taskId)), naslov), 'tmp')
    : join(korijen, 'servisi', `spawn-${sastavnica(agentId)}`, 'tmp')
}

export function tmpMapaKriticara(taskId: string | null | undefined, korijen = tmpKorijen()): string {
  return join(korijen, 'ispitno', 'kriticar', taskId ? sastavnica(String(taskId)) : 'bez-zadatka')
}

export function tmpMapaServisa(servis: string, korijen = tmpKorijen()): string {
  return join(korijen, 'servisi', sastavnica(servis), 'tmp')
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
    const env: Record<string, string> = { TMPDIR: dir, BUN_TMPDIR: dir, TMP: dir, TEMP: dir, PIP_CACHE_DIR: pip }
    // TASK-5414: mapa zadatka (<korijen>/zadaci/TASK-<n>_<ime>/tmp) → agent dobiva i njezin roditelj kao REGOC_TASK_DIR
    if (resolve(dirname(dirname(dir))) === resolve(korijen, 'zadaci')) env.REGOC_TASK_DIR = dirname(dir)
    return env
  } catch {
    return {}
  }
}

/**
 * TASK-5414 (QA TASK-5409 N1, N2): rečenica o radnoj mapi za prompt spawna. Sa zadatkom nosi STVARNU
 * putanju (roditelj od TMPDIR) — predložak „zadaci/<zadatak>/” agenti su čitali doslovno i stvarali golu
 * TASK-<n> uz daemonsku TASK-<n>_<ime>. Trajni alati idu u kanonski tmp/tools/ (§9.2), ne tmp/alati/.
 */
export function uputaRadneMape(mapaZadatka: string | null | undefined, home = homedir()): string {
  const gdje = mapaZadatka
    ? `SAMO u ${mapaZadatka}/ (tvoja radna mapa = $REGOC_TASK_DIR, roditelj od $TMPDIR; daemon ju je već stvorio — NE stvaraj drugu mapu ${home}/app/tmp/zadaci/<ID>)`
    : `SAMO u ${home}/app/tmp/zadaci/TASK-<n>_<kratko-ime>/ (ADR-0020 §9.2)`
  return `Radne i privremene datoteke (skupovi, treninzi, zapisi, TMPDIR) ${gdje} — /tmp, nove stvari u ~/.tmp i nove mape izravno u ${home} ili na vrhu ~/app/tmp NESTAJU ili se gube (CLAUDE.md pr. 26). Što trajno izgradiš (venv, model, alat, runner) PRIJE DONE premjesti u ${home}/app/tmp/tools/<ime>/ ili ${home}/app/raid/projekti/<projekt>/, stavi datoteku .trajno (JSON: id, vrsta, svrha, kako_obnoviti), kratki README i upiši u katalog. Brisanje samo kroz branu: bash ~/.claude/regoc/tools/servisi/brana_brisanja.sh <putanja>; veliko ili trajno ide u karantenu (tmp_red.sh karantena).`
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
