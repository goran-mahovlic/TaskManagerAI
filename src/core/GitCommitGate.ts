/**
 * GitCommitGate — zadatak bez ijednog commita ne prolazi u `completed` (U4 / TASK-4264).
 *
 * Razrada: `~/app/regoc_system/docs/RAZRADA-3691_workflow_i_pragovi.md` §4 („Git — obavezno i
 * mjerljivo"), pravilo 15: napredak mora biti durabilan.
 *
 * KVAR KOJI OVO ZATVARA. Rad koji nije commitan živi u radnom stablu jedne sjednice: sljedeći
 * agent ga pregazi, restart ga izgubi, a ploča i dalje pokazuje ✅. Mjereno (A4/MergeGate):
 * samo 1,4 % zadataka uopće dodiruje git repozitorij, pa je „gotovo" najčešće tvrdnja bez
 * traga. Vratar traži TRAG, ne tvrdnju.
 *
 * ── DVA IZVORA DOKAZA, RAZLIČITE TEŽINE ──────────────────────────────────────────────────
 *   1. `git log --all --grep=TASK-####` u poznatim repozitorijima — dokaz koji piše git.
 *      Agent ga ne može izmisliti; ovo je primarni izvor.
 *   2. SHA naveden u `result_summary` — dopušten jer commit može nastati u repozitoriju koji
 *      nije na popisu (Goranovi projekti izvan `~/app`). Slabiji, ali provjerljiv unatrag.
 *
 * ── ZAŠTO DOSEG NIJE „SVI ZADACI" ────────────────────────────────────────────────────────
 * Zahtjev glasi „zadatak bez ijednog commita ne prolazi u completed". Da to danas krene nad
 * cijelom pločom, palo bi ~98 % zatvaranja — jer 98 % zadataka i ne nastaje u repozitoriju
 * (izmjereno A4). Vratar koji blokira uredan rad biva isključen u tjedan dana (naučeno na
 * `SecurityValidator` hooku), pa doseg kreće od zadataka koji su OTVORENI PO PREDLOŠKU (oznaka
 * `lanac`) — njima git obveza piše u opisu, dakle kažnjava se pravilo koje je izvršitelj vidio.
 * Širenje je jedna izmjena konfiguracije: `scopeTags: ["*"]`.
 *
 * Autorica: Kosjenka (Architect), TASK-4264.
 */

import { CHAIN_TAG, TEXT_ONLY_TAG, branchName, gitCommitCommand, isTextOnly } from './WorkflowTemplate'

// ─── Prepoznavanje commita u tekstu ──────────────────────────────────────────

/**
 * „commit a1b2c3d", „SHA: a1b2c3d", „commitala sam kao a1b2c3d".
 *
 * Razmak između riječi i otiska je LIJEN `[^\n]{0,32}?`, a ne „sve osim hex znamenki":
 * hrvatska rečenica između („sam kao") gotovo uvijek sadrži a–f, pa je uža inačica
 * propuštala baš uobičajen oblik izvještaja. Ostaje unutar jednog retka i 32 znaka.
 */
export const COMMIT_DECLARATION_RE =
  /\b(?:commit\w*|sha|hash|revizij\w*)\b[^\n]{0,32}?\b([0-9a-f]{7,40})\b/gi

/** Redak iz `git log --oneline`: `a1b2c3d TASK-4264 korak 6: …` — najjači tekstualni dokaz. */
export const GIT_LOG_LINE_RE = /(?:^|\n)\s*([0-9a-f]{7,40})\s+(?=\S)[^\n]*\bTASK-\d+/gi

export interface CommitRef {
  sha: string
  via: 'git_log' | 'declaration' | 'repo'
  repo?: string
}

function pushRef(out: CommitRef[], seen: Set<string>, ref: CommitRef): void {
  const sha = ref.sha.trim().toLowerCase()
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return
  if (seen.has(sha)) return
  seen.add(sha)
  out.push({ ...ref, sha })
}

/** Svi commit-otisci navedeni u tekstu, bez ponavljanja. */
export function extractCommitRefs(text?: string | null): CommitRef[] {
  const t = String(text || '')
  if (!t) return []
  const out: CommitRef[] = []
  const seen = new Set<string>()
  for (const m of t.matchAll(GIT_LOG_LINE_RE)) pushRef(out, seen, { sha: m[1], via: 'git_log' })
  for (const m of t.matchAll(COMMIT_DECLARATION_RE)) pushRef(out, seen, { sha: m[1], via: 'declaration' })
  return out
}

// ─── Doseg ───────────────────────────────────────────────────────────────────

export function inScope(tags: string[] | null | undefined, scopeTags: readonly string[]): boolean {
  if (scopeTags.includes('*')) return true
  if (!Array.isArray(tags)) return false
  const want = new Set(scopeTags.map(t => String(t).trim().toLowerCase()))
  return tags.some(t => want.has(String(t).trim().toLowerCase()))
}

