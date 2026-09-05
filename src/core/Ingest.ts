/**
 * Ingest — generički ulaz `POST /api/ingest` (U6 / TASK-4266).
 *
 * Razrada: `docs/RAZRADA-3691_workflow_i_pragovi.md` §1 (položaji), §2 (pragovi), §4 (koraci).
 *
 * ŠTO JE OVDJE NOVO. U1–U5 su ulaz gradili oko Telegrama: `chatId`, `senderId`, ime grupe,
 * povratak u „istu grupu". Ovdje toga nema. Poruka je pet polja koja ne znaju za kanal:
 *
 *   source      — odakle je stigla: `email`, `telegram`, `konzola`, `sms`… (ključ postavki)
 *   externalId  — oznaka razgovora/pretinca unutar kanala; za paket je neproziran niz
 *   replyTo     — kamo ide odgovor; paket ga NE tumači i NE šalje, samo zapisuje uz zadatak
 *   text        — sam zahtjev
 *   senderName  — tko je poslao, za trag u opisu
 *
 * Telegram, e-pošta i konzola time postaju obični pozivatelji: most koji je dosad sam
 * ocjenjivao poruku sada radi jedan `curl` i dobiva natrag odluku.
 *
 * ŠTO OVAJ MODUL NAMJERNO NE RADI:
 *   • ne stvara zadatak — vraća PRIJEDLOG zadatka, a stvara ga `handleCreateTask`, jedini
 *     ingress ploče. Drugi stvaratelj značio bi granu koja zaobilazi vratare (anti-echo,
 *     prazan opis, strop stvaranja) i dvije istine o tome tko je zadatak otvorio;
 *   • ne zove nijedan model — ocjena je determinističa (`ModeClassifier` + `WeightScore`),
 *     jer stoji na vrućem putu svake dolazne poruke (pouka TASK-2559: model kao vratar
 *     krivo je skretao 92 % prometa);
 *   • ne šalje ništa natrag na `replyTo` — dojavu radi korak 9, kanalom koji je izvan paketa.
 *
 * Autorica: Jelena (Engineer), TASK-4266.
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

import { TM_DATA } from './paths'
import { getModeClassifier, type EffortTier } from './ModeClassifier'
import { countFiles, routeByWeight, scoreWeight, weightTag, type Postupak } from './WeightScore'
import { CHAIN_TAG, TEXT_ONLY_TAG, isTextOnly } from './WorkflowTemplate'
import { naslovIzPoruke, renderirajOpis } from './IngestTemplate'
import {
  loadIngestConfig, nacinZaIzvor, projektZaIzvor,
  type IngestPostavke, type Nacin,
} from './IngestConfig'

/** Inačica zapisa — izvještaj mora znati po kojim je pravilima redak nastao. */
export const INGEST_VERZIJA = 1

/** Dnevnik ulaza (jedan JSON po retku). Uz bazu, jer je to podatak instalacije. */
export const INGEST_LOG_PATH = process.env.TM_INGEST_LOG || join(TM_DATA, 'ingest.jsonl')

/** Koliko znakova poruke ide u zapis. */
export const ISJECAK_ZNAKOVA = 200

/** Gornja granica teksta. Iznad toga je datoteka, ne poruka — i ruši granicu opisa u shemi. */
export const MAX_TEKST = 20000

/** Naziv izvora ide u ključ postavki i u oznaku zadatka, pa je uzak namjerno. */
const RE_SOURCE = /^[a-z0-9][a-z0-9_.\-]{0,31}$/i

// ─── Zahtjev ─────────────────────────────────────────────────────────────────

export interface IngestZahtjev {
  source: string
  externalId?: string
  replyTo?: string
  text: string
  senderName?: string
  /** Izričit projekt — ima prednost pred postavkama izvora. */
  projectId?: string
  /** Izričit nositelj; provjerava ga tek `handleCreateTask` (popis `$TM_AGENTS`). */
  assignee?: string
  tags?: string[]
  /** Vrijeme prijema (ISO); zadano „sada". */
  receivedAt?: string
}

