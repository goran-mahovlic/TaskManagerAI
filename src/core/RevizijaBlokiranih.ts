/**
 * RevizijaBlokiranih — naknadna revizija blokiranih zadataka: klasa blokade, presuda i pregled
 * za ploču (TASK-5204 izvornog sustava, prenesen u paket u TASK-5327).
 *
 * Zašto u paketu: ploča mora pokazivati ISTO što revizija radi. Presude računa daemon izvornog
 * sustava (na čvoru je to komplet uz paket) istim pravilima; ploča ih ponavlja nad istim
 * ulazima (baza, `stale-watchdog.json`, dnevnik presuda), pa traka „Blokirano” ne može lagati
 * o pogonu. Ovdje NEMA radnji — puštanje, zatvaranje deploya i oznake izvodi daemon kroz API.
 *
 * Putanje (ADR-0001 O1.4, bez tuđeg kućnog direktorija):
 *   - postavke: `TM_STALE_WATCHDOG_CONFIG` → `$TM_HOME/config/stale-watchdog.json` → `config/` paketa;
 *   - dnevnik presuda i run log: `TM_IZVORNI_PODACI` (mapa podataka daemona domaćina) → `TM_DATA`.
 *
 * Razlike prema izvoru (brana ADR-0001 §8): imena ljudi i popis tima su konfiguracija —
 * `izuzetiNositelji` dolaze iz `excludeAssignees`, `jeftiniAgenti` iz `blocked.jeftiniAgenti`;
 * presuda i skupina „čeka čovjeka” zovu se `covjeku`.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { konfigPutanja, TM_DATA } from './paths'

/** Postavke revizije (odjeljak `blocked`) i izuzeća watchdoga (vrh datoteke). */
export function putanjaKonfiguracijeRevizije(): string {
  return konfigPutanja('stale-watchdog.json', 'TM_STALE_WATCHDOG_CONFIG')
}

/** Ključ koji izvorni sustav koristi za `projektiUvijekCovjeku` — čita se radi iste datoteke na čvoru. */
const STARI_KLJUC_PROJEKATA = ['projektiUvijek', 'Gor', 'anu'].join('')

// ─── Pomoćno (iz StaleWatchdog izvora — isto ponašanje) ──────────────────────────────────

/** Normalizirana lista (trim + lowercase); nešto što nije lista → fallback. */
export function asStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  return value.filter((v): v is string => typeof v === 'string').map(v => v.trim().toLowerCase())
}

/** Pozitivan konačan broj ili fallback — 0/negativno/NaN nikad ne smije postati prag. */
export function asPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function formatAge(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min}min`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ${min % 60}min`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Minimum koji trebamo iz zadatka — namjerno labavo (API vraća više). */
export interface WatchdogTask {
  id: string
  title?: string
  assignee?: string | null
  status?: string
  tags?: string[]
  updatedAt?: string | null
  startedAt?: string | null
  createdAt?: string | null
}

export interface ExclusionConfig {
  excludeTags: string[]
  excludeAssignees: string[]
  excludeTaskIds: string[]
  onlyTaskIds: string[]
}

/** Jedini kod koji smije reći „ne diraj” — isti za sve mehanizme koji diraju tuđi zadatak. */
export function exclusionReason(task: WatchdogTask, assignee: string, config: ExclusionConfig): string | null {
  const id = (task.id || '').toLowerCase()
  if (config.onlyTaskIds.length > 0 && !config.onlyTaskIds.includes(id)) {
    return `izuzet: canary opseg (onlyTaskIds) ne uključuje ovaj task`
  }
  if (config.excludeTaskIds.includes(id)) return `izuzet: task ID na excludeTaskIds listi`
  const tags = (task.tags || []).filter(t => typeof t === 'string').map(t => t.toLowerCase())
  const hitTag = tags.find(t => config.excludeTags.includes(t))
  if (hitTag) return `izuzet: tag '${hitTag}' (interaktivni/ljudski rad nema agent_checkpoints)`
  if (assignee && config.excludeAssignees.includes(assignee.toLowerCase())) {
    return `izuzet: assignee '${assignee}' na whitelisti`
  }
  return null
}

/**
 * Eksponencijalna odgoda s raspršenjem u [0,5·base, base] — isti izvor slučajnosti (`rand`)
 * daje isto vrijeme na ploči i u daemonu.
 */
export function jitteredBackoff(failCount: number, opts: { stepMs?: number; maxMs?: number; rand?: () => number } = {}): number {
  const step = opts.stepMs ?? 30_000
  const max = opts.maxMs ?? 600_000
  const n = Math.max(1, Math.floor(Number(failCount) || 1))
  const growth = step * Math.pow(2, Math.min(30, n - 1))
  const base = Math.min(max, Number.isFinite(growth) ? growth : max)
  if (!(base > 0)) return 0
  const floor = base * 0.5
  const r = Math.min(1, Math.max(0, Number((opts.rand ?? Math.random)()) || 0))
  return Math.round(floor + (base - floor) * r)
}

// ════════════════════════════════════════════════════════════════════════════════════════
// NAKNADNA REVIZIJA BLOKIRANIH (TASK-5204). Puštanje NIKAD ne ide u `cancelled`.
// ════════════════════════════════════════════════════════════════════════════════════════

export const BLOK_KLASE = ['prolazno', 'kriticar', 'covjek', 'odluka', 'lanac', 'datum', 'deploy',
  'sustav', 'sigurnost', 'novac', 'vanjsko', 'zastarjelo', 'nepoznato'] as const
export type BlokKlasa = typeof BLOK_KLASE[number]

/** Zatvoren popis (§6.1) — dopunjuje se samo odlukom vlasnika. Ove se klase NIKAD ne puštaju. */
export const UVIJEK_COVJEKU: BlokKlasa[] = ['odluka', 'covjek', 'sustav', 'sigurnost', 'novac', 'vanjsko']
/** Rizik (§6.2): uz `waiting-for-human` dobivaju i `no-autonomy`. */
export const RIZICNE_KLASE: BlokKlasa[] = ['sustav', 'sigurnost', 'novac', 'vanjsko']

const BLOK_TAG = /^blok:(.+)$/
const REDRIVE_TAG = /^redrive:(\d+)$/
const KRITIKA_TAG = /^kritika:(\d+)$/

function listaOznaka(tags: unknown): string[] {
  return Array.isArray(tags) ? tags.map(t => String(t)) : []
}

export function jeBlokKlasa(k: unknown): k is BlokKlasa {
  return typeof k === 'string' && (BLOK_KLASE as readonly string[]).includes(k)
}

/** Klasa iz oznake `blok:<k>`; nepoznata klasa se ignorira (null). */
export function klasaIzOznaka(tags: unknown): BlokKlasa | null {
  for (const t of listaOznaka(tags)) {
    const m = BLOK_TAG.exec(t.trim().toLowerCase())
    if (m && jeBlokKlasa(m[1])) return m[1]
  }
  return null
}

/** Jedina pomoćna funkcija za oznaku klase — stara `blok:*` se ZAMJENJUJE, ne gomila. */
export function withBlokTag(tags: unknown, klasa: BlokKlasa): string[] {
  const out: string[] = []
  for (const t of listaOznaka(tags)) {
    if (BLOK_TAG.test(t)) continue
    if (!out.includes(t)) out.push(t)
  }
  out.push(`blok:${klasa}`)
  return out
}

/** Brojač ponovnih puštanja revizije — odvojen od `pokusaj:` (FailRequeue) i `kritika:`. */
export function redriveIzOznaka(tags: unknown): number {
  let n = 0
  for (const t of listaOznaka(tags)) { const m = REDRIVE_TAG.exec(t); if (m) n = Math.max(n, Number(m[1])) }
  return n
}

