/**
 * PostaPrivitci — privitci e-pošte spremaju se na disk (TASK-5508), a putanja ide dalje u
 * tekstu kao i za Telegram: `[PRIVITAK: /putanja]`.
 *
 * Povod (14.10.2026.): mail „Fasada" s PDF-om od 8 MB i dvije slike — u `posta.json`
 * su bila samo IMENA privitaka, pa je razgovorni bot rekao „datoteke nisu na disku" i tražio
 * od čovjeka da ih ručno proslijedi. Ovo je OPCIJA paketa (`email.json` → `imap.privitci`,
 * zadano isključena), ne zakrpa za jedan stroj.
 *
 * SIGURNOST (ista četiri uvjeta kao `TelegramPrivitci`, sva su uvjet):
 *   1. preuzima se samo od dopuštenih pošiljatelja — `posiljatelji` (adresa, `@domena` ili `*`);
 *      prazan popis = ne preuzima se ništa. `*` je svjestan izbor vlasnika, ne zadano;
 *   2. ime datoteke je SANITIZIRANO (`cistoIme`), a odredište se još jednom provjeri da je
 *      unutar mape maila (`zapisiPrivitak`);
 *   3. strop veličine vrijedi dvaput: prema veličini dijela iz strukture poruke PRIJE
 *      preuzimanja (base64 se preračuna na stvarne bajtove) i prema preuzetim bajtovima;
 *   4. datoteka se piše s pravima 0600 — nikad izvršna — i ništa je ne pokreće.
 *
 * Preuzima se DIO PO DIO (`BODY.PEEK[<dio>]`), nikad cijela poruka: i poruka veća od stropa
 * za tijelo (`NAJVISE_BAJTA_PORUKE`) dobiva svoje privitke, a mail ostaje nepročitan.
 *
 * Autorica: Jelena (Engineer), TASK-5508.
 */

import { join } from 'path'
import { TM_ROOT } from './core/paths'
import { cistoIme, zapisiPrivitak, type Preuzeto } from './TelegramPrivitci'

export type VrstaMailPrivitka =
  | 'pdf' | 'slika' | 'dokument' | 'tablica' | 'prezentacija' | 'tekst' | 'arhiva' | 'zvuk' | 'video' | 'ostalo'

export const VRSTE_MAIL_PRIVITAKA: readonly VrstaMailPrivitka[] =
  ['pdf', 'slika', 'dokument', 'tablica', 'prezentacija', 'tekst', 'arhiva', 'zvuk', 'video', 'ostalo']

export interface PostaPrivitci {
  ukljucen: boolean
  /** Prazno = `$TM_HOME/privitci/posta`. Ispod se uvijek slaže `<uid>/`. */
  mapa: string
  /** Strop po datoteci (stvarni bajtovi, ne base64). */
  maxMB: number
  vrste: VrstaMailPrivitka[]
  /** `ime@domena`, `@domena` ili `*`. Prazno = ne preuzima se ništa. */
  posiljatelji: string[]
}

export const ZADANI_POSTA_PRIVITCI: PostaPrivitci = {
  ukljucen: false,
  mapa: '',
  maxMB: 25,
  // `ostalo` (izvršne datoteke, nepoznati formati) samo na izričit izbor.
  vrste: VRSTE_MAIL_PRIVITAKA.filter(v => v !== 'ostalo'),
  posiljatelji: [],
}

export const GRANICE_POSTA_PRIVITAKA = {
  maxMB: { min: 1, max: 100 },
  mapa: { maxDuljina: 300 },
  posiljatelji: { maxStavki: 50 },
  /** Više privitaka od ovoga u jednom mailu se ne preuzima (ostali dobiju razlog). */
  najviseDatoteka: 20,
} as const

/** Apsolutna putanja bez `..` segmenta, ili prazno (= zadana mapa). */
export const RE_MAPA_PRIVITAKA = /^(?!.*(?:^|\/)\.\.(?:\/|$))(?:\/.*)?$/
/** `*`, `@domena.tld` ili `ime@domena.tld`. */
export const RE_POSILJATELJ = /^(\*|@[^\s@]+\.[^\s@]+|[^\s@]+@[^\s@]+\.[^\s@]+)$/

// ─── Pravila ─────────────────────────────────────────────────────────────────

