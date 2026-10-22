#!/usr/bin/env bun
/**
 * WorktreeIsolation — svaki paralelni spawn u vlastitom git worktreeju (A1 / TASK-3000).
 *
 * ZAŠTO POSTOJI (dokazana šteta, 2026-07-28): tri paralelne Jelene uređivale su isti
 * `TaskWebUI.ts`; jedna je ubijena usred izmjene i ostavila sintaksnu grešku (obrnuti
 * navodnik u komentaru unutar HTML predloška) koja je rušila build. Zajedničko radno
 * stablo + istovremeni pisci = tuđi posao se ruši, a krivac se ne vidi.
 *
 * ŠTO RADI: prije spawna odlučuje hoće li agent raditi u ZAJEDNIČKOM stablu ili u
 * VLASTITOM git worktreeju, napravi ga, upiše ga u registar, i počisti ga nakon izlaska.
 * Modul je JEDINI IZVOR ISTINE za to pravilo; koristi ga:
 *   - RegocDaemon.spawnAgentOnDemand()   → odabir `cwd` spawna + oslobađanje u `finally`
 *   - tools/worktree-report.ts / CLI     → „što bi odlučio", stanje registra, žetva
 *
 * ŠTO NAMJERNO NE RADI: ne spaja ništa. Worktree u kojem je ostao posao se ČUVA i
 * prijavljuje (`preserved`), nikad se ne briše. Spajanje uz provjeru je posao vrata
 * prije spajanja (A4) — ovaj modul mu samo priprema izolirane grane.
 *
 * LICENCA/PODRIJETLO: zamisao (worktree po zadatku) pročitana je u projektu pod
 * PolyForm Noncommercial licencom, koja zabranjuje komercijalnu uporabu. Autorsko pravo
 * štiti IZRAZ, ne zamisao — ovo je vlastita izvedba: ni jedan redak, naziv datoteke,
 * naziv agenta ni format konfiguracije nije preuzet. Vidi docs/research/ALBERT_ANALIZA_20260728.md.
 *
 * IZMJERENA OGRANIČENJA OKOLINE (mjereno u testnom kontejneru, 2026-07-29):
 *   - `~/.claude` NIJE git repozitorij → baš datoteka iz incidenta (TaskManagerMD/src/
 *     TaskWebUI.ts) se NE MOŽE izolirati worktreejem. Odluka tada je `shared` s kodom
 *     `no-repo`, a kad su takva dva spawna istovremena, ide GLASNO upozorenje.
 *   - Disk: 8,4 GB slobodno (98% popunjeno) na istom LV-u za `/`, `~/.claude` i `~/app`.
 *     Zato tvrda brana `minFreeMb` i `maxRepoMb` — worktree je puna kopija radnog stabla.
 *   - `/tmp` je tmpfs 100 MB i **noexec** → nikad korijen worktreeja (checkout sa
 *     skriptama se ne bi mogao izvršiti).
 *   - Docker + uid 1001: `git worktree add` piše u `<repo>/.git/worktrees/`, pa repozitorij
 *     mora biti pisiv NAMA; tuđe vlasništvo (host root) daje „dubious ownership" i pad.
 *     Zato preflight, a pad → `shared` uz log, nikad srušen spawn.
 *
 * Autor: Jelena (Engineer) · 2026-07-29
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, appendFileSync } from 'fs'
import { join, basename, resolve } from 'path'
import { spawnSync } from 'child_process'
import { processStartMs } from './StaleCodeCheck'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()
export const WORKTREE_CONFIG_PATH = join(HOME, '.claude', 'regoc', 'config', 'worktree-isolation.json')
export const WORKTREE_JSONL_PATH = join(HOME, '.claude', 'regoc', 'data', 'worktree_isolation.jsonl')

// ============================================
// KONFIGURACIJA
// ============================================

export interface WorktreeConfig {
  /**
   * Korijen u kojem žive worktreejevi. NE smije biti unutar repozitorija (git status bi
   * ga vidio) niti u /tmp (100 MB tmpfs + noexec). Default je bind-mountani `~/app`
   * susjed, jer je na istom uređaju kao repozitoriji i preživi ponovnu izgradnju
   * kontejnera — za razliku od overlay sloja pod `~/`.
   */
  worktreeRoot: string
  /**
   * `off`    — nikad ne izoliraj (mehanizam mrtav, ostaje samo mjerenje).
   * `auto`   — izoliraj tek kad u ISTOM repozitoriju već radi drugi spawn (jeftino:
   *            usamljeni zadatak nema trošak ni teret spajanja).
   * `always` — svaki spawn u vlastitom worktreeju.
   */
  policy: 'off' | 'auto' | 'always'
  /** Ispod toliko slobodnog prostora (MB) se NE radi worktree. Disk je na 98%. */
  minFreeMb: number
  /** Repozitorij veći od toliko MB se ne kopira (npr. zephyr) — pada na zajedničko stablo. */
  maxRepoMb: number
  /** Koliko minuta nakon smrti spawna se napušteni worktree smije žeti. */
  graceMinutes: number
  /** Tagovi zadatka koji ZABRANJUJU izolaciju (zadatak mora vidjeti tuđe izmjene). */
  excludeTags: string[]
  /** Tagovi zadatka koji TRAŽE izolaciju bez obzira na `auto` pravilo. */
  includeTags: string[]
  /** Canary allowlist: dok nije prazna, izolira se SAMO te agente. */
  onlyAgents: string[]
  /** Prefiks grane izoliranog rada. */
  branchPrefix: string
  /** projectId → apsolutni put radnog stabla tog projekta (bez toga se ne zna gdje agent radi). */
  projectRepos: Record<string, string>
}