export function withRedriveTag(tags: unknown, n: number): string[] {
  const out: string[] = []
  for (const t of listaOznaka(tags)) {
    if (REDRIVE_TAG.test(t)) continue
    if (!out.includes(t)) out.push(t)
  }
  out.push(`redrive:${n}`)
  return out
}

function dodajOznake(tags: string[], ...nove: string[]): string[] {
  const out = [...tags]
  for (const n of nove) if (!out.includes(n)) out.push(n)
  return out
}

// ─── Rizik (TS prijevod `tools/orkestracija/odlucitelj.py` RIZIK + NIJECNICA) ──────────
// Python `\b` i `\w` su Unicode; JS ih ima samo za ASCII, pa se oba prevode izričito —
// inače „čisti” ili „€” daju drukčiji pogodak nego u odlučitelju (test pariteta, §10.1 t. 2).
const W = '[\\p{L}\\p{N}_]'
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`
function pyRe(src: string): RegExp {
  return new RegExp(src.replace(/\\b/g, B).replace(/\\w/g, W), 'giu')
}

/** Isti redoslijed i isti nazivi kao `RIZIK` u odlucitelj.py (r. 104–115). */
const RIZIK_ODLUCITELJA: Array<[string, RegExp]> = [
  ['novac', pyRe('\\b(eur|usd|€|\\$|kupi|kupnj|plati|plaćanj|placanj|račun|racun|naplat|ponud|' +
    'kredit|pretplat|licenc|narudžb|narudzb)\\w*')],
  ['brisanje', pyRe('\\b(obriši|obrisi|izbriši|izbrisi|briš|bris|delete|drop\\s+table|rm\\s+-rf|' +
    'purge|očisti|ocisti|ukloni|reset)\\w*')],
  ['vanjski učinak', pyRe('\\b(pošalji|posalji|slanje|e-?mail|mail|klijent|naručitelj|narucitelj|' +
    'objavi|push|deploy|produkcij|uživo|uzivo|live|javno|kupac)\\w*')],
  ['tajne', pyRe('\\b(ključ|kljuc|lozink|token|credential|api[\\s_-]?key|tajn)\\w*')],
  ['nepovratno', pyRe('\\b(migracij|selidb|preseli|nadogradnj|upgrade)\\w*')],
]
/** Dodatni uzorci za `sustav` (§6.2) — nisu u odlučitelju, pa nisu dio testa pariteta. */
const RIZIK_SUSTAV = pyRe('\\b(features\\.json|regocdaemon|entrypoint|docker|restart|capguard|settings)\\w*')

const NIJECNICA = new RegExp(`${B}(ne|nemoj|nikad|nikada|bez)${B}[\\s\\p{L}\\p{N}_,„”"'\`()-]{0,24}$`, 'iu')

function stvaranPogodak(tekst: string, uzorak: RegExp): string | null {
  uzorak.lastIndex = 0
  for (const m of tekst.matchAll(uzorak)) {
    const i = m.index ?? 0
    if (!NIJECNICA.test(tekst.slice(Math.max(0, i - 40), i))) return m[0]
  }
  return null
}

/** Doslovni paritet s `odlucitelj.py rizik()` — naslov + opis, vraća Pythonov naziv ili null. */
export function rizikOdlucitelja(title: string, description: string): string | null {
  const tekst = `${title || ''}\n${description || ''}`.toLowerCase()
  for (const [naziv, uzorak] of RIZIK_ODLUCITELJA) if (stvaranPogodak(tekst, uzorak)) return naziv
  return null
}

const RIZIK_U_KLASU: Record<string, BlokKlasa> = {
  'novac': 'novac', 'tajne': 'sigurnost', 'brisanje': 'sustav', 'nepovratno': 'sustav', 'vanjski učinak': 'vanjsko',
}

export interface RizikPogodak { klasa: BlokKlasa; naziv: string; pogodak: string }

/**
 * Prepoznaj rizik (§6.2). Deterministički, preteže nad svim drugim klasama osim
 * `zastarjelo`/`datum` (one se ionako nikad ne puštaju). `blockedReason` ulazi samo kad
 * je ljudski tekst — strojna dijagnostika spawna („…manage.sh restart”) nije namjera zadatka.
 */
export function prepoznajRizik(title: string, description: string, blockedReason: string): RizikPogodak | null {
  const tekst = `${title || ''}\n${description || ''}\n${blockedReason || ''}`.toLowerCase()
  for (const [naziv, uzorak] of RIZIK_ODLUCITELJA) {
    const p = stvaranPogodak(tekst, uzorak)
    if (p) return { klasa: RIZIK_U_KLASU[naziv]!, naziv, pogodak: p }
  }
  const s = stvaranPogodak(tekst, RIZIK_SUSTAV)
  return s ? { klasa: 'sustav', naziv: 'sustav', pogodak: s } : null
}

// ─── Klasifikacija ─────────────────────────────────────────────────────────────────────
export interface BlockedTask extends WatchdogTask {
  blockedReason?: string | null
  description?: string | null
  blockedBy?: string[] | null
  projectId?: string | null
}

/** Dorin prefiks `[revizija TASK-5201] <UZROK>:` (TASK-5201). */
const DORIN_PREFIKS = /^\[revizija TASK-5201\]\s*([A-Z_]+)\s*:/
const DORA_U_KLASU: Record<string, BlokKlasa> = {
  SPAWN_PREKINUT: 'prolazno', NO_TURNS: 'prolazno', BEZ_RAZLOGA: 'nepoznato', DECLARED_HUMAN: 'covjek',
  LANAC: 'lanac', CRITIC: 'kriticar', DATUM: 'datum', ZASTARJELO: 'zastarjelo', DEPLOY: 'deploy', GORAN: 'odluka',
}
/** Strojni kod na početku razloga: `<KLASA>: opis` (§3, „razlog počinje strojnim kodom”). */
const KOD_KLASE = /^(PROLAZNO|KRITICAR|COVJEK|ODLUKA|LANAC|DATUM|DEPLOY|SUSTAV|SIGURNOST|NOVAC|VANJSKO|ZASTARJELO|NEPOZNATO)\s*:/

/** Ime servisa iz „čeka restart <servis>” (deploy klasa); null kad ga nema. */
export function servisIzRazloga(reason: string | null | undefined): string | null {
  const m = /(?:č|c)eka\s+restart\s+([a-z][a-z0-9_-]*)/i.exec(reason || '')
  return m ? m[1]!.toLowerCase() : null
}

/** Klasa samo iz teksta razloga (bez oznaka i rizika). */
function klasaIzRazloga(r: string): { klasa: BlokKlasa; izvor: string } | null {
  const reason = (r || '').trim()
  if (!reason) return null
  const kod = KOD_KLASE.exec(reason)
  if (kod) return { klasa: kod[1]!.toLowerCase() as BlokKlasa, izvor: `strojni kod ${kod[1]}` }
  if (/^(no-turns|session-budget|hook-block)/i.test(reason)) return { klasa: 'prolazno', izvor: `HookBlockGuard ${reason.split(/[\s:]/)[0]}` }
  if (/spawn prekinut/i.test(reason)) return { klasa: 'prolazno', izvor: 'Spawn prekinut (FailRequeue)' }
  if (/zombie-recovery/i.test(reason)) return { klasa: 'prolazno', izvor: 'Zombie-recovery' }
  if (/siro(č|c)e\s*×\s*3/i.test(reason)) return { klasa: 'prolazno', izvor: 'siroče ×3' }
  if (/^(č|c)eka slobodno mjesto/i.test(reason)) return { klasa: 'prolazno', izvor: 'čeka slobodno mjesto' }
  if (/CRITIC_FAILED/.test(reason)) return { klasa: 'kriticar', izvor: 'CRITIC_FAILED' }
  if (servisIzRazloga(reason)) return { klasa: 'deploy', izvor: 'čeka restart servisa' }
  const rev = DORIN_PREFIKS.exec(reason)
  if (rev && DORA_U_KLASU[rev[1]!]) return { klasa: DORA_U_KLASU[rev[1]!]!, izvor: `revizija TASK-5201 ${rev[1]}` }
  if (/^(č|c)eka odluku/i.test(reason) || /ljudska odluka/i.test(reason)) return { klasa: 'odluka', izvor: 'čeka odluku' }
  if (/^(č|c)eka TASK-\d+/i.test(reason)) return { klasa: 'lanac', izvor: 'čeka zadatak' }
  if (/budilica|^vremenski uvjet|^(č|c)eka \d{1,2}\.\s?\d{1,2}\./i.test(reason)) return { klasa: 'datum', izvor: 'nadnevak/budilica' }
  if (/^BLOCKED: Agent je sam deklarirao/i.test(reason) || /^waiting-for-human|^(č|c)eka (vlasnika|(č|c)ovjeka)/i.test(reason)) {
    return { klasa: 'covjek', izvor: 'agent/razlog traži čovjeka' }
  }
  return null
}

const LJUDSKI_RAZLOG: BlokKlasa[] = ['covjek', 'odluka', 'nepoznato']

/**
 * Klasa blokade. Redoslijed (§4.1): rizik* > oznaka `blok:` > needs-decision >
 * waiting-for-human > blockedBy > strojni kod / Dorin prefiks u razlogu > `nepoznato`.
 * `waiting-for-human` je ispred strojnog koda namjerno: zadatak koji je netko predao
 * čovjeku ne smije se pustiti samo zato što je njegov stari razlog bio „Spawn prekinut”.
 *
 * *Rizik: zadano (`rizikPreteze` nije `false`) preteže kao klasa. Revizija ga zove s
 * `rizikPreteze: cfg.rizikPretezeUvijek` (zadano false): klasa ostaje mehanička, a pogodak
 * rizika vraća se u polju `rizik` i provjerava kao BRANA prije svakog puštanja. Izmjereno
 * 04.10.2026. nad 104 blokirana: kao klasa šalje čovjeku 59 (npr. „računalo” → novac,
 * „RegocDaemon”/„uživo” u gotovo svakom opisu sustava) i zauvijek drži lance 5170–5172;
 * kao brana daje istu tvrdu garanciju (0 puštanja uz pogodak rizika) bez lažnih predaja.
 */
export function klasificirajBlokadu(
  t: Partial<BlockedTask>,
  opts: { projektiUvijekCovjeku?: string[]; rizikPreteze?: boolean } = {},
): { klasa: BlokKlasa; izvor: string; rizik?: RizikPogodak } {
  const tags = listaOznaka(t.tags).map(x => x.toLowerCase())
  const reason = String(t.blockedReason || '')
  const izRazloga = klasaIzRazloga(reason)
  const izOznake = klasaIzOznaka(tags)

  const osnovna = ((): { klasa: BlokKlasa; izvor: string } => {
    if (izOznake) return { klasa: izOznake, izvor: `oznaka blok:${izOznake}` }
    if (tags.includes('needs-decision')) return { klasa: 'odluka', izvor: 'oznaka needs-decision' }
    if (tags.includes('waiting-for-human')) return { klasa: 'covjek', izvor: 'oznaka waiting-for-human' }
    if (Array.isArray(t.blockedBy) && t.blockedBy.length > 0) return { klasa: 'lanac', izvor: `blockedBy ${t.blockedBy.join(',')}` }
    if (izRazloga) return izRazloga
    if (tags.includes('okidac-strojni')) return { klasa: 'datum', izvor: 'oznaka okidac-strojni' }
    return { klasa: 'nepoznato', izvor: reason ? 'razlog bez prepoznatljivog koda' : 'bez razloga' }
  })()

  if (osnovna.klasa === 'zastarjelo' || osnovna.klasa === 'datum') return osnovna

  const projekt = String(t.projectId || '').toLowerCase()
  if (projekt && (opts.projektiUvijekCovjeku || []).includes(projekt)) {
    return { klasa: 'vanjsko', izvor: `projekt ${t.projectId} je pod vlasnikom (projektiUvijekCovjeku)` }
  }
  const razlogZaRizik = !izRazloga || LJUDSKI_RAZLOG.includes(izRazloga.klasa) ? reason : ''
  const r = prepoznajRizik(String(t.title || ''), String(t.description || ''), razlogZaRizik)
  if (r && opts.rizikPreteze !== false) return { klasa: r.klasa, izvor: `rizik ${r.naziv} („${r.pogodak}”)`, rizik: r }
  return r ? { ...osnovna, rizik: r } : osnovna
}

// ─── Konfiguracija (odjeljak `blocked` u config/stale-watchdog.json) ────────────────────
export interface BlockedReviewConfig {
  intervalMinutes: number
  klaseUzivo: BlokKlasa[]
  maxRedrive: number
  maxPustanjaPoProlazu: number
  maxUsdPoPustanju: number
  maxUsdPoZadatku: number
  maxUsdDnevno: number
  maxUdioSpawnova: number
  najstarijiZaAutomatskiDana: number
  minSlobodnogDiskaPosto: number
  bez429Minuta: number
  projektiUvijekCovjeku: string[]
  podsjetnikCovjekSati: number
  podsjetnikRizikDana: number
  maxKrugovaKriticara: number
  /**
   * Nositelji koje revizija nikad ne dira — `excludeAssignees` IZ ISTE datoteke (vrh, ne `blocked`),
   * pa izvorni daemon i ploča sude isto. Zadano samo `user`; ime vlasnika je podatak instalacije.
   */
  izuzetiNositelji: string[]
  /** Nositelji s jeftinim modelom: bez povijesti troška procjena puštanja 1 USD (ostali 5 USD, §5.4). */
  jeftiniAgenti: string[]
  /** true = rizik je klasa koja preteže nad svime (dizajn §6.2 doslovno); false = brana pri puštanju. */
  rizikPretezeUvijek: boolean
}

export const DEFAULT_BLOCKED_REVIEW_CONFIG: BlockedReviewConfig = {
  intervalMinutes: 60,
  // QA-5205 N2 / dizajn §12: `prolazno` tek nakon 48 h uživo za lanac i deploy bez incidenta.
  klaseUzivo: ['lanac', 'deploy'],
  maxRedrive: 3,
  maxPustanjaPoProlazu: 3,
  maxUsdPoPustanju: 5,
  maxUsdPoZadatku: 10,
  maxUsdDnevno: 15,
  maxUdioSpawnova: 0.2,
  najstarijiZaAutomatskiDana: 14,
  minSlobodnogDiskaPosto: 10,
  bez429Minuta: 30,
  projektiUvijekCovjeku: [],
  podsjetnikCovjekSati: 24,
  podsjetnikRizikDana: 7,
  maxKrugovaKriticara: 2,
  izuzetiNositelji: ['user'],
  jeftiniAgenti: [],
  rizikPretezeUvijek: false,
}

/**
 * Konfiguracija revizije. Nedostajuća datoteka ili odjeljak → zadano.
 * `klaseUzivo` je fail-CLOSED: sve osim ispravnog popisa poznatih klasa → `[]` (ništa uživo),
 * a klase „uvijek čovjeku” se izbacuju uvijek — njih ni konfiguracija ne smije pustiti.
 */
export function loadBlockedReviewConfig(path: string = putanjaKonfiguracijeRevizije()): BlockedReviewConfig {
  const d = DEFAULT_BLOCKED_REVIEW_CONFIG
  let raw: any
  let izuzeti = d.izuzetiNositelji
  try {
    if (!existsSync(path)) return { ...d, klaseUzivo: [...d.klaseUzivo] }
    const cijela = JSON.parse(readFileSync(path, 'utf-8'))
    izuzeti = asStringArray(cijela?.excludeAssignees, d.izuzetiNositelji)
    raw = cijela?.blocked
  } catch {
    return { ...d, klaseUzivo: [] }
  }
  if (!raw || typeof raw !== 'object') return { ...d, klaseUzivo: [...d.klaseUzivo], izuzetiNositelji: izuzeti }
  let klaseUzivo: BlokKlasa[]
  if (raw.klaseUzivo === undefined) klaseUzivo = [...d.klaseUzivo]
  else if (!Array.isArray(raw.klaseUzivo) || !raw.klaseUzivo.every(jeBlokKlasa)) klaseUzivo = []
  else klaseUzivo = (raw.klaseUzivo as BlokKlasa[]).filter(k => !UVIJEK_COVJEKU.includes(k))
  const udio = typeof raw.maxUdioSpawnova === 'number' && raw.maxUdioSpawnova > 0 && raw.maxUdioSpawnova <= 1 ? raw.maxUdioSpawnova : d.maxUdioSpawnova
  return {
    intervalMinutes: asPositiveNumber(raw.intervalMinutes, d.intervalMinutes),
    klaseUzivo,
    maxRedrive: asPositiveNumber(raw.maxRedrive, d.maxRedrive),
    maxPustanjaPoProlazu: asPositiveNumber(raw.maxPustanjaPoProlazu, d.maxPustanjaPoProlazu),
    maxUsdPoPustanju: asPositiveNumber(raw.maxUsdPoPustanju, d.maxUsdPoPustanju),
    maxUsdPoZadatku: asPositiveNumber(raw.maxUsdPoZadatku, d.maxUsdPoZadatku),
    maxUsdDnevno: asPositiveNumber(raw.maxUsdDnevno, d.maxUsdDnevno),
    maxUdioSpawnova: udio,
    najstarijiZaAutomatskiDana: asPositiveNumber(raw.najstarijiZaAutomatskiDana, d.najstarijiZaAutomatskiDana),
    minSlobodnogDiskaPosto: asPositiveNumber(raw.minSlobodnogDiskaPosto, d.minSlobodnogDiskaPosto),
    bez429Minuta: asPositiveNumber(raw.bez429Minuta, d.bez429Minuta),
    projektiUvijekCovjeku: asStringArray(raw.projektiUvijekCovjeku ?? raw[STARI_KLJUC_PROJEKATA], d.projektiUvijekCovjeku),
    podsjetnikCovjekSati: asPositiveNumber(raw.podsjetnikCovjekSati, d.podsjetnikCovjekSati),
    podsjetnikRizikDana: asPositiveNumber(raw.podsjetnikRizikDana, d.podsjetnikRizikDana),
    maxKrugovaKriticara: asPositiveNumber(raw.maxKrugovaKriticara, d.maxKrugovaKriticara),
    izuzetiNositelji: izuzeti,
    jeftiniAgenti: asStringArray(raw.jeftiniAgenti, d.jeftiniAgenti),
    rizikPretezeUvijek: raw.rizikPretezeUvijek === true,
  }
}

/** Preskočen prolaz revizije (ručna kočnica, pad API-ja) ponavlja se brzo, ne za cijeli interval (QA-5205 N3). */
export const PONOVI_PRESKOCENI_PROLAZ_MS = 5 * 60_000

/**
 * Vrijednost za `lastBlockedReviewCheck` nakon preskočenog prolaza: sljedeći pokušaj za 5 min
 * (ili za interval, ako je kraći). Bez toga se prvi prolaz nakon `restart_kad_mirno.sh`, koji
 * restarta pod kočnicom, gubio na cijelih 60 min.
 */
export function zadnjiProlazZaPonavljanje(now: number, intervalMinutes: number, ponoviZaMs = PONOVI_PRESKOCENI_PROLAZ_MS): number {
  const iv = intervalMinutes * 60_000
  return now - iv + Math.min(ponoviZaMs, iv)
}

export type NacinRevizije = 'off' | 'shadow' | 'on'

/** Prekidač (§8.1): `revizijaBlokiranih` / `revizijaBlokiranihLive` u features.json. */
export function nacinRevizije(isEnabled: (name: string) => boolean): NacinRevizije {
  if (!isEnabled('revizijaBlokiranih')) return 'off'
  return isEnabled('revizijaBlokiranihLive') ? 'on' : 'shadow'
}

// ─── Odgoda (§5.3) ─────────────────────────────────────────────────────────────────────
/** Stabilan [0,1) iz niza — isti zadatak i isti redrive daju isto vrijeme na ploči i u daemonu. */
function stabilanRand(kljuc: string): () => number {
  let h = 2166136261
  for (let i = 0; i < kljuc.length; i++) { h ^= kljuc.charCodeAt(i); h = Math.imul(h, 16777619) }
  const v = (h >>> 0) / 4294967296
  return () => v
}

const H_MS = 3_600_000
const D_MS = 24 * H_MS

/** Sljedeći višekratnik koraka iza `now` (najmanje jedan korak od ulaska). */
function sljedeciKorak(ulazakMs: number, korakMs: number, now?: number): number {
  const k = now === undefined ? 1 : Math.max(1, Math.ceil((now - ulazakMs) / korakMs))
  return ulazakMs + korakMs * k
}

export function sljedecaRevizijaMs(
  klasa: BlokKlasa, redrive: number, ulazakMs: number, cfg: BlockedReviewConfig = DEFAULT_BLOCKED_REVIEW_CONFIG,
  opts: { rand?: () => number; taskId?: string; now?: number } = {},
): number | null {
  switch (klasa) {
    case 'prolazno': {
      const rand = opts.rand ?? stabilanRand(`${opts.taskId || ''}#${redrive}`)
      return ulazakMs + jitteredBackoff(redrive + 1, { stepMs: 6 * H_MS, maxMs: 72 * H_MS, rand })
    }
    case 'kriticar': case 'deploy': case 'lanac': return ulazakMs + H_MS
    case 'covjek': case 'odluka': case 'nepoznato': return sljedeciKorak(ulazakMs, cfg.podsjetnikCovjekSati * H_MS, opts.now)
    case 'sustav': case 'sigurnost': case 'novac': case 'vanjsko': return sljedeciKorak(ulazakMs, cfg.podsjetnikRizikDana * D_MS, opts.now)
    default: return null
  }
}

// ─── Odluka (§5) ───────────────────────────────────────────────────────────────────────
export type BlockedVerdict = 'ceka' | 'izuzet' | 'pusti' | 'otpusti-lanac' | 'popravi-lanac'
  | 'zatvori-deploy' | 'covjeku' | 'razina2' | 'strop'
/** Presude koje zadatak vraćaju u rad — samo za njih vrijedi `klaseUzivo` i proračun. */
export const PUSTANJA: BlockedVerdict[] = ['pusti', 'otpusti-lanac', 'zatvori-deploy']

export interface UzrokProvjera { ok: boolean; razlog: string }
export interface RoditeljLanca { id: string; status: string; imaBlocks: boolean }
export interface DeployProvjera { servis: string | null; exit: number | null; izlaz: string }

export interface BlockedReviewInput {
  now: number
  config: BlockedReviewConfig
  /** Trenutak ulaska u `blocked` (zadnji redak `task_history`), ne `updated_at`. */
  ulazakMs: number
  redrive: number
  uzrokNestao: UzrokProvjera
  projektArhiviran: boolean
  /** ID kasnijeg `completed` zadatka koji spominje ovaj (kandidat „riješeno drugdje”). */
  rjesenoDrugdje: string | null
  procjenaUsd: number
  ukupnoUsd: number
  lanac?: RoditeljLanca[]
  deploy?: DeployProvjera
  /** P0a (popravci kritičara) u pogonu i `criticRepairLoopLive` — tek tada kritičar ide dalje. */
  kriticarSpreman?: boolean
}

export interface BlockedDecision {
  taskId: string
  title: string
  assignee: string
  klasa: BlokKlasa
  izvor: string
  presuda: BlockedVerdict
  razlog: string
  redrive: number
  ulazakMs: number
  sljedecaRevizijaMs: number | null
  procjenaUsd: number
  /** Nove oznake kad presuda nešto mijenja (puštanje, čovjeku, strop); inače undefined. */
  oznake?: string[]
  /** Roditelji kojima nedostaje `blocks` (popravi-lanac). */
  roditeljiBezBlocks?: string[]
}

const ASSIGNEE_BEZ_AGENTA = ['regoc', 'user', '']

export function decideBlockedTask(task: BlockedTask, u: BlockedReviewInput): BlockedDecision {
  const cfg = u.config
  const assignee = String(task.assignee || '').trim().toLowerCase()
  const tags = listaOznaka(task.tags)
  const { klasa, izvor, rizik } = klasificirajBlokadu(task, { projektiUvijekCovjeku: cfg.projektiUvijekCovjeku, rizikPreteze: cfg.rizikPretezeUvijek })
  const redrive = Math.max(u.redrive, redriveIzOznaka(tags))
  const sljedeca = sljedecaRevizijaMs(klasa, redrive, u.ulazakMs, cfg, { taskId: task.id, now: u.now })
  const base = {
    taskId: task.id, title: task.title || '', assignee, klasa, izvor, redrive,
    ulazakMs: u.ulazakMs, sljedecaRevizijaMs: sljedeca, procjenaUsd: u.procjenaUsd,
  }
  const odl = (presuda: BlockedVerdict, razlog: string, extra: Partial<BlockedDecision> = {}): BlockedDecision =>
    ({ ...base, presuda, razlog, ...extra })
  const covjeku = (k: BlokKlasa, razlog: string, presuda: BlockedVerdict = 'covjeku'): BlockedDecision => {
    const potrebne = RIZICNE_KLASE.includes(k) ? ['waiting-for-human', 'no-autonomy'] : ['waiting-for-human']
    const oznake = dodajOznake(withBlokTag(tags, k), ...potrebne)
    return odl(presuda, razlog, { oznake })
  }

  // Izuzeća su ista kao za in_progress, osim `waiting-for-human`: takve revizija broji i
  // podsjeća na njih — samo ih nikad ne pušta (§4.1).
  const excl = exclusionReason(task, assignee, {
    excludeTags: ['no-watchdog', 'interactive'], excludeAssignees: cfg.izuzetiNositelji, excludeTaskIds: [], onlyTaskIds: [],
  })
  if (excl) return odl('izuzet', excl)

  const danaUBlocked = (u.now - u.ulazakMs) / D_MS
  const prestar = danaUBlocked > cfg.najstarijiZaAutomatskiDana

  if (UVIJEK_COVJEKU.includes(klasa)) {
    const potrebne = [`blok:${klasa}`, 'waiting-for-human', ...(RIZICNE_KLASE.includes(klasa) ? ['no-autonomy'] : [])]
    const nedostaje = potrebne.filter(o => !tags.map(t => t.toLowerCase()).includes(o))
    if (nedostaje.length > 0) return covjeku(klasa, `uvijek čovjeku (${izvor}) — ne puštam sam`)
    if ((klasa === 'covjek' || klasa === 'odluka') && prestar) {
      return odl('razina2', `čeka čovjeka ${Math.floor(danaUBlocked)} d (> ${cfg.najstarijiZaAutomatskiDana} d) — razina 2: prijedlog [ARHIVA] ili pitanje`)
    }
    return odl('ceka', `čeka čovjeka (${izvor})`)
  }

  switch (klasa) {
    case 'zastarjelo': return odl('ceka', 'zastarjelo — ide u tjedni popis [ARHIVA] za vlasnika (nikad cancelled)')
    case 'datum': return odl('ceka', 'čeka nadnevak ili strojni okidač — otpušta budilica/okidač, ne revizija')
    case 'nepoznato': return odl('razina2', 'bez klase — razina 2 dodjeljuje klasu')
    case 'kriticar': {
      let krug = 0
      for (const t of tags) { const m = KRITIKA_TAG.exec(t); if (m) krug = Math.max(krug, Number(m[1])) }
      if (krug >= cfg.maxKrugovaKriticara) return covjeku('covjek', `${krug}/${cfg.maxKrugovaKriticara} krugova kritičara potrošeno`, 'strop')
      if (!u.kriticarSpreman) return odl('ceka', 'kritičar: ne puštam dok P0a (popravci kritičara) i criticRepairLoopLive nisu u pogonu')
      return odl('ceka', 'kritičar: put je CriticRepairLoop (kritika:<n>), ne redrive')
    }
    case 'deploy': {
      if (!u.deploy) return odl('ceka', 'deploy: provjera StaleCodeCheck nije izvedena u ovom prolazu')
      if (!u.deploy.servis) return odl('razina2', 'deploy: razlog ne imenuje servis')
      if (u.deploy.exit === 0) return odl('zatvori-deploy', `deploy izveden — StaleCodeCheck ${u.deploy.servis} exit 0: ${u.deploy.izlaz.slice(0, 300)}`)
      return odl('ceka', `deploy: ${u.deploy.servis} još vrti stari kod (exit ${u.deploy.exit})`)
    }
    case 'lanac': {
      const rod = u.lanac || []
      if (rod.length === 0) return odl('razina2', 'lanac: roditelj se ne može odrediti (ni blockedBy ni ID u razlogu)')
      const bez = rod.filter(r => !r.imaBlocks && r.status !== 'completed').map(r => r.id)
      if (bez.length > 0) return odl('popravi-lanac', `roditelju ${bez.join(', ')} nedostaje blocks → ${task.id}`, { roditeljiBezBlocks: bez })
      if (rod.every(r => r.status === 'completed')) {
        if (rizik) return covjeku(rizik.klasa, `lanac otpušten, ali rizik ${rizik.naziv} („${rizik.pogodak}”) — uvijek čovjeku, ne puštam sam`)
        return odl('otpusti-lanac', `svi roditelji completed (${rod.map(r => r.id).join(', ')})`, { oznake: withBlokTag(tags, 'lanac') })
      }
      return odl('ceka', `lanac: čeka ${rod.filter(r => r.status !== 'completed').map(r => `${r.id} (${r.status})`).join(', ')}`)
    }
  }

  // prolazno — provjera stvarnosti PRIJE svakog puštanja (§5.1, zaštita od Dorinih 37/52)
  if (u.projektArhiviran) return odl('razina2', 'projekt je archived')
  if (/^\s*\[ARHIVA\]/i.test(task.title || '')) return odl('razina2', 'naslov je [ARHIVA]')
  if (prestar) return odl('razina2', `u blocked ${Math.floor(danaUBlocked)} d (> ${cfg.najstarijiZaAutomatskiDana} d) — vjerojatno zastarjelo`)
  if (u.rjesenoDrugdje) return odl('razina2', `kandidat „riješeno drugdje”: ${u.rjesenoDrugdje} (completed) spominje ovaj zadatak`)
  if (ASSIGNEE_BEZ_AGENTA.includes(assignee)) return odl('razina2', `assignee '${assignee || '—'}' nije agent koji se može pustiti`)
  if (redrive >= cfg.maxRedrive) return covjeku('covjek', `${redrive}/${cfg.maxRedrive} puštanja potrošeno`, 'strop')
  if (u.ukupnoUsd > cfg.maxUsdPoZadatku) return covjeku('novac', `zadatak je već potrošio ${u.ukupnoUsd.toFixed(2)} USD (> ${cfg.maxUsdPoZadatku})`, 'strop')
  if (u.procjenaUsd > cfg.maxUsdPoPustanju) return covjeku('novac', `procjena puštanja ${u.procjenaUsd.toFixed(2)} USD > ${cfg.maxUsdPoPustanju} USD`)
  if (sljedeca !== null && u.now < sljedeca) return odl('ceka', `sljedeća revizija za ${formatAge(sljedeca - u.now)} (puštanje ${redrive + 1}/${cfg.maxRedrive})`)
  if (!u.uzrokNestao.ok) return odl('ceka', `uzrok nije nestao: ${u.uzrokNestao.razlog}`)
  if (rizik) return covjeku(rizik.klasa, `rizik ${rizik.naziv} („${rizik.pogodak}”) — uvijek čovjeku, ne puštam sam`)
  return odl('pusti', `prolazno (${izvor}), uzrok nestao (${u.uzrokNestao.razlog}) — vraćam u red (${redrive + 1}/${cfg.maxRedrive}, ≈${u.procjenaUsd.toFixed(2)} USD)`,
    { oznake: withRedriveTag(withBlokTag(tags, 'prolazno'), redrive + 1) })
}

export interface BlockedBudget {
  /** Zbroj procjena puštenih u zadnja 24 h (iz `revizija_blokiranih.jsonl`, mode live). */
  pustenoUsdDanas: number
  pustenoBrojDanas: number
  /** Spawnova u zadnja 24 h (`run_log.jsonl`). */
  spawnova24h: number
}

/**
 * Presude za sve blokirane + proračun prolaza (§5.4). Puštanja se dijele od najstarijeg
 * ulaska; ono što ne stane u proračun dobiva `ceka` s razlogom „proračun: …”.
 */
export function evaluateBlockedTasks(
  tasks: BlockedTask[],
  opts: { now: number; config: BlockedReviewConfig; ulaz: (t: BlockedTask) => BlockedReviewInput; budzet: BlockedBudget },
): BlockedDecision[] {
  const cfg = opts.config
  const sve = (tasks || []).map(t => decideBlockedTask(t, { ...opts.ulaz(t), now: opts.now, config: cfg }))
  const udioMax = Math.max(2, Math.floor(cfg.maxUdioSpawnova * opts.budzet.spawnova24h))
  let n = 0
  let usd = opts.budzet.pustenoUsdDanas
  const kandidati = sve.filter(d => d.presuda === 'pusti' || d.presuda === 'otpusti-lanac').sort((a, b) => a.ulazakMs - b.ulazakMs)
  for (const d of kandidati) {
    const preko =
      n >= cfg.maxPustanjaPoProlazu ? `${cfg.maxPustanjaPoProlazu} puštanja po prolazu`
      : usd + d.procjenaUsd > cfg.maxUsdDnevno ? `dnevni ${usd.toFixed(2)} + ${d.procjenaUsd.toFixed(2)} > ${cfg.maxUsdDnevno} USD`
      : opts.budzet.pustenoBrojDanas + n >= udioMax ? `udio ${udioMax} od ${opts.budzet.spawnova24h} spawnova u 24 h`
      : null
    if (preko) {
      d.razlog = `proračun: ${preko} — ${d.razlog}`
      d.presuda = 'ceka'
      d.oznake = undefined
      continue
    }
    n++
    usd += d.procjenaUsd
  }
  return sve
}

/** Jedan redak dnevnika — isti u daemonu i u izvještaju. */
export function formatBlockedDecisionLine(d: BlockedDecision): string {
  const mark: Record<BlockedVerdict, string> = {
    ceka: '⏳', izuzet: '⏸️', pusti: '🔁', 'otpusti-lanac': '🔗', 'popravi-lanac': '🔧',
    'zatvori-deploy': '✅', covjeku: '🙋', razina2: '🔎', strop: '⛔',
  }
  return `${mark[d.presuda]} ${d.taskId.padEnd(10)} ${(d.assignee || '-').padEnd(9)} ${d.klasa.padEnd(10)} ${d.presuda.padEnd(13)} ${d.razlog}`
}

// ─── Ulazi iz baze i okoline (zajedničko daemonu i izvještaju) ─────────────────────────
// I/O je ovdje, a ne u daemonu, iz istog razloga kao `makeCheckpointLookup`: izvještaj
// „što BI revizija napravila” mora čitati isto što i daemon, inače laže.

type Db = { prepare: (sql: string) => { get: (...args: any[]) => any; all: (...args: any[]) => any[] } }

/**
 * Dnevnik presuda i run log piše DAEMON koji revidira (izvorni sustav domaćina — na čvoru je to
 * komplet uz paket), a ploča ih samo čita. Mapa: `TM_IZVORNI_PODACI`, bez nje podaci paketa.
 */
export function izvorniPodaci(): string {
  return (process.env.TM_IZVORNI_PODACI || '').trim() || TM_DATA
}
export const putanjaDnevnikaRevizije = () => join(izvorniPodaci(), 'revizija_blokiranih.jsonl')
export const putanjaRunLoga = () => join(izvorniPodaci(), 'run_log.jsonl')

function parseVrijeme(s: unknown): number {
  if (typeof s !== 'string' || !s) return NaN
  // SQLite `datetime('now')` nema zonu, a znači UTC.
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z')
}

/** Zadnji redak u kojem je JSONL stariji od `odMs` se preskače — čita se samo rep datoteke. */
function citajJsonlRep(path: string, maxBajtova = 2_000_000): any[] {
  try {
    if (!existsSync(path)) return []
    const s = readFileSync(path, 'utf-8')
    const rep = s.length > maxBajtova ? s.slice(s.length - maxBajtova) : s
    const out: any[] = []
    for (const l of rep.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)) } catch { /* poluzapis */ } }
    return out
  } catch { return [] }
}
/** Proračun za danas iz vlastitog dnevnika (puštanja uživo) i `run_log.jsonl` (spawnovi). */
export function procitajBudzet(now: number, logPath = putanjaDnevnikaRevizije(), runLog = putanjaRunLoga()): BlockedBudget {
  const od = now - 24 * 3_600_000
  let usd = 0, broj = 0
  for (const r of citajJsonlRep(logPath)) {
    if (r?.nacin !== 'live' || !r?.izvedeno) continue
    if (r.presuda !== 'pusti' && r.presuda !== 'otpusti-lanac') continue
    if (parseVrijeme(r.ts) < od) continue
    usd += Number(r.usd_procjena) || 0
    broj++
  }
  let spawnova = 0
  for (const r of citajJsonlRep(runLog)) if (parseVrijeme(r?.ts) >= od) spawnova++
  return { pustenoUsdDanas: usd, pustenoBrojDanas: broj, spawnova24h: spawnova }
}

