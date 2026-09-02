/**
 * CompletionGuard — tvrdo pravilo za zatvaranje zadatka (TASK-2954 / nalaz D2).
 *
 * PROBLEM (dokazano iz žive baze):
 *   TASK-329  result_summary = "Nema zadane test description, ne mogu pokrenuti test
 *             bez detalja."                                        → status `completed`
 *   TASK-330  "Nemam pristup alatima (Bash, datotekama, MCP-u) ... pa ne mogu stvoriti
 *             rezultate."                                          → status `completed`
 *   TASK-338  "Zadatak je gotov."  (to je CIJELI rezultat)         → status `completed`
 *
 *   Agent doslovno kaže da posao NIJE napravljen, a ploča pokazuje ✅. To je najgori
 *   mogući ishod: laž na ploči je skuplja od vidljivo nezavršenog zadatka.
 *
 * UZROK: nitko nije gledao SADRŽAJ rezultata.
 *   - RegocDaemon (CLI spawn):  `exitCode === 0` ⇒ completed. Ali agent koji kaže
 *     "ne mogu" uredno izlazi s 0.
 *   - RegocDaemon (Ollama/API spawn): system prompt EKSPLICITNO traži od modela da
 *     kaže da bez alata ne može — i taj se tekst onda sprema kao dokaz uspjeha.
 *   - TaskWebUI PUT /api/tasks/:id: nikakva validacija `result_summary`.
 *
 * RJEŠENJE: čist, bez nuspojava, jedinično testabilan sud o tekstu rezultata.
 * Wiring (jedan ulaz po sloju):
 *   - TaskWebUI.handleUpdateTask  → PUT status=completed s praznim/trivijalnim/
 *     poraznim rezultatom vraća HTTP 400 (osim uz eksplicitni `force`).
 *   - RegocDaemon (oba spawn puta) → umjesto `completed` postavlja `blocked` s
 *     blocked_reason prefiksiranim NEEDS_CONTEXT: / BLOCKED:.
 *
 * DIZAJN-ODLUKA (zašto `blocked`, a ne novi status NEEDS_CONTEXT):
 *   Shema (tasks.status) i ValidStatusTransitions poznaju 5 statusa; uvođenje šestog
 *   traži migraciju baze, izmjenu UI kolona, watchdoga i reapera — nesrazmjeran rizik
 *   na živoj ploči. `blocked` već znači "nije gotovo, treba intervencija", pa razliku
 *   nosi PREFIKS u blocked_reason, koji je i strojno čitljiv i vidljiv čovjeku:
 *     NEEDS_CONTEXT: ...  → fali opis/kontekst/specifikacija (popravlja se boljim taskom)
 *     BLOCKED: ...        → fali sposobnost/alat/pristup (popravlja se drugim runnerom)
 */

// ─── Pragovi (izvezeni: testovi i pozivatelji ne smiju pogađati brojeve) ──────

/** Ispod ovoliko znakova rezultat ne može biti smislen dokaz izvršenja. */
export const MIN_MEANINGFUL_LENGTH = 40

/**
 * Koliko RAZLIČITIH vrsta dokaza mora postojati da spomen ograničenja
 * ("nisam mogao pristupiti X, ali sam napravio Y") NE blokira zatvaranje.
 * Bez ovoga bi svaki pošten izvještaj koji navodi ijedno ograničenje pao.
 */
export const EVIDENCE_OVERRIDE_THRESHOLD = 2

/**
 * Do ove duljine tekst BEZ ijednog dokaznog markera tretiramo kao neutemeljenu
 * tvrdnju uspjeha. Duži elaborat (analiza, dizajn-dokument) propuštamo — takav
 * sadržaj ionako nije obrazac "prazna potvrda", a lažni pozitiv ovdje košta više.
 */
export const NO_EVIDENCE_MAX_LENGTH = 1200

// ─── Obrasci ─────────────────────────────────────────────────────────────────

/**
 * Cijeli rezultat je gola potvrda bez sadržaja. Namjerno se testira nad CIJELIM
 * tekstom (anchored) — "Gotovo." kao rezultat je laž, "Gotovo je." usred izvještaja nije.
 */
