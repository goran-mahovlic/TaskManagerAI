/**
 * TaskTelemetry — „Potrošnja zadatka" za karticu zadatka (TASK-3568, kriška T4)
 *
 * Izvor istine je `tools/agent_telemetry.py` (kriške T2/T3):
 * on čita NAŠE transkripte `~/.claude/projects/**\/*.jsonl` i `run_log.jsonl`.
 * Ovdje se taj izračun NE duplicira — ovaj modul ga samo poziva, keširaj i svodi
 * na ono što kartica prikazuje (mjere 1, 2, 3, 4 i 5 iz ISTRAZIVANJE_AGENTSIGHT §7).
 *
 * Tri pravila koja ovaj modul provodi:
 *   1. IZRAČUN NE SMIJE BLOKIRATI PLOČU. Zahtjev čeka najviše `TELEMETRY_WAIT_MS`;
 *      ako alat nije gotov, vraća se 202 `stanje:"racuna"`, a izračun teče dalje u
 *      pozadini i puni keš. Isti zadatak nikad ne pokreće dva procesa (single-flight),
 *      a broj istodobnih procesa je ograničen (`TELEMETRY_MAX_PARALLEL`).
 *   2. NEMA TELEMETRIJE ≠ POGREŠKA. Stari zadatci bez transkripta vraćaju 200 s
 *      `imaPodatke:false` i razlogom. Nedostajuća vrijednost je `null`, nikad 0 (ADR §9).
 *   3. ID ZADATKA IDE U ARGV, NE U LJUSKU, i prije toga kroz uzorak — argument koji
 *      počinje crticom python bi pročitao kao opciju.
 */
import { join } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { sustavPutanja } from './core/paths'

const HOME = process.env.HOME || homedir()

/**
 * Putanja alata. Paket ga nosi u `tools/`; instalacija koja drži vlastitu inačicu postavlja
 * `TM_TELEMETRY_SCRIPT` ili `TM_SUSTAV_DIR` (v. `sustavPutanja()` u src/core/paths.ts) —
 * odabir je kroz okolinu, s prvim postojećim kao pretpostavkom. Bez njega „Potrošnja" javlja da alat nedostaje, a ploča i dalje radi.
 */
function prviPostojeci(putovi: string[]): string {
  for (const p of putovi) { try { if (existsSync(p)) return p } catch { /* dalje */ } }
  return putovi[putovi.length - 1]
}

export const TELEMETRY_SCRIPT = process.env.TM_TELEMETRY_SCRIPT
  || prviPostojeci([
       join(import.meta.dir, '..', 'tools', 'agent_telemetry.py'),
       sustavPutanja('tools/agent_telemetry.py'),
     ].filter((p): p is string => p !== null))

/** Završeno izvođenje se više ne mijenja; keš je tu zbog ponovnog otvaranja kartice. */
export const TELEMETRY_TTL_MS = 10 * 60_000
/** Donja brana za `force` — da tipka „osvježi" ne postane bujica procesa. */
export const TELEMETRY_MIN_REFRESH_MS = 15_000
/** Koliko zahtjev najviše čeka alat prije nego vrati 202 „računa se". */
export const TELEMETRY_WAIT_MS = 2_500
/** Alat na 44 MB transkripta traje ~0,4 s; ovo je brana od zaglavljenog procesa. */
export const TELEMETRY_TIMEOUT_MS = 25_000
/** Gornja granica keša — kartica se otvara puno puta, memorija ne smije rasti. */
export const TELEMETRY_CACHE_MAX = 200
/** Najviše istodobnih pythona; ostali čekaju red umjesto da guše ploču. */
export const TELEMETRY_MAX_PARALLEL = 2
/** Koliko alata ide u prikaz (mjera 3: „top 5"). */
export const TELEMETRY_TOP_ALATA = 5