const TASK_ID = /\bTASK-\d+\b/g
/** Zadatak koji spominje više od ovoliko ID-eva je skupni izvještaj (npr. Dorina revizija) — nije „riješeno drugdje”. */
const SKUPNI_IZVJESTAJ_ID = 10

/**
 * Lookup ulaza za `decideBlockedTask` nad bazom ploče. Skupi upiti se rade jednom po prolazu
 * (troškovi, projekti), a po zadatku samo indeksirani `get`.
 */
export function makeBlockedReviewLookup(db: Db, opts: {
  now: number; config: BlockedReviewConfig; uzrok: UzrokProvjera
  deploy?: (servis: string) => DeployProvjera
  kriticarSpreman?: boolean
}): (t: BlockedTask) => BlockedReviewInput {
  const arhivirani = new Set<string>()
  try { for (const r of db.prepare("SELECT id FROM projects WHERE status = 'archived'").all()) arhivirani.add(String(r.id)) } catch { /* bez projekata */ }

  const ukupno = new Map<string, number>()
  const poAgentu = new Map<string, number[]>()
  try {
    for (const r of db.prepare('SELECT task_id, SUM(cost_usd) s FROM cost_log WHERE task_id IS NOT NULL GROUP BY task_id').all()) {
      ukupno.set(String(r.task_id), Number(r.s) || 0)
    }
    for (const r of db.prepare(
      "SELECT agent_id, task_id, SUM(cost_usd) s FROM cost_log WHERE task_id IS NOT NULL AND timestamp > datetime('now', '-14 days') GROUP BY agent_id, task_id",
    ).all()) {
      const a = String(r.agent_id || '').toLowerCase()
      if (!poAgentu.has(a)) poAgentu.set(a, [])
      poAgentu.get(a)!.push(Number(r.s) || 0)
    }
  } catch { /* bez cost_log → zadane procjene */ }
  const medijan = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2 }

  const ulazakQ = db.prepare("SELECT MAX(changed_at) t FROM task_history WHERE task_id = ? AND field = 'status' AND new_value = 'blocked'")
  const zadatakQ = db.prepare('SELECT id, status, blocks, project_id FROM tasks WHERE id = ?')
  const kandidatiQ = db.prepare(
    "SELECT id, description, result_summary FROM tasks WHERE status = 'completed' AND id != ? AND completed_at > ? " +
    "AND (description LIKE '%' || ? || '%' OR result_summary LIKE '%' || ? || '%') ORDER BY completed_at LIMIT 20",
  )

  return (t: BlockedTask): BlockedReviewInput => {
    const id = t.id
    const zapis = (() => { try { return zadatakQ.get(id) } catch { return null } })()
    let ulazakMs = NaN
    try { ulazakMs = parseVrijeme(ulazakQ.get(id)?.t) } catch { /* bez povijesti */ }
    if (!Number.isFinite(ulazakMs)) ulazakMs = parseVrijeme(t.updatedAt) || parseVrijeme(t.createdAt) || opts.now
    const projekt = String(t.projectId || zapis?.project_id || '')

    let rjeseno: string | null = null
    // Skupi LIKE upit (≈10 ms po zadatku) samo ondje gdje ga presuda čita: mladi `prolazno` (§5.1).
    // Ploča zove lookup svake minute; za ostale klase i prestare zadatke ishod je isti bez njega.
    const trebaRjeseno = (opts.now - ulazakMs) / D_MS <= opts.config.najstarijiZaAutomatskiDana &&
      klasificirajBlokadu(t, { projektiUvijekCovjeku: opts.config.projektiUvijekCovjeku, rizikPreteze: opts.config.rizikPretezeUvijek }).klasa === 'prolazno'
    if (trebaRjeseno) try {
      const odIso = new Date(ulazakMs).toISOString()
      const re = new RegExp(`\\b${id}\\b`)
      for (const k of kandidatiQ.all(id, odIso, id, id)) {
        const tekst = `${k.description || ''}\n${k.result_summary || ''}`
        if (!re.test(tekst)) continue                                   // TASK-50 ≠ TASK-5000
        if (new Set(tekst.match(TASK_ID) || []).size > SKUPNI_IZVJESTAJ_ID) continue
        rjeseno = String(k.id); break
      }
    } catch { /* heuristika — bez nje se ne pušta ništa manje sigurno */ }

    const agent = String(t.assignee || '').toLowerCase()
    const uzorak = poAgentu.get(agent) || []
    const procjena = uzorak.length >= 3 ? medijan(uzorak) : (opts.config.jeftiniAgenti.includes(agent) ? 1 : 5)

    let lanac: RoditeljLanca[] | undefined
    const roditelji = Array.isArray(t.blockedBy) && t.blockedBy.length > 0
      ? t.blockedBy
      : Array.from(new Set((String(t.blockedReason || '').replace(DORIN_PREFIKS, '').match(TASK_ID) || []))).filter(x => x !== id)
    if (roditelji.length > 0) {
      lanac = roditelji.map(pid => {
        const r = (() => { try { return zadatakQ.get(pid) } catch { return null } })()
        let blocks: string[] = []
        try { blocks = JSON.parse(r?.blocks || '[]') } catch { /* prazno */ }
        return { id: pid, status: String(r?.status || 'nepostoji'), imaBlocks: blocks.includes(id) }
      })
    }

    const servis = servisIzRazloga(t.blockedReason)
    const deploy = servis && opts.deploy ? opts.deploy(servis) : (servis ? undefined : { servis: null, exit: null, izlaz: '' })

    return {
      now: opts.now, config: opts.config, ulazakMs, redrive: redriveIzOznaka(t.tags), uzrokNestao: opts.uzrok,
      projektArhiviran: arhivirani.has(projekt), rjesenoDrugdje: rjeseno, procjenaUsd: Math.round(procjena * 100) / 100,
      ukupnoUsd: ukupno.get(id) || 0, lanac, deploy, kriticarSpreman: !!opts.kriticarSpreman,
    }
  }
}

