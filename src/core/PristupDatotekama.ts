/**
 * Tko smije čitati što s ploče — preuzimanje datoteka i CORS (nalaz TASK-5329 N4).
 *
 * Prije: /api/files/download služio je svaku običnu datoteku pod $HOME (ključ zatvarača,
 * ~/.claude/.credentials.json, ~/.ssh), a ploča sluša 0.0.0.0. CORS je odražavao bilo koji
 * Origin uz Allow-Credentials, pa je tuđa stranica u pregledniku vlasnika čitala odgovore.
 *
 * Sada:
 *   - preuzima se samo iz popisa korijena (`TM_DOWNLOAD_DIRS`, zadano `$HOME/app` —
 *     projekti i isporuke u `app/tmp`), nikad datoteka izravno u korijenu (ondje leže
 *     ključevi i certifikati), nijedan dio puta s točkom, nijedno ime koje izgleda kao
 *     tajna; realpath ide PRIJE provjere prefiksa, pa simlink van korijena ne prolazi;
 *   - Origin se odražava samo ako je vlastiti; mutacija sa stranim Originom se odbija.
 *
 * Autorica: Jelena (Engineer), TASK-5333.
 */
import { existsSync, realpathSync, statSync } from 'fs'
import { dirname, join, relative, resolve, sep, isAbsolute } from 'path'
import { PAKET_DIR } from './paths'

type Okolina = Record<string, string | undefined>

/** Dijelovi imena koji odaju tajnu — i u mapama i u datotekama. */
const TAJNO_IME_RE = /(kljuc|ključ|secret|tajn|credential|passw|lozink|token|private|id_rsa|id_ed25519|id_ecdsa)/i
/** Nastavci datoteka s ključevima i certifikatima. */
const TAJNI_NASTAVAK_RE = /\.(key|pem|p12|pfx|crt|cer|der|jks|keystore|kdbx|gpg|asc|token|env)$/i
/** Konfiguracije ulaza s tajnama (isti popis kao razgovor/SendDoc). */
const ZABRANJENA_IMENA = new Set(['telegram.json', 'signal.json'])

function prosiri(p: string, home: string): string {
  if (p === '~') return home
  return p.startsWith('~/') ? join(home, p.slice(2)) : p
}

/** Dopušteni korijeni preuzimanja; samo apsolutne putanje (nakon širenja `~`). */
export function korijeniPreuzimanja(env: Okolina = process.env): string[] {
  const home = env.HOME || ''
  const izEnv = (env.TM_DOWNLOAD_DIRS || '').split(',').map(s => s.trim()).filter(Boolean)
  const sirovi = izEnv.length ? izEnv : (home ? [join(home, 'app')] : [])
  return sirovi.map(s => prosiri(s, home)).filter(s => isAbsolute(s)).map(s => resolve(s))
}

/**
 * Mape koje se ne služe ni kad leže pod dopuštenim korijenom: konfiguracija paketa
 * (tajne ulaza) i korijen podataka ploče (baza, najmovi, ključ zatvarača).
 */
export function izuzeteMape(env: Okolina = process.env): string[] {
  const home = env.HOME || ''
  const out = [join(PAKET_DIR, 'config'), env.TM_HOME || join(home, '.taskmanager')]
  if (env.TM_DB) out.push(dirname(env.TM_DB))
  if (env.TM_IZVORNI_PODACI) out.push(env.TM_IZVORNI_PODACI)
  return out.filter(p => isAbsolute(p)).map(p => resolve(p))
}

export type Preuzimanje =
  | { ok: true; putanja: string; ime: string }
  | { ok: false; status: 400 | 403 | 404; razlog: string }

function stvarna(p: string): string | null {
  try { return realpathSync(p) } catch { return null }
}

/** Dijelovi puta ispod korijena, ili null ako put nije ispod njega (ni sam korijen). */
function dijeloviIspod(korijen: string, put: string): string[] | null {
  const rel = relative(korijen, put)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep)
}

function zabranjeniDio(dijelovi: string[]): string | null {
  for (const d of dijelovi) {
    if (d.startsWith('.')) return `dio puta počinje točkom (${d})`
    if (TAJNO_IME_RE.test(d)) return `ime izgleda kao tajna (${d})`
  }
  const ime = dijelovi[dijelovi.length - 1]
  if (ZABRANJENA_IMENA.has(ime.toLowerCase())) return `konfiguracija s tajnama (${ime})`
  if (TAJNI_NASTAVAK_RE.test(ime)) return `nastavak ključa/certifikata (${ime})`
  return null
}

/**
 * Odluka za `?path=` s /api/files/download. Provjera se radi i nad zatraženim putem
 * (prije realpatha — `.git/`, `.env` u imenu) i nad stvarnim (simlinkovi).
 */