export const DEFAULT_WORKTREE_CONFIG: WorktreeConfig = {
  worktreeRoot: join(HOME, 'app', '.regoc-worktrees'),
  policy: 'auto',
  minFreeMb: 2048,
  maxRepoMb: 500,
  graceMinutes: 30,
  excludeTags: ['shared-tree', 'no-worktree', 'integration'],
  includeTags: ['isolate'],
  onlyAgents: [],
  branchPrefix: 'regoc/',
  projectRepos: {},
}

function asPositive(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
}

function asStrings(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(s => s.trim())
  return out
}

/** Čita se pri SVAKOJ odluci — izmjena konfiguracije djeluje bez restarta daemona. */
export function loadWorktreeConfig(path = WORKTREE_CONFIG_PATH): WorktreeConfig {
  const cfg: WorktreeConfig = { ...DEFAULT_WORKTREE_CONFIG }
  try {
    if (!existsSync(path)) return cfg
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (!raw || typeof raw !== 'object') return cfg
    if (typeof raw.worktreeRoot === 'string' && raw.worktreeRoot.trim()) cfg.worktreeRoot = raw.worktreeRoot.trim()
    if (raw.policy === 'off' || raw.policy === 'auto' || raw.policy === 'always') cfg.policy = raw.policy
    cfg.minFreeMb = asPositive(raw.minFreeMb, cfg.minFreeMb)
    cfg.maxRepoMb = asPositive(raw.maxRepoMb, cfg.maxRepoMb)
    cfg.graceMinutes = asPositive(raw.graceMinutes, cfg.graceMinutes)
    cfg.excludeTags = asStrings(raw.excludeTags, cfg.excludeTags)
    cfg.includeTags = asStrings(raw.includeTags, cfg.includeTags)
    cfg.onlyAgents = asStrings(raw.onlyAgents, cfg.onlyAgents)
    if (typeof raw.branchPrefix === 'string' && raw.branchPrefix.trim()) cfg.branchPrefix = raw.branchPrefix.trim()
    if (raw.projectRepos && typeof raw.projectRepos === 'object' && !Array.isArray(raw.projectRepos)) {
      const map: Record<string, string> = {}
      // Ključevi s '_' su komentari u konfiguraciji (kuća stil), ne projekti.
      for (const [k, v] of Object.entries(raw.projectRepos)) {
        if (k.startsWith('_')) continue
        if (typeof v === 'string' && v.trim()) map[k] = v.trim()
      }
      cfg.projectRepos = map
    }
  } catch {
    // Neispravna konfiguracija NE smije srušiti spawn — vraćaju se defaulti.
  }
  return cfg
}

// ============================================
// ODLUKA (čista funkcija — srce mehanizma)
// ============================================

export type IsolationMode = 'worktree' | 'shared'

