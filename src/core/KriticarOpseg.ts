/**
 * KriticarOpseg — što kritičar SMIJE pokrenuti (TASK-5235, vlasnik, 04.10.2026.)
 *
 * ZAŠTO POSTOJI: `CriticGate` skup izmjena gradi samo po vremenu izmjene (mtime > start
 * spawna) u nadziranim stablima. Ne zna TKO je datoteku dirao ni ŠTO ona jest. Izmjereno
 * 04.10.2026. — četiri lažna CRITIC_FAILED u jednom danu, posao je svaki put bio ispravan:
 *   • TASK-5210, TASK-5215: `bun build`/`bun test` nad SNIMKAMA koda u docs/ (importi se
 *     izvan izvornog stabla ne razrješavaju — „Could not resolve ./StaleWatchdog"),
 *   • TASK-5217: tuđi test koji je usporedno pisala TASK-5215 (modul još nije postojao),
 *   • TASK-5220: tuđi test iz TaskManagerMD koji je padao i prije (TASK-5204/5211).
 * `concurrentSpawns` to nije hvatao: broji spawnove u ISTOM workTreeju, a pisci su bili u
 * različitim stablima i pisali u isti korijen orkestratora. Interaktivne sesije nisu ni spawnovi.
 *
 * PRAVILO (dizajn: REGOČ docs/KRITICAR-opseg-provjera.md):
 *   (a) propisana provjera zadatka (`[PROVJERA] cmd:`) — uvijek,
 *   (b) raščlamba/test samo za datoteke koje je OVAJ spawn dirao — po transkriptu spawna,
 *   (c) snimke koda u dokumentaciji se ne pokreću,
 *   (d) pad koji je postojao i prije starta = zatečen (napomena, ne CRITIC_FAILED).
 *
 * Čiste funkcije osim čitanja transkripta; nikad ne bacaju.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'path'

const HOME = process.env.HOME || homedir()

export type OpsegMode = 'off' | 'shadow' | 'on'
export type RazlogIzvan = 'snimka-koda' | 'nije-dirao'

/** Ekstenzije koje kritičar pokreće/raščlanjuje — samo za njih vrijedi izuzeće snimke. */
const KOD_EKSTENZIJE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.json'])

// ─── (c) Snimke koda u dokumentaciji ─────────────────────────────────────────

/**
 * Je li put snimka/kopija koda u dokumentaciji: `docs/kod/**`, `docs/prijedlozi/**` ili
 * `docs/**​/snimka*`. Takva datoteka je PRILOG izvještaja, a ne izvršni kod: importi joj
 * pokazuju na module izvornog stabla, pa `bun build` nad njom pada neovisno o kvaliteti rada.
 */
export function jeSnimkaKoda(path: string): boolean {
  const p = path.replace(/\\/g, '/')
  const mape = p.split('/').slice(0, -1)
  // Mapa `snimka*`/`snimke`/`snapshot*` bilo gdje (replay: tools/telegram_identity_eval/
  // snapshot/ kod TASK-5104). Ime DATOTEKE se ne gleda (`kpi-snapshot.ts` je pravi alat).
  if (mape.some((seg) => /^(snimk|snapshot)/i.test(seg))) return true
  const i = p.indexOf('/docs/')
  if (i < 0) return false
  const ispod = p.slice(i + '/docs/'.length).split('/')
  if (ispod.length < 2) return false // datoteka izravno u docs/ nije u podmapi snimki
  return ispod[0] === 'kod' || ispod[0] === 'prijedlozi'
}

const RELATIVNI_IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"\n]+)['"]/g
const NASTAVCI_IMPORTA = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.js']

/**
 * Razrješavaju li se relativni importi datoteke? Za kod pod `docs/` izvan izričitih mapa
 * snimki (nalog vlasnika: „ili ih parsirati samo ako im se importi razrješavaju"). Replay
 * 30 dana: docs/architecture/<zadatak>/*.ts i docs/katalog/adr0016_kod/ (TASK-5028, 5107,
 * 5135, 5140) — kopije modula uz izvještaj, svaka s „Could not resolve ../Modul".
 */