const TRIVIAL_ONLY: RegExp[] = [
  /^(zadatak|task|posao)?\s*(je|is)?\s*(gotov|gotova|gotovo|zavr[šs]en[oa]?|dovr[šs]en[oa]?|rije[šs]en[oa]?|napravljen[oa]?|izvr[šs]en[oa]?|obavljen[oa]?|done|finished|complete[d]?|ok|okej|u\s+redu)\s*[.!…]*$/iu,
  /^(uspje[šs]no|successfully)?\s*(zavr[šs]eno|izvr[šs]eno|napravljeno|obavljeno|done|completed)\s*[.!…]*$/iu,
  /^(sve\s+)?(radi|ok|uredu|u\s+redu|fine|works)\s*[.!…]*$/iu,
  /^(nema\s+(promjena|primjedbi)|no\s+changes?)\s*[.!…]*$/iu,
]

/**
 * Priznanje nemoći zbog NEDOSTATKA KONTEKSTA — zadatak je loše specificiran.
 * Popravak: bolji opis zadatka ⇒ NEEDS_CONTEXT.
 */
const NEEDS_CONTEXT_PATTERNS: RegExp[] = [
  /\bnema\s+(zadan|zadane|zadanog|zadanih)\b/iu,
  /\bnema\s+(dovoljno\s+)?(opisa|konteksta|detalja|specifikacije|informacija)\b/iu,
  /\bnedostaj[ue]\s+(mi\s+)?(opis|kontekst|specifikacija|detalj|informacij|podat)/iu,
  /\bbez\s+(detalja|opisa|konteksta|specifikacije)\b[^.!?]{0,60}\bne\s+mogu\b/iu,
  /\bne\s+mogu\b[^.!?]{0,60}\bbez\s+(detalja|opisa|konteksta|specifikacije)\b/iu,
  /\b(zadatak|task)\s+(je\s+)?(prazan|nejasan|nedefiniran|nespecificiran)\b/iu,
  /\b(insufficient|missing|lack\s+of|no)\s+(context|information|details?|specification)\b/iu,
  /\bneeds?\s+more\s+(context|information|details?)\b/iu,
  /\b(task|description)\s+is\s+(empty|unclear|undefined|missing)\b/iu,
]

/**
 * Priznanje nemoći zbog NEDOSTATKA SPOSOBNOSTI/ALATA — okruženje je krivo.
 * Popravak: drugi runner/model/ovlasti ⇒ BLOCKED.
 * (Ovo je doslovno ono što Ollama system prompt traži od modela da kaže.)
 */
