#!/usr/bin/env bun
/**
 * MergeGate — A4 / TASK-3003: vrata prije spajanja.
 * ─────────────────────────────────────────────────────────────────────────────
 * Rezultat izoliranog spawna (A1) NE ULAZI u glavno stablo dok ga netko ne
 * POTPIŠE. Potpis je ili strojni (A2 kritičar: status `pass`) ili ljudski
 * (`bun MergeGate.ts sign`). Bez potpisa posao ostaje u svom worktreeju i
 * čeka — vidljiv, imenovan i s točnom naredbom kojom se pregleda.
 *
 * VLASTITA IZVEDBA. Zamisao „spoji tek na potpis" preuzeta je kao IDEJA iz
 * tuđeg projekta pod PolyForm Noncommercial licencom; nijedan njihov redak,
 * naziv datoteke ni naziv polja ovdje nije prenesen. Nazivlje, ustroj odluke,
 * kodovi i ustupci su naši.
 *
 * TRI NAČINA RADA (kućni obrazac flag → shadow → live):
 *   mergeGate=false      → potpuni no-op; A1 kao i dosad ČUVA worktree s poslom
 *   +mergeGateLive=false → SHADOW: odluka se donese, zapiše i logira, git se NE dira
 *   +mergeGateLive=true  → LIVE: na potpis se stvarno spaja i worktree se zatvara
 *
 * ŠTO OVA VRATA NE MOGU (piše ovdje da se ne bi pretpostavljalo suprotno):
 *   1. Rad IZVAN git repozitorija se ne može spojiti ni vratiti. Izmjereno nad
 *      795 zadataka u regoc.db: 11 (1,4 %) dira samo datoteke unutar repozitorija,
 *      136 (17,1 %) samo datoteke izvan ijednog repozitorija (uglavnom ~/.claude,
 *      koji NIJE repozitorij). Za tih 17 % vrata su savjetodavna — kažu što je
 *      dirano, ali ne mogu zaustaviti ni poništiti. Rješenje nije u A4 nego u
 *      A1-ovom otvorenom pitanju (`git init` nad ~/.claude ili serijalizacija).
 *   2. Popratni učinci izvan datotečnog sustava (zapisi u regoc.db, RAG,
 *      poslana Telegram poruka) se ne „spajaju" i ne poništavaju. Vrata ih
 *      PRIJAVLJUJU i po potrebi zadržavaju spajanje, ali povrat nije moguć.
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync,
  appendFileSync, statSync,
} from 'fs'
import { join, basename } from 'path'
import { createHash } from 'crypto'
import {
  loadWorktreeConfig, removeRecord, listWorktreeRecords, realGit,
  type WorktreeRecord, type Probes,
} from './WorktreeIsolation'
import type { CriticStatus, CritiqueOutcome } from './CriticGate'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()
export const MERGE_CONFIG_PATH = join(HOME, '.claude', 'regoc', 'config', 'merge-gate.json')

/**
 * Trag i pretinac zadržanog posla. Putanja se čita kroz funkciju (ne konstantu) jer
 * testovi podmeću $HOME — konstanta zaključana pri importu držala bi pravi trag.
 */
export function mergeLedgerPath(): string {
  const home = process.env.HOME || HOME
  return join(home, '.claude', 'regoc', 'data', 'merge_gate.jsonl')
}
export function holdDir(): string {
  const home = process.env.HOME || HOME
  return join(home, '.claude', 'regoc', 'data', 'merge_holds')
}

// ============================================
// 1. KONFIGURACIJA
// ============================================

/** Kanal koji se NE može spojiti jer nije datoteka u repozitoriju. */
export interface NonGitChannel {
  id: string
  /** Put koji se promatra (datoteka ili direktorij). Prazno = nedetektabilno s diska. */
  path: string
  /**
   * `annotate`         — samo zapiši da je diran (povrat nije moguć)
   * `require-snapshot` — spajanje se zadržava ako nema svježe kopije/snimke
   * `forbid`           — dodir tog kanala zadržava spajanje bez iznimke
   */
  policy: 'annotate' | 'require-snapshot' | 'forbid'
  /** Put do snimke koja se traži kod `require-snapshot`. */
  snapshotPath?: string
  note?: string
}

export interface MergeConfig {
  /**
   * `off`              — vrata mrtva (ostaje samo zapis odluke)
   * `manual`           — SVE čeka ljudski potpis; strojni potpis je samo preporuka
   * `auto-on-signoff`  — potpis kritičara (`pass`) sam otvara vrata
   */
  policy: 'off' | 'manual' | 'auto-on-signoff'
  /** Samo `pass` potpisuje. Kad je false, i `partial`/`unverifiable` prolaze (NE preporučuje se). */
  requireCriticPass: boolean
  /** Smije li `unverifiable` potpisati kad su SVE izmjene nedokumentacijske… ne: samo dokumentacija. */
  allowUnverifiableForDocsOnly: boolean
  /** Nastavci koji se smatraju dokumentacijom (za gornje pravilo). */
  docExtensions: string[]
  /** Potpis stariji od ovoga više ne otvara vrata — stablo se u međuvremenu pomaklo. */
  signoffTtlMinutes: number
  /** Strop veličine spajanja: iznad toga uvijek ide ljudski pregled. */
  maxChangedFiles: number
  /** Grane na koje se NIKAD ne spaja automatski. */
  protectedBranches: string[]
  /** Repozitoriji (apsolutni putovi) koji uvijek traže ljudski potpis. */
  protectedRepos: string[]
  /** Mora li glavno stablo biti potpuno čisto prije spajanja (inače samo bez preklapanja). */
  requireCleanTarget: boolean
  /** `--no-ff` ostavlja vidljiv čvor spajanja (lakši povrat); `ff-only` odbija ako nije brzo naprijed. */
  strategy: 'no-ff' | 'ff-only'
  /** Predložak poruke spajanja. Zamjenice: {taskId} {agentId} {branch} {base} {signoff} {critic}. */
  commitMessageTemplate: string
  /** Predložak poruke commita koji zatvara nespremljene izmjene u worktreeju. */
  worktreeCommitTemplate: string
  /** Alarm: posao koji u pretincu stoji dulje od ovoga trune (isti kvar kao neisporučeni izvještaji). */
  maxHoldAgeHours: number
  /** Kanali izvan gita. */
  nonGitChannels: NonGitChannel[]
}

