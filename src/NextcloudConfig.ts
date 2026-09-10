/**
 * NextcloudConfig — postavke i osnovni WebDAV klijent (DIZAJN-integracije §2).
 *
 * ŠTO OVO MIJENJA: polje `nextcloudFolder` na zadatku dosad je bilo samo tekstualna
 * etiketa — nitko ništa nije čitao ni pisao na Nextcloud. Ovaj modul daje mapu i datoteku.
 *
 * BEZ VANJSKIH KNJIŽNICA: WebDAV je HTTP s nekoliko dodatnih metoda (`PROPFIND`, `MKCOL`,
 * `PUT`), pa ide izravnim `fetch`-om, isto kao Telegram.
 *
 * OPSEG: `osigurajMapu` + `postaviDatoteku`. Sinkronizacija u oba smjera NIJE ovdje — to je
 * posao `rclone`-a i ne treba mu naša loša preslika.
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

import { ConfigModul, procitajTajnu, tajnaPostavljena, type StanjeIntegracije } from './core/ConfigModul'
import { probaj as probajUrl, provjeriUrl, prigusenje, sigurniZapis } from './core/ProbeGuard'

export interface NextcloudPostavke {
  ukljucen: boolean
  baseUrl: string
  korisnik: string
  /** IME varijable okoline s lozinkom aplikacije — nikad sama lozinka. */
  lozinkaEnv: string
  korijenskaMapa: string
  mapaPoProjektu: boolean
  dopustiHttp: boolean
  dopustiPrivatneMreze: boolean
}

export const ZADANE_POSTAVKE: NextcloudPostavke = {
  ukljucen: false,
  baseUrl: '',
  korisnik: '',
  lozinkaEnv: 'NEXTCLOUD_APP_PASSWORD',
  korijenskaMapa: '',
  mapaPoProjektu: true,
  dopustiHttp: false,
  dopustiPrivatneMreze: true,
}

export const GRANICE = {
  baseUrl: { maxDuljina: 200 },
  korisnik: { maxDuljina: 100 },
  lozinkaEnv: { maxDuljina: 64 },
  korijenskaMapa: { maxDuljina: 100 },
} as const

/**
 * Naziv mape bez `..`, bez vodeće kose crte i bez obrnute kose crte — obrana od izlaska iz
 * mape. Ista provjera vrijedi i za putanju koju gradi `putanjaProjekta()`.
 */
