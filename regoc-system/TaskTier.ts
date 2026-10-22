/**
 * TaskTier.ts — tier modela po ZADATKU umjesto po agentu (A6 / TASK-3005)
 *
 * PROBLEM: `resolveSpawnModel` (RegocDaemon.ts) veže model uz AGENTA
 * (`REGOC_AGENTS.json` → `model`, uz `agentOverrides` iz `model-config.json`).
 * Jelena time vozi Opus i za izmjenu jednog retka i za arhitektonski zahvat.
 * Mjereno u `cost_log` 29.07.: 26 Opus runova = 106,88 USD (prosjek 4,11 USD),
 * najskuplji pojedinačni run 7,13 USD.
 *
 * OVAJ MODUL je čista logika (bez I/O, bez importa daemona) koja od činjenica o
 * zadatku donosi odluku KOJI TIER pokrenuti. RegocDaemon radi samo I/O oko toga.
 * Odvojen je iz istog razloga kao `AutonomyQueue.ts` / `ZombieRecovery.ts`:
 * `RegocDaemon.ts` nema `import.meta.main` gate, pa bi ga import u testu pokrenuo.
 *
 * ── TRI PRAVILA KOJA DRŽE CIJELU ODLUKU ────────────────────────────────────────
 *
 * 1. SAMO NADOLJE. Heuristika smije predložiti model JEFTINIJI ili JEDNAK
 *    agentovom zadanom — nikad skuplji. Rizik je asimetričan: promašen downgrade
 *    košta jedan ponovni pokušaj, promašen upgrade košta novac bez gornje granice.
 *    Posljedica: sustav po pokušaju NIKAD ne troši više nego danas.
 *
 * 2. NEODLUČENO = DANAŠNJE PONAŠANJE. Bez pozitivnog dokaza da je posao lagan,
 *    odluka je `agent-default` — bitno identično stanju prije ovog modula.
 *
 * 3. NADOGORE SAMO NA DOKAZ. Tier se diže isključivo eskalacijom (prethodni
 *    pokušaj na slabijem modelu nije isporučio) ili izričitom oznakom na zadatku,
 *    i to najviše do agentovog zadanog tiera. Nagađanje ne diže trošak.
 *
 * ── ZAŠTO HEURISTIKA, A NE LLM-KLASIFIKATOR ───────────────────────────────────
 *
 * Jer je to kod nas već mjereno i palo: `ModeClassifier` kao vrata na vrućem putu
 * krivo je skrenuo 92 % prometa (replay 3370 poruka, TASK-2559, docs/TASK-2559_modeClassify.md),
 * a svaka klasifikacija je i sama bila `claude --print` spawn — plaćaš model da bi
 * odlučio koji model platiti. Deterministička heuristika je besplatna, ponovljiva
 * i testabilna; kad promaši, promašaj hvata eskalacija (§ shouldEscalate).
 *
 * ── EKONOMIJA (zašto je prag baš tu gdje je) ──────────────────────────────────
 *
 * Anthropic tarife skaliraju PROPORCIONALNO po svim osima (ulaz/izlaz/cache
 * read/write), pa je omjer cijene tierova neovisan o sastavu tokena:
 *   haiku = 0,2 × opus | sonnet = 0,6 × opus | fable = 2,0 × opus
 * Uz trošak jeftinog pokušaja C, skupog S i vjerojatnost promašaja p:
 *   downgrade se isplati  ⟺  C + p·S < S  ⟺  p < 1 − C/S
 * Odatle `breakEvenFailureRate`: opus→haiku 0,80; opus→sonnet 0,40; sonnet→haiku 0,67.
 * Prag je GORNJA granica, ne cilj: neuspjeli pokušaj troši i kvotu sesije (vrata
 * autonomije na 70 %) i zidni sat, a to se u USD-u ne vidi. Zato radna preporuka
 * traži rezervu (v. `SAFETY_MARGIN`).
 *
 * VAŽNO — `fable` je SKUPLJI od `opus` (10/50 vs 5/25 USD po Mtok), nije "još jedan
 * jeftini tier". U ljestvici stoji iznad opusa i dostupan je samo izričitom oznakom.
 */