export const DEFAULT_MERGE_CONFIG: MergeConfig = {
  // Zadano je NAJSTROŽE: sve čeka čovjeka. `auto-on-signoff` je svjesna odluka koja
  // se donosi tek kad sjena pokaže da se sud kritičara i ljudski sud poklapaju.
  policy: 'manual',
  requireCriticPass: true,
  allowUnverifiableForDocsOnly: false,
  docExtensions: ['.md', '.txt', '.rst', '.adoc'],
  signoffTtlMinutes: 60,
  maxChangedFiles: 40,
  protectedBranches: [],
  protectedRepos: [],
  requireCleanTarget: false,
  strategy: 'no-ff',
  commitMessageTemplate:
    '{taskId} {agentId}: spojeno kroz vrata spajanja\n\nPotpis: {signoff}. Kritičar: {critic}.\nGrana: {branch}, baza: {base}.',
  worktreeCommitTemplate: '{taskId} {agentId}: rad agenta (nespremljene izmjene zatvorene pred vratima)',
  maxHoldAgeHours: 48,
  nonGitChannels: [
    { id: 'regoc-db', path: join(HOME, '.claude', 'regoc', 'data', 'regoc.db'), policy: 'annotate', note: 'ploča zadataka — povrat nije moguć, zaštita je uzvodno (TaskManager API + CompletionGuard)' },
    { id: 'regoc-data', path: join(HOME, '.claude', 'regoc', 'data'), policy: 'annotate', note: 'tragovi i pretinci (jsonl)' },
  ],
}

let _cfgCache: { at: number; from: string; cfg: MergeConfig } | null = null
const CFG_TTL_MS = 30_000

function asPositive(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
}
function asStrings(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim())
}

/** Čita se pri svakoj odluci (keš 30 s) — izmjena djeluje bez restarta daemona. */
export function loadMergeConfig(path = MERGE_CONFIG_PATH, force = false): MergeConfig {
  const now = Date.now()
  if (!force && _cfgCache && _cfgCache.from === path && now - _cfgCache.at < CFG_TTL_MS) return _cfgCache.cfg
  const cfg: MergeConfig = { ...DEFAULT_MERGE_CONFIG, nonGitChannels: [...DEFAULT_MERGE_CONFIG.nonGitChannels] }
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf-8'))
      if (raw && typeof raw === 'object') {
        if (raw.policy === 'off' || raw.policy === 'manual' || raw.policy === 'auto-on-signoff') cfg.policy = raw.policy
        if (typeof raw.requireCriticPass === 'boolean') cfg.requireCriticPass = raw.requireCriticPass
        if (typeof raw.allowUnverifiableForDocsOnly === 'boolean') cfg.allowUnverifiableForDocsOnly = raw.allowUnverifiableForDocsOnly
        if (typeof raw.requireCleanTarget === 'boolean') cfg.requireCleanTarget = raw.requireCleanTarget
        cfg.docExtensions = asStrings(raw.docExtensions, cfg.docExtensions)
        cfg.signoffTtlMinutes = asPositive(raw.signoffTtlMinutes, cfg.signoffTtlMinutes)
        cfg.maxChangedFiles = asPositive(raw.maxChangedFiles, cfg.maxChangedFiles)
        cfg.maxHoldAgeHours = asPositive(raw.maxHoldAgeHours, cfg.maxHoldAgeHours)
        cfg.protectedBranches = asStrings(raw.protectedBranches, cfg.protectedBranches)
        cfg.protectedRepos = asStrings(raw.protectedRepos, cfg.protectedRepos)
        if (raw.strategy === 'no-ff' || raw.strategy === 'ff-only') cfg.strategy = raw.strategy
        if (typeof raw.commitMessageTemplate === 'string' && raw.commitMessageTemplate.trim()) cfg.commitMessageTemplate = raw.commitMessageTemplate
        if (typeof raw.worktreeCommitTemplate === 'string' && raw.worktreeCommitTemplate.trim()) cfg.worktreeCommitTemplate = raw.worktreeCommitTemplate
        if (Array.isArray(raw.nonGitChannels)) {
          const out: NonGitChannel[] = []
          for (const c of raw.nonGitChannels) {
            if (!c || typeof c !== 'object') continue
            const id = typeof c.id === 'string' ? c.id.trim() : ''
            const p = typeof c.path === 'string' ? c.path.trim() : ''
            const pol = c.policy === 'forbid' || c.policy === 'require-snapshot' ? c.policy : 'annotate'
            if (!id) continue
            out.push({ id, path: p, policy: pol, snapshotPath: typeof c.snapshotPath === 'string' ? c.snapshotPath : undefined, note: typeof c.note === 'string' ? c.note : undefined })
          }
          cfg.nonGitChannels = out
        }
      }
    }
  } catch {
    // Neispravna konfiguracija NE smije srušiti spawn — vrijede zadane vrijednosti.
  }
  _cfgCache = { at: now, from: path, cfg }
  return cfg
}

// ============================================
// 2. POTPIS
// ============================================

export type SignoffSource = 'critic' | 'human'

/**
 * POTPIS. Nastaje ISKLJUČIVO u procesu koji je sam pokrenuo provjere (daemon preko
 * A2) ili ga upiše čovjek kroz CLI. Tekst izvještaja agenta NIKAD ne postaje potpis —
 * to je ista granica koju je postavio A2 (izvođač ne sudi o sebi).
 *
 * `hash` je dokaz NEPROMIJENJENOSTI zapisa, ne dokaz ovlasti: agent radi pod istim
 * uidom pa bi tajni ključ ionako mogao pročitati. Pravo jamstvo je što se potpis
 * proizvodi u procesu, a ne čita iz onoga što je agent napisao.
 */
export interface MergeSignoff {
  source: SignoffSource
  by: string
  ts: string
  tsMs: number
  criticStatus: CriticStatus | null
  checks: number
  failed: number
  /** Putovi koje je potpisnik STVARNO pogledao — po tome se mjeri pokriva li potpis spajanje. */
  checkedPaths: string[]
  /** A2: je li granica „njegovo vs tuđe" bila čista (nema drugih pisaca u istom stablu). */
  attributionClean: boolean
  /**
   * TASK-4833/4834 §5.4: razina doc-provjere koja je prošla (`L0` oblik, `L1` oblik+struktura).
   * Provjera OBLIKA dokumenta nije provjera sadržaja i SAMA ne smije otvoriti spajanje.
   */
  razina?: 'L0' | 'L1' | null
  /**
   * Broj provjera koje NISU doc — kod (`parse`), test i propisani pregled (`task`).
   * Nedostaje kod starih potpisa; tada se pada na `checks` (ponašanje kao prije).
   */
  substantiveChecks?: number
  note?: string
  hash?: string
}