export type IsolationCode =
  | 'policy-off'          // mehanizam isključen konfiguracijom
  | 'opt-out-tag'         // zadatak izrijekom traži zajedničko stablo
  | 'opt-in-tag'          // zadatak izrijekom traži izolaciju
  | 'canary'              // agent nije u canary allowlisti
  | 'no-repo'             // radno stablo nije git repozitorij → izolacija nemoguća
  | 'git-unusable'        // git ne može raditi s tim repozitorijem (vlasništvo, korupcija)
  | 'repo-not-writable'   // `git worktree add` piše u .git; bez prava nema worktreeja
  | 'low-disk'            // premalo slobodnog prostora
  | 'repo-too-large'      // kopija radnog stabla bi bila preskupa
  | 'solo'                // nitko drugi ne radi u tom repozitoriju → nema se s kim sudariti
  | 'collision'           // već radi drugi spawn u istom repozitoriju → izoliraj
  | 'policy-always'       // konfiguracija traži izolaciju uvijek

export interface IsolationDecision {
  mode: IsolationMode
  code: IsolationCode
  reason: string
  /** Glasno upozorenje: sudar je moguć, a mehanizam ga NE MOŽE spriječiti. */
  warn?: string
}

export interface DecisionInput {
  taskId: string | null
  agentId: string
  /** Korijen git repozitorija radnog stabla, ili null ako to nije repozitorij. */
  repoRoot: string | null
  /** Tagovi zadatka (iz `tasks.tags`). */
  tags?: string[]
  /** Koliko DRUGIH spawnova upravo radi u istom radnom stablu (bez ovoga). */
  activeInSameTree: number
  /** Rezultat preflighta repozitorija; null kad repoRoot ne postoji. */
  preflight: RepoPreflight | null
}

/** Hrvatski brojevni oblik: 1 drugi spawn / 2–4 druga spawna / 5+ drugih spawnova. */
function pluralSpawn(n: number): string {
  const last2 = n % 100
  const last = n % 10
  if (last === 1 && last2 !== 11) return 'drugi spawn'
  if (last >= 2 && last <= 4 && (last2 < 12 || last2 > 14)) return 'druga spawna'
  return 'drugih spawnova'
}

/**
 * Jedina funkcija koja odlučuje. Čista je (bez diska i gita) da se svako pravilo može
 * dokazati testom — uključujući ono najvažnije: „nema repozitorija, a ima sudara".
 */
export function decideIsolation(input: DecisionInput, cfg: WorktreeConfig): IsolationDecision {
  const tags = (input.tags || []).map(t => t.toLowerCase())
  const collides = input.activeInSameTree > 0
  const collisionNote = `${input.activeInSameTree} ${pluralSpawn(input.activeInSameTree)} u istom stablu`

  if (cfg.policy === 'off') {
    return { mode: 'shared', code: 'policy-off', reason: 'izolacija isključena konfiguracijom (policy=off)' }
  }

  const optOut = cfg.excludeTags.find(t => tags.includes(t.toLowerCase()))
  if (optOut) {
    return {
      mode: 'shared',
      code: 'opt-out-tag',
      reason: `zadatak nosi tag '${optOut}' — mora vidjeti izmjene ostalih, radi u zajedničkom stablu`,
      warn: collides ? `tag '${optOut}' isključuje izolaciju, a ${collisionNote} — sudar je moguć` : undefined,
    }
  }

  if (cfg.onlyAgents.length > 0 && !cfg.onlyAgents.includes(input.agentId)) {
    return {
      mode: 'shared',
      code: 'canary',
      reason: `agent '${input.agentId}' nije u canary allowlisti (${cfg.onlyAgents.join(', ')})`,
      warn: collides ? `canary isključuje izolaciju, a ${collisionNote}` : undefined,
    }
  }

  if (!input.repoRoot) {
    return {
      mode: 'shared',
      code: 'no-repo',
      reason: 'radno stablo nije git repozitorij — worktree izolacija je nemoguća',
      // Ovo je točno slučaj `~/.claude` iz incidenta 28.07. Bez repozitorija se ne može
      // izolirati NIŠTA, pa je jedino pošteno ponašanje glasan alarm, a ne tiha nada.
      warn: collides
        ? `IZOLACIJA NEMOGUĆA: ${collisionNote} nad stablom bez gita — ovo je oblik kvara od 2026-07-28 (tri pisca nad TaskWebUI.ts). Rjesenje: git-ificirati to stablo ili serijalizirati zadatke (blockedBy).`
        : undefined,
    }
  }

  const pf = input.preflight
  if (!pf || !pf.gitOk) {
    return {
      mode: 'shared',
      code: 'git-unusable',
      reason: `git ne može raditi s '${input.repoRoot}'${pf?.note ? ` (${pf.note})` : ''}`,
      warn: collides ? `${collisionNote}, a izolacija nije izvediva` : undefined,
    }
  }
  if (!pf.writable) {
    return {
      mode: 'shared',
      code: 'repo-not-writable',
      reason: `repozitorij '${input.repoRoot}' nije pisiv (uid ${process.getuid?.() ?? '?'}) — 'git worktree add' piše u .git/worktrees`,
      warn: collides ? `${collisionNote}, a izolacija nije izvediva` : undefined,
    }
  }
  if (pf.freeMb < cfg.minFreeMb) {
    return {
      mode: 'shared',
      code: 'low-disk',
      reason: `slobodno ${pf.freeMb} MB < prag ${cfg.minFreeMb} MB — kopija radnog stabla bi ugrozila disk`,
      warn: collides ? `${collisionNote}, a izolacija je odbijena zbog diska` : undefined,
    }
  }
  if (pf.repoMb > cfg.maxRepoMb) {
    return {
      mode: 'shared',
      code: 'repo-too-large',
      reason: `radno stablo ${pf.repoMb} MB > prag ${cfg.maxRepoMb} MB — kopija je preskupa`,
      warn: collides ? `${collisionNote}, a izolacija je odbijena zbog veličine` : undefined,
    }
  }

  const optIn = cfg.includeTags.find(t => tags.includes(t.toLowerCase()))
  if (optIn) {
    return { mode: 'worktree', code: 'opt-in-tag', reason: `zadatak nosi tag '${optIn}' — izolacija izrijekom tražena` }
  }
  if (cfg.policy === 'always') {
    return { mode: 'worktree', code: 'policy-always', reason: 'policy=always — svaki spawn dobiva vlastito stablo' }
  }
  if (collides) {
    return { mode: 'worktree', code: 'collision', reason: `${collisionNote} — izoliram da se pisci ne poklope` }
  }
  return { mode: 'shared', code: 'solo', reason: 'nitko drugi ne radi u tom stablu — nema se s kim sudariti' }
}

