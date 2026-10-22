/**
 * TaskDecomposer.ts — E4/E5 zadatak se RAZLAŽE na 3–7 podzadataka (P5c / TASK-2584, PRJ-030)
 *
 * PROBLEM (izmjeren 2026-09-02 na regoc.db, zadnjih 60 dana): od 852 zadatka njih
 * 278 (32,6 %) je E4/E5, a od 92 takva s odlukom tiera 78 (85 %) je pokrenuto kao
 * JEDAN opus generalist. Isti obrazac vrijedi i za ovaj zadatak: TASK-2584 je u
 * 09:14 klasificiran COMPLEX/E5 i dobio `model=opus, source=agent-default`.
 * Jedan div nosi cijeli kontekst, jedan pad briše cijeli posao, a cijena raste
 * neograničeno.
 *
 * RJEŠENJE: skupi model (ili Ollama) radi SAMO plan — razlaganje na 3–7 koraka s
 * EKSPLICITNIM ulazima i izlazima. Korake zatim voze jeftiniji radnici, svaki sa
 * svojim zadatkom u TaskManageru, svojim checkpointom i malim kontekst-paketom.
 *
 * ── ŠTO OVAJ MODUL JEST, A ŠTO NIJE ───────────────────────────────────────────
 *
 * JEST: čista logika (procjena prikladnosti, normalizacija plana, provjera ciklusa,
 * računanje valova paralelizma, gradnja opisa podzadatka) + tanak I/O sloj
 * (spremanje plana, materijalizacija u TaskManager, otprema `chain_next` poruka).
 *
 * NIJE: nova klasifikacija težine. Težinu i dalje daje `ModeClassifier`
 * (E1–E5), a tier modela `TaskTier`. Ovo se nadovezuje na njih.
 *
 * ── ZAŠTO PLANER SMIJE BITI LLM, A `TaskTier` NE SMIJE ────────────────────────
 *
 * `ModeClassifier` kao LLM-vrata na VRUĆEM putu je kod nas pao (92 % krivo
 * skrenutog prometa, TASK-2559) — jer je svaka poruka plaćala klasifikaciju.
 * Ovdje je drukčije: planer se zove NAJVIŠE JEDNOM po E4/E5 zadatku (≈ 1/3
 * zadataka), a njegov izlaz zamjenjuje puni opus run. Trošak plana je red
 * veličine manji od onoga što izbjegava. Ulaz u planer je usko grlo, pa je
 * izlaz strogo stegnut (`normalizePlan`): enum-clamp na registar agenata i na
 * dopuštene tierove, broj koraka na 3–7, nepoznate ovisnosti se brišu, ciklusi
 * se lome. Malikova pouka iz NT-F (TASK-2579): LLM izlaz nikad ne ide dalje
 * neprovjeren.
 *
 * ── TRI PRAVILA ODLUKE ────────────────────────────────────────────────────────
 *
 * 1. SAMO NADOLJE (isto kao TaskTier). Korak nikad ne dobiva model skuplji od
 *    zadanog za tog agenta. Promašen downgrade košta jedan ponovni pokušaj.
 * 2. NEODLUČENO = DANAŠNJE PONAŠANJE. Ako plan ne prođe provjeru, nema
 *    razlaganja — zadatak ide starim putem (jedan agent). Fail-safe, ne fail-open.
 * 3. NIŠTA SE NE STVARA BEZ POTVRDE. Plan se ZAPIŠE i JAVI Goranu; podzadaci
 *    nastaju tek na `approve` (PLAN mod: predloži, ne izvrši).
 *
 * ── ZAŠTO ULAZI/IZLAZI MORAJU BITI EKSPLICITNI ───────────────────────────────
 *
 * Bez njih se lanac raspada na „doradi rad prethodnog" — obrazac koji smo već
 * imali u `createSequentialHelpers` i koji radniku ne kaže ŠTO traži ni ŠTO mora
 * ostaviti. Ulaz = konkretna datoteka/zadatak/naredba; izlaz = konkretan artefakt
 * koji sljedeći korak može pročitati. Time podzadatak postaje provjerljiv
 * (CriticGate ima što gledati) i prenosiv na slabiji model.
 *
 * Zastavice (features.json):
 *   taskDecompose      — PROMATRANJE: plan se izračuna, zapiše i javi; ploča se NE dira.
 *   taskDecomposeLive  — true → odobren plan se STVARNO materijalizira u podzadatke.
 */

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from 'fs'
import { join } from 'path'

// ─── Tipovi ───────────────────────────────────────────────────────────────────

export type Tier = 'haiku' | 'sonnet' | 'opus'
export const TIER_ORDER: Record<Tier, number> = { haiku: 1, sonnet: 2, opus: 3 }
export const ALLOWED_TIERS: Tier[] = ['haiku', 'sonnet', 'opus']