export function signoffHash(s: Omit<MergeSignoff, 'hash'>, branch: string, head: string): string {
  const payload = JSON.stringify({
    source: s.source, by: s.by, ts: s.ts, criticStatus: s.criticStatus,
    checks: s.checks, failed: s.failed, attributionClean: s.attributionClean, branch, head,
  })
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

/** Potpis izveden iz suda A2 kritičara. `null` kad kritičar uopće nije sudio. */
export function signoffFromCritique(o: CritiqueOutcome | null | undefined, nowMs = Date.now()): MergeSignoff | null {
  if (!o || !o.verdict) return null
  const v = o.verdict
  return {
    source: 'critic',
    by: 'critic-gate',
    ts: new Date(nowMs).toISOString(),
    tsMs: nowMs,
    criticStatus: v.status,
    checks: v.checks.length,
    failed: v.failed.length,
    checkedPaths: v.checks.map((c) => c.target),
    attributionClean: !v.notes.some((n) => n.includes('atribucija')),
    razina: v.razina ?? null,
    substantiveChecks: v.checks.filter((c) => c.kind !== 'doc').length,
  }
}

// ============================================
// 3. ODLUKA (čista funkcija — srce mehanizma)
// ============================================

export type MergeAction = 'merge' | 'hold' | 'skip'

export type MergeCode =
  | 'gate-off'            // konfiguracija ugasila vrata
  | 'not-isolated'        // spawn nije bio u worktreeju → nema se što spojiti (savjetodavno)
  | 'empty'               // worktree bez ijedne izmjene i bez commita
  | 'spawn-failed'        // agent nije uredno izašao — nema se što potpisati
  | 'no-signoff'          // nitko nije potpisao
  | 'critic-fail'         // kritičar je našao dokazan kvar
  | 'critic-not-pass'     // `partial`/`unverifiable` — nije potvrda ispravnosti
  | 'scope-mismatch'      // potpis ne pokriva nijednu datoteku koja se spaja
  | 'stale-signoff'       // potpis stariji od roka
  | 'manual-policy'       // pravilo traži ljudski potpis
  | 'protected-target'    // ciljna grana zaštićena
  | 'protected-repo'      // repozitorij traži ljudski potpis
  | 'too-large'           // spajanje veće od stropa
  | 'dirty-target'        // glavno stablo ima nespremljene izmjene nad istim datotekama
  | 'forbidden-channel'   // diran kanal koji zabranjuje automatsko spajanje
  | 'missing-snapshot'    // kanal traži svježu snimku, a nje nema
  | 'ok'                  // sve prošlo → spoji

export interface MergeDecision {
  action: MergeAction
  code: MergeCode
  /** Ljudsko obrazloženje (hrvatski) — ide u log, u pretinac i na ploču. */
  reason: string
  /** Glasno upozorenje: vrata NE MOGU zaštititi ono što se ovdje dogodilo. */
  warn?: string
}

export interface ChannelHit {
  id: string
  path: string
  policy: NonGitChannel['policy']
  /** Trenutak zadnje izmjene (ms), ili null kad se nije dalo utvrditi. */
  mtimeMs: number | null
  note?: string
}

export interface MergeDecisionInput {
  taskId: string | null
  agentId: string
  /** Je li spawn stvarno radio u vlastitom worktreeju (A1 live). */
  isolated: boolean
  repoRoot: string | null
  branch: string | null
  /** Relativni putovi koji ulaze u spajanje (commitano + nespremljeno). */
  changed: string[]
  /** Koliko commita grana ima preko baze. */
  aheadCommits: number
  /** Nespremljene izmjene u worktreeju (bit će zatvorene commitom prije spajanja). */
  dirtyInWorktree: number
  /** Grana glavnog stabla u koju bi se spajalo. */
  targetBranch: string | null
  /** Relativni putovi s nespremljenim izmjenama u glavnom stablu. */
  targetDirty: string[]
  signoff: MergeSignoff | null
  channels: ChannelHit[]
  /** Ishod spawna (`completed` / `blocked` / `failed`). */
  runOutcome?: string
  nowMs: number
}

function isDoc(path: string, cfg: MergeConfig): boolean {
  const lower = path.toLowerCase()
  return cfg.docExtensions.some((e) => lower.endsWith(e.toLowerCase()))
}

/**
 * Pokriva li potpis ono što se spaja? Kritičar (A2) gleda `watchRoots` iz svoje
 * konfiguracije — danas je to samo `~/.claude/regoc`. Worktreejevi (A1) žive pod
 * `~/app/.regoc-worktrees`. Bez ove provjere bi „pass" nad NULA pogledanih datoteka
 * otvarao vrata kodu koji nitko nije ni pogledao — potpis bez čitanja.
 */
export function signoffCoversChange(signoff: MergeSignoff, worktreePath: string | null, changed: string[]): boolean {
  if (!signoff.checkedPaths.length) return false
  const wt = worktreePath || ''
  for (const p of signoff.checkedPaths) {
    if (wt && p.startsWith(wt)) return true
    const base = basename(p)
    if (changed.some((c) => basename(c) === base)) return true
  }
  return false
}

export function decideMerge(input: MergeDecisionInput, cfg: MergeConfig, worktreePath: string | null = null): MergeDecision {
  const n = input.changed.length

  if (cfg.policy === 'off') {
    return { action: 'skip', code: 'gate-off', reason: 'vrata spajanja isključena konfiguracijom (policy=off)' }
  }

  if (!input.isolated || !input.repoRoot || !input.branch) {
    return {
      action: 'skip',
      code: 'not-isolated',
      reason: 'spawn nije radio u izoliranom stablu — nema grane koja bi se spajala',
      warn: 'rad je već upisan u zajedničko stablo; vrata ga NE MOGU ni zaustaviti ni vratiti',
    }
  }

  if (n === 0 && input.aheadCommits === 0 && input.dirtyInWorktree === 0) {
    return { action: 'skip', code: 'empty', reason: 'izolirano stablo je prazno — nema što spojiti' }
  }

  // Spawn koji nije uredno izašao nema se čime potpisati. Posao se ČUVA (ne briše),
  // ali u glavno stablo ne ulazi — to je cijeli smisao ovih vrata.
  if (input.runOutcome && input.runOutcome !== 'completed') {
    return {
      action: 'hold',
      code: 'spawn-failed',
      reason: `agent nije uredno završio (${input.runOutcome}) — rad ostaje u svom stablu i čeka pregled`,
    }
  }

  const s = input.signoff
  if (!s) {
    return { action: 'hold', code: 'no-signoff', reason: 'nitko nije potpisao (kritičar nije sudio) — bez potpisa nema ulaska' }
  }

  if (s.source === 'critic') {
    if (s.criticStatus === 'fail') {
      return { action: 'hold', code: 'critic-fail', reason: `kritičar je našao dokazan kvar (${s.failed} od ${s.checks} provjera palo) — spajanje se ne događa` }
    }
    if (cfg.requireCriticPass && s.criticStatus !== 'pass') {
      const docsOnly = n > 0 && input.changed.every((p) => isDoc(p, cfg))
      const allowed = cfg.allowUnverifiableForDocsOnly && s.criticStatus === 'unverifiable' && docsOnly
      if (!allowed) {
        return {
          action: 'hold',
          code: 'critic-not-pass',
          reason: `sud kritičara je „${s.criticStatus}" — ništa nije palo, ali to NIJE potvrda ispravnosti; treba ljudski potpis`,
        }
      }
    }
    // TASK-4833/4834 §5.4: doc-provjera SAMA ne otvara automatsko spajanje. L0/L1 sude o
    // OBLIKU dokumenta („tvar, a ne ljuska"), ne o njegovoj istinitosti — dokument koji ih
    // prođe može biti posve pogrešan. Kad u potpisu nema nijedne kodne ni propisane
    // provjere, vrata traže čovjeka; inače bi ovaj mehanizam olabavio ono što je A4
    // zatvorio. Stari potpisi (bez `substantiveChecks`) ponašaju se kao i dosad.
    const substantive = s.substantiveChecks ?? s.checks
    if (s.razina && substantive === 0) {
      return {
        action: 'hold',
        code: 'critic-not-pass',
        reason: `potpis se oslanja SAMO na doc-provjeru (razina ${s.razina} — oblik dokumenta, ne sadržaj); za spajanje bez čovjeka treba barem jedna kodna ili propisana provjera`,
      }
    }
    if (!s.attributionClean) {
      return {
        action: 'hold',
        code: 'critic-not-pass',
        reason: 'atribucija izmjena nije bila čista (u istom stablu radio je još netko) — potpis ne obvezuje',
      }
    }
    if (!signoffCoversChange(s, worktreePath, input.changed)) {
      return {
        action: 'hold',
        code: 'scope-mismatch',
        reason: `potpis ne pokriva nijednu od ${n} datoteka koje se spajaju (kritičar je gledao ${s.checkedPaths.length} drugih putova) — potpis bez čitanja ne otvara vrata`,
        warn: 'provjeri `watchRoots` u config/critic-gate.json: kritičar mora gledati i korijen worktreejeva',
      }
    }
  }

  const ageMin = (input.nowMs - s.tsMs) / 60_000
  if (ageMin > cfg.signoffTtlMinutes) {
    return {
      action: 'hold',
      code: 'stale-signoff',
      reason: `potpis je star ${Math.round(ageMin)} min (rok ${cfg.signoffTtlMinutes}) — stablo se u međuvremenu moglo pomaknuti, treba novi`,
    }
  }

  // Kanali izvan gita: zabrana je tvrda, snimka je uvjet, ostalo je zabilježba.
  const forbidden = input.channels.filter((c) => c.policy === 'forbid')
  if (forbidden.length) {
    return {
      action: 'hold',
      code: 'forbidden-channel',
      reason: `diran kanal koji zabranjuje automatsko spajanje: ${forbidden.map((c) => c.id).join(', ')}`,
      warn: 'taj se dodir ne može poništiti povratom spajanja',
    }
  }
  const needSnapshot = input.channels.filter((c) => c.policy === 'require-snapshot')
  if (needSnapshot.length) {
    return {
      action: 'hold',
      code: 'missing-snapshot',
      reason: `kanal traži svježu snimku prije spajanja, a nje nema: ${needSnapshot.map((c) => c.id).join(', ')}`,
    }
  }

  if (n > cfg.maxChangedFiles) {
    return { action: 'hold', code: 'too-large', reason: `${n} izmijenjenih datoteka je iznad stropa ${cfg.maxChangedFiles} — veliko spajanje ide na ljudski pregled` }
  }

  if (cfg.protectedRepos.some((r) => input.repoRoot === r || input.repoRoot!.startsWith(r.replace(/\/$/, '') + '/'))) {
    return { action: 'hold', code: 'protected-repo', reason: `repozitorij ${input.repoRoot} traži ljudski potpis (protectedRepos)` }
  }
  if (input.targetBranch && cfg.protectedBranches.includes(input.targetBranch)) {
    return { action: 'hold', code: 'protected-target', reason: `grana ${input.targetBranch} je zaštićena — automatsko spajanje nije dopušteno` }
  }

  // Nespremljene izmjene u glavnom stablu: git bi ih spajanjem pregazio ili bi odbio.
  // Preklapanje je tvrda zapreka; `requireCleanTarget` diže prag na „ništa nespremljeno".
  const overlap = input.targetDirty.filter((p) => input.changed.includes(p))
  if (overlap.length) {
    return {
      action: 'hold',
      code: 'dirty-target',
      reason: `glavno stablo ima nespremljene izmjene nad istim datotekama (${overlap.slice(0, 5).join(', ')}) — spajanje bi ih pregazilo`,
    }
  }
  if (cfg.requireCleanTarget && input.targetDirty.length) {
    return {
      action: 'hold',
      code: 'dirty-target',
      reason: `glavno stablo nije čisto (${input.targetDirty.length} nespremljenih) — konfiguracija traži čisto stablo`,
    }
  }

  if (cfg.policy === 'manual' && s.source !== 'human') {
    return {
      action: 'hold',
      code: 'manual-policy',
      reason: 'pravilo je `manual`: strojni potpis je preporuka, ulazak otvara tek ljudski potpis (`bun MergeGate.ts sign <id> --by <ime>`)',
    }
  }

  return {
    action: 'merge',
    code: 'ok',
    reason: `potpisao ${s.source === 'human' ? `čovjek (${s.by})` : `kritičar (${s.checks} provjera, 0 palo)`} — ${n} datoteka ulazi u ${input.targetBranch || 'glavno stablo'}`,
  }
}

// ============================================
// 4. GIT — mjerenje stanja
// ============================================

export interface WorktreeState {
  /** Relativni putovi izmjena (commitano preko baze + nespremljeno). */
  changed: string[]
  aheadCommits: number
  dirtyCount: number
  head: string
  ok: boolean
  error?: string
}

function porcelainPaths(out: string): string[] {
  const paths: string[] = []
  for (const line of out.split('\n')) {
    const t = line.trim()
    if (!t) continue
    // "XY put" i "XY stari -> novi" (preimenovanje) — zanima nas odredište.
    const rest = t.slice(2).trim() || t
    const arrow = rest.indexOf(' -> ')
    paths.push((arrow >= 0 ? rest.slice(arrow + 4) : rest).replace(/^"|"$/g, ''))
  }
  return [...new Set(paths)]
}

/** Što točno stoji u izoliranom stablu. Ne mijenja ništa. */
export function readWorktreeState(rec: WorktreeRecord, probes: Probes = {}): WorktreeState {
  const git = probes.git || realGit
  const empty: WorktreeState = { changed: [], aheadCommits: 0, dirtyCount: 0, head: '', ok: false }
  if (!existsSync(rec.worktreePath)) return { ...empty, error: 'worktree ne postoji na disku' }

  const st = git(['status', '--porcelain'], rec.worktreePath)
  if (st.code !== 0) return { ...empty, error: st.stderr.split('\n')[0] || `git status exit ${st.code}` }
  const dirty = porcelainPaths(st.stdout)

  const headRes = git(['rev-parse', 'HEAD'], rec.worktreePath)
  const head = headRes.code === 0 ? headRes.stdout.split('\n')[0] : ''

  let ahead = 0
  let committed: string[] = []
  if (rec.baseCommit) {
    const cnt = git(['rev-list', '--count', `${rec.baseCommit}..HEAD`], rec.worktreePath)
    if (cnt.code === 0) ahead = Number(cnt.stdout.trim() || '0') || 0
    if (ahead > 0) {
      const names = git(['diff', '--name-only', `${rec.baseCommit}..HEAD`], rec.worktreePath)
      if (names.code === 0) committed = names.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    }
  }
  return {
    changed: [...new Set([...committed, ...dirty])],
    aheadCommits: ahead,
    dirtyCount: dirty.length,
    head,
    ok: true,
  }
}

export interface TargetState {
  branch: string | null
  dirty: string[]
  head: string
  ok: boolean
  error?: string
}

/** Stanje glavnog stabla u koje bi se spajalo. */
export function readTargetState(repoRoot: string, probes: Probes = {}): TargetState {
  const git = probes.git || realGit
  const st = git(['status', '--porcelain'], repoRoot)
  if (st.code !== 0) return { branch: null, dirty: [], head: '', ok: false, error: st.stderr.split('\n')[0] || `git status exit ${st.code}` }
  const br = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot)
  const head = git(['rev-parse', 'HEAD'], repoRoot)
  return {
    branch: br.code === 0 ? br.stdout.split('\n')[0] : null,
    dirty: porcelainPaths(st.stdout),
    head: head.code === 0 ? head.stdout.split('\n')[0] : '',
    ok: true,
  }
}