export function importiSeRazrjesavaju(path: string, exists: (p: string) => boolean = existsSync): boolean {
  let tekst: string
  try { tekst = readFileSync(path, 'utf-8') } catch { return true } // nečitljivo → odluči provjera, ne opseg
  const dir = resolve(path, '..')
  for (const m of tekst.matchAll(RELATIVNI_IMPORT_RE)) {
    const cilj = resolve(dir, m[1])
    if (!NASTAVCI_IMPORTA.some((n) => exists(cilj + n))) return false
  }
  return true
}

// ─── (b) Atribucija iz transkripta spawna ────────────────────────────────────

export interface Atribucija {
  /** Transkripti iz kojih je atribucija sastavljena. */
  izvori: string[]
  /** Apsolutni putovi iz `Write`/`Edit`/`MultiEdit`/`NotebookEdit`. */
  pisano: Set<string>
  /** Tekst svih `Bash` naredbi spawna (pisanje kroz ljusku: `cat >`, `sed -i`, `cp`). */
  bash: string[]
}

const ALATI_PISANJA = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * Transkripti jednog spawna: `~/.claude/projects/<slug>/<sid>.jsonl` i podagenti pod
 * `<slug>/<sid>/subagents/*.jsonl`. Session-id daje daemon (`claude --session-id`), pa
 * agent ne bira koji se transkript čita.
 */
export function nadjiTranskripte(sessionId: string, projectsDir = join(HOME, '.claude', 'projects')): string[] {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(sessionId || '')) return []
  const out: string[] = []
  let slugovi: string[] = []
  try { slugovi = readdirSync(projectsDir) } catch { return [] }
  for (const s of slugovi) {
    const glavni = join(projectsDir, s, `${sessionId}.jsonl`)
    if (existsSync(glavni)) out.push(glavni)
    const pod = join(projectsDir, s, sessionId, 'subagents')
    try {
      if (existsSync(pod) && statSync(pod).isDirectory()) {
        for (const f of readdirSync(pod)) if (f.endsWith('.jsonl')) out.push(join(pod, f))
      }
    } catch { /* nečitljiva mapa podagenata nije razlog za pad */ }
  }
  return out
}

