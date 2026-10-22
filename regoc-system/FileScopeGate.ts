#!/usr/bin/env bun
/**
 * FileScopeGate — disjunktan opseg datoteka po zadatku (A3 / TASK-3002).
 *
 * ZAŠTO POSTOJI: `blockedBy`/`blocks` izražavaju REDOSLIJED, ne OPSEG. Dva zadatka bez
 * ijedne veze među sobom mogu istovremeno dobiti istu datoteku i jedan drugome pojesti
 * izmjene. Danas to ne sprječava ništa.
 *
 * MJERENO (regoc.db, 29.07.2026, 794 zadatka / 462 s `started_at`):
 *   • 2729 parova zadataka ima preklopljen vremenski prozor;
 *   • 244 tih parova (8,9 %) u svom tekstu spominje ISTU datoteku;
 *   • 117 od njih ima RAZLIČITE izvršitelje — to je oblik kvara od 28.07. (tri pisca
 *     nad `TaskWebUI.ts`, jedan ubijen usred izmjene → sintaksna greška u buildu);
 *   • 306 od 462 zadatka (66 %) uopće spominje bar jednu putanju u tekstu, pa je
 *     automatsko izvođenje opsega iz opisa izvedivo, ali NIJE dokaz (v. `derived` niže).
 *
 * ODNOS PREMA A1 (WorktreeIsolation): A1 dopusti sudar pa ga rješava PRI SPAJANJU
 * (dvije grane, ručni merge). A3 sudar SPRJEČAVA — dva zadatka s presjekom opsega ne
 * kreću istovremeno. Nadopunjuju se: A3 je jeftiniji (čekanje), A1 je mreža ispod njega
 * za slučaj kad se opseg krivo procijeni ili se tijekom rada proširi.
 *
 * ŠTO OVAJ MODUL NAMJERNO NE RADI:
 *   • ne mijenja status zadatka — odgoda znači „ostani `pending`, dolaziš na red za 15 s";
 *     nikakvo `blocked`, jer blokada traži čovjeka, a ovo se razriješi samo od sebe;
 *   • ne dira disk radnog stabla ni git;
 *   • ne zaključava datoteke na razini datotečnog sustava — ovo je dogovor između
 *     zadataka, ne kernel lock.
 *
 * SLOJEVI ISTINE O OPSEGU (redom po jačini):
 *   1. `declared`   — oznake `scope:<uzorak>` na zadatku. MJERODAVNE: samo one dopuštaju
 *                     paralelan rad kad je presjek prazan.
 *   2. `derived`    — putanje izvučene iz naslova/opisa. Služe SAMO za OTKRIVANJE sudara:
 *                     presjek je dokaz sudara, ali prazan presjek NIJE dokaz nesudara
 *                     (izvlačenje promašuje datoteke koje opis ne spominje).
 *   3. `undeclared` — ni oznaka ni izvedene putanje. Ne zna se ništa.
 *   4. `unbounded`  — `scope:*` ili oznaka `scope-all`: zadatak izrijekom traži cijelo
 *                     stablo (npr. refaktor kroz repozitorij) → ne trpi nikoga uz sebe.
 *
 * ANTI-DEADLOCK: zahtjev umrlog vlasnika se NE poštuje. Svaki zapis nosi pid i trenutak
 * starta procesa; kad taj proces nestane, zahtjev se pri prvom čitanju briše. Vrata koja
 * bi zbog jednog mrtvog procesa zauvijek zaustavila rad gora su od kvara koji sprječavaju.
 *
 * LICENCA/PODRIJETLO: zamisao („zadatak nosi popis datoteka koje smije dirati") pročitana
 * je u projektu pod PolyForm Noncommercial licencom, koja zabranjuje komercijalnu uporabu.
 * Autorsko pravo štiti IZRAZ, ne zamisao — ovo je vlastita izvedba: ni jedan redak, naziv
 * datoteke, naziv agenta ni format konfiguracije nije preuzet. Presjek uzorak-uzorak,
 * troslojni model istine o opsegu, registar sa žetvom po pid-u i protokol proširenja
 * napisani su ovdje od nule. Vidi ~/app/regoc_system/docs/research/ALBERT_ANALIZA_20260728.md.
 *
 * Autorica: Kosjenka (Architect) · 2026-07-29 · TASK-3002 (A3)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, appendFileSync } from 'fs'
import { join, dirname } from 'path'
import { processStartMs } from './StaleCodeCheck'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()

export const SCOPE_CONFIG_PATH =
  process.env.REGOC_SCOPE_CONFIG || join(HOME, '.claude', 'regoc', 'config', 'file-scope-gate.json')
/** Registar živih zahtjeva — dijeli ga daemon (odluka) i CLI (proširenje, izvještaj). */
export const SCOPE_CLAIMS_DIR =
  process.env.REGOC_SCOPE_CLAIMS || join(HOME, '.claude', 'regoc', 'data', 'file_scope_claims')
/** Zapis SVAKE odluke — mjeri se prije nego se vrata upale (kućni obrazac shadow → live). */
export const SCOPE_JSONL_PATH =
  process.env.REGOC_SCOPE_JSONL || join(HOME, '.claude', 'regoc', 'data', 'file_scope.jsonl')

/** Prefiks oznake kojom zadatak izjavljuje opseg: `scope:regoc/TaskWebUI.ts`. */
export const SCOPE_TAG_PREFIX = 'scope:'
/** Oznaka „diram cijelo stablo" — ekvivalent `scope:**`. */
export const SCOPE_ALL_TAG = 'scope-all'
/** Oznaka kojom se zadatak izuzima iz vrata (npr. integracijski posao koji MORA teći usporedno). */
export const SCOPE_OPT_OUT_TAG = 'no-scope-gate'

// ============================================
// KONFIGURACIJA
// ============================================

