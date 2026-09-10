/**
 * StepSchema — strukturirani izlaz koraka (W3 / TASK-4615).
 *
 * NALOG: `~/app/regoc_system/docs/PLAN-workflow-integracija.md` §3 W3 — „svaki korak dobiva
 * shemu izlaza (JSON: napravljeno, dokaz, datoteke, sljedeci_korak, nesigurnosti). Vratar
 * tada provjerava POLJA, a ne prozu."
 *
 * UZOR: `schema` u Anthropicovu `Workflow` alatu — podagent ne vraća prozu nego JSON koji se
 * validira na razini alata, pa model ponavlja dok ne pogodi oblik. Kod nas se „ponavljanje"
 * dogodi kroz vrata (`CompletionGuard` → HTTP 400 / `blocked`), jer naši izvršitelji nisu
 * pozivi alata nego procesi na ploči.
 *
 * ZAŠTO: danas je udio strojno provjerljivog dokaza blizu nule — `CompletionGuard` broji
 * REGEX MARKERE nad slobodnim tekstom (spomen riječi „bun" je „dokaz naredbe"). Taj sloj je
 * sam sebe označio kao `conf=heuristic` i zato je do danas u sjeni. Lažni „gotovo je" nam se
 * ponovio tri puta u istom danu: TASK-2953 zatvoren kao DONE uz vlastitu napomenu „nije još
 * deployan", pa TASK-2974 i TASK-2983 zatvoreni kao completed s porukom hook-blokade
 * u rezultatu. Polje `dokaz[].naredba` + `dokaz[].izlaz` je nešto što se može PONOVO POKRENUTI;
 * rečenica „sve je provjereno" nije.
 *
 * ŠTO OVAJ MODUL NAMJERNO NE RADI:
 *   • NE izvršava ništa iz agentova teksta. Nema `child_process`, `Bun.spawn`, mreže.
 *     `dokaz[].naredba` je PODATAK koji čovjek ili kritičar smiju ponoviti — ne naredba koju
 *     ovaj modul pušta. (Isti razlog kao `_zasto_zatvoren_rjecnik` u config/critic-gate.json.)
 *   • NE sudi o istinitosti izlaza. Sudi o OBLIKU: je li dokaz takav da ga netko MOŽE
 *     provjeriti. Istinitost je posao `CriticGate`-a (koji stvarno pokreće build/test).
 *
 * TRI NAČINA (isti obrazac kao WorkflowGate/W0 — jedini koji nam se pokazao siguran):
 *   `off`    — blok se ne ubacuje u prompt, sud se ne donosi. Put je bajt-identičan starome.
 *   `shadow` — blok SE ubacuje (inače nema što mjeriti), sud se donosi i logira, ali NE
 *              blokira: nevaljana shema ne zaustavlja zatvaranje zadatka.
 *   `on`     — nevaljana/nedostajuća shema je razlog za odbijanje u `CompletionGuard`-u.
 *
 * Autorica: Kosjenka (Architect), TASK-4615.
 */

import { konfigPutanja } from './paths'

// ─── Ugovor ───────────────────────────────────────────────────────────────────

/** Inačica sheme — mjerenje mora znati po kojim je pravilima redak ocijenjen. */
export const SHEMA_VERZIJA = 1

/** Redak-najava iznad JSON bloka. Traži se ZADNJI pojavak (agent smije citirati protokol). */
export const SHEMA_MARKER = 'REGOC-IZLAZ'

/** Polja koja izlaz koraka MORA imati. Redoslijed je i redoslijed u promptu. */
export const OBAVEZNA_POLJA = [
  'napravljeno',
  'dokaz',
  'datoteke',
  'sljedeci_korak',
  'nesigurnosti',
] as const

export type PoljeSheme = (typeof OBAVEZNA_POLJA)[number]

/** Zatvoren rječnik vrsta dokaza. Nepoznata vrsta je GREŠKA, ne tiho propuštanje. */
export const VRSTE_DOKAZA = [
  'naredba',
  'test',
  'datoteka',
  'mjerenje',
  'http',
  'commit',
  'url',
] as const

export type VrstaDokaza = (typeof VRSTE_DOKAZA)[number]

/** Kraće od ovoga „napravljeno" ne opisuje ništa — to je opet gola potvrda, samo u JSON-u. */
export const MIN_NAPRAVLJENO = 20

/** Strop na broj stavki dokaza koje uopće gledamo (obrana od zapisa od megabajta). */
export const MAX_STAVKI_DOKAZA = 50

