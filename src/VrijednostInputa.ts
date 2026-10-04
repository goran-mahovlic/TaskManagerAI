/**
 * VrijednostInputa — kartica „Vrijednost korisničkih upita — cjenik S1–S6" (TASK-3691)
 * i chip ljudskog rada na projektima. Izračun radi `vrijednost_inputa.py --json`.
 *
 * TASK-5230 (vlasnik, 04.10.2026.: „visi na Računam…, Osvježi ne radi"). Ruta je od TASK-3691
 * zvala python SINKRONO unutar zahtjeva. Dok je izračun trajao sekundu, to je radilo; danas
 * čita sve transkripte i traje 68 s (65 s CPU, izmjereno), a Bun `idleTimeout` je 10 s —
 * poslužitelj prekine vezu, preglednik dobije ERR_EMPTY_RESPONSE, Chromium zahtjev sam ponovi
 * (još jedan python) i ništa se ne zbraja. Kartica i chip projekta ostaju na „…".
 *
 * Pravila koja ovaj modul provodi:
 *   1. ZAHTJEV NIKAD NE ČEKA PYTHON DULJE OD `waitMs` (3 s < idleTimeout 10 s).
 *   2. JEDAN POSAO U LETU — svaki zahtjev, Osvježi i ponovljeni zahtjev preglednika dijele isti.
 *   3. STALE-WHILE-REVALIDATE — postoji li ikakav keš, vraća se ODMAH (200, `osvjezava:true`),
 *      a izračun teče u pozadini. 202 `racuna` samo kad keša nema nikako.
 *   4. KEŠ NA DISKU — restart ploče ne vraća hladnih 68 s; pokvarena datoteka = nema keša.
 *   5. PYTHON NA NIŽEM PRIORITETU (`nice`) — teški poslovi agenata i ploča ne guše jedno drugo.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { dirname } from 'path'

/** Rezultat se mijenja tek novim upitima; 10 min kao i prije TASK-5230. */
export const VRIJEDNOST_TTL_MS = 10 * 60_000
/** Donja brana za Osvježi — tipka ne smije postati bujica procesa. */
export const VRIJEDNOST_MIN_REFRESH_MS = 20_000
/** Koliko zahtjev najviše čeka posao. MORA biti kraće od Bun `idleTimeout` (10 s). */
export const VRIJEDNOST_WAIT_MS = 3_000
/** Brana od zaglavljenog procesa (hladno 68 s, pod opterećenjem i više). */
export const VRIJEDNOST_TIMEOUT_MS = 10 * 60_000

export interface VrijednostKes { u: number; podatci: any }

export interface VrijednostDeps {
  now: () => number
  runTool: () => Promise<string>
  /** Putanja keša na disku; `null` = samo u memoriji (testovi). */
  kesPath: string | null
}

export interface VrijednostState {
  kes: VrijednostKes | null
  posao: Promise<any> | null
  posaoOd: number | null
  zadnjaGreska: string | null
}

export interface VrijednostOdgovor { http: number; body: any }

function ucitajSDiska(kesPath: string | null): VrijednostKes | null {
  if (!kesPath) return null
  try {
    if (!existsSync(kesPath)) return null
    const k = JSON.parse(readFileSync(kesPath, 'utf8'))
    if (k && typeof k.u === 'number' && k.podatci && typeof k.podatci === 'object') return k
  } catch { /* pokvarena datoteka = nema keša, nikad pad */ }
  return null
}

function zapisiNaDisk(kesPath: string | null, kes: VrijednostKes): void {
  if (!kesPath) return
  try {
    mkdirSync(dirname(kesPath), { recursive: true })
    const tmp = kesPath + '.tmp-' + process.pid
    writeFileSync(tmp, JSON.stringify(kes))
    renameSync(tmp, kesPath)   // atomično: čitatelj nikad ne vidi pola JSON-a
  } catch { /* keš na disku je pogodnost; izostanak ne ruši izračun */ }
}

export function createVrijednostState(deps: Pick<VrijednostDeps, 'kesPath'>): VrijednostState {
  return { kes: ucitajSDiska(deps.kesPath), posao: null, posaoOd: null, zadnjaGreska: null }
}