// ============================================
// 5. KANALI IZVAN GITA
// ============================================

function newestMtimeMs(path: string, depth = 2): number | null {
  try {
    const st = statSync(path)
    if (!st.isDirectory()) return st.mtimeMs
    let newest = st.mtimeMs
    if (depth <= 0) return newest
    for (const e of readdirSync(path)) {
      if (e === '.git' || e === 'node_modules') continue
      const m = newestMtimeMs(join(path, e), depth - 1)
      if (m !== null && m > newest) newest = m
    }
    return newest
  } catch { return null }
}

/**
 * Koje je kanale IZVAN gita ovaj spawn dirao. Otkrivanje je po vremenu izmjene i
 * NAMJERNO nepotpuno: mrežni kanali (ChromaDB, Nextcloud, poslana
 * Telegram poruka) s diska se ne vide. Za njih zaštita ne može biti nizvodno —
 * mora biti uzvodno, u posredniku kroz koji se piše.
 */
export function scanChannels(sinceMs: number, cfg: MergeConfig): ChannelHit[] {
  const hits: ChannelHit[] = []
  for (const ch of cfg.nonGitChannels) {
    if (!ch.path) continue
    const m = newestMtimeMs(ch.path)
    if (m === null) continue
    if (m >= sinceMs - 2000) hits.push({ id: ch.id, path: ch.path, policy: ch.policy, mtimeMs: m, note: ch.note })
  }
  // `require-snapshot` pada samo ako snimke NEMA ili je starija od dodira.
  return hits.filter((h) => {
    if (h.policy !== 'require-snapshot') return true
    const ch = cfg.nonGitChannels.find((c) => c.id === h.id)
    if (!ch?.snapshotPath) return true
    const snap = newestMtimeMs(ch.snapshotPath)
    return snap === null || snap < (h.mtimeMs || 0)
  })
}

