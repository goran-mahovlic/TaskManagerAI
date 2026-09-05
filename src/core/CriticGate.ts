/**
 * CriticGate — nezavisni kritičar, odvojen od izvođača (A2 / TASK-3001).
 *
 * PROBLEM (dokazan, ne pretpostavljen):
 *   Pravilo #7 (VERIFICATION GATE) traži da agent SAM SEBE provjeri, a `CompletionGuard`
 *   sudi samo o TEKSTU rezultata. Nitko ne provjerava prevodi li isporučeni kod.
 *   28.07.2026. Jelenin je kod ostao na disku sa sintaksnom greškom (obrnuti navodnik u
 *   komentaru unutar predloška, TaskManagerMD/src/TaskWebUI.ts) i ploča je pokazala ✅.
 *   Otkriveno je tek ručnim `bun buildom`.
 *
 * ZAMISAO: „proizvođač ne ocjenjuje sam sebe" — provjeru pokreće netko drugi, i to tako da
 *   izvještaj izvođača NE ULAZI u sud. Sud se donosi iz onoga što je na disku.
 *
 * ŠTO OVDJE ZNAČI „NEZAVISNO" (tri osi, mjerene našim ograničenjima):
 *   1. Drugi PROCES — kritičar sam pokreće naredbe, ne čita ničiji ispis o naredbama.
 *   2. Drugi ULAZ — skup izmijenjenih datoteka utvrđuje se iz vremena izmjene na disku
 *      (mtime > trenutak spawna), ne iz onoga što je agent napisao da je dirao.
 *   3. Bez modela — sud „prevodi li ovo" nije mišljenje. Naredba i izlazni kod su
 *      reproducibilni, pa ih ne treba nijedan LLM.
 *
 * ZAŠTO NE „ČISTO STABLO" DOSLOVNO: `~/.claude` NIJE git repozitorij (mjereno:
 *   `git rev-parse` → „not a git repository"; isto je utvrdio A1/TASK-3000 i zapisao kao
 *   ograničenje u config/worktree-isolation.json). Za daemonov vlastiti kod checkout čistog
 *   stabla ne postoji. Zato je nezavisnost ovdje procesna, a ne git-izolacija; ondje gdje
 *   repozitorij POSTOJI, izolaciju već radi A1 i kritičar radi u tom istom stablu.
 *
 * SIGURNOSNO PRAVILO (bez iznimke): kritičar NIKAD ne izvršava naredbu iz agentova teksta.
 *   Rječnik naredbi je zatvoren i ugrađen (`bun build <put>`, `bun test <put>`), a putovi
 *   dolaze iz vlastitog obilaska datoteka. Da je drukčije, izvještaj agenta bio bi put do
 *   izvršavanja proizvoljnog koda.
 *
 * ROLLOUT: features.json → `criticGate` (promatranje: sudi i loga, ništa ne mijenja) i
 *   `criticGateLive` (sud se PROVODI: zadatak se ne zatvara kao completed dok provjere padaju).
 */

import { existsSync, readFileSync, readdirSync, statSync, appendFileSync, mkdirSync } from 'fs'
import { join, dirname, relative, basename, extname, resolve, isAbsolute, sep } from 'path'
import { isTestRuntime } from './LiveDbGuard'
// W3/TASK-4615: unakrsna provjera tvrdnji gleda POLJE `datoteke` kad ga ima (v. crossCheckClaims).
import { ocijeniIzlazKoraka } from './StepSchema'

const HOME = process.env.HOME || '/home/klaudio'

export const CRITIC_CONFIG_PATH = join(HOME, '.claude', 'regoc', 'config', 'critic-gate.json')

/**
 * Revizijski trag kritike. `REGOC_CRITIC_LEDGER` je override SAMO za testove/alat.
 *
 * Zašto uopće postoji: prva verzija ovog modula pisala je iz `bun testa` ravno u živi
 * trag i `tools/critic-report.ts` je odmah prijavio 34 „pada" koji su bili fixture iz
 * ~/.tmp. To je ista klasa kvara koju je kuća već jednom liječila (LiveDbGuard,
 * TASK-3020) — zato se ovdje koristi ISTI detektor test-okruženja, a ne nov.
 */
export function criticLedgerPath(): string {
  return process.env.REGOC_CRITIC_LEDGER || join(HOME, '.claude', 'regoc', 'data', 'critic_gate.jsonl')
}

export const CRITIC_JSONL_PATH = criticLedgerPath()

// ─── Konfiguracija ───────────────────────────────────────────────────────────

export interface CriticConfig {
  /** Stabla u kojima kritičar uopće gleda promjene. Izvan njih ne zaviruje. */
  watchRoots: string[]
  /** Dubina obilaska direktorija (štiti od šetnje po cijelom disku). */
  maxDepth: number
  /** Najviše datoteka koje ulaze u provjeru; višak se prijavljuje, ne prešućuje. */
  maxFiles: number
  /** Rok po jednoj provjeri. */
  perCheckTimeoutMs: number
  /** Ukupni rok za sve provjere jednog zadatka. */
  totalBudgetMs: number
  /** Tolerancija na nepreciznost sata/FS-a kod usporedbe mtimea. */
  mtimeSkewMs: number
  /** Koliko krugova popravka smije proći prije eskalacije čovjeku. */
  maxRounds: number
  /** Isječci puta koji se preskaču (podniz, ne glob — namjerno bez ovisnosti). */
  ignore: string[]
  /** Direktorij s testovima, relativno na korijen modula. */
  testDir: string
  /** Ekstenzije koje se provjeravaju prevođenjem. */
  parseExtensions: string[]
  /**
   * Ekstenzije koje se provjeravaju sintaksnom raščlambom Pythona.
   *
   * ZAŠTO POSTOJI (26.08.2026.): kritičar je znao samo `bun build` i `bun test`, pa je za
   * projekt pisan u Pythonu (MUSZG-WEB-PYTHON) `planChecks` vraćao PRAZAN popis → sud
   * `unverifiable` → vrata spajanja drže rad i traže ljudski potpis. Automatsko spajanje
   * po zadatku tako nikad ne bi opalilo. Raščlamba se radi `ast.parse`-om, NE izvođenjem
   * i NE `py_compile`-om: izvođenje tuđeg koda nije provjera nego rizik, a `py_compile`
   * usput piše `__pycache__` u tuđe stablo.
   */
  pythonExtensions: string[]
  /**
   * Izvršne datoteke koje zadatak SMIJE propisati ključem `[PROVJERA] cmd:` (TASK-3460).
   *
   * ZAŠTO ZATVOREN POPIS: naredba dolazi iz opisa zadatka, dakle iz naše ruke — ali se
   * prema njoj postupa kao prema vanjskom ulazu. Da je popis otvoren, opis zadatka bio bi
   * put do izvršavanja bilo čega pod ovlastima daemona; `bash`, `sh` i `curl` zato NISU
   * na njemu, i potpuna putanja (`/usr/bin/python3`) nije zaobilaznica.
   */
  declaredAllowlist: string[]
  /** Gornja granica roka koji zadatak smije propisati (`[PROVJERA] rok:`). */
  maxDeclaredTimeoutMs: number
}

export const DEFAULT_CRITIC_CONFIG: CriticConfig = {
  watchRoots: [join(HOME, '.claude', 'regoc')],
  maxDepth: 4,
  maxFiles: 40,
  perCheckTimeoutMs: 20_000,
  totalBudgetMs: 90_000,
  mtimeSkewMs: 2_000,
  maxRounds: 2,
  ignore: [
    '/node_modules/', '/.git/', '/data/', '/logs/', '/tests/scratch/',
    '.bak', '.backup', '.tmp.', '/dist/', '/build/', '/.cache/',
    // Baze i njihovi WAL/SHM pratitelji mijenjaju mtime na SVAKI upis, pa bi inače svaki
    // spawn izgledao kao da je „dirao" bazu. Nisu izvršni artefakt i ne provjeravaju se.
    '.db', '.db-wal', '.db-shm', '.sqlite',
  ],
  testDir: 'tests',
  parseExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'],
  pythonExtensions: ['.py'],
  declaredAllowlist: ['python3', 'bun', 'node', 'pytest', 'npm', 'make'],
  maxDeclaredTimeoutMs: 300_000,
}

const CONFIG_TTL_MS = 30_000
let _cfgCache: CriticConfig | null = null
let _cfgLoadedAt = 0
let _cfgFrom = ''