// ─── Sud ─────────────────────────────────────────────────────────────────────

export type CommitCode = 'not_in_scope' | 'text_only' | 'has_commit' | 'no_commit'

export interface CommitVerdict {
  /** Je li zadatak uopće u dosegu vratara. */
  inScope: boolean
  accept: boolean
  code: CommitCode
  refs: CommitRef[]
  reason: string
}

export interface CommitClosureInput {
  taskId?: string | null
  tags?: string[] | null
  resultSummary?: string | null
  /** Commiti nađeni u repozitorijima (`findTaskCommits`) — dokaz koji piše git. */
  gitProof?: CommitRef[] | null
  scopeTags?: readonly string[]
}

export function evaluateCommitClosure(input: CommitClosureInput): CommitVerdict {
  const scopeTags = input.scopeTags ?? [CHAIN_TAG]
  if (!inScope(input.tags, scopeTags)) {
    return { inScope: false, accept: true, code: 'not_in_scope', refs: [], reason: 'zadatak nije otvoren po predlošku lanca' }
  }
  if (isTextOnly(input.tags)) {
    return { inScope: true, accept: true, code: 'text_only', refs: [], reason: `zadatak je označen kao „${TEXT_ONLY_TAG}" — commit se ne traži` }
  }
  const refs = [...(input.gitProof || []), ...extractCommitRefs(input.resultSummary)]
  if (refs.length > 0) {
    const izvori = Array.from(new Set(refs.map(r => r.via))).join('+')
    return {
      inScope: true, accept: true, code: 'has_commit', refs,
      reason: `commit dokazan (${izvori}): ${refs.slice(0, 5).map(r => r.sha.slice(0, 8)).join(', ')}`,
    }
  }
  return {
    inScope: true, accept: false, code: 'no_commit', refs: [],
    reason: 'zadatak lanca nema nijedan commit — rad koji nije commitan nestaje s radnim stablom (pravilo 15)',
  }
}

/** Poruka uz HTTP 400 — mora reći ŠTO pokrenuti, ne samo što fali (isti ugovor kao R2). */
export function formatCommitHint(taskId?: string | null): string {
  const id = String(taskId || 'TASK-####').toUpperCase()
  return 'Zadatak otvoren po predlošku lanca mora ostaviti trag u gitu.\n' +
    `  grana:  ${branchName(id)}\n` +
    `  commit: ${gitCommitCommand(id, 6).replace(/\n\s*/g, ' ')}\n` +
    `Zatim u result_summary zalijepi izlaz \`git log --oneline -1\` (SHA + ${id}).\n` +
    `Ako zadatak po prirodi ne dira kod, dodaj oznaku „${TEXT_ONLY_TAG}" (korak 4) i zatvori ga ponovno.`
}

/** Jednoredni zapis za log — isti oblik kao `formatResearchLog`. */
export function formatCommitLog(taskId: string, v: CommitVerdict): string {
  return v.accept
    ? `git-commit-gate: ACCEPT ${taskId} ${v.code}${v.refs.length ? ` sha=${v.refs.slice(0, 3).map(r => r.sha.slice(0, 8)).join(',')}` : ''}`
    : `git-commit-gate: REJECT ${taskId} ${v.code}`
}

// ─── Konfiguracija (hot-reload, isti obrazac kao ResearchRagGate) ────────────

export interface GitCommitGateConfig {
  enabled: boolean
  /** true = odbijanje se PROVODI (HTTP 400); false = SHADOW, samo log. */
  live: boolean
  /** Oznake koje zadatak stavljaju u doseg. `["*"]` = svi zadaci. */
  scopeTags: string[]
  /** Traži li se dokaz i u gitu (skuplje: pokreće `git log` po repozitoriju). */
  verifyWithGit: boolean
  /** Repozitoriji u kojima se traži `TASK-####` u porukama commita. */
  repos: string[]
}

export const DEFAULT_GIT_COMMIT_GATE_CONFIG: GitCommitGateConfig = {
  enabled: true,
  live: true,                 // doseg je uzak (samo oznaka `lanac`) — v. zaglavlje
  scopeTags: [CHAIN_TAG],
  verifyWithGit: true,
  /**
   * `~/app/*` se ŠIRI u sve podmape koje stvarno imaju `.git` (jedan readdir). Tvrd popis
   * putanja ovdje je bio pogrešan iz prve: `~/app/regoc_system` — mjesto gdje živi najviše
   * REGOČ-evih zadataka — NIJE git repozitorij, pa bi vratar tražio dokaz u nepostojećem
   * spremištu. Popis koji se sam održava ne može ostarjeti u tišini.
   */
  repos: ['~/app/*'],
}