/** Jedan korak plana. Ulazi i izlazi su OBAVEZNI — to je cijela poanta. */
export interface PlanStep {
  key: string           // 's1', 's2', … (stabilan ključ unutar plana)
  title: string         // kratak naslov posla
  agent: string         // izvršitelj iz registra
  tier: Tier            // predloženi model (nikad skuplji od agentovog zadanog)
  brief: string         // što točno napraviti
  inputs: string[]      // konkretni ulazi (datoteka, zadatak, naredba)
  outputs: string[]     // konkretni izlazi (artefakt koji sljedeći korak čita)
  dependsOn: string[]   // ključevi koraka o kojima ovisi
  verify?: string       // naredba/mjerilo kojim se korak dokazuje
  taskId?: string       // popunjava se pri materijalizaciji
}

export interface DecompositionPlan {
  taskId: string
  parentTitle: string
  projectId?: string | null
  effort: string          // 'E4' | 'E5'
  planner: string         // 'claude:opus' | 'ollama:<model>' | 'manual'
  createdAt: string
  status: 'proposed' | 'approved' | 'materialized' | 'rejected'
  approvedBy?: string
  approvedAt?: string
  /**
   * Canary-strop: pumpa smije otpremiti samo korake iz valova ≤ ovoga. Bez toga
   * „pusti prvi val pa stani i pogledaj" ne postoji — pumpa bi u sljedećoj minuti
   * sama nastavila u drugi val. Neodređeno = svi valovi.
   */
  maxWave?: number
  steps: PlanStep[]
  notes?: string
}

export interface PlanIssue { level: 'error' | 'warn'; msg: string }

// ─── Putanje ──────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || process.env.USERPROFILE || ''
export const REGOC_DIR = join(HOME, '.claude', 'regoc')
export function plansDir(): string {
  return process.env.REGOC_PLANS_DIR || join(REGOC_DIR, 'data', 'decomposition_plans')
}
export function decisionLog(): string {
  return process.env.REGOC_DECOMPOSE_LOG || join(REGOC_DIR, 'data', 'task_decomposition.jsonl')
}
export function messagesDbPath(): string {
  return process.env.REGOC_MESSAGES_DB || join(REGOC_DIR, 'messages.db')
}
export const TASK_API = process.env.REGOC_TASK_API || 'http://localhost:17781/api/tasks'

// ─── 1. Prikladnost (čista logika) ────────────────────────────────────────────

export interface TaskFacts {
  id: string
  title: string
  description?: string | null
  tags?: string[]
  assignee?: string | null
  status?: string | null
  projectId?: string | null
}

export interface EligibilityResult {
  eligible: boolean
  reason: string
}

/** Razredi koje razlaganje prima ako pozivatelj ne kaže drukčije (P5c, izvorno ponašanje). */
export const ZADANI_RAZREDI_ZA_RAZLAGANJE: readonly string[] = ['E4', 'E5'] as const

/**
 * Razlaže se SAMO ono što ima smisla razložiti. Namjerno usko — pouka TASK-2559:
 * široka vrata skrenu promet koji nije trebao skrenuti.
 *
 * U5/TASK-4265: popis razreda je sad ULAZ, a ne konstanta. Razlog: prag B iz razrade §2
 * („puni lanac od težine ≥ 36") pada u razred E3, pa bi tvrdo zapisan popis E4/E5 značio
 * da vrata puštaju posao u lanac, a razlaganje ga na sljedećem koraku odbija — lanac bi
 * tiho stao na koraku 3. Zadana vrijednost ostaje E4/E5, pa nijedan postojeći pozivatelj
 * ne mijenja ponašanje.
 */
export function isDecomposable(
  task: TaskFacts,
  effort: string,
  opts: { allowedEfforts?: readonly string[] } = {},
): EligibilityResult {
  const dopusteni = (opts.allowedEfforts && opts.allowedEfforts.length ? opts.allowedEfforts : ZADANI_RAZREDI_ZA_RAZLAGANJE)
    .map(e => String(e).toUpperCase())
  if (!dopusteni.includes(String(effort).toUpperCase())) {
    return { eligible: false, reason: `napor ${effort} — razlaganje je za ${dopusteni.join('/')}` }
  }
  const tags = (task.tags || []).map(t => String(t).toLowerCase())
  // Podzadatak se ne razlaže dalje — inače lanac eksplodira u stablo.
  if (tags.some(t => t.startsWith('parent:') || t === 'subtask' || t === 'decomposed')) {
    return { eligible: false, reason: 'zadatak je već podzadatak (oznaka parent:/subtask)' }
  }
  if (tags.includes('no-decompose')) return { eligible: false, reason: 'izričita oznaka no-decompose' }
  // Bez opisa nema iz čega napraviti ulaze/izlaze — plan bi bio izmišljen.
  const desc = (task.description || '').trim()
  if (desc.length < 120) return { eligible: false, reason: `opis prekratak (${desc.length} zn.) — nema iz čega izvesti ulaze/izlaze` }
  return { eligible: true, reason: `napor ${effort}, opis ${desc.length} zn.` }
}

// ─── 2. Normalizacija plana (enum-clamp nad LLM izlazom) ──────────────────────

export interface NormalizeCtx {
  knownAgents: string[]                    // registar agenata
  agentBaseline: Record<string, Tier>      // agentov zadani tier (strop, pravilo „samo nadolje")
  fallbackAgent: string
  minSteps?: number
  maxSteps?: number
}

