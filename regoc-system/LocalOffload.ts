/**
 * LocalOffload.ts — mehanički koraci na LOKALNOJ Ollami umjesto na Anthropic kvoti
 * (F2 / P2 / TASK-2568, PRJ-030)
 *
 * ── PROBLEM ───────────────────────────────────────────────────────────────────
 * Pet koraka u REGOČ-u je čisto mehaničkih (klasifikacija, ekstrakcija, sažimanje,
 * dedup-provjera, heartbeat-brief). Svaki od njih danas ili troši `claude --print`
 * spawn (Anthropic kvota, ~5–15 s, pada kad je API u rate-limitu) ili se uopće ne
 * radi. Ollama na GPU stroju već poslužuje embeddinge, besplatna je i ne dijeli
 * sudbinu Anthropic API-ja.
 *
 * ── ŠTO OVAJ MODUL SMIJE, A ŠTO NIKAD ────────────────────────────────────────
 * SMIJE (jedini dopušteni poslovi, `ALLOWED_JOBS`):
 *   1. classifyTier      — poruka → E1..E5 + predloženi izvršitelj
 *   2. extractRefs       — TASK-ID / PRJ-ID / agent / tier-oznaka iz teksta
 *   3. summarize         — sažetak rezultata za Telegram (≤200 znakova)
 *   4. recycledReport    — SAVJET „je li ovo recikliran izvještaj?"
 *   5. heartbeatBrief    — brief za watchdog (≤100 znakova)
 * NIKAD: pisanje koda, sigurnosne odluke, finalni izvještaji korisniku.
 * To nije samo dogovor — `offload()` odbija svaki posao izvan `ALLOWED_JOBS`, a
 * posao 4 je konstrukcijski SAMO savjetodavan (v. `recycledReport` niže).
 *
 * ── ZAŠTO OVO NE PROTURJEČI TaskTier.ts §„zašto heuristika, a ne LLM" ────────
 * Ondje je odbačen LLM-klasifikator koji je i SAM bio `claude --print` spawn na
 * vrućem putu — plaćaš model da odlučiš koji model platiti, i to sinkrono. Ovdje
 * je model besplatan, lokalan i NIJE na vrućem putu: u sjeni se poziv uopće ne
 * čeka, a determinističko rješenje se izračuna PRIJE njega i uvijek je odgovor.
 *
 * ── UGOVOR O KRITIČNOM PUTU (revizija Jelena fable, 2026-07-13) ───────────────
 *   • deterministički fallback se računa PRVI i sinkrono — on je uvijek `value`
 *     dok `ollamaClassifierLive` nije upaljen;
 *   • u SJENI se Ollama zove fire-and-forget (`void`), pozivatelj ne čeka ništa;
 *   • timeout je ≤ 2 s (`OFFLOAD_TIMEOUT_MS`), uz AbortController;
 *   • svaka iznimka se guta — pad Ollame ne smije usporiti ni srušiti dispatch;
 *   • bez `ollamaClassifier` flaga modul je potpuni no-op (ni promatranja).
 *
 * ── FLAGOVI ──────────────────────────────────────────────────────────────────
 *   ollamaClassifier      false → no-op | true → SJENA (zove, uspoređuje, LOGIRA)
 *   ollamaClassifierLive  true  → Ollamin odgovor se STVARNO koristi (osim posla 4)
 * Rollback = flag na false, djeluje ≤30 s bez restarta (FeatureFlags TTL).
 *
 * Zapis usporedbe: `~/.claude/regoc/data/ollama_offload.jsonl`.
 */

import { appendFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { isEnabled } from './FeatureFlags'
import { getModeClassifier, type EffortTier } from './ModeClassifier'
import { isRecycledAgentReport } from './DispatchGuard'
import { getModelRouter } from './models/ModelRouter'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()

/** Gdje se piše usporedba sjene. Test/alat smije preusmjeriti. */
export function offloadLogPath(): string {
  return process.env.REGOC_OFFLOAD_LOG || join(HOME, '.claude/regoc/data/ollama_offload.jsonl')
}

/** Tvrda gornja granica čekanja na Ollamu. Revizija traži ≤ 2 s. */
export const OFFLOAD_TIMEOUT_MS = Number(process.env.REGOC_OFFLOAD_TIMEOUT_MS) || 2000

export const ALLOWED_JOBS = [
  'classifyTier',
  'extractRefs',
  'summarize',
  'recycledReport',
  'heartbeatBrief',
] as const
export type OffloadJob = (typeof ALLOWED_JOBS)[number]

/**
 * Poslovi koje ovaj modul odbija i kad ih netko izričito zatraži. Popis je ovdje
 * da zabrana bude STROJNA, a ne komentar u dokumentaciji.
 */
export const FORBIDDEN_JOBS = ['writeCode', 'securityDecision', 'finalReport'] as const

export interface OffloadResult<T> {
  /** Vrijednost koju pozivatelj smije koristiti. U sjeni = `fallback`. */
  value: T
  /** Odakle je `value` došla. */
  source: 'fallback' | 'ollama'
  /** Determinističko rješenje — uvijek izračunato, uvijek dostupno. */
  fallback: T
  /** Ollamin prijedlog; `null` ako flag isključen, timeout, greška ili neparsabilno. */
  ollama: T | null
  /** Slažu li se; `null` kad Ollamin odgovor ne postoji. */
  agreed: boolean | null
  /** Trajanje Ollaminog poziva u ms; 0 kad poziva nije bilo. */
  latencyMs: number
  error?: string
}

// ─── Zapis sjene ──────────────────────────────────────────────────────────────

function logComparison(job: OffloadJob, input: string, r: OffloadResult<unknown>, live: boolean): void {
  try {
    const file = offloadLogPath()
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(),
      job,
      mode: live ? 'live' : 'shadow',
      inputLen: input.length,
      inputHead: input.replace(/\s+/g, ' ').slice(0, 120),
      fallback: r.fallback,
      ollama: r.ollama,
      agreed: r.agreed,
      latencyMs: r.latencyMs,
      error: r.error,
    }) + '\n')
  } catch {
    // Zapis je promatranje, ne funkcija — nikad ne ruši pozivatelja.
  }
}

// ─── Poziv Ollame (jedini izlaz prema mreži) ─────────────────────────────────

/**
 * Jedan JSON poziv lokalnom klasifikatoru. NIKAD ne baca: greška, timeout i
 * neparsabilan odgovor svi vraćaju `null`. Model se čita iz
 * `model-config.json → componentOverrides.classifier` preko `ModelRouter`-a, pa
 * promjena modela ne traži izmjenu koda.
 */
async function askOllama<T>(systemPrompt: string, userPrompt: string, timeoutMs = OFFLOAD_TIMEOUT_MS): Promise<T | null> {
  try {
    const router = getModelRouter()
    const { provider } = router.resolve({ tier: 'classifier', component: 'classifier' })
    if (provider !== 'ollama') {
      // Osigurač: komponentni override je netko vratio na plaćeni provider.
      // Offload tada NE radi ništa — ne trošimo kvotu iza leđa.
      return null
    }
    return await router.classify<T>(systemPrompt, userPrompt, timeoutMs)
  } catch {
    return null
  }
}

// ─── Zajednička jezgra ───────────────────────────────────────────────────────

interface JobSpec<T> {
  job: OffloadJob
  input: string
  fallback: T
  system: string
  user: string
  parse: (raw: unknown) => T | null
  equals: (a: T, b: T) => boolean
  /** true = Ollamin odgovor se NIKAD ne koristi kao `value`, ni u LIVE-u. */
  advisoryOnly?: boolean
}

/**
 * Srce ugovora. U sjeni vraća fallback ODMAH i pušta Ollamu u pozadinu; u LIVE-u
 * je čeka, ali najviše `OFFLOAD_TIMEOUT_MS` i uz fallback na svaki neuspjeh.
 */
