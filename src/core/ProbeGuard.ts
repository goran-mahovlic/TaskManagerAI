/**
 * ProbeGuard — obrana gumba „Probaj konekciju" (DIZAJN-integracije §1.4).
 *
 * KVAR KOJI OVO ZATVARA: svaka proba šalje zahtjev na adresu koju je upisao KORISNIK. Bez
 * ograničenja to je klasičan SSRF — ploča postaje posrednik prema unutarnjoj mreži, a
 * odgovor bi joj vratio sadržaj stranica do kojih napadač inače ne dolazi.
 *
 * ŠTO OVDJE NIJE NAPRAVLJENO I ZAŠTO. Zabrana privatnih raspona (10/8, 172.16/12,
 * 192.168/16, 127/8, 169.254/16) NIJE tvrda: kućni Nextcloud i lokalni GitLab žive upravo
 * ondje, pa bi tvrda zabrana cijelu značajku učinila beskorisnom za samostalno hostanje.
 * Zato je to postavka (`dopustiPrivatneMreze`, zadano `true`) uz vidljivo upozorenje na
 * kartici. Instalacija izložena internetu je isključi.
 *
 * Pravilo o odgovoru: proba vraća SAŽETAK (status, trajanje, poslužitelj), nikad sirovo
 * tijelo — inače „Probaj" postaje čitač unutarnjih stranica.
 *
 * Autorica: Jelena (Engineer), TASK-4800.
 */

export interface ProbeOpcije {
  /** Dopusti `http://` (zadano samo `https://`). */
  dopustiHttp?: boolean
  /** Dopusti privatne/lokalne raspone (zadano `true` — v. komentar gore). */
  dopustiPrivatneMreze?: boolean
  rokMs?: number
  maxBajtova?: number
  method?: string
  headers?: Record<string, string>
  body?: string
}

export interface ProbeIshod {
  ok: boolean
  greska?: string
  detalj?: {
    status?: number
    trajanjeMs?: number
    posluzitelj?: string | null
    velicinaB?: number
  }
  /** Prvih nekoliko stotina znakova — SAMO za pozivatelja koji zna što traži (npr. XML). */
  isjecak?: string
}

export const PROBE_ZADANO = {
  rokMs: 10_000,
  maxBajtova: 64 * 1024,
  razmakMs: 5_000,
} as const

const ZABRANJENE_SHEME = ['file:', 'gopher:', 'ftp:', 'data:', 'ws:', 'wss:']

/** Zadnja proba po modulu — jedna u 5 s, da „Probaj" ne postane skener (§1.4 t.3). */
const zadnjaProba = new Map<string, number>()

export function prigusenje(modul: string, razmakMs = PROBE_ZADANO.razmakMs, sada = Date.now()):
  { ok: boolean; cekajMs: number } {
  const prije = zadnjaProba.get(modul) || 0
  const proteklo = sada - prije
  if (proteklo < razmakMs) return { ok: false, cekajMs: razmakMs - proteklo }
  zadnjaProba.set(modul, sada)
  return { ok: true, cekajMs: 0 }
}

/** Samo za testove — inače bi drugi test čekao 5 s zbog prvoga. */
export function resetirajPrigusenje(): void { zadnjaProba.clear() }

function privatnaAdresa(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (h === '::1' || h.startsWith('[::1')) return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0
}

export interface ProvjeraUrl {
  ok: boolean
  greska?: string
  url?: URL
}