/** Učitaj konfiguraciju (keš 30 s ⇒ promjena djeluje bez restarta daemona). */
export function loadCriticConfig(path = CRITIC_CONFIG_PATH, force = false): CriticConfig {
  const now = Date.now()
  if (!force && _cfgCache && path === _cfgFrom && now - _cfgLoadedAt < CONFIG_TTL_MS) return _cfgCache
  const cfg: CriticConfig = { ...DEFAULT_CRITIC_CONFIG }
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf-8'))
      for (const key of Object.keys(DEFAULT_CRITIC_CONFIG) as Array<keyof CriticConfig>) {
        const v = (raw as any)?.[key]
        if (v === undefined || v === null) continue
        const def = DEFAULT_CRITIC_CONFIG[key]
        if (Array.isArray(def) && Array.isArray(v)) (cfg as any)[key] = v
        else if (typeof def === 'number' && typeof v === 'number' && Number.isFinite(v)) (cfg as any)[key] = v
        else if (typeof def === 'string' && typeof v === 'string') (cfg as any)[key] = v
      }
    }
  } catch {
    // Neispravan JSON → defaulti. Kritičar nikad ne smije srušiti poziv koji ga zove.
  }
  // Popis dopuštenih naredbi je sigurnosna granica, a ne obična postavka: nemarno
  // uređivanje datoteke ne smije od ključa `[PROVJERA]` napraviti izvršavanje bilo čega.
  // Putanja u imenu je zabranjena (`/bin/sh` bi zaobišao provjeru po imenu).
  cfg.declaredAllowlist = cfg.declaredAllowlist
    .filter((x) => typeof x === 'string' && x.length > 0 && !x.includes('/') && !x.includes('\\'))
  _cfgCache = cfg
  _cfgLoadedAt = now
  _cfgFrom = path
  return cfg
}

// ─── 1. Skup izmjena: iz diska, ne iz izvještaja ─────────────────────────────

export interface ChangedFile {
  path: string
  mtimeMs: number
  sizeBytes: number
}

export interface ScanResult {
  files: ChangedFile[]
  /** Koliko je datoteka odbačeno stropom `maxFiles` — nikad se ne prešućuje. */
  truncated: number
  /** Korijeni koji ne postoje (tiho preskočeni bili bi tiha rupa u pokrivenosti). */
  missingRoots: string[]
}

/**
 * Dodatni korijen pretrage vezan uz JEDAN spawn (A4 dopuna / TASK-3052).
 *
 * ZAŠTO POSTOJI: `watchRoots` je globalan i statičan (~/.claude/regoc). A1 worktreejevi
 * žive pod ~/app/.regoc-worktrees i imaju ime po spawnu, pa se u konfiguraciju ne mogu
 * upisati unaprijed. Bez ovoga kritičar izoliranog spawna NE VIDI nijednu datoteku koju
 * je agent stvarno dirao, pa njegov `pass` ne pokriva ništa što se spaja (A4 to hvata
 * branom `scope-mismatch`, ali onda strojni potpis nikad ne može otvoriti vrata).
 *
 * ZAŠTO NE `watchRoots += ~/app/.regoc-worktrees`: tada bi SVAKA kritika obilazila i
 * TUĐE worktreejeve i sudila ovom spawnu po kolegin nedovršen posao — točno ona nečista
 * atribucija zbog koje A1 uopće postoji. Korijen zato mora biti per-spawn.
 */
export interface ScanRoot {
  path: string
  /**
   * Vlastita donja granica mtimea za OVAJ korijen (ms). Kad je zadana, koristi se
   * DOSLOVNO — bez `mtimeSkewMs` unatrag.
   *
   * ZAŠTO: `git worktree add` ISPIŠE cijelo stablo, pa svaka datoteka u svježem
   * worktreeju ima mtime = trenutak checkouta. Izmjereno 2026-07-29 (~/.tmp/wt_mtime_probe):
   * checkout je bio 1219 ms NAKON zabilježenog starta spawna, a `spawnInfo.startTime`
   * nastaje PRIJE `prepareSpawnWorkspace`. Uz globalnu granicu (start − 2 s) cijeli bi
   * checkout ispao „izmjena ovog agenta" i kritičar bi gradio 40 nasumičnih datoteka repoa.
   * Zato daemon ovdje šalje trenutak ZAVRŠETKA checkouta: sve od checkouta je stablo
   * kakvo je agent zatekao, sve poslije je njegov rad.
   */
  sinceMs?: number
}

export type ExtraRoot = string | ScanRoot

function isIgnored(path: string, cfg: CriticConfig): boolean {
  return cfg.ignore.some((frag) => path.includes(frag))
}

/** Korijeni + granica po korijenu, bez duplikata (isti put dvaput = dvostruki `bun build`). */
function resolveScanRoots(sinceMs: number, cfg: CriticConfig, extra: ExtraRoot[] = []): Array<{ path: string; cutoff: number }> {
  const roots: Array<{ path: string; cutoff: number }> = []
  const seen = new Set<string>()
  const push = (path: string, cutoff: number) => {
    if (!path || seen.has(path)) return
    seen.add(path)
    roots.push({ path, cutoff })
  }
  for (const r of cfg.watchRoots) push(r, sinceMs - cfg.mtimeSkewMs)
  for (const r of extra) {
    if (typeof r === 'string') push(r, sinceMs - cfg.mtimeSkewMs)
    else if (r && typeof r.path === 'string') push(r.path, Number.isFinite(r.sinceMs) ? (r.sinceMs as number) : sinceMs - cfg.mtimeSkewMs)
  }
  return roots
}

/**
 * Datoteke izmijenjene NAKON `sinceMs`. Ovo je jedini ulaz u sud o kodu i namjerno
 * ne ovisi o agentovu tekstu: agent koji „zaboravi" spomenuti datoteku ne može je sakriti.
 *
 * Granica sa `mtimeSkewMs` ide UNATRAG (hvata i izmjenu neposredno prije zabilježenog
 * starta) — lažni pozitiv ovdje košta jedan `bun build` od 85 ms, lažni negativ košta
 * neuhvaćen kvar na ploči. Iznimka je korijen koji nosi vlastiti `sinceMs` (`ScanRoot`):
 * ondje je granica doslovna, jer je „prije nje" tuđi checkout, a ne izmjena ovog agenta.
 */
export function scanChangedFiles(
  sinceMs: number,
  cfg: CriticConfig = loadCriticConfig(),
  extraRoots: ExtraRoot[] = [],
): ScanResult {
  const out: ChangedFile[] = []
  const missingRoots: string[] = []
  const takenPaths = new Set<string>()
  let seen = 0

  const walk = (dir: string, depth: number, cutoff: number): void => {
    if (depth > cfg.maxDepth) return
    let entries: string[]
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const full = join(dir, name)
      if (isIgnored(full + '/', cfg) || isIgnored(full, cfg)) continue
      let st: ReturnType<typeof statSync>
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) { walk(full, depth + 1, cutoff); continue }
      if (!st.isFile()) continue
      if (st.mtimeMs < cutoff) continue
      // Ugniježđeni korijeni (npr. worktree unutar nadziranog stabla) inače bi istu
      // datoteku poslali na provjeru dvaput.
      if (takenPaths.has(full)) continue
      takenPaths.add(full)
      seen++
      if (out.length < cfg.maxFiles) out.push({ path: full, mtimeMs: st.mtimeMs, sizeBytes: st.size })
    }
  }

  for (const root of resolveScanRoots(sinceMs, cfg, extraRoots)) {
    if (!existsSync(root.path)) { missingRoots.push(root.path); continue }
    walk(root.path, 0, root.cutoff)
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { files: out, truncated: Math.max(0, seen - out.length), missingRoots }
}

// ─── 2. Plan provjera: zatvoren rječnik naredbi ──────────────────────────────

/**
 * `task` = provjera koju je propisao SAM ZADATAK (`[PROVJERA] cmd:`, TASK-3460).
 * Ostale tri kritičar izvodi iz vrste datoteke.
 */
export type CheckKind = 'parse' | 'json' | 'test' | 'task'

export interface PlannedCheck {
  kind: CheckKind
  /** Datoteka nad kojom se sudi (apsolutni put); za `task` — stablo u kojem se vrti. */
  target: string
  /** Točna naredba — sastavlja je KRITIČAR, nikad tekst agenta. */
  cmd: string[]
  /** Radni direktorij naredbe. */
  cwd: string
  /** Rok koji je propisao zadatak (samo `task`); prazno = `perCheckTimeoutMs`. */
  timeoutMs?: number
}

/**
 * `WorktreeIsolation.ts` → `worktree-isolation`. Nizovi velikih slova ostaju cjelina
 * (`ISAGenerator` → `isa-generator`), inače bi ime testa ispalo `i-s-a-generator`.
 */
export function kebabOfModule(fileName: string): string {
  const stem = basename(fileName, extname(fileName))
  return stem
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}

/** Kandidati za test uz modul; vraća samo one koji stvarno postoje. */
export function relatedTestFiles(
  file: string,
  cfg: CriticConfig = loadCriticConfig(),
  exists: (p: string) => boolean = existsSync,
): string[] {
  const dir = dirname(file)
  const kebab = kebabOfModule(file)
  const stem = basename(file, extname(file))
  const roots = [join(dir, cfg.testDir), join(dirname(dir), cfg.testDir), dir]
  const names = [`${kebab}.test.ts`, `${stem}.test.ts`, `${kebab}.spec.ts`]
  const found: string[] = []
  for (const r of roots) {
    for (const n of names) {
      const p = join(r, n)
      if (exists(p) && !found.includes(p)) found.push(p)
    }
  }
  return found
}

// ─── 2b. Provjera koju propisuje ZADATAK (ključ `[PROVJERA]`) ────────────────

