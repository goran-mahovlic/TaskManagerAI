/**
 * TjedniPregled — „Potrošnja" na ploči 17781 (TASK-3569 T5; TASK-3572 T8, mjera 6)
 *
 * Mjera 6 iz ISTRAZIVANJE_AGENTSIGHT_2026-09-01.md §7: agregacija `run_log.jsonl`
 * i telemetrije NAŠIH transkripata (`~/.claude/projects/**\/*.jsonl`) po projektu
 * (`tasks.project_id`) i po agentu za zadnjih N dana.
 *
 * Izračun se ovdje NE duplicira — sve radi `tools/tjedni_pregled.py`,
 * koji za pojedino izvođenje zove `agent_telemetry.py` (kriške T2/T3). Ovaj modul je
 * samo prijenos: poziv alata, keš, propusnica i svođenje na oblik koji pregled prikazuje.
 *
 * Tri pravila koja ovaj modul provodi:
 *   1. IZRAČUN NE SMIJE BLOKIRATI PLOČU. Hladan prolaz nad sedam dana traje ~2,3 s
 *      (89 izvođenja, 89 MB transkripata), a alat sam vodi keš na disku pa je topli
 *      prolaz ~0,15 s. Zahtjev ipak čeka najviše `PREGLED_WAIT_MS`; ako alat nije gotov,
 *      vraća se 202 `stanje:"racuna"`, izračun teče dalje i puni keš, klijent pita ponovno.
 *   2. PARAMETRI IDU U ARGV KAO BROJEVI, NIKAD KAO TEKST IZ URL-a. `dana` i `najskupljih`
 *      se pretvaraju u cijeli broj i stežu u raspon; neispravan parametar je 400, ne
 *      pokretanje pythona s tuđim nizom.
 *   4. FILTAR PO PROJEKTU JE ISTI ALAT, NE TREĆI. „Potrošnja projekta" (T8) zove
 *      `tjedni_pregled.py --projekt PRJ-060`; drugog izračuna nema, pa se brojka na
 *      kartici projekta i brojka u tjednom pregledu ne mogu razići. Ključ projekta
 *      ulazi u ključ keša i provjerava se uzorkom prije nego dođe do argv-a.
 *
 *   3. SVAKA BROJKA NOSI SVOJ NAZIVNIK. Sažimanje prenosi `izZadataka` uz trošak, tokene,
 *      latenciju, trajanje i alate — pregled bez nazivnika nije provjerljiv (zahtjev T5).
 */
import { join } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { sustavPutanja } from './core/paths'

const HOME = process.env.HOME || homedir()

/** Isti odabir kao u TaskTelemetry: paket prvo gleda uz sebe, pa u `TM_SUSTAV_DIR`. */
function prviPostojeci(putovi: string[]): string {
  for (const p of putovi) { try { if (existsSync(p)) return p } catch { /* dalje */ } }
  return putovi[putovi.length - 1]
}

export const PREGLED_SCRIPT = process.env.TM_PREGLED_SCRIPT
  || prviPostojeci([
       join(import.meta.dir, '..', 'tools', 'tjedni_pregled.py'),
       sustavPutanja('tools/tjedni_pregled.py'),
     ].filter((p): p is string => p !== null))

/** Razdoblje se mijenja tek novim izvođenjima; keš je tu da ploča ne pokreće python po kliku. */
export const PREGLED_TTL_MS = 5 * 60_000
/** Donja brana za „osvježi" — da tipka ne postane bujica procesa. */
export const PREGLED_MIN_REFRESH_MS = 20_000
/** Koliko zahtjev najviše čeka alat prije nego vrati 202 „računa se". */
export const PREGLED_WAIT_MS = 4_000
/** Hladan prolaz nad 7 dana traje ~2,3 s; ovo je brana od zaglavljenog procesa. */
export const PREGLED_TIMEOUT_MS = 90_000
/** Najviše istodobnih pythona (pregled je teži od kartice zadatka). */
export const PREGLED_MAX_PARALLEL = 1
/** Koliko različitih (dana, najskupljih) kombinacija držimo u kešu. */
export const PREGLED_CACHE_MAX = 12

export const DANA_MIN = 1
/**
 * „Svo vrijeme" na ploči je konačan broj dana, ne beskonačnost: `run_log.jsonl`
 * počinje 2026-07-28, a transkripti se čuvaju ~30 dana, pa 3650 pouzdano obuhvaća
 * sve što uopće postoji. Ista granica vrijedi i u `tjedni_pregled.py`.
 */
