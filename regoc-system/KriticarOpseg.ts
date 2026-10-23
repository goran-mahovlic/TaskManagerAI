/**
 * KriticarOpseg — što kritičar SMIJE pokrenuti (TASK-5235, Goran 04.10.2026.)
 *
 * ZAŠTO POSTOJI: `CriticGate` skup izmjena gradi samo po vremenu izmjene (mtime > start
 * spawna) u nadziranim stablima. Ne zna TKO je datoteku dirao ni ŠTO ona jest. Izmjereno
 * 04.10.2026. — četiri lažna CRITIC_FAILED u jednom danu, posao je svaki put bio ispravan:
 *   • TASK-5210, TASK-5215: `bun build`/`bun test` nad SNIMKAMA koda u docs/ (importi se
 *     izvan izvornog stabla ne razrješavaju — „Could not resolve ./StaleWatchdog"),
 *   • TASK-5217: tuđi test koji je usporedno pisala TASK-5215 (modul još nije postojao),
 *   • TASK-5220: tuđi test iz TaskManagerMD koji je padao i prije (TASK-5204/5211).
 * `concurrentSpawns` to nije hvatao: broji spawnove u ISTOM workTreeju, a pisci su bili u
 * različitim stablima i pisali u isti ~/.claude/regoc. Interaktivne sesije nisu ni spawnovi.
 *
 * PRAVILO (dizajn: ~/app/regoc_system/docs/KRITICAR-opseg-provjera.md):
 *   (a) propisana provjera zadatka (`[PROVJERA] cmd:`) — uvijek,
 *   (b) raščlamba/test samo za datoteke koje je OVAJ spawn dirao — po transkriptu spawna,
 *   (c) snimke koda u dokumentaciji se ne pokreću,
 *   (d) pad koji je postojao i prije starta = zatečen (napomena, ne CRITIC_FAILED).
 *
 * Čiste funkcije osim čitanja transkripta; nikad ne bacaju.
 */

import { existsSync, readFileSync, readdirSync, statSync, statfsSync } from 'fs'
import { spawnSync } from 'child_process'
import { basename, extname, isAbsolute, join, relative, resolve } from 'path'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()

export type OpsegMode = 'off' | 'shadow' | 'on'
export type RazlogIzvan = 'snimka-koda' | 'komplet-kopija' | 'nije-dirao'
/** Razlozi iz TASK-5670 (replay): pad koji nije dokaz kvara zadatka. */
export type RazlogNeprovjereno = 'istek-roka' | 'okolina' | 'visestruki'

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
  // `architecture` (TASK-5670/K5): docs/architecture/<zadatak>/*.ts su kopije modula uz
  // izvještaj (TASK-5259 pozadina_povrat_5259, TASK-5414 radna_mapa_5414) — „Could not
  // resolve ../TaskManagerSQL". Provjera po importima to nije hvatala kad je snimka obrisana.
  return ispod[0] === 'kod' || ispod[0] === 'prijedlozi' || ispod[0] === 'architecture'
}

// ─── (c2) Kopije kompleta (TASK-5727) ────────────────────────────────────────

/** Kod koji `bun build`/`bun test` razrješava preko relativnih importa (JSON i Python ne). */
const KOMPLET_BUILD_EKSTENZIJE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

/**
 * Je li put kopija kompleta sustava, a ne izvor: mapa `regoc-system/` s `KOMPLET.json`
 * (izvoz `gradi_komplet.sh --javno`, uklj. `vanjsko/`) ili predložak kompleta
 * `deploy/regoc-komplet-javno/predlozak/`. Takav kod se razrješava tek u instaliranom
 * stablu (`../tools`, `../VoiceServer`, `../skills` → ~/.claude/…), a testovi predloška
 * traže schema.sql izgrađenog kompleta — pa `bun build`/`bun test` u mapi paketa padaju
 * neovisno o radu (TASK-5662 krug 5: „Could not resolve ../tools/Telegram/lib/SendDoc").
 * Izvor (~/.claude/regoc) kritičar i dalje provjerava; komplet provjerava vlastiti
 * `bun test` pri gradnji ili `[PROVJERA] cmd:` zadatka.
 *
 * Ime mape `regoc-system` je uvjet namjerno: instalirano stablo (`.claude/regoc`) na
 * čvoru može nositi KOMPLET.json, a ondje je to izvor koji se mora provjeravati.
 */