// ============================================
// 6. PRETINAC ZADRŽANOG POSLA + TRAG
// ============================================

export interface HoldRecord {
  id: string
  taskId: string | null
  agentId: string
  repoRoot: string
  worktreePath: string
  branch: string
  baseCommit: string
  targetBranch: string | null
  changed: string[]
  code: MergeCode
  reason: string
  warn?: string
  channels: ChannelHit[]
  signoff: MergeSignoff | null
  createdAt: string
  createdAtMs: number
  /** Ljudski potpis dodan naknadno kroz CLI. */
  humanSignoff?: MergeSignoff
}

export function writeHold(rec: HoldRecord, dir = holdDir()): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, `${rec.id}.json`)
  writeFileSync(p, JSON.stringify(rec, null, 2))
  return p
}

export function listHolds(dir = holdDir()): HoldRecord[] {
  if (!existsSync(dir)) return []
  const out: HoldRecord[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as HoldRecord
      if (r && typeof r.id === 'string') out.push(r)
    } catch { /* neispravan zapis ne smije srušiti pregled */ }
  }
  return out.sort((a, b) => a.createdAtMs - b.createdAtMs)
}

export function readHold(id: string, dir = holdDir()): HoldRecord | null {
  const p = join(dir, `${id}.json`)
  if (!existsSync(p)) return listHolds(dir).find((h) => h.id === id || h.taskId === id) || null
  try { return JSON.parse(readFileSync(p, 'utf-8')) as HoldRecord } catch { return null }
}

export function removeHold(id: string, dir = holdDir()): void {
  try { rmSync(join(dir, `${id}.json`), { force: true }) } catch {}
}

export interface LedgerEntry {
  ts: string
  taskId: string | null
  agentId: string
  action: MergeAction
  code: MergeCode
  live: boolean
  branch: string | null
  targetBranch: string | null
  changed: number
  signoff: { source: SignoffSource; by: string; criticStatus: CriticStatus | null; hash?: string } | null
  mergeCommit?: string
  preMergeCommit?: string
  channels: string[]
  reason: string
}

/** Isti obrazac kao A1/A2/A3: jedan redak po odluci, dopisivanje ne ruši poziv. */
export function appendMergeLedger(e: LedgerEntry, path = mergeLedgerPath()): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    appendFileSync(path, JSON.stringify(e) + '\n')
  } catch { /* trag koji ne uspije zapisati ne smije zaustaviti spajanje */ }
}

export function readMergeLedger(path = mergeLedgerPath()): LedgerEntry[] {
  if (!existsSync(path)) return []
  const out: LedgerEntry[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line) as LedgerEntry) } catch {}
  }
  return out
}

// ============================================
// 7. IZVRŠENJE SPAJANJA
// ============================================

export interface MergeExecResult {
  ok: boolean
  mergeCommit?: string
  preMergeCommit?: string
  worktreeCommit?: string
  detail: string
  /** true kad je izolirano stablo nakon spajanja uklonjeno. */
  worktreeClosed: boolean
}

function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
}

/**
 * Stvarno spajanje. Redoslijed je odabran tako da se u SVAKOM koraku može stati bez
 * štete: prvo se rad zatvori commitom u SVOM stablu (glavno se još ne dira), pa se
 * zabilježi točka povratka, pa tek onda spaja. Neuspjeh spajanja ide u `git merge
 * --abort` — glavno stablo ostaje točno kakvo je bilo.
 */