// ============================================
// GIT / DISK — sve preko injektabilnih sondi (testovi ne diraju stvarni disk)
// ============================================

export interface RunResult { code: number; stdout: string; stderr: string }
export type GitRunner = (args: string[], cwd?: string) => RunResult

export const realGit: GitRunner = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 60_000 })
  return {
    code: typeof r.status === 'number' ? r.status : 1,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  }
}

/** Slobodan prostor (MB) na uređaju zadanog puta. `df -Pk` jer statfs nije svugdje isti. */
export function freeMbOf(path: string): number {
  try {
    const r = spawnSync('df', ['-Pk', path], { encoding: 'utf-8', timeout: 10_000 })
    const line = (r.stdout || '').trim().split('\n')[1] || ''
    const kb = Number(line.split(/\s+/)[3])
    return Number.isFinite(kb) ? Math.floor(kb / 1024) : 0
  } catch { return 0 }
}

/** Veličina radnog stabla (MB), bez .git — to je ono što se kopira u worktree. */
export function repoWorkTreeMb(repoRoot: string): number {
  try {
    const r = spawnSync('du', ['-sm', '--exclude=.git', repoRoot], { encoding: 'utf-8', timeout: 60_000 })
    const mb = Number((r.stdout || '').trim().split(/\s+/)[0])
    return Number.isFinite(mb) ? mb : Number.MAX_SAFE_INTEGER
  } catch { return Number.MAX_SAFE_INTEGER }
}

export interface RepoPreflight {
  repoRoot: string
  gitOk: boolean
  writable: boolean
  freeMb: number
  repoMb: number
  note?: string
}

export interface Probes {
  git?: GitRunner
  freeMb?: (path: string) => number
  repoMb?: (repoRoot: string) => number
  canWrite?: (path: string) => boolean
}

function defaultCanWrite(path: string): boolean {
  // Pravo pisanja u .git je ono što `git worktree add` stvarno treba (registrira se u
  // .git/worktrees). Provjerava se stvarnim upisom, ne bitovima moda — bind-mount i
  // uid 1001 znaju lagati kroz mode.
  try {
    const probe = join(path, `.regoc-write-probe-${process.pid}`)
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return true
  } catch { return false }
}

