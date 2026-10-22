// ─── AgentConcurrency ────────────────────────────────────────────────────────
// DUR-4 / TASK-3596 (PRJ-030). Jedan izvor istine za STROP USPOREDNIH SPAWNOVA.
//
// Do 02.09.2026. je `MAX_AGENT_CONCURRENT` bio tvrdo zapisan u RegocDaemon.ts (1), dok su
// komentari u AutonomyQueue.ts i TokenBucket.ts već pretpostavljali 3 — kod i dokumentacija
// su si proturječili, a povratak na serijski rad tražio je izmjenu koda. Odsad se strop
// čita iz okoline (`REGOC_MAX_AGENT_CONCURRENT`) uz pretpostavku 3, pa je i vraćanje na 1
// i podizanje na 2 stvar pokretanja procesa, ne uređivanja datoteke.
//
// ŠTO OVAJ BROJ **NIJE**: dozvola za rafal. Auto-exec prije SVAKOG spawna iznova mjeri
// potrošnju sesije i pita vrata autonomije (`autonomyTierFromUsage`, WorkStateJournal):
//   • < 70 % (`full`)                      → red se vuče, do ovog stropa;
//   • ≥ 70 % / stara ili slijepa snimka    → `autonomousQueue=false` → auto-exec STAJE;
//   • ≥ 85 % (`cautious`) / 429            → `multiAgent=false` → najviše jedan spawn.
// Rafali od 3 Opusa iz incidenta 29.07. nastali su zato što je zastarjeli keš značio punu
// autonomiju (fail-open), a ne zato što je strop bio 3. Ta je rupa zatvorena u TASK-3046
// (fail-CLOSED na staroj snimci + prisilno mjerenje između spawnova istog prolaza).
//
// Autorica: Jelena (Engineer) · 2026-09-02 · TASK-3596
//
// ⚠️ TASK-5015 (24.09.2026.): daemon VIŠE NE ZOVE `resolveMaxAgentConcurrent()`. Strop je
// postavka TaskManagera (`ConcurrencySetting.ts`, tablica `settings`), promjenjiva uživo na
// Config stranici; okolina je samo jednokratni seed. Resolver ostaje za alate i testove.

/** Pretpostavka kad okolina ne kaže drukčije (vrijednost iz izvornog zahtjeva). */
export const DEFAULT_MAX_AGENT_CONCURRENT = 3

/** Gornja brana protiv tipfelera u okolini (`=30` ne smije značiti 30 Opusa odjednom). */
export const MAX_AGENT_CONCURRENT_CEILING = 10

/**
 * Strop usporednih agentskih spawnova iz okoline.
 *
 * • nepostavljeno / prazno / smeće (`NaN`) → `DEFAULT_MAX_AGENT_CONCURRENT` (3)
 * • broj                                    → odrezan na cijeli i stisnut u [1, 10]
 *
 * Zašto ne goli `Number(env ?? 3)`: `Number('abc')` je `NaN`, a `size >= NaN` je uvijek
 * `false` — tipfeler u okolini bi ukinuo strop umjesto da ga postavi. Isto vrijedi za 0:
 * „nula spawnova" nije strop nego pauza, a za pauzu postoji `readPauseState()`.
 */
export function resolveMaxAgentConcurrent(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): number {
  const raw = env.REGOC_MAX_AGENT_CONCURRENT
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_MAX_AGENT_CONCURRENT
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_MAX_AGENT_CONCURRENT
  return Math.min(MAX_AGENT_CONCURRENT_CEILING, Math.max(1, Math.floor(n)))
}

/**
 * Ima li slobodnog mjesta za još jedan spawn.
 *
 * Predikat je izdvojen da bi ga test mogao pozvati: RegocDaemon.ts se ne smije uvoziti u
 * test (uvoz pokreće daemon), pa bi test koji si sam prepiše `>=` dokazivao svoju kopiju,
 * a ne pogon.
 */
export function spawnSlotAvailable(activeCount: number, max: number = resolveMaxAgentConcurrent()): boolean {
  return activeCount < max
}

// ─── Vidljivost stropa ───────────────────────────────────────────────────────
// TASK-4675 (dorada TASK-4667). Strop koji se doseže bez zapisa nije jamstvo nego
// pretpostavka: 05.09.2026. je u dnevniku bilo 10631 zapisa „1 drugi spawn radi u istom
// stablu" i NIJEDAN o dosegnutom stropu — ne zato što se nije dosezao, nego zato što je
// auto-exec petlja na tom mjestu radila goli `break`. Pri stropu 1 to je značilo da red
// utihne bez razloga: provjera mjesta stoji PRIJE serijalizacije po stablu, pa nestane i
// taj jedini trag.

/** Koliko najmanje vremena mora proći između dva zapisa o dosegnutom stropu. */
export const SPAWN_LIMIT_LOG_THROTTLE_MS = 60_000

/**
 * Zapis o odbijanju spawna ZBOG BROJA SPAWNOVA (ne zbog stabla, kvote ili pauze).
 *
 * Prigušen je namjerno: auto-exec prolazi redom svakih ~15 s, pa bi neprigušen zapis za
 * jedan dan dao isti red veličine smeća kao redak o stablu. Prigušenje dojave NIJE
 * prigušenje radnje — spawn je odbijen svaki put, samo se ne prepisuje svaki put.
 *
 * Odluka o vremenu se ne donosi ovdje (`Date.now()` u čistoj funkciji test ne može
 * zaustaviti) — pozivatelj predaje `nowMs` i `lastLoggedMs`.
 */
export function spawnLimitNotice(opts: {
  activeCount: number
  max: number
  pendingCount: number
  nowMs: number
  lastLoggedMs: number | null
}): { shouldLog: boolean; message: string } {
  const { activeCount, max, pendingCount, nowMs, lastLoggedMs } = opts
  const shouldLog = lastLoggedMs === null || nowMs - lastLoggedMs >= SPAWN_LIMIT_LOG_THROTTLE_MS
  const message =
    `⛔ [strop] spawn odbijen: ${activeCount}/${max} mjesta zauzeto — ` +
    `${pendingCount} zadatak(a) čeka (Config → Usporedni agenti = ${max}, ` +
    `prigušeno na ${SPAWN_LIMIT_LOG_THROTTLE_MS / 1000}s)`
  return { shouldLog, message }
}
