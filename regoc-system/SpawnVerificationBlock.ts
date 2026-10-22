/**
 * SpawnVerificationBlock.ts — TASK-3669 (ADR-0004, odluke O2 i O3)
 *
 * Sastavljač verifikacijskih odsjeka prompta iz `REGOC_AGENTS.json → spawn_template`.
 *
 * ODAKLE: kod je PRENESEN iz `UnifiedSpawnPipeline.buildVerificationBlock()` — jedinog
 * čitatelja `spawn_template`-a u repozitoriju, koji nije bio pozvan ni iz jednog daemona
 * (ADR-0004 §2.1). Tekst se NE prepisuje rukom nigdje: jedini izvor je registar, a
 * `UnifiedSpawnPipeline` sada delegira ovamo (§5).
 *
 * ŠTO IDE U ŽIVI PUT (`RegocDaemon.buildAgentPrompt` + `AgentDaemon.buildPrompt`):
 *   • `anti_rationalization` — BEZUVJETNO (~450 zn.). Protuotrov je dokumentiranom kvaru
 *     lažnog „✅": TASK-2953 zatvoren kao DONE uz vlastitu napomenu „nije još deployan",
 *     pa TASK-2974/2983 zatvoreni kao completed s porukom hook-blokade u rezultatu.
 *   • `zod_verification` — UVJETNO, samo za tri slučaja koje registar nabraja u
 *     `zod_verification.required_for` (file/version/feature). Bezuvjetno ubacivanje se
 *     ODBIJA: ADR-0003 je izmjerio da REGOČ-ev vlastiti boilerplate diže udio nepotrebnih
 *     odsjeka s 1,5 % na 35,1 % (×23,4).
 *   • `verification_gate` i `structured_status` NE idu odavde — živi put ih već šalje uz
 *     `taskId` (ADR-0004 §4.1, redci 7 i 8). Dupliciranje bi bilo čisti teret.
 */

export type ZodComparisonKind = 'file_comparison' | 'version_comparison' | 'feature_comparison'
export type VerificationPart =
  | 'verification_gate'
  | 'anti_rationalization'
  | 'structured_status'
  | 'zod_verification'

export interface SpawnTemplateLike {
  verification_gate?: { prompt_injection?: string }
  anti_rationalization?: { prompt_injection?: string }
  structured_status?: { prompt_injection?: string }
  zod_verification?: { prompt_injection?: string; required_for?: string[] }
}

/** Redoslijed kojim je blok slagao napušteni `UnifiedSpawnPipeline` (O3 — ostaje za njega). */
export const LEGACY_PARTS: VerificationPart[] = [
  'verification_gate',
  'anti_rationalization',
  'structured_status',
]

/** Ono što u živi put ide BEZUVJETNO. ZOD se dodaje samo kad ga zadatak traži. */
export const LIVE_PARTS_BASE: VerificationPart[] = ['anti_rationalization']

// ---------------------------------------------------------------------------
// Sastavljač
// ---------------------------------------------------------------------------

/**
 * Spoji tražene odsjeke iz `spawn_template`. Dio bez teksta se preskače (nikad ne baca) —
 * kvar u registru ne smije zaustaviti spawn.
 */
export function buildVerificationBlock(
  spawnTemplate: SpawnTemplateLike | undefined | null,
  parts: VerificationPart[],
): string {
  if (!spawnTemplate) return ''
  const komadi: string[] = []
  for (const part of parts) {
    const tekst = (spawnTemplate as Record<string, { prompt_injection?: string }>)[part]?.prompt_injection
    if (typeof tekst === 'string' && tekst.trim().length > 0) komadi.push(tekst)
  }
  return komadi.join('\n\n')
}

// ---------------------------------------------------------------------------
// Detekcija zadatka usporedbe (stavka 6 iz `required_in_prompt`)
// ---------------------------------------------------------------------------

/**
 * Repovi koje REGOČ sam dopisuje na zadatak (recept, protokol, vlastiti verifikacijski
 * odsjeci, prihvatni kriteriji, projekt). Detekcija gleda SAMO posao — inače bi sam
 * ubačeni ZOD-odsjek u sljedećem krugu okinuo novi ZOD-odsjek (ista zamka koju je
 * ADR-0003 izmjerio na tierima).
 */
const REGOC_TAIL_MARKERS = [
  '── RECEPT (tier',
  '## ZOD VERIFIKACIJA',
  '## ANTI-RATIONALIZATION',
  '## VERIFICATION GATE',
  '## STRUCTURED STATUS',
  '## TASKMANAGER PROTOCOL',
  '## HEARTBEAT',
  '## PRIHVATNI KRITERIJI',
  '## PROJEKT ZADATKA',
]