async function run<T>(spec: JobSpec<T>): Promise<OffloadResult<T>> {
  const base: OffloadResult<T> = {
    value: spec.fallback, source: 'fallback', fallback: spec.fallback,
    ollama: null, agreed: null, latencyMs: 0,
  }

  if (!ALLOWED_JOBS.includes(spec.job)) {
    return { ...base, error: `job '${spec.job}' nije na popisu dopuštenih` }
  }
  if (!isEnabled('ollamaClassifier')) return base

  const live = isEnabled('ollamaClassifierLive') && !spec.advisoryOnly

  const call = async (): Promise<OffloadResult<T>> => {
    const t0 = Date.now()
    const raw = await askOllama<unknown>(spec.system, spec.user)
    const latencyMs = Date.now() - t0
    if (raw === null) {
      return { ...base, latencyMs, error: 'ollama nedostupna/neparsabilna' }
    }
    let parsed: T | null = null
    try { parsed = spec.parse(raw) } catch { parsed = null }
    if (parsed === null) {
      return { ...base, latencyMs, error: 'odgovor ne odgovara shemi' }
    }
    const agreed = spec.equals(spec.fallback, parsed)
    return {
      value: live ? parsed : spec.fallback,
      source: live ? 'ollama' : 'fallback',
      fallback: spec.fallback,
      ollama: parsed,
      agreed,
      latencyMs,
    }
  }

  if (!live) {
    // SJENA: fire-and-forget. Pozivatelj dobiva fallback bez ijedne milisekunde čekanja.
    void call()
      .then(r => logComparison(spec.job, spec.input, r, false))
      .catch(() => {})
    return base
  }

  try {
    const r = await call()
    logComparison(spec.job, spec.input, r, true)
    return r
  } catch (e: any) {
    return { ...base, error: String(e?.message || e) }
  }
}

/** Javni ulaz za alate/testove — provjerava allowlist prije svega. */
export function isAllowedJob(job: string): job is OffloadJob {
  return (ALLOWED_JOBS as readonly string[]).includes(job)
}

// ─── 1. Klasifikacija poruke u tier ──────────────────────────────────────────

export interface TierDecision {
  effort: EffortTier
  agent: string | null
}

const TIER_SYSTEM = `Ti si klasifikator poruka u sustavu REGOČ. Odredi KOLIKO POSLA poruka traži.

E1 = ne traži novi posao: pozdrav, zahvala, ispravak, informacija ili trajna uputa bez artefakta,
     statusni upit, GOTOV agentski izvještaj, sistemska obavijest, šum. Orkestrator odgovara sam.
E2 = jedan konkretan deliverable, jedan izvršitelj, uzak opseg (jedan popravak/upit/izmjena konfiguracije).
E3 = više deliverablea ili modulska implementacija; jedan primarni agent.
E4 = opseg cijelog podsustava ili više disciplina — traži tim.
E5 = izgradnja cijelog sustava od nule ili višefazni program.

PRAVILA KOJA SE NAJČEŠĆE KRŠE:
- DULJINA NIJE MJERILO. Poruka od 10000 znakova koja samo daje upute je E1.
- Poruka koja SADRŽI gotov izvještaj (📋 SUMMARY / ✅ RESULTS / 📊 STATUS) i ne traži ništa novo = E1.
- Sistemska obavijest o pokretanju/završetku/padu agenta = E1.
- "Zapamti X" = E1; "spremi X u RAG/datoteku" = E2.
- Sistemski alarm koji traži radnju = E2, ne E1.
- Puno glagola radnje u tekstu NE znači veći tier ako je tekst izvještaj o već obavljenom poslu.

agent = primarni IZVRŠITELJ posla, jedan od:
kosjenka (arhitektura, plan), jelena (implementacija, popravak koda), malik (sigurnost),
manda (istraživanje, analiza izvora), dora (analiza podataka, izvještaj), gita (vizual),
grga (dizajn sučelja), potjeh (QA, testovi), stribor (glas i govor), regoc (orkestracija, sustav).
Za E1 agent je null.

Odgovori ISKLJUČIVO JSON-om: {"tier":"E1|E2|E3|E4|E5","agent":"<ime>|null"}`

const VALID_TIERS: EffortTier[] = ['E1', 'E2', 'E3', 'E4', 'E5']
const VALID_AGENTS = ['kosjenka', 'jelena', 'malik', 'manda', 'dora', 'gita', 'grga', 'potjeh', 'stribor', 'regoc']

/** Deterministički put — postojeći keyword `ModeClassifier`, bez ijednog mrežnog poziva. */
export function classifyTierFallback(content: string): TierDecision {
  const r = getModeClassifier().classifyMessage(content)
  return { effort: r.effort, agent: r.suggestedAgents.length ? r.suggestedAgents[0] : null }
}