export interface ScopeConfig {
  /** `off` — potpuni no-op. `on` — vrata odlučuju (živost i dalje ovisi o zastavici u features.json). */
  policy: 'off' | 'on'
  /**
   * Što s parom u kojem bar jedan zadatak NEMA mjerodavan (izjavljen) opseg. Tri stepenice,
   * izmjerene replayem 2729 povijesnih preklopljenih parova (v. docs/TASK-3002_A3_...):
   *   `allow`      — odgađa samo DOKAZAN presjek (6,7 % parova). Nedokazivo prolazi uz
   *                  upozorenje. Ovo je jedina stepenica koja danas ne guši paralelizam.
   *   `derived-ok` — prazan presjek vrijedi i kad je opseg izveden iz opisa; odgađa se tek
   *                  kad bar jedan zadatak nema NIJEDNU putanju (64,1 % parova).
   *   `serialize`  — prazan presjek dokazuje disjunktnost samo među IZJAVLJENIM opsezima
   *                  (100 % parova danas, jer nijedan zadatak nema oznaku `scope:`).
   * Zadano u kodu je `serialize` jer je semantički pošteno; isporučena konfiguracija kreće
   * na `allow` i penje se tek kad zadatci počnu nositi oznake.
   */
  undeclaredPolicy: 'serialize' | 'derived-ok' | 'allow'
  /** Smije li se opseg izvoditi iz teksta zadatka (samo za OTKRIVANJE sudara). */
  deriveFromDescription: boolean
  /** Oznake koje zadatak izuzimaju iz vrata. */
  excludeTags: string[]
  /** Canary: dok popis nije prazan, vrata vrijede SAMO za te izvršitelje. */
  onlyAgents: string[]
  /** Nakon koliko minuta odgode zadatak dobiva glasno upozorenje (sumnja na izgladnjivanje). */
  starvationWarnMinutes: number
  /** Koliko minuta nakon smrti procesa-vlasnika se zahtjev smije požeti. */
  graceMinutes: number
}

export const DEFAULT_SCOPE_CONFIG: ScopeConfig = {
  policy: 'on',
  undeclaredPolicy: 'serialize',
  deriveFromDescription: true,
  excludeTags: [SCOPE_OPT_OUT_TAG, 'integration'],
  onlyAgents: [],
  starvationWarnMinutes: 30,
  graceMinutes: 5,
}

function asStrings(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(s => s.trim())
}

/** Čita se pri SVAKOJ odluci — izmjena konfiguracije djeluje bez restarta daemona. */
export function loadScopeConfig(path = SCOPE_CONFIG_PATH): ScopeConfig {
  const cfg: ScopeConfig = { ...DEFAULT_SCOPE_CONFIG }
  try {
    if (!existsSync(path)) return cfg
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (!raw || typeof raw !== 'object') return cfg
    if (raw.policy === 'off' || raw.policy === 'on') cfg.policy = raw.policy
    if (raw.undeclaredPolicy === 'serialize' || raw.undeclaredPolicy === 'derived-ok' || raw.undeclaredPolicy === 'allow') {
      cfg.undeclaredPolicy = raw.undeclaredPolicy
    }
    if (typeof raw.deriveFromDescription === 'boolean') cfg.deriveFromDescription = raw.deriveFromDescription
    cfg.excludeTags = asStrings(raw.excludeTags, cfg.excludeTags)
    cfg.onlyAgents = asStrings(raw.onlyAgents, cfg.onlyAgents)
    if (typeof raw.starvationWarnMinutes === 'number' && raw.starvationWarnMinutes >= 0) cfg.starvationWarnMinutes = raw.starvationWarnMinutes
    if (typeof raw.graceMinutes === 'number' && raw.graceMinutes >= 0) cfg.graceMinutes = raw.graceMinutes
  } catch {
    // Neispravna konfiguracija NE smije srušiti dodjelu posla — vraćaju se defaulti.
  }
  return cfg
}

// ============================================
// UZORCI: normalizacija
// ============================================

/**
 * Svede uzorak na kanonski oblik: apsolutna putanja bez početne kose crte, bez `.`/`~`,
 * bez dvostrukih kosih crta. Uzorak BEZ ijedne kose crte je golo ime datoteke i znači
 * „gdje god bila" ⇒ `**​/ime` — jer tako se putanje i pišu u opisima zadataka
 * (mjereno: „live.js", „TaskWebUI.ts", a ne pune putanje).
 *
 * `base` je stablo u odnosu na koje se čitaju relativne putanje (zadano HOME).
 */