export function jeKompletKopija(path: string, exists: (p: string) => boolean = existsSync): boolean {
  const p = resolve(path).replace(/\\/g, '/')
  if (p.includes('/deploy/regoc-komplet-javno/predlozak/')) return true
  const seg = p.split('/')
  for (let i = seg.length - 2; i > 0; i--) {
    if (seg[i] !== 'regoc-system') continue
    if (exists(seg.slice(0, i + 1).join('/') + '/KOMPLET.json')) return true
  }
  return false
}

const RELATIVNI_IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"\n]+)['"]/g
const NASTAVCI_IMPORTA = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.js']

/**
 * Razrješavaju li se relativni importi datoteke? Za kod pod `docs/` izvan izričitih mapa
 * snimki (Goranov nalog: „ili ih parsirati samo ako im se importi razrješavaju"). Replay
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
  /** Tekst svih `Bash` naredbi spawna (pisanje kroz ljusku: `cat >`, sed na mjestu, `cp`). */
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
    if (KOMPLET_BUILD_EKSTENZIJE.has(extname(path)) && jeKompletKopija(path)) return 'komplet-kopija'
    // Ostali kod pod docs/: dokument dok mu se importi ne razrješavaju. Izvan docs/ se
    // ovo NE gleda — pravi modul s krivim importom je pravi kvar i mora pasti.
    if (path.replace(/\\/g, '/').includes('/docs/') && !importiSeRazrjesavaju(path)) return 'snimka-koda'
  }
  const abs = resolve(path)
  if (vlastitiKorijeni.some((k) => k && (abs === resolve(k) || abs.startsWith(resolve(k) + '/')))) return null
  if (!a) return null
  return pripadaSpawnu(abs, a) ? null : 'nije-dirao'
}

// ─── (e) Okolina i istek roka (TASK-5670) ────────────────────────────────────

const ENOSPC_RE = /\bENOSPC\b|no space left on device|\bEDQUOT\b|disk quota exceeded/i
const BARE_PAKET_RE = /Could not resolve: "([^".\/][^"]*)"\. Maybe you need to "bun install"/

/**
 * TASK-5674: `bun test` koji nije izveo NIJEDAN test ne dokazuje ništa ni o kodu ni o
 * izvođaču — filter ne odgovara nijednoj datoteci u stablu u kojem je pokrenut (TASK-5657:
 * provjere pokrenute na grani main, a testovi su u worktreeju zadatka). „Ran 0 tests" se
 * računa samo kad u izlazu nema nijednog pada: test koji pukne pri učitavanju bun broji kao
 * „1 fail" i to ostaje pravi pad.
 */
const FILTER_BEZ_TESTA_RE = /did not match any test files|\bNo tests found\b/i
const RAN_0_RE = /\bRan 0 tests?\b/
const IMA_PAD_RE = /^\s*[1-9]\d*\s+fail\b/m
export const NULA_TESTOVA = '0 izvedenih testova — filter ne odgovara nijednoj datoteci u stablu provjere (krivo stablo ili put)'

export function nulaIzvedenihTestova(tekst: string): boolean {
  const t = tekst || ''
  if (IMA_PAD_RE.test(t)) return false
  return FILTER_BEZ_TESTA_RE.test(t) || RAN_0_RE.test(t)
}

/**
 * Je li pad posljedica OKOLINE kritičara, a ne koda (`null` = nije, sudi se normalno):
 *   • ENOSPC/EDQUOT — pun disk ili tmpfs (TASK-5306/5327/5331/5333),
 *   • paket (ne relativni put) se ne razrješava, a stablo NEMA nijedan node_modules od mape
 *     cilja do korijena paketa — worktree je stvoren bez `bun install` (~20 zadataka
 *     06.–14.10., TASK-5509). Kad node_modules POSTOJI, a paketa u njemu nema, ovisnost
 *     nije upisana/instalirana — to je pravi kvar i ostaje pad.
 * Relativni import koji se ne razrješava NIKAD nije okolina (pravi modul s krivim importom).
 */
export function okolinaIzIzlaza(tekst: string, target: string, exists: (p: string) => boolean = existsSync): string | null {
  const t = tekst || ''
  if (ENOSPC_RE.test(t)) return 'ENOSPC — disk ili tmpfs kritičara je pun'
  if (nulaIzvedenihTestova(t)) return NULA_TESTOVA
  const m = BARE_PAKET_RE.exec(t)
  // Okolina samo kad je SVAKA prijavljena greška nerazriješen paket: `bun build` uz „zod"
  // prijavi i pravu sintaksnu grešku, a ona ne smije nestati pod „okolinom".
  const greske = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^(error|SyntaxError|TypeError|ReferenceError)\b/.test(l))
  if (m && greske.every((l) => BARE_PAKET_RE.test(l))) {
    let dir = resolve(target, '..')
    for (let i = 0; i < 40; i++) {
      if (exists(join(dir, 'node_modules'))) return null
      if (exists(join(dir, 'package.json')) || dir === '/' || dir === HOME) break
      const gore = resolve(dir, '..')
      if (gore === dir) break
      dir = gore
    }
    return `paket „${m[1]}" se ne razrješava, a stablo nema node_modules (worktree bez bun install)`
  }
  return null
}