/** Tierovi poredani od najjeftinijeg prema najskupljem. Redoslijed je nosiv (v. `tierRank`). */
export const TIER_ORDER = ['haiku', 'sonnet', 'opus', 'fable'] as const
export type ModelTier = (typeof TIER_ORDER)[number]

/**
 * Relativni trošak prema opusu (=1). Točan, ne procijenjen: tarife svih tierova
 * dijele isti množitelj na svakoj osi, pa omjer ne ovisi o omjeru ulaz/izlaz/cache.
 */
export const TIER_COST_FACTOR: Readonly<Record<ModelTier, number>> = {
  haiku: 0.2,
  sonnet: 0.6,
  opus: 1.0,
  fable: 2.0,
}

/**
 * `--model` vrijednost za `claude --print`. Aliasi (`opus`/`sonnet`/`haiku`) prate
 * generaciju sami; `fable` nema alias pa ide punim ID-em.
 */
export const TIER_MODEL_ARG: Readonly<Record<ModelTier, string>> = {
  haiku: 'haiku',
  sonnet: 'sonnet',
  opus: 'opus',
  fable: 'claude-fable-5',
}

/** Rezerva na teorijski prag: neuspjeli pokušaj troši i kvotu sesije i vrijeme, ne samo USD. */
export const SAFETY_MARGIN = 0.5

/** Oznaka koja zaključava zadatak na agentov zadani model (isključuje heuristiku). */
export const PIN_TAG = 'no-downgrade'

export interface TierDecision {
  /** Odabrani tier. */
  tier: ModelTier
  /** `--model` vrijednost za spawn. */
  model: string
  /** Tko je odlučio — ide u log i u izvještaj. */
  source: 'explicit-tag' | 'escalation' | 'heuristic' | 'agent-default' | 'non-anthropic'
  /** Ljudsko obrazloženje (jedna rečenica), za log i `tier_decisions.jsonl`. */
  reason: string
  /** Agentov zadani tier — referenca prema kojoj se mjeri ušteda. */
  baseline: ModelTier
  /** Koliko puta jeftinije od baseline-a (1 = bez promjene, <1 = ušteda). */
  costFactor: number
}

export interface TierInput {
  title?: string | null
  description?: string | null
  tags?: unknown
  /** `model` iz REGOC_AGENTS.json / agentOverrides — referentna točka i STROP. */
  agentDefaultModel?: string | null
  /** Provider iz `resolveSpawnModel`; sve osim 'anthropic' se ne dira. */
  provider?: string | null
  /**
   * Modeli koji su za OVAJ zadatak već pokrenuti i nisu isporučili
   * (iz `cost_log` / `tier_decisions.jsonl`). Podiže tier — do baseline-a.
   */
  attemptedModels?: string[] | null
}

// ============================================
// Ljestvica
// ============================================

export function tierRank(tier: ModelTier): number {
  return TIER_ORDER.indexOf(tier)
}

/**
 * Model → tier. Radi i s aliasom (`opus`), i s punim ID-em (`claude-opus-5`), i s
 * datiranim (`claude-haiku-4-5-20251001`) — upravo tri oblika koja stoje u `cost_log`.
 * Nepoznat model → null (ne pogađamo; pozivatelj pada na siguran default).
 */
export function tierOfModel(model: string | null | undefined): ModelTier | null {
  const m = (model || '').toLowerCase()
  if (!m) return null
  // Redoslijed provjera je bitan samo utoliko što se nazivi ne preklapaju.
  if (m.includes('fable') || m.includes('mythos')) return 'fable'
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return null
}

/** Prag ispod kojeg se downgrade s `from` na `to` isplati (p* = 1 − C/S). */
export function breakEvenFailureRate(from: ModelTier, to: ModelTier): number {
  const s = TIER_COST_FACTOR[from]
  const c = TIER_COST_FACTOR[to]
  if (c >= s) return 0   // isti ili skuplji model se kao "ušteda" nikad ne isplati
  return 1 - c / s
}