/** Bez dijakritike i malim slovima — tekst zadataka dolazi i s č/ć/š/ž/đ i bez njih. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/č|ć/g, 'c')
    .replace(/š/g, 's')
    .replace(/ž/g, 'z')
    .replace(/đ/g, 'd')
}

function stripRegocTail(text: string): string {
  let cut = text.length
  const hay = text.toUpperCase()
  for (const marker of REGOC_TAIL_MARKERS) {
    const i = hay.indexOf(marker.toUpperCase())
    if (i >= 0 && i < cut) cut = i
  }
  return text.slice(0, cut)
}

/** Riječi koje znače „usporedi", u hrvatskom i engleskom. */
const COMPARISON_SIGNALS: RegExp[] = [
  /uspored/,            // usporedi, usporedba, usporediti, usporedno
  /\bcompar(e|es|ing|ison)\b/,
  /\bdiff(aj|ati|am)?\b/,
  /razlik\w*\s+izmedu/,
  /\bvs\.?\b/,
  /\bparitet\b|\bparity\b/,
]

/** Predmet usporedbe → koji od tri slučaja iz `zod_verification.required_for`. */
const SUBJECT_SIGNALS: Array<{ kind: ZodComparisonKind; patterns: RegExp[] }> = [
  { kind: 'version_comparison', patterns: [/verzij/, /\bversion/, /revizij/, /\bv\d+(\.\d+)*\b/] },
  { kind: 'file_comparison', patterns: [/datotek/, /fajl/, /\bfiles?\b/, /file_comparison/] },
  { kind: 'feature_comparison', patterns: [/znacajk/, /funkcionalnost/, /\bfeatures?\b/, /\bparitet\b|\bparity\b/] },
]

/**
 * Vrati koji je to tip usporedbe, ili `null` kad zadatak nije usporedba.
 *
 * Traže se OBA signala — i „usporedi", i predmet usporedbe. Sama riječ „usporedi" bez
 * predmeta NE okida ZOD: propis pokriva točno tri slučaja, a ubacivanje na slutnju je
 * upravo boilerplate-inflacija iz ADR-0003.
 */
export function detectComparisonKind(text: string | null | undefined): ZodComparisonKind | null {
  if (!text) return null
  const posao = normalize(stripRegocTail(text))
  if (!posao.trim()) return null
  if (!COMPARISON_SIGNALS.some(r => r.test(posao))) return null
  for (const { kind, patterns } of SUBJECT_SIGNALS) {
    if (patterns.some(r => r.test(posao))) return kind
  }
  return null
}

export function needsZodVerification(text: string | null | undefined): boolean {
  return detectComparisonKind(text) !== null
}

// ---------------------------------------------------------------------------
// Živi blok
// ---------------------------------------------------------------------------

export interface LiveVerificationBlock {
  /** Tekst za prompt ('' ako registar nema tekstova — spawn tada ide bez bloka). */
  block: string
  /** Dijelovi koji su stvarno ušli (za test i za dnevnik). */
  parts: VerificationPart[]
  /** Tip usporedbe koji je okinuo ZOD, ili null. */
  zodKind: ZodComparisonKind | null
  /** Jednoredni opis za daemon.log. */
  opis: string
}

/**
 * Blok za živi put: anti-racionalizacija bezuvjetno + ZOD kad zadatak traži usporedbu.
 * `taskText` mora biti tekst POSLA (u RegocDaemonu prolazi kroz `stripRegocBoilerplate`).
 */
export function buildLiveVerificationBlock(
  spawnTemplate: SpawnTemplateLike | undefined | null,
  taskText: string | null | undefined,
): LiveVerificationBlock {
  const zodKind = detectComparisonKind(taskText)
  const zeljeni: VerificationPart[] = zodKind
    ? [...LIVE_PARTS_BASE, 'zod_verification']
    : [...LIVE_PARTS_BASE]

  // U `parts` ulazi samo ono što je registar stvarno dao (prazan tekst → dio otpada).
  const parts = zeljeni.filter(p => {
    const t = (spawnTemplate as Record<string, { prompt_injection?: string }> | null | undefined)?.[p]?.prompt_injection
    return typeof t === 'string' && t.trim().length > 0
  })
  const block = buildVerificationBlock(spawnTemplate, parts)

  const anti = parts.includes('anti_rationalization')
    ? `anti-racionalizacija ${(spawnTemplate as any).anti_rationalization.prompt_injection.length} zn.`
    : 'bez anti-racionalizacije (nema teksta u registru)'
  const zod = parts.includes('zod_verification')
    ? ` + ZOD (${zodKind}) ${(spawnTemplate as any).zod_verification.prompt_injection.length} zn.`
    : ', bez ZOD-a'
  return { block, parts, zodKind, opis: `${anti}${zod} → ukupno ${block.length} zn.` }
}