/** Sastavi atribuciju; `null` = nijedan transkript nije pročitan (atribucija nedostupna). */
export function citajAtribuciju(transkripti: string[]): Atribucija | null {
  const pisano = new Set<string>()
  const bash: string[] = []
  const izvori: string[] = []
  for (const t of transkripti) {
    let tekst: string
    try { tekst = readFileSync(t, 'utf-8') } catch { continue }
    izvori.push(t)
    for (const red of tekst.split('\n')) {
      if (!red.includes('tool_use')) continue
      let j: any
      try { j = JSON.parse(red) } catch { continue }
      const sadrzaj = j?.message?.content
      if (!Array.isArray(sadrzaj)) continue
      const cwd = typeof j.cwd === 'string' ? j.cwd : ''
      for (const b of sadrzaj) {
        if (b?.type !== 'tool_use') continue
        const ulaz = b.input || {}
        if (ALATI_PISANJA.has(b.name)) {
          const p = ulaz.file_path || ulaz.notebook_path
          if (typeof p === 'string' && p) pisano.add(isAbsolute(p) ? resolve(p) : resolve(cwd || '/', p))
        } else if (b.name === 'Bash' && typeof ulaz.command === 'string') {
          bash.push(ulaz.command)
        }
      }
    }
  }
  return izvori.length ? { izvori, pisano, bash } : null
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Je li spawn dirao datoteku? Izravno pisanje ILI spomen u Bash naredbi — punim putem ili
 * imenom datoteke omeđenim kao riječ puta (`PlocaJezik.ts` NIJE spomen od `Jezik.ts`).
 * Spomen u čitanju (`cat X.ts`) se namjerno računa: datoteka je ionako izmijenjena u
 * prozoru spawna, a agent ju je svjesno dirao — greška je na strani provjere, ne prolaza.
 */
export function pripadaSpawnu(path: string, a: Atribucija): boolean {
  const abs = resolve(path)
  if (a.pisano.has(abs)) return true
  const ime = basename(abs)
  const tilda = abs.startsWith(HOME + '/') ? '~' + abs.slice(HOME.length) : null
  const reIme = new RegExp(`(^|[\\s/'"=>(<])${escapeRe(ime)}(?=$|[\\s'";&|)<>:,])`, 'm')
  for (const cmd of a.bash) {
    if (cmd.includes(abs) || (tilda && cmd.includes(tilda))) return true
    if (cmd.includes(ime) && reIme.test(cmd)) return true
  }
  return false
}

/**
 * Zašto datoteka NE ulazi u provjere (`null` = ulazi). Redoslijed: snimka (vrsta datoteke)
 * → vlastiti korijen (izolirani worktree, u njemu nitko drugi ne piše) → atribucija.
 * Bez atribucije (`null`) vrijedi staro pravilo po mtimeu — fail-closed prema provjeri.
 */
export function razlogIzvanOpsega(path: string, a: Atribucija | null, vlastitiKorijeni: string[]): RazlogIzvan | null {
  if (KOD_EKSTENZIJE.has(extname(path))) {
    if (jeSnimkaKoda(path)) return 'snimka-koda'
    // Ostali kod pod docs/: dokument dok mu se importi ne razrješavaju. Izvan docs/ se
    // ovo NE gleda — pravi modul s krivim importom je pravi kvar i mora pasti.
    if (path.replace(/\\/g, '/').includes('/docs/') && !importiSeRazrjesavaju(path)) return 'snimka-koda'
  }
  const abs = resolve(path)
  if (vlastitiKorijeni.some((k) => k && (abs === resolve(k) || abs.startsWith(resolve(k) + '/')))) return null
  if (!a) return null
  return pripadaSpawnu(abs, a) ? null : 'nije-dirao'
}

// ─── (d) Zatečeni pad ────────────────────────────────────────────────────────

/** Podskup zapisa traga kritičara koji ovaj modul čita. */
export interface LedgerZapis {
  ts: string
  taskId: string
  status: string
  signatures: string[]
  /** `<vrsta>:<relativni put>` provjera koje su PROŠLE (od TASK-5235). */
  prosle?: string[]
  /** Potpis → broj palih testova (od TASK-5235). */
  failCounts?: Record<string, number>
}

export interface ZateceniUlaz {
  signature: string
  kind: string
  /** Cilj relativno na HOME, kako ga piše `failureSignature`. */
  relTarget: string
  failCount?: number
  sinceMs: number
  taskId: string | null
  rows: LedgerZapis[]
  lookbackMs?: number
}

export const ZADANI_ROK_ZATECENOG_MS = 14 * 86_400_000

function zapisSpominje(r: LedgerZapis, kind: string, rel: string): 'pao' | 'prosao' | null {
  if ((r.signatures || []).some((s) => s.startsWith(`${kind}:${rel}:`))) return 'pao'
  if ((r.prosle || []).some((p) => p === `${kind}:${rel}` || p === rel)) return 'prosao'
  return null
}

/**
 * Pad je zatečen kad je ZADNJI zapis prije starta spawna (kod drugog zadatka, unutar roka)
 * koji spominje istu provjeru bio pad s ISTIM potpisom, a palih testova sada nije više.
 * „Zadnji" je bitan: pad koji je netko u međuvremenu popravio (zapis `prosle`) više nije
 * zatečen, pa novi pad s istim potpisom pripada ovom spawnu.
 * Propisana provjera (`task`) nikad nije zatečena — po TDD-u smije padati prije rada.
 */
export function jeZateceniPad(u: ZateceniUlaz): { zatecen: boolean; izvor?: string } {
  if (u.kind === 'task') return { zatecen: false }
  const rok = u.lookbackMs ?? ZADANI_ROK_ZATECENOG_MS
  // Granica „prije" je PRVI trag ovog zadatka, ne start ovog spawna: u krugu popravka bi
  // inače tuđi zapis nastao između krugova (koji bilježi pad što ga je ovaj zadatak sam
  // napravio u 1. krugu) proglasio vlastiti kvar zatečenim. Isti razlog: ako je ovaj
  // zadatak već ranije pao s istim potpisom, pad je njegov.
  let granica = u.sinceMs
  for (const r of u.rows) {
    if (!r || !u.taskId || r.taskId !== u.taskId) continue
    if ((r.signatures || []).includes(u.signature)) return { zatecen: false }
    const t = Date.parse(r.ts)
    if (Number.isFinite(t) && t < granica) granica = t
  }
  let zadnji: { r: LedgerZapis; t: number; kako: 'pao' | 'prosao' } | null = null
  for (const r of u.rows) {
    if (!r || r.taskId === u.taskId) continue
    const t = Date.parse(r.ts)
    if (!Number.isFinite(t) || t >= granica || t < u.sinceMs - rok) continue
    const kako = zapisSpominje(r, u.kind, u.relTarget)
    if (!kako) continue
    if (!zadnji || t >= zadnji.t) zadnji = { r, t, kako }
  }
  if (!zadnji || zadnji.kako !== 'pao') return { zatecen: false }
  if (!zadnji.r.signatures.includes(u.signature)) return { zatecen: false }
  const prije = zadnji.r.failCounts?.[u.signature]
  if (typeof prije === 'number' && typeof u.failCount === 'number' && u.failCount > prije) return { zatecen: false }
  return { zatecen: true, izvor: `${zadnji.r.taskId} ${zadnji.r.ts}` }
}

/** Svi zapisi traga (za zatečeni pad treba i tuđe zadatke). Nikad ne baca. */
export function citajSveZapise(path: string): LedgerZapis[] {
  try {
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf-8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as LedgerZapis } catch { return null } })
      .filter((r): r is LedgerZapis => !!r && Array.isArray(r.signatures))
  } catch { return [] }
}