/** Radna preporuka: prag umanjen za rezervu (kvota sesije + zidni sat nisu u USD-u). */
export function recommendedFailureCeiling(from: ModelTier, to: ModelTier): number {
  return breakEvenFailureRate(from, to) * SAFETY_MARGIN
}

// ============================================
// Oznake na zadatku
// ============================================

function normalizeTags(tags: unknown): string[] {
  // Tags stižu i kao polje (API) i kao JSON-string (izravno iz SQLite retka).
  let arr: unknown = tags
  if (typeof tags === 'string') {
    try { arr = JSON.parse(tags) } catch { arr = tags.split(',') }
  }
  if (!Array.isArray(arr)) return []
  return arr.map(t => String(t).trim().toLowerCase()).filter(Boolean)
}

/** `tier:opus` / `model:haiku` na zadatku → izričit tier. Nepoznat naziv se ignorira. */
export function explicitTier(tags: unknown): ModelTier | null {
  for (const tag of normalizeTags(tags)) {
    const m = tag.match(/^(?:tier|model):(.+)$/)
    if (!m) continue
    const t = tierOfModel(m[1])
    if (t) return t
  }
  return null
}

export function isPinned(tags: unknown): boolean {
  return normalizeTags(tags).includes(PIN_TAG)
}

// ============================================
// Heuristika
// ============================================

/**
 * Markeri težine. Bilo koji pogodak isključuje downgrade — namjerno široko
 * postavljeno, jer je cijena lažnog "težak" (nula, ostaje kao danas) puno manja
 * od cijene lažnog "lagan" (posao se radi dvaput).
 */
const HEAVY_MARKERS = [
  // arhitektura i dizajn
  'arhitekt', 'dizajniraj', 'projektiraj', 'adr', 'specifikacij', 'design', 'architecture',
  // sigurnost i revizija
  'sigurnosn', 'security', 'audit', 'revizij', 'pentest', 'threat',
  // veliki zahvati
  'refaktor', 'refactor', 'migracij', 'migrate', 'redizajn', 'od nule', 'from scratch',
  'cijeli sustav', 'kompletn', 'overhaul',
  // istraživanje i dijagnostika
  'istraž', 'istraz', 'analizir', 'analiza', 'research', 'debug', 'dijagnos',
  'root cause', 'uzrok', 'zašto', 'zasto', 'reproduc',
  // procesna težina
  'dod', 'definition of done', 'kriterij prihvat', 'epic', 'plan rada', 'orkestr',
]

/**
 * Markeri trivijalnosti. Traži se BAREM JEDAN, uz odsutnost svih teških markera.
 *
 * Sve su GLAGOLSKE FRAZE, nikad puke imenice. Prva verzija je imala i `format`, `popis`
 * i `list ` — backtest preko `cost_log` odmah ih je uhvatio kao lažno pozitivne
 * (TASK-2988 „…usporedbu run_log.jsonl…" proglašen trivijalnim jer opis spominje format).
 * Imenica opisuje TEMU, glagolska fraza opisuje POTEZ; samo drugo govori o težini.
 *
 * TRAŽE SE SAMO U NASLOVU (v. `classifyTaskTier`). Backtest preko 775 stvarnih zadataka:
 * sa skeniranjem opisa heuristika je pogodila 3 zadatka i sva 3 bila su lažno pozitivna —
 * „Loaded panels rename" u opisu featurea (TASK-349), „Rename" kao stavka izbornika u
 * specifikaciji galerije (TASK-515), „Bump verzije" preko šest datoteka (TASK-2597).
 * Opis nabraja ŠTO SVE posao dodiruje; naslov kaže ŠTO POSAO JEST.
 */