/**
 * TASK-3460 — zašto ovo uopće postoji.
 *
 * Od 26.08.2026. vrata spajanja rade po pravilu `auto-on-signoff`: potpis kritičara sa
 * statusom `pass` SAM otvara spajanje tog jednog zadatka. Dotad je `pass` značio samo
 * „ono što je kritičar sam izveo iz vrste datoteke je prošlo" — za Python projekt
 * (MUSZG-WEB-PYTHON) doslovno „datoteka se raščlanjuje". To nije dokaz ispravnosti, a
 * spojilo bi se samo.
 *
 * Zato zadatak smije UNAPRIJED propisati naredbu pregleda:
 *
 *     [PROVJERA] cmd: python3 usporedi.py --sve
 *     [PROVJERA] cwd: konverzija      (neobavezno; zadano = korijen stabla spawna)
 *     [PROVJERA] rok: 120s            (neobavezno; zadano = perCheckTimeoutMs)
 *
 * Tek tada `pass` znači „unaprijed dogovoreni pregled je prošao".
 *
 * `cwd` i `rok` vrijede za CIJELI blok (za sve `cmd` retke), bez obzira na redoslijed —
 * u opisu se prirodno pišu ISPOD naredbe, pa bi pravilo „vrijedi za ono što slijedi"
 * tiho poništilo ono što je čovjek napisao.
 *
 * NAČELO: naredba dolazi iz našeg opisa, ali se prema njoj postupa kao prema vanjskom
 * ulazu — zatvoren popis izvršnih datoteka, bez ljuske, bez izlaska iz stabla spawna.
 */
export interface DeclaredCheck {
  /** Naredba rastavljena na argumente — nikad se ne pušta kroz ljusku. */
  cmd: string[]
  /** Radni direktorij kako ga je zadatak napisao; prazno = korijen stabla spawna. */
  cwdRel: string
  /** Rok koji je zadatak propisao (ms); prazno = `perCheckTimeoutMs`. */
  timeoutMs?: number
  /** Izvorni redak — ide u razlog odbijanja i u dnevnik, da se vidi ŠTO je traženo. */
  raw: string
}

/** Deklarirana provjera s razriješenim (i provjerenim) radnim direktorijem. */
export interface ResolvedCheck {
  cmd: string[]
  cwd: string
  timeoutMs?: number
  raw: string
}

/**
 * Razlog zbog kojeg se propisana provjera NE MOŽE izvesti. Nikad se ne prešućuje: tiho
 * preskakanje bi kroz vrata spajanja propustilo rad koji nitko nije provjerio.
 */
export interface DeclaredIssue { raw: string; reason: string }

export interface DeclaredParse {
  checks: DeclaredCheck[]
  issues: DeclaredIssue[]
  /** Je li opis uopće imao ključ — razlikuje „nema ključa" od „ključ je neispravan". */
  present: boolean
}

/** Oznaka je neosjetljiva na velika/mala slova i na razmake unutar uglatih zagrada. */
const DECLARED_LINE_RE = /^\s*\[\s*provjera\s*\]\s*([a-zžćčšđ0-9_-]+)\s*:\s*(.*?)\s*$/i

/** Metaznakovi ljuske. Prisutnost bilo kojeg = odbijanje, NIKAD pokušaj čišćenja. */
const SHELL_META_RE = /[|&;$`><\n\r]/

/** Rastavljanje na argumente. Navodnici drže argument s razmakom na okupu. */
function tokenizeCommand(raw: string): { argv: string[]; error: string | null } {
  const argv: string[] = []
  let cur = ''
  let quote: string | null = null
  let started = false
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) { quote = null; continue }
      cur += ch; started = true; continue
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue }
    if (/\s/.test(ch)) { if (started) { argv.push(cur); cur = ''; started = false } continue }
    cur += ch; started = true
  }
  if (quote) return { argv: [], error: 'nezatvoren navodnik u naredbi' }
  if (started) argv.push(cur)
  return { argv, error: null }
}

function parseRok(value: string, cfg: CriticConfig): { ms: number | null; error: string | null } {
  const m = /^(\d+)\s*(ms|s|m)?$/i.exec(value.trim())
  if (!m) return { ms: null, error: `rok „${value}" nije čitljiv (očekujem npr. 120s, 2m ili 4500ms)` }
  const n = Number(m[1])
  const unit = (m[2] || 's').toLowerCase()
  const ms = unit === 'ms' ? n : unit === 'm' ? n * 60_000 : n * 1_000
  if (ms <= 0) return { ms: null, error: `rok „${value}" mora biti veći od nule` }
  if (ms > cfg.maxDeclaredTimeoutMs) {
    return { ms: null, error: `rok „${value}" je izvan granice (najviše ${Math.round(cfg.maxDeclaredTimeoutMs / 1000)}s)` }
  }
  return { ms, error: null }
}

/**
 * Pročitaj propisane provjere iz opisa zadatka. Čista funkcija: ne dira disk i ne zna
 * gdje spawn radi — razrješavanje putanja radi `resolveDeclaredChecks`.
 *
 * Fail-closed: neispravan `cwd` ili `rok` ruši CIJELI blok (ne izvodi se nijedna
 * naredba), jer bi inače propisana provjera potiho radila u krivom stablu ili s krivim
 * rokom — a potpis bi i dalje pisao `pass`.
 */
export function parseDeclaredChecks(description: string | null | undefined, cfg: CriticConfig = loadCriticConfig()): DeclaredParse {
  const out: DeclaredParse = { checks: [], issues: [], present: false }
  const text = typeof description === 'string' ? description : ''
  if (!text.includes('[')) return out

  const raws: string[] = []
  let cwdRel = ''
  let timeoutMs: number | undefined
  let blockBroken = false

  for (const line of text.split(/\r?\n/)) {
    const m = DECLARED_LINE_RE.exec(line)
    if (!m) continue
    out.present = true
    const key = m[1].toLowerCase()
    let value = m[2]

    if (key === 'cmd') { raws.push(value); continue }

    // Komentar iza vrijednosti dopušten je SAMO na postavkama (`cwd`, `rok`) — na `cmd`
    // nije, jer bi tiho odrezan argument značio da se pokreće druga naredba od napisane.
    if (key === 'cwd' || key === 'rok') {
      const cut = value.search(/\s#/)
      if (cut >= 0) value = value.slice(0, cut).trim()
    }

    if (key === 'cwd') {
      if (!value) { out.issues.push({ raw: line.trim(), reason: 'prazan `cwd` redak' }); blockBroken = true; continue }
      if (SHELL_META_RE.test(value)) { out.issues.push({ raw: value, reason: 'metaznak ljuske u `cwd` — odbijeno' }); blockBroken = true; continue }
      if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) {
        out.issues.push({ raw: value, reason: '`..` u `cwd` — putanja koja izlazi iz stabla se ne razrješava' })
        blockBroken = true; continue
      }
      cwdRel = value
      continue
    }

    if (key === 'rok') {
      const r = parseRok(value, cfg)
      if (r.error) { out.issues.push({ raw: value, reason: r.error }); blockBroken = true; continue }
      timeoutMs = r.ms as number
      continue
    }

    out.issues.push({ raw: line.trim(), reason: `nepoznat ključ „${m[1]}" uz oznaku [PROVJERA] (poznati: cmd, cwd, rok)` })
    blockBroken = true
  }

  for (const raw of raws) {
    if (!raw) { out.issues.push({ raw: '[PROVJERA] cmd:', reason: 'prazna naredba u `cmd` retku' }); continue }
    if (SHELL_META_RE.test(raw)) { out.issues.push({ raw, reason: 'metaznak ljuske u naredbi — odbijeno, naredba se ne čisti' }); continue }
    const { argv, error } = tokenizeCommand(raw)
    if (error) { out.issues.push({ raw, reason: error }); continue }
    if (!argv.length) { out.issues.push({ raw, reason: 'prazna naredba u `cmd` retku' }); continue }
    if (!cfg.declaredAllowlist.includes(argv[0])) {
      out.issues.push({ raw, reason: `naredba „${argv[0]}" nije na popisu dopuštenih (${cfg.declaredAllowlist.join(', ')})` })
      continue
    }
    out.checks.push({ cmd: argv, cwdRel, timeoutMs, raw })
  }

  if (blockBroken) out.checks = []
  return out
}

/**
 * Razriješi radni direktorij i provjeri da NE IZLAZI iz stabla ovog spawna.
 *
 * Bez korijena se ne pada na `$HOME` ni na `process.cwd()`: propisana provjera pokrenuta
 * u nepoznatom stablu ne dokazuje ništa, a potpis bi izgledao jednako valjano.
 */