export interface StavkaDokaza {
  vrsta?: string
  naredba?: string
  datoteka?: string
  izlaz?: string
  [k: string]: unknown
}

export interface IzlazKoraka {
  napravljeno: string
  dokaz: StavkaDokaza[]
  datoteke: string[]
  sljedeci_korak: string | null
  nesigurnosti: string[]
}

// ─── Parsiranje ──────────────────────────────────────────────────────────────

export interface RezultatParsiranja {
  /** Postoji li ikakav kandidat za JSON blok. */
  nadjen: boolean
  /** Doslovan tekst bloka (dijagnostika). */
  sirovo: string | null
  /** Razparsiran objekt, ili null ako JSON ne valja. */
  objekt: Record<string, unknown> | null
  /** Poruka parsera kad JSON ne valja. */
  greskaParsiranja: string | null
}

/**
 * Izreži uravnotežen `{...}` počevši od zadanog indeksa. Nizovi i escape se poštuju, pa
 * vitičasta zagrada unutar teksta („izlaz": "24 pass {ok}") ne razbija blok.
 */
function izrezijBlok(text: string, od: number): string | null {
  let dubina = 0
  let uNizu = false
  let escape = false
  for (let i = od; i < text.length; i++) {
    const c = text[i]
    if (escape) { escape = false; continue }
    if (c === '\\') { escape = true; continue }
    if (uNizu) { if (c === '"') uNizu = false; continue }
    if (c === '"') { uNizu = true; continue }
    if (c === '{') dubina++
    else if (c === '}') {
      dubina--
      if (dubina === 0) return text.slice(od, i + 1)
    }
  }
  return null
}

/** Indeksi svih `{` koji otvaraju objekt sa spomenom „napravljeno" (kandidati). */
function kandidati(text: string): number[] {
  const out: number[] = []
  const re = /\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push(m.index)
  return out
}

/**
 * Nađi izlaz koraka u slobodnom tekstu agenta.
 *
 * Redoslijed traženja (od najjačeg signala prema najslabijem) — uzima se ZADNJI valjani
 * kandidat, jer agent smije usput citirati predložak iz prompta:
 *   1. blok koji slijedi nakon marketa `REGOC-IZLAZ`
 *   2. bilo koji `{...}` koji sadrži i „napravljeno" i „dokaz"
 * Ograde ```json se ne traže posebno — brojanje zagrada ih preskače samo od sebe, pa
 * agent koji zaboravi ogradu (ili je stavi krivo) ne pada zbog formatiranja.
 */
export function parsirajIzlazKoraka(text?: string | null): RezultatParsiranja {
  const t = (text ?? '').toString()
  const prazno: RezultatParsiranja = { nadjen: false, sirovo: null, objekt: null, greskaParsiranja: null }
  if (!t.trim()) return prazno

  const markerIdx = t.lastIndexOf(SHEMA_MARKER)
  const pocetak = markerIdx >= 0 ? markerIdx : 0

  let zadnji: RezultatParsiranja | null = null
  for (const idx of kandidati(t)) {
    if (idx < pocetak) continue
    const blok = izrezijBlok(t, idx)
    if (!blok) continue
    if (!/"napravljeno"/.test(blok) || !/"dokaz"/.test(blok)) continue
    try {
      const objekt = JSON.parse(blok)
      if (objekt && typeof objekt === 'object' && !Array.isArray(objekt)) {
        zadnji = { nadjen: true, sirovo: blok, objekt: objekt as Record<string, unknown>, greskaParsiranja: null }
      }
    } catch (e) {
      // Zapamti neispravan blok samo ako još nemamo ispravan — poruka parsera je korisna
      // agentu ("Unexpected token"), ali ispravan blok uvijek pobjeđuje neispravan.
      if (!zadnji?.objekt) {
        zadnji = { nadjen: true, sirovo: blok, objekt: null, greskaParsiranja: (e as Error).message }
      }
    }
  }

  // Marker je bio, ali iza njega nema bloka → probaj cijeli tekst (agent je marker stavio na kraj).
  if (!zadnji && markerIdx >= 0) {
    for (const idx of kandidati(t)) {
      const blok = izrezijBlok(t, idx)
      if (!blok || !/"napravljeno"/.test(blok)) continue
      try {
        const objekt = JSON.parse(blok)
        if (objekt && typeof objekt === 'object' && !Array.isArray(objekt)) {
          zadnji = { nadjen: true, sirovo: blok, objekt: objekt as Record<string, unknown>, greskaParsiranja: null }
        }
      } catch { /* preskoči */ }
    }
  }

  return zadnji ?? prazno
}