function clampTier(raw: unknown, agent: string, ctx: NormalizeCtx): Tier {
  const t = String(raw || '').toLowerCase().trim()
  const base = ctx.agentBaseline[agent] || 'sonnet'
  const picked: Tier = (ALLOWED_TIERS as string[]).includes(t) ? t as Tier : 'sonnet'
  // Pravilo 1: nikad skuplje od agentovog zadanog.
  return TIER_ORDER[picked] > TIER_ORDER[base] ? base : picked
}

/**
 * „Samo nadolje" kao JEDNA funkcija — koriste je i planer (clampTier) i durabilni
 * radnik (AgentDaemon.resolveMessageModel). Dva mjesta s istim pravilom značila bi
 * dva mjesta na kojima se pravilo može razići.
 * Nepoznata tražena vrijednost → `mine` (današnje ponašanje), nikad iznenađenje.
 */
export function clampModelDownward(wanted: unknown, mine: string): string {
  const w = String(wanted || '').toLowerCase().trim()
  if (!(w in TIER_ORDER)) return mine
  const mineRank = TIER_ORDER[String(mine || '').toLowerCase() as Tier] ?? TIER_ORDER.opus
  return TIER_ORDER[w as Tier] > mineRank ? mine : w
}

function asStringArray(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map(x => String(x).trim())
            : (typeof v === 'string' && v.trim()) ? [v.trim()] : []
  // Dedup po malim slovima: isti artefakt naveden dvaput izgleda kao dva izlaza,
  // pa i „nema izlaza" i „dva izlaza" postaju netočni brojevi u planu.
  const seen = new Set<string>()
  return raw.filter(x => { const k = x.toLowerCase(); if (!x || seen.has(k)) return false; seen.add(k); return true })
}

/**
 * Pretvara sirovi (LLM) izlaz u plan kojem se smije vjerovati. Sve što ne
 * prepoznaje — briše ili stegne. Nikad ne baca iznimku: neuspjeh se vidi kao
 * plan koji ne prođe `validatePlan`.
 */
export function normalizePlan(raw: any, ctx: NormalizeCtx): PlanStep[] {
  const minSteps = ctx.minSteps ?? 3
  const maxSteps = ctx.maxSteps ?? 7
  const rawSteps: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.steps) ? raw.steps : []
  const seen = new Set<string>()
  let idx = 0
  const steps: PlanStep[] = []

  for (const s of rawSteps) {
    if (steps.length >= maxSteps) break
    if (!s || typeof s !== 'object') continue
    idx++
    let key = String(s.key || s.id || `s${idx}`).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (!key || seen.has(key)) key = `s${idx}`
    if (seen.has(key)) continue
    const title = String(s.title || s.name || '').trim().slice(0, 120)
    if (!title) continue
    const agentRaw = String(s.agent || s.assignee || '').trim().toLowerCase()
    const agent = ctx.knownAgents.includes(agentRaw) ? agentRaw : ctx.fallbackAgent
    const inputs = asStringArray(s.inputs).slice(0, 8)
    const outputs = asStringArray(s.outputs).slice(0, 8)
    const dependsOn = asStringArray(s.dependsOn ?? s.depends_on).map(d => d.toLowerCase().replace(/[^a-z0-9_-]/g, ''))
    seen.add(key)
    steps.push({
      key,
      title,
      agent,
      tier: clampTier(s.tier || s.model, agent, ctx),
      brief: String(s.brief || s.description || title).trim().slice(0, 1200),
      inputs,
      outputs,
      dependsOn,
      verify: s.verify ? String(s.verify).trim().slice(0, 300) : undefined,
    })
  }

  // Ovisnosti na nepostojeće korake su šum iz modela — brišu se.
  const keys = new Set(steps.map(s => s.key))
  for (const s of steps) s.dependsOn = s.dependsOn.filter(d => keys.has(d) && d !== s.key)
  // Ciklus bi zauvijek zaključao lanac: lomi se brisanjem unatražnih bridova.
  breakCycles(steps)
  if (steps.length < minSteps) return steps   // provjera će ga odbiti — namjerno ne izmišljamo korake
  return steps
}

/** Uklanja bridove koji vode na korak koji dolazi kasnije u nizu (jedini izvor ciklusa nakon topološkog reda). */
export function breakCycles(steps: PlanStep[]): void {
  const pos = new Map(steps.map((s, i) => [s.key, i]))
  for (const s of steps) s.dependsOn = s.dependsOn.filter(d => (pos.get(d) ?? Infinity) < (pos.get(s.key) ?? -1))
}

// ─── 3. Provjera plana ────────────────────────────────────────────────────────