const LIGHT_MARKERS = [
  'tipfeler', 'typo', 'pravopis', 'preimenuj', 'rename',
  'dodaj redak', 'dodaj liniju', 'promijeni tekst', 'promjeni tekst',
  'ispravi naziv', 'ispravi tekst', 'uskladi naziv',
  'obriši datoteku', 'obrisi datoteku', 'formatiraj',
  'dodaj komentar', 'dopuni opis', 'dopiši opis', 'dopisi opis',
  'izlistaj', 'provjeri status', 'javi status',
  'bump verzij', 'podigni verzij', 'version bump',
]

/** Iznad ovoga opis više nije "jedan potez" — specifikacija te duljine nosi zahvat. */
export const LIGHT_DESCRIPTION_MAX_CHARS = 600

/**
 * Najveća težina iz ulaza (`tezina:NN`) koja smije na sonnet — gornja granica E2 u
 * `WeightScore` (E2 16–35). Ispod praga B ulaz ionako šalje posao jednom izvršitelju.
 */
export const ULAZ_LAKA_TEZINA_MAX = 35

/** Oznaka zadatka iz `POST /api/ingest` (TaskManagerAI `Ingest.ts`). */
const ULAZ_TAG = 'ulaz'
const ZAHTJEV_POCETAK = /^## Zahtjev korisnika[^\n]*\n/m
const ZAHTJEV_KRAJ = /\n## Koraci\b/

/**
 * Samo zahtjev korisnika iz opisa zadatka iz ulaza: odjeljak „## Zahtjev korisnika" do
 * „## Koraci". Opis bez tog okvira (ručni zadatak, prilagođen predložak) vraća se cijeli.
 */
export function zahtjevKorisnika(description: string | null | undefined): string {
  const d = String(description || '')
  const p = d.match(ZAHTJEV_POCETAK)
  if (!p || p.index === undefined) return d
  const ostatak = d.slice(p.index + p[0].length)
  const k = ostatak.search(ZAHTJEV_KRAJ)
  return k < 0 ? d : ostatak.slice(0, k).trim()
}

/**
 * Težina koju je ulaz izmjerio nad SAMIM zahtjevom. Uzima se samo uz oznaku `ulaz` —
 * `tezina:` s drugih mjesta može biti izmjerena nad cijelim opisom.
 */
function tezinaIzUlaza(tags: unknown): number | null {
  const t = normalizeTags(tags)
  if (!t.includes(ULAZ_TAG)) return null
  for (const x of t) {
    const m = x.match(/^tezina:(\d{1,3})$/)
    if (m) { const n = Number(m[1]); if (n >= 1 && n <= 100) return n }
  }
  return null
}

export interface HeuristicVerdict {
  /** Predloženi tier ILI null = nema dokaza, ne diraj. */
  tier: ModelTier | null
  reason: string
  heavyHits: string[]
  lightHits: string[]
}

/**
 * Deterministička procjena težine. Vraća SAMO 'sonnet' kao downgrade — nikad haiku.
 *
 * Zašto ne haiku iz heuristike: haiku je 5× jeftiniji, ali je i jedini tier za koji
 * kod nas NEMA dokaza da nosi agentski posao s alatima; jedini zabilježeni haiku-lanac
 * u `cost_log` (TASK-2988: haiku → haiku → sonnet) izgleda upravo kao dva promašaja
 * pa eskalacija. Haiku ostaje dostupan, ali samo na izričitu oznaku `tier:haiku`,
 * gdje odluku nosi čovjek koji zna zadatak.
 */
