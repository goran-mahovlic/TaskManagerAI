/**
 * OdlukeRazvrstaj.ts — JEDAN filtar za traku „Čeka odluku" i za odlučitelja (TASK-5173).
 *
 * POVOD (03.10.2026.): traka je pisala „3 zadataka u redu odlučitelja — odlučuje model, ne
 * čekaju tebe", a odlučitelj u istom trenutku „nema zadataka koji čekaju odluku" (pregledano
 * 0). Ploča je brojila sve zadatke s ljudskom oznakom, a `odlucitelj.py` (`cekaju()`) je
 * ispravno preskakao strojne okidače i nedovršene ovisnosti. Dva filtra, dvije istine.
 * Jedan od tri (TASK-4717, reboot traži sudo) stvarno je čekao vlasnika — „ne čeka tebe" je
 * za njega bila laž.
 *
 * Sad poslužitelj svakom zadatku u `/api/odluke` računa skupinu i `zaOdlucitelja`, a
 * odlučitelj NE filtrira sam nego čita to polje. Skupine trake:
 *   model   — odlučuje model (prekidač uključen, ništa drugo ne drži zadatak)
 *   strojni — čeka strojni okidač: nedovršenu ovisnost ili `okidac-strojni` (ADR-0010)
 *   covjek  — čeka tebe: ljudski potez (sudo, fizički rad…) ili odluka dok model ne odlučuje
 */

export type SkupinaOdluke = 'model' | 'strojni' | 'covjek'

/** Oznake koje traže LJUDSKI POTEZ, ne prosudbu — model ih ne smije „odlučiti". */
export const OZNAKE_COVJEKA = ['waiting-for-human', 'interactive', 'no-autonomy']
export const OZNAKA_STROJNI = 'okidac-strojni'

export interface ZadatakOdluke {
  id?: string
  title?: string
  tags?: unknown
  /** SAMO nezatvorene ovisnosti (kako ih računa `handleGetOdluke`). */
  cekaNa?: string[]
  blockedReason?: string | null
  description?: string | null
  pitanje?: { pitanje?: string } | null
  odgoda?: { do?: string } | null
}

export interface OpcijeRazvrstaja {
  /** `ukljucen` iz config/odlucitelj.json. */
  modelOdlucuje: boolean
  /** `pusta_strojni_okidac` iz config/odlucitelj.json — ista sklopka koju čita alat. */
  pustaStrojni: boolean
  sada?: number
}

export interface DoKada { tekst: string; iso: string; prosao: boolean }

export interface Razvrstaj {
  skupina: SkupinaOdluke
  /** Što zadatak drži — za strojni okidač i za čovjeka. */
  sto: string
  /** Do kada — prvi budući nadnevak iz razloga/opisa, ili zadnji prošli (`prosao: true`). */
  doKada: DoKada | null
}

const oznake = (t: ZadatakOdluke): string[] =>
  Array.isArray(t.tags) ? t.tags.map(g => String(g).trim().toLowerCase()) : []

const imaLjudskuOznaku = (t: ZadatakOdluke) => oznake(t).some(g => OZNAKE_COVJEKA.includes(g))
const imaStrojni = (t: ZadatakOdluke) => oznake(t).includes(OZNAKA_STROJNI)

function odgodaTraje(t: ZadatakOdluke, sada: number): boolean {
  const d = Date.parse(String(t.odgoda?.do ?? ''))
  return !Number.isNaN(d) && d > sada
}

/**
 * Skupina BEZ obzira na prekidač — redoslijed je namjeran:
 * ovisnost prva (ni čovjek ne može ništa dok drugi zadatak ne završi), pa ljudski potez
 * (pobjeđuje `okidac-strojni`: TASK-4717 nosi obje oznake, a čeka čovjeka), pa strojni okidač.
 */
function osnovnaSkupina(t: ZadatakOdluke, o: OpcijeRazvrstaja): 'ovisnost' | 'covjek' | 'strojni' | 'odluka' {
  if ((t.cekaNa ?? []).length) return 'ovisnost'
  if (imaLjudskuOznaku(t)) return 'covjek'
  if (imaStrojni(t) && !o.pustaStrojni) return 'strojni'
  return 'odluka'
}

/**
 * Filtar odlučitelja — JEDINI. `odlucitelj.py` (`cekaju()`) čita ovo polje iz `/api/odluke`.
 * Ne ovisi o prekidaču: kad je isključen, alat ionako ništa ne upisuje, a proba (`--proba`)
 * mora pokazati isti red koji bi uključen prekidač obradio.
 */
export function zaOdlucitelja(t: ZadatakOdluke, o: OpcijeRazvrstaja): boolean {
  return osnovnaSkupina(t, o) === 'odluka' && !odgodaTraje(t, o.sada ?? Date.now())
}