export function resolveDeclaredChecks(
  checks: DeclaredCheck[],
  rootDir: string,
  exists: (p: string) => boolean = existsSync,
): { checks: ResolvedCheck[]; issues: DeclaredIssue[] } {
  const out: ResolvedCheck[] = []
  const issues: DeclaredIssue[] = []
  const root = rootDir ? resolve(rootDir) : ''
  for (const c of checks) {
    if (!root) { issues.push({ raw: c.raw, reason: 'stablo spawna nije poznato — propisana provjera se ne pokreće' }); continue }
    const cwd = c.cwdRel ? (isAbsolute(c.cwdRel) ? resolve(c.cwdRel) : resolve(root, c.cwdRel)) : root
    if (cwd !== root && !cwd.startsWith(root + sep)) {
      issues.push({ raw: c.raw, reason: `radni direktorij „${cwd}" izlazi izvan stabla spawna (${root})` })
      continue
    }
    if (!exists(cwd)) { issues.push({ raw: c.raw, reason: `radni direktorij „${cwd}" ne postoji` }); continue }
    out.push({ cmd: c.cmd, cwd, timeoutMs: c.timeoutMs, raw: c.raw })
  }
  return { checks: out, issues }
}

/**
 * Od skupa izmjena do konkretnih provjera. Test datoteka koja je i sama izmijenjena
 * pokreće se izravno (izmijenjen test je i sam isporuka koja mora prolaziti).
 */
export function planChecks(
  changed: ChangedFile[],
  cfg: CriticConfig = loadCriticConfig(),
  exists: (p: string) => boolean = existsSync,
  declared: ResolvedCheck[] = [],
): PlannedCheck[] {
  const checks: PlannedCheck[] = []
  const testTargets = new Set<string>()

  // Dogovoreni pregled ide PRVI: on je jedini razlog zbog kojeg `pass` išta znači, pa ne
  // smije ispasti zato što je strop vremena potrošio `bun build` po tuđim datotekama.
  for (const d of declared) {
    checks.push({ kind: 'task', target: d.cwd, cmd: d.cmd, cwd: d.cwd, ...(d.timeoutMs ? { timeoutMs: d.timeoutMs } : {}) })
  }

  for (const f of changed) {
    const ext = extname(f.path)
    const isTest = /\.(test|spec)\.[tj]sx?$/.test(f.path)

    if (cfg.parseExtensions.includes(ext)) {
      checks.push({ kind: 'parse', target: f.path, cmd: ['bun', 'build', f.path, '--target=bun'], cwd: dirname(f.path) })
      if (isTest) testTargets.add(f.path)
      else for (const t of relatedTestFiles(f.path, cfg, exists)) testTargets.add(t)
    } else if (cfg.pythonExtensions.includes(ext)) {
      // Sintaksna raščlamba bez izvođenja i bez pisanja po tuđem stablu.
      checks.push({
        kind: 'parse',
        target: f.path,
        cmd: ['python3', '-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1])', f.path],
        cwd: dirname(f.path),
      })
    } else if (ext === '.json') {
      checks.push({ kind: 'json', target: f.path, cmd: ['__json__', f.path], cwd: dirname(f.path) })
    }
  }

  for (const t of testTargets) {
    checks.push({ kind: 'test', target: t, cmd: ['bun', 'test', t], cwd: dirname(dirname(t)) })
  }
  return checks
}

// ─── 3. Izvršavanje ──────────────────────────────────────────────────────────

export interface RunOutput { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }
export type CheckRunner = (check: PlannedCheck, timeoutMs: number) => RunOutput

/** Stvarni izvršitelj. Odvojen tip da ga test može zamijeniti bez diranja diska. */
export const realRunner: CheckRunner = (check, timeoutMs) => {
  if (check.cmd[0] === '__json__') {
    try {
      JSON.parse(readFileSync(check.target, 'utf-8'))
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    } catch (e: any) {
      return { exitCode: 1, stdout: '', stderr: String(e?.message || e), timedOut: false }
    }
  }
  const { spawnSync } = require('child_process') as typeof import('child_process')
  const r = spawnSync(check.cmd[0], check.cmd.slice(1), {
    cwd: check.cwd,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    encoding: 'utf-8',
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  })
  return {
    exitCode: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    timedOut: (r as any).signal === 'SIGKILL' && r.status === null,
  }
}

export interface CheckResult extends PlannedCheck {
  ok: boolean
  exitCode: number | null
  ms: number
  timedOut: boolean
  /** Preskočena jer je ukupni rok potrošen — NIJE prošla, samo nije stigla. */
  skipped: boolean
  /** Prvi smisleni redak greške (za potpis i za izvještaj). */
  errorLine: string
  /** Izmjereno iz izlaza `bun test`, kad postoji. */
  measured?: { pass: number; fail: number }
}

const TEST_TALLY_RE = /(\d+)\s+pass\b[\s\S]{0,200}?(\d+)\s+fail\b/i

function firstErrorLine(out: RunOutput): string {
  const hay = `${out.stderr}\n${out.stdout}`
  for (const line of hay.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    if (/^(error|Error|SyntaxError|TypeError|ReferenceError|\(fail\)|✗|error:)/.test(t) || /\berror\b/.test(t)) {
      return t.slice(0, 300)
    }
  }
  const firstNonEmpty = hay.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || ''
  return firstNonEmpty.slice(0, 300)
}

/**
 * Isti izvršitelj, ali bez blokiranja petlje događaja. Daemon ga zove ovim putem:
 * `spawnSync` bi mu zaustavio cijelu petlju dok traje `bun test` (mjereno 0,9 s za
 * jedan skup, a strop je 90 s) — a daemon u tom vremenu ne bi ni disao.
 */
export type AsyncCheckRunner = (check: PlannedCheck, timeoutMs: number) => Promise<RunOutput>