export function rijesiPreuzimanje(sirovo: string, env: Okolina = process.env, izuzeti: string[] = izuzeteMape(env)): Preuzimanje {
  const raw = (sirovo || '').trim()
  if (!raw) return { ok: false, status: 400, razlog: 'Missing path' }
  const home = env.HOME || ''
  const zatrazeno = prosiri(raw, home)
  if (!isAbsolute(zatrazeno)) return { ok: false, status: 403, razlog: 'Forbidden path (nije apsolutna putanja)' }
  const abs = resolve(zatrazeno)

  const korijeni = korijeniPreuzimanja(env)
  const stvarniKorijeni = korijeni.map(k => stvarna(k) || k)

  // 1) Zatraženi put (logički) mora biti ispod nekog korijena, bez zabranjenih dijelova.
  const logicki = korijeni.map(k => ({ k, d: dijeloviIspod(k, abs) })).find(x => x.d)
    || stvarniKorijeni.map(k => ({ k, d: dijeloviIspod(k, abs) })).find(x => x.d)
  if (!logicki) return { ok: false, status: 403, razlog: 'Forbidden path (izvan dopuštenih mapa)' }
  const zabranaLogicka = zabranjeniDio(logicki.d!)
  if (zabranaLogicka) return { ok: false, status: 403, razlog: `Forbidden path (${zabranaLogicka})` }
  if (logicki.d!.length < 2) return { ok: false, status: 403, razlog: 'Forbidden path (datoteka izravno u korijenu)' }

  if (!existsSync(abs)) return { ok: false, status: 404, razlog: 'Not found' }

  // 2) Stvarni put (simlinkovi razriješeni) — ista pravila nad stvarnim korijenima.
  const real = stvarna(abs)
  if (!real) return { ok: false, status: 404, razlog: 'Not found' }
  const d = stvarniKorijeni.map(k => dijeloviIspod(k, real)).find(Boolean)
  if (!d) return { ok: false, status: 403, razlog: 'Forbidden path (simlink izvan dopuštenih mapa)' }
  const zabrana = zabranjeniDio(d)
  if (zabrana) return { ok: false, status: 403, razlog: `Forbidden path (${zabrana})` }
  if (d.length < 2) return { ok: false, status: 403, razlog: 'Forbidden path (datoteka izravno u korijenu)' }

  const izuzeto = izuzeti.flatMap(m => [m, stvarna(m) || m])
  if (izuzeto.some(m => dijeloviIspod(m, real) || dijeloviIspod(m, abs))) {
    return { ok: false, status: 403, razlog: 'Forbidden path (konfiguracija/podaci ploče)' }
  }

  let jeDatoteka = false
  try { jeDatoteka = statSync(real).isFile() } catch {}
  if (!jeDatoteka) return { ok: false, status: 404, razlog: 'Not found' }
  return { ok: true, putanja: real, ime: (real.split(sep).pop() || 'file').replace(/["\r\n]/g, '') }
}

const MUTACIJE = new Set(['POST', 'PUT', 'DELETE', 'PATCH'])

export interface CorsUlaz {
  origin: string | null
  host: string
  metoda: string
  /** ALLOWED_HOSTS ploče; za Origin vrijede samo unosi S PORTOM (točan host:port). */
  dopusteni: string[]
  /** Zahtjev za WebSocket nadogradnju — preglednik ga šalje bez CORS-a, pa se brani ovdje. */
  websocket?: boolean
}

/**
 * Je li Origin vlastiti: njegov host:port jednak je Host zaglavlju zahtjeva, ili je
 * izričito (s portom) u popisu dopuštenih. Ime bez porta ne pokriva druge aplikacije
 * na istom stroju (http://localhost:8080 nije ploča).
 */
export function jeVlastitiOrigin(origin: string, host: string, dopusteni: string[]): boolean {
  let u: URL
  try { u = new URL(origin) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const port = u.port || (u.protocol === 'https:' ? '443' : '80')
  const hp = `${u.hostname}:${port}`
  const hostNorm = host.includes(':') ? host : `${host}:${u.protocol === 'https:' ? '443' : '80'}`
  if (hp === hostNorm || u.host === host) return true
  return dopusteni.some(d => d.includes(':') && d === hp)
}

/** CORS zaglavlja i smije li se zahtjev uopće obraditi. */
export function corsOdluka(ulaz: CorsUlaz): { dopusti: boolean; zaglavlja: Record<string, string> } {
  const { origin, host, metoda, dopusteni } = ulaz
  if (!origin) return { dopusti: true, zaglavlja: {} }
  if (!jeVlastitiOrigin(origin, host, dopusteni)) {
    return { dopusti: !ulaz.websocket && !MUTACIJE.has(metoda.toUpperCase()), zaglavlja: {} }
  }
  return {
    dopusti: true,
    zaglavlja: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
    },
  }
}