export const DANA_MAX = 3650
export const SVE_VRIJEME_DANA = 3650
/**
 * TASK-3691 (Goran, 04.09.2026.): „to se mora vući iz istog izvora! Ne smije biti razlike
 * i sve mora biti uključeno."
 *
 * Kartica projekta pokazuje UKUPNU potrošnju, a pregled je zadano gledao zadnjih 7 dana —
 * ista se brojka time razilazila (MUSZG: 316,79 € u pregledu, 1.388,83 € na kartici).
 * Izvor je oba puta isti (`cost_log` odnosno `run_log.jsonl`, provjereno: razilaze se za
 * 0,07 USD na 3 540, i to samo na 48 redaka bez `task_id`), pa je razlika bila ISKLJUČIVO
 * razdoblje. Zadano je sada „svo vrijeme"; kraća razdoblja ostaju kao izbor.
 */
export const ZADANO_DANA = SVE_VRIJEME_DANA
export const NAJSKUPLJIH_MIN = 1
export const NAJSKUPLJIH_MAX = 50
export const ZADANO_NAJSKUPLJIH = 5

/**
 * Dopušten oblik ključa projekta. Ključ ide u `argv` pythona, pa se ne prima
 * ništa osim slova, znamenki i `-_.`; „(bez projekta)" je jedina iznimka jer je
 * to doslovna oznaka skupine iz alata (`BEZ_PROJEKTA`).
 */
export const PROJEKT_UZORAK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/
export const BEZ_PROJEKTA = '(bez projekta)'

export interface AlatVrh {
  ime: string | null
  poziva: number | null
  neuspjelih: number | null
  udioPoziva: number | null
}

/** Skupina = ukupno, jedan projekt ili jedan agent. Svaka brojka nosi svoj nazivnik. */
export interface Skupina {
  kljuc: string
  naziv: string | null
  zadataka: number
  razlicitihZadataka: number
  sTranskriptom: number
  ishodi: Record<string, number>
  /**
   * M3/TASK-4625: tri stupca koja ploča prikazuje — `completed` (isporučeno),
   * `blocked_ok` (agent je SAM stao pred preprekom) i `failed` (kvar). `ishodi` iznad
   * ostaje puna raščlamba po sirovoj vrijednosti, pa se zbroj može provjeriti.
   * Preslikavanje radi `tjedni_pregled.py:stupac_ishoda`; SSOT je `RunOutcome.ts`.
   */
  ishodiStupci: { completed: number; blocked_ok: number; failed: number }
  trosak: { usd: number | null; izZadataka: number; usdPoZadatku: number | null }
  tokeni: {
    ulaz: number | null
    izlaz: number | null
    kesCitanje: number | null
    kesPisanje: number | null
    ulazniKontekst: number | null
    udioKesa: number | null
    izZadataka: number
  }
  latencija: {
    prosjekS: number | null
    medijanS: number | null
    p95S: number | null
    najvecaS: number | null
    pozivaModela: number
    izPoziva: number
    izZadataka: number
  }
  trajanje: {
    ukupnoS: number | null
    modelS: number | null
    alatS: number | null
    udioModel: number | null
    udioAlat: number | null
    izZadataka: number
  }
  alati: {
    poziva: number | null
    neuspjelih: number | null
    udioNeuspjelih: number | null
    vrh: AlatVrh[]
    izZadataka: number
  }
  trenje: { zadatakaSTrenjem: number; izgubljenoS: number | null; izZadataka: number }
}

export interface NajskupljiRedak {
  taskId: string | null
  naslov: string | null
  projectId: string | null
  agent: string | null
  model: string | null
  outcome: string | null
  pokrenutoTs: string | null
  trosakUsd: number | null
  trajanjeS: number | null
  pozivaModela: number | null
  prosjekLatencijeS: number | null
  ulazniKontekst: number | null
  udioKesa: number | null
  sessionId: string | null
}