export const realRunnerAsync: AsyncCheckRunner = async (check, timeoutMs) => {
  if (check.cmd[0] === '__json__') return realRunner(check, timeoutMs)
  const proc = Bun.spawn(check.cmd, {
    cwd: check.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL') } catch {} }, timeoutMs)
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited
    return { exitCode: timedOut ? null : exitCode, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

/** Jedan ishod → jedan zapis. Dijele ga sinkroni i asinkroni put (bez dvije istine). */
function toResult(check: PlannedCheck, out: RunOutput, ms: number): CheckResult {
  const tally = TEST_TALLY_RE.exec(`${out.stdout}\n${out.stderr}`)
  const ok = out.exitCode === 0 && !out.timedOut
  return {
    ...check,
    ok,
    exitCode: out.exitCode,
    ms,
    timedOut: out.timedOut,
    skipped: false,
    errorLine: ok ? '' : firstErrorLine(out),
    measured: tally ? { pass: Number(tally[1]), fail: Number(tally[2]) } : undefined,
  }
}

function skippedResult(check: PlannedCheck): CheckResult {
  return { ...check, ok: false, exitCode: null, ms: 0, timedOut: false, skipped: true, errorLine: 'preskočeno: potrošen ukupni rok kritičara' }
}

/**
 * Rok jedne provjere. Deklarirana (`task`) nosi onaj koji je propisao zadatak, ali nikad
 * iznad `maxDeclaredTimeoutMs` — opis zadatka ne smije daemonu propisati vječnost.
 */
function checkTimeout(check: PlannedCheck, cfg: CriticConfig): number {
  const wanted = check.timeoutMs ?? cfg.perCheckTimeoutMs
  return Math.max(1, Math.min(wanted, cfg.maxDeclaredTimeoutMs))
}

/**
 * Ukupni proračun. Deklarirane provjere ga POVEĆAVAJU točno za ono što su propisale:
 * propisani rok (do 300 s) je veći od cijelog dosadašnjeg stropa (90 s), pa bi dogovoreni
 * pregled inače uvijek istekao i sud bi bio `unverifiable`. Strop time nije ukinut —
 * provjera koja u njega ne stane i dalje je `partial`, a `partial` nije prolaz.
 */
function totalBudget(checks: PlannedCheck[], cfg: CriticConfig): number {
  let extra = 0
  for (const c of checks) if (c.kind === 'task') extra += checkTimeout(c, cfg)
  return cfg.totalBudgetMs + extra
}

/** Pokreni plan uz ukupni rok. Preskočeno se PRIJAVLJUJE, nikad ne broji kao prolaz. */
export function runChecks(
  checks: PlannedCheck[],
  cfg: CriticConfig = loadCriticConfig(),
  runner: CheckRunner = realRunner,
  nowFn: () => number = Date.now,
): CheckResult[] {
  const started = nowFn()
  const total = totalBudget(checks, cfg)
  const results: CheckResult[] = []
  for (const check of checks) {
    const elapsed = nowFn() - started
    if (elapsed >= total) { results.push(skippedResult(check)); continue }
    const budget = Math.min(checkTimeout(check, cfg), total - elapsed)
    const t0 = nowFn()
    let out: RunOutput
    try {
      out = runner(check, budget)
    } catch (e: any) {
      out = { exitCode: null, stdout: '', stderr: String(e?.message || e), timedOut: false }
    }
    results.push(toResult(check, out, nowFn() - t0))
  }
  return results
}

/** Asinkrona blizanka `runChecks` — isti sud, samo bez zaustavljanja petlje događaja. */
export async function runChecksAsync(
  checks: PlannedCheck[],
  cfg: CriticConfig = loadCriticConfig(),
  runner: AsyncCheckRunner = realRunnerAsync,
  nowFn: () => number = Date.now,
): Promise<CheckResult[]> {
  const started = nowFn()
  const total = totalBudget(checks, cfg)
  const results: CheckResult[] = []
  for (const check of checks) {
    const elapsed = nowFn() - started
    if (elapsed >= total) { results.push(skippedResult(check)); continue }
    const budget = Math.min(checkTimeout(check, cfg), total - elapsed)
    const t0 = nowFn()
    let out: RunOutput
    try {
      out = await runner(check, budget)
    } catch (e: any) {
      out = { exitCode: null, stdout: '', stderr: String(e?.message || e), timedOut: false }
    }
    results.push(toResult(check, out, nowFn() - t0))
  }
  return results
}

// ─── 4. Sud ──────────────────────────────────────────────────────────────────

export type CriticStatus =
  /** Sve planirane provjere prošle. */
  | 'pass'
  /** Barem jedna provjera pala — reproducibilno, s naredbom i izlaznim kodom. */
  | 'fail'
  /** Nije bilo što provjeriti (istraživački/dokumentacijski zadatak, nema izvršnog artefakta). */
  | 'unverifiable'
  /** Ništa nije palo, ali kritičar nije sve stigao (rok/strop). Nije isto što i „prošlo". */
  | 'partial'

export interface CriticVerdict {
  status: CriticStatus
  /** Smije li ovaj sud zaustaviti zatvaranje zadatka (samo `fail` — determinističan dokaz). */
  blocking: boolean
  checks: CheckResult[]
  failed: CheckResult[]
  /** Stabilni potpisi kvarova — ulaz u kontrolu petlje popravaka. */
  signatures: string[]
  /** Ljudski čitljivo obrazloženje (hrvatski; ide u blocked_reason i u log). */
  reason: string
  /**
   * Propisane provjere koje se NISU mogle izvesti, s razlogom (T10/TASK-3575). Prije su
   * postojale samo unutar `judge` i završavale u tekstu razloga; dojava „što je točno
   * nedostajalo" mora ih dobiti kao PODATAK, ne kao rečenicu iz koje se parsira.
   */
  unrunnable: DeclaredIssue[]
  scan: { changedFiles: number; truncated: number; missingRoots: string[] }
  notes: string[]
  /** Ukupno potrošeno vrijeme svih provjera. */
  ms: number
}

/**
 * Stabilan potpis kvara: vrsta + relativna datoteka + poruka bez brojeva redaka i
 * apsolutnih putova. Dva pokušaja koja pucaju na istome daju ISTI potpis — po tome se
 * prepoznaje popravak koji ne konvergira.
 */
export function failureSignature(r: CheckResult, home = HOME): string {
  const base = r.target.startsWith(home) ? relative(home, r.target) : r.target
  // Kod `task` provjera cilj je STABLO, pa bi dvije različite propisane naredbe u istom
  // stablu dale isti potpis i druga bi lažno ispala „isti kvar dvaput" → prerana eskalacija.
  const rel = r.kind === 'task' ? `${base}$${r.cmd.join(' ')}` : base
  const msg = (r.errorLine || `exit=${r.exitCode}`)
    .replace(/(\/[\w.@ -]+)+\.\w{1,6}(:\d+)?(:\d+)?/g, '<put>')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return `${r.kind}:${rel}:${msg}`
}

/**
 * Sud. Uz uobičajene provjere gleda i propisane (`task`, TASK-3460):
 *
 *   • propisana provjera pala          → `fail` (blokira, kao i dosad `parse`/`test`)
 *   • propisana provjera NEIZVEDIVA    → `unverifiable` uz izričit razlog — NIKAD `pass`
 *
 * Druga je stavka cijeli smisao ovoga: uz `auto-on-signoff` bi tiho preskočena propisana
 * provjera dala potpis `pass` i sama spojila rad koji nitko nije pregledao.
 */
export function judge(
  checks: CheckResult[],
  scan: ScanResult,
  notes: string[] = [],
  declaredIssues: DeclaredIssue[] = [],
): CriticVerdict {
  // Istek roka propisane provjere NIJE dokazan pad tuđeg koda nego neizvedena provjera —
  // ide u istu ladicu kao naredba koja se uopće nije mogla pokrenuti.
  const unrunnable: DeclaredIssue[] = [
    ...declaredIssues,
    ...checks
      .filter((c) => c.kind === 'task' && c.timedOut)
      .map((c) => ({ raw: c.cmd.join(' '), reason: `istekao rok (${c.ms} ms) — propisana provjera nije dovršena` })),
    // Izlazni kod `null` bez isteka roka = naredba se NIJE ni pokrenula (npr. `pytest`
    // nije instaliran). To nije dokaz da tuđi kod ne valja nego da provjere nije bilo —
    // pa ne smije proći ni kao `pass` ni kao `fail`.
    ...checks
      .filter((c) => c.kind === 'task' && !c.ok && !c.skipped && !c.timedOut && c.exitCode === null)
      .map((c) => ({ raw: c.cmd.join(' '), reason: `naredba se nije pokrenula: ${c.errorLine || 'bez izlaznog koda'}` })),
  ]
  const notRun = (c: CheckResult) => c.kind === 'task' && (c.timedOut || c.exitCode === null)
  const failed = checks.filter((c) => !c.ok && !c.skipped && !notRun(c))
  const skipped = checks.filter((c) => c.skipped)
  const ms = checks.reduce((a, c) => a + c.ms, 0)
  const base = {
    checks,
    failed,
    unrunnable,
    signatures: failed.map((f) => failureSignature(f)),
    scan: { changedFiles: scan.files.length, truncated: scan.truncated, missingRoots: scan.missingRoots },
    notes,
    ms,
  }

  if (failed.length > 0) {
    // Kod `task` provjere cilj je stablo, pa bi `basename` ispisao ime direktorija umjesto
    // onoga o čemu se sudi — izvještaj mora imenovati NAREDBU koja je pala.
    const head = failed.slice(0, 3).map((f) => `${f.kind} ${f.kind === 'task' ? f.cmd.join(' ') : basename(f.target)}: ${f.errorLine || `exit=${f.exitCode}`}`)
    return {
      ...base,
      status: 'fail',
      blocking: true,
      reason: `Kritičar je sam pokrenuo provjere i ${failed.length} je palo (od ${checks.length}). ${head.join(' | ')}`,
    }
  }
  if (unrunnable.length > 0) {
    const head = unrunnable.slice(0, 3).map((i) => `„${i.raw}": ${i.reason}`)
    return {
      ...base,
      status: 'unverifiable',
      blocking: false,
      reason: `Zadatak je propisao provjeru koju NIJE bilo moguće izvesti (${unrunnable.length}) — potpis zato NE MOŽE biti prolaz. ${head.join(' | ')}`,
    }
  }
  if (checks.length === 0) {
    return {
      ...base,
      status: 'unverifiable',
      blocking: false,
      reason: scan.files.length === 0
        ? 'Kritičar nije našao nijednu izmijenjenu datoteku u nadziranim stablima — nema izvršnog artefakta za provjeru.'
        : 'Izmijenjene datoteke nisu izvršne (nema koda ni testa) — strojna provjera ne postoji.',
    }
  }
  if (skipped.length > 0) {
    return {
      ...base,
      status: 'partial',
      blocking: false,
      reason: `Ništa nije palo, ali ${skipped.length} provjera nije stiglo unutar roka — ovo NIJE potvrda ispravnosti.`,
    }
  }
  return {
    ...base,
    status: 'pass',
    blocking: false,
    reason: `Sve provjere prošle (${checks.length}, ${ms} ms) — pokrenuo ih je kritičar, ne izvođač.`,
  }
}

/**
 * ŠTO je nedostajalo da bi se uopće imalo što provjeriti (T10 / TASK-3575).
 *
 * ZAŠTO POSTOJI: sud `unverifiable` je oznaka, a ne obavijest. Dojava koja kaže samo
 * „unverifiable" ne govori treba li zadatku test, ključ `[PROVJERA]` ili je agent radio
 * izvan nadziranog stabla — i takva se dojava za tjedan dana isključi kao šum. Ovdje se
 * razlozi IMENUJU, iz istih polja iz kojih je sud i donesen.
 *
 * Čista funkcija: `exists` se podmeće da provjera „nije git repozitorij" ne mora dirati disk.
 */
export function explainUnverified(
  verdict: CriticVerdict,
  cfg: CriticConfig = loadCriticConfig(),
  ctx: { roots?: string[]; exists?: (p: string) => boolean } = {},
): string[] {
  const out: string[] = []
  const checks = verdict.checks || []
  const scan = verdict.scan || { changedFiles: 0, truncated: 0, missingRoots: [] }
  const roots = ctx.roots && ctx.roots.length ? ctx.roots : cfg.watchRoots
  const exists = ctx.exists || existsSync

  // (a) Propisana provjera koja se nije mogla izvesti — najkonkretniji mogući razlog.
  for (const u of verdict.unrunnable || []) {
    out.push(`propisana provjera „${u.raw}" se NIJE mogla izvesti: ${u.reason}`)
  }

  // (b) Nema izmjena / izmjene nisu izvršne.
  if (checks.length === 0) {
    if (scan.changedFiles === 0) {
      out.push(`nijedna izmijenjena datoteka nije nađena u nadziranim stablima (${roots.join(', ') || 'nema korijena'}) — agent je radio izvan nadzora ili nije pisao na disk`)
      // „Nije git repozitorij" je RAZLOG zašto nema čistog polazišta: skup izmjena se
      // utvrđuje po mtimeu, pa se provjera ne može ograničiti na stvarni diff.
      for (const r of roots) {
        try {
          if (!exists(join(r, '.git'))) {
            out.push(`nadzirano stablo ${r} nije git repozitorij — nema diffa, skup izmjena se utvrđuje po vremenu izmjene (mtime)`)
          }
        } catch { /* ispitivanje putanje nikad ne ruši dojavu */ }
      }
    } else {
      out.push(`${scan.changedFiles} izmijenjenih datoteka, ali nijedna nije kod ni test (tražim ${[...cfg.parseExtensions, ...cfg.pythonExtensions, '.json'].join(' ')}) — nema što prevesti ni pokrenuti`)
    }
  }

  // (c) Zadatak nije propisao nijednu naredbu pregleda.
  const declaredRan = checks.filter((c) => c.kind === 'task').length
  if (declaredRan === 0 && (verdict.unrunnable || []).length === 0) {
    out.push('zadatak u opisu nema ključ `[PROVJERA] cmd:` — vratar nije imao nijednu dogovorenu naredbu za pokretanje')
  }

  // (d) Ima koda, ali nema pripadnog testa — raščlamba nije provjera ponašanja.
  if (checks.length > 0 && !checks.some((c) => c.kind === 'test')) {
    out.push(`za izmijenjene module nema pripadnog testa u ${cfg.testDir}/ — prošla je samo raščlamba, ne i ponašanje`)
  }

  // (e) Preskočeno zbog roka — put do suda `partial`.
  const skipped = checks.filter((c) => c.skipped).length
  if (skipped > 0) out.push(`${skipped} provjera nije stiglo unutar ukupnog roka (${cfg.totalBudgetMs} ms) — nisu ni pokrenute`)

  // (f) Rupe u pokrivenosti koje se nikad ne prešućuju.
  if (scan.truncated > 0) out.push(`strop od ${cfg.maxFiles} datoteka: ${scan.truncated} izmijenjenih uopće nije ušlo u provjeru`)
  if (scan.missingRoots && scan.missingRoots.length) out.push(`nadzirani korijen ne postoji: ${scan.missingRoots.join(', ')}`)

  if (out.length === 0) out.push(`kritičar nije naveo razlog (sud=${verdict.status}) — ${verdict.reason}`)
  return out
}

// ─── 5. Unakrsna provjera tvrdnji (savjetodavno) ─────────────────────────────

const CLAIM_FILE_RE = /\b[\w.\/-]+\.(ts|tsx|js|jsx|py|json|md|sh|sql|html|css|yml|yaml)\b/g
const CLAIM_TALLY_RE = /(\d+)\s*(?:test[a-z]*\s*)?pass/gi

export interface ClaimCheck {
  /** Datoteke spomenute u izvještaju kojih nema u skupu stvarnih izmjena. */
  unbacked: string[]
  /** Datoteke stvarno izmijenjene, a u izvještaju neopisane (ulaz za A3 — opseg). */
  unreported: string[]
  /** Najveći broj prolaza koji izvještaj tvrdi (usporedba s izmjerenim). */
  claimedPass: number | null
  /** W3: je li popis datoteka pročitan iz POLJA `datoteke`, ili izvučen iz proze? */
  izvor: 'polja' | 'proza'
}

/**
 * Izvještaj izvođača NE ULAZI u sud, ali se smije usporediti s izmjerenim. Namjerno je
 * savjetodavno: spomen datoteke ne znači i izmjenu (agent ju je mogao samo pročitati),
 * pa bi blokiranje po ovome bilo kažnjavanje poštenog izvještaja.
 *
 * W3/TASK-4615 — POLJA PRIJE PROZE: ako izvještaj nosi valjan blok `REGOC-IZLAZ`, popis
 * datoteka se uzima iz polja `datoteke` (agentova NAMJERA, izrečena strojno) umjesto iz
 * regexa nad rečenicama. Razlika nije kozmetička: prozni regex hvata svaku spomenutu
 * datoteku — i onu koju je agent samo pročitao ili citirao iz prompta — pa je `unbacked`
 * bio pun lažnih pogodaka. Kad bloka nema, sve ostaje kao prije.
 */
export function crossCheckClaims(resultText: string, changed: ChangedFile[]): ClaimCheck {
  const text = resultText || ''
  const changedBase = new Set(changed.map((c) => basename(c.path)))
  const mentioned = new Set<string>()
  const sud = ocijeniIzlazKoraka(text)
  const izPolja = sud.strojnoProvjerljiv && sud.datoteke.length > 0
  if (izPolja) for (const f of sud.datoteke) mentioned.add(basename(f))
  else for (const m of text.matchAll(CLAIM_FILE_RE)) mentioned.add(basename(m[0]))

  const unbacked = [...mentioned].filter((f) => !changedBase.has(f))
  const unreported = [...changedBase].filter((f) => !mentioned.has(f))

  let claimedPass: number | null = null
  for (const m of text.matchAll(CLAIM_TALLY_RE)) {
    const n = Number(m[1])
    if (Number.isFinite(n)) claimedPass = Math.max(claimedPass ?? 0, n)
  }
  return { unbacked, unreported, claimedPass, izvor: izPolja ? 'polja' : 'proza' }
}

// ─── 6. Kontrola petlje popravak → odbijanje → popravak ──────────────────────

export interface LedgerRound {
  ts: string
  taskId: string
  agentId: string
  round: number
  status: CriticStatus
  signatures: string[]
  enforced: boolean
  /**
   * Naredbe koje je propisao ZADATAK i koje su stvarno pokrenute (TASK-3460). Bez ovoga
   * se iz traga ne vidi RAZLIKA između „pass jer se datoteka raščlanjuje" i „pass jer je
   * dogovoreni pregled prošao" — a upravo o toj razlici ovisi `auto-on-signoff`.
   */
  declared?: string[]
  /** Propisane provjere koje se NISU mogle izvesti, s razlogom. */
  unrunnable?: string[]
  /**
   * ŠTO je nedostajalo da bi se uopće imalo što provjeriti (T10/TASK-3575). Piše se samo
   * kad sud NIJE provjerio ništa (`unverifiable`/`partial`) — ploča i dnevni sažetak čitaju
   * odavde, pa razlog ne mora nitko rekonstruirati iz teksta.
   */
  reasons?: string[]
}

export type NextAction =
  /** Zadatak smije dalje (prošlo, neprovjerljivo ili nedovršeno bez pada). */
  | 'accept'
  /** Vrati izvođaču s konkretnim kvarom — još ima krugova. */
  | 'repair'
  /** Stop. Petlja ne konvergira ili su krugovi potrošeni ⇒ odluku donosi čovjek. */
  | 'escalate'

export interface LoopDecision {
  action: NextAction
  round: number
  reason: string
  /** Potpisi koji se ponavljaju iz prethodnog kruga. */
  repeated: string[]
}

/**
 * Smije li se OVDJE pisati? Test-proces ne smije prljati živi trag: `critic-report.ts`
 * onda prijavljuje fixture kvarove kao stvarne, a upravo se po tom popisu odlučuje
 * hoće li se `criticGateLive` uopće upaliti. Izlaz za nuždu: REGOC_CRITIC_LEDGER.
 */
export function ledgerWriteAllowed(path: string): boolean {
  if (!isTestRuntime()) return true
  return path !== join(HOME, '.claude', 'regoc', 'data', 'critic_gate.jsonl')
}

/** Zapisi za jedan zadatak, najstariji prvi. */
export function readLedger(taskId: string, path = criticLedgerPath()): LedgerRound[] {
  try {
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as LedgerRound } catch { return null } })
      .filter((r): r is LedgerRound => !!r && r.taskId === taskId)
  } catch { return [] }
}

export function appendLedger(rec: LedgerRound, path = criticLedgerPath()): void {
  if (!ledgerWriteAllowed(path)) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(rec) + '\n')
  } catch { /* zapis kritičara nikad ne ruši poziv */ }
}