/** Provjeri adresu PRIJE ijednog mrežnog poziva. Odbijenica uvijek nosi razlog. */
export function provjeriUrl(sirovi: string, opcije: ProbeOpcije = {}): ProvjeraUrl {
  const tekst = String(sirovi || '').trim()
  if (!tekst) return { ok: false, greska: 'adresa nije upisana' }
  let url: URL
  try { url = new URL(tekst) } catch { return { ok: false, greska: 'adresa nije ispravan URL' } }

  if (ZABRANJENE_SHEME.includes(url.protocol)) {
    return { ok: false, greska: `shema ${url.protocol} nije dopuštena` }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, greska: `shema ${url.protocol} nije dopuštena (dopušteno: https, http)` }
  }
  if (url.protocol === 'http:' && !opcije.dopustiHttp) {
    return { ok: false, greska: 'nešifrirani http nije dopušten (uključi „dopusti http" ako doista treba)' }
  }
  if (opcije.dopustiPrivatneMreze === false && privatnaAdresa(url.hostname)) {
    return { ok: false, greska: `adresa ${url.hostname} je u privatnoj mreži, a to je isključeno u postavkama` }
  }
  if (url.username || url.password) {
    return { ok: false, greska: 'korisničko ime i lozinka ne idu u adresu (idu u zasebna polja)' }
  }
  return { ok: true, url }
}

/**
 * Jedan probni zahtjev s obranama: rok, ručno preusmjeravanje, gornja granica odgovora.
 *
 * `redirect: 'manual'` je bitan: automatsko slijeđenje preusmjeravanja vodi na host koji
 * korisnik NIJE upisao, pa bi sve provjere iznad vrijedile samo za prvi skok.
 */
export async function probaj(
  sirovi: string,
  opcije: ProbeOpcije = {},
): Promise<ProbeIshod> {
  const provjera = provjeriUrl(sirovi, opcije)
  if (!provjera.ok || !provjera.url) return { ok: false, greska: provjera.greska }

  const rok = opcije.rokMs ?? PROBE_ZADANO.rokMs
  const maxB = opcije.maxBajtova ?? PROBE_ZADANO.maxBajtova
  const kontrola = new AbortController()
  const prekid = setTimeout(() => kontrola.abort(), rok)
  const pocetak = Date.now()
  try {
    const resp = await fetch(provjera.url.toString(), {
      method: opcije.method || 'GET',
      headers: opcije.headers,
      body: opcije.body,
      redirect: 'manual',
      signal: kontrola.signal,
    })
    const trajanjeMs = Date.now() - pocetak

    if (resp.status >= 300 && resp.status < 400) {
      const kamo = resp.headers.get('location') || ''
      let drugiHost = true
      try { drugiHost = new URL(kamo, provjera.url).host !== provjera.url.host } catch { /* neispravan location */ }
      if (drugiHost) {
        return {
          ok: false,
          greska: 'poslužitelj preusmjerava na drugi host — proba se zaustavlja (SSRF obrana)',
          detalj: { status: resp.status, trajanjeMs, posluzitelj: resp.headers.get('server') },
        }
      }
    }

    const tekst = await resp.text().catch(() => '')
    const velicinaB = new TextEncoder().encode(tekst).length
    if (velicinaB > maxB) {
      return {
        ok: false,
        greska: `odgovor je veći od ${Math.round(maxB / 1024)} KB — proba ne čita tolike odgovore`,
        detalj: { status: resp.status, trajanjeMs, posluzitelj: resp.headers.get('server'), velicinaB },
      }
    }
    return {
      ok: resp.ok || (resp.status >= 200 && resp.status < 400),
      greska: resp.ok ? undefined : `HTTP ${resp.status}`,
      detalj: {
        status: resp.status, trajanjeMs,
        posluzitelj: resp.headers.get('server'), velicinaB,
      },
      isjecak: tekst.slice(0, 400),
    }
  } catch (e: any) {
    const razlog = e?.name === 'AbortError'
      ? `poslužitelj se nije javio u ${Math.round(rok / 1000)} s`
      : String(e?.message || e)
    return { ok: false, greska: razlog, detalj: { trajanjeMs: Date.now() - pocetak } }
  } finally {
    clearTimeout(prekid)
  }
}

/**
 * Zapis u dnevnik BEZ tajne i bez punog URL-a s korisničkim imenom (§1.4 t.5).
 * Ostaje shema + host + putanja; upit i vjerodajnice otpadaju.
 */
export function sigurniZapis(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return '(neispravan URL)'
  }
}
