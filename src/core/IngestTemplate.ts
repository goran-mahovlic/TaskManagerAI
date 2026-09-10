/**
 * IngestTemplate — predložak koraka i opisa prvog zadatka, iz mape `templates/` (U6).
 *
 * ZAŠTO IZ DATOTEKE, A NE IZ KODA. Popis koraka je nastao u U4 kao TypeScript konstanta
 * (`WorkflowTemplate.WORKFLOW_STEPS`) i ondje je imenovao REGOČ-ev tim i njegov kanal
 * dojave. Paket ne smije poznavati ni jedno ni drugo: instalacija koja ga preuzme ima
 * svoje izvršitelje i svoj kanal. Zato su koraci sada PODATCI (`templates/koraci.json`),
 * a skelet opisa je `templates/prvi-zadatak.md`.
 *
 * ŠTO OSTAJE U KODU — i namjerno: PRAVILO skaliranja po težini (koji je korak obvezan,
 * koji skraćen, koji se preskače) i git blok. To su odluke, ne tekst; da su i one u
 * datoteci, instalacija bi ih mogla „prepisati" u nešto što vratari više ne mogu provjeriti.
 * Skaliranje se UVOZI iz `WorkflowTemplate` (SSOT), ovdje se samo preslikava na učitane
 * korake po ključu — pravilo u dvije kopije prestaje biti isto pravilo (ADR-0004).
 *
 * Mapu predložaka mijenja `$TM_TEMPLATES`; zadano je `templates/` uz sam paket.
 *
 * Autorica: Jelena (Engineer), TASK-4266.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

import {
  opisGitIdentiteta, TEXT_ONLY_TAG, WORKFLOW_STEPS, branchName, gitBranchCommands,
  gitCommitCommand, grillLevel, scaleSteps,
  type Obveznost, type WorkflowStep,
} from './WorkflowTemplate'
import { RESEARCH_STEP_OUTPUT_SPEC } from './ResearchRagGate'

const PAKET_DIR = join(import.meta.dir, '..', '..')

/** Mapa s predlošcima. `$TM_TEMPLATES` je za instalaciju koja ih drži izvan paketa. */
export const PREDLOSCI_DIR: string = process.env.TM_TEMPLATES || join(PAKET_DIR, 'templates')

export const DATOTEKA_KORACI = 'koraci.json'
export const DATOTEKA_OPIS = 'prvi-zadatak.md'

// ─── Koraci ──────────────────────────────────────────────────────────────────

function jeKorak(x: unknown): x is WorkflowStep {
  const s = x as Record<string, unknown>
  return !!s && typeof s === 'object'
    && Number.isInteger(s.n) && typeof s.key === 'string' && s.key.length > 0
    && typeof s.title === 'string' && typeof s.what === 'string'
    && typeof s.executor === 'string' && typeof s.tool === 'string'
    && typeof s.artifact === 'string' && typeof s.proof === 'string'
}

/**
 * Učitaj korake iz `templates/koraci.json`.
 *
 * Nedostajuća ili pokvarena datoteka NE ruši ulaz — vraća se ugrađeni popis. Ulaz stoji
 * na vrućem putu svake dolazne poruke; predložak koji može zaustaviti prijem gori je od
 * predloška koji je zastario.
 */
export function ucitajKorake(dir: string = PREDLOSCI_DIR): readonly WorkflowStep[] {
  try {
    const sirovo = JSON.parse(readFileSync(join(dir, DATOTEKA_KORACI), 'utf-8'))
    const popis = Array.isArray(sirovo) ? sirovo : sirovo?.koraci
    if (!Array.isArray(popis) || !popis.length || !popis.every(jeKorak)) return WORKFLOW_STEPS
    return popis as WorkflowStep[]
  } catch {
    return WORKFLOW_STEPS
  }
}

const OBVEZNOST_OZNAKA: Record<Obveznost, string> = {
  obvezno: '[obvezno]',
  skraceno: '[skraćeno]',
  neobvezno: '[neobvezno]',
  preskace: '[preskače se]',
}

/** Obveznost po ključu koraka — pravilo dolazi iz `WorkflowTemplate.scaleSteps`. */
function obveznostPoKljucu(weight: number, pragB: number): Map<string, { o: Obveznost; n?: string }> {
  const m = new Map<string, { o: Obveznost; n?: string }>()
  for (const s of scaleSteps({ weight, pragB })) m.set(s.key, { o: s.obveznost, n: s.napomena })
  return m
}

// ─── Opis prvog zadatka ──────────────────────────────────────────────────────

export interface OpisUlaz {
  /** Izvorna poruka korisnika, doslovno. */
  message: string
  /** Težina 1–100. */
  weight: number
  /** Kanal s kojega je poruka stigla: `email`, `telegram`, `konzola`… */
  source?: string | null
  /** Oznaka razgovora/pretinca unutar kanala (opaque za paket). */
  externalId?: string | number | null
  /** Adresa na koju ide dojava (korak 9). */
  replyTo?: string | null
  senderName?: string | null
  projectId?: string | null
  taskId?: string | null
  /** ID zadatka dojave, ako je već otvoren. */
  reportBackId?: string | null
  pragB?: number
  /** Zadatak koji po prirodi ne ostavlja commit (korak 4). */
  textOnly?: boolean
  receivedAt?: string
  /** Predlošci iz druge mape (testovi, druga instalacija). */
  templatesDir?: string
}