/**
 * Odgovor na „kako izbjeći beskonačnu petlju popravak–odbijanje".
 *
 * Dva neovisna osigurača, oba tvrda:
 *   (a) STROP KRUGOVA — nakon `maxRounds` odbijanja ide čovjek, bez obzira na sadržaj.
 *   (b) NEKONVERGENCIJA — isti potpis kvara u dva uzastopna kruga znači da popravak ne
 *       hvata uzrok. Treći pokušaj tada nije skupa nada nego sigurno bacanje novca, pa se
 *       staje ODMAH, i prije stropa.
 *
 * Eskalacija nikad ne gasi zadatak (`cancelled` je terminalan) — traži čovjeka.
 */
export function decideNextAction(
  history: LedgerRound[],
  verdict: CriticVerdict,
  cfg: CriticConfig = loadCriticConfig(),
): LoopDecision {
  // BROJE SE SAMO ODBIJENICE. `history` su SVI sudovi o ovom zadatku, a velika ih je
  // većina `pass`/`unverifiable` (mjereno 05.09.2026. na data/critic_gate.jsonl: 170 od
  // 176). Da se broje i oni, zadatak koji je prije bio uredno provjeren ulazio bi u prvu
  // svoju odbijenicu s već potrošenim krugovima i odmah eskalirao čovjeku — dakle W4
  // petlja mu se ne bi ni jednom okrenula. Krug je krug POPRAVKA, pa ga broji samo pad.
  const round = history.filter((h) => h.status === 'fail').length + 1
  if (verdict.status !== 'fail') {
    return { action: 'accept', round, reason: `sud=${verdict.status}, nema kvara koji bi vraćao zadatak`, repeated: [] }
  }
  const prev = history[history.length - 1]
  const repeated = prev ? verdict.signatures.filter((s) => prev.signatures.includes(s)) : []
  if (repeated.length > 0) {
    return {
      action: 'escalate',
      round,
      reason: `isti kvar po drugi put (${repeated[0]}) — popravak ne konvergira, sljedeći pokušaj ne bi bio jeftiniji ni pametniji`,
      repeated,
    }
  }
  if (round >= cfg.maxRounds + 1) {
    return { action: 'escalate', round, reason: `potrošeno ${cfg.maxRounds} krugova popravka`, repeated }
  }
  return { action: 'repair', round, reason: `kvar je nov (krug ${round}/${cfg.maxRounds}) — vraćam izvođaču s dokazom`, repeated }
}