/** Redak dnevnika revizije (§3) — isti oblik u sjeni i uživo. */
export function zapisRevizije(d: BlockedDecision, nacin: NacinRevizije, izvedeno: boolean, now = Date.now()): Record<string, unknown> {
  return {
    ts: new Date(now).toISOString(), taskId: d.taskId, klasa: d.klasa, pravilo: d.izvor, presuda: d.presuda,
    razlog: d.razlog, nacin: nacin === 'on' ? 'live' : 'shadow', izvedeno, redrive: d.redrive,
    usd_procjena: d.procjenaUsd, sljedeca: d.sljedecaRevizijaMs ? new Date(d.sljedecaRevizijaMs).toISOString() : null,
  }
}
// ─── Pregled za ploču (§9): tri skupine koje vlasnik traži ───────────────────────────────
/** `ponovno` = sustav će ponovno pokušati · `covjeku` = čeka čovjeka · `istroseno` = pokušaji potrošeni · `ostalo`. */
export type SkupinaBlokade = 'ponovno' | 'covjeku' | 'istroseno' | 'ostalo'

const LJUDSKE_OZNAKE = ['waiting-for-human', 'needs-decision', 'no-autonomy']

/**
 * Skupina na ploči iz PRESUDE `decideBlockedTask` — iste funkcije kojom sudi daemon (QA-5205 N1).
 * Ranije je skupina išla samo iz klase, pa su izuzeti (`no-watchdog`), prestari (> najstarijiZaAutomatskiDana,
 * razina 2) i lanci sa zapetim roditeljem stajali pod „sustav će ponovno pokušati”, a daemon ih nikad ne pušta.
 * `ceka` i puštanje su ista skupina: razlika (uzrok nestao, StaleCodeCheck, proračun) je mjerenje
 * okoline u trenutku prolaza, ne pravilo koje bi ploča smjela drugačije pokazati.
 */