export function normalizePattern(pattern: string, base = HOME): string | null {
  let p = (pattern || '').trim()
  if (!p) return null
  // Navodnici i zarezi iz ljudskog upisa („scope:'a.ts', b.ts").
  p = p.replace(/^['"`]+|['"`,;]+$/g, '').trim()
  if (!p) return null

  if (p === '*' || p === '**' || p === '/' || p === '.') return '**'

  // Je li ulaz IZRIJEKOM vezan uz stablo (`./`, `~/`, `/`)? To se mora znati PRIJE
  // skidanja prefiksa — inače bi `./manage.sh` postao golo ime i time „bilo gdje".
  const anchored = p.startsWith('/') || p.startsWith('~/') || p.startsWith('./') || p.includes('/')

  if (p.startsWith('~/')) p = join(HOME, p.slice(2))
  else if (p === '~') p = HOME
  else if (p.startsWith('./')) p = p.slice(2)

  if (!anchored) {
    // Golo ime → bilo gdje u stablu. Zadržava se i uzorak (`*.ts` → `**​/*.ts`).
    // Tako se putanje stvarno pišu u opisima zadataka („live.js", „TaskWebUI.ts").
    return `**/${p}`
  }

  if (!p.startsWith('/')) p = `${base.replace(/\/+$/, '')}/${p}`

  // Sažmi `//`, makni `/.` segmente, razriješi `..` bez dodirivanja diska.
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { out.pop(); continue }
    out.push(seg)
  }
  if (out.length === 0) return '**'
  // Direktorij (završna kosa crta) znači „sve ispod njega".
  if (p.endsWith('/')) out.push('**')
  // Vodeća kosa crta se MORA vratiti: bez nje kanonski oblik nije apsolutan, pa bi ga
  // drugi prolaz kroz `normalizePattern` još jednom prefiksirao bazom (`/r/r/...`).
  return '/' + out.join('/')
}

/** Normalizira popis uzoraka, izbacuje prazne i duplikate, čuva redoslijed. */
export function normalizePatterns(patterns: string[], base = HOME): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of patterns) {
    const n = normalizePattern(raw, base)
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

// ============================================
// UZORCI: presjek (čisto, bez diska)
// ============================================

/**
 * Imaju li dva JEDNOSEGMENTNA uzorka (`*`, `?`, doslovni znakovi) ijedan zajednički niz?
 * Dinamičko programiranje nad parom pozicija: `dp(i,j)` = „ostatak A i ostatak B mogu
 * proizvesti isti niz". Ovo NIJE podudaranje uzorka s putanjom — oba su uzorci, pa
 * `*.ts` i `Task*` moraju dati `true` (npr. `TaskWebUI.ts`).
 */
export function tokensOverlap(a: string, b: string): boolean {
  const A = a, B = b
  const memo = new Map<number, boolean>()
  const key = (i: number, j: number) => i * (B.length + 1) + j

  const allStars = (s: string, from: number) => {
    for (let k = from; k < s.length; k++) if (s[k] !== '*') return false
    return true
  }

  const dp = (i: number, j: number): boolean => {
    const k = key(i, j)
    const cached = memo.get(k)
    if (cached !== undefined) return cached
    let res: boolean
    if (i === A.length && j === B.length) res = true
    else if (i === A.length) res = allStars(B, j)
    else if (j === B.length) res = allStars(A, i)
    else {
      const ca = A[i], cb = B[j]
      if (ca === '*') {
        // `*` pojede nula znakova, ili pojede jedan znak koji emitira B.
        res = dp(i + 1, j) || dp(i, j + 1)
      } else if (cb === '*') {
        res = dp(i, j + 1) || dp(i + 1, j)
      } else {
        // Oba emitiraju točno jedan znak.
        const same = ca === '?' || cb === '?' || ca === cb
        res = same ? dp(i + 1, j + 1) : false
      }
    }
    memo.set(k, res)
    return res
  }
  return dp(0, 0)
}

/**
 * Postoji li putanja koju pokrivaju OBA uzorka? `**` guta nula ili više segmenata.
 * Ovo je srce vrata: sudar se mora vidjeti i kad datoteka JOŠ NE POSTOJI (zadatak je tek
 * treba napisati), pa se disk ne smije pitati.
 */
export function patternsOverlap(a: string, b: string): boolean {
  const A = a.split('/'), B = b.split('/')
  const memo = new Map<number, boolean>()
  const key = (i: number, j: number) => i * (B.length + 1) + j

  const restAllDeep = (S: string[], from: number) => {
    for (let k = from; k < S.length; k++) if (S[k] !== '**') return false
    return true
  }

  const go = (i: number, j: number): boolean => {
    const k = key(i, j)
    const cached = memo.get(k)
    if (cached !== undefined) return cached
    let res: boolean
    if (i === A.length && j === B.length) res = true
    else if (i === A.length) res = restAllDeep(B, j)
    else if (j === B.length) res = restAllDeep(A, i)
    else if (A[i] === '**') res = go(i + 1, j) || go(i, j + 1)
    else if (B[j] === '**') res = go(i, j + 1) || go(i + 1, j)
    else res = tokensOverlap(A[i], B[j]) ? go(i + 1, j + 1) : false
    memo.set(k, res)
    return res
  }
  return go(0, 0)
}

/**
 * Normalizacija KONKRETNE putanje (ne uzorka). Razlika je jedna i bitna: golo ime se ovdje
 * čita kao datoteka u korijenu stabla, a NE kao `**​/ime` — inače bi dirnuti `manage.sh`
 * ispao „pokriven" bilo kojim `manage.sh` uzorkom bilo gdje, pa bi revizija odstupanja
 * (`auditDrift`) prijavljivala manje odstupanja nego što ih stvarno ima.
 */
export function normalizePath(path: string, base = HOME): string | null {
  const p = (path || '').trim().replace(/^['"`]+|['"`,;]+$/g, '').trim()
  if (!p) return null
  if (!p.includes('/')) return normalizePattern(`./${p}`, base)
  return normalizePattern(p, base)
}

/** Pokriva li uzorak konkretnu putanju. */
export function matchesPath(path: string, pattern: string, base = HOME): boolean {
  const p = normalizePath(path, base)
  const q = normalizePattern(pattern, base)
  if (!p || !q) return false
  return patternsOverlap(p, q)
}

/** Parovi uzoraka koji se preklapaju (za poruku čovjeku — bez toga je „sudar" prazna riječ). */
export function overlappingPairs(a: string[], b: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const x of a) for (const y of b) if (patternsOverlap(x, y)) out.push([x, y])
  return out
}

// ============================================
// OPSEG ZADATKA
// ============================================

export type ScopeMode = 'declared' | 'derived' | 'undeclared' | 'unbounded'

export interface TaskScope {
  patterns: string[]
  mode: ScopeMode
  /** Sirovi ulaz (oznake ili izvučeni tekst) — za izvještaj i reviziju. */
  raw: string[]
}

/**
 * Putanje iz slobodnog teksta. NAMJERNO široko (radije uzorak viška nego promašen sudar),
 * ali rezultat je zato `derived`, ne `declared` — v. slojevi istine u zaglavlju.
 * Prihvaćaju se poznate nastavke koje sustav stvarno uređuje.
 */
const TEXT_PATH_RE =
  /(?:^|[\s`'"(\[,;:])((?:~\/|\.\/|\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]*[A-Za-z0-9_-]\.(?:ts|tsx|js|jsx|mjs|cjs|py|sh|c|h|cpp|hpp|json|md|sql|html|css|yaml|yml))(?=$|[\s`'")\],;:.])/g

export function deriveScopeFromText(text: string, base = HOME): string[] {
  const found: string[] = []
  const s = String(text || '')
  TEXT_PATH_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TEXT_PATH_RE.exec(s)) !== null) found.push(m[1])
  return normalizePatterns(found, base)
}

export interface TaskLike {
  id?: string
  title?: string
  description?: string
  tags?: string[] | string | null
}

function readTags(t: TaskLike): string[] {
  const raw = t.tags
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string')
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw)
      return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : []
    } catch { return [] }
  }
  return []
}