const CONFIG_TTL_MS = 30_000
let _cfg: GitCommitGateConfig | null = null
let _loadedAt = 0
let _loadedFrom = ''

function configPath(): string {
  return (
    process.env.REGOC_GIT_COMMIT_GATE_CONFIG ||
    `${process.env.HOME || '/home/klaudio'}/.claude/regoc/config/git-commit-gate.json`
  )
}

function ocisceniPopis(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback
  const out = v.map(x => String(x).trim()).filter(Boolean)
  return out.length ? out : fallback
}

export function loadGitCommitGateConfig(force = false): GitCommitGateConfig {
  const p = configPath()
  const now = Date.now()
  if (!force && _cfg && p === _loadedFrom && now - _loadedAt < CONFIG_TTL_MS) return _cfg
  const cfg: GitCommitGateConfig = {
    ...DEFAULT_GIT_COMMIT_GATE_CONFIG,
    scopeTags: [...DEFAULT_GIT_COMMIT_GATE_CONFIG.scopeTags],
    repos: [...DEFAULT_GIT_COMMIT_GATE_CONFIG.repos],
  }
  try {
    const { readFileSync, existsSync } = require('fs') as typeof import('fs')
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      if (typeof raw?.enabled === 'boolean') cfg.enabled = raw.enabled
      if (typeof raw?.live === 'boolean') cfg.live = raw.live
      if (typeof raw?.verifyWithGit === 'boolean') cfg.verifyWithGit = raw.verifyWithGit
      cfg.scopeTags = ocisceniPopis(raw?.scopeTags, cfg.scopeTags)
      cfg.repos = ocisceniPopis(raw?.repos, cfg.repos)
    }
  } catch { /* neispravan JSON → defaulti; vratar nikad ne ruši poziv */ }
  _cfg = cfg
  _loadedAt = now
  _loadedFrom = p
  return cfg
}

export function shouldEnforceCommit(
  v: CommitVerdict,
  cfg: GitCommitGateConfig = loadGitCommitGateConfig(),
): boolean {
  if (v.accept) return false
  if (!cfg.enabled) return false
  return cfg.live
}

// ─── Dokaz iz gita (tanak I/O sloj) ──────────────────────────────────────────

function expandHome(p: string): string {
  const home = process.env.HOME || '/home/klaudio'
  return p.startsWith('~') ? p.replace(/^~/, home) : p
}

/**
 * Proširi popis repozitorija: unos koji završava na `/*` postaje popis podmapa s `.git`.
 * Nepostojeća mapa daje prazan doprinos — vratar nikad ne pada na konfiguraciji.
 */
export function expandRepos(repos: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const { existsSync, readdirSync } = require('fs') as typeof import('fs')
  for (const raw of repos) {
    const p = expandHome(String(raw).trim())
    if (!p) continue
    if (p.endsWith('/*')) {
      const baza = p.slice(0, -2)
      let unosi: string[] = []
      try { unosi = readdirSync(baza) } catch { unosi = [] }
      for (const u of unosi) {
        const kandidat = `${baza}/${u}`
        if (!seen.has(kandidat) && existsSync(`${kandidat}/.git`)) { seen.add(kandidat); out.push(kandidat) }
      }
      continue
    }
    if (!seen.has(p)) { seen.add(p); out.push(p) }
  }
  return out
}

/**
 * Commiti čija poruka spominje `TASK-####`, po repozitorijima iz konfiguracije.
 * Nikad ne baca: repozitorij koji ne postoji ili git koji padne daju prazan popis, a
 * odsutan dokaz je i inače ono što vratar sudi.
 */
export function findTaskCommits(
  taskId: string,
  cfg: GitCommitGateConfig = loadGitCommitGateConfig(),
): CommitRef[] {
  const id = String(taskId || '').trim().toUpperCase()
  if (!cfg.verifyWithGit || !/^TASK-\d+$/.test(id)) return []
  const out: CommitRef[] = []
  const seen = new Set<string>()
  for (const repo of expandRepos(cfg.repos)) {
    try {
      const { existsSync } = require('fs') as typeof import('fs')
      if (!existsSync(`${repo}/.git`)) continue
      const r = Bun.spawnSync(
        ['git', '-C', repo, 'log', '--all', '--format=%h', `--grep=${id}`, '-i', '--max-count=20'],
        { stdout: 'pipe', stderr: 'ignore', timeout: 15000 },
      )
      const txt = new TextDecoder().decode(r.stdout || new Uint8Array())
      for (const line of txt.split('\n')) {
        const sha = line.trim().toLowerCase()
        if (!/^[0-9a-f]{7,40}$/.test(sha) || seen.has(sha)) continue
        seen.add(sha)
        out.push({ sha, via: 'repo', repo })
      }
    } catch { /* repozitorij bez gita / nedostupan — dokaz jednostavno nema */ }
  }
  return out
}