export function parseTierDecision(raw: any): TierDecision | null {
  const tier = String(raw?.tier ?? raw?.effort ?? '').toUpperCase().trim()
  if (!VALID_TIERS.includes(tier as EffortTier)) return null
  let agent: string | null = raw?.agent == null ? null : String(raw.agent).toLowerCase().trim()
  if (agent === 'null' || agent === '' || agent === 'none') agent = null
  if (agent !== null && !VALID_AGENTS.includes(agent)) agent = null
  return { effort: tier as EffortTier, agent }
}

export async function classifyTier(content: string): Promise<OffloadResult<TierDecision>> {
  return run<TierDecision>({
    job: 'classifyTier',
    input: content,
    fallback: classifyTierFallback(content),
    system: TIER_SYSTEM,
    user: content.slice(0, 6000),
    parse: parseTierDecision,
    equals: (a, b) => a.effort === b.effort,
  })
}

/** Izravan Ollamin sud bez flagova i sjene — za mjerne alate (golden-set). */
export async function classifyTierOllama(content: string, timeoutMs = OFFLOAD_TIMEOUT_MS): Promise<TierDecision | null> {
  const raw = await askOllama<any>(TIER_SYSTEM, content.slice(0, 6000), timeoutMs)
  return raw === null ? null : parseTierDecision(raw)
}

// ─── 2. Ekstrakcija referenci ────────────────────────────────────────────────

export interface ExtractedRefs {
  taskIds: string[]
  projectIds: string[]
  agents: string[]
  tier: EffortTier | null
}

/** Regex put. Za ID-eve je deterministika TOČNIJA od modela — model ovdje samo dopunjuje. */
export function extractRefsFallback(content: string): ExtractedRefs {
  const uniq = (a: string[]) => [...new Set(a)]
  const lower = content.toLowerCase()
  const tierMatch = content.match(/\b(?:tier[:\s-]*)?(E[1-5])\b/)
  return {
    taskIds: uniq(content.match(/TASK-\d+/g) || []),
    projectIds: uniq(content.match(/PRJ-\d+/g) || []),
    agents: VALID_AGENTS.filter(a => new RegExp(`\\b${a}\\b`, 'i').test(lower)),
    tier: tierMatch ? (tierMatch[1].toUpperCase() as EffortTier) : null,
  }
}

const EXTRACT_SYSTEM = `Iz teksta izvuci reference. Ne izmišljaj — ako nečega nema, vrati prazno.
Odgovori ISKLJUČIVO JSON-om:
{"taskIds":["TASK-123"],"projectIds":["PRJ-030"],"agents":["jelena"],"tier":"E1|E2|E3|E4|E5|null"}`

export function parseExtractedRefs(raw: any): ExtractedRefs | null {
  if (!raw || typeof raw !== 'object') return null
  const arr = (v: any, re: RegExp) => (Array.isArray(v) ? v : []).map(String).map(s => s.trim().toUpperCase()).filter(s => re.test(s))
  const tier = String(raw.tier ?? '').toUpperCase().trim()
  return {
    taskIds: [...new Set(arr(raw.taskIds, /^TASK-\d+$/))],
    projectIds: [...new Set(arr(raw.projectIds, /^PRJ-\d+$/))],
    agents: [...new Set((Array.isArray(raw.agents) ? raw.agents : []).map(String).map((s: string) => s.toLowerCase().trim()).filter((s: string) => VALID_AGENTS.includes(s)))],
    tier: VALID_TIERS.includes(tier as EffortTier) ? (tier as EffortTier) : null,
  }
}

export async function extractRefs(content: string): Promise<OffloadResult<ExtractedRefs>> {
  return run<ExtractedRefs>({
    job: 'extractRefs',
    input: content,
    fallback: extractRefsFallback(content),
    system: EXTRACT_SYSTEM,
    user: content.slice(0, 6000),
    parse: parseExtractedRefs,
    equals: (a, b) => a.taskIds.join(',') === b.taskIds.join(',') && a.projectIds.join(',') === b.projectIds.join(','),
  })
}

// ─── 3. Sažimanje rezultata za Telegram ──────────────────────────────────────

export const TELEGRAM_SUMMARY_LIMIT = 200