const NASTAVCI: [VrstaMailPrivitka, RegExp][] = [
  ['pdf', /^pdf$/],
  ['slika', /^(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|svg)$/],
  ['dokument', /^(docx?|odt|rtf|pages)$/],
  ['tablica', /^(xlsx?|xlsm|ods|csv|numbers)$/],
  ['prezentacija', /^(pptx?|odp|key)$/],
  ['tekst', /^(txt|md|json|xml|ya?ml|html?|ics|vcf|log)$/],
  ['arhiva', /^(zip|7z|rar|tar|gz|tgz|bz2|xz)$/],
  ['zvuk', /^(mp3|wav|ogg|oga|opus|m4a|flac|aac)$/],
  ['video', /^(mp4|mov|mkv|webm|avi|m4v)$/],
]

/** Vrsta prema nastavku imena, a bez poznatog nastavka prema MIME-u. */
export function vrstaDijela(ime: string, mime: string): VrstaMailPrivitka {
  const nastavak = (String(ime || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/) || [])[1] || ''
  for (const [v, re] of NASTAVCI) if (re.test(nastavak)) return v
  const m = String(mime || '').toLowerCase()
  if (m === 'application/pdf') return 'pdf'
  if (m.startsWith('image/')) return 'slika'
  if (m.startsWith('audio/')) return 'zvuk'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('text/')) return 'tekst'
  if (/zip|compressed|x-tar|gzip/.test(m)) return 'arhiva'
  if (/spreadsheet|excel/.test(m)) return 'tablica'
  if (/presentation|powerpoint/.test(m)) return 'prezentacija'
  if (/wordprocessing|msword|opendocument\.text/.test(m)) return 'dokument'
  return 'ostalo'
}

/** Je li pošiljatelj na popisu? Usporedba bez obzira na velika/mala slova. */
export function dopustenPosiljatelj(adresa: string, popis: readonly string[]): boolean {
  const a = String(adresa || '').trim().toLowerCase()
  if (!a.includes('@')) return false
  const domena = a.slice(a.lastIndexOf('@'))
  return popis.some(x => {
    const p = String(x || '').trim().toLowerCase()
    return p === '*' || p === a || (p.startsWith('@') && p === domena)
  })
}

/** `<mapa ili $TM_HOME/privitci/posta>/<uid>`. */
export function mapaMaila(p: Pick<PostaPrivitci, 'mapa'>, uid: number, tmRoot: string = TM_ROOT): string {
  const korijen = p.mapa?.trim() || join(tmRoot, 'privitci', 'posta')
  return join(korijen, String(Math.trunc(Number(uid)) || 0))
}

/** Korijen mape privitaka pošte (bez `<uid>`) — za upute modelu i mape SEND_DOC-a. */
export function korijenPostePrivitaka(p: Pick<PostaPrivitci, 'mapa'>, tmRoot: string = TM_ROOT): string {
  return p.mapa?.trim() || join(tmRoot, 'privitci', 'posta')
}

/** Ime datoteke na disku: samo osnovno, sanitizirano (isto pravilo kao Telegram). */
export const imeDatotekeMaila = (izvorno: string | undefined) => cistoIme(izvorno)

// ─── Dijelovi i spremanje ────────────────────────────────────────────────────

/** Jedan privitak iz strukture poruke (`bodyStructure`). */
export interface DioMaila {
  /** Oznaka dijela za `BODY.PEEK[<dio>]`, npr. `2` ili `1.2`. */
  dio: string
  ime: string
  /** Veličina dijela u poruci (kodirana, npr. base64). */
  velicina: number
  mime: string
  kodiranje?: string
}

/** Ishod za jedan privitak — ide u `posta.json` uz ime. */
export interface DatotekaMaila { ime: string; putanja?: string; greska?: string }

/** Procjena stvarnih bajtova iz veličine u strukturi (base64 nosi 4 znaka na 3 bajta). */
export function procjenaBajta(d: Pick<DioMaila, 'velicina' | 'kodiranje'>): number {
  const n = Math.max(0, Number(d.velicina) || 0)
  return String(d.kodiranje || '').toLowerCase() === 'base64' ? Math.floor(n * 3 / 4) : n
}

