// ─── Backoff ─────────────────────────────────────────────────────────────────
// DUR-5 / TASK-3597 (PRJ-030), dio 1/2: JITTER NA ODGODI.
//
// Do 02.09.2026. su sve odgode u REGOČ-u bile DETERMINISTIČNE:
//   • AgentDaemon.ts: `RETRY_DELAY_MS = 30 * 60 * 1000` — tvrdih 30 minuta;
//   • RegocDaemon.ts: `30000 * 2^(n-1)` (strop 600 s) — po agentu, ali bez raspršenja.
// Posljedica je „stado u koraku": tri radnika koja padnu na ISTOM rate-limitu (jedan
// račun, jedan `claude --print`) izračunaju ISTU odgodu i vrate se u istoj sekundi —
// pa ga zajedno obore ponovno. Odgoda tada ne rasterećuje, nego sinkronizira.
//
// Lijek je raspršenje (jitter): svaki radnik čeka SLUČAJNO odabran razmak unutar
// dopuštenog raspona, pa se povratci razmaknu sami od sebe.
//
// ZAŠTO NE DOSLOVNO `base * (0,5 + random())`
// Zahtjev traži pun jitter uz „gornju granicu koja ostaje 30 min". Doslovna formula
// daje [0,5·base, 1,5·base), pa bi rezanje na `base` guralo POLOVICU izvlačenja na
// točno 30 min — a to je opet stado u koraku, samo s pola populacije. Zato se izvlači
// uniformno po DOPUŠTENOM rasponu [0,5·base, cap], što je za cap = base isto što i
// `base * (0,5 + 0,5·random())`: donja granica 0,5·base, gornja base, bez gomilanja
// na rubu. Mjerni kriterij iz zadatka („dva uzastopna kvara daju RAZLIČITE razmake,
// oba u [0,5·base, base]") time je zadovoljen doslovno.
//
// Autorica: Jelena (Engineer) · 2026-09-02 · TASK-3597

/** Pretpostavljena osnovica retryja nakon pada `claude --print` (dosadašnjih 30 min). */
export const DEFAULT_RETRY_BASE_MS = 30 * 60 * 1000

/** Udio osnovice ispod kojeg odgoda nikad ne pada (donja granica raspona). */
export const JITTER_FLOOR_RATIO = 0.5

export interface JitterOptions {
  /** Gornja granica odgode. Zadano = `baseMs` (zahtjev: „gornja granica ostaje 30 min"). */
  capMs?: number
  /** Injektabilan izvor slučajnosti — testovi vrte determinističan niz. */
  rand?: () => number
}

/**
 * Pun jitter: slučajna odgoda unutar [0,5·base, cap].
 *
 * • `baseMs <= 0`            → 0 (nema odgode; ne izmišljamo čekanje)
 * • `cap < 0,5·base`         → cap (dogovorena granica je jača od poda)
 * • `rand()` izvan [0,1)     → stisnuto, da pokvaren izvor ne izbaci odgodu iz raspona
 */
export function jitteredDelay(baseMs: number, opts: JitterOptions = {}): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 0
  if (base === 0) return 0
  const cap = Number.isFinite(opts.capMs as number) ? Math.max(0, opts.capMs as number) : base
  const floor = base * JITTER_FLOOR_RATIO
  if (cap <= floor) return Math.round(cap)
  const rand = opts.rand ?? Math.random
  const r = Math.min(1, Math.max(0, Number(rand()) || 0))
  return Math.round(floor + (cap - floor) * r)
}

export interface ExponentialBackoffOptions extends JitterOptions {
  /** Osnovni korak (prvi kvar). Zadano 30 s — vrijednost koju je RegocDaemon već koristio. */
  stepMs?: number
  /** Strop rasta prije jittera. Zadano 10 min — također dosadašnja vrijednost. */
  maxMs?: number
}

/**
 * Eksponencijalna odgoda S JITTEROM za n-ti uzastopni kvar (n ≥ 1).
 *
 * Deterministični dio je isti kao dosad (`step · 2^(n-1)`, odrezan na `maxMs`), pa se
 * ponašanje sustava ne mijenja u redu veličine — mijenja se samo to da dva procesa
 * koja padnu istovremeno više ne odabiru identičnu sekundu povratka.
 */
export function jitteredBackoff(failCount: number, opts: ExponentialBackoffOptions = {}): number {
  const step = opts.stepMs ?? 30_000
  const max = opts.maxMs ?? 600_000
  const n = Math.max(1, Math.floor(Number(failCount) || 1))
  // 2^30 je već daleko iznad svakog stropa; ograničenje čuva od Infinity kod pobjesnjelog brojača.
  const growth = step * Math.pow(2, Math.min(30, n - 1))
  const base = Math.min(max, Number.isFinite(growth) ? growth : max)
  return jitteredDelay(base, { capMs: base, rand: opts.rand })
}

/** Ljudski zapis odgode za dnevnik i checkpoint („24 min 13 s", „45 s"). */
export function formatDelay(ms: number): string {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  const min = Math.floor(total / 60)
  const sec = total % 60
  if (min === 0) return `${sec} s`
  return sec === 0 ? `${min} min` : `${min} min ${sec} s`
}

/**
 * Tekst za checkpoint `WAITING_RETRY`.
 *
 * Zahtjev traži da se IZABRANI razmak zapiše u checkpoint — bez toga se raspršenje ne
 * može izmjeriti poslije (checkpoint je jedini trag koji preživi restart procesa).
 * Format je strojno čitljiv (`jitter=<ms>ms base=<ms>ms`) baš zato da ga izvještaj može
 * pokupiti regexom, a i dalje se čita ljudski.
 */
export function formatRetryCheckpoint(
  exitCode: number | null,
  attempt: number,
  delayMs: number,
  baseMs: number = DEFAULT_RETRY_BASE_MS,
): string {
  return `exit ${exitCode}, retry ${attempt} za ${formatDelay(delayMs)} `
    + `(jitter=${Math.round(delayMs)}ms base=${Math.round(baseMs)}ms)`
}