export interface PregledPayload {
  dana: number
  od: string | null
  do: string | null
  izracunatoU: string | null
  /** Postavljeno samo kad je pregled filtriran na jedan projekt (T8). */
  projekt: { id: string; naziv: string | null } | null
  izvor: {
    runLog: string | null
    runLogRedakaUkupno: number | null
    izvodjenjaURazdoblju: number | null
    /** Koliko je razdoblje imalo izvođenja PRIJE reza po projektu. */
    izvodjenjaPrijeFiltra: number | null
    sTranskriptom: number | null
    bezSessionId: number | null
    izgubljenTranskript: number | null
    izKesa: number | null
    izracunatoSada: number | null
  }
  ukupno: Skupina
  poProjektu: Skupina[]
  poAgentu: Skupina[]
  najskuplji: NajskupljiRedak[]
  upozorenja: string[]
}

export type PregledStanje = 'spremno' | 'racuna' | 'greska'

export interface PregledOdgovor {
  stanje: PregledStanje
  http: number
  izvor: 'kes' | 'izracun' | null
  staroMs: number | null
  poruka: string | null
  pregled: PregledPayload | null
}

export interface PregledState {
  cache: Map<string, { payload: PregledPayload; cachedAtMs: number }>
  inflight: Map<string, Promise<PregledPayload>>
  aktivnih: number
  red: Array<() => void>
}

export interface PregledDeps {
  runTool: (dana: number, najskupljih: number, projekt: string | null) => Promise<string>
  now: () => number
  state: PregledState
}

export function createPregledState(): PregledState {
  return { cache: new Map(), inflight: new Map(), aktivnih: 0, red: [] }
}

// ---------------------------------------------------------------------------
// Čiste funkcije (jedinično testirane)
// ---------------------------------------------------------------------------

/**
 * Parametar iz URL-a → cijeli broj u rasponu, ili `null` ako je neispravan.
 * `null` je 400, a NE tiho vraćanje na zadanu vrijednost: pregled od 7 dana
 * prikazan na zahtjev za 30 dana je pogrešna brojka bez ijedne poruke.
 */
export function parseBroj(sirovo: string | null, zadano: number, min: number, max: number): number | null {
  if (sirovo === null || sirovo === '') return zadano
  if (!/^\d{1,6}$/.test(sirovo.trim())) return null
  const n = Number.parseInt(sirovo.trim(), 10)
  if (!Number.isFinite(n) || n < min || n > max) return null
  return n
}

/**
 * Ključ projekta iz URL-a → provjeren ključ, ili `null` ako je neispravan.
 * Prazno/izostavljeno NIJE pogreška — to je „bez filtra" (`undefined`).
 */
export function parseProjekt(sirovo: string | null | undefined): string | null | undefined {
  if (sirovo === null || sirovo === undefined || sirovo === '') return undefined
  const t = sirovo.trim()
  if (t === BEZ_PROJEKTA) return t
  if (!PROJEKT_UZORAK.test(t)) return null
  return t
}

export function kljucKesa(dana: number, najskupljih: number, projekt?: string | null): string {
  return `${dana}:${najskupljih}:${projekt ?? '*'}`
}