/** Rez na granici rečenice, pa riječi; bez modela i bez mreže. */
export function summarizeFallback(text: string, limit = TELEGRAM_SUMMARY_LIMIT): string {
  const t = (text || '').replace(/\s+/g, ' ').trim()
  if (t.length <= limit) return t
  const cut = t.slice(0, limit)
  const sentence = cut.lastIndexOf('. ')
  if (sentence > limit * 0.5) return cut.slice(0, sentence + 1)
  // Trotočje je znak kao i svaki drugi — rez mora ostaviti mjesta za njega,
  // inače rezultat izađe za jedan znak preko granice (mjereno: 101 na limitu 100).
  const room = t.slice(0, Math.max(1, limit - 1))
  const word = room.lastIndexOf(' ')
  return (word > 0 ? room.slice(0, word) : room).trimEnd() + '…'
}

const SUMMARY_SYSTEM = `Sažmi rezultat rada u JEDNU rečenicu na hrvatskom, najviše ${TELEGRAM_SUMMARY_LIMIT} znakova.
Zadrži brojeve, statuse i ID-eve (TASK-…, PRJ-…). Bez uvoda, bez emojija, bez markdowna.
Odgovori ISKLJUČIVO JSON-om: {"summary":"…"}`

export async function summarizeForTelegram(text: string, limit = TELEGRAM_SUMMARY_LIMIT): Promise<OffloadResult<string>> {
  return run<string>({
    job: 'summarize',
    input: text,
    fallback: summarizeFallback(text, limit),
    system: SUMMARY_SYSTEM,
    user: (text || '').slice(0, 6000),
    parse: (raw: any) => {
      const s = String(raw?.summary ?? '').replace(/\s+/g, ' ').trim()
      if (!s) return null
      return s.length > limit ? summarizeFallback(s, limit) : s
    },
    equals: (a, b) => a === b,
  })
}

// ─── 4. Dedup / „recikliran izvještaj?" — SAMO SAVJET ────────────────────────

/**
 * Blokada dispatcha je sigurnosna odluka i ostaje na determinističkom
 * `DispatchGuard.isRecycledAgentReport` (≥3 format-markera). Ollama ovdje NIKAD
 * ne odlučuje: `advisoryOnly` znači da ni s upaljenim LIVE flagom njezin odgovor
 * ne postaje `value`. Njena je jedina uloga popuniti `ollama` polje u zapisu, da
 * se vidi hvata li recikliranje koje regex propušta (npr. izvještaj bez emojija).
 */
const RECYCLED_SYSTEM = `Je li ovaj tekst GOTOV IZVJEŠTAJ o već obavljenom poslu (sažetak, rezultati,
status, sljedeći koraci) ili SISTEMSKA OBAVIJEST — umjesto specifikacije NOVOG posla?
Odgovori ISKLJUČIVO JSON-om: {"recycled":true|false}`

export async function recycledReport(content: string): Promise<OffloadResult<boolean>> {
  return run<boolean>({
    job: 'recycledReport',
    input: content,
    fallback: isRecycledAgentReport(content),
    system: RECYCLED_SYSTEM,
    user: (content || '').slice(0, 6000),
    parse: (raw: any) => (typeof raw?.recycled === 'boolean' ? raw.recycled : null),
    equals: (a, b) => a === b,
    advisoryOnly: true,
  })
}

// ─── 5. Heartbeat brief ──────────────────────────────────────────────────────

export const HEARTBEAT_BRIEF_LIMIT = 100

export function heartbeatBriefFallback(text: string, limit = HEARTBEAT_BRIEF_LIMIT): string {
  return summarizeFallback(text, limit)
}

const BRIEF_SYSTEM = `Napiši gdje je agent stao, na hrvatskom, najviše ${HEARTBEAT_BRIEF_LIMIT} znakova.
Samo činjenica o napretku, bez uvoda i emojija. Odgovori ISKLJUČIVO JSON-om: {"brief":"…"}`

export async function heartbeatBrief(text: string, limit = HEARTBEAT_BRIEF_LIMIT): Promise<OffloadResult<string>> {
  return run<string>({
    job: 'heartbeatBrief',
    input: text,
    fallback: heartbeatBriefFallback(text, limit),
    system: BRIEF_SYSTEM,
    user: (text || '').slice(0, 4000),
    parse: (raw: any) => {
      const s = String(raw?.brief ?? '').replace(/\s+/g, ' ').trim()
      if (!s) return null
      return s.length > limit ? summarizeFallback(s, limit) : s
    },
    equals: (a, b) => a === b,
  })
}