/** Korijen git repozitorija za zadani direktorij, ili null. */
export function detectRepoRoot(dir: string, probes: Probes = {}): string | null {
  if (!dir || !existsSync(dir)) return null
  const git = probes.git || realGit
  const r = git(['rev-parse', '--show-toplevel'], dir)
  if (r.code !== 0) return null
  const top = r.stdout.split('\n')[0]?.trim()
  return top ? top : null
}

export function preflightRepo(repoRoot: string, probes: Probes = {}): RepoPreflight {
  const git = probes.git || realGit
  const freeFn = probes.freeMb || freeMbOf
  const sizeFn = probes.repoMb || repoWorkTreeMb
  const writeFn = probes.canWrite || defaultCanWrite

  const out: RepoPreflight = { repoRoot, gitOk: false, writable: false, freeMb: 0, repoMb: Number.MAX_SAFE_INTEGER }

  // `git status` hvata i „dubious ownership" (tuđi uid preko bind-mounta) i oštećen .git.
  const st = git(['status', '--porcelain'], repoRoot)
  if (st.code !== 0) {
    out.note = st.stderr.split('\n')[0] || `git status exit ${st.code}`
    return out
  }
  out.gitOk = true
  out.writable = writeFn(join(repoRoot, '.git'))
  out.freeMb = freeFn(repoRoot)
  out.repoMb = sizeFn(repoRoot)
  return out
}

// ============================================
// STVARANJE / OSLOBAĐANJE
// ============================================

export interface WorktreeRecord {
  id: string
  taskId: string | null
  agentId: string
  repoRoot: string
  worktreePath: string
  branch: string
  baseCommit: string
  pid: number | null
  /** Trenutak starta procesa (jiffies→ms) — brana protiv ponovno iskorištenog PID-a. */
  pidStartMs: number | null
  createdAtMs: number
  createdAt: string
}

function sanitize(s: string): string {
  return (s || '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60) || 'x'
}

function registryDir(cfg: WorktreeConfig): string {
  return join(cfg.worktreeRoot, '.registry')
}

export function writeRecord(cfg: WorktreeConfig, rec: WorktreeRecord): string {
  const dir = registryDir(cfg)
  mkdirSync(dir, { recursive: true })
  const p = join(dir, `${rec.id}.json`)
  writeFileSync(p, JSON.stringify(rec, null, 2))
  return p
}

export function listWorktreeRecords(cfg: WorktreeConfig): WorktreeRecord[] {
  const dir = registryDir(cfg)
  if (!existsSync(dir)) return []
  const out: WorktreeRecord[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as WorktreeRecord
      if (rec && typeof rec.worktreePath === 'string') out.push(rec)
    } catch { /* neispravan zapis ne smije srušiti pregled */ }
  }
  return out.sort((a, b) => a.createdAtMs - b.createdAtMs)
}

export function removeRecord(cfg: WorktreeConfig, id: string): void {
  try { rmSync(join(registryDir(cfg), `${id}.json`), { force: true }) } catch {}
}

/**
 * TASK-5674: sačuvani worktree ZADATKA — zadnji (po `createdAtMs`) zapis s istim `taskId` i
 * `repoRoot` čije stablo još postoji na disku. Ponovni spawn istog zadatka (dorada, reclaim
 * iz `blocked`) mora nastaviti U NJEMU: tamo su njegovi commiti i testovi. Inače dobije
 * glavno stablo („shared (solo)"), a kritičar propisane provjere pokrene na grani main gdje
 * testova još nema — TASK-5657 je tako dvaput pao bez ijednog izvedenog testa.
 */
export function sacuvaniWorktreeZadatka(
  cfg: WorktreeConfig,
  taskId: string | null | undefined,
  repoRoot: string | null | undefined,
  exists: (p: string) => boolean = existsSync,
): WorktreeRecord | null {
  if (!taskId || !repoRoot) return null
  const kandidati = listWorktreeRecords(cfg)
    .filter((r) => r.taskId === taskId && r.repoRoot === repoRoot && exists(r.worktreePath))
  return kandidati.length ? kandidati[kandidati.length - 1] : null
}

/**
 * TASK-5680: korijen propisanih provjera kritičara na putu ZAHTJEVA zatvaranja (nema spawna,
 * pa ni `workspace.cwd`). Redom: sačuvani worktree zadatka (u repozitoriju projekta, inače
 * bilo kojem) → mapirano stablo projekta → `fallback`. Prije je ondje stajao `$HOME`, pa je
 * `bun test tests/bootcheck.test.ts` (TASK-5657) padao s „filters did not match any test files".
 */