/**
 * Opseg zadatka. Oznake su mjerodavne; tekst je zamjena samo za otkrivanje sudara.
 * Više `scope:` oznaka se zbraja (unija), a `scope:*`/`scope-all` sve nadjačava.
 */
export function readTaskScope(task: TaskLike, cfg: ScopeConfig = DEFAULT_SCOPE_CONFIG, base = HOME): TaskScope {
  const tags = readTags(task)
  const declared: string[] = []
  let unbounded = false

  for (const tag of tags) {
    if (tag.trim().toLowerCase() === SCOPE_ALL_TAG) { unbounded = true; continue }
    if (!tag.startsWith(SCOPE_TAG_PREFIX)) continue
    const body = tag.slice(SCOPE_TAG_PREFIX.length).trim()
    if (!body) continue
    // Jedna oznaka smije nositi više uzoraka odvojenih zarezom ili razmakom.
    for (const piece of body.split(/[,\s]+/)) {
      if (!piece) continue
      const n = normalizePattern(piece, base)
      if (!n) continue
      if (n === '**') { unbounded = true; continue }
      declared.push(n)
    }
  }

  if (unbounded) return { patterns: ['**'], mode: 'unbounded', raw: tags.filter(t => t.startsWith(SCOPE_TAG_PREFIX) || t === SCOPE_ALL_TAG) }
  if (declared.length > 0) {
    const patterns = normalizePatterns(declared, base)
    return { patterns, mode: 'declared', raw: tags.filter(t => t.startsWith(SCOPE_TAG_PREFIX)) }
  }

  if (cfg.deriveFromDescription) {
    const text = `${task.title || ''}\n${task.description || ''}`
    const derived = deriveScopeFromText(text, base)
    if (derived.length > 0) return { patterns: derived, mode: 'derived', raw: derived }
  }
  return { patterns: [], mode: 'undeclared', raw: [] }
}

/** Oznake kojima se izjavljuje opseg — ono što se stvarno šalje na `POST /api/tasks`. */
export function scopeTags(patterns: string[]): string[] {
  return patterns.map(p => `${SCOPE_TAG_PREFIX}${p.startsWith(HOME + '/') ? p.slice(HOME.length + 1) : p}`)
}

// ============================================
// ODLUKA
// ============================================

export type ScopeVerdict = 'allow' | 'defer'

export type ScopeCode =
  | 'policy-off'        // vrata isključena konfiguracijom
  | 'opt-out-tag'       // zadatak izrijekom izuzet
  | 'canary'            // izvršitelj nije u canary popisu
  | 'no-active'         // nitko drugi ne radi
  | 'disjoint'          // presjek prazan, oba opsega mjerodavna → paralelno je dokazano sigurno
  | 'overlap'           // dokazan presjek uzoraka
  | 'unbounded'         // netko od dvoje traži cijelo stablo
  | 'unproven'          // bar jedan opseg nije mjerodavan pa se disjunktnost ne može dokazati
  | 'unproven-allowed'  // isto, ali politika kaže „pusti" (mjeri se šteta)

export interface ScopeConflict {
  taskId: string | null
  agentId: string
  code: Extract<ScopeCode, 'overlap' | 'unbounded' | 'unproven'>
  /** Parovi uzoraka koji se sudaraju; prazno kad je razlog nedokazivost. */
  pairs: Array<[string, string]>
  /**
   * Samo za `unproven`: bar jedna strana nema NIJEDNU putanju, pa se o njoj ne zna baš
   * ništa. Razlika prema „obje strane imaju putanje, ali izvedene" je jedina stvar koja
   * razlikuje stepenicu `derived-ok` od `serialize`.
   */
  blind?: boolean
  detail: string
}

export interface ScopeDecision {
  verdict: ScopeVerdict
  code: ScopeCode
  reason: string
  conflicts: ScopeConflict[]
  /** Sudar postoji, a vrata ga ne mogu spriječiti (izuzeće, canary, politika `allow`). */
  warn?: string
}

/** Zahtjev nad opsegom koji netko upravo drži. */
export interface ScopeClaim {
  id: string
  taskId: string | null
  agentId: string
  patterns: string[]
  mode: ScopeMode
  /** Proces koji jamči za zahtjev (daemon koji je spawnao agenta). Mrtav pid ⇒ mrtav zahtjev. */
  pid: number | null
  pidStartMs: number | null
  createdAtMs: number
  createdAt: string
  /** Uzorci dodani tijekom rada (protokol proširenja) — čuvaju se odvojeno radi revizije. */
  widened?: string[]
}

export interface ScopeDecisionInput {
  taskId: string | null
  agentId: string
  scope: TaskScope
  /** Zahtjevi DRUGIH (bez ovog zadatka). */
  active: ScopeClaim[]
  tags?: string[]
}

function describeMode(m: ScopeMode): string {
  return m === 'declared' ? 'izjavljen' : m === 'derived' ? 'izveden iz opisa' : m === 'unbounded' ? 'cijelo stablo' : 'neizjavljen'
}

/**
 * Jedina funkcija koja odlučuje. Čista je (bez diska, bez sata) da se svako pravilo može
 * dokazati testom — uključujući ono najvažnije: „nepoznat opseg nije prazan opseg".
 */