function broj(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function cijeli(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0
}

/**
 * `ishodi_stupci` iz alata; ako ih nema (keš zapisan prije M3/TASK-4625), izvede ih iz
 * pune raščlambe `ishodi` istim pravilom: sve što nije `completed`/`blocked_ok` je kvar.
 */
function stupciIzOdgovora(s: Record<string, any>): { completed: number; blocked_ok: number; failed: number } {
  const iz = s.ishodi_stupci
  if (iz && typeof iz === 'object') {
    return {
      completed: cijeli(iz.completed),
      blocked_ok: cijeli(iz.blocked_ok),
      failed: cijeli(iz.failed),
    }
  }
  const out = { completed: 0, blocked_ok: 0, failed: 0 }
  const ishodi = (s.ishodi && typeof s.ishodi === 'object') ? s.ishodi as Record<string, any> : {}
  for (const [k, v] of Object.entries(ishodi)) {
    const n = cijeli(v)
    if (k === 'completed') out.completed += n
    else if (k === 'blocked_ok') out.blocked_ok += n
    else out.failed += n
  }
  return out
}

function tekst(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Jedna skupina iz izlaza alata → oblik koji pregled prikazuje. */
export function sazmiSkupinu(sirovo: unknown, kljucPolje: 'project_id' | 'agent' | null): Skupina {
  const s = (sirovo ?? {}) as Record<string, any>
  const trosak = (s.trosak ?? {}) as Record<string, any>
  const tokeni = (s.tokeni ?? {}) as Record<string, any>
  const lat = (s.latencija ?? {}) as Record<string, any>
  const traj = (s.trajanje ?? {}) as Record<string, any>
  const alati = (s.alati ?? {}) as Record<string, any>
  const trenje = (s.trenje ?? {}) as Record<string, any>

  const kljuc = kljucPolje ? (tekst(s[kljucPolje]) ?? '(nepoznato)') : 'ukupno'

  return {
    kljuc,
    naziv: tekst(s.naziv),
    zadataka: cijeli(s.zadataka),
    razlicitihZadataka: cijeli(s.razlicitih_zadataka),
    sTranskriptom: cijeli(s.s_transkriptom),
    ishodi: (s.ishodi && typeof s.ishodi === 'object') ? (s.ishodi as Record<string, number>) : {},
    // Stariji keš pregleda (prije M3) nema `ishodi_stupci` — tada se stupci izvedu iz
    // `ishodi`, da ploča ne pokazuje tri nule dok se keš ne osvježi.
    ishodiStupci: stupciIzOdgovora(s),
    trosak: {
      usd: broj(trosak.usd),
      izZadataka: cijeli(trosak.iz_zadataka),
      usdPoZadatku: broj(trosak.usd_po_zadatku),
    },
    tokeni: {
      ulaz: broj(tokeni.ulaz),
      izlaz: broj(tokeni.izlaz),
      kesCitanje: broj(tokeni.kes_citanje),
      kesPisanje: broj(tokeni.kes_pisanje),
      ulazniKontekst: broj(tokeni.ulazni_kontekst),
      udioKesa: broj(tokeni.udio_kesa),
      izZadataka: cijeli(tokeni.iz_zadataka),
    },
    latencija: {
      prosjekS: broj(lat.prosjek_s),
      medijanS: broj(lat.medijan_s),
      p95S: broj(lat.p95_s),
      najvecaS: broj(lat.najveca_s),
      pozivaModela: cijeli(lat.poziva_modela),
      izPoziva: cijeli(lat.iz_poziva),
      izZadataka: cijeli(lat.iz_zadataka),
    },
    trajanje: {
      ukupnoS: broj(traj.ukupno_s),
      modelS: broj(traj.model_s),
      alatS: broj(traj.alat_s),
      udioModel: broj(traj.udio_model),
      udioAlat: broj(traj.udio_alat),
      izZadataka: cijeli(traj.iz_zadataka),
    },
    alati: {
      poziva: broj(alati.poziva),
      neuspjelih: broj(alati.neuspjelih),
      udioNeuspjelih: broj(alati.udio_neuspjelih),
      vrh: Array.isArray(alati.top)
        ? alati.top.map((t: any) => ({
            ime: tekst(t?.ime),
            poziva: broj(t?.poziva),
            neuspjelih: broj(t?.neuspjelih),
            udioPoziva: broj(t?.udio_poziva),
          }))
        : [],
      izZadataka: cijeli(alati.iz_zadataka),
    },
    trenje: {
      zadatakaSTrenjem: cijeli(trenje.zadataka_s_trenjem),
      izgubljenoS: broj(trenje.izgubljeno_s),
      izZadataka: cijeli(trenje.iz_zadataka),
    },
  }
}

/** Cijeli izlaz `tjedni_pregled.py --json` → `PregledPayload`. */
export function sazmiPregled(sirovo: unknown): PregledPayload {
  const p = (sirovo ?? {}) as Record<string, any>
  const razdoblje = (p.razdoblje ?? {}) as Record<string, any>
  const izvor = (p.izvor ?? {}) as Record<string, any>
  const proj = (p.projekt && typeof p.projekt === 'object') ? (p.projekt as Record<string, any>) : null
  const projId = proj ? tekst(proj.id) : null

  return {
    dana: cijeli(razdoblje.dana) || ZADANO_DANA,
    od: tekst(razdoblje.od),
    do: tekst(razdoblje.do),
    izracunatoU: tekst(p.zapisano_ts),
    projekt: projId ? { id: projId, naziv: tekst(proj!.naziv) } : null,
    izvor: {
      runLog: tekst(izvor.run_log),
      runLogRedakaUkupno: broj(izvor.run_log_redaka_ukupno),
      izvodjenjaURazdoblju: broj(izvor.izvodjenja_u_razdoblju),
      izvodjenjaPrijeFiltra: broj(izvor.izvodjenja_prije_filtra),
      sTranskriptom: broj(izvor.s_transkriptom),
      bezSessionId: broj(izvor.bez_session_id),
      izgubljenTranskript: broj(izvor.izgubljen_transkript),
      izKesa: broj(izvor.iz_kesa),
      izracunatoSada: broj(izvor.izracunato_sada),
    },
    ukupno: sazmiSkupinu(p.ukupno, null),
    poProjektu: Array.isArray(p.po_projektu)
      ? p.po_projektu.map((s: unknown) => sazmiSkupinu(s, 'project_id'))
      : [],
    poAgentu: Array.isArray(p.po_agentu)
      ? p.po_agentu.map((s: unknown) => sazmiSkupinu(s, 'agent'))
      : [],
    najskuplji: Array.isArray(p.najskuplji)
      ? p.najskuplji.map((z: any) => ({
          taskId: tekst(z?.task_id),
          naslov: tekst(z?.naslov),
          projectId: tekst(z?.project_id),
          agent: tekst(z?.agent),
          model: tekst(z?.model),
          outcome: tekst(z?.outcome),
          pokrenutoTs: tekst(z?.pokrenuto_ts),
          trosakUsd: broj(z?.trosak_usd),
          trajanjeS: broj(z?.trajanje_s),
          pozivaModela: broj(z?.poziva_modela),
          prosjekLatencijeS: broj(z?.prosjek_latencije_s),
          ulazniKontekst: broj(z?.ulazni_kontekst),
          udioKesa: broj(z?.udio_kesa),
          sessionId: tekst(z?.session_id),
        }))
      : [],
    upozorenja: Array.isArray(p.upozorenja) ? p.upozorenja.filter((w: unknown) => typeof w === 'string') : [],
  }
}

/** Alat ispisuje JEDAN vršni JSON objekt; sve prije/poslije njega je šum. */
export function parsePregledOutput(stdout: string): unknown | null {
  if (!stdout) return null
  const prvi = stdout.indexOf('{')
  const zadnji = stdout.lastIndexOf('}')
  if (prvi < 0 || zadnji <= prvi) return null
  try {
    return JSON.parse(stdout.slice(prvi, zadnji + 1))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Keš, propusnica, razrješenje
// ---------------------------------------------------------------------------

function zapamti(state: PregledState, kljuc: string, payload: PregledPayload, atMs: number): void {
  state.cache.set(kljuc, { payload, cachedAtMs: atMs })
  while (state.cache.size > PREGLED_CACHE_MAX) {
    const najstariji = state.cache.keys().next()
    if (najstariji.done) break
    state.cache.delete(najstariji.value)
  }
}

async function uzmiMjesto(state: PregledState): Promise<void> {
  if (state.aktivnih < PREGLED_MAX_PARALLEL) {
    state.aktivnih++
    return
  }
  await new Promise<void>((resolve) => state.red.push(resolve))
  state.aktivnih++
}

function pustiMjesto(state: PregledState): void {
  state.aktivnih = Math.max(0, state.aktivnih - 1)
  const sljedeci = state.red.shift()
  if (sljedeci) sljedeci()
}

/**
 * Tjedni pregled za zadano razdoblje.
 *
 * Redoslijed: keš → tekući izračun (dijeljen) → novi izračun, uz ograničeno čekanje.
 * Istek čekanja NIJE pogreška: 202, a izračun u pozadini dovrši i napuni keš.
 */
export async function resolveTjedniPregled(
  opts: { dana?: number; najskupljih?: number; projekt?: string | null; force?: boolean; waitMs?: number },
  deps: PregledDeps
): Promise<PregledOdgovor> {
  const dana = opts.dana ?? ZADANO_DANA
  const najskupljih = opts.najskupljih ?? ZADANO_NAJSKUPLJIH
  const projekt = opts.projekt ?? null
  if (!Number.isInteger(dana) || dana < DANA_MIN || dana > DANA_MAX ||
      !Number.isInteger(najskupljih) || najskupljih < NAJSKUPLJIH_MIN || najskupljih > NAJSKUPLJIH_MAX) {
    return {
      stanje: 'greska', http: 400, izvor: null, staroMs: null,
      poruka: `Neispravni parametri: dana ${DANA_MIN}–${DANA_MAX}, najskupljih ${NAJSKUPLJIH_MIN}–${NAJSKUPLJIH_MAX}.`,
      pregled: null,
    }
  }
  // Ključ projekta se provjerava i ovdje, a ne samo na ruti: modul je taj koji
  // sastavlja argv, pa neprovjeren niz ne smije proći ni jednim putem.
  if (projekt !== null && projekt !== BEZ_PROJEKTA && !PROJEKT_UZORAK.test(projekt)) {
    return {
      stanje: 'greska', http: 400, izvor: null, staroMs: null,
      poruka: 'Neispravan ključ projekta.', pregled: null,
    }
  }

  const state = deps.state
  const kljuc = kljucKesa(dana, najskupljih, projekt)
  const now = deps.now()
  const prag = opts.force ? PREGLED_MIN_REFRESH_MS : PREGLED_TTL_MS
  const hit = state.cache.get(kljuc)
  if (hit && now - hit.cachedAtMs < prag) {
    return {
      stanje: 'spremno', http: 200, izvor: 'kes',
      staroMs: Math.max(0, now - hit.cachedAtMs), poruka: null, pregled: hit.payload,
    }
  }

  let posao = state.inflight.get(kljuc)
  if (!posao) {
    posao = (async () => {
      await uzmiMjesto(state)
      try {
        const stdout = await deps.runTool(dana, najskupljih, projekt)
        const parsed = parsePregledOutput(stdout)
        if (!parsed) throw new Error('tjedni_pregled.py nije vratio ispravan JSON')
        const payload = sazmiPregled(parsed)
        zapamti(state, kljuc, payload, deps.now())
        return payload
      } finally {
        pustiMjesto(state)
        state.inflight.delete(kljuc)
      }
    })()
    // Bez ovoga bi odbijeni posao, kojemu je istekao `waitMs`, srušio proces
    // kao neuhvaćeno odbijanje obećanja.
    posao.catch(() => {})
    state.inflight.set(kljuc, posao)
  }

  const waitMs = opts.waitMs ?? PREGLED_WAIT_MS
  const cekanje = new Promise<'istek'>((resolve) => {
    const t = setTimeout(() => resolve('istek'), waitMs)
    if (typeof (t as any)?.unref === 'function') (t as any).unref()
  })

  try {
    const ishod = await Promise.race([posao, cekanje])
    if (ishod === 'istek') {
      return {
        stanje: 'racuna', http: 202, izvor: null, staroMs: null,
        poruka: 'Pregled se računa; pokušajte ponovno za koji trenutak.', pregled: null,
      }
    }
    return {
      stanje: 'spremno', http: 200, izvor: 'izracun', staroMs: 0,
      poruka: null, pregled: ishod as PregledPayload,
    }
  } catch (err) {
    const poruka = err instanceof Error ? err.message : String(err)
    if (hit) {
      return {
        stanje: 'spremno', http: 200, izvor: 'kes',
        staroMs: Math.max(0, deps.now() - hit.cachedAtMs),
        poruka: 'Osvježavanje nije uspjelo: ' + poruka, pregled: hit.payload,
      }
    }
    return { stanje: 'greska', http: 503, izvor: null, staroMs: null, poruka, pregled: null }
  }
}

/** Produkcijske ovisnosti: `tjedni_pregled.py --dana N --najskupljih M [--projekt X] --json`. */
export function createPregledDeps(state: PregledState): PregledDeps {
  return {
    now: () => Date.now(),
    state,
    runTool: async (dana: number, najskupljih: number, projekt: string | null = null) => {
      const argv = ['python3', PREGLED_SCRIPT,
        '--dana', String(dana), '--najskupljih', String(najskupljih)]
      // Niz je već prošao `PROJEKT_UZORAK`; ipak ide kao zaseban argv element,
      // nikad kao dio ljuske — Bun.spawn ne pokreće shell.
      if (projekt) argv.push('--projekt', projekt)
      argv.push('--json')
      const proc = Bun.spawn(
        argv,
        {
          stdout: 'pipe',
          stderr: 'pipe',
          env: {
            HOME,
            PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
            LANG: 'en_US.UTF-8',
            PYTHONIOENCODING: 'utf-8',
          },
        }
      )
      const timer = setTimeout(() => { try { proc.kill() } catch {} }, PREGLED_TIMEOUT_MS)
      try {
        const [stdout, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ])
        if (exitCode !== 0) {
          const stderr = (await new Response(proc.stderr).text()).trim()
          throw new Error(`tjedni_pregled.py exit ${exitCode}${stderr ? ': ' + stderr.slice(0, 200) : ''}`)
        }
        return stdout
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