export function korijenKriticaraZahtjeva(
  cfg: WorktreeConfig,
  taskId: string | null | undefined,
  projectId: string | null | undefined,
  fallback = HOME,
  probes: Probes = {},
  exists: (p: string) => boolean = existsSync,
): string {
  const workDir = resolveProjectWorkDir(cfg, projectId, fallback)
  const repoRoot = workDir !== fallback ? detectRepoRoot(workDir, probes) : null
  const sacuvan = sacuvaniWorktreeZadatka(cfg, taskId, repoRoot, exists)
    ?? (taskId ? listWorktreeRecords(cfg).filter((r) => r.taskId === taskId && exists(r.worktreePath)).pop() ?? null : null)
  return sacuvan ? sacuvan.worktreePath : workDir
}

export interface CreateWorktreeInput {
  taskId: string | null
  agentId: string
  repoRoot: string
  pid?: number | null
  nowMs: number
}

/**
 * Napravi worktree na NOVOJ grani iz trenutnog HEAD-a. Izolirano stablo vidi zadnji
 * COMMIT, ne tuđe nespremljene izmjene — to je cijena izolacije i mora se znati unaprijed.
 */
export function createWorktree(cfg: WorktreeConfig, input: CreateWorktreeInput, probes: Probes = {}): WorktreeRecord {
  const git = probes.git || realGit
  const id = `${sanitize(input.taskId || 'no-task')}__${sanitize(input.agentId)}__${input.nowMs}`
  const root = join(cfg.worktreeRoot, sanitize(basename(input.repoRoot)))
  mkdirSync(root, { recursive: true })
  const path = join(root, id)
  const branch = `${cfg.branchPrefix}${sanitize(input.taskId || 'adhoc')}-${sanitize(input.agentId)}-${input.nowMs}`

  // Ostaci prethodnih generacija (kontejner presložen, daemon ubijen) inače blokiraju
  // `git worktree add` s „already registered".
  git(['worktree', 'prune'], input.repoRoot)

  const head = git(['rev-parse', 'HEAD'], input.repoRoot)
  const baseCommit = head.code === 0 ? head.stdout.split('\n')[0] : ''

  const add = git(['worktree', 'add', '-b', branch, path, 'HEAD'], input.repoRoot)
  if (add.code !== 0) {
    throw new Error(`git worktree add nije uspio: ${add.stderr.split('\n')[0] || `exit ${add.code}`}`)
  }

  const rec: WorktreeRecord = {
    id,
    taskId: input.taskId,
    agentId: input.agentId,
    repoRoot: input.repoRoot,
    worktreePath: path,
    branch,
    baseCommit,
    pid: input.pid ?? null,
    pidStartMs: input.pid ? processStartMs(input.pid) : null,
    createdAtMs: input.nowMs,
    createdAt: new Date(input.nowMs).toISOString(),
  }
  writeRecord(cfg, rec)
  return rec
}

/** Ima li u worktreeju ičega što bi se brisanjem izgubilo? */
export function hasWork(rec: WorktreeRecord, probes: Probes = {}): boolean {
  const git = probes.git || realGit
  const st = git(['status', '--porcelain'], rec.worktreePath)
  if (st.code !== 0) return true            // ne znamo → čuvamo
  if (st.stdout.trim().length > 0) return true
  if (!rec.baseCommit) return false
  const ahead = git(['rev-list', '--count', `${rec.baseCommit}..HEAD`], rec.worktreePath)
  if (ahead.code !== 0) return true
  return Number(ahead.stdout.trim() || '0') > 0
}

export type ReleaseOutcome = 'removed' | 'preserved' | 'missing' | 'failed'

export interface ReleaseResult {
  outcome: ReleaseOutcome
  record: WorktreeRecord
  detail: string
}

/**
 * Oslobodi worktree nakon izlaska spawna.
 *   - prazan (bez izmjena i bez commita)  → briše se i registracija nestaje
 *   - ima posla                            → ČUVA se; put ide u izvještaj (A4 ga spaja)
 * Posao agenta se NIKAD ne briše automatski. Tiho brisanje tuđeg rada je gori kvar od
 * zaostalog direktorija.
 */