function pokreniPosao(state: VrijednostState, deps: VrijednostDeps): Promise<any> {
  if (state.posao) return state.posao
  state.posaoOd = deps.now()
  const p = (async () => {
    try {
      const izlaz = await deps.runTool()
      const podatci = JSON.parse(izlaz)
      state.kes = { u: deps.now(), podatci }
      state.zadnjaGreska = null
      zapisiNaDisk(deps.kesPath, state.kes)
      return podatci
    } catch (e) {
      state.zadnjaGreska = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      state.posao = null
      state.posaoOd = null
    }
  })()
  p.catch(() => {})   // posao kojemu je istekao waitMs ne smije srušiti proces
  state.posao = p
  return p
}

function izKesa(state: VrijednostState, deps: VrijednostDeps, osvjezava: boolean): VrijednostOdgovor {
  const k = state.kes as VrijednostKes
  return {
    http: 200,
    body: {
      ...k.podatci, izvor: 'kes',
      staroS: Math.max(0, Math.round((deps.now() - k.u) / 1000)),
      osvjezava,
      racunaOdS: state.posaoOd !== null ? Math.round((deps.now() - state.posaoOd) / 1000) : null,
      greskaOsvjezavanja: state.zadnjaGreska,
    },
  }
}

export async function resolveVrijednost(
  opts: { force?: boolean; waitMs?: number },
  state: VrijednostState,
  deps: VrijednostDeps,
): Promise<VrijednostOdgovor> {
  const now = deps.now()
  const starost = state.kes ? now - state.kes.u : Infinity
  const prag = opts.force ? VRIJEDNOST_MIN_REFRESH_MS : VRIJEDNOST_TTL_MS
  if (state.kes && starost < prag) return izKesa(state, deps, state.posao !== null)

  const posao = pokreniPosao(state, deps)
  const waitMs = opts.waitMs ?? VRIJEDNOST_WAIT_MS
  let timer: any
  const cekanje = new Promise<'istek'>((r) => { timer = setTimeout(() => r('istek'), waitMs) })
  try {
    const ishod = await Promise.race([posao, cekanje])
    if (ishod !== 'istek') return { http: 200, body: { ...ishod, izvor: 'izracun', staroS: 0, osvjezava: false } }
  } catch (e) {
    if (state.kes) return izKesa(state, deps, false)
    return { http: 503, body: { error: 'izračun nije uspio: ' + (e instanceof Error ? e.message : String(e)) } }
  } finally {
    clearTimeout(timer)
  }
  if (state.kes) return izKesa(state, deps, true)
  return {
    http: 202,
    body: {
      stanje: 'racuna',
      racunaOdS: state.posaoOd !== null ? Math.round((deps.now() - state.posaoOd) / 1000) : 0,
      poruka: 'Vrijednost se računa u pozadini; pokušajte ponovno za koji trenutak.',
    },
  }
}

/** Produkcija: `nice -n 15 python3 vrijednost_inputa.py --json`, uz branu od zaglavljenja. */
export function createVrijednostDeps(alat: string | null, kesPath: string | null): VrijednostDeps {
  return {
    now: () => Date.now(),
    kesPath,
    runTool: async () => {
      if (!alat) throw new Error('alat vrijednost_inputa.py nije pronađen')
      const argv = existsSync('/usr/bin/nice') || existsSync('/bin/nice')
        ? ['nice', '-n', '15', 'python3', alat, '--json']
        : ['python3', alat, '--json']
      const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
      const t = setTimeout(() => { try { proc.kill() } catch {} }, VRIJEDNOST_TIMEOUT_MS)
      try {
        const [izlaz, kod] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
        if (kod !== 0) {
          const greska = (await new Response(proc.stderr).text()).trim()
          throw new Error(`exit ${kod}${greska ? ': ' + greska.slice(-300) : ''}`)
        }
        return izlaz
      } finally {
        clearTimeout(t)
      }
    },
  }
}

/**
 * Prvi postojeći alat iz popisa kandidata (pozivatelj daje redoslijed: uz paket, pa u
 * instalaciji sustava). TM_VRIJEDNOST_SCRIPT podmeće alat (e2e s namjerno sporim izračunom),
 * isto kao TM_PREGLED_SCRIPT.
 */
export function nadjiAlat(kandidati: Array<string | null>): string | null {
  const podmetnut = process.env.TM_VRIJEDNOST_SCRIPT
  if (podmetnut) return existsSync(podmetnut) ? podmetnut : null
  return kandidati.find((p): p is string => !!p && existsSync(p)) || null
}