export function razvrstajOdluku(t: ZadatakOdluke, o: OpcijeRazvrstaja): Razvrstaj {
  const sada = o.sada ?? Date.now()
  const razlog = String(t.blockedReason ?? '')
  const rok = () => nadnevakIzTeksta(razlog, sada) ?? nadnevakIzTeksta(String(t.description ?? ''), sada)
  switch (osnovnaSkupina(t, o)) {
    case 'ovisnost':
      return { skupina: 'strojni', sto: `dovršetak ${(t.cekaNa ?? []).join(', ')}`, doKada: null }
    case 'strojni':
      return { skupina: 'strojni', sto: sazetakRazloga(razlog) || prviRedak(t.description), doKada: rok() }
    case 'covjek':
      return { skupina: 'covjek', sto: sazetakRazloga(razlog) || prviRedak(t.description), doKada: rok() }
    default:
      if (o.modelOdlucuje) return { skupina: 'model', sto: '', doKada: null }
      return { skupina: 'covjek', sto: String(t.pitanje?.pitanje || t.title || '').trim(), doKada: null }
  }
}

export function zbrojiSkupine(r: Array<{ skupina: SkupinaOdluke }>): Record<SkupinaOdluke, number> {
  const z = { model: 0, strojni: 0, covjek: 0 }
  for (const x of r) z[x.skupina]++
  return z
}

function prviRedak(s: unknown): string {
  return sazetakRazloga(String(s ?? '').split('\n').find(r => r.trim()) ?? '')
}

/**
 * `blockedReason` u ljudskom obliku: bez „BLOCKED: Agent je sam deklarirao BLOCKED:" i bez
 * vratareve završne rečenice — ostane ono što zadatak doista drži. Reže na granici riječi.
 */
export function sazetakRazloga(s: string | null | undefined, max = 240): string {
  let t = String(s ?? '').replace(/\s+/g, ' ').trim()
  t = t.replace(/^(BLOCKED:\s*)?(Agent je sam deklarirao BLOCKED:\s*)?/i, '')
  t = t.replace(/\s*Zatvaranje kao completed proturječi vlastitoj izjavi agenta\.?\s*$/i, '').trim()
  if (t.length <= max) return t
  const rez = t.slice(0, max)
  const razmak = rez.lastIndexOf(' ')
  return (razmak > max * 0.6 ? rez.slice(0, razmak) : rez).replace(/[\s,;:.]+$/, '') + '…'
}

const HR_NADNEVAK = /(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})\.?(?:\s+(\d{1,2}):(\d{2})(Z)?)?/g
const ISO_NADNEVAK = /(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?)?/g

function sastavi(g: number, m: number, d: number, h: number, min: number, s: number, utc: boolean): number | null {
  const ms = utc ? Date.UTC(g, m - 1, d, h, min, s) : new Date(g, m - 1, d, h, min, s).getTime()
  const x = new Date(ms)
  const [gg, mm, dd] = utc ? [x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()]
                           : [x.getFullYear(), x.getMonth() + 1, x.getDate()]
  return (gg === g && mm === m && dd === d && h < 24 && min < 60) ? ms : null
}

/**
 * Nadnevak okidača iz slobodnog teksta. Budući pobjeđuje (najraniji od budućih); kad su svi
 * prošli, vraća zadnji uz `prosao: true` — rok iz opisa koji je davno istekao je SIGNAL da
 * okidač treba provjeriti, ne podatak za skrivanje.
 */
export function nadnevakIzTeksta(tekst: string, sada: number = Date.now()): DoKada | null {
  const nadjeni: Array<{ tekst: string; ms: number }> = []
  for (const m of String(tekst || '').matchAll(HR_NADNEVAK)) {
    const ms = sastavi(+m[3], +m[2], +m[1], +(m[4] ?? 0), +(m[5] ?? 0), 0, m[6] === 'Z')
    if (ms != null) nadjeni.push({ tekst: m[0].trim(), ms })
  }
  for (const m of String(tekst || '').matchAll(ISO_NADNEVAK)) {
    let ms: number | null
    if (m[7] && m[7] !== 'Z') ms = Date.parse(m[0].replace(' ', 'T'))
    else ms = sastavi(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), m[7] === 'Z')
    if (ms != null && !Number.isNaN(ms)) nadjeni.push({ tekst: m[0].trim(), ms })
  }
  if (!nadjeni.length) return null
  const buduci = nadjeni.filter(n => n.ms > sada).sort((a, b) => a.ms - b.ms)
  const izbor = buduci[0] ?? nadjeni.sort((a, b) => b.ms - a.ms)[0]
  return { tekst: izbor.tekst, iso: new Date(izbor.ms).toISOString(), prosao: izbor.ms <= sada }
}