export function executeMerge(
  rec: WorktreeRecord,
  cfg: MergeConfig,
  signoff: MergeSignoff | null,
  probes: Probes = {},
): MergeExecResult {
  const git = probes.git || realGit
  const vars = {
    taskId: rec.taskId || 'bez-zadatka',
    agentId: rec.agentId,
    branch: rec.branch,
    base: (rec.baseCommit || '').slice(0, 8),
    signoff: signoff ? `${signoff.source}/${signoff.by}` : 'nema',
    critic: signoff?.criticStatus ? `${signoff.criticStatus} (${signoff.checks} provjera, ${signoff.failed} palo)` : 'nije sudio',
  }

  // 1. Nespremljeni rad se zatvara commitom u SVOM stablu.
  let worktreeCommit: string | undefined
  const st = git(['status', '--porcelain'], rec.worktreePath)
  if (st.code === 0 && st.stdout.trim()) {
    const add = git(['add', '-A'], rec.worktreePath)
    if (add.code !== 0) return { ok: false, detail: `git add nije uspio: ${add.stderr.split('\n')[0]}`, worktreeClosed: false }
    const msg = fill(cfg.worktreeCommitTemplate, vars)
    const ci = git(['commit', '-m', msg], rec.worktreePath)
    if (ci.code !== 0) return { ok: false, detail: `git commit u worktreeju nije uspio: ${ci.stderr.split('\n')[0] || ci.stdout.split('\n')[0]}`, worktreeClosed: false }
    const h = git(['rev-parse', 'HEAD'], rec.worktreePath)
    worktreeCommit = h.code === 0 ? h.stdout.split('\n')[0] : undefined
  }

  // 2. Točka povratka PRIJE dodira u glavno stablo.
  const pre = git(['rev-parse', 'HEAD'], rec.repoRoot)
  const preMergeCommit = pre.code === 0 ? pre.stdout.split('\n')[0] : undefined

  // 3. Spajanje.
  const args = cfg.strategy === 'ff-only'
    ? ['merge', '--ff-only', rec.branch]
    : ['merge', '--no-ff', '-m', fill(cfg.commitMessageTemplate, vars), rec.branch]
  const mg = git(args, rec.repoRoot)
  if (mg.code !== 0) {
    git(['merge', '--abort'], rec.repoRoot)
    return {
      ok: false,
      preMergeCommit,
      worktreeCommit,
      detail: `spajanje nije uspjelo (${mg.stderr.split('\n')[0] || mg.stdout.split('\n')[0] || `exit ${mg.code}`}) — glavno stablo vraćeno, rad ostaje u ${rec.worktreePath}`,
      worktreeClosed: false,
    }
  }
  const post = git(['rev-parse', 'HEAD'], rec.repoRoot)
  const mergeCommit = post.code === 0 ? post.stdout.split('\n')[0] : undefined

  // 4. Izolirano stablo je odradilo svoje. `branch -d` (malo d) briše granu SAMO ako
  //    je stvarno spojena — ako git u tome sumnja, grana ostaje i posao je vraćiv.
  let worktreeClosed = false
  const rm = git(['worktree', 'remove', '--force', rec.worktreePath], rec.repoRoot)
  if (rm.code === 0) {
    worktreeClosed = true
    git(['branch', '-d', rec.branch], rec.repoRoot)
    try { removeRecord(loadWorktreeConfig(), rec.id) } catch {}
  }

  return {
    ok: true,
    mergeCommit,
    preMergeCommit,
    worktreeCommit,
    worktreeClosed,
    detail: `spojeno u ${mergeCommit?.slice(0, 8) || '?'} (povratak: git -C ${rec.repoRoot} reset --hard ${preMergeCommit?.slice(0, 8) || '?'})${worktreeClosed ? '' : ' — izolirano stablo NIJE zatvoreno, počisti ručno'}`,
  }
}

// ============================================
// 8. ULAZ ZA DAEMON
// ============================================

export interface GateInput {
  record: WorktreeRecord | null
  agentId: string
  taskId: string | null
  signoff: MergeSignoff | null
  /** Trenutak starta spawna — granica za pretragu kanala izvan gita. */
  sinceMs: number
  runOutcome?: string
  /** true = stvarno se spaja; false = SHADOW (odluka, zapis, log, bez dodira gita). */
  live: boolean
  nowMs?: number
}

export interface GateResult {
  decision: MergeDecision
  input: MergeDecisionInput | null
  exec?: MergeExecResult
  hold?: HoldRecord
  /** true kad je izolirano stablo zatvoreno pa pozivatelj NE treba zvati releaseWorktree. */
  worktreeConsumed: boolean
}

/**
 * Sve zajedno. Nikad ne baca — kvar u vratima ne smije srušiti spawn ni izgubiti rad
 * (fail-open na vlastitu grešku, fail-closed samo na tuđi dokazani kvar). Pri svakoj
 * neizvjesnosti izbor je „zadrži i prijavi", nikad „spoji svejedno".
 */
