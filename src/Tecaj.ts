/**
 * Tecaj — pretvorba USD → EUR za prikaz troška na ploči (TASK-3609)
 *
 * Goran, 02.09.2026.: „neka budu u € ne u $ — cijene idu za zadatke i za projekte."
 *
 * MJERENJE OSTAJE U DOLARIMA. `run_log.jsonl` bilježi `cost_usd` jer dobavljač tako
 * naplaćuje; `agent_telemetry.py` i `tjedni_pregled.py` se ne diraju. Euro je stvar
 * PRIKAZA — pretvorba se događa na jednom mjestu, a uz iznos ide tečaj i njegov datum,
 * da se preračunata brojka uvijek može provjeriti.
 *
 * Tri pravila:
 *   1. NIKAD TIHO MNOŽENJE NEPOZNATIM BROJEM. Svaki odgovor nosi `izvor` i `datum`.
 *      Kad je tečaj samo pretpostavka, to piše — ne pravimo se da smo ga izmjerili.
 *   2. MREŽA SMIJE PASTI. Zadnji poznati tečaj s diska vrijedi dalje; tek ako ni njega
 *      nema, koristi se zapisana pretpostavka. Ploča nikad ne ostaje bez brojke.
 *   3. JEDAN DOHVAT NA DAN. Tečaj se mijenja jednom dnevno (ECB), pa ga i mi tako čitamo.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

const HOME = process.env.HOME || homedir()

export const TECAJ_PUT = process.env.TM_TECAJ_FILE
  || join(HOME, '.claude', 'regoc', 'data', 'tecaj_usd_eur.json')

/** ECB-ov dnevni tečaj preko frankfurter.dev — bez ključa, bez registracije. */
export const TECAJ_URL = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR'

/** Osvježavamo jednom dnevno; ECB objavljuje jednom dnevno. */
export const TECAJ_TTL_MS = 24 * 60 * 60_000

/** Rok za mrežu — ploča ne smije visjeti na tuđem poslužitelju. */
export const TECAJ_FETCH_MS = 4_000

/**
 * Posljednja izlazna brana. Vrijednost od 02.09.2026. (ECB). Koristi se SAMO kad nema
 * ni keša ni mreže, i tada `izvor` glasi „pretpostavka" — da nitko ne pomisli da je mjereno.
 */
export const TECAJ_PRETPOSTAVKA = 0.86281

export type Tecaj = {
  /** Koliko eura vrijedi jedan dolar. */
  tecaj: number
  /** Datum tečaja (YYYY-MM-DD) — ECB-ov, ne naš. */
  datum: string
  /** `ecb` = dohvaćeno, `kes` = zadnje poznato s diska, `pretpostavka` = zapisana konstanta. */
  izvor: 'ecb' | 'kes' | 'pretpostavka'
  /** Kad smo ga mi zapisali (ISO). */
  dohvaceno?: string
}

/** Ručno zadan tečaj (`TM_USD_EUR`) nadjačava sve — za rad bez mreže i za testove. */
function izOkoline(): Tecaj | null {
  const raw = process.env.TM_USD_EUR
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return { tecaj: n, datum: new Date().toISOString().slice(0, 10), izvor: 'pretpostavka' }
}

function procitajKes(): Tecaj | null {
  try {
    if (!existsSync(TECAJ_PUT)) return null
    const d = JSON.parse(readFileSync(TECAJ_PUT, 'utf-8'))
    if (!d || !Number.isFinite(d.tecaj) || d.tecaj <= 0) return null
    return { tecaj: d.tecaj, datum: String(d.datum || ''), izvor: 'kes', dohvaceno: d.dohvaceno }
  } catch { return null }
}

/** Atomski upis — poluispisan JSON kod čitatelja završi kao `null`, a to je gore od starog. */
function zapisiKes(t: Tecaj): void {
  try {
    mkdirSync(dirname(TECAJ_PUT), { recursive: true })
    const tmp = TECAJ_PUT + '.tmp'
    writeFileSync(tmp, JSON.stringify({ ...t, izvor: 'ecb' }, null, 2))
    renameSync(tmp, TECAJ_PUT)
  } catch { /* keš je udobnost, ne uvjet */ }
}

function jeSvjez(t: Tecaj | null): boolean {
  if (!t || !t.dohvaceno) return false
  const ms = Date.parse(t.dohvaceno)
  return Number.isFinite(ms) && (Date.now() - ms) < TECAJ_TTL_MS
}

let uTijeku: Promise<void> | null = null

/**
 * Trenutačno važeći tečaj — nikad ne baca i nikad ne čeka mrežu.
 * Ako je keš star, osvježavanje se pokrene u pozadini, a poziv vrati staru vrijednost.
 */
export function tecajSada(): Tecaj {
  const rucni = izOkoline()
  if (rucni) return rucni
  const kes = procitajKes()
  if (!jeSvjez(kes) && !uTijeku) {
    uTijeku = osvjezi().finally(() => { uTijeku = null })
  }
  if (kes) return kes
  return { tecaj: TECAJ_PRETPOSTAVKA, datum: '2026-09-02', izvor: 'pretpostavka' }
}

/** Dohvat s ECB-a; tiho odustaje — stari tečaj je bolji od nikakvog. */
export async function osvjezi(): Promise<void> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TECAJ_FETCH_MS)
    const r = await fetch(TECAJ_URL, { signal: ctrl.signal })
    clearTimeout(t)
    if (!r.ok) return
    const d: any = await r.json()
    const n = Number(d?.rates?.EUR)
    if (!Number.isFinite(n) || n <= 0) return
    zapisiKes({ tecaj: n, datum: String(d.date || '').slice(0, 10), izvor: 'ecb',
                dohvaceno: new Date().toISOString() })
  } catch { /* mreža smije pasti */ }
}

/** Odgovor za `/api/tecaj`. */
export function tecajOdgovor(): Response {
  const t = tecajSada()
  return new Response(JSON.stringify(t), {
    headers: { 'Content-Type': 'application/json' },
  })
}