export function decideScope(input: ScopeDecisionInput, cfg: ScopeConfig): ScopeDecision {
  const tags = (input.tags || []).map(t => t.toLowerCase())
  const others = input.active.filter(c => c.taskId !== input.taskId || input.taskId === null)

  const collide = (): ScopeConflict[] => {
    const out: ScopeConflict[] = []
    for (const c of others) {
      const selfUnbounded = input.scope.mode === 'unbounded'
      const otherUnbounded = c.mode === 'unbounded'
      if (selfUnbounded || otherUnbounded) {
        out.push({
          taskId: c.taskId, agentId: c.agentId, code: 'unbounded', pairs: [],
          detail: selfUnbounded
            ? `ovaj zadatak traži cijelo stablo, a ${c.agentId} već radi na ${c.taskId || 'bez-zadatka'}`
            : `${c.agentId}/${c.taskId || 'bez-zadatka'} drži cijelo stablo`,
        })
        continue
      }
      const patterns = [...(c.patterns || []), ...(c.widened || [])]
      const pairs = overlappingPairs(input.scope.patterns, patterns)
      if (pairs.length > 0) {
        out.push({
          taskId: c.taskId, agentId: c.agentId, code: 'overlap', pairs,
          detail: `presjek s ${c.agentId}/${c.taskId || 'bez-zadatka'}: ${pairs.slice(0, 4).map(([x, y]) => x === y ? x : `${x} ∩ ${y}`).join(', ')}${pairs.length > 4 ? ` (+${pairs.length - 4})` : ''}`,
        })
        continue
      }
      // Prazan presjek je dokaz SAMO kad su oba opsega mjerodavna.
      const proven = input.scope.mode === 'declared' && c.mode === 'declared'
      if (!proven) {
        const blind = input.scope.patterns.length === 0 || patterns.length === 0
        out.push({
          taskId: c.taskId, agentId: c.agentId, code: 'unproven', pairs: [], blind,
          detail: `disjunktnost nedokaziva: ovaj opseg je ${describeMode(input.scope.mode)}, ` +
                  `a ${c.agentId}/${c.taskId || 'bez-zadatka'} ima ${describeMode(c.mode)}`,
        })
      }
    }
    return out
  }

  if (cfg.policy === 'off') {
    return { verdict: 'allow', code: 'policy-off', reason: 'vrata isključena konfiguracijom (policy=off)', conflicts: [] }
  }

  const optOut = cfg.excludeTags.find(t => tags.includes(t.toLowerCase()))
  if (optOut) {
    const c = collide()
    return {
      verdict: 'allow', code: 'opt-out-tag',
      reason: `zadatak nosi oznaku '${optOut}' — izuzet je iz vrata opsega`,
      conflicts: c,
      warn: c.length ? `oznaka '${optOut}' isključuje vrata, a postoji ${c.length} sudar(a): ${c[0].detail}` : undefined,
    }
  }

  if (cfg.onlyAgents.length > 0 && !cfg.onlyAgents.includes(input.agentId)) {
    const c = collide()
    return {
      verdict: 'allow', code: 'canary',
      reason: `izvršitelj '${input.agentId}' nije u canary popisu (${cfg.onlyAgents.join(', ')})`,
      conflicts: c,
      warn: c.length ? `canary isključuje vrata, a postoji ${c.length} sudar(a): ${c[0].detail}` : undefined,
    }
  }

  if (others.length === 0) {
    return { verdict: 'allow', code: 'no-active', reason: 'nitko drugi ne radi — nema se s kim sudariti', conflicts: [] }
  }

  const conflicts = collide()
  if (conflicts.length === 0) {
    return {
      verdict: 'allow', code: 'disjoint',
      reason: `presjek prazan prema svima (${others.length}) i oba opsega su izjavljena — paralelan rad je dokazano siguran`,
      conflicts: [],
    }
  }

  const hard = conflicts.filter(c => c.code !== 'unproven')
  if (hard.length > 0) {
    const code: ScopeCode = hard.some(c => c.code === 'unbounded') ? 'unbounded' : 'overlap'
    return {
      verdict: 'defer', code,
      reason: `${hard.length} sudar(a) opsega — ${hard[0].detail}`,
      conflicts,
    }
  }

  // Ostali su samo „nedokazivi" — koliko oni vrijede, odlučuje stepenica politike.
  const blocking = cfg.undeclaredPolicy === 'serialize'
    ? conflicts
    : cfg.undeclaredPolicy === 'derived-ok'
      ? conflicts.filter(c => c.blind)     // obje strane imaju putanje ⇒ prazan presjek se prihvaća
      : []                                  // 'allow'
  if (blocking.length === 0) {
    return {
      verdict: 'allow', code: 'unproven-allowed',
      reason: `disjunktnost nedokaziva (${conflicts.length}), ali politika je '${cfg.undeclaredPolicy}' — puštam uz mjerenje`,
      conflicts,
      warn: `nedokazana disjunktnost: ${conflicts[0].detail}. Zadatci bez oznake 'scope:' su slijepa točka.`,
    }
  }
  return {
    verdict: 'defer', code: 'unproven',
    reason: `disjunktnost nedokaziva (${blocking.length}) — ${blocking[0].detail}. Dodaj oznaku 'scope:<uzorak>' da zadatak smije teći usporedno.`,
    conflicts: blocking,
  }
}

// ============================================
// REGISTAR ZAHTJEVA (dijeljen između daemona i CLI-ja)
// ============================================

export type AliveProbe = (pid: number | null, pidStartMs: number | null) => boolean

/** Živ je samo proces koji postoji I ima isti trenutak starta (pid-ovi se recikliraju). */
export const realAliveProbe: AliveProbe = (pid, pidStartMs) => {
  if (!pid) return false
  const started = processStartMs(pid)
  if (started === null) return false
  if (pidStartMs === null) return true
  return Math.abs(started - pidStartMs) < 2000
}