export function releaseWorktree(cfg: WorktreeConfig, rec: WorktreeRecord, probes: Probes = {}): ReleaseResult {
  const git = probes.git || realGit
  if (!existsSync(rec.worktreePath)) {
    git(['worktree', 'prune'], rec.repoRoot)
    removeRecord(cfg, rec.id)
    return { outcome: 'missing', record: rec, detail: 'worktree više ne postoji na disku — registracija očišćena' }
  }
  if (hasWork(rec, probes)) {
    return {
      outcome: 'preserved',
      record: rec,
      detail: `ostavljen posao u ${rec.worktreePath} (grana ${rec.branch}) — čeka provjeru i spajanje`,
    }
  }
  const rm = git(['worktree', 'remove', '--force', rec.worktreePath], rec.repoRoot)
  if (rm.code !== 0) {
    return { outcome: 'failed', record: rec, detail: `git worktree remove nije uspio: ${rm.stderr.split('\n')[0] || `exit ${rm.code}`}` }
  }
  // Grana bez ijednog commita je smeće — briše se s worktreejem.
  git(['branch', '-D', rec.branch], rec.repoRoot)
  removeRecord(cfg, rec.id)
  return { outcome: 'removed', record: rec, detail: `prazan worktree uklonjen (${rec.worktreePath})` }
}

// ============================================
// ŽETVA NAPUŠTENIH (daemon ubijen → `finally` nikad nije ni pokrenut)
// ============================================

export type AliveProbe = (pid: number | null, pidStartMs: number | null) => boolean

/** Živ je samo proces koji postoji I ima isti trenutak starta (PID se recikliraju). */
export const realAliveProbe: AliveProbe = (pid, pidStartMs) => {
  if (!pid) return false
  const started = processStartMs(pid)
  if (started === null) return false
  if (pidStartMs === null) return true
  return Math.abs(started - pidStartMs) < 2000
}

export interface ReapOptions {
  nowMs: number
  alive?: AliveProbe
  probes?: Probes
  /** true → samo prijavi što BI napravio (dry-run). */
  dryRun?: boolean
}

export interface ReapEntry {
  record: WorktreeRecord
  action: 'kept-alive' | 'kept-young' | 'removed' | 'preserved' | 'missing' | 'failed'
  detail: string
}

/**
 * Prođi registar i počisti worktreejeve čiji je spawn mrtav dulje od grace perioda.
 * Prazni se brišu, oni s poslom se ČUVAJU i prijavljuju. Zove se pri startu daemona
 * (tada je „mrtav" i cijela prethodna generacija) i periodično.
 */
export function reapAbandonedWorktrees(cfg: WorktreeConfig, opts: ReapOptions): ReapEntry[] {
  const alive = opts.alive || realAliveProbe
  const graceMs = cfg.graceMinutes * 60_000
  const out: ReapEntry[] = []
  for (const rec of listWorktreeRecords(cfg)) {
    if (alive(rec.pid, rec.pidStartMs)) {
      out.push({ record: rec, action: 'kept-alive', detail: `spawn pid ${rec.pid} još radi` })
      continue
    }
    const ageMs = opts.nowMs - rec.createdAtMs
    if (ageMs < graceMs) {
      out.push({ record: rec, action: 'kept-young', detail: `mrtav, ali mlađi od ${cfg.graceMinutes} min (${Math.round(ageMs / 60000)} min)` })
      continue
    }
    if (opts.dryRun) {
      out.push({ record: rec, action: 'preserved', detail: 'dry-run — ništa nije dirano' })
      continue
    }
    const res = releaseWorktree(cfg, rec, opts.probes || {})
    out.push({ record: rec, action: res.outcome === 'removed' ? 'removed' : res.outcome, detail: res.detail })
  }
  return out
}

// ============================================
// ZAPIS ODLUKA (mjerenje prije uključivanja — shadow)
// ============================================

export interface DecisionLogEntry {
  ts: string
  taskId: string | null
  agentId: string
  mode: IsolationMode
  code: IsolationCode
  live: boolean
  repoRoot: string | null
  workDir: string
  activeInSameTree: number
  reason: string
  warn?: string
  worktreePath?: string
}

export function appendDecisionLog(entry: DecisionLogEntry, path = WORKTREE_JSONL_PATH): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    appendFileSync(path, JSON.stringify(entry) + '\n')
  } catch { /* mjerenje nikad ne ruši spawn */ }
}