export function classifyTaskTier(input: TierInput): HeuristicVerdict {
  const title = String(input.title || '')
  // TASK-5367: zadatak iz ulaza nosi predložak koraka (arhitekt/ADR/specifikacija…) — sudi zahtjev, ne predložak.
  const description = zahtjevKorisnika(input.description)
  // Asimetrično po namjeri: težinu tražimo SVUDA (jeftino je pogriješiti u smjeru
  // „ostavi skuplji model"), trivijalnost SAMO U NASLOVU (skupo je pogriješiti u smjeru
  // „spusti model" — v. komentar uz LIGHT_MARKERS i backtest nad 775 zadataka).
  const text = `${title}\n${description}`.toLowerCase()
  const titleText = title.toLowerCase()

  const heavyHits = HEAVY_MARKERS.filter(m => text.includes(m))
  if (heavyHits.length > 0) {
    return { tier: null, reason: `markeri težine (${heavyHits.slice(0, 3).join(', ')})`, heavyHits, lightHits: [] }
  }

  if (description.length > LIGHT_DESCRIPTION_MAX_CHARS) {
    return {
      tier: null,
      reason: `opis ${description.length} znakova (> ${LIGHT_DESCRIPTION_MAX_CHARS}) — nije jedan potez`,
      heavyHits, lightHits: [],
    }
  }

  const tezina = tezinaIzUlaza(input.tags)
  if (tezina !== null && tezina <= ULAZ_LAKA_TEZINA_MAX) {
    return {
      tier: 'sonnet',
      reason: `težina iz ulaza tezina:${tezina} ≤ ${ULAZ_LAKA_TEZINA_MAX} (E1/E2), zahtjev bez markera težine`,
      heavyHits, lightHits: [],
    }
  }

  const lightHits = LIGHT_MARKERS.filter(m => titleText.includes(m))
  if (lightHits.length === 0) {
    return { tier: null, reason: 'nema dokaza trivijalnosti u naslovu — ostaje agentov model', heavyHits, lightHits }
  }

  return {
    tier: 'sonnet',
    reason: `trivijalan zahvat u naslovu (${lightHits.slice(0, 3).join(', ')}), opis ${description.length} znakova`,
    heavyHits, lightHits,
  }
}

// ============================================
// Odluka
// ============================================

/**
 * Puna odluka o tieru za jedan spawn.
 *
 * Redoslijed (prvi koji odgovori pobjeđuje):
 *   1. ne-Anthropic provider → ne diramo (agentOverrides nose RUTANJE, ne snagu)
 *   2. `tier:*` oznaka na zadatku → čovjekova riječ, jedini put iznad baseline-a
 *   3. `no-downgrade` oznaka → baseline
 *   4. eskalacija (prethodni pokušaj nije isporučio) → tier iznad zadnjeg, do baseline-a
 *   5. heuristika, ako predlaže JEFTINIJE od baseline-a
 *   6. inače baseline
 *
 * NAPOMENA o prednosti: `ModelRouter.resolve()` daje prednost `agentOverrides` PRIJE
 * tiera. Ovdje je namjerno obrnuto za snagu modela, ali NE i za providera: ako
 * `agentOverrides` rutira agenta na ollama/kimi/glm, tier se ne primjenjuje. Inače bi
 * "ušteda" gitu i potjeha prebacila s lokalnog qwena na plaćeni Anthropic — trošak,
 * ne ušteda.
 */