function sanitize(s: string): string {
  return (s || '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60) || 'x'
}

export function claimId(taskId: string | null, agentId: string, nowMs: number): string {
  return `${sanitize(taskId || 'bez-zadatka')}__${sanitize(agentId)}__${nowMs}`
}

export function writeClaim(claim: ScopeClaim, dir = SCOPE_CLAIMS_DIR): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, `${claim.id}.json`)
  writeFileSync(p, JSON.stringify(claim, null, 2))
  return p
}

export function removeClaim(id: string, dir = SCOPE_CLAIMS_DIR): void {
  try { rmSync(join(dir, `${id}.json`), { force: true }) } catch { /* nema ga → posao obavljen */ }
}

export interface ListClaimsOptions {
  dir?: string
  alive?: AliveProbe
  nowMs?: number
  graceMinutes?: number
  /** true → ne briši mrtve zapise s diska (za izvještaj/dry-run). */
  keepDead?: boolean
}

/**
 * Živi zahtjevi. Mrtvi (proces-vlasnik nestao) se PREŠUĆUJU i, nakon grace perioda,
 * brišu — to je jedina brana od zaključavanja cijelog reda zbog jednog pada daemona.
 */
export function listClaims(opts: ListClaimsOptions = {}): ScopeClaim[] {
  const dir = opts.dir || SCOPE_CLAIMS_DIR
  const alive = opts.alive || realAliveProbe
  const nowMs = opts.nowMs ?? Date.now()
  const graceMs = (opts.graceMinutes ?? DEFAULT_SCOPE_CONFIG.graceMinutes) * 60_000
  if (!existsSync(dir)) return []
  const out: ScopeClaim[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    let rec: ScopeClaim
    try {
      rec = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as ScopeClaim
      if (!rec || !Array.isArray(rec.patterns)) continue
    } catch { continue }
    if (alive(rec.pid, rec.pidStartMs)) { out.push(rec); continue }
    // Mrtav vlasnik: zahtjev se više ne poštuje odmah, a s diska nestaje nakon grace perioda
    // (grace postoji samo zato da se svjež zapis ne pomete prije nego mu se pid uopće izmjeri).
    if (!opts.keepDead && nowMs - rec.createdAtMs > graceMs) removeClaim(rec.id, dir)
  }
  return out.sort((a, b) => a.createdAtMs - b.createdAtMs)
}

/** Svi zapisi, uključujući mrtve — za izvještaj („tko je ostavio smeće"). */
export function listAllClaims(dir = SCOPE_CLAIMS_DIR): ScopeClaim[] {
  return listClaims({ dir, alive: () => true, keepDead: true })
}

export interface RegisterInput {
  taskId: string | null
  agentId: string
  scope: TaskScope
  pid: number
  nowMs: number
}

export function registerClaim(input: RegisterInput, dir = SCOPE_CLAIMS_DIR): ScopeClaim {
  const claim: ScopeClaim = {
    id: claimId(input.taskId, input.agentId, input.nowMs),
    taskId: input.taskId,
    agentId: input.agentId,
    patterns: input.scope.patterns,
    mode: input.scope.mode,
    pid: input.pid,
    pidStartMs: processStartMs(input.pid),
    createdAtMs: input.nowMs,
    createdAt: new Date(input.nowMs).toISOString(),
  }
  writeClaim(claim, dir)
  return claim
}

// ============================================
// PROŠIRENJE OPSEGA TIJEKOM RADA
// ============================================

export interface WidenResult {
  ok: boolean
  /** Uzorci koji su stvarno dodani (normalizirani, bez onih koje opseg već pokriva). */
  added: string[]
  conflicts: ScopeConflict[]
  reason: string
}

/**
 * „Što kad se opseg tijekom rada proširi?" — jedini dopušten put je OVAJ, izrijekom.
 * Tiho širenje je isto što i nemati vrata: agent bi upisao datoteku koju netko drugi
 * upravo drži i vrata bi lagala da su nešto spriječila.
 *
 * Odgovor je namjerno ODBIJANJE, a ne čekanje: agent je usred rada, ne može stati bez
 * troška, pa mora dobiti jasnu uputu (uzmi drugi put, ili neka se posao razdvoji u
 * zadatak koji čeka). Trošak odbijanja plaća onaj koji je krivo procijenio opseg.
 */
export function planWiden(
  self: ScopeClaim,
  addPatterns: string[],
  active: ScopeClaim[],
  base = HOME,
): WidenResult {
  const wanted = normalizePatterns(addPatterns, base)
  if (wanted.length === 0) return { ok: false, added: [], conflicts: [], reason: 'nije zadan nijedan valjan uzorak' }

  const have = [...self.patterns, ...(self.widened || [])]
  // „Već pokriveno" znamo pouzdano samo za doslovno isti uzorak i za `**`. Preklapanje
  // NIJE sadržavanje (`src/a.ts` se preklapa sa `src/*.ts`, ali ga ne pokriva), pa bi
  // preklapanje kao kriterij tiho propustilo širi uzorak bez provjere sudara.
  const toAdd = wanted.filter(w => !have.some(h => h === w || h === '**'))
  if (toAdd.length === 0) {
    return { ok: true, added: [], conflicts: [], reason: 'traženi uzorci već su unutar postojećeg opsega' }
  }

  const conflicts: ScopeConflict[] = []
  for (const c of active) {
    if (c.id === self.id) continue
    const theirs = [...(c.patterns || []), ...(c.widened || [])]
    if (c.mode === 'unbounded') {
      conflicts.push({ taskId: c.taskId, agentId: c.agentId, code: 'unbounded', pairs: [], detail: `${c.agentId}/${c.taskId || 'bez-zadatka'} drži cijelo stablo` })
      continue
    }
    const pairs = overlappingPairs(toAdd, theirs)
    if (pairs.length > 0) {
      conflicts.push({
        taskId: c.taskId, agentId: c.agentId, code: 'overlap', pairs,
        detail: `${pairs.map(([x, y]) => x === y ? x : `${x} ∩ ${y}`).join(', ')} drži ${c.agentId}/${c.taskId || 'bez-zadatka'}`,
      })
    }
  }

  if (conflicts.length > 0) {
    return {
      ok: false, added: [], conflicts,
      reason: `proširenje odbijeno — ${conflicts[0].detail}. Ili pričekaj da taj zadatak završi, ili otvori novi zadatak s tim opsegom (blockedBy na tuđi), ili se dogovori s vlasnikom.`,
    }
  }
  return { ok: true, added: toAdd, conflicts: [], reason: `opseg proširen za ${toAdd.length} uzorak/uzoraka` }
}