export function formatDecision(d: IsolationDecision, input: DecisionInput, live: boolean): string {
  const tag = live ? '' : ' SHADOW'
  const icon = d.mode === 'worktree' ? '🌿' : '📂'
  const head = `${icon} [worktree${tag}] ${input.agentId}/${input.taskId || 'bez-zadatka'} → ${d.mode} (${d.code}): ${d.reason}`
  return d.warn ? `${head}\n   ⚠️ ${d.warn}` : head
}

// ============================================
// SASTAVLJENI PUT (ono što daemon zove)
// ============================================

export interface PlanInput {
  taskId: string | null
  agentId: string
  /** Radni direktorij u kojem bi agent inače radio (danas: HOME). */
  workDir: string
  tags?: string[]
  /** Broj DRUGIH aktivnih spawnova u istom radnom stablu. */
  activeInSameTree: number
}

export interface IsolationPlan {
  decision: IsolationDecision
  repoRoot: string | null
  input: DecisionInput
  workDir: string
}

/** Odluči (bez ikakve izmjene na disku): detekcija repozitorija + preflight + pravilo. */
export function planIsolation(cfg: WorktreeConfig, p: PlanInput, probes: Probes = {}): IsolationPlan {
  const repoRoot = detectRepoRoot(p.workDir, probes)
  const preflight = repoRoot ? preflightRepo(repoRoot, probes) : null
  const input: DecisionInput = {
    taskId: p.taskId,
    agentId: p.agentId,
    repoRoot,
    tags: p.tags,
    activeInSameTree: p.activeInSameTree,
    preflight,
  }
  return { decision: decideIsolation(input, cfg), repoRoot, input, workDir: p.workDir }
}

/** projectId → radno stablo projekta; bez mapiranja pada na zadani direktorij. */
export function resolveProjectWorkDir(cfg: WorktreeConfig, projectId: string | null | undefined, fallback = HOME): string {
  if (!projectId) return fallback
  const mapped = cfg.projectRepos[projectId]
  if (!mapped) return fallback
  const abs = resolve(mapped.replace(/^~(?=$|\/)/, HOME))
  return existsSync(abs) ? abs : fallback
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2)
  const cfg = loadWorktreeConfig()
  const cmd = args[0] || 'status'

  if (cmd === 'status') {
    const recs = listWorktreeRecords(cfg)
    console.log(`Korijen: ${cfg.worktreeRoot}  policy=${cfg.policy}  minFree=${cfg.minFreeMb}MB  maxRepo=${cfg.maxRepoMb}MB`)
    console.log(`Slobodno na korijenu: ${freeMbOf(existsSync(cfg.worktreeRoot) ? cfg.worktreeRoot : HOME)} MB`)
    console.log(`Registriranih worktreejeva: ${recs.length}`)
    for (const r of recs) {
      const live = realAliveProbe(r.pid, r.pidStartMs)
      console.log(`  ${live ? '🟢' : '⚪'} ${r.id}  pid=${r.pid ?? '-'}  ${r.branch}  ${r.worktreePath}`)
    }
    process.exit(0)
  }

  if (cmd === 'plan') {
    const dir = args[1] || HOME
    const plan = planIsolation(cfg, { taskId: args[2] || null, agentId: args[3] || 'jelena', workDir: dir, activeInSameTree: Number(args[4] || 0) })
    console.log(formatDecision(plan.decision, plan.input, false))
    console.log(`   repoRoot=${plan.repoRoot ?? 'nije git repozitorij'}`)
    if (plan.input.preflight) console.log(`   preflight: ${JSON.stringify(plan.input.preflight)}`)
    process.exit(plan.decision.mode === 'worktree' ? 0 : 0)
  }

  if (cmd === 'reap') {
    const dry = !args.includes('--live')
    const entries = reapAbandonedWorktrees(cfg, { nowMs: Date.now(), dryRun: dry })
    console.log(`Žetva (${dry ? 'DRY-RUN' : 'LIVE'}): ${entries.length} zapisa`)
    for (const e of entries) console.log(`  ${e.action.padEnd(12)} ${e.record.id} — ${e.detail}`)
    process.exit(0)
  }

  console.log('Uporaba: bun WorktreeIsolation.ts [status|plan <dir> [taskId] [agent] [aktivnih]|reap [--live]]')
  process.exit(2)
}