export function resolveTaskTier(input: TierInput): TierDecision {
  const baseline = tierOfModel(input.agentDefaultModel) ?? 'sonnet'
  /** Agentov model doslovno — pin s generacijom i prozorom, npr. 'claude-opus-4-6[1m]'. */
  const agentov = typeof input.agentDefaultModel === 'string' ? input.agentDefaultModel.trim() : ''
  const mk = (tier: ModelTier, source: TierDecision['source'], reason: string): TierDecision => ({
    tier,
    /*
     * TASK-4894: kad tier ISPADNE JEDNAK baseline-u, odluka glasi „ne mijenjaj agentov
     * model" — pa se vraća doslovno on, a ne plivajući alias tog tiera. Alias ('opus')
     * CLI razrješava na najnoviju generaciju, pa je svaka takva ne-odluka tiho brisala
     * pin iz `agentOverrides`. Mjereno 16.09.2026. u 09:07:10: pin `claude-opus-4-6[1m]`
     * pročitan ispravno, a spawn otišao s `--model opus`.
     *
     * Kod STVARNOG downgradea (heuristika) i kod izričite oznake iznad baseline-a alias
     * ostaje: ondje agentov model namjerno nije mjerodavan.
     */
    model: tier === baseline && agentov ? agentov : TIER_MODEL_ARG[tier],
    source,
    reason,
    baseline,
    costFactor: TIER_COST_FACTOR[tier] / TIER_COST_FACTOR[baseline],
  })

  const provider = (input.provider || 'anthropic').toLowerCase()
  if (provider !== 'anthropic') {
    return {
      ...mk(baseline, 'non-anthropic', `provider '${provider}' nosi rutanje, ne snagu — tier se ne primjenjuje`),
      model: String(input.agentDefaultModel || TIER_MODEL_ARG[baseline]),
    }
  }

  const explicit = explicitTier(input.tags)
  if (explicit) {
    return mk(explicit, 'explicit-tag', `oznaka tier:${explicit} na zadatku`)
  }

  if (isPinned(input.tags)) {
    return mk(baseline, 'agent-default', `oznaka ${PIN_TAG} — zaključano na agentov model`)
  }

  const esc = escalatedTier(input.attemptedModels, baseline)
  if (esc) {
    return mk(esc.tier, 'escalation', esc.reason)
  }

  const verdict = classifyTaskTier(input)
  if (verdict.tier && tierRank(verdict.tier) < tierRank(baseline)) {
    return mk(verdict.tier, 'heuristic', verdict.reason)
  }

  return mk(baseline, 'agent-default', verdict.tier ? 'heuristika ne predlaže ništa jeftinije' : verdict.reason)
}

/**
 * Tier nakon neuspjelih pokušaja: jedan stepenik iznad najjačeg već pokušanog,
 * ograničen baseline-om. Vraća null kad nema pokušaja ili je već na stropu.
 *
 * Strop je namjerno baseline, a ne 'fable': eskalacija ISPRAVLJA prejeftinu procjenu,
 * ne kupuje jači model nego što bi zadatak dobio bez ovog modula. Time je najgori
 * ishod "jeftin pokušaj + današnji pokušaj", nikad "dva skupa pokušaja".
 */
export function escalatedTier(
  attemptedModels: string[] | null | undefined,
  baseline: ModelTier,
): { tier: ModelTier; reason: string } | null {
  const tiers = (attemptedModels || [])
    .map(tierOfModel)
    .filter((t): t is ModelTier => t !== null)
  if (tiers.length === 0) return null

  const highest = tiers.reduce((a, b) => (tierRank(a) >= tierRank(b) ? a : b))
  if (tierRank(highest) >= tierRank(baseline)) return null

  const next = TIER_ORDER[Math.min(tierRank(highest) + 1, tierRank(baseline))]
  return {
    tier: next,
    reason: `eskalacija: ${tiers.length} pokušaj(a) do '${highest}' bez isporuke → ${next} (strop = agentov ${baseline})`,
  }
}

/** Redak `data/run_log.jsonl` — sve što treba za sud o prošlom pokušaju. */
export interface AttemptRecord {
  task_id?: string | null
  model?: string | null
  outcome?: string | null
  num_turns?: number | null
}

/**
 * Je li JEDAN prošli run dokaz da model nije bio dorastao poslu?
 *
 * `completed` očito nije. `blocked` uz `num_turns === 0` TAKOĐER nije: to je potpis
 * hook-blokade (spawn je izašao s 0 a da model nije napravio nijedan korak — v.
 * `HookBlockGuard.classifySpawnOutcome` i memoriju o exit-0 blokadama). Eskalirati na
 * jači model zbog blokade na ULAZU značilo bi platiti skuplji model za posao koji
 * nikad nije ni počeo.
 */
export function isModelFailure(entry: AttemptRecord): boolean {
  const outcome = entry.outcome || ''
  if (outcome !== 'blocked' && outcome !== 'failed') return false
  if (outcome === 'blocked' && entry.num_turns === 0) return false
  return true
}