/** Zapiši proširenje u zahtjev (poziva se tek kad `planWiden` kaže da smije). */
export function applyWiden(self: ScopeClaim, added: string[], dir = SCOPE_CLAIMS_DIR): ScopeClaim {
  const next: ScopeClaim = { ...self, widened: [...(self.widened || []), ...added] }
  writeClaim(next, dir)
  return next
}

// ============================================
// REVIZIJA: je li se opseg poštovao
// ============================================

export interface DriftReport {
  taskId: string | null
  inScope: string[]
  outOfScope: string[]
  /** Postotak dirnutih datoteka koje su bile izvan izjavljenog opsega. */
  driftPct: number
}

/**
 * Usporedi STVARNO dirnute datoteke s izjavljenim opsegom. Bez ovoga je izjava opsega
 * samo lijepa namjera: mjeri se koliko su izjave točne prije nego se na njih osloni
 * odluka o paralelnom radu.
 */
export function auditDrift(taskId: string | null, scope: TaskScope, touched: string[], base = HOME): DriftReport {
  const inScope: string[] = []
  const outOfScope: string[] = []
  for (const f of touched) {
    const n = normalizePath(f, base)
    if (!n) continue
    const covered = scope.mode === 'unbounded' || scope.patterns.some(p => patternsOverlap(n, p))
    ;(covered ? inScope : outOfScope).push(n)
  }
  const total = inScope.length + outOfScope.length
  return { taskId, inScope, outOfScope, driftPct: total === 0 ? 0 : Math.round((outOfScope.length / total) * 100) }
}

// ============================================
// ZAPIS ODLUKA (mjerenje prije uključivanja)
// ============================================

export interface ScopeLogEntry {
  ts: string
  taskId: string | null
  agentId: string
  verdict: ScopeVerdict
  code: ScopeCode
  live: boolean
  mode: ScopeMode
  patterns: string[]
  activeCount: number
  reason: string
  warn?: string
  conflicts?: Array<{ taskId: string | null; agentId: string; code: string; detail: string }>
}

export function appendScopeLog(entry: ScopeLogEntry, path = SCOPE_JSONL_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(entry) + '\n')
  } catch { /* mjerenje nikad ne ruši dodjelu posla */ }
}

export function formatScopeDecision(d: ScopeDecision, input: ScopeDecisionInput, live: boolean): string {
  const tag = live ? '' : ' SHADOW'
  const icon = d.verdict === 'defer' ? '⛔' : d.code === 'unproven-allowed' ? '👁️' : '✅'
  const scopeTxt = input.scope.mode === 'undeclared'
    ? 'bez opsega'
    : `${describeMode(input.scope.mode)}: ${input.scope.patterns.slice(0, 3).join(', ')}${input.scope.patterns.length > 3 ? ` (+${input.scope.patterns.length - 3})` : ''}`
  const head = `${icon} [opseg${tag}] ${input.agentId}/${input.taskId || 'bez-zadatka'} → ${d.verdict} (${d.code}); ${scopeTxt} — ${d.reason}`
  return d.warn ? `${head}\n   ⚠️ ${d.warn}` : head
}

// ============================================
// ODGODE: praćenje izgladnjivanja
// ============================================

export const DEFER_STATE_PATH =
  process.env.REGOC_SCOPE_DEFERS || join(HOME, '.claude', 'regoc', 'data', 'file_scope_defers.json')

export interface DeferState { [taskId: string]: { sinceMs: number; count: number; lastCode: ScopeCode } }

export function readDeferState(path = DEFER_STATE_PATH): DeferState {
  try {
    if (!existsSync(path)) return {}
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as DeferState : {}
  } catch { return {} }
}

export function writeDeferState(state: DeferState, path = DEFER_STATE_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(state, null, 2))
  } catch { /* praćenje odgoda nije razlog za pad petlje */ }
}

export interface DeferNote { waitedMs: number; count: number; starving: boolean }

/**
 * Zabilježi odgodu i reci koliko se već čeka. Odgoda bez trajanja je nevidljiva —
 * točno onaj oblik u kojem je „posao koji čeka" prije bio samo tišina u `pending`.
 */
export function noteDefer(taskId: string, code: ScopeCode, nowMs: number, cfg: ScopeConfig, path = DEFER_STATE_PATH): DeferNote {
  const state = readDeferState(path)
  const prev = state[taskId]
  const sinceMs = prev?.sinceMs ?? nowMs
  const count = (prev?.count ?? 0) + 1
  state[taskId] = { sinceMs, count, lastCode: code }
  writeDeferState(state, path)
  const waitedMs = nowMs - sinceMs
  return { waitedMs, count, starving: waitedMs >= cfg.starvationWarnMinutes * 60_000 }
}

/** Zadatak je krenuo (ili nestao iz reda) → brisanje brojača. Vraća koliko je čekao. */
export function clearDefer(taskId: string, nowMs: number, path = DEFER_STATE_PATH): number | null {
  const state = readDeferState(path)
  const prev = state[taskId]
  if (!prev) return null
  delete state[taskId]
  writeDeferState(state, path)
  return nowMs - prev.sinceMs
}

// ============================================
// SASTAVLJENI PUT (ono što daemon zove)
// ============================================

export interface PlanScopeInput {
  task: TaskLike
  agentId: string
  /** Zahtjevi drugih; ako se izostavi, čitaju se s diska (živi). */
  active?: ScopeClaim[]
  nowMs?: number
}

export interface ScopePlan {
  decision: ScopeDecision
  scope: TaskScope
  input: ScopeDecisionInput
  active: ScopeClaim[]
}