export function skupinaBlokade(
  t: BlockedTask, d: Pick<BlockedDecision, 'klasa' | 'presuda'>, cfg: BlockedReviewConfig, rizik: RizikPogodak | null = null,
): SkupinaBlokade {
  const klasa = d.klasa
  if (d.presuda === 'strop') return 'istroseno'
  if (d.presuda === 'covjeku') return 'covjeku'
  const tags = listaOznaka(t.tags).map(x => x.toLowerCase())
  let krug = 0
  for (const x of tags) { const m = KRITIKA_TAG.exec(x); if (m) krug = Math.max(krug, Number(m[1])) }
  if (redriveIzOznaka(tags) >= cfg.maxRedrive || (klasa === 'kriticar' && krug >= cfg.maxKrugovaKriticara)) return 'istroseno'
  if (UVIJEK_COVJEKU.includes(klasa) || tags.some(x => LJUDSKE_OZNAKE.includes(x))) return 'covjeku'
  // Pogodak rizika: revizija ga u trenutku puštanja predaje čovjeku, pa „sustav će pokušati” bi lagao.
  if (rizik && (klasa === 'prolazno' || klasa === 'lanac')) return 'covjeku'
  // Izuzet i razina 2: daemon ih ne pušta sam. „Čeka tebe” ostaje (ljudski rad se ne skriva),
  // ali „sustav će ponovno pokušati” bi lagao.
  if (d.presuda === 'izuzet' || d.presuda === 'razina2') return 'ostalo'
  if (['prolazno', 'lanac', 'deploy', 'kriticar'].includes(klasa)) return 'ponovno'
  return 'ostalo'
}