// ─── Provjera polja (ovo je „vratar gleda polja, ne prozu") ──────────────────

/** Putanja ili ime datoteke s poznatom ekstenzijom — nešto što se može otvoriti. */
const PUTANJA_RE = /^(?:[~/]|\.{1,2}\/)?[\w.@\/-]*[\w-]\.\w{1,6}$|^\/[\w.@\/-]+$/u
const BROJ_RE = /\d/u
const SHA_RE = /\b[0-9a-f]{7,40}\b/iu
const HTTP_STATUS_RE = /\b[1-5]\d{2}\b/u
const URL_RE = /\bhttps?:\/\/\S+/u

export interface SudDokaza {
  /** Može li itko (čovjek ili kritičar) ovaj dokaz PONOVITI i usporediti? */
  provjerljiv: boolean
  /** Zašto nije — ide agentu natrag kao konkretna zamjerka. */
  razlog: string | null
}

/**
 * Je li POJEDINA stavka dokaza strojno provjerljiva?
 *
 * Mjerilo nije „zvuči uvjerljivo" nego „postoji ponovljiv postupak i očekivani ishod":
 * naredba + njezin izlaz, putanja koja se može otvoriti, izmjeren broj, statusni kod,
 * sha commita, URL. Sve ostalo je proza u JSON-u i ne broji se.
 */
export function provjeriStavkuDokaza(stavka: unknown): SudDokaza {
  if (!stavka || typeof stavka !== 'object' || Array.isArray(stavka)) {
    return { provjerljiv: false, razlog: 'stavka dokaza mora biti objekt {vrsta, …}' }
  }
  const s = stavka as StavkaDokaza
  const vrsta = typeof s.vrsta === 'string' ? s.vrsta.trim().toLowerCase() : ''
  if (!vrsta) return { provjerljiv: false, razlog: `nedostaje "vrsta" (dopušteno: ${VRSTE_DOKAZA.join(', ')})` }
  if (!(VRSTE_DOKAZA as readonly string[]).includes(vrsta)) {
    return { provjerljiv: false, razlog: `nepoznata vrsta "${vrsta}" (dopušteno: ${VRSTE_DOKAZA.join(', ')})` }
  }
  const naredba = typeof s.naredba === 'string' ? s.naredba.trim() : ''
  const datoteka = typeof s.datoteka === 'string' ? s.datoteka.trim() : ''
  const izlaz = typeof s.izlaz === 'string' ? s.izlaz.trim() : ''

  switch (vrsta as VrstaDokaza) {
    case 'naredba':
      if (naredba.length < 3) return { provjerljiv: false, razlog: 'vrsta "naredba" traži polje "naredba" (≥3 znaka)' }
      if (!izlaz) return { provjerljiv: false, razlog: 'vrsta "naredba" traži polje "izlaz" (što je naredba vratila)' }
      return { provjerljiv: true, razlog: null }
    case 'test':
      if (naredba.length < 3) return { provjerljiv: false, razlog: 'vrsta "test" traži polje "naredba" (kako se test pokreće)' }
      if (!BROJ_RE.test(izlaz)) return { provjerljiv: false, razlog: 'vrsta "test" traži brojčani "izlaz" (npr. "24 pass, 0 fail")' }
      return { provjerljiv: true, razlog: null }
    case 'datoteka':
      if (!datoteka) return { provjerljiv: false, razlog: 'vrsta "datoteka" traži polje "datoteka" (putanja)' }
      if (!PUTANJA_RE.test(datoteka)) return { provjerljiv: false, razlog: `"${datoteka}" ne izgleda kao putanja koja se može otvoriti` }
      return { provjerljiv: true, razlog: null }
    case 'mjerenje':
      if (!BROJ_RE.test(izlaz)) return { provjerljiv: false, razlog: 'vrsta "mjerenje" traži "izlaz" s brojem' }
      return { provjerljiv: true, razlog: null }
    case 'http':
      if (!HTTP_STATUS_RE.test(izlaz)) return { provjerljiv: false, razlog: 'vrsta "http" traži statusni kod u "izlaz" (npr. "200")' }
      return { provjerljiv: true, razlog: null }
    case 'commit':
      if (!SHA_RE.test(izlaz) && !SHA_RE.test(naredba)) return { provjerljiv: false, razlog: 'vrsta "commit" traži sha (7–40 hex) u "izlaz"' }
      return { provjerljiv: true, razlog: null }
    case 'url':
      if (!URL_RE.test(izlaz) && !URL_RE.test(naredba)) return { provjerljiv: false, razlog: 'vrsta "url" traži http(s) adresu u "izlaz"' }
      return { provjerljiv: true, razlog: null }
  }
  return { provjerljiv: false, razlog: `nepodržana vrsta "${vrsta}"` }
}