const RE_MAPA = /^(?!.*\.\.)(?!\/)[^\\:*?"<>|]{0,100}$/

const modul = new ConfigModul<NextcloudPostavke>({
  ime: 'nextcloud',
  datoteka: 'nextcloud.json',
  envVar: 'TM_NEXTCLOUD_CONFIG',
  zadane: ZADANE_POSTAVKE,
  shema: {
    ukljucen: { tip: 'bool' },
    baseUrl: {
      tip: 'tekst', obavezno: true, maxDuljina: GRANICE.baseUrl.maxDuljina,
      uzorak: /^https?:\/\/[^\s]+$/, uzorakPoruka: 'mora biti oblika https://oblak.primjer.hr',
    },
    korisnik: { tip: 'tekst', obavezno: true, maxDuljina: GRANICE.korisnik.maxDuljina },
    lozinkaEnv: {
      tip: 'tekst', obavezno: true, maxDuljina: GRANICE.lozinkaEnv.maxDuljina, tajnaEnv: true,
      uzorak: /^[A-Z][A-Z0-9_]*$/, uzorakPoruka: 'upiši IME varijable okoline (VELIKIM_SLOVIMA), ne lozinku',
    },
    korijenskaMapa: {
      tip: 'tekst', maxDuljina: GRANICE.korijenskaMapa.maxDuljina,
      uzorak: RE_MAPA, uzorakPoruka: 'bez „..", bez vodeće kose crte i bez obrnute kose crte',
    },
    mapaPoProjektu: { tip: 'bool' },
    dopustiHttp: { tip: 'bool' },
    dopustiPrivatneMreze: { tip: 'bool' },
  },
})

/**
 * Putanja se razrjesava PRI SVAKOM CITANJU (v. `ConfigModul.putanja`) — zamrznuta
 * vrijednost pokazivala bi na primjer uz paket i nakon prvog zapisa u `$TM_HOME/config/`.
 */
export function NEXTCLOUD_CONFIG_PATH(): string { return modul.putanja }

/** Sam modul — ploca ga treba za putanju i za stanje. */
export const nextcloudKonfigModul = modul

export const loadNextcloudConfig = (path?: string) => modul.load(path)
export const validateNextcloudPatch = (tijelo: unknown) => modul.validate(tijelo)
export const saveNextcloudConfig = (zakrpa: Partial<NextcloudPostavke>, path?: string) =>
  modul.save(zakrpa, path)

export function stanjeNextcloud(cfg: NextcloudPostavke = loadNextcloudConfig()): StanjeIntegracije {
  const tajna = tajnaPostavljena(cfg.lozinkaEnv)
  let zastoKey = 'int_zasto_spreman'
  let zastoVars: Record<string, string> | undefined
  let spreman = true
  if (!cfg.ukljucen) { spreman = false; zastoKey = 'int_zasto_iskljucen' }
  else if (!cfg.baseUrl) { spreman = false; zastoKey = 'int_zasto_nema_adrese' }
  else if (!cfg.korisnik) { spreman = false; zastoKey = 'int_zasto_nema_korisnika' }
  else if (!tajna) { spreman = false; zastoKey = 'int_zasto_treba_kljuc'; zastoVars = { env: cfg.lozinkaEnv } }
  return { ukljucen: cfg.ukljucen, tajnaPostavljena: tajna, spreman, zastoKey, zastoVars }
}

// ─── WebDAV ──────────────────────────────────────────────────────────────────

function davKorijen(cfg: NextcloudPostavke): string {
  return `${cfg.baseUrl.replace(/\/+$/, '')}/remote.php/dav/files/${encodeURIComponent(cfg.korisnik)}`
}

function zaglavlja(cfg: NextcloudPostavke): Record<string, string> | null {
  const lozinka = procitajTajnu(cfg.lozinkaEnv)
  if (!lozinka) return null
  const osnova = Buffer.from(`${cfg.korisnik}:${lozinka}`).toString('base64')
  return { Authorization: `Basic ${osnova}` }
}

/** Putanja mape zadatka: `<korijen>/<Projekt>` ili samo `<korijen>`. */
export function putanjaProjekta(cfg: NextcloudPostavke, projectId?: string | null): string {
  const dijelovi = [cfg.korijenskaMapa]
  if (cfg.mapaPoProjektu && projectId) dijelovi.push(String(projectId))
  return dijelovi
    .map(d => String(d || '').trim().replace(/^\/+|\/+$/g, ''))
    .filter(d => d && RE_MAPA.test(d))
    .join('/')
}

export interface WebDavIshod { ok: boolean; greska?: string; status?: number }

/** `MKCOL` po razinama. Postojeća mapa (405) nije greška. */
export async function osigurajMapu(
  putanja: string, cfg: NextcloudPostavke = loadNextcloudConfig(),
): Promise<WebDavIshod> {
  const h = zaglavlja(cfg)
  if (!h) return { ok: false, greska: `lozinka nije postavljena (varijabla ${cfg.lozinkaEnv})` }
  const dijelovi = putanja.split('/').filter(Boolean)
  let dosad = ''
  for (const d of dijelovi) {
    if (!RE_MAPA.test(d)) return { ok: false, greska: `neispravan naziv mape: ${d}` }
    dosad += `/${encodeURIComponent(d)}`
    try {
      const r = await fetch(davKorijen(cfg) + dosad, { method: 'MKCOL', headers: h })
      if (!r.ok && r.status !== 405) {
        return { ok: false, status: r.status, greska: `MKCOL ${dosad}: HTTP ${r.status}` }
      }
    } catch (e: any) {
      return { ok: false, greska: `mrežna greška: ${String(e?.message || e)}` }
    }
  }
  return { ok: true }
}

/** `PUT` datoteke. Mapa se ne stvara sama — pozovi `osigurajMapu` prije. */
export async function postaviDatoteku(
  putanja: string, sadrzaj: string | Uint8Array, cfg: NextcloudPostavke = loadNextcloudConfig(),
): Promise<WebDavIshod> {
  const h = zaglavlja(cfg)
  if (!h) return { ok: false, greska: `lozinka nije postavljena (varijabla ${cfg.lozinkaEnv})` }
  const sigurna = putanja.split('/').filter(Boolean)
  if (sigurna.some(d => !RE_MAPA.test(d) && d !== sigurna[sigurna.length - 1])) {
    return { ok: false, greska: 'neispravna putanja' }
  }
  if (putanja.includes('..')) return { ok: false, greska: 'putanja ne smije sadržavati „.."' }
  try {
    const url = davKorijen(cfg) + '/' + sigurna.map(encodeURIComponent).join('/')
    const r = await fetch(url, { method: 'PUT', headers: h, body: sadrzaj as any })
    return r.ok
      ? { ok: true, status: r.status }
      : { ok: false, status: r.status, greska: `PUT: HTTP ${r.status}` }
  } catch (e: any) {
    return { ok: false, greska: `mrežna greška: ${String(e?.message || e)}` }
  }
}

// ─── Proba ───────────────────────────────────────────────────────────────────

export interface Ishod { ok: boolean; greska?: string; detalj?: Record<string, unknown> }

/**
 * `PROPFIND Depth: 0` na korijen korisnika. `207 Multi-Status` = radi.
 * Poruke po ishodu, jer „HTTP 401" korisniku ne kaže što da napravi.
 */
export async function probajNextcloud(path?: string): Promise<Ishod> {
  const cfg = loadNextcloudConfig(path)
  if (!cfg.baseUrl) return { ok: false, greska: 'adresa poslužitelja nije upisana' }
  if (!cfg.korisnik) return { ok: false, greska: 'korisničko ime nije upisano' }

  const provjera = provjeriUrl(cfg.baseUrl, {
    dopustiHttp: cfg.dopustiHttp, dopustiPrivatneMreze: cfg.dopustiPrivatneMreze,
  })
  if (!provjera.ok) return { ok: false, greska: provjera.greska }

  const p = prigusenje('nextcloud')
  if (!p.ok) return { ok: false, greska: `pričekaj još ${Math.ceil(p.cekajMs / 1000)} s prije nove probe` }

  const h = zaglavlja(cfg)
  if (!h) return { ok: false, greska: `lozinka aplikacije nije postavljena (varijabla ${cfg.lozinkaEnv})` }

  const ishod = await probajUrl(davKorijen(cfg) + '/', {
    method: 'PROPFIND',
    headers: { ...h, Depth: '0' },
    dopustiHttp: cfg.dopustiHttp,
    dopustiPrivatneMreze: cfg.dopustiPrivatneMreze,
  })
  const status = ishod.detalj?.status
  if (status === 207) return { ok: true, detalj: { ...ishod.detalj, adresa: sigurniZapis(cfg.baseUrl) } }
  if (status === 401) return { ok: false, greska: 'korisnik ili lozinka aplikacije nisu točni', detalj: ishod.detalj }
  if (status === 404) return { ok: false, greska: 'adresa nije Nextcloud ili korisnik ne postoji', detalj: ishod.detalj }
  if (!status) return { ok: false, greska: ishod.greska || 'poslužitelj nije dostupan', detalj: ishod.detalj }
  return { ok: false, greska: ishod.greska || `neočekivan odgovor HTTP ${status}`, detalj: ishod.detalj }
}