/** Pročitaj opseg, pročitaj žive zahtjeve, odluči. Ništa ne mijenja. */
export function planScope(cfg: ScopeConfig, p: PlanScopeInput, base = HOME): ScopePlan {
  const scope = readTaskScope(p.task, cfg, base)
  const taskId = p.task.id ? String(p.task.id) : null
  const all = p.active ?? listClaims({ nowMs: p.nowMs, graceMinutes: cfg.graceMinutes })
  const active = all.filter(c => c.taskId !== taskId)
  const input: ScopeDecisionInput = {
    taskId,
    agentId: p.agentId,
    scope,
    active,
    tags: readTags(p.task),
  }
  return { decision: decideScope(input, cfg), scope, input, active }
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2)
  const cmd = args[0] || 'status'
  const cfg = loadScopeConfig()

  if (cmd === 'status') {
    const all = listAllClaims()
    const live = listClaims({ keepDead: true })
    const liveIds = new Set(live.map(c => c.id))
    console.log(`Vrata opsega: policy=${cfg.policy}  nedokazano=${cfg.undeclaredPolicy}  izvodi-iz-opisa=${cfg.deriveFromDescription}`)
    console.log(`Registar: ${SCOPE_CLAIMS_DIR}  zapisa=${all.length}  živih=${live.length}`)
    for (const c of all) {
      const pats = [...c.patterns, ...(c.widened || [])]
      console.log(`  ${liveIds.has(c.id) ? '🟢' : '⚪'} ${c.agentId}/${c.taskId || 'bez-zadatka'}  mode=${c.mode}  pid=${c.pid ?? '-'}  ${pats.slice(0, 5).join(', ') || '(prazno)'}${pats.length > 5 ? ` +${pats.length - 5}` : ''}`)
    }
    const defers = readDeferState()
    const keys = Object.keys(defers)
    if (keys.length) {
      console.log(`Odgođeni (${keys.length}):`)
      for (const k of keys) {
        const d = defers[k]
        console.log(`  ⏳ ${k}  čeka ${Math.round((Date.now() - d.sinceMs) / 60000)} min  pokušaja=${d.count}  razlog=${d.lastCode}`)
      }
    }
    process.exit(0)
  }

  if (cmd === 'scope') {
    // `scope <taskId>` — što bi vrata pročitala kao opseg tog zadatka.
    const id = args[1]
    if (!id) { console.log('Uporaba: bun FileScopeGate.ts scope <TASK-ID>'); process.exit(2) }
    const { Database } = await import('bun:sqlite')
    const db = new Database(join(HOME, '.claude', 'regoc', 'data', 'regoc.db'), { readonly: true })
    const row = db.query('SELECT id,title,description,tags,assignee FROM tasks WHERE id = ?').get(id) as any
    db.close()
    if (!row) { console.log(`Nema zadatka ${id}`); process.exit(1) }
    const s = readTaskScope(row, cfg)
    console.log(`${row.id} (${row.assignee || 'bez izvršitelja'}) → mode=${s.mode}`)
    for (const p of s.patterns) console.log(`   ${p}`)
    if (s.mode === 'derived') console.log('   ⚠️ izvedeno iz opisa — služi samo za otkrivanje sudara, NE dokazuje disjunktnost')
    if (s.mode === 'undeclared') console.log(`   ⚠️ nema opsega. Dodaj oznake: ${scopeTags(['regoc/NekiModul.ts']).join(' ')}`)
    process.exit(0)
  }

  if (cmd === 'plan') {
    // `plan <taskId> [agent]` — bi li zadatak sada prošao vrata.
    const id = args[1]
    if (!id) { console.log('Uporaba: bun FileScopeGate.ts plan <TASK-ID> [agent]'); process.exit(2) }
    const { Database } = await import('bun:sqlite')
    const db = new Database(join(HOME, '.claude', 'regoc', 'data', 'regoc.db'), { readonly: true })
    const row = db.query('SELECT id,title,description,tags,assignee FROM tasks WHERE id = ?').get(id) as any
    db.close()
    if (!row) { console.log(`Nema zadatka ${id}`); process.exit(1) }
    const agentId = args[2] || row.assignee || 'kosjenka'
    const plan = planScope(cfg, { task: row, agentId })
    console.log(formatScopeDecision(plan.decision, plan.input, false))
    for (const c of plan.decision.conflicts) console.log(`   ↳ ${c.code}: ${c.detail}`)
    process.exit(plan.decision.verdict === 'defer' ? 1 : 0)
  }

  if (cmd === 'claim') {
    // `claim <taskId> <uzorak...>` — protokol proširenja opsega tijekom rada.
    const id = args[1]
    const pats = args.slice(2)
    if (!id || pats.length === 0) { console.log('Uporaba: bun FileScopeGate.ts claim <TASK-ID> <uzorak> [uzorak...]'); process.exit(2) }
    const active = listClaims()
    const self = active.find(c => c.taskId === id)
    if (!self) {
      console.log(`⚠️ Za ${id} ne postoji živ zahtjev (zadatak nije pokrenut kroz daemon, ili je vlasnik umro).`)
      console.log('   Proširenje se ne može zabilježiti. Dodaj oznaku scope: na zadatak i pokreni ga ponovno.')
      process.exit(2)
    }
    const res = planWiden(self, pats, active)
    if (!res.ok) {
      console.log(`⛔ ${res.reason}`)
      for (const c of res.conflicts) console.log(`   ↳ ${c.detail}`)
      process.exit(1)
    }
    if (res.added.length > 0) applyWiden(self, res.added)
    console.log(`✅ ${res.reason}${res.added.length ? `: ${res.added.join(', ')}` : ''}`)
    process.exit(0)
  }

  console.log('Uporaba: bun FileScopeGate.ts [status | scope <TASK-ID> | plan <TASK-ID> [agent] | claim <TASK-ID> <uzorak...>]')
  process.exit(2)
}