/** Status roditelja iz kojeg lanac nikad sam ne kreće (otkazan ili ga nema). */
const MRTVI_RODITELJ = ['cancelled', 'nepostoji']

/** Ljudski opis onoga na što zadatak čeka — bez strojnih prefiksa. */
export function cekaNa(reason: string | null | undefined): string {
  return String(reason || '').replace(DORIN_PREFIKS, '').replace(KOD_KLASE, '')
    .replace(/^BLOCKED: Agent je sam deklarirao BLOCKED:\s*/i, '').trim().slice(0, 240)
}

export interface PregledZadatak {
  id: string; title: string; assignee: string; klasa: BlokKlasa; skupina: SkupinaBlokade
  /** Presuda `decideBlockedTask` nad istim ulazima kao daemon (okolinu ploča ne mjeri). */
  presuda: BlockedVerdict; razlog: string
  /** Samo za skupinu „ponovno” — za ono što se ne pušta nema roka (QA-5205 N1). */
  redrive: number; maxRedrive: number; sljedecaRevizija: string | null; cekaNa: string
  rizik: string | null; zadnjaPresuda: { ts: string; presuda: string; razlog: string; nacin: string } | null
}

/** Ulaz bez baze (stari pozivatelji, testovi): okolina se ne mjeri, roditelji su iz popisa blokiranih. */
function ulazBezBaze(t: BlockedTask, ul: number, now: number, cfg: BlockedReviewConfig, blokirani: Set<string>): BlockedReviewInput {
  const rod = Array.isArray(t.blockedBy) ? t.blockedBy.filter(x => x && x !== t.id) : []
  return {
    now, config: cfg, ulazakMs: ul, redrive: redriveIzOznaka(t.tags),
    uzrokNestao: { ok: false, razlog: 'ploča ne mjeri okolinu' },
    projektArhiviran: false, rjesenoDrugdje: null, procjenaUsd: 0, ukupnoUsd: 0,
    lanac: rod.length ? rod.map(id => ({ id, status: blokirani.has(id) ? 'blocked' : 'nepoznato', imaBlocks: true })) : undefined,
  }
}