/** TASK-3568: id ide u argv alata — bez crtice na početku i bez razmaka. */
export const TASK_ID_UZORAK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export interface AlatStavka {
  ime: string
  poziva: number
  neuspjelih: number
  udioPoziva: number | null
  trajanjeZbrojS: number | null
  trajanjeMedijanS: number | null
}

export interface TrenjePrimjer {
  signal: string
  razina: string
  alat: string | null
  argument: string | null
  puta: number | null
  podvrsta: string | null
  opis: string | null
}

export interface TelemetryPayload {
  taskId: string
  imaPodatke: boolean
  razlog: string | null
  izracunatoU: string | null
  zadatak: {
    agent: string | null
    model: string | null
    outcome: string | null
    exitCode: number | null
    vrsta: string | null
    pokrenutoU: string | null
    runLogTrajanjeS: number | null
  }
  sesija: {
    sessionId: string | null
    transkript: string | null
    redaka: number | null
    prozorOd: string | null
    prozorDo: string | null
    cwd: string | null
    gitGrana: string | null
  }
  trajanje: {
    ukupnoS: number | null
    modelS: number | null
    alatS: number | null
    cekanjeCovjekaS: number | null
    rezijaS: number | null
    udioModel: number | null
    udioAlat: number | null
    udioCekanjeCovjeka: number | null
    udioRezija: number | null
  }
  latencija: {
    poziva: number | null
    prosjekS: number | null
    medijanS: number | null
    p95S: number | null
    najvecaS: number | null
  }
  alati: {
    poziva: number | null
    rezultata: number | null
    neuspjelih: number | null
    udioNeuspjelih: number | null
    top: AlatStavka[]
    ostalihAlata: number
  }
  tokeni: {
    ulaz: number | null
    izlaz: number | null
    kesCitanje: number | null
    kesPisanje: number | null
    ulazniKontekst: number | null
    udioKesa: number | null
  }
  trosak: {
    usd: number | null
    izvor: string | null
  }
  trenje: {
    ocjena: number | null
    upozorenja: number | null
    dogadjaja: number
    izgubljenoS: number | null
    udioIzgubljenog: number | null
    primjeri: TrenjePrimjer[]
  } | null
  zastavice: string[]
}

export type TelemetryStanje = 'spremno' | 'racuna' | 'greska'

export interface TelemetryOdgovor {
  stanje: TelemetryStanje
  http: 200 | 202 | 400 | 503
  taskId: string
  izvor: 'kes' | 'izracun' | null
  staroMs: number | null
  poruka: string | null
  telemetrija: TelemetryPayload | null
}

export interface TelemetryState {
  cache: Map<string, { payload: TelemetryPayload; cachedAtMs: number }>
  inflight: Map<string, Promise<TelemetryPayload>>
  aktivnih: number
  red: Array<() => void>
}

export interface TelemetryDeps {
  runTool: (taskId: string) => Promise<string>
  now: () => number
  state: TelemetryState
}

export function createTelemetryState(): TelemetryState {
  return { cache: new Map(), inflight: new Map(), aktivnih: 0, red: [] }
}

// ---------------------------------------------------------------------------
// Čiste funkcije (jedinično testirane)
// ---------------------------------------------------------------------------

/**
 * `--json --primjeri` ispisuje DVA vršna objekta jedan za drugim (zapis po shemi
 * + primjeri trenja), pa `JSON.parse` nad cijelim stdoutom pada. Razdvajanje ide
 * brojanjem vitičastih zagrada uz svijest o nizovima — naredba u primjeru trenja
 * slobodno smije sadržavati `{`, `}` ili navodnik.
 */
export function splitJsonObjects(stdout: string): unknown[] {
  const out: unknown[] = []
  if (!stdout) return out
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < stdout.length; i++) {
    const ch = stdout[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(stdout.slice(start, i + 1))) } catch { /* nepotpun blok */ }
        start = -1
      }
      if (depth < 0) depth = 0
    }
  }
  return out
}