export function validatePlan(steps: PlanStep[], opts: { minSteps?: number; maxSteps?: number; grounding?: boolean | GroundingOpts } = {}): PlanIssue[] {
  const minSteps = opts.minSteps ?? 3
  const maxSteps = opts.maxSteps ?? 7
  const issues: PlanIssue[] = []
  if (steps.length < minSteps) issues.push({ level: 'error', msg: `plan ima ${steps.length} koraka, minimum je ${minSteps}` })
  if (steps.length > maxSteps) issues.push({ level: 'error', msg: `plan ima ${steps.length} koraka, maksimum je ${maxSteps}` })
  const keys = new Set<string>()
  for (const s of steps) {
    if (keys.has(s.key)) issues.push({ level: 'error', msg: `dvostruki ključ koraka: ${s.key}` })
    keys.add(s.key)
    if (!s.inputs.length) issues.push({ level: 'error', msg: `${s.key}: nema eksplicitnih ULAZA` })
    if (!s.outputs.length) issues.push({ level: 'error', msg: `${s.key}: nema eksplicitnih IZLAZA` })
    if (!s.agent) issues.push({ level: 'error', msg: `${s.key}: nema izvršitelja` })
    if (!s.verify) issues.push({ level: 'warn', msg: `${s.key}: nema mjerila provjere` })
  }
  for (const s of steps) for (const d of s.dependsOn) if (!keys.has(d)) issues.push({ level: 'error', msg: `${s.key}: ovisi o nepoznatom koraku ${d}` })
  if (hasCycle(steps)) issues.push({ level: 'error', msg: 'ovisnosti sadrže ciklus' })
  const waves = computeWaves(steps)
  if (maxParallel(waves) < 2) issues.push({ level: 'warn', msg: 'plan je potpuno sekvencijalan — nema dobitka od paralelizma' })
  // Isti izvršitelj u istom valu = serijsko izvođenje (jedan daemon, jedna poruka odjednom).
  const eff = effectiveParallelism(steps, waves)
  if (maxParallel(waves) >= 2 && eff < 2) {
    issues.push({ level: 'error', msg: `plan izgleda paralelno (${maxParallel(waves)} koraka u valu) ali su svi na istom izvršitelju — stvarni paralelizam je ${eff}` })
  }
  for (const c of outputCollisions(steps, waves)) {
    issues.push({ level: 'error', msg: `val ${c.wave}: koraci ${c.keys.join(' i ')} usporedno pišu isti izlaz „${c.output}" — pregazili bi se` })
  }
  // Utemeljenost je OPT-IN: pozivatelj (tools/decompose.ts) je pali izričito, pa
  // nijedan postojeći pozivatelj ne mijenja ponašanje bez odluke.
  if (opts.grounding) issues.push(...groundingIssues(steps, typeof opts.grounding === 'object' ? opts.grounding : {}))
  return issues
}

// ─── 3b. Utemeljenost plana (P5c / TASK-4672) ────────────────────────────────

/**
 * STRUKTURA PLANA NIJE ISTINA O PLANU.
 *
 * Kvar izmjeren 04.09.2026. na TASK-2563 („R7: kraj tihih cancelled"): Ollamin
 * planer je PREPRIČAO runtime ponašanje iz opisa kao korake posla i izmislio
 * artefakte — s2 je tražio `agent-output.log`/`exit-code` kojih nema ni na disku
 * ni u planu, sva četiri koraka su „ostavljala" nepostojeće `.db` baze, a s1 je
 * bio čisti protokol ploče („postavi status na in_progress"). Plan je pritom
 * PROŠAO `validatePlan`: valovi točni, paralelizam stvaran, bez ciklusa i sudara.
 *
 * Cijena propuštanja (mjereno): s1 je potrošio 0,12 USD i IZMISLIO datoteku
 * (~/.tmp/status-updated-in-progress.db — 753 B teksta s nastavkom .db) samo da
 * zadovolji ugovor „IZLAZI (bez njih zadatak NIJE gotov)"; s2 se blokirao
 * (TASK-4669), s3/s4 stali, a `spawnAgentOnDemand` — jedino mjesto koje je posao
 * trebao dirati — nije taknuo nijedan korak. Ugovor koji se ne može ispuniti ne
 * disciplinira radnika nego ga tjera na izmišljanje.
 *
 * Tri pravila (sva fail-safe: greška = nema razlaganja, zadatak ide starim putem):
 *   G1  ULAZ mora netko proizvesti ili mora postojati na disku.
 *   G2  IZLAZ mora imati mjesto na kojem nastaje (postojeća datoteka ili
 *       postojeći direktorij); nova `.db`/`.sqlite` baza nije artefakt koraka.
 *   G3  Korak čiji je cijeli posao vođenje ploče (status, progressNote) nije
 *       posao — to svaki radnik radi ionako, po protokolu.
 */
export interface GroundingOpts {
  /** Postoji li artefakt? Prazno = pravi disk (roots + ~ ekspanzija). Testovi ubrizgaju svoju. */
  exists?: (token: string) => boolean
  /** Korijeni u kojima se traži relativna putanja. */
  roots?: string[]
}