const NO_CAPABILITY_PATTERNS: RegExp[] = [
  /\bnemam\s+(pristup|pristupa|alat|alata|alate|alatima|mogu[ćc]nost|ovlast|dozvol)/iu,
  /\bnemam\s+(pristup|pristupa)\s+(bashu|datotekama|mre[žz]i|repozitoriju|internetu)/iu,
  /\bne\s+mogu\s+(pristupiti|koristiti|pokrenuti)\s+(alat|bash|datotek|mrež|internet|mcp)/iu,
  /\bnije\s+mogu[ćc]e\s+(ovdje|u\s+ovom\s+okru[žz]enju|bez\s+alata)/iu,
  /\bnije\s+mogu[ćc]e\b[^.!?]{0,40}\bbez\s+(pristupa|alata|ovlasti|dozvole)\b/iu,
  /\b(no|without)\s+access\s+to\s+(tools?|bash|the\s+filesystem|files?|the\s+network|mcp)\b/iu,
  /\bI\s+(don'?t|do\s+not)\s+have\s+(access|tools?|the\s+ability)\b/iu,
  /\b(lacking|missing)\s+tool\s+access\b/iu,
]

/**
 * Opće priznanje da posao nije obavljen. Prvo lice + glagol izvršavanja — namjerno
 * NE hvata "korisnici ne mogu otvoriti stranicu" (opis buga, ne priznanje agenta).
 */
const GENERIC_INCAPACITY_PATTERNS: RegExp[] = [
  /\bne\s+mogu\s+(ni[šs]ta\s+)?(izvr[šs]iti|pokrenuti|napraviti|stvoriti|kreirati|dovr[šs]iti|zavr[šs]iti|testirati|provjeriti|verificirati|odraditi|obaviti|nastaviti|isporu[čc]iti)/iu,
  /\bnisam\s+(u\s+mogu[ćc]nosti|bio\s+u\s+mogu[ćc]nosti|mogao|mogla)\b/iu,
  /\bnisam\s+(ni[šs]ta\s+)?(napravio|napravila|izvr[šs]io|izvr[šs]ila|testirao|testirala|dovr[šs]io|dovr[šs]ila)\b/iu,
  /\bzadatak\s+nije\s+(izvr[šs]en|napravljen|dovr[šs]en|obavljen)\b/iu,
  /\bnije\s+mogu[ćc]e\s+(izvr[šs]iti|pokrenuti|napraviti|stvoriti|dovr[šs]iti|zavr[šs]iti|testirati|provjeriti|nastaviti)\b/iu,
  /\bI\s+(cannot|can'?t|could\s+not|couldn'?t|am\s+unable\s+to|was\s+unable\s+to)\s+(run|execute|access|complete|perform|create|proceed|verify|test|do)\b/iu,
  /\bunable\s+to\s+(complete|execute|run|access|perform|proceed|verify)\b/iu,
]

/**
 * Dokazni markeri — svaka STAVKA je jedna VRSTA dokaza; broji se koliko je
 * različitih vrsta prisutno, ne koliko puta se ponavljaju. Namjerno NE brojimo
 * goli `TASK-\d+` jer daemon ubacuje ID zadatka u svaki prompt, pa bi ga i
 * prazna potvrda "prepisala" i lažno stekla dokaz.
 */
const EVIDENCE_MARKERS: Array<{ kind: string; re: RegExp }> = [
  // Apsolutna putanja ili datoteka s poznatom ekstenzijom.
  { kind: 'file', re: /(\/[\w.@-]+){2,}\.\w{1,6}\b|\b[\w.-]+\.(ts|tsx|js|jsx|py|md|json|sh|sql|html|css|yml|yaml|toml|c|h|cpp|rs|go|v|sv)\b/u },
  // Izvršena naredba / alat.
  { kind: 'command', re: /\b(curl|git|bun|npm|npx|pnpm|yarn|python3?|sqlite3?|grep|rg|sed|awk|systemctl|docker|make|pytest|cargo|ssh|scp|kicad-cli|ffmpeg|tailscale)\b/u },
  // Mjereni ishod: X/Y, N testova, postotak, trajanje, veličina.
  { kind: 'measurement', re: /\b\d+\s*\/\s*\d+\b|\b\d+\s*(test|testov|pass|fail|greš|error|redak|redaka|linij|frame|ms\b|sek|s\b|%|MB|KB|GB)/iu },
  // HTTP/exit status.
  { kind: 'status_code', re: /\b(HTTP\s*)?(200|201|204|301|400|401|403|404|409|422|500|502|503)\b|\bexit\s*(code)?\s*\d+\b/iu },
  // Kod: backtick blok, poziv funkcije, referenca na liniju.
  { kind: 'code', re: /`[^`\n]{3,}`|\b\w+\.\w+\(|\b\w+\(\)|:\d{1,5}\b/u },
  // Identifikator artefakta: commit sha, projekt, ADR, PR.
  { kind: 'artifact_id', re: /\b[0-9a-f]{7,40}\b|\bPRJ-\d+\b|\bADR-\d+\b|\b(PR|MR)\s*#?\d+\b/u },
  { kind: 'url', re: /\bhttps?:\/\/\S+/u },
  // Eksplicitna verifikacijska radnja nad nečim.
  { kind: 'verification', re: /\b(verificiran|verificirala|verificirao|testiran|izmjeren|reproduciran|commitan|commitala|deployan|pokrenula|pokrenuo|potvr[đd]en)\w*\b/iu },
]

// ─── Javni tip suda ──────────────────────────────────────────────────────────

export type CompletionCode =
  | 'ok'
  | 'empty_result'
  | 'trivial_result'
  | 'incapacity_admission'
  | 'no_evidence'
  /** Agent je SAM deklarirao neuspjeh kroz REGOC-STATUS redak (nije heuristika). */
  | 'declared_not_done'

/**
 * Koliko je sud pouzdan.
 *   `declared`  — agent je ishod deklarirao strojno čitljivim REGOC-STATUS retkom.
 *                 Ovo je ugovor, ne pogađanje; smije biti jedini osnov odluke.
 *   `heuristic` — nema deklaracije, sudi se po prozi. NISKA pouzdanost: koristi se
 *                 kao fallback i tako se i loga (uvjet iz arhitektonske dorade,
 *                 TASK-2959: „regex nad prozom nikad kao jedini osnov" u live modu).
 */
export type CompletionConfidence = 'declared' | 'heuristic'

/** Oznaka koja ide kao prefiks u blocked_reason (i u telemetriju). */
export type CompletionLabel = 'NEEDS_CONTEXT' | 'BLOCKED'

export interface CompletionVerdict {
  /** Smije li se zadatak zatvoriti kao `completed`. */
  accept: boolean
  code: CompletionCode
  /** Ljudski čitljivo obrazloženje (hrvatski — ide u blocked_reason i u API odgovor). */
  reason: string
  /** NEEDS_CONTEXT (fali specifikacija) ili BLOCKED (fali sposobnost). Prazno kad accept. */
  label: CompletionLabel | null
  /** Status koji pozivatelj treba postaviti umjesto traženog. */
  suggestedStatus: 'completed' | 'blocked'
  /** Gotov, prefiksiran tekst za tasks.blocked_reason. Prazan kad accept. */
  blockedReason: string
  /** Broj RAZLIČITIH vrsta dokaza pronađenih u tekstu. */
  evidence: number
  /** Deklarirani ishod (ugovor) ili heuristika (proza)? */
  confidence: CompletionConfidence
  /** Doslovni isječak koji je okinuo odbijanje (dijagnostika/log). */
  matched?: string
}

/** Strojno čitljiv ishod koji agent MORA ispisati kao zadnji redak odgovora. */
export type DeclaredStatus = 'DONE' | 'BLOCKED' | 'NEEDS_CONTEXT'

/**
 * Obvezni završni redak spawn-protokola (TASK-2959, sloj 2):
 *   `REGOC-STATUS: DONE|BLOCKED|NEEDS_CONTEXT — <razlog>`
 * Prihvaćamo crticu, dvotočje ili ništa kao razdjelnik, s ili bez razmaka.
 */
const DECLARED_STATUS_RE =
  /^[\s>*_#-]*REGOC[-_ ]?STATUS\s*[:=]\s*(DONE|BLOCKED|NEEDS[-_ ]?CONTEXT)\s*(?:[—–\-:]\s*(.*))?$/imu

/**
 * Izvuci deklarirani ishod iz odgovora. Uzima se ZADNJE pojavljivanje — agent može
 * usput citirati protokol, mjerodavna je njegova završna izjava.
 */
export function parseDeclaredStatus(
  text?: string | null,
): { status: DeclaredStatus; reason: string } | null {
  const t = (text ?? '').trim()
  if (!t) return null
  let found: { status: DeclaredStatus; reason: string } | null = null
  for (const line of t.split(/\r?\n/)) {
    const m = line.match(DECLARED_STATUS_RE)
    if (!m) continue
    const status = m[1].toUpperCase().replace(/[-_ ]/g, '_') as DeclaredStatus
    found = { status, reason: (m[2] || '').trim() }
  }
  return found
}

// ─── Detektori (izvezeni radi jediničnog testiranja) ─────────────────────────

/** Cijeli rezultat je gola potvrda bez ijednog konkretnog podatka. */
export function isTrivialResult(text: string): boolean {
  const t = (text || '').trim()
  if (!t) return false
  return TRIVIAL_ONLY.some((re) => re.test(t))
}

/**
 * Vraća { label, matched } za prvo priznanje nemoći, ili null.
 * Redoslijed je namjeran: nedostatak SPOSOBNOSTI je specifičnija dijagnoza od
 * nedostatka KONTEKSTA, pa se provjerava prvi.
 */
export function classifyIncapacity(
  text: string,
): { label: CompletionLabel; matched: string } | null {
  const t = text || ''
  for (const re of NO_CAPABILITY_PATTERNS) {
    const m = t.match(re)
    if (m) return { label: 'BLOCKED', matched: m[0] }
  }
  for (const re of NEEDS_CONTEXT_PATTERNS) {
    const m = t.match(re)
    if (m) return { label: 'NEEDS_CONTEXT', matched: m[0] }
  }
  for (const re of GENERIC_INCAPACITY_PATTERNS) {
    const m = t.match(re)
    if (m) return { label: 'NEEDS_CONTEXT', matched: m[0] }
  }
  return null
}

/** Doslovni isječak priznanja nemoći, ili null. Tanki omotač oko classifyIncapacity. */
export function findIncapacityAdmission(text: string): string | null {
  return classifyIncapacity(text)?.matched ?? null
}

/** Broj RAZLIČITIH vrsta dokaza izvršenja u tekstu. */
export function countEvidenceMarkers(text: string): number {
  const t = text || ''
  if (!t.trim()) return 0
  let kinds = 0
  for (const { re } of EVIDENCE_MARKERS) if (re.test(t)) kinds++
  return kinds
}

// ─── Glavni sud ──────────────────────────────────────────────────────────────

function reject(
  code: CompletionCode,
  label: CompletionLabel,
  reason: string,
  evidence: number,
  matched?: string,
  confidence: CompletionConfidence = 'heuristic',
): CompletionVerdict {
  return {
    accept: false,
    code,
    reason,
    label,
    suggestedStatus: 'blocked',
    blockedReason: `${label}: ${reason}`,
    evidence,
    confidence,
    matched,
  }
}

function accept(evidence: number, confidence: CompletionConfidence): CompletionVerdict {
  return {
    accept: true,
    code: 'ok',
    reason: 'ok',
    label: null,
    suggestedStatus: 'completed',
    blockedReason: '',
    evidence,
    confidence,
  }
}

/**
 * Smije li se zadatak s ovim `result_summary` zatvoriti kao `completed`?
 *
 * Tvrdo pravilo (nalaz D2): odbij ako rezultat NE sadrži dokaz izvršenja ILI
 * sadrži priznanje nemoći. Jedina propusnica za priznanje nemoći su jaki dokazi
 * (≥ EVIDENCE_OVERRIDE_THRESHOLD različitih vrsta) — pošten izvještaj smije reći
 * "ovo jedno nisam mogao" ako je sve ostalo dokazano napravio.
 */
export function evaluateCompletion(resultSummary?: string | null): CompletionVerdict {
  const text = (resultSummary ?? '').trim()

  // ── Prvo ugovor, tek onda heuristika ────────────────────────────────────────
  // Agent koji je SAM deklarirao ishod ne treba pogađanje: njegova izjava je
  // mjerodavna. Ovo je jedini put koji smije biti jedini osnov odluke u live modu.
  const declared = parseDeclaredStatus(text)
  if (declared && declared.status !== 'DONE') {
    const label: CompletionLabel = declared.status === 'BLOCKED' ? 'BLOCKED' : 'NEEDS_CONTEXT'
    return reject(
      'declared_not_done',
      label,
      `Agent je sam deklarirao ${declared.status}${declared.reason ? `: ${declared.reason}` : ''}. Zatvaranje kao completed proturječi vlastitoj izjavi agenta.`,
      countEvidenceMarkers(text),
      `REGOC-STATUS: ${declared.status}`,
      'declared',
    )
  }
  // Deklarirani DONE ne daje slobodan prolaz: i dalje mora imati nekakav sadržaj —
  // inače bi jedan redak "REGOC-STATUS: DONE" postao nova rupa iste veličine.
  if (declared?.status === 'DONE' && text.length >= MIN_MEANINGFUL_LENGTH) {
    return accept(countEvidenceMarkers(text), 'declared')
  }

  if (!text) {
    return reject(
      'empty_result',
      'NEEDS_CONTEXT',
      'Zadatak se ne može zatvoriti bez result_summary — nema nikakvog dokaza izvršenja.',
      0,
    )
  }

  if (isTrivialResult(text)) {
    return reject(
      'trivial_result',
      'NEEDS_CONTEXT',
      `Rezultat je gola potvrda bez sadržaja ("${text.slice(0, 60)}") — nedostaje što je konkretno napravljeno i čime je provjereno.`,
      countEvidenceMarkers(text),
      text.slice(0, 60),
    )
  }

  const evidence = countEvidenceMarkers(text)

  if (text.length < MIN_MEANINGFUL_LENGTH) {
    return reject(
      'trivial_result',
      'NEEDS_CONTEXT',
      `Rezultat je prekratak (${text.length} < ${MIN_MEANINGFUL_LENGTH} znakova) da bi bio dokaz izvršenja.`,
      evidence,
      text,
    )
  }

  const admission = classifyIncapacity(text)
  if (admission && evidence < EVIDENCE_OVERRIDE_THRESHOLD) {
    const explain =
      admission.label === 'BLOCKED'
        ? 'agent nema alate/pristup potreban za ovaj zadatak — treba drugi runner ili ovlasti'
        : 'zadatak nije dovoljno specificiran — treba opis/kontekst'
    return reject(
      'incapacity_admission',
      admission.label,
      `Agent priznaje da posao nije izvršen ("${admission.matched}"): ${explain}. Zatvaranje kao completed bilo bi lažni ✅.`,
      evidence,
      admission.matched,
    )
  }

  if (evidence === 0 && text.length < NO_EVIDENCE_MAX_LENGTH) {
    return reject(
      'no_evidence',
      'NEEDS_CONTEXT',
      'Rezultat tvrdi uspjeh, ali ne sadrži nijedan dokaz izvršenja (naredba, datoteka, mjerenje, status, artefakt). Dopiši ŠTO je pokrenuto i ŠTO je vraćeno.',
      0,
    )
  }

  return accept(evidence, 'heuristic')
}

// ─── Rollout: shadow → live (config/completion-gate.json) ────────────────────

export interface GateConfig {
  /** Gate uopće radi (sudi i loga). false = potpuno isključen. */
  enabled: boolean
  /** true = odbijanje se PROVODI (HTTP 400). false = SHADOW, samo log. */
  live: boolean
  /** Smiju li se NE-heuristički sudovi provoditi i prije nego `live` postane true. */
  deterministicLive: boolean
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  enabled: true,
  live: false,             // shadow-first: dorada TASK-2959
  deterministicLive: true,
}

const GATE_CONFIG_TTL_MS = 30_000
let _gateCache: GateConfig | null = null
let _gateLoadedAt = 0

function gateConfigPath(): string {
  // REGOC_COMPLETION_GATE_CONFIG: override SAMO za testove/alat.
  return (
    process.env.REGOC_COMPLETION_GATE_CONFIG ||
    `${process.env.HOME || '/home/klaudio'}/.claude/regoc/config/completion-gate.json`
  )
}

/** Učitaj konfiguraciju gatea (keširano 30 s ⇒ promjena djeluje bez restarta). */
export function loadGateConfig(force = false): GateConfig {
  const now = Date.now()
  if (!force && _gateCache && now - _gateLoadedAt < GATE_CONFIG_TTL_MS) return _gateCache
  let cfg = { ...DEFAULT_GATE_CONFIG }
  try {
    // require/readFileSync bez top-level importa fs: modul ostaje čist za jedinične testove.
    const { readFileSync, existsSync } = require('fs') as typeof import('fs')
    const p = gateConfigPath()
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      if (typeof raw?.enabled === 'boolean') cfg.enabled = raw.enabled
      if (typeof raw?.live === 'boolean') cfg.live = raw.live
      if (typeof raw?.deterministicLive === 'boolean') cfg.deterministicLive = raw.deterministicLive
    }
  } catch {
    // Neispravan JSON → defaulti (shadow). Gate nikad ne smije srušiti poziv.
  }
  _gateCache = cfg
  _gateLoadedAt = now
  return cfg
}

/**
 * Smije li se OVAJ sud stvarno provesti (blokirati), ili ide samo u log?
 *
 * Razlika koja opravdava dvije brzine uvođenja:
 *   - `confidence === 'declared'` i `empty_result` NISU heuristika. Prazan rezultat
 *     je prazan, a agentov vlastiti "REGOC-STATUS: BLOCKED" je njegova izjava —
 *     nijedno ne može dati lažni pozitiv nad slobodnim tekstom. Provode se odmah.
 *   - sve ostalo (proza: trivial/incapacity/no_evidence) čeka `live: true`, jer je
 *     fail-closed nad slobodnim tekstom i lažna blokada zaustavlja ploču.
 */
export function shouldEnforce(v: CompletionVerdict, cfg: GateConfig = loadGateConfig()): boolean {
  if (v.accept) return false
  if (!cfg.enabled) return false
  if (cfg.live) return true
  if (!cfg.deterministicLive) return false
  return v.confidence === 'declared' || v.code === 'empty_result'
}

/** Redak za shadow-log: točno ono što bi se dogodilo da je gate live. */
export function formatShadowLog(taskId: string, v: CompletionVerdict): string {
  return `BIH blokirala ${taskId} (reason=${v.code}/${v.label} conf=${v.confidence} evidence=${v.evidence})`
}

/**
 * Jednoredni sažetak za daemon-log/telemetriju. `conf=heuristic` je namjerno
 * vidljiv u svakom retku — dorada TASK-2959 traži da se sud po prozi UVIJEK
 * prepozna kao nisko-pouzdan, i u shadowu i u liveu.
 * Primjer: `completion-guard: REJECT incapacity_admission/BLOCKED conf=heuristic evidence=0`
 */
export function formatVerdictLog(v: CompletionVerdict): string {
  return v.accept
    ? `completion-guard: ACCEPT conf=${v.confidence} evidence=${v.evidence}`
    : `completion-guard: REJECT ${v.code}/${v.label} conf=${v.confidence} evidence=${v.evidence}${v.matched ? ` matched="${v.matched}"` : ''}`
}