/**
 * Replay starih zapisa (prije TASK-5670 trag nije bilježio istek): `bun test` ubijen na
 * roku ispiše samo zaglavlje datoteke, pa `failureSignature` od njega napravi `<dir><put>:`.
 * Provjereno na daemon.log: TASK-5157 mjere-cron, TASK-5397 daemon-keeper-env → „ISTEKAO ROK".
 */
export function jeIstekRokaPotpis(sig: string): boolean {
  const { kind } = rastaviPotpis(sig)
  if (kind !== 'test' && kind !== 'parse') return false
  return /:[^\s:]*<put>:$/.test(sig)
}

/** Potpis bez osobnog dijela puta worktreeja: `app/.regoc-worktrees/<repo>/<TASK-…>/` → `wt:<repo>/`. */
export function normalizirajPotpis(sig: string): string {
  return sig.replace(/app\/\.regoc-worktrees\/([^/]+)\/TASK-[^/]+\//g, 'wt:$1/')
}

/** Spominje li izvještaj datoteku (ime kao riječ puta)? Zamjena za transkript kad ga nema. */
export function spominjeIzvjestaj(path: string, tekst: string | undefined | null): boolean {
  if (!tekst) return false
  const ime = basename(path)
  if (!ime || !tekst.includes(ime)) return false
  return new RegExp(`(^|[\\s/'"\`=>(<*])${escapeRe(ime)}(?=$|[\\s'"\`;&|)<>:,.*])`, 'm').test(tekst)
}

/**
 * K4: je li spawn dirao test ILI modul koji test izravno uvozi (relativni import, jedna
 * razina). Bez toga bi krivac koji je pokvario MODUL (a test nije ni otvorio) prošao kao
 * „zatečen" čim je netko drugi pao s istim potpisom. Bez transkripta (`a = null`) vrijedi
 * spomen imena u izvještaju — kad ga nema, nije dirao.
 */
export function diraoTest(
  testPath: string, a: Atribucija | null, izvjestaj: string | undefined | null,
  git?: { taskId: string | null; sinceMs: number },
): boolean {
  // Bez transkripta: git (commit s ID-om zadatka / neuvrštena izmjena) je dokaz s diska;
  // spomen u izvještaju agent bira sam, pa vrijedi samo kad git ne zna (datoteka nije u gitu).
  const dirao = (p: string) => {
    if (a) return pripadaSpawnu(p, a)
    if (spominjeIzvjestaj(p, izvjestaj)) return true
    return git ? gitDirao(p, git.taskId, git.sinceMs) === true : false
  }
  if (dirao(testPath)) return true
  let tekst = ''
  try { tekst = readFileSync(testPath, 'utf-8') } catch { return false }
  const dir = resolve(testPath, '..')
  for (const m of tekst.matchAll(RELATIVNI_IMPORT_RE)) {
    const cilj = resolve(dir, m[1])
    for (const n of NASTAVCI_IMPORTA) {
      const p = cilj + n
      if (existsSync(p) && (() => { try { return statSync(p).isFile() } catch { return false } })()) {
        if (dirao(p)) return true
        break
      }
    }
  }
  return false
}

/**
 * Je li zadatak dirao datoteku po gitu: `true` = commit od `sinceMs` čija poruka nosi ID
 * zadatka ILI neuvrštena izmjena (ne zna se čija → fail-closed); `false` = datoteka je u
 * gitu, čista, a commitovi u prozoru su tuđi; `null` = git ne zna (izvan repozitorija,
 * nepraćena datoteka, git pao — npr. safe.directory). Rok 3 s po pozivu.
 */
export function gitDirao(path: string, taskId: string | null, sinceMs: number): boolean | null {
  try {
    const dir = resolve(path, '..')
    if (!existsSync(dir)) return null
    const git = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf-8', timeout: 3000 })
    if (git('ls-files', '--error-unmatch', '--', path).status !== 0) return null
    const st = git('status', '--porcelain', '--', path)
    if (st.status !== 0) return null
    if ((st.stdout || '').trim()) return true
    const log = git('log', `--since=@${Math.floor(sinceMs / 1000)}`, '--format=%s%n%b', '--', path)
    if (log.status !== 0) return null
    return !!taskId && (log.stdout || '').includes(taskId)
  } catch { return null }
}

/**
 * Je li disk na kojem leži put STVARNO pun (ENOSPC iz ispisa vlastitog testa nije dokaz —
 * test smije ispisati što hoće). Pun = < 5 % slobodno, ili < 512 MiB na volumenu ≥ 10 GiB.
 * Ne zna → `false`.
 */
export function diskNizak(path: string): boolean {
  try {
    let p = resolve(path)
    while (!existsSync(p) && p !== '/') p = resolve(p, '..')
    const s = statfsSync(p)
    const slobodno = Number(s.bavail) * Number(s.bsize)
    const ukupno = Number(s.blocks) * Number(s.bsize)
    // Apsolutni prag samo za velike volumene: tmpfs od 100 MB bi inače uvijek bio „pun".
    return (ukupno > 0 && slobodno / ukupno < 0.05) || (ukupno >= 10 * 1024 ** 3 && slobodno < 512 * 1024 ** 2)
  } catch { return false }
}

export interface VisestrukiUlaz {
  signature: string
  taskId: string | null
  rows: LedgerZapis[]
  nowMs: number
  prozorMs: number
  /** Je li OVAJ spawn dirao datoteku (transkript; bez njega: spomen u izvještaju). */
  dirao: boolean
}

/**
 * K4 (TASK-5670): isti potpis pao je na DRUGOM zadatku unutar prozora (ukupno ≥ 2 zadatka
 * s ovim), a ovaj spawn datoteku NIJE dirao → zatečen. Izmjereno: trajna-sesija-spawn.test.ts
 * pokvario je TASK-5615 (23:32), pa su 5623/5625/5626 (put zahtjeva zatvaranja, bez
 * transkripta) pali s istim potpisom minutu kasnije. `jeZateceniPad` to ne hvata jer je
 * granica PRVI trag zadatka (22:59), a tuđi pad je nastao poslije.
 * Dirao = nikad zatečen: vlastiti kod je fail-closed.
 */
export function jeVisestrukiTudjiPad(u: VisestrukiUlaz): { zatecen: boolean; izvor?: string; zadaci: string[] } {
  if (u.dirao || rastaviPotpis(u.signature).kind === 'task') return { zatecen: false, zadaci: [] }
  const sig = normalizirajPotpis(u.signature)
  // Vlastiti raniji pad istog potpisa (krug popravka): pad je njegov, kao u `jeZateceniPad`.
  if (u.taskId && u.rows.some((r) => r?.taskId === u.taskId && (r.signatures || []).some((s) => normalizirajPotpis(s) === sig))) {
    return { zatecen: false, zadaci: [] }
  }
  const zadaci = new Map<string, string>()
  for (const r of u.rows) {
    if (!r || !r.taskId || r.taskId === u.taskId) continue
    const t = Date.parse(r.ts)
    if (!Number.isFinite(t) || t >= u.nowMs || t < u.nowMs - u.prozorMs) continue
    // Samo STVARNI padovi (`signatures`). Zatečeni drugog zadatka nije dokaz — inače bi se
    // lanac „zatečen jer je i onaj bio zatečen" protezao bez kraja i bez ijednog pravog pada.
    if ((r.signatures || []).some((s) => normalizirajPotpis(s) === sig)) zadaci.set(r.taskId, r.ts)
  }
  if (zadaci.size === 0) return { zatecen: false, zadaci: [] }
  const ids = [...zadaci.keys()]
  return { zatecen: true, izvor: `višestruki: ${ids.slice(0, 5).join(', ')}`, zadaci: ids }
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
  /** Potpisi zatečenih padova (od TASK-5670) — ulaz za K4 sljedećih zadataka. */
  zateceniSig?: string[]
  /** Potpisi neprovjerenih provjera (istek/okolina, od TASK-5670). */
  neprovjereno?: string[]
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
  otpalo: Array<{ sig: string; razlog: RazlogIzvan | 'zatecen' | RazlogNeprovjereno; izvor?: string }>
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
  opts: { sinceMs?: number; lookbackMs?: number; vlastitiKorijeni?: string[]; resultText?: string; prozorMs?: number; lazni?: boolean } = {},
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
    const lazni = opts.lazni !== false
    const abs = kind === 'task' ? '' : (isAbsolute(rel) ? rel : join(home, rel))
    // TASK-5670: okolina vrijedi i za propisanu provjeru (ENOSPC nije kvar ničijeg koda);
    // kod nje je cilj `stablo$naredba`, pa se node_modules traži od stabla.
    const okCilj = abs || join(home, rel.split('$')[0], '_')
    if (lazni && okolinaIzIzlaza(poruka(sig), okCilj)) { otpalo.push({ sig, razlog: 'okolina' }); continue }
    if (kind === 'task' || kind === 'doc' || kind === 'doc2') { zadrzano.push(sig); continue }
    if (lazni && jeIstekRokaPotpis(sig)) { otpalo.push({ sig, razlog: 'istek-roka' }); continue }
    // K5 u replayu: snimka pod docs/ koja je u međuvremenu obrisana ne može se pročitati,
    // pa `importiSeRazrjesavaju` ne zna ništa — tada svjedoči potpis istog zapisa: raščlamba
    // te datoteke pala je na relativnom importu („Could not resolve: "../TaskToolkit"").
    if (lazni && abs.includes('/docs/') && !existsSync(abs)
      && (row.signatures || []).some((x) => x.startsWith(`parse:${rel}:`) && /Could not resolve: "\.\.?\//.test(x))) {
      otpalo.push({ sig, razlog: 'snimka-koda' }); continue
    }
    const razlog = razlogIzvanOpsega(abs, a, opts.vlastitiKorijeni || [])
    if (razlog) { otpalo.push({ sig, razlog }); continue }
    const z = jeZateceniPad({ signature: sig, kind, relTarget: rel, sinceMs, taskId: row.taskId, rows: sviZapisi, lookbackMs: opts.lookbackMs })
    if (z.zatecen) { otpalo.push({ sig, razlog: 'zatecen', izvor: z.izvor }); continue }
    if (lazni) {
      const dirao = diraoTest(abs, a, opts.resultText, { taskId: row.taskId, sinceMs })
      const v = jeVisestrukiTudjiPad({ signature: sig, taskId: row.taskId, rows: sviZapisi, nowMs: tRow, prozorMs: opts.prozorMs ?? 24 * 3_600_000, dirao })
      if (v.zatecen) { otpalo.push({ sig, razlog: 'visestruki', izvor: v.izvor }); continue }
    }
    zadrzano.push(sig)
  }
  return { novo: zadrzano.length ? 'fail' : 'pass', zadrzano, otpalo }
}

/** Poruka potpisa (dio iza `vrsta:cilj:`). */
function poruka(sig: string): string {
  const i = sig.indexOf(':')
  const j = sig.indexOf(':', i + 1)
  return j >= 0 ? sig.slice(j + 1) : ''
}

/** Relativni cilj kakav piše `failureSignature` (za zapis `prosle`). */
export function relativnoNaHome(target: string, home = HOME): string {
  return target.startsWith(home) ? relative(home, target) : target
}