/** Modeli koji su za zadatak već pokušani i nisu isporučili — ulaz u `escalatedTier`. */
export function failedAttemptModels(entries: AttemptRecord[], taskId: string): string[] {
  return entries
    .filter(e => e && String(e.task_id || '') === taskId && isModelFailure(e))
    .map(e => String(e.model || ''))
    .filter(Boolean)
}

/**
 * Je li ishod spawna razlog za eskalaciju sljedećeg pokušaja?
 * Eskalira se samo ono što je stvarno kvar modela (v. `isModelFailure`) i samo kad je
 * run bio na jeftinijem modelu od agentovog — run na agentovom modelu nema kamo gore.
 */
export function shouldEscalate(
  entry: AttemptRecord,
  decision: Pick<TierDecision, 'tier' | 'baseline'>,
): boolean {
  if (!isModelFailure(entry)) return false
  return tierRank(decision.tier) < tierRank(decision.baseline)
}

// ============================================
// Izvještaj / mjerenje
// ============================================

export interface TierLedgerRow {
  taskId: string | null
  tier: ModelTier
  baseline: ModelTier
  source: TierDecision['source']
  costUsd: number
  outcome: string
}

export interface TierSavings {
  runs: number
  downgradedRuns: number
  /** Stvarno potrošeno (USD) na runovima s downgradeom. */
  actualUsd: number
  /** Što bi ti isti runovi stajali na agentovom zadanom tieru. */
  counterfactualUsd: number
  /** Ušteda prije troška ponovnih pokušaja. */
  grossSavingUsd: number
  /** Trošak eskalacija: cijeli iznos jeftinog runa koji nije isporučio je bačen. */
  wastedUsd: number
  /** Neto = bruto − bačeno. Negativan broj znači da downgrade gubi novac. */
  netSavingUsd: number
  /** Udio downgrade-runova koji nisu isporučili (izmjereni p iz jednadžbe iznad). */
  observedFailureRate: number
}

/**
 * Mjerenje po istoj jednadžbi po kojoj je odluka i donesena — bez toga je "ušteda"
 * tvrdnja, ne broj. `counterfactual` se računa iz omjera tarifa (točan, v. gore),
 * a ne iz pretpostavke da bi skuplji model potrošio jednako tokena; ta pretpostavka
 * je konzervativna u korist SKUPLJEG modela (jači model tipično troši manje krugova),
 * pa prijavljena ušteda radije podcjenjuje nego precjenjuje.
 */
export function summarizeSavings(rows: TierLedgerRow[]): TierSavings {
  const downgraded = rows.filter(r => tierRank(r.tier) < tierRank(r.baseline))
  const failed = downgraded.filter(r => r.outcome === 'blocked' || r.outcome === 'failed')

  let actual = 0
  let counterfactual = 0
  for (const r of downgraded) {
    actual += r.costUsd
    const factor = TIER_COST_FACTOR[r.baseline] / TIER_COST_FACTOR[r.tier]
    counterfactual += r.costUsd * factor
  }
  const wasted = failed.reduce((s, r) => s + r.costUsd, 0)
  const gross = counterfactual - actual

  return {
    runs: rows.length,
    downgradedRuns: downgraded.length,
    actualUsd: round4(actual),
    counterfactualUsd: round4(counterfactual),
    grossSavingUsd: round4(gross),
    wastedUsd: round4(wasted),
    netSavingUsd: round4(gross - wasted),
    observedFailureRate: downgraded.length ? failed.length / downgraded.length : 0,
  }
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4
}

/** Jedan redak za log daemona — kratak, jer se ispisuje pri svakom spawnu. */
export function formatDecisionLog(taskId: string | null, agentId: string, d: TierDecision): string {
  const same = d.tier === d.baseline
  const arrow = same ? `${d.baseline}` : `${d.baseline} → ${d.tier}`
  const save = same ? '' : ` (${Math.round((1 - d.costFactor) * 100)}% jeftinije)`
  return `[TIER] ${taskId || 'bez-zadatka'} ${agentId}: ${arrow}${save} — ${d.source}: ${d.reason}`
}