/** `ime.pdf` → `ime-2.pdf` kad je ime u ovom mailu već zauzeto. */
function slobodnoIme(ime: string, zauzeto: Set<string>): string {
  if (!zauzeto.has(ime)) return ime
  const t = ime.lastIndexOf('.')
  const [osnova, nastavak] = t > 0 ? [ime.slice(0, t), ime.slice(t)] : [ime, '']
  for (let i = 2; ; i++) {
    const k = `${osnova}-${i}${nastavak}`
    if (!zauzeto.has(k)) return k
  }
}

export interface SpremiOpcije {
  tmRoot?: string
  /**
   * Ručni dohvat (CLI, izričit nalog čovjeka): ne gleda `ukljucen` ni popis pošiljatelja.
   * Ime, mapa, strop, vrste i 0600 vrijede i tada.
   */
  rucno?: boolean
}

/**
 * Preuzmi i spremi privitke jednog maila. `preuzmi(dio, maxBajta)` čita JEDAN dio
 * (`BODY.PEEK[<dio>]`, dekodiran). Greška jednog dijela ne ruši ostale. Vraća `[]` kad je
 * opcija isključena ili mail nema privitaka.
 */
export async function spremiPrivitkeMaila(
  m: { uid: number; odAdresa: string; dijelovi?: DioMaila[] },
  p: PostaPrivitci,
  preuzmi: (dio: string, maxBajta: number) => Promise<Preuzeto>,
  o: SpremiOpcije = {},
): Promise<DatotekaMaila[]> {
  const dijelovi = m.dijelovi || []
  if (!dijelovi.length || (!p.ukljucen && !o.rucno)) return []
  if (!o.rucno && !dopustenPosiljatelj(m.odAdresa, p.posiljatelji)) {
    const razlog = `pošiljatelj ${m.odAdresa || '(nepoznat)'} nije na popisu imap.privitci.posiljatelji`
    return dijelovi.map(d => ({ ime: d.ime, greska: razlog }))
  }
  const maxBajta = Math.round(p.maxMB * 1024 * 1024)
  const mapa = mapaMaila(p, m.uid, o.tmRoot)
  const zauzeto = new Set<string>()
  const out: DatotekaMaila[] = []
  for (const [i, d] of dijelovi.entries()) {
    if (i >= GRANICE_POSTA_PRIVITAKA.najviseDatoteka) {
      out.push({ ime: d.ime, greska: `više od ${GRANICE_POSTA_PRIVITAKA.najviseDatoteka} privitaka u jednom mailu` })
      continue
    }
    const vrsta = vrstaDijela(d.ime, d.mime)
    if (!p.vrste.includes(vrsta)) { out.push({ ime: d.ime, greska: `vrsta ${vrsta} nije dopuštena (imap.privitci.vrste)` }); continue }
    if (procjenaBajta(d) > maxBajta) { out.push({ ime: d.ime, greska: `veći od ${p.maxMB} MB` }); continue }
    try {
      const r = await preuzmi(d.dio, maxBajta)
      if (!r.ok) { out.push({ ime: d.ime, greska: String(r.greska || 'preuzimanje nije uspjelo').slice(0, 200) }); continue }
      if (r.bajtovi.byteLength > maxBajta) { out.push({ ime: d.ime, greska: `veći od ${p.maxMB} MB` }); continue }
      const ime = slobodnoIme(imeDatotekeMaila(d.ime), zauzeto)
      zauzeto.add(ime)
      const z = zapisiPrivitak(mapa, ime, r.bajtovi)
      out.push(z.ok ? { ime: d.ime, putanja: z.putanja } : { ime: d.ime, greska: z.razlog })
    } catch (e: any) {
      out.push({ ime: d.ime, greska: String(e?.message || e).replace(/\s+/g, ' ').slice(0, 200) })
    }
  }
  return out
}

/** Redci za tekst obavijesti, ulaza i zadatka — isti oblik kao Telegram privitak. */
export function oznakePrivitaka(datoteke: readonly DatotekaMaila[] | undefined): string[] {
  return (datoteke || []).map(d => d.putanja
    ? `[PRIVITAK: ${d.putanja}]`
    : `[PRIVITAK nije spremljen: ${String(d.ime).replace(/[\[\]\n]/g, '_')} — ${String(d.greska || 'nepoznat razlog').replace(/[\[\]\n]/g, '_')}]`)
}