export function pregledBlokiranih(tasks: BlockedTask[], o: {
  now: number; config: BlockedReviewConfig; nacin: NacinRevizije
  ulazak: (id: string) => number | null
  zadnja: Map<string, any>
  budzet: BlockedBudget
  /** Ulaz za `decideBlockedTask` (ploča: `makeBlockedReviewLookup` bez StaleCodeCheck i bez mjerenja okoline). */
  ulaz?: (t: BlockedTask) => BlockedReviewInput
}) {
  const poKlasi: Record<string, number> = Object.fromEntries(BLOK_KLASE.map(k => [k, 0]))
  const skupine: Record<SkupinaBlokade, number> = { ponovno: 0, covjeku: 0, istroseno: 0, ostalo: 0 }
  const blokirani = new Set((tasks || []).map(t => t.id))
  const rows: Array<{ z: PregledZadatak; d: BlockedDecision; roditelji: RoditeljLanca[] }> = []
  for (const t of tasks || []) {
    const ul = o.ulazak(t.id) ?? (Date.parse(String(t.updatedAt || '')) || o.now)
    const u0 = o.ulaz ? o.ulaz(t) : ulazBezBaze(t, ul, o.now, o.config, blokirani)
    const u: BlockedReviewInput = { ...u0, now: o.now, config: o.config, ulazakMs: ul }
    const d = decideBlockedTask(t, u)
    const k = klasificirajBlokadu(t, { projektiUvijekCovjeku: o.config.projektiUvijekCovjeku, rizikPreteze: o.config.rizikPretezeUvijek })
    const z = o.zadnja.get(t.id)
    rows.push({
      d, roditelji: d.klasa === 'lanac' ? (u.lanac || []) : [],
      z: {
        id: t.id, title: t.title || '', assignee: String(t.assignee || ''), klasa: d.klasa,
        skupina: skupinaBlokade(t, d, o.config, k.rizik ?? null), presuda: d.presuda, razlog: d.razlog,
        redrive: d.redrive, maxRedrive: o.config.maxRedrive,
        sljedecaRevizija: d.sljedecaRevizijaMs ? new Date(d.sljedecaRevizijaMs).toISOString() : null,
        cekaNa: cekaNa(t.blockedReason), rizik: k.rizik ? `${k.rizik.naziv} („${k.rizik.pogodak}”)` : null,
        zadnjaPresuda: z ? { ts: z.ts, presuda: z.presuda, razlog: z.razlog, nacin: z.nacin } : null,
      },
    })
  }
  // Lanac je „ponovno” samo ako mu roditelj može krenuti: roditelj otkazan/nepostojeći ili sam
  // blokiran izvan „ponovno” (razina 2, izuzet, čeka čovjeka) → ni dijete se neće pomaknuti samo.
  // Ponavlja se do ustaljenja, jer zapinjanje putuje niz lanac (unuk zapetog roditelja).
  const poId = new Map(rows.map(r => [r.z.id, r]))
  for (let promjena = true, krug = 0; promjena && krug <= rows.length; krug++) {
    promjena = false
    for (const r of rows) {
      if (r.z.skupina !== 'ponovno' || r.roditelji.length === 0) continue
      const zapeo = r.roditelji.find(p => MRTVI_RODITELJ.includes(p.status) || (poId.has(p.id) && poId.get(p.id)!.z.skupina !== 'ponovno'))
      if (!zapeo) continue
      const rp = poId.get(zapeo.id)
      const zasto = rp ? (rp.z.presuda === 'razina2' ? 'na razini 2' : rp.z.presuda === 'izuzet' ? 'izuzet iz revizije'
        : rp.z.skupina === 'covjeku' ? 'čeka čovjeka' : rp.z.skupina === 'istroseno' ? 'pokušaji potrošeni' : 'ne kreće sam') : zapeo.status
      r.z.skupina = 'ostalo'
      r.z.cekaNa = `čeka ${zapeo.id} (${zasto}) — sustav ga neće sam pokrenuti`
      promjena = true
    }
  }
  const zadaci: PregledZadatak[] = []
  for (const { z } of rows) {
    if (z.skupina !== 'ponovno') z.sljedecaRevizija = null
    poKlasi[z.klasa] = (poKlasi[z.klasa] || 0) + 1
    skupine[z.skupina]++
    zadaci.push(z)
  }
  return {
    nacin: o.nacin, klaseUzivo: o.config.klaseUzivo, poKlasi, skupine, zadaci,
    proracun: {
      danasUsd: Math.round(o.budzet.pustenoUsdDanas * 100) / 100, danasBroj: o.budzet.pustenoBrojDanas,
      maxUsdDnevno: o.config.maxUsdDnevno, maxPustanjaPoProlazu: o.config.maxPustanjaPoProlazu, maxRedrive: o.config.maxRedrive,
    },
  }
}

/** Zadnja presuda po zadatku iz dnevnika (za ploču i detalje). */
export function zadnjePresude(logPath = putanjaDnevnikaRevizije()): Map<string, any> {
  const m = new Map<string, any>()
  for (const r of citajJsonlRep(logPath)) if (r?.taskId) m.set(r.taskId, r)
  return m
}

/** Povijest presuda za jedan zadatak (detalji zadatka). */
export function povijestPresuda(taskId: string, limit = 30, logPath = putanjaDnevnikaRevizije()): any[] {
  return citajJsonlRep(logPath).filter(r => r?.taskId === taskId).slice(-limit)
}