/** Naslov zadatka iz poruke — prva rečenica, skraćena na `max` znakova. */
export function naslovIzPoruke(message: string, max = 120): string {
  const t = String(message || '').replace(/\s+/g, ' ').trim()
  if (!t) return 'Zahtjev bez teksta'
  const prva = t.split(/(?<=[.!?])\s/)[0] || t
  return prva.length <= max ? prva : prva.slice(0, max - 1).trimEnd() + '…'
}

function blokKoraka(ulaz: OpisUlaz): string {
  const w = Number.isFinite(ulaz.weight) ? Number(ulaz.weight) : 0
  const pragB = ulaz.pragB ?? 36
  const skala = obveznostPoKljucu(w, pragB)
  return ucitajKorake(ulaz.templatesDir).map(s => {
    const sk = skala.get(s.key) ?? { o: 'obvezno' as Obveznost }
    const glava = `${s.n}. ${s.title.toUpperCase()} ${OBVEZNOST_OZNAKA[sk.o]} — ${s.what}`
    return [
      glava,
      `   izvršitelj: ${s.executor} · alat: ${s.tool}`,
      `   izlaz: ${s.artifact}`,
      `   dokaz: ${s.proof}`,
      sk.n ? `   napomena: ${sk.n}` : null,
    ].filter(Boolean).join('\n')
  }).join('\n')
}

function blokGita(ulaz: OpisUlaz): string {
  const taskId = (ulaz.taskId || 'TASK-####').toUpperCase()
  if (ulaz.textOnly) {
    return `Zadatak je označen kao „${TEXT_ONLY_TAG}" (korak 4) — commit se ne traži.\n`
      + 'Ako se tijekom rada ispostavi da ipak dira kod, makni oznaku i vrati se na korak 5.'
  }
  return [
    'GIT JE OBVEZAN — napredak mora biti durabilan.',
    `  grana:     ${branchName(taskId)}`,
    `  identitet: ${opisGitIdentiteta()}`,
    '  commit:    POSLIJE SVAKOG KORAKA, poruka počinje ID-em zadatka:',
    gitCommitCommand(taskId, 6).split('\n').map(r => '             ' + r.trim()).join('\n'),
    '',
    'Korak 5 (otvaranje grane):',
    gitBranchCommands(taskId).split('\n').map(r => '  ' + r.trim()).join('\n'),
    '',
    'Zadatak BEZ IJEDNOG COMMITA ne prolazi u completed (vratar GitCommitGate).',
    `Jedini izlaz: oznaka „${TEXT_ONLY_TAG}" na zadatku, dodijeljena u koraku 4.`,
  ].join('\n')
}

function blokDojave(ulaz: OpisUlaz): string {
  const adresa = ulaz.replyTo ? ` (adresa: ${ulaz.replyTo})` : ''
  return ulaz.reportBackId
    ? `Korisniku javlja ISKLJUČIVO zadatak dojave ${ulaz.reportBackId}${adresa} — jedna poruka za cijeli niz.\n`
      + 'Ti ne šalji ništa sam: niz zadataka mora dati JEDNU poruku, ne po jednu iz svakog zadatka.'
    : `Korisniku javlja ISKLJUČIVO zadatak dojave (tip report-back) na kraju niza${adresa} — ne šalji poruke sam.`
}

const ZADANI_SKELET = [
  '## Zahtjev korisnika (izvor: {{izvor}})',
  '{{poruka}}',
  '',
  '## Koraci — FIKSNI POPIS',
  'Težina: {{tezina}}/100 · grill: {{grill}} · prag B: {{pragB}}{{projekt}}',
  '',
  '{{koraci}}',
  '',
  '## Git',
  '{{git}}',
  '',
  '## Dojava',
  '{{dojava}}',
  '',
  '## Korak 2 — obvezan izlaz',
  '{{korak2}}',
].join('\n')

function ucitajSkelet(dir: string): string {
  try {
    const s = readFileSync(join(dir, DATOTEKA_OPIS), 'utf-8')
    return s.includes('{{koraci}}') ? s : ZADANI_SKELET
  } catch {
    return ZADANI_SKELET
  }
}

/**
 * Opis prvog zadatka: izvor, popis koraka, git obveza i tko javlja korisniku.
 * Čista funkcija osim čitanja predložaka — isti ulaz daje isti tekst.
 */
export function renderirajOpis(ulaz: OpisUlaz): string {
  const w = Number.isFinite(ulaz.weight) ? Number(ulaz.weight) : 0
  const izvor = [
    ulaz.source ? `kanal ${ulaz.source}` : null,
    ulaz.externalId != null && String(ulaz.externalId) ? `id ${ulaz.externalId}` : null,
    ulaz.senderName ? `pošiljatelj ${ulaz.senderName}` : null,
    `primljeno ${ulaz.receivedAt || new Date().toISOString()}`,
  ].filter(Boolean).join(' · ')

  const zamjene: Record<string, string> = {
    izvor,
    poruka: String(ulaz.message || '').trim() || '(poruka je bila prazna)',
    tezina: String(w),
    grill: grillLevel(w),
    pragB: String(ulaz.pragB ?? 36),
    projekt: ulaz.projectId ? ` · projekt: ${ulaz.projectId}` : '',
    koraci: blokKoraka(ulaz),
    git: blokGita(ulaz),
    dojava: blokDojave(ulaz),
    korak2: RESEARCH_STEP_OUTPUT_SPEC,
  }

  return ucitajSkelet(ulaz.templatesDir || PREDLOSCI_DIR)
    .replace(/\{\{(\w+)\}\}/g, (cijelo, kljuc: string) =>
      Object.prototype.hasOwnProperty.call(zamjene, kljuc) ? zamjene[kljuc]! : cijelo)
    .trimEnd() + '\n'
}