function broj(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function tekst(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/** Zapis po shemi = objekt sa `shema: "regoc.telemetrija-zadatka/v1"`. */
export function parseTelemetryOutput(
  stdout: string
): { zapis: Record<string, any>; primjeri: TrenjePrimjer[] } | null {
  const objekti = splitJsonObjects(stdout)
  let zapis: Record<string, any> | null = null
  let primjeri: TrenjePrimjer[] = []
  for (const o of objekti) {
    if (!o || typeof o !== 'object') continue
    const rec = o as Record<string, any>
    if (Array.isArray(rec)) {
      // `--zadnjih N` vraća niz; uzimamo prvi zapis koji nosi shemu.
      for (const el of rec) {
        if (el && typeof el === 'object' && typeof el.shema === 'string' && !zapis) zapis = el
      }
      continue
    }
    if (typeof rec.shema === 'string' && rec.shema.startsWith('regoc.telemetrija-zadatka')) {
      if (!zapis) zapis = rec
    } else if (Array.isArray(rec.trenje_primjeri)) {
      primjeri = rec.trenje_primjeri.map((p: any) => ({
        signal: String(p?.signal ?? ''),
        razina: String(p?.razina ?? ''),
        alat: tekst(p?.alat),
        argument: tekst(p?.argument),
        puta: broj(p?.puta),
        podvrsta: tekst(p?.podvrsta),
        opis: tekst(p?.opis),
      }))
    }
  }
  if (!zapis) return null
  return { zapis, primjeri }
}

/**
 * Svođenje zapisa alata na ono što kartica prikazuje.
 * Prazno stanje (`imaPodatke:false`) prepoznaje se po tome što sesija nema
 * transkript — to su stari zadatci koji su nastali prije telemetrije, ili
 * zadatci koje nikad nije izvodio agent.
 */
export function sazmiTelemetriju(
  taskId: string,
  zapis: Record<string, any>,
  primjeri: TrenjePrimjer[]
): TelemetryPayload {
  const z = zapis.zadatak ?? {}
  const s = zapis.sesija ?? {}
  const t = zapis.trajanje ?? {}
  const l = zapis.latencija_modela ?? {}
  const a = zapis.alati ?? {}
  const tok = zapis.tokeni ?? {}
  const tr = zapis.trosak ?? {}
  const f = zapis.trenje ?? null

  const histogram: any[] = Array.isArray(a.histogram) ? a.histogram.slice() : []
  histogram.sort((x, y) => (broj(y?.poziva) ?? 0) - (broj(x?.poziva) ?? 0))
  const top: AlatStavka[] = histogram.slice(0, TELEMETRY_TOP_ALATA).map((h) => ({
    ime: String(h?.ime ?? '?'),
    poziva: broj(h?.poziva) ?? 0,
    neuspjelih: broj(h?.neuspjelih) ?? 0,
    udioPoziva: broj(h?.udio_poziva),
    trajanjeZbrojS: broj(h?.trajanje_zbroj_s),
    trajanjeMedijanS: broj(h?.trajanje_medijan_s),
  }))

  const imaTranskript = tekst(s.transkript_putanja) !== null && broj(s.redaka) !== null
  const imaSesiju = tekst(s.session_id) !== null
  let razlog: string | null = null
  if (!imaTranskript) {
    if (!imaSesiju) razlog = 'Zadatak nema zabilježeno izvođenje agenta (nema session_id u run_log.jsonl).'
    else razlog = 'Transkript sesije više ne postoji na disku — telemetrija se ne može izračunati.'
  }

  return {
    taskId,
    imaPodatke: imaTranskript,
    razlog,
    izracunatoU: tekst(zapis.zapisano_ts),
    zadatak: {
      agent: tekst(z.agent),
      model: tekst(z.model),
      outcome: tekst(z.outcome),
      exitCode: broj(z.exit_code),
      vrsta: tekst(z.vrsta),
      pokrenutoU: tekst(z.run_log_ts),
      runLogTrajanjeS: broj(z.run_log_duration_s),
    },
    sesija: {
      sessionId: tekst(s.session_id),
      transkript: tekst(s.transkript_putanja),
      redaka: broj(s.redaka),
      prozorOd: tekst(s.prozor_od),
      prozorDo: tekst(s.prozor_do),
      cwd: tekst(s.cwd),
      gitGrana: tekst(s.git_grana),
    },
    trajanje: {
      ukupnoS: broj(t.ukupno_s),
      modelS: broj(t.model_s),
      alatS: broj(t.alat_s),
      cekanjeCovjekaS: broj(t.cekanje_covjeka_s),
      rezijaS: broj(t.rezija_s),
      udioModel: broj(t.udio_model),
      udioAlat: broj(t.udio_alat),
      udioCekanjeCovjeka: broj(t.udio_cekanje_covjeka),
      udioRezija: broj(t.udio_rezija),
    },
    latencija: {
      poziva: broj(l.poziva),
      prosjekS: broj(l.prosjek_s),
      medijanS: broj(l.medijan_s),
      p95S: broj(l.p95_s),
      najvecaS: broj(l.najveca_s),
    },
    alati: {
      poziva: broj(a.poziva),
      rezultata: broj(a.rezultata),
      neuspjelih: broj(a.neuspjelih),
      udioNeuspjelih: broj(a.udio_neuspjelih),
      top,
      ostalihAlata: Math.max(0, histogram.length - top.length),
    },
    tokeni: {
      ulaz: broj(tok.ulaz),
      izlaz: broj(tok.izlaz),
      kesCitanje: broj(tok.kes_citanje),
      kesPisanje: broj(tok.kes_pisanje),
      ulazniKontekst: broj(tok.ulazni_kontekst),
      udioKesa: broj(tok.udio_kesa),
    },
    trosak: { usd: broj(tr.usd), izvor: tekst(tr.izvor) },
    trenje: f
      ? {
          ocjena: broj(f.ocjena),
          upozorenja: broj(f.upozorenja),
          dogadjaja: Array.isArray(f.dogadjaji) ? f.dogadjaji.length : 0,
          izgubljenoS: broj(f.izgubljeno_s),
          udioIzgubljenog: broj(f.udio_izgubljenog),
          primjeri: primjeri.slice(0, TELEMETRY_TOP_ALATA),
        }
      : null,
    zastavice: Array.isArray(zapis.zastavice) ? zapis.zastavice.map((x: any) => String(x)) : [],
  }
}

function zapamti(state: TelemetryState, taskId: string, payload: TelemetryPayload, atMs: number): void {
  state.cache.set(taskId, { payload, cachedAtMs: atMs })
  while (state.cache.size > TELEMETRY_CACHE_MAX) {
    const najstariji = state.cache.keys().next()
    if (najstariji.done) break
    state.cache.delete(najstariji.value)
  }
}

/** Propusnica: najviše TELEMETRY_MAX_PARALLEL pythona istodobno. */
async function uzmiMjesto(state: TelemetryState): Promise<void> {
  if (state.aktivnih < TELEMETRY_MAX_PARALLEL) {
    state.aktivnih++
    return
  }
  await new Promise<void>((resolve) => state.red.push(resolve))
  state.aktivnih++
}

function pustiMjesto(state: TelemetryState): void {
  state.aktivnih = Math.max(0, state.aktivnih - 1)
  const sljedeci = state.red.shift()
  if (sljedeci) sljedeci()
}

/**
 * Telemetrija jednog zadatka.
 *
 * Redoslijed: keš → tekući izračun (dijeljen) → novi izračun, ali čekanje je
 * ograničeno na `waitMs`. Prekoračenje NIJE pogreška: vraća se 202 i klijent
 * pita ponovno, dok izračun u pozadini dovrši i napuni keš.
 */
export async function resolveTaskTelemetry(
  taskId: string,
  opts: { force?: boolean; waitMs?: number },
  deps: TelemetryDeps
): Promise<TelemetryOdgovor> {
  if (!TASK_ID_UZORAK.test(taskId)) {
    return {
      stanje: 'greska', http: 400, taskId, izvor: null, staroMs: null,
      poruka: 'Neispravan id zadatka.', telemetrija: null,
    }
  }

  const state = deps.state
  const now = deps.now()
  const prag = opts.force ? TELEMETRY_MIN_REFRESH_MS : TELEMETRY_TTL_MS
  const hit = state.cache.get(taskId)
  if (hit && now - hit.cachedAtMs < prag) {
    return {
      stanje: 'spremno', http: 200, taskId, izvor: 'kes',
      staroMs: Math.max(0, now - hit.cachedAtMs), poruka: null, telemetrija: hit.payload,
    }
  }

  let posao = state.inflight.get(taskId)
  if (!posao) {
    posao = (async () => {
      await uzmiMjesto(state)
      try {
        const stdout = await deps.runTool(taskId)
        const parsed = parseTelemetryOutput(stdout)
        if (!parsed) throw new Error('agent_telemetry.py nije vratio ispravan JSON')
        const payload = sazmiTelemetriju(taskId, parsed.zapis, parsed.primjeri)
        zapamti(state, taskId, payload, deps.now())
        return payload
      } finally {
        pustiMjesto(state)
        state.inflight.delete(taskId)
      }
    })()
    // Bez ovoga bi odbijeni posao, kojemu je istekao `waitMs`, srušio proces
    // kao neuhvaćeno odbijanje obećanja.
    posao.catch(() => {})
    state.inflight.set(taskId, posao)
  }

  const waitMs = opts.waitMs ?? TELEMETRY_WAIT_MS
  const cekanje = new Promise<'istek'>((resolve) => {
    const t = setTimeout(() => resolve('istek'), waitMs)
    if (typeof (t as any)?.unref === 'function') (t as any).unref()
  })

  try {
    const ishod = await Promise.race([posao, cekanje])
    if (ishod === 'istek') {
      return {
        stanje: 'racuna', http: 202, taskId, izvor: null, staroMs: null,
        poruka: 'Telemetrija se računa; pokušajte ponovno za koji trenutak.', telemetrija: null,
      }
    }
    return {
      stanje: 'spremno', http: 200, taskId, izvor: 'izracun', staroMs: 0,
      poruka: null, telemetrija: ishod as TelemetryPayload,
    }
  } catch (err) {
    const poruka = err instanceof Error ? err.message : String(err)
    if (hit) {
      return {
        stanje: 'spremno', http: 200, taskId, izvor: 'kes',
        staroMs: Math.max(0, deps.now() - hit.cachedAtMs),
        poruka: 'Osvježavanje nije uspjelo: ' + poruka, telemetrija: hit.payload,
      }
    }
    return { stanje: 'greska', http: 503, taskId, izvor: null, staroMs: null, poruka, telemetrija: null }
  }
}

/** Produkcijske ovisnosti: `agent_telemetry.py --task <ID> --json --primjeri`. */
export function createTelemetryDeps(state: TelemetryState): TelemetryDeps {
  return {
    now: () => Date.now(),
    state,
    runTool: async (taskId: string) => {
      const proc = Bun.spawn(['python3', TELEMETRY_SCRIPT, '--task', taskId, '--json', '--primjeri'], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          HOME,
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
          LANG: 'en_US.UTF-8',
          PYTHONIOENCODING: 'utf-8',
        },
      })
      const timer = setTimeout(() => { try { proc.kill() } catch {} }, TELEMETRY_TIMEOUT_MS)
      try {
        const [stdout, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ])
        if (exitCode !== 0) {
          const stderr = (await new Response(proc.stderr).text()).trim()
          throw new Error(`agent_telemetry.py exit ${exitCode}${stderr ? ': ' + stderr.slice(0, 200) : ''}`)
        }
        return stdout
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