export interface ProvjeraZahtjeva {
  ok: boolean
  greske: string[]
  zahtjev?: IngestZahtjev
}

function niz(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

/**
 * Provjeri i očisti tijelo zahtjeva. Obavezni su samo `source` i `text` — sve ostalo je
 * pomoć pozivatelju, a ulaz koji traži pet polja prestaje biti generički.
 */
export function validirajZahtjev(tijelo: unknown): ProvjeraZahtjeva {
  const greske: string[] = []
  if (!tijelo || typeof tijelo !== 'object' || Array.isArray(tijelo)) {
    return { ok: false, greske: ['Očekivan je JSON objekt s poljima source, text (i po želji externalId, replyTo, senderName)'] }
  }
  const t = tijelo as Record<string, unknown>

  const source = String(t.source ?? '').trim()
  if (!source) greske.push('source je obavezan (npr. "telegram", "email", "konzola")')
  else if (!RE_SOURCE.test(source)) {
    greske.push('source smije imati samo slova, brojke, točku, crticu i podvlaku (do 32 znaka)')
  }

  const text = typeof t.text === 'string' ? t.text : ''
  if (!text.trim()) greske.push('text je obavezan i ne smije biti prazan')
  else if (text.length > MAX_TEKST) greske.push(`text je dulji od ${MAX_TEKST} znakova`)

  if (t.tags !== undefined && !Array.isArray(t.tags)) greske.push('tags mora biti polje nizova')

  if (greske.length) return { ok: false, greske }

  return {
    ok: true,
    greske: [],
    zahtjev: {
      source: source.toLowerCase(),
      externalId: niz(t.externalId, 200).trim() || undefined,
      replyTo: niz(t.replyTo, 500).trim() || undefined,
      text,
      senderName: niz(t.senderName, 120).trim() || undefined,
      projectId: niz(t.projectId, 40).trim() || undefined,
      assignee: niz(t.assignee, 64).trim() || undefined,
      tags: Array.isArray(t.tags) ? t.tags.map(x => String(x).trim()).filter(Boolean).slice(0, 20) : undefined,
      receivedAt: niz(t.receivedAt, 40).trim() || undefined,
    },
  }
}

// ─── Čišćenje teksta ─────────────────────────────────────────────────────────

const RE_BILJEG_OD = /\[OD:\s*[^\]]*\]\s*/g
const RE_PRETHODNI_KONTEKST = /\[PRETHODNI KONTEKST[\s\S]*?\]\s*/g

/**
 * Skini biljege koje dodaju pozivatelji (most, pretinac) prije nego što tekst ode u ocjenu.
 * Bez ovoga bi klasifikator mjerio TUĐI tekst — biljeg s prethodnim kontekstom zna biti
 * dulji od same poruke.
 */