export function runMergeGate(gi: GateInput, cfg: MergeConfig = loadMergeConfig(), probes: Probes = {}): GateResult {
  const nowMs = gi.nowMs ?? Date.now()
  const rec = gi.record

  if (!rec) {
    const decision = decideMerge(
      {
        taskId: gi.taskId, agentId: gi.agentId, isolated: false, repoRoot: null, branch: null,
        changed: [], aheadCommits: 0, dirtyInWorktree: 0, targetBranch: null, targetDirty: [],
        signoff: gi.signoff, channels: [], runOutcome: gi.runOutcome, nowMs,
      },
      cfg,
    )
    appendMergeLedger(ledgerOf(gi, decision, null, null, [], nowMs))
    return { decision, input: null, worktreeConsumed: false }
  }

  let channels: ChannelHit[] = []
  try { channels = scanChannels(gi.sinceMs, cfg) } catch {}

  const wt = readWorktreeState(rec, probes)
  const tgt = wt.ok ? readTargetState(rec.repoRoot, probes) : { branch: null, dirty: [], head: '', ok: false }

  const input: MergeDecisionInput = {
    taskId: gi.taskId,
    agentId: gi.agentId,
    isolated: true,
    repoRoot: rec.repoRoot,
    branch: rec.branch,
    changed: wt.changed,
    aheadCommits: wt.aheadCommits,
    dirtyInWorktree: wt.dirtyCount,
    targetBranch: tgt.branch,
    targetDirty: tgt.dirty,
    signoff: gi.signoff,
    channels,
    runOutcome: gi.runOutcome,
    nowMs,
  }

  // Git koji ne odgovara nije razlog za spajanje naslijepo.
  if (!wt.ok || !tgt.ok) {
    const decision: MergeDecision = {
      action: 'hold',
      code: 'dirty-target',
      reason: `stanje se nije dalo očitati (${wt.error || (tgt as TargetState).error || 'git ne odgovara'}) — rad ostaje u ${rec.worktreePath}`,
    }
    const hold = makeHold(rec, input, decision, nowMs)
    if (gi.live) writeHold(hold)
    appendMergeLedger(ledgerOf(gi, decision, rec, tgt.branch, channels, nowMs, input.changed.length))
    return { decision, input, hold, worktreeConsumed: false }
  }

  const decision = decideMerge(input, cfg, rec.worktreePath)

  if (decision.action === 'skip') {
    appendMergeLedger(ledgerOf(gi, decision, rec, tgt.branch, channels, nowMs, input.changed.length))
    return { decision, input, worktreeConsumed: false }
  }

  if (decision.action === 'hold') {
    const hold = makeHold(rec, input, decision, nowMs)
    if (gi.live) writeHold(hold)
    appendMergeLedger(ledgerOf(gi, decision, rec, tgt.branch, channels, nowMs, input.changed.length))
    return { decision, input, hold, worktreeConsumed: false }
  }

  // action === 'merge'
  if (!gi.live) {
    appendMergeLedger(ledgerOf(gi, decision, rec, tgt.branch, channels, nowMs, input.changed.length))
    return { decision, input, worktreeConsumed: false }
  }

  let exec: MergeExecResult
  try {
    exec = executeMerge(rec, cfg, gi.signoff, probes)
  } catch (e: any) {
    exec = { ok: false, detail: `spajanje je puklo: ${String(e?.message || e).slice(0, 200)}`, worktreeClosed: false }
  }

  if (!exec.ok) {
    const failDecision: MergeDecision = {
      action: 'hold',
      code: 'dirty-target',
      reason: `potpis je bio uredan, ali spajanje nije prošlo — ${exec.detail}`,
    }
    const hold = makeHold(rec, input, failDecision, nowMs)
    writeHold(hold)
    appendMergeLedger(ledgerOf(gi, failDecision, rec, tgt.branch, channels, nowMs, input.changed.length, exec))
    return { decision: failDecision, input, exec, hold, worktreeConsumed: false }
  }

  removeHold(rec.id)
  appendMergeLedger(ledgerOf(gi, decision, rec, tgt.branch, channels, nowMs, input.changed.length, exec))
  return { decision, input, exec, worktreeConsumed: exec.worktreeClosed }
}

function makeHold(rec: WorktreeRecord, input: MergeDecisionInput, d: MergeDecision, nowMs: number): HoldRecord {
  return {
    id: rec.id,
    // Zadatak i agent se uzimaju iz ULAZA, ne iz zapisa o stablu: stablo je moglo
    // nastati za jedan zadatak, a ovaj izlaz spawna pripada onome tko ga je pokrenuo.
    taskId: input.taskId,
    agentId: input.agentId,
    repoRoot: rec.repoRoot,
    worktreePath: rec.worktreePath,
    branch: rec.branch,
    baseCommit: rec.baseCommit,
    targetBranch: input.targetBranch,
    changed: input.changed,
    code: d.code,
    reason: d.reason,
    warn: d.warn,
    channels: input.channels,
    signoff: input.signoff,
    createdAt: new Date(nowMs).toISOString(),
    createdAtMs: nowMs,
  }
}

function ledgerOf(
  gi: GateInput, d: MergeDecision, rec: WorktreeRecord | null, targetBranch: string | null,
  channels: ChannelHit[], nowMs: number, changed = 0, exec?: MergeExecResult,
): LedgerEntry {
  const s = gi.signoff
  return {
    ts: new Date(nowMs).toISOString(),
    taskId: gi.taskId,
    agentId: gi.agentId,
    action: d.action,
    code: d.code,
    live: gi.live,
    branch: rec?.branch || null,
    targetBranch,
    changed,
    signoff: s ? { source: s.source, by: s.by, criticStatus: s.criticStatus, hash: s.hash } : null,
    mergeCommit: exec?.mergeCommit,
    preMergeCommit: exec?.preMergeCommit,
    channels: channels.map((c) => `${c.id}:${c.policy}`),
    reason: d.reason,
  }
}

// ============================================
// 9. ISPIS
// ============================================

/** Jedan redak za daemon-log. Način rada (LIVE/SJENA) je uvijek vidljiv. */
export function formatGateLog(gi: GateInput, r: GateResult): string {
  const icon = r.decision.action === 'merge' ? '🔀' : r.decision.action === 'hold' ? '⏸️' : '·'
  const mode = gi.live ? (r.decision.action === 'merge' ? 'SPAJAM' : 'ZADRŽAVAM') : 'SJENA'
  const n = r.input?.changed.length ?? 0
  return `${icon} merge-gate: ${r.decision.code} task=${gi.taskId || 'N/A'} agent=${gi.agentId} datoteka=${n} ${mode} — ${r.decision.reason}`
}

/** Upute čovjeku: točne naredbe kojima se zadržani posao pregleda, potpiše ili odbaci. */
export function formatHoldBrief(h: HoldRecord): string {
  const lines = [
    `⏸️ Rad čeka pred vratima spajanja: ${h.id}`,
    `   zadatak: ${h.taskId || 'bez-zadatka'} · agent: ${h.agentId}`,
    `   razlog:  ${h.code} — ${h.reason}`,
  ]
  if (h.warn) lines.push(`   ⚠️  ${h.warn}`)
  lines.push(`   grana:   ${h.branch} → ${h.targetBranch || '?'} (${h.repoRoot})`)
  lines.push(`   datoteke (${h.changed.length}): ${h.changed.slice(0, 8).join(', ')}${h.changed.length > 8 ? ' …' : ''}`)
  if (h.channels.length) {
    lines.push(`   izvan gita (povrat NIJE moguć): ${h.channels.map((c) => `${c.id}[${c.policy}]`).join(', ')}`)
  }
  lines.push(`   pregled: bun ~/.claude/regoc/MergeGate.ts diff ${h.id}`)
  lines.push(`   potpis:  bun ~/.claude/regoc/MergeGate.ts sign ${h.id} --by <ime>`)
  lines.push(`   odbaci:  bun ~/.claude/regoc/MergeGate.ts drop ${h.id} --yes`)
  return lines.join('\n')
}

// ============================================
// 10. CLI
// ============================================

function argOf(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : undefined
}