// ─── 7. Sve zajedno (ulaz za daemon) ─────────────────────────────────────────

export interface CritiqueInput {
  taskId: string | null
  agentId: string
  /** Trenutak starta spawna — granica „što je ovaj agent dirao". */
  sinceMs: number
  /** Izvještaj izvođača: SAMO za unakrsnu provjeru tvrdnji, nikad kao dokaz. */
  resultText?: string
  /** true = sud se provodi; false = promatranje (log + zapis, ploča se ne dira). */
  live?: boolean
  /**
   * Koliko DRUGIH spawnova u ovom trenutku radi u istom stablu. Kad ih ima, granica po
   * `mtime` više ne dijeli „njegovo" od „tuđe" — vidi `attributionClean`.
   */
  concurrentSpawns?: number
  /**
   * Dodatni korijeni pretrage vezani uz OVAJ spawn — u praksi worktree koji mu je A1
   * napravio (`workspace.worktree.worktreePath`). Vidi `ScanRoot`: put je per-spawn
   * upravo zato da kritičar NE zaviruje u tuđe worktreejeve.
   */
  extraRoots?: ExtraRoot[]
  /**
   * Provjere koje je propisao SAM ZADATAK (TASK-3460), već raščlanjene iz `description`.
   * Raščlambu radi pozivatelj (`RegocDaemon.readTaskContext`) jer on jedini ima bazu;
   * kritičar ih dobiva kao ULAZ i ne čita ih sam.
   */
  declared?: DeclaredParse | null
  /**
   * Korijen stabla u kojem je spawn radio — jedina granica unutar koje se `cwd` propisane
   * provjere smije razriješiti. Bez njega se propisana provjera NE pokreće (fail-closed):
   * naredba pokrenuta u nepoznatom stablu ne dokazuje ništa.
   */
  rootDir?: string
}

export interface CritiqueOutcome {
  verdict: CriticVerdict
  loop: LoopDecision
  claims: ClaimCheck
  /** Smije li pozivatelj STVARNO zaustaviti zatvaranje zadatka. */
  enforce: boolean
  /** Gotov tekst za blocked_reason (prazan kad se ne provodi). */
  blockedReason: string
  /**
   * ŠTO je nedostajalo da bi se uopće imalo što provjeriti (T10/TASK-3575). Neprazno samo
   * kad sud NIJE ništa provjerio (`unverifiable`/`partial`); ulaz u dojavu korisniku.
   */
  reasons: string[]
}

/** Prefiksi razloga — strojno čitljivi, u duhu NEEDS_CONTEXT:/BLOCKED: iz CompletionGuarda. */
export const CRITIC_REPAIR_PREFIX = 'BLOCKED: CRITIC_FAILED'
export const CRITIC_ESCALATE_PREFIX = 'BLOCKED: CRITIC_ESCALATED'

/**
 * Pokreni kritiku nad onim što je spawn ostavio na disku. Nikad ne baca — kvar u
 * kritičaru ne smije zaustaviti ploču (fail-open na vlastitu grešku, fail-closed samo
 * na tuđi dokazani kvar).
 */
export function critiqueSpawn(input: CritiqueInput, cfg: CriticConfig = loadCriticConfig(), runner: CheckRunner = realRunner): CritiqueOutcome {
  const prep = prepareScan(input, cfg)
  let checks: CheckResult[] = []
  try {
    checks = runChecks(prep.plan, cfg, runner)
  } catch (e: any) {
    prep.notes.push(`kritičar je pao na vlastitoj grešci: ${String(e?.message || e).slice(0, 200)}`)
  }
  return finalizeCritique(input, cfg, prep, checks)
}

/**
 * Isti sud, bez blokiranja petlje događaja — ovo je put kojim ga zove RegocDaemon.
 * Sinkroni `critiqueSpawn` ostaje za CLI i testove.
 */
export async function critiqueSpawnAsync(
  input: CritiqueInput,
  cfg: CriticConfig = loadCriticConfig(),
  runner: AsyncCheckRunner = realRunnerAsync,
): Promise<CritiqueOutcome> {
  const prep = prepareScan(input, cfg)
  let checks: CheckResult[] = []
  try {
    checks = await runChecksAsync(prep.plan, cfg, runner)
  } catch (e: any) {
    prep.notes.push(`kritičar je pao na vlastitoj grešci: ${String(e?.message || e).slice(0, 200)}`)
  }
  return finalizeCritique(input, cfg, prep, checks)
}

interface ScanPrep { scan: ScanResult; plan: PlannedCheck[]; notes: string[]; declaredIssues: DeclaredIssue[] }