export interface SudPolja {
  valjan: boolean
  /** Konkretne zamjerke, jedna po retku — ovo se vraća agentu (W4 povratna petlja). */
  greske: string[]
  stavkiDokaza: number
  provjerljivih: number
}

function jeNizStringova(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

/**
 * Provjeri POLJA razparsiranog izlaza. Nikakvo gledanje u prozu: svaka zamjerka imenuje
 * polje i kaže što s njim nije u redu, da agent u sljedećem krugu zna što popraviti.
 */
export function provjeriPolja(objekt: Record<string, unknown> | null): SudPolja {
  const greske: string[] = []
  if (!objekt) return { valjan: false, greske: ['izlaz koraka nije valjan JSON objekt'], stavkiDokaza: 0, provjerljivih: 0 }

  for (const polje of OBAVEZNA_POLJA) {
    if (!(polje in objekt)) greske.push(`nedostaje polje "${polje}"`)
  }

  const napravljeno = objekt.napravljeno
  if ('napravljeno' in objekt) {
    if (typeof napravljeno !== 'string') greske.push('"napravljeno" mora biti tekst')
    else if (napravljeno.trim().length < MIN_NAPRAVLJENO) {
      greske.push(`"napravljeno" je prekratko (${napravljeno.trim().length} < ${MIN_NAPRAVLJENO} znakova) — opiši ŠTO je konkretno napravljeno`)
    }
  }

  let stavkiDokaza = 0
  let provjerljivih = 0
  const dokaz = objekt.dokaz
  if ('dokaz' in objekt) {
    if (!Array.isArray(dokaz)) {
      greske.push('"dokaz" mora biti niz stavki [{vrsta, …}]')
    } else if (dokaz.length === 0) {
      greske.push('"dokaz" je prazan — bez ijednog ponovljivog dokaza ovo je gola tvrdnja')
    } else {
      const gledamo = dokaz.slice(0, MAX_STAVKI_DOKAZA)
      stavkiDokaza = gledamo.length
      gledamo.forEach((s, i) => {
        const sud = provjeriStavkuDokaza(s)
        if (sud.provjerljiv) provjerljivih++
        else greske.push(`dokaz[${i}]: ${sud.razlog}`)
      })
      if (provjerljivih === 0) greske.push('nijedna stavka dokaza nije strojno provjerljiva')
    }
  }

  if ('datoteke' in objekt && !jeNizStringova(objekt.datoteke)) {
    greske.push('"datoteke" mora biti niz putanja (smije biti prazan)')
  }
  if ('nesigurnosti' in objekt && !jeNizStringova(objekt.nesigurnosti)) {
    greske.push('"nesigurnosti" mora biti niz rečenica (smije biti prazan)')
  }
  if ('sljedeci_korak' in objekt) {
    const sk = objekt.sljedeci_korak
    if (sk !== null && typeof sk !== 'string') greske.push('"sljedeci_korak" mora biti tekst ili null')
  }

  return { valjan: greske.length === 0, greske, stavkiDokaza, provjerljivih }
}

// ─── Sud o koraku ────────────────────────────────────────────────────────────

export type KodSheme = 'ok' | 'nema_sheme' | 'neispravan_json' | 'nevaljana_polja'

export interface SudKoraka {
  /** Ima li korak strojno provjerljiv dokaz? Ovo je BROJNIK mjerila iz plana §3 W3. */
  strojnoProvjerljiv: boolean
  kod: KodSheme
  nadjen: boolean
  valjan: boolean
  greske: string[]
  stavkiDokaza: number
  provjerljivih: number
  /** Datoteke koje je korak proglasio dirnutima — ulaz za CriticGate (polja umjesto proze). */
  datoteke: string[]
  sljedeciKorak: string | null
  nesigurnosti: string[]
  verzija: number
}

/** Puni sud o izlazu jednog koraka: parsiraj → provjeri polja → izračunaj mjerilo. */
export function ocijeniIzlazKoraka(text?: string | null): SudKoraka {
  const p = parsirajIzlazKoraka(text)
  if (!p.nadjen) {
    return {
      strojnoProvjerljiv: false, kod: 'nema_sheme', nadjen: false, valjan: false,
      greske: [`izlaz koraka nema blok ${SHEMA_MARKER} s poljima ${OBAVEZNA_POLJA.join(', ')}`],
      stavkiDokaza: 0, provjerljivih: 0, datoteke: [], sljedeciKorak: null, nesigurnosti: [],
      verzija: SHEMA_VERZIJA,
    }
  }
  if (!p.objekt) {
    return {
      strojnoProvjerljiv: false, kod: 'neispravan_json', nadjen: true, valjan: false,
      greske: [`blok ${SHEMA_MARKER} nije valjan JSON: ${p.greskaParsiranja}`],
      stavkiDokaza: 0, provjerljivih: 0, datoteke: [], sljedeciKorak: null, nesigurnosti: [],
      verzija: SHEMA_VERZIJA,
    }
  }
  const sud = provjeriPolja(p.objekt)
  const datoteke = jeNizStringova(p.objekt.datoteke) ? p.objekt.datoteke : []
  const nesigurnosti = jeNizStringova(p.objekt.nesigurnosti) ? p.objekt.nesigurnosti : []
  const sk = typeof p.objekt.sljedeci_korak === 'string' ? p.objekt.sljedeci_korak : null
  return {
    // Mjerilo je namjerno strože od „shema postoji": korak se broji kao strojno provjerljiv
    // SAMO ako su polja valjana I ako bar jedan dokaz netko može ponoviti.
    strojnoProvjerljiv: sud.valjan && sud.provjerljivih > 0,
    kod: sud.valjan ? 'ok' : 'nevaljana_polja',
    nadjen: true,
    valjan: sud.valjan,
    greske: sud.greske,
    stavkiDokaza: sud.stavkiDokaza,
    provjerljivih: sud.provjerljivih,
    datoteke,
    sljedeciKorak: sk,
    nesigurnosti,
    verzija: SHEMA_VERZIJA,
  }
}

/** Jednoredni zapis za dnevnik — isti oblik kao `CompletionGuard.formatVerdictLog`. */
export function formatSudKoraka(v: SudKoraka): string {
  return v.strojnoProvjerljiv
    ? `step-schema: OK dokaz=${v.provjerljivih}/${v.stavkiDokaza} datoteka=${v.datoteke.length}`
    : `step-schema: NEVALJAN ${v.kod} dokaz=${v.provjerljivih}/${v.stavkiDokaza} greske=${v.greske.length}${v.greske[0] ? ` prva="${v.greske[0]}"` : ''}`
}

/** Zamjerke složene za povratak agentu (W4). Kratko i konkretno, bez proze. */
export function zamjerkeZaAgenta(v: SudKoraka, maks = 6): string {
  if (v.strojnoProvjerljiv) return ''
  const lista = v.greske.slice(0, maks).map((g) => `  - ${g}`).join('\n')
  return `Izlaz koraka ne zadovoljava shemu ${SHEMA_MARKER} (v${v.verzija}):\n${lista}`
}

// ─── Način rada (off / shadow / on) ──────────────────────────────────────────

export type NacinSheme = 'off' | 'shadow' | 'on'

export const NACINI_SHEME: readonly NacinSheme[] = ['off', 'shadow', 'on'] as const

export interface StepSchemaConfig {
  nacin: NacinSheme
  /** Otkad se blok ubacuje u promptove — dijeli mjerenje na „prije" i „poslije". */
  aktiviranoU: string | null
  izvor: string
}

export const DEFAULT_STEP_SCHEMA_CONFIG: StepSchemaConfig = {
  nacin: 'shadow',   // isti obrazac kao W0: prvo mjeri na istom prometu, pa uključi
  aktiviranoU: null,
  izvor: '(zadano)',
}

const KES_TTL_MS = 30_000
let _cfg: { v: StepSchemaConfig; put: string; u: number; mtime: number; vel: number } | null = null

export function stepSchemaConfigPath(): string {
  return (
    process.env.REGOC_STEP_SCHEMA_CONFIG ||
    konfigPutanja('step-schema.json')
  )
}

/**
 * Učitaj način rada. Keš pada čim se promijeni vrijeme izmjene ili veličina datoteke
 * (gornja granica 30 s) — prekidač djeluje BEZ ponovnog pokretanja daemona.
 * Nedostajuća/neispravna datoteka → `shadow`, nikad tiho `on`.
 */
export function loadStepSchemaConfig(force = false): StepSchemaConfig {
  const put = stepSchemaConfigPath()
  const { existsSync, readFileSync, statSync } = require('fs') as typeof import('fs')
  let mtime = -1, vel = -1
  try { const st = statSync(put); mtime = st.mtimeMs; vel = st.size } catch { /* nema datoteke */ }
  if (!force && _cfg && _cfg.put === put && Date.now() - _cfg.u < KES_TTL_MS && _cfg.mtime === mtime && _cfg.vel === vel) {
    return _cfg.v
  }
  const cfg: StepSchemaConfig = { ...DEFAULT_STEP_SCHEMA_CONFIG }
  try {
    if (existsSync(put)) {
      const raw = JSON.parse(readFileSync(put, 'utf-8'))
      if (typeof raw?.nacin === 'string' && (NACINI_SHEME as readonly string[]).includes(raw.nacin)) {
        cfg.nacin = raw.nacin as NacinSheme
      }
      if (typeof raw?.aktiviranoU === 'string') cfg.aktiviranoU = raw.aktiviranoU
      cfg.izvor = put
    }
  } catch {
    // Neispravan JSON → shadow. Vrata nikad ne smiju srušiti poziv.
  }
  _cfg = { v: cfg, put, u: Date.now(), mtime, vel }
  return cfg
}

/** Ubacuje li se blok u promptove? (`off` = ni retka boilerplatea — ADR-0003.) */
export function shemaUPromptu(cfg: StepSchemaConfig = loadStepSchemaConfig()): boolean {
  return cfg.nacin !== 'off'
}

/** Smije li nevaljan izlaz STVARNO zaustaviti zatvaranje zadatka? Samo u načinu `on`. */
export function shemaSeProvodi(cfg: StepSchemaConfig = loadStepSchemaConfig()): boolean {
  return cfg.nacin === 'on'
}

// ─── Blok za prompt ──────────────────────────────────────────────────────────

/**
 * Odsjek koji ide u spawn-prompt. Namjerno kratak (~1 kB): ADR-0003 je izmjerio da naš
 * vlastiti boilerplate diže udio nepotrebnih odsjeka ×23,4, pa ovdje stoji samo ono bez
 * čega agent ne može pogoditi oblik — imena polja, rječnik vrsta i jedan primjer.
 */
export function blokShemeKoraka(cfg: StepSchemaConfig = loadStepSchemaConfig()): string {
  if (!shemaUPromptu(cfg)) return ''
  const provodi = shemaSeProvodi(cfg)
  return `
## STRUKTURIRANI IZLAZ KORAKA (${SHEMA_MARKER}) — uz REGOC-STATUS redak
Prije završnog REGOC-STATUS retka ispiši JSON blok. Vratar provjerava POLJA, ne prozu.

${SHEMA_MARKER}
\`\`\`json
{
  "napravljeno": "<što je konkretno napravljeno, jedna rečenica>",
  "dokaz": [
    {"vrsta": "naredba", "naredba": "bun test tests/x.test.ts", "izlaz": "24 pass, 0 fail"},
    {"vrsta": "datoteka", "datoteka": "src/core/X.ts", "izlaz": "312 redaka"}
  ],
  "datoteke": ["/putanja/koju/si/dirao.ts"],
  "sljedeci_korak": "<što slijedi, ili null>",
  "nesigurnosti": ["<što nisi mogao provjeriti>"]
}
\`\`\`

Pravila (${provodi ? 'ODBIJA se izlaz koji ih krši' : 'način shadow: sud se bilježi, ne blokira'}):
- "dokaz" mora imati BAR JEDNU stavku koju netko može PONOVITI. Vrste: ${VRSTE_DOKAZA.join(', ')}.
- naredba/test → obavezno "naredba" + "izlaz"; datoteka → "datoteka" (putanja);
  mjerenje → broj u "izlaz"; http → statusni kod; commit → sha; url → adresa.
- "nesigurnosti" je mjesto za ono što nisi mogao provjeriti — prazan niz ako svega nema.
  Tu rečenicu NE stavljaj u "napravljeno": ondje ide samo ono što je stvarno napravljeno.
`
}