function humanSignoff(by: string, note: string | undefined, nowMs: number, changed: string[]): MergeSignoff {
  const s: MergeSignoff = {
    source: 'human',
    by,
    ts: new Date(nowMs).toISOString(),
    tsMs: nowMs,
    criticStatus: null,
    checks: 0,
    failed: 0,
    checkedPaths: changed,
    attributionClean: true,
    note,
  }
  s.hash = signoffHash(s, '', '')
  return s
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2)
  const cfg = loadMergeConfig(MERGE_CONFIG_PATH, true)

  if (!cmd || cmd === 'help') {
    console.log(`MergeGate — A4/TASK-3003 vrata prije spajanja

  status                          što čeka pred vratima (+ alarm za ostarjelo)
  show <id>                       puni zapis jednog zadržanog posla
  diff <id>                       razlika koja bi ušla u glavno stablo
  sign <id> --by <ime> [--note ..] ljudski potpis (zapisuje se, ne spaja sam)
  merge <id> [--dry-run]          pokušaj spajanja po trenutnom potpisu
  drop <id> --yes [--keep-branch] odustani od zadržanog posla
  channels [--since-min N]        koji su kanali izvan gita dirani
  config                          djelatna konfiguracija

Pravilo: ${cfg.policy} · potpis vrijedi ${cfg.signoffTtlMinutes} min · strop ${cfg.maxChangedFiles} datoteka`)
    process.exit(0)
  }

  if (cmd === 'config') {
    console.log(JSON.stringify(cfg, null, 2))
    process.exit(0)
  }

  if (cmd === 'status') {
    const holds = listHolds()
    if (!holds.length) {
      console.log('Ništa ne čeka pred vratima spajanja.')
      process.exit(0)
    }
    const now = Date.now()
    console.log(`Pred vratima čeka ${holds.length} posao/posla:\n`)
    for (const h of holds) {
      const ageH = (now - h.createdAtMs) / 3_600_000
      const rot = ageH > cfg.maxHoldAgeHours ? ' 🔴 TRUNE' : ''
      console.log(`${h.id}${rot}`)
      console.log(`  ${h.taskId || 'bez-zadatka'} · ${h.agentId} · ${h.code} · ${ageH.toFixed(1)} h · ${h.changed.length} datoteka`)
      console.log(`  ${h.reason}`)
      if (h.humanSignoff) console.log(`  ✍️  potpisao ${h.humanSignoff.by} u ${h.humanSignoff.ts}`)
      console.log('')
    }
    const rotten = holds.filter((h) => (now - h.createdAtMs) / 3_600_000 > cfg.maxHoldAgeHours)
    if (rotten.length) {
      console.log(`🔴 ${rotten.length} posao/posla stoji dulje od ${cfg.maxHoldAgeHours} h. Vrata koja zadrže i zaborave su isti kvar kao izvještaj koji nikad nije isporučen.`)
    }
    process.exit(0)
  }

  const id = rest[0]
  if (cmd === 'show' || cmd === 'diff' || cmd === 'sign' || cmd === 'merge' || cmd === 'drop') {
    if (!id) { console.error(`Nedostaje <id>. Popis: bun MergeGate.ts status`); process.exit(2) }
    const h = readHold(id)
    if (!h) { console.error(`Nema zadržanog posla s oznakom ${id}.`); process.exit(2) }

    if (cmd === 'show') {
      console.log(formatHoldBrief(h))
      console.log('\n--- puni zapis ---')
      console.log(JSON.stringify(h, null, 2))
      process.exit(0)
    }

    if (cmd === 'diff') {
      const base = h.baseCommit || 'HEAD'
      const r = realGit(['diff', `${base}...HEAD`], h.worktreePath)
      const st = realGit(['status', '--porcelain'], h.worktreePath)
      if (st.stdout.trim()) console.log(`# nespremljeno u worktreeju:\n${st.stdout}\n`)
      console.log(r.stdout || '(nema razlike u commitima)')
      process.exit(0)
    }

    if (cmd === 'sign') {
      const by = argOf(rest, 'by')
      if (!by) { console.error('Potpis mora imati ime: --by <ime>'); process.exit(2) }
      h.humanSignoff = humanSignoff(by, argOf(rest, 'note'), Date.now(), h.changed)
      writeHold(h)
      console.log(`✍️  Potpisano: ${by}. Zapis osvježen.`)
      console.log(`Spajanje: bun ~/.claude/regoc/MergeGate.ts merge ${h.id}`)
      process.exit(0)
    }

    if (cmd === 'drop') {
      if (!rest.includes('--yes')) {
        console.error(`Odbacivanje briše tuđi rad. Ponovi s --yes ako si siguran.\n${formatHoldBrief(h)}`)
        process.exit(2)
      }
      if (existsSync(h.worktreePath)) realGit(['worktree', 'remove', '--force', h.worktreePath], h.repoRoot)
      if (!rest.includes('--keep-branch')) realGit(['branch', '-D', h.branch], h.repoRoot)
      try { removeRecord(loadWorktreeConfig(), h.id) } catch {}
      removeHold(h.id)
      console.log(`🗑️  Odbačeno ${h.id}${rest.includes('--keep-branch') ? ' (grana zadržana)' : ''}.`)
      process.exit(0)
    }

    // merge
    const rec = listWorktreeRecords(loadWorktreeConfig()).find((r) => r.id === h.id) || {
      id: h.id, taskId: h.taskId, agentId: h.agentId, repoRoot: h.repoRoot,
      worktreePath: h.worktreePath, branch: h.branch, baseCommit: h.baseCommit,
      pid: null, pidStartMs: null, createdAtMs: h.createdAtMs, createdAt: h.createdAt,
    } as WorktreeRecord

    const signoff = h.humanSignoff || h.signoff
    const dry = rest.includes('--dry-run')
    const res = runMergeGate(
      { record: rec, agentId: h.agentId, taskId: h.taskId, signoff, sinceMs: h.createdAtMs, runOutcome: 'completed', live: !dry },
      cfg,
    )
    console.log(formatGateLog({ record: rec, agentId: h.agentId, taskId: h.taskId, signoff, sinceMs: h.createdAtMs, live: !dry }, res))
    if (res.exec) console.log(`   ${res.exec.detail}`)
    if (res.decision.action !== 'merge') console.log(`\n${formatHoldBrief(res.hold || h)}`)
    process.exit(res.decision.action === 'merge' && (dry || res.exec?.ok) ? 0 : 1)
  }

  if (cmd === 'channels') {
    const mins = Number(argOf(rest, 'since-min') || '60')
    const hits = scanChannels(Date.now() - mins * 60_000, cfg)
    console.log(`Kanali izvan gita dirani u zadnjih ${mins} min:`)
    if (!hits.length) console.log('  (nijedan od praćenih)')
    for (const hh of hits) {
      console.log(`  ${hh.id} [${hh.policy}] ${hh.path}${hh.note ? `\n     ${hh.note}` : ''}`)
    }
    console.log('\nNapomena: mrežni kanali (ChromaDB, Nextcloud, poslana Telegram poruka) se s diska NE VIDE.')
    console.log('Za njih zaštita mora biti uzvodno — u posredniku kroz koji se piše, ne u ovim vratima.')
    process.exit(0)
  }

  console.error(`Nepoznata naredba: ${cmd}. Pomoć: bun MergeGate.ts help`)
  process.exit(2)
}