const MANAGED_STORE_RX = /\.(db|sqlite3?|db3)$/i
const FILEISH_RX = /\.[a-z0-9]{1,6}$/i
const PROTOCOL_RX = /(ažurira\w*\s+status)|(postav\w*\s+status)|(status\w*\s+(taska|zadatka)?\s*(na\s*)?['"`]?(in_progress|pending|completed|blocked))|(progress\s*note)|(zatvor\w*\s+zadat)/i

/** Je li token uopće putanja/datoteka? Opisi, TASK-ID-evi, API-ji i URL-ovi nisu. */
export function isFileish(token: string): boolean {
  const t = (token || '').trim()
  if (!t) return false
  if (/^https?:\/\//i.test(t) || /^\/?api\//i.test(t)) return false
  if (/\s/.test(t)) return false
  return FILEISH_RX.test(t) || t.includes('/')
}

function expandHome(p: string): string {
  const home = process.env.HOME || ''
  return p.startsWith('~') ? join(home, p.slice(1)) : p
}

function makeExists(opts: GroundingOpts): (t: string) => boolean {
  if (opts.exists) return opts.exists
  const home = process.env.HOME || ''
  const roots = opts.roots ?? [process.cwd(), join(home, '.claude/regoc'), join(home, '.claude'), home]
  return (token: string) => {
    const t = expandHome(token.trim())
    try {
      if (t.startsWith('/')) return existsSync(t)
      return roots.some(r => existsSync(join(r, t)))
    } catch { return false }
  }
}

/** Ima li token direktorijsku komponentu (dakle: zna se GDJE nastaje)? */
function dirPart(token: string): string | null {
  const t = token.trim()
  const i = t.lastIndexOf('/')
  return i > 0 ? t.slice(0, i) : null
}

/** Artefakt koji izgleda kao stvaran posao na disku (ne gola izmišljotina). */
function isRealArtifact(token: string, exists: (t: string) => boolean): boolean {
  if (!isFileish(token)) return false
  if (exists(token)) return true
  const d = dirPart(token)
  return !!d && exists(d)
}

export function groundingIssues(steps: PlanStep[], opts: GroundingOpts = {}): PlanIssue[] {
  const exists = makeExists(opts)
  const issues: PlanIssue[] = []
  const produced = new Set<string>()
  for (const s of steps) for (const o of s.outputs) {
    const t = o.trim().toLowerCase()
    produced.add(t)
    const b = t.slice(t.lastIndexOf('/') + 1)
    if (b) produced.add(b)
  }

  for (const s of steps) {
    // G1 — ULAZ koji nitko ne proizvodi i koji ne postoji
    for (const i of s.inputs) {
      if (!isFileish(i)) continue
      const t = i.trim().toLowerCase()
      if (produced.has(t) || produced.has(t.slice(t.lastIndexOf('/') + 1))) continue
      if (exists(i)) continue
      issues.push({ level: 'error', msg: `${s.key}: ULAZ „${i}" nitko u planu ne proizvodi i ne postoji na disku — korak bi se blokirao prvog trena` })
    }
    // G2 — IZLAZ bez mjesta na kojem nastaje
    for (const o of s.outputs) {
      if (!isFileish(o)) continue
      if (exists(o)) continue
      if (MANAGED_STORE_RX.test(o)) {
        issues.push({ level: 'error', msg: `${s.key}: IZLAZ „${o}" je izmišljena baza — korak ne stvara novi .db; navedi postojeću bazu ili pravi artefakt` })
        continue
      }
      const d = dirPart(o)
      if (!d || !exists(d)) {
        issues.push({ level: 'error', msg: `${s.key}: IZLAZ „${o}" nema putanju u kojoj bi nastao — bez toga ga radnik izmisli da zatvori korak` })
      }
    }
    // G3 — korak koji je vođenje ploče, a ne posao
    const text = `${s.title}\n${s.brief}`
    if (PROTOCOL_RX.test(text) && !s.outputs.some(o => isRealArtifact(o, exists))) {
      issues.push({ level: 'error', msg: `${s.key}: korak je protokol ploče (status/progressNote), ne posao — to svaki radnik radi ionako, a kao korak troši spawn i tjera na izmišljen izlaz` })
    }
  }
  return issues
}

export function hasCycle(steps: PlanStep[]): boolean {
  const dep = new Map(steps.map(s => [s.key, s.dependsOn.slice()]))
  const state = new Map<string, number>()   // 0=nedirnut 1=u obradi 2=gotov
  const visit = (k: string): boolean => {
    const st = state.get(k) || 0
    if (st === 1) return true
    if (st === 2) return false
    state.set(k, 1)
    for (const d of dep.get(k) || []) if (dep.has(d) && visit(d)) return true
    state.set(k, 2)
    return false
  }
  return steps.some(s => visit(s.key))
}

/** Topološki slojevi: sve u istom valu smije teći USPOREDNO. */
export function computeWaves(steps: PlanStep[]): string[][] {
  const remaining = new Map(steps.map(s => [s.key, s.dependsOn.filter(d => steps.some(x => x.key === d))]))
  const done = new Set<string>()
  const waves: string[][] = []
  let guard = 0
  while (remaining.size && guard++ < 32) {
    const wave = [...remaining.entries()].filter(([, deps]) => deps.every(d => done.has(d))).map(([k]) => k)
    if (!wave.length) break            // ciklus — validatePlan ga prijavljuje zasebno
    for (const k of wave) { remaining.delete(k); done.add(k) }
    waves.push(wave)
  }
  return waves
}

export function maxParallel(waves: string[][]): number {
  return waves.reduce((m, w) => Math.max(m, w.length), 0)
}

/**
 * STVARNI paralelizam nije broj koraka u valu nego broj RAZLIČITIH izvršitelja u njemu.
 * Durabilni `AgentDaemon` obrađuje TOČNO JEDNU poruku odjednom (`pollInbox` → prva pa
 * `Bun.sleep`), pa tri koraka dodijeljena istoj agentici teku SERIJSKI, koliko god
 * plan izgledao paralelno. Mjereno 02.09.: Ollama (qwen3-coder:30b) je za TASK-2569
 * vratio 5 koraka od kojih su svih 5 pripali Jeleni — plan koji „ima 2 usporedna koraka",
 * a zapravo nema nijedan.
 */
export function distinctAgents(steps: PlanStep[], wave: string[]): string[] {
  const byKey = new Map(steps.map(s => [s.key, s]))
  return [...new Set(wave.map(k => byKey.get(k)?.agent).filter(Boolean) as string[])]
}

export function effectiveParallelism(steps: PlanStep[], waves: string[][]): number {
  return waves.reduce((m, w) => Math.max(m, distinctAgents(steps, w).length), 0)
}

/**
 * Dva koraka u ISTOM valu ne smiju pisati istu datoteku — tekli bi usporedno i
 * pregazili se. Vrata opsega datoteka (A3/`fileScopeGate`) su ugašena, pa je ovo
 * jedina obrana. Ollamin plan za TASK-2569 je imao točno taj kvar: s1 i s4 su oba
 * u 1. valu mijenjala `buildAgentPrompt()`.
 */
export function outputCollisions(steps: PlanStep[], waves: string[][]): Array<{ wave: number; output: string; keys: string[] }> {
  const byKey = new Map(steps.map(s => [s.key, s]))
  const out: Array<{ wave: number; output: string; keys: string[] }> = []
  waves.forEach((w, i) => {
    const seen = new Map<string, string[]>()
    for (const k of w) {
      for (const o of byKey.get(k)?.outputs || []) {
        const norm = o.toLowerCase().trim()
        seen.set(norm, [...(seen.get(norm) || []), k])
      }
    }
    for (const [o, keys] of seen) if (keys.length > 1) out.push({ wave: i + 1, output: o, keys })
  })
  return out
}

/**
 * Prefiks kojim pumpa označava SVOJU zadršku („ovaj korak čeka prethodni"). Sve ostalo
 * u `blocked` je ljudska ili agentska odluka i pumpa je NE smije poništiti.
 *
 * Zašto postoji (kvar uhvaćen 02.09. u canaryju TASK-2569): korak s3 je isporučio
 * djelomično, pa je ručno stavljen u `blocked` s popisom onoga što fali. Pumpa ga je
 * u sljedećem prolazu vidjela kao „nije otpremljen, ovisnosti nema" i vratila u
 * `in_progress` — dakle blokada koju postavi čovjek nije držala ni minutu.
 */
export const DEP_HOLD_PREFIX = 'BLOCKED: čeka korake'

/**
 * Oznaka „ovo čeka čovjeka" iz `AutonomyQueue.DEFAULT_HUMAN_GATED_TAGS`. Jedina zadrška
 * koja stvarno drži.
 *
 * Zašto (kvar uhvaćen 02.09. u 10:09): korak iznad canary-stropa stvoren je kao `blocked`,
 * ali kad je 1. val završio, sistemski AUTO-UNBLOCK je obrisao `blockedBy` i vratio ga u
 * `pending` — a auto-exec ga je 30 s kasnije pokrenuo. Strop je dakle čuvao samo pumpu, dok
 * je posao u vrući daemon ušao drugim putem. Status nije brava; oznaka jest.
 */
export const HUMAN_HOLD_TAG = 'waiting-for-human'

/** Oznake podzadatka; korak iznad canary-stropa dobiva i ljudsku zadršku. */
export function subtaskTags(parentTaskId: string, step: PlanStep, aboveCanaryCap = false): string[] {
  const tags = [`parent:${parentTaskId}`, 'subtask', 'decomposed', `tier:${step.tier}`, `step:${step.key}`]
  if (aboveCanaryCap) tags.push(HUMAN_HOLD_TAG)
  return tags
}

export function isSystemDependencyHold(blockedReason?: string | null): boolean {
  return typeof blockedReason === 'string' && blockedReason.trim().startsWith(DEP_HOLD_PREFIX)
}

/**
 * Smije li pumpa dirati korak u ovom stanju?
 * `pending` = još nije krenuo. `blocked` SAMO ako je to zadrška same pumpe.
 * Sve ostalo (in_progress, completed, cancelled, ručni blocked) se ne dira.
 */
export function isPumpable(taskStatus?: string | null, blockedReason?: string | null): boolean {
  if (taskStatus === 'pending') return true
  if (taskStatus === 'blocked') return isSystemDependencyHold(blockedReason)
  return false
}

/**
 * Koraci koji se smiju otpremiti ODMAH (sve ovisnosti su u `completedKeys`).
 * `maxWave` je canary-strop: korak iz kasnijeg vala se ne otprema ni kad je spreman.
 */
export function readySteps(steps: PlanStep[], completedKeys: Set<string>, dispatchedKeys: Set<string>,
                           maxWave?: number): PlanStep[] {
  const allowed = new Set<string>()
  if (maxWave && maxWave > 0) {
    computeWaves(steps).slice(0, maxWave).forEach(w => w.forEach(k => allowed.add(k)))
  }
  return steps.filter(s => !completedKeys.has(s.key) && !dispatchedKeys.has(s.key)
    && s.dependsOn.every(d => completedKeys.has(d))
    && (!maxWave || maxWave <= 0 || allowed.has(s.key)))
}

// ─── 4. Opis podzadatka (ono što radnik stvarno dobije) ───────────────────────

export interface SubtaskDescOpts {
  parentTaskId: string
  parentTitle: string
  originalRequest: string
  contextPack?: string      // P4a: mali kontekst-paket (memory + RAG)
  recipe?: string           // P3: recept za tier
  depTaskIds?: Record<string, string>   // key → TASK-ID (za čitanje rezultata prethodnog koraka)
}

export function buildSubtaskDescription(step: PlanStep, opts: SubtaskDescOpts): string {
  const deps = step.dependsOn.map(d => opts.depTaskIds?.[d] ? `${d} (${opts.depTaskIds[d]})` : d)
  const L: string[] = []
  L.push(`Podzadatak razloženog posla ${opts.parentTaskId} — „${opts.parentTitle}".`)
  L.push('')
  L.push(`## TVOJ DIO`)
  L.push(step.brief)
  L.push('')
  L.push(`## ULAZI (ovo pročitaj PRIJE nego počneš)`)
  for (const i of step.inputs) L.push(`- ${i}`)
  if (deps.length) L.push(`- rezultat prethodnih koraka: ${deps.join(', ')} — pročitaj im resultSummary preko GET ${TASK_API}/<ID>`)
  L.push('')
  L.push(`## IZLAZI (bez njih zadatak NIJE gotov)`)
  for (const o of step.outputs) L.push(`- ${o}`)
  L.push('')
  if (step.verify) { L.push(`## PROVJERA`); L.push(step.verify); L.push('') }
  L.push(`## OPSEG — DRŽI SE GA`)
  L.push(`Radi SAMO ovaj korak. Ne rješavaj ostatak nadzadatka, ne otvaraj nove teme, ne diraj datoteke izvan svojih izlaza.`)
  L.push(`Ako ti ulaz nedostaje ili nije upotrebljiv: status blocked s razlogom, NE completed.`)
  L.push('')
  if (opts.recipe) { L.push(`## RECEPT (${step.tier})`); L.push(opts.recipe); L.push('') }
  if (opts.contextPack) { L.push(`## KONTEKST-PAKET (dovoljno za ovaj korak — ne učitavaj cijeli sustav)`); L.push(opts.contextPack); L.push('') }
  L.push(`## IZVORNI ZAHTJEV (referenca, NE tvoj opseg)`)
  L.push(opts.originalRequest.slice(0, 1500))
  return L.join('\n')
}

// ─── 5. Upit planeru (opus ili Ollama radi SAMO plan) ─────────────────────────

export function buildPlannerPrompt(task: TaskFacts, ctx: NormalizeCtx, effort: string): string {
  return [
    `Razloži složeni zadatak na 3–7 podzadataka koje mogu izvršiti SLABIJI modeli (haiku/sonnet) usporedno.`,
    `Ti radiš SAMO plan. Ne izvršavaj ništa, ne piši kod, ne diraj datoteke.`,
    ``,
    `ZADATAK ${task.id} (napor ${effort}): ${task.title}`,
    `OPIS:`,
    (task.description || '').slice(0, 6000),
    ``,
    `DOSTUPNI IZVRŠITELJI: ${ctx.knownAgents.join(', ')}`,
    ``,
    `PRAVILA PLANA:`,
    `1. 3 do 7 koraka. Svaki korak mora biti izvediv u JEDNOM prolazu bez šireg konteksta.`,
    `2. Svaki korak MORA imati eksplicitne "inputs" (konkretne datoteke/zadaci/naredbe koje čita) i "outputs" (konkretne artefakte koje ostavlja).`,
    `2a. ULAZ i IZLAZ su PUNE PUTANJE do datoteka koje POSTOJE ili nastaju u postojećem direktoriju (npr. ~/.claude/regoc/RegocDaemon.ts). NE izmišljaj imena tipa "cancelled-log.db" ni nove .db/.sqlite baze — plan s neutemeljenim artefaktom se ODBIJA.`,
    `2b. ULAZ koraka mora biti IZLAZ nekog ranijeg koraka ili datoteka koja već postoji. Ako ga nitko ne proizvodi, korak se blokira prvog trena.`,
    `2c. NE pretvaraj opis ponašanja sustava u korake plana. Koraci su IZMJENE KODA/DOKUMENATA i njihove provjere, a ne prepričan tijek izvođenja.`,
    `2d. Vođenje ploče (postavljanje statusa, progressNote, zatvaranje zadatka) NIJE korak — svaki radnik to radi po protokolu.`,
    `3. "dependsOn" navodi SAMO stvarne ovisnosti. Koraci bez ovisnosti teku usporedno — traži barem 3 takva ako je posao djeljiv.`,
    `3a. Koraci koji teku usporedno MORAJU imati RAZLIČITE izvršitelje — jedan izvršitelj radi jedan po jedan korak, pa bi inače tekli serijski.`,
    `3b. Koraci koji teku usporedno NE SMIJU pisati istu datoteku — pregazili bi se.`,
    `4. "tier": haiku za mehanički posao, sonnet za rutinski, opus samo ako je korak nesvodivo težak.`,
    `5. "verify": naredba ili mjerilo kojim se korak dokazuje (npr. "bun test tests/x.test.ts → 0 fail").`,
    ``,
    `VRATI ISKLJUČIVO JSON, bez teksta oko njega:`,
    `{"steps":[{"key":"s1","title":"...","agent":"...","tier":"sonnet","brief":"...","inputs":["..."],"outputs":["..."],"dependsOn":[],"verify":"..."}],"notes":"..."}`,
  ].join('\n')
}

/** Izvlači prvi JSON objekt iz teksta modela (koji zna zaogrnuti odgovor u ```json). */
export function extractJson(text: string): any | null {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates = [fenced?.[1], text]
  for (const c of candidates) {
    if (!c) continue
    const start = c.indexOf('{')
    const end = c.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try { return JSON.parse(c.slice(start, end + 1)) } catch {}
  }
  return null
}

// ─── 6. Trajno stanje plana ───────────────────────────────────────────────────

export function planPath(taskId: string): string {
  return join(plansDir(), `${taskId}.json`)
}

export function savePlan(plan: DecompositionPlan): string {
  const dir = plansDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const p = planPath(plan.taskId)
  writeFileSync(p, JSON.stringify(plan, null, 2))
  return p
}

export function loadPlan(taskId: string): DecompositionPlan | null {
  const p = planPath(taskId)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf-8')) as DecompositionPlan } catch { return null }
}

export function listPlans(): DecompositionPlan[] {
  const dir = plansDir()
  if (!existsSync(dir)) return []
  const out: DecompositionPlan[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try { out.push(JSON.parse(readFileSync(join(dir, f), 'utf-8'))) } catch {}
  }
  return out
}

export function logDecision(entry: Record<string, unknown>): void {
  try {
    const f = decisionLog()
    const dir = f.slice(0, f.lastIndexOf('/'))
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch {}
}

// ─── 7. Otprema podzadatka durabilnom radniku (`chain_next` proizvođač) ───────

/**
 * `chain_next` je u `AgentDaemon.pollInbox` bio na popisu prihvaćenih tipova od
 * početka, ali ga NITKO nije proizvodio — mrtav ulaz. Ovo je proizvođač.
 * `metadata.model` nosi tier koraka; AgentDaemon ga smije primijeniti samo NADOLJE.
 */
export function dispatchSubtask(args: {
  agent: string; content: string; taskId: string; parentTaskId: string; stepKey: string; tier: Tier;
  dbPath?: string; priority?: number
}): string {
  const db = new Database(args.dbPath || messagesDbPath())
  try {
    const id = `chain-${args.parentTaskId}-${args.stepKey}-${Date.now()}`
    db.prepare(`
      INSERT INTO messages (id, from_agent, to_agent, content, message_type, priority, status, metadata)
      VALUES (?, 'regoc', ?, ?, 'chain_next', ?, 'pending', ?)
    `).run(id, args.agent, args.content, args.priority ?? 2,
      JSON.stringify({ taskId: args.taskId, parentTaskId: args.parentTaskId, stepKey: args.stepKey, model: args.tier }))
    return id
  } finally { db.close() }
}

// ─── 8. Sažetak plana za čovjeka (Telegram / CLI) ────────────────────────────

export function renderPlan(plan: DecompositionPlan): string {
  const waves = computeWaves(plan.steps)
  const L: string[] = []
  L.push(`PLAN RAZLAGANJA ${plan.taskId} — ${plan.parentTitle}`)
  L.push(`napor ${plan.effort} · planer ${plan.planner} · koraka ${plan.steps.length} · valova ${waves.length} · koraka u najvećem valu ${maxParallel(waves)} · STVARNIH usporednih radnika ${effectiveParallelism(plan.steps, waves)}`)
  L.push('')
  waves.forEach((w, i) => {
    const ag = distinctAgents(plan.steps, w)
    L.push(`── VAL ${i + 1}${w.length > 1 ? ` (${w.length} koraka, ${ag.length} radnik${ag.length === 1 ? ' → SERIJSKI!' : 'a usporedno'})` : ''} ──`)
    for (const k of w) {
      const s = plan.steps.find(x => x.key === k)!
      L.push(`  [${s.key}] ${s.agent}/${s.tier}: ${s.title}${s.taskId ? ` → ${s.taskId}` : ''}`)
      L.push(`      ulazi:  ${s.inputs.join(' | ')}`)
      L.push(`      izlazi: ${s.outputs.join(' | ')}`)
      if (s.dependsOn.length) L.push(`      ovisi:  ${s.dependsOn.join(', ')}`)
      if (s.verify) L.push(`      provjera: ${s.verify}`)
    }
  })
  if (plan.notes) { L.push(''); L.push(`napomena: ${plan.notes}`) }
  return L.join('\n')
}