function prepareScan(input: CritiqueInput, cfg: CriticConfig): ScanPrep {
  const notes: string[] = []
  const declaredIssues: DeclaredIssue[] = []
  let scan: ScanResult = { files: [], truncated: 0, missingRoots: [] }
  let plan: PlannedCheck[] = []
  try {
    const extraRoots = input.extraRoots ?? []
    scan = scanChangedFiles(input.sinceMs, cfg, extraRoots)
    if (scan.truncated > 0) notes.push(`strop ${cfg.maxFiles} datoteka: ${scan.truncated} izmijenjenih NIJE provjereno`)
    if (scan.missingRoots.length) notes.push(`nadzirani korijen ne postoji: ${scan.missingRoots.join(', ')}`)
    // Vidljivo u tragu i u logu: bez ovoga se ne razlikuje „kritičar je gledao worktree
    // spawna" od „gledao je samo ~/.claude/regoc pa mu je potpis prazan" (A4 scope-mismatch).
    if (extraRoots.length) {
      const paths = extraRoots.map((r) => (typeof r === 'string' ? r : r.path))
      notes.push(`dodatni korijen ovog spawna: ${paths.join(', ')}`)
    }
    // Provjere koje je propisao zadatak (TASK-3460). Korijen je stablo OVOG spawna; kad
    // ga nema, pada se na prvi dodatni korijen, pa tek onda na nadzirano stablo — nikad
    // na `process.cwd()`.
    let declaredResolved: ResolvedCheck[] = []
    const declared = input.declared
    if (declared) {
      declaredIssues.push(...declared.issues)
      if (declared.checks.length) {
        const firstExtra = extraRoots.length ? (typeof extraRoots[0] === 'string' ? extraRoots[0] : extraRoots[0].path) : ''
        const root = input.rootDir || firstExtra || cfg.watchRoots[0] || ''
        const r = resolveDeclaredChecks(declared.checks, root)
        declaredResolved = r.checks
        declaredIssues.push(...r.issues)
      }
      if (declaredResolved.length) notes.push(`zadatak je propisao ${declaredResolved.length} provjeru/e: ${declaredResolved.map((d) => d.cmd.join(' ')).join(' | ')}`)
      if (declaredIssues.length) notes.push(`propisana provjera se NE MOŽE izvesti: ${declaredIssues.map((i) => `„${i.raw}" — ${i.reason}`).join('; ')}`)
    }

    plan = planChecks(scan.files, cfg, existsSync, declaredResolved)
  } catch (e: any) {
    notes.push(`kritičar je pao na vlastitoj grešci: ${String(e?.message || e).slice(0, 200)}`)
  }
  return { scan, plan, notes, declaredIssues }
}

function finalizeCritique(input: CritiqueInput, cfg: CriticConfig, prep: ScanPrep, checks: CheckResult[]): CritiqueOutcome {
  const taskId = input.taskId || 'bez-zadatka'
  const { scan, notes } = prep
  const claims = crossCheckClaims(input.resultText || '', scan.files)
  if (claims.unbacked.length) notes.push(`spomenuto u izvještaju, a nije izmijenjeno: ${claims.unbacked.slice(0, 5).join(', ')}`)
  if (claims.unreported.length) notes.push(`izmijenjeno, a neopisano: ${claims.unreported.slice(0, 5).join(', ')}`)

  /**
   * ATRIBUCIJA. Granica po `mtime` je poštena samo dok je u stablu jedan pisac. Kad uz
   * ovaj spawn radi još netko, u skup izmjena upada i TUĐA datoteka — možda nedovršena,
   * jer je taj agent još usred posla. Blokirati ovoga zbog toga bila bi lažna blokada
   * (točno onaj kvar zbog kojeg je 28.07. i nastao A1: tri pisca u istom stablu).
   *
   * Zato: kvar se i dalje MJERI i prijavljuje, ali ne obvezuje. Čistu atribuciju vraća
   * A1 (`worktreeIsolationLive`) — dok je on ugašen, ovo je pošteniji sud.
   */
  const concurrent = input.concurrentSpawns ?? 0
  const attributionClean = concurrent === 0
  if (!attributionClean) {
    notes.push(`u istom stablu radi još ${concurrent} spawn(ova) — atribucija po mtimeu nije čista, sud NE obvezuje (rješenje: A1 worktreeIsolationLive)`)
  }

  const verdict = judge(checks, scan, notes, prep.declaredIssues)
  if (!attributionClean) verdict.blocking = false
  // Povijest se čita SAMO kad zadatak postoji. Bez toga bi svi spawnovi bez zadatka
  // dijelili jednu pretinac-povijest („bez-zadatka") i tuđi ponovljeni kvar bi eskalirao
  // nečiji prvi pokušaj. (Uhvaćeno testom „LIVE: kvar blokira i nosi prefiks CRITIC_FAILED".)
  const history = input.taskId ? readLedger(input.taskId) : []
  const loop = decideNextAction(history, verdict, cfg)
  const live = !!input.live
  const enforce = live && verdict.blocking

  const blockedReason = !enforce
    ? ''
    : `${loop.action === 'escalate' ? CRITIC_ESCALATE_PREFIX : CRITIC_REPAIR_PREFIX}: ${verdict.reason} (${loop.reason})`.slice(0, 500)

  // T10/TASK-3575: sud koji NIJE ništa provjerio mora sa sobom nositi i RAZLOG. Računa se
  // ovdje, jednom, pa ga i trag i dojava i ploča čitaju iz istog izvora.
  const reasons = (verdict.status === 'unverifiable' || verdict.status === 'partial')
    ? explainUnverified(verdict, cfg, { roots: [...cfg.watchRoots, ...(input.rootDir ? [input.rootDir] : [])] })
    : []

  const declaredRun = verdict.checks.filter((c) => c.kind === 'task').map((c) => c.cmd.join(' '))
  appendLedger({
    ts: new Date().toISOString(),
    taskId,
    agentId: input.agentId,
    round: loop.round,
    status: verdict.status,
    signatures: verdict.signatures,
    enforced: enforce,
    ...(declaredRun.length ? { declared: declaredRun } : {}),
    ...(prep.declaredIssues.length ? { unrunnable: prep.declaredIssues.map((i) => `${i.raw} — ${i.reason}`) } : {}),
    ...(reasons.length ? { reasons } : {}),
  })

  return { verdict, loop, claims, enforce, blockedReason, reasons }
}

/** Jedan redak za daemon-log. Način rada (LIVE/PROMATRANJE) je uvijek vidljiv. */
export function formatCritiqueLog(taskId: string | null, o: CritiqueOutcome, live: boolean): string {
  const v = o.verdict
  // Propisana provjera se ISPISUJE doslovno: iz retka se mora vidjeti ŠTO je dogovoreno i
  // pokrenuto, inače se `pass` ne razlikuje od „datoteka se raščlanjuje" (TASK-3460).
  const declared = v.checks.filter((c) => c.kind === 'task')
  const propisano = declared.length ? ` propisano=[${declared.map((c) => `${c.ok ? '✓' : c.skipped ? '…' : '✗'} ${c.cmd.join(' ')}`).join(' | ')}]` : ''
  return `critic-gate: ${v.status.toUpperCase()} task=${taskId || 'N/A'} checks=${v.checks.length} failed=${v.failed.length} ${v.ms}ms akcija=${o.loop.action}${propisano} ${live ? (o.enforce ? 'BLOKIRAM' : 'live') : 'PROMATRANJE'}`
}

/** Izvještaj koji se vraća izvođaču: kvar + točna naredba kojom se reproducira. */
export function formatRepairBrief(o: CritiqueOutcome): string {
  const lines = [`Nezavisni kritičar je sam pokrenuo provjere i ${o.verdict.failed.length} je palo:`]
  for (const f of o.verdict.failed.slice(0, 10)) {
    lines.push(`  ✗ ${f.kind} — ${f.kind === 'task' ? `propisana provjera zadatka (cwd ${f.cwd})` : f.target}`)
    lines.push(`     naredba: ${f.cmd.join(' ')}  (exit=${f.exitCode}${f.timedOut ? ', ISTEKAO ROK' : ''})`)
    if (f.errorLine) lines.push(`     greška:  ${f.errorLine}`)
  }
  if (o.verdict.notes.length) lines.push(`  napomene: ${o.verdict.notes.join('; ')}`)
  lines.push(`  sljedeći korak: ${o.loop.action} — ${o.loop.reason}`)
  return lines.join('\n')
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2)
  const argOf = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`)
    return i >= 0 ? rest[i + 1] : undefined
  }

  if (cmd === 'check') {
    const sinceArg = argOf('since') || '15m'
    const m = /^(\d+)m$/.exec(sinceArg)
    const sinceMs = m ? Date.now() - Number(m[1]) * 60_000
      : /^\d+$/.test(sinceArg) ? Number(sinceArg)
      : Date.parse(sinceArg)
    if (!Number.isFinite(sinceMs)) { console.error('neispravan --since (očekujem 15m, ISO datum ili ms)'); process.exit(2) }
    const taskId = argOf('task') || null
    const live = rest.includes('--live')
    // `--worktree <put>` = ručna provjera A4 puta: kritičar gleda i stablo tog spawna.
    const wt = argOf('worktree')
    // `--desc-file <put>` = ručna provjera ključa `[PROVJERA]` iz opisa zadatka bez daemona
    // (TASK-3460); `--root <put>` je stablo unutar kojeg se `cwd` smije razriješiti.
    const descFile = argOf('desc-file')
    const rootDir = argOf('root') || wt
    let declared = null
    if (descFile) {
      try { declared = parseDeclaredChecks(readFileSync(descFile, 'utf-8')) }
      catch (e) { console.error(`ne mogu pročitati --desc-file: ${e}`); process.exit(2) }
    }
    const o = critiqueSpawn({
      taskId, agentId: argOf('agent') || 'cli', sinceMs, resultText: argOf('result') || '', live,
      extraRoots: wt ? [{ path: wt, sinceMs }] : undefined,
      declared, rootDir,
    })
    console.log(formatCritiqueLog(taskId, o, live))
    console.log(`  ${o.verdict.reason}`)
    for (const c of o.verdict.checks) {
      const mark = c.skipped ? '…' : c.ok ? '✓' : '✗'
      const what = c.kind === 'task' ? `${c.cmd.join(' ')}  (cwd ${c.cwd})` : c.target
      console.log(`  ${mark} ${c.kind.padEnd(5)} ${c.ms}ms  ${what}${c.ok || c.skipped ? '' : `  → ${c.errorLine}`}`)
    }
    if (o.verdict.notes.length) console.log(`  napomene: ${o.verdict.notes.join('; ')}`)
    process.exit(o.verdict.status === 'fail' ? 3 : 0)
  }

  if (cmd === 'ledger') {
    const taskId = argOf('task')
    if (!taskId) { console.error('koristi: ledger --task TASK-XXXX'); process.exit(2) }
    const rows = readLedger(taskId)
    if (!rows.length) { console.log(`nema zapisa za ${taskId}`); process.exit(0) }
    for (const r of rows) console.log(`${r.ts}  krug ${r.round}  ${r.status.padEnd(12)} enforced=${r.enforced}  ${r.signatures.slice(0, 2).join(' | ')}`)
    process.exit(0)
  }

  console.log(`CriticGate — nezavisni kritičar (A2/TASK-3001)

  bun CriticGate.ts check  --since 15m [--task TASK-X] [--agent ime] [--worktree PUT] [--live]
  bun CriticGate.ts ledger --task TASK-X

  --worktree gleda i stablo tog spawna (isti korijen koji daemon šalje kroz extraRoots).
  POZOR: ovdje granica ostaje --since, pa worktree napravljen UNUTAR tog prozora pokaže
  cijeli svoj checkout. Daemon tu zamku nema — on šalje trenutak kraja checkouta.

  exit 3 = provjere su pale.`)
  process.exit(0)
}