export function ocistiTekst(tekst: string): string {
  return String(tekst || '')
    .replace(RE_PRETHODNI_KONTEKST, '')
    .replace(RE_BILJEG_OD, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ─── Druga polovica praga A: obično pitanje ─────────────────────────────────
//
// Razrada §2, prag A: „Ispod praga (pozdrav, PITANJE, „koliko je sati", razrada ideje)
// odgovor ide odmah i ploča ostaje čista." Razred E2 u klasifikatoru hvata SVE što nije
// kratko i nije pozdrav, pa je „Zašto se mora ići u terensku provjeru?" ispadalo iznad
// praga A — obično pitanje koje bi otvorilo zadatak.
//
// Uska vrata, tri uvjeta zajedno: (1) JEDNA rečenica koja završava upitnikom, (2) počinje
// pravom upitnom riječi (`možeš li` NIJE — to je uljudan imperativ), (3) nema glagola
// naloga, provjereno PO GRANICI RIJEČI (`\b…\w*`) da „provjeru" ne prođe kao „provjeri".

const UPITNE_RIJECI = /^(zašto|zasto|kako|koliko|kolika|koliki|kada|kad|gdje|tko|što|sto|šta|sta|čime|cime|čemu|cemu|otkud|odakle|kamo|koji|koja|koje|kojim|kojih|kojeg)\b/i

const GLAGOLI_NALOGA = new RegExp(
  '\\b(napravi|napiši|napisi|popravi|dodaj|pronađi|pronadji|obriši|obrisi|promijeni|promjeni|' +
  'provjeri|pokreni|zaustavi|pošalji|posalji|sredi|razradi|istraži|istrazi|implementiraj|' +
  'kreiraj|refaktoriraj|analiziraj|pripremi|dovrši|dovrsi|ispravi|prilagodi|osiguraj|izradi|' +
  'dostavi|prebaci|ukloni|zamijeni|testiraj|dokumentiraj)\\w*\\b', 'i')

export function jeObicnoPitanje(tekst: string): boolean {
  const s = String(tekst || '').trim()
  if (!s.endsWith('?')) return false
  if ((s.match(/[?!.;\n]/g) || []).length !== 1) return false
  if (/\s[-–—]\s/.test(s)) return false
  if (!UPITNE_RIJECI.test(s)) return false
  return !GLAGOLI_NALOGA.test(s)
}

// ─── Odluka ──────────────────────────────────────────────────────────────────

export type IngestAkcija = 'odbijeno' | 'preskoceno' | 'sjena' | 'odgovor' | 'zadatak'
export type IzvorProjekta = 'zahtjev' | 'izvor' | 'pretinac'

/** Razlozi — stalni nizovi, jer ulaze u dnevnik i u testove. */
export const RAZLOG = {
  ISKLJUCEN: 'izvor je u položaju off — zadatak se ne otvara',
  SJENA: 'izvor je u položaju shadow — ocjena se zapisuje, zadatak se ne otvara',
  ISPOD_PRAGA: 'ispod praga A — odgovor, ploča se ne dira',
  PITANJE: 'obično pitanje — odgovor, ploča se ne dira',
} as const

export interface IngestZapis {
  ts: string
  source: string
  externalId: string
  senderName: string
  /** Prvih 200 znakova očišćene poruke. */
  poruka: string
  duljina: number
  effort: EffortTier
  tezina: number
  tezinaRazlog: string
  projectId: string
  projectSource: IzvorProjekta
  nacin: Nacin
  akcija: IngestAkcija
  postupak: Postupak
  trebaPotvrdu: boolean
  razlog: string
  pragovi: { A: number; B: number; C: number }
  verzija: number
}

/** Prijedlog zadatka — tijelo za `POST /api/tasks`, ne zapis u bazi. */
export interface PrijedlogZadatka {
  title: string
  description: string
  projectId: string
  tags: string[]
  createdBy: string
  assignee?: string
}

export interface IngestOdluka {
  akcija: IngestAkcija
  nacin: Nacin
  postupak: Postupak
  effort: EffortTier
  tezina: number
  tezinaRazlog: string
  projectId: string
  projectSource: IzvorProjekta
  trebaPotvrdu: boolean
  razlog: string
  /** Postoji samo uz `akcija: 'zadatak'`. */
  zadatak?: PrijedlogZadatka
  zapis: IngestZapis
}

function odrediProjekt(z: IngestZahtjev, cfg: IngestPostavke): { projectId: string; projectSource: IzvorProjekta } {
  if (z.projectId) return { projectId: z.projectId, projectSource: 'zahtjev' }
  const izPostavki = projektZaIzvor(cfg, z.source, z.externalId)
  if (izPostavki) return { projectId: izPostavki, projectSource: 'izvor' }
  return { projectId: cfg.defaultProject, projectSource: 'pretinac' }
}

/**
 * Što ulaz radi s ovom porukom. Čista funkcija (osim vremenskog žiga): bez mreže, bez
 * modela, bez diska — ista poruka i iste postavke uvijek daju istu odluku.
 *
 * Redoslijed grana JE pravilo: prvo sve što NE otvara zadatak (isključeno, sjena, ispod
 * praga, obično pitanje), tek na kraju prijedlog zadatka.
 */
export function procijeniIngest(z: IngestZahtjev, cfg: IngestPostavke = loadIngestConfig()): IngestOdluka {
  const cisto = ocistiTekst(z.text)
  const razred = getModeClassifier().classifyMessage(cisto)
  const ocjena = scoreWeight({ effort: razred.effort, planSteps: 0, files: countFiles(cisto), retried: false })
  const put = routeByWeight({
    score: ocjena.score, pragA: cfg.pragA, pragB: cfg.pragB, pragC: cfg.pragC, planSteps: 0,
  })
  const nacin = nacinZaIzvor(cfg, z.source, z.externalId)
  const { projectId, projectSource } = odrediProjekt(z, cfg)

  let akcija: IngestAkcija
  let razlog: string
  if (nacin === 'off') { akcija = 'preskoceno'; razlog = RAZLOG.ISKLJUCEN }
  else if (nacin === 'shadow') { akcija = 'sjena'; razlog = RAZLOG.SJENA }
  else if (put.postupak === 'odgovor') { akcija = 'odgovor'; razlog = RAZLOG.ISPOD_PRAGA }
  else if (jeObicnoPitanje(cisto.slice(0, ISJECAK_ZNAKOVA))) { akcija = 'odgovor'; razlog = RAZLOG.PITANJE }
  else { akcija = 'zadatak'; razlog = put.reason }

  const zapis: IngestZapis = {
    ts: z.receivedAt || new Date().toISOString(),
    source: z.source,
    externalId: z.externalId || '',
    senderName: z.senderName || '',
    poruka: cisto.slice(0, ISJECAK_ZNAKOVA),
    duljina: cisto.length,
    effort: ocjena.effort,
    tezina: ocjena.score,
    tezinaRazlog: ocjena.reason,
    projectId,
    projectSource,
    nacin,
    akcija,
    postupak: put.postupak,
    trebaPotvrdu: put.trebaPotvrdu,
    razlog,
    pragovi: { A: cfg.pragA, B: cfg.pragB, C: cfg.pragC },
    verzija: INGEST_VERZIJA,
  }

  const odluka: IngestOdluka = {
    akcija, nacin,
    postupak: put.postupak,
    effort: ocjena.effort,
    tezina: ocjena.score,
    tezinaRazlog: ocjena.reason,
    projectId, projectSource,
    trebaPotvrdu: put.trebaPotvrdu,
    razlog,
    zapis,
  }
  if (akcija !== 'zadatak') return odluka

  const uLancu = put.postupak === 'lanac' || put.postupak === 'lanac-uz-potvrdu'
  const samoTekst = isTextOnly(z.tags)
  const oznake = [
    'ulaz',
    `izvor:${z.source}`,
    weightTag(ocjena.score),
    ...(uLancu ? [CHAIN_TAG] : []),
    ...(samoTekst ? [TEXT_ONLY_TAG] : []),
    ...(z.tags || []),
  ]
  odluka.zadatak = {
    title: naslovIzPoruke(cisto),
    description: renderirajOpis({
      message: z.text,
      weight: ocjena.score,
      source: z.source,
      externalId: z.externalId,
      replyTo: z.replyTo,
      senderName: z.senderName,
      projectId,
      pragB: cfg.pragB,
      textOnly: samoTekst,
      receivedAt: zapis.ts,
    }),
    projectId,
    tags: [...new Set(oznake)],
    createdBy: `ingest:${z.source}`,
    ...(z.assignee ? { assignee: z.assignee } : {}),
  }
  return odluka
}

// ─── Dnevnik ─────────────────────────────────────────────────────────────────

/**
 * Dopiši redak. Namjerno `appendFileSync` bez brave: jedan redak JSON-a je ispod
 * PIPE_BUF, a `O_APPEND` u jezgri jamči da se dva pisca ne izmiješaju usred retka.
 * Nikad ne baca — dnevnik ne smije srušiti prijem poruke.
 */
export function zapisiUlaz(zapis: IngestZapis, logPath: string = INGEST_LOG_PATH): void {
  try {
    const dir = dirname(logPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(logPath, JSON.stringify(zapis) + '\n', 'utf-8')
  } catch { /* dnevnik je trag, ne uvjet */ }
}