// ─── Replay nad tragom ───────────────────────────────────────────────────────

/** Raščlani potpis `vrsta:relput:poruka` (za `task` je cilj `stablo$naredba`). */
export function rastaviPotpis(sig: string): { kind: string; rel: string } {
  const i = sig.indexOf(':')
  const kind = sig.slice(0, i)
  const ostatak = sig.slice(i + 1)
  const j = ostatak.indexOf(':')
  return { kind, rel: j >= 0 ? ostatak.slice(0, j) : ostatak }
}

export interface PresudaReplay {
  novo: 'fail' | 'pass'
  zadrzano: string[]
  otpalo: Array<{ sig: string; razlog: RazlogIzvan | 'zatecen'; izvor?: string }>
}

/**
 * Što bi NOVO pravilo reklo o jednom starom `fail` zapisu. Radi samo s onim što trag ima
 * (potpisi), plus transkript spawna. `novo: 'pass'` ovdje znači „nema pada koji obvezuje".
 */
export function presudiZapisReplay(
  row: LedgerZapis,
  a: Atribucija | null,
  sviZapisi: LedgerZapis[],
  home = HOME,
  opts: { sinceMs?: number; lookbackMs?: number; vlastitiKorijeni?: string[] } = {},
): PresudaReplay {
  const zadrzano: string[] = []
  const otpalo: PresudaReplay['otpalo'] = []
  const sinceMs = opts.sinceMs ?? Date.parse(row.ts)
  // Uživo zapis koji se sudi još NE postoji u tragu; u replayu postoji — pa ga (i sve
  // poslije njega) treba maknuti, inače bi vlastiti potpis dokazivao „vlastiti pad".
  const tRow = Date.parse(row.ts)
  sviZapisi = sviZapisi.filter((r) => Date.parse(r.ts) < tRow)
  for (const sig of row.signatures || []) {
    const { kind, rel } = rastaviPotpis(sig)
    if (kind === 'task' || kind === 'doc' || kind === 'doc2') { zadrzano.push(sig); continue }
    const abs = isAbsolute(rel) ? rel : join(home, rel)
    const razlog = razlogIzvanOpsega(abs, a, opts.vlastitiKorijeni || [])
    if (razlog) { otpalo.push({ sig, razlog }); continue }
    const z = jeZateceniPad({ signature: sig, kind, relTarget: rel, sinceMs, taskId: row.taskId, rows: sviZapisi, lookbackMs: opts.lookbackMs })
    if (z.zatecen) { otpalo.push({ sig, razlog: 'zatecen', izvor: z.izvor }); continue }
    zadrzano.push(sig)
  }
  return { novo: zadrzano.length ? 'fail' : 'pass', zadrzano, otpalo }
}

/** Relativni cilj kakav piše `failureSignature` (za zapis `prosle`). */
export function relativnoNaHome(target: string, home = HOME): string {
  return target.startsWith(home) ? relative(home, target) : target
}
