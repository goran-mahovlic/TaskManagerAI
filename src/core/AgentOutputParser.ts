/**
 * AgentOutputParser — JEDAN parser agentova izlaza i JEDAN prekidač prikaza po kanalu.
 *
 * Dizajn: TASK-4813 (arhitekt) + ispravci iz revizije TASK-4814 (inženjer).
 * Provedba: TASK-4815.
 *
 * ZAŠTO POSTOJI: format se prije ovoga izmišljao na devet mjesta sa šest različitih
 * konstanti reza (`substring(0, 2000|3900|500|200|4000)`), i nijedno nije gledalo
 * strukturu — rez je padao nasred zaglavlja. Ovdje je gramatika na jednom mjestu,
 * a kanali se razlikuju samo PRIKAZOM.
 *
 * ŠTO OVAJ MODUL NIJE: nije vratar i nema U/I. Čiste funkcije, bez baze, bez mreže.
 * **NIKAD ne baca** — ni na `null`, ni na ne-stringu, ni na 11 313 znakova.
 * Izmjereno na živom korpusu (1297 zapisa / 30 dana): 79,1 % zapisa NEMA nijedno
 * zaglavlje, pa je fail-soft GLAVNI put, a ne rub.
 *
 * Ponovno korišteno (ne preslikano — ADR-0004):
 *   · `CompletionGuard.parseDeclaredStatus` → redak `REGOC-STATUS:`
 *   · `StepSchema.parsirajIzlazKoraka`      → blok `REGOC-IZLAZ`
 *   · `MARKER_VOCAB` odavde troši `DispatchGuard` (rječnik, ne gotovi uzorci — §F revizije)
 */
import { parseDeclaredStatus } from './CompletionGuard'
import { parsirajIzlazKoraka } from './StepSchema'

// ─── Tipovi (ugovor §H revizije) ─────────────────────────────────────────────

export type Dialect = 'pai' | 'regoc' | 'mjesovit' | 'nijedan'
export type ParseLevel = 'L0' | 'L1' | 'L2' | 'L3'
export type Badge = 'DONE' | 'DONE_WITH_CONCERNS' | 'BLOCKED' | 'NEEDS_CONTEXT' | 'IN_PROGRESS' | 'UNKNOWN'
export type Field =
  | 'summary' | 'analysis' | 'actions' | 'results' | 'statusText'
  | 'capture' | 'next' | 'story' | 'rate' | 'spoken'

export interface AgentOutput {
  /** Uvijek pun, NIKAD rezan — izvor za „prikaži sirovo". Rez se događa tek u prikazu. */
  raw: string
  level: ParseLevel
  dialect: Dialect
  fields: Partial<Record<Field, string>>
  /** P3: prvi redak `statusText`, ≤80 zn — jedino što smije u bedž. */
  statusHead: string
  verification?: string
  stepOutput?: unknown
  declared?: { status: string; reason: string }
}

/**
 * Telegram propušta ~4096 znakova. JEDAN strop za sve kanale (§J.9 revizije);
 * `ReportBackTask` ga re-izvozi radi zatečenih uvoznika.
 */
export const MAX_MSG_LEN = 3900

/** Koliko sažetak smije zauzeti u jednom retku minimalnog kanala (§4 dizajna). */
export const SAZETAK_MAXLEN = 240

/** P3: bedž čita najviše toliko znakova prvog retka `📊 STATUS`. */
export const STATUS_HEAD_MAXLEN = 80

// ─── Rječnik markera (§F revizije) ───────────────────────────────────────────
/**
 * RJEČNIK, ne gotovi uzorci. Parser od njega gradi SIDRENE uzorke (pravilo P1:
 * zaglavlje mora biti na početku retka), a `DispatchGuard` NESIDRENE (njegov je
 * posao naći format bilo gdje u tekstu, i to je namjerno). Isti uzorak ne može
 * služiti obojici, pa se dijeli izvor podataka, a ne izraz.
 */
export interface MarkerEntry {
  /** Regex izvor emojija (`➡️?` jer agenti pišu i bez varijacijskog znaka). */
  emoji: string
  /** Regex izvor ključne riječi. */
  keyword: string
  field: Field
  dialect: 'pai' | 'regoc'
  /** Traži li SIDRENI uzorak dvotočku (`⭐ RATE` i `📖 STORY` je često nemaju). */
  dvotocka?: boolean
}

export const MARKER_VOCAB: MarkerEntry[] = [
  { emoji: '📋', keyword: 'SUMMARY', field: 'summary', dialect: 'pai' },
  { emoji: '🔍', keyword: 'ANALYSIS', field: 'analysis', dialect: 'pai' },
  { emoji: '⚡', keyword: 'ACTIONS', field: 'actions', dialect: 'pai' },
  { emoji: '✅', keyword: 'RESULTS', field: 'results', dialect: 'pai' },
  { emoji: '📊', keyword: 'STATUS', field: 'statusText', dialect: 'regoc' },
  { emoji: '📁', keyword: 'CAPTURE', field: 'capture', dialect: 'pai' },
  { emoji: '➡️?', keyword: 'NEXT', field: 'next', dialect: 'pai' },
  { emoji: '📖', keyword: 'STORY\\s*EXPLANATION', field: 'story', dialect: 'pai', dvotocka: false },
  { emoji: '⭐', keyword: 'RATE', field: 'rate', dialect: 'pai', dvotocka: false },
  { emoji: '📋', keyword: 'REZULTAT', field: 'summary', dialect: 'regoc' },
  { emoji: '➡️?', keyword: 'SLJEDE[ĆC]I\\s*KORAC\\w*', field: 'next', dialect: 'regoc' },
]

/** Ukrasi koje agenti stavljaju oko zaglavlja: citat, naslov, podebljano. */
const UKRAS = String.raw`[\s>*_#-]*`

/** SIDRENI uzorak (P1) — za parser. */
export function anchoredMarkerRe(m: MarkerEntry): RegExp {
  const rep = m.dvotocka === false ? `${UKRAS}[:：]?` : `${UKRAS}[:：]`
  return new RegExp(`^${UKRAS}${m.emoji}${UKRAS}${m.keyword}${rep}`, 'u')
}

/** NESIDRENI uzorak — za `DispatchGuard` (format bilo gdje u tekstu). */
export function freeMarkerRe(m: MarkerEntry): RegExp {
  return new RegExp(`${m.emoji}[\\s*_]*${m.keyword}`, 'u')
}

const ZAGLAVLJA = MARKER_VOCAB.map(m => ({ ...m, re: anchoredMarkerRe(m) }))

const SPOKEN_RE = new RegExp(`^${UKRAS}🗣️?${UKRAS}([^:：]{0,40})[:：]\\s*(.*)$`, 'u')
const VERIF_RE = /^={2,}\s*VERIFIKACIJA\s*={2,}\s*$/mu
const VERIF_KRAJ_RE = /^={2,}\s*KRAJ VERIFIKACIJE\s*={2,}\s*$/mu
const IZLAZ_MARKER_RE = /REGOC-IZLAZ/u

/**
 * P2 — GRANICA SEKCIJE. Tijelo NE smije teći do sljedećeg poznatog zaglavlja, jer
 * ga agenti u praksi nemaju. Izmjereno prije pravila: `TASK-4809.summary` = 3762 zn,
 * `TASK-4803.statusText` = 3417 zn — cijeli dokument pod jednim zaglavljem.
 */
const GRANICA_RE = /^(?:#{1,6}\s|={2,}\s*VERIFIKACIJA|REGOC-IZLAZ|```)/u

// ─── Parser ──────────────────────────────────────────────────────────────────

/** Fail-soft: nikad ne baca, uvijek vraća objekt s punim `raw`. */
export function parseAgentOutput(rawIn?: string | null): AgentOutput {
  const raw = typeof rawIn === 'string' ? rawIn : (rawIn == null ? '' : String(rawIn))
  const out: AgentOutput = { raw, level: 'L3', dialect: 'nijedan', fields: {}, statusHead: '' }
  if (!raw.trim()) return out

  try {
    const dijalekti = new Set<'pai' | 'regoc'>()
    let tekuce: Field | null = null
    let buf: string[] = []
    const spremi = () => {
      if (tekuce) {
        const v = buf.join('\n').trim()
        if (v && !out.fields[tekuce]) out.fields[tekuce] = v
      }
      buf = []
    }

    for (const l of raw.split(/\r?\n/)) {
      const pogodak = ZAGLAVLJA.find(z => z.re.test(l))
      if (pogodak) {
        spremi()
        tekuce = pogodak.field
        dijalekti.add(pogodak.dialect)
        // Ostatak retka je početak tijela; skidamo i ukrase koje je uzorak ostavio
        // ("**📊 STATUS:** Uspješno" → "Uspješno", ne "** Uspješno").
        buf = [l.replace(pogodak.re, '').replace(/^[\s:：*_]+/, '')]
        continue
      }
      const sp = SPOKEN_RE.exec(l)
      if (sp) {
        spremi()
        tekuce = null
        const izgovoreno = (sp[2] || '').trim()
        if (izgovoreno && !out.fields.spoken) out.fields.spoken = izgovoreno
        continue
      }
      if (tekuce && GRANICA_RE.test(l.trim())) { spremi(); tekuce = null; continue }
      if (tekuce) buf.push(l)
    }
    spremi()

    const d = parseDeclaredStatus(raw)
    if (d) out.declared = { status: d.status, reason: d.reason }

    const izlaz = parsirajIzlazKoraka(raw)
    if (izlaz.nadjen) out.stepOutput = izlaz.objekt ?? izlaz.sirovo ?? undefined

    const vi = raw.search(VERIF_RE)
    if (vi >= 0) {
      const ostatak = raw.slice(vi)
      const kraj = ostatak.search(VERIF_KRAJ_RE)
      out.verification = (kraj > 0 ? ostatak.slice(0, kraj) : ostatak).trim().slice(0, 4000)
    }

    // P3: u bedž smije samo PRVI redak statusa, i to skraćen.
    out.statusHead = prviRedak(out.fields.statusText || '', STATUS_HEAD_MAXLEN)

    out.dialect = dijalekti.size === 0 ? 'nijedan'
      : dijalekti.size > 1 ? 'mjesovit'
      : (dijalekti.values().next().value as Dialect)

    const brojPolja = Object.keys(out.fields).length
    const strojni = !!out.declared || out.stepOutput !== undefined || !!out.verification
    out.level = brojPolja >= 3 ? 'L0' : brojPolja >= 1 ? 'L1' : strojni ? 'L2' : 'L3'
  } catch {
    // Fail-soft: `raw` ostaje, prikaz uvijek ima što pokazati.
  }
  return out
}

function prviRedak(s: string, maxLen: number): string {
  const prvi = String(s || '').split(/\r?\n/).find(l => l.trim().length > 0) || ''
  const cist = plainText(prvi).replace(/\s+/g, ' ').trim()
  return cist.length <= maxLen ? cist : cist.slice(0, maxLen - 1).trimEnd() + '…'
}

// ─── Bedž: ploča je mjerodavna (§3 dizajna — najvažnije pravilo) ─────────────

/**
 * Rječnik normalizacije proze je PODATAK, ne kod (§3): agenti pišu „uspješno",
 * „uspješno.", „** uspješno.", pa i doslovno prepisan predložak iz prompta.
 */
const PROZA_OGRADE: RegExp[] = [
  /djelomi[čc]n/iu,
  /uz ograde/iu,
  /with\s+concerns/iu,
  /\bpartial/iu,
  /neuspje[šs]n/iu,
  /nije\s+(?:sve|do\s*kraja|u\s*potpunosti)/iu,
]
/** „uspješno" DA, „neuspješno" NE — granica riječi je ovdje jedina razlika. */
const PROZA_USPJEH = /\buspje[šs]n/iu

export interface BadgeResult {
  badge: Badge
  /** Je li tekst SUZIO sud ploče (DONE → DONE_WITH_CONCERNS)? */
  sazio: boolean
  /** Tvrdi li tekst da je gotovo, a ploča kaže da nije? Prikazuje se, ne razrješava. */
  neslaganje: boolean
  /** Čime je sud obrazložen — ide u `title` bedža na ploči. */
  izvor: string
}

/**
 * Bedž se NE izvodi iz teksta. Ploča je mjerodavna; parsirani tekst ga smije samo
 * SUZITI (DONE → DONE_WITH_CONCERNS), nikad podići. Zeleni DONE na zadatku koji na
 * ploči nije `completed` je zabranjen — neslaganje se PRIKAZUJE (⚠️).
 */
export function badgeFor(
  boardStatus: string | null | undefined,
  parsed: AgentOutput,
  opts: { blockedReason?: string | null } = {},
): BadgeResult {
  const st = String(boardStatus || '').toLowerCase().trim()
  const razlog = String(opts.blockedReason || '')
  const dekl = parsed.declared?.status || ''
  const head = parsed.statusHead || ''

  const tvrdiDone = dekl.startsWith('DONE') || PROZA_USPJEH.test(head)
  const ograde = dekl === 'DONE_WITH_CONCERNS' || PROZA_OGRADE.some(re => re.test(head))

  if (st === 'completed') {
    if (ograde) {
      return {
        badge: 'DONE_WITH_CONCERNS', sazio: true, neslaganje: false,
        izvor: dekl === 'DONE_WITH_CONCERNS' ? 'REGOC-STATUS: DONE_WITH_CONCERNS' : `📊 STATUS: ${head}`,
      }
    }
    return { badge: 'DONE', sazio: false, neslaganje: false, izvor: 'ploča: completed' }
  }

  if (st === 'blocked') {
    const trebaKontekst = /NEEDS[-_ ]?CONTEXT/i.test(razlog) || dekl === 'NEEDS_CONTEXT'
    return {
      badge: trebaKontekst ? 'NEEDS_CONTEXT' : 'BLOCKED',
      sazio: false,
      neslaganje: tvrdiDone,
      izvor: razlog ? `blocked_reason: ${prviRedak(razlog, 80)}` : 'ploča: blocked',
    }
  }

  if (st === 'in_progress' || st === 'pending') {
    return { badge: 'IN_PROGRESS', sazio: false, neslaganje: tvrdiDone, izvor: `ploča: ${st}` }
  }

  return { badge: 'UNKNOWN', sazio: false, neslaganje: tvrdiDone, izvor: `ploča: ${st || '(nepoznato)'}` }
}

/** Emoji bedža — isti za ploču i za Telegram, jer je sud isti. */
export const BADGE_EMOJI: Record<Badge, string> = {
  DONE: '🟢',
  DONE_WITH_CONCERNS: '🟡',
  BLOCKED: '🔴',
  NEEDS_CONTEXT: '🟠',
  IN_PROGRESS: '⚪',
  UNKNOWN: '⚪',
}

// ─── Rod izvođača ─────────────────────────────────────────────────────────────

/**
 * Tko je u ženskom rodu — iz registra agenata (`config/agents.json`, polje `"rod": "ž"`),
 * NE iz popisa u kodu: imena tima su konfiguracija instalacije (ADR-0001, TASK-4808).
 * Čita se lijeno i jednom; nečitljiv registar = muški rod za sve (poruka ostaje točna
 * po sadržaju, samo gramatički neutralnija).
 */
let _agentice: Set<string> | null = null
function agentice(): Set<string> {
  if (_agentice) return _agentice
  const skup = new Set<string>()
  try {
    const { readFileSync, existsSync } = require('fs') as typeof import('fs')
    const { konfigPutanja } = require('./paths') as typeof import('./paths')
    const p = konfigPutanja('agents.json', 'TM_AGENTS_CONFIG')
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      for (const a of Array.isArray(raw?.agents) ? raw.agents : []) {
        const rod = String(a?.rod || '').toLowerCase()
        if (a?.id && (rod === 'ž' || rod === 'z' || rod === 'f')) skup.add(String(a.id).toLowerCase())
      }
    }
  } catch { /* registar nije obavezan */ }
  _agentice = skup
  return skup
}

/** Samo za testove: zadaj skup ženskog roda ili ga vrati na čitanje registra (`null`). */
export function postaviZenskiRod(ids: string[] | null): void {
  _agentice = ids ? new Set(ids.map((x) => x.toLowerCase())) : null
}

/**
 * „završila" / „završio". Poruka o ženskoj agentici u muškom rodu je jednako kriva
 * kao krivi status; pravilo živi ovdje jer je ovo jedino mjesto koje sastavlja
 * tekst za korisnika.
 */
export function zavrsioZavrsila(agentId?: string | null): string {
  return agentice().has(String(agentId || '').toLowerCase().trim()) ? 'završila' : 'završio'
}

// ─── Čisti tekst (§E revizije) ───────────────────────────────────────────────

/**
 * Telegram se šalje BEZ `parse_mode` (`grep -rn "parse_mode" → 0 pogodaka`), pa
 * markdown stiže korisniku doslovno: izmjereno 4735 parova `**` i 100 tablica u
 * 518 poruka u 30 dana. Ovo briše ZAPIS, a čuva SADRŽAJ.
 */
export function plainText(sIn?: string | null): string {
  let s = typeof sIn === 'string' ? sIn : (sIn == null ? '' : String(sIn))
  if (!s) return ''
  try {
    const linije = s.split(/\r?\n/).filter(l => !/^\s*```/.test(l))
    s = linije.map(l => {
      if (/^\s*\|.*\|\s*$/.test(l)) {
        // Redak-razdjelnik tablice nosi nula sadržaja; ostali postaju „a · b · c".
        if (/^[\s|:\-]+$/.test(l)) return ''
        const celije = l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()).filter(Boolean)
        return celije.join(' · ')
      }
      return l
    }).filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')

    s = s
      .replace(/^\s*#{1,6}\s*/gmu, '')                              // markdown naslovi
      .replace(/!?\[([^\]\n]*)\]\(([^)\s]+)[^)]*\)/gu, (_m, t, u) => (t ? `${t} (${u})` : String(u)))
      .replace(/\*\*/gu, '')
      .replace(/__/gu, '')
      .replace(/`+/gu, '')
      .replace(/^\s*[-*+]\s+/gmu, '• ')                             // natuknice
      .replace(/^\s*>\s?/gmu, '')                                   // citat
      .replace(/\n{3,}/gu, '\n\n')
    return s.trim()
  } catch {
    return String(sIn ?? '')
  }
}

// ─── Sažetak: ljestvica koja nikad ne vraća prazno (§5 dizajna) ──────────────

/** Prvi neprazan: summary → results → spoken → obrazloženje REGOC-STATUS → sirovo. */
export function summarySource(p: AgentOutput): string {
  return (
    p.fields.summary ||
    p.fields.results ||
    p.fields.spoken ||
    (p.declared?.reason || '') ||
    p.raw ||
    ''
  )
}

/** Jedan redak, čisti tekst, rez na granici rečenice. NIKAD prazno. */
export function summaryLine(p: AgentOutput, maxLen = SAZETAK_MAXLEN): string {
  const izvor = summarySource(p)
  const prviOdlomak = String(izvor).split(/\n\s*\n/)[0] || String(izvor)
  const jedanRedak = plainText(prviOdlomak).replace(/\s+/g, ' ').trim()
  if (!jedanRedak) return '(prazan rezultat)'
  return rezNaGranici(jedanRedak, maxLen)
}

/**
 * Rez koji ne pada nasred formata (T3 ugovora): prvo na kraj rečenice, pa na
 * granicu riječi, i tek onda tvrdo. Uvijek označen s „…" da se vidi da ima još.
 */
export function rezNaGranici(sIn: string, maxLen: number): string {
  const s = String(sIn ?? '')
  if (maxLen <= 1) return s.slice(0, Math.max(0, maxLen))
  if (s.length <= maxLen) return s
  const prozor = s.slice(0, maxLen - 1)
  const recenica = Math.max(
    prozor.lastIndexOf('. '), prozor.lastIndexOf('! '), prozor.lastIndexOf('? '),
    prozor.lastIndexOf('.\n'), prozor.lastIndexOf('\n\n'),
  )
  if (recenica > maxLen * 0.4) return prozor.slice(0, recenica + 1).trimEnd()
  const rijec = prozor.lastIndexOf(' ')
  const osnova = rijec > maxLen * 0.5 ? prozor.slice(0, rijec) : prozor
  return osnova.trimEnd() + '…'
}

// ─── Prekidač prikaza ────────────────────────────────────────────────────────

export interface MinimalOpts {
  /** Ukupan strop poruke. Jedan za sve kanale. */
  maxLen?: number
  /** Gotov, već ispravan prvi redak (npr. „✅ Arhitektica završila zadatak TASK-1"). */
  heading?: string
  /** Poveznica na ploču — zamjena za sve što minimalni kanal izostavlja. */
  boardUrl?: string | null
  /** Strop tijela; bez njega tijelo dobiva sav preostali prostor do `maxLen`. */
  bodyMax?: number
}

/**
 * `minimal` — Telegram. ČISTI TEKST (§E revizije), bez markdowna.
 * Sadrži: glavu (ako je zadana), sažetak, 🗣️ redak, trag verifikacije i poveznicu
 * na ploču. Analiza, koraci, tablica dokaza i sirovi tekst ostaju na ploči.
 */
export function renderMinimal(p: AgentOutput, opts: MinimalOpts = {}): string {
  // Strop je ono što je pozivatelj tražio. Raniji `Math.max(80, …)` tiho je dizao
  // mali strop i poruka od 75 zn nije bila rezana na 60 — mjerilo je to uhvatilo.
  const maxLen = Math.max(1, opts.maxLen ?? MAX_MSG_LEN)
  const glava = opts.heading ? plainText(opts.heading).replace(/\s+/g, ' ').trim() : ''
  const rep = opts.boardUrl ? `Ploča: ${opts.boardUrl}` : ''

  const spoken = p.fields.spoken ? `🗣️ ${plainText(p.fields.spoken).replace(/\s+/g, ' ').trim()}` : ''
  // Verifikacija se na minimalnom kanalu ne prepisuje, ali se njezino POSTOJANJE ne
  // smije izgubiti — izmjereno 80 od 518 poruka nosi taj blok. Uzima se prvi redak
  // koji NOSI SADRŽAJ: ograda ``` i redak `=== VERIFIKACIJA ===` nisu sadržaj, a bez
  // ovoga je na Telegram odlazio goli znak „✓" bez ijedne riječi iza njega.
  const verifTijelo = p.verification
    ? plainText(p.verification.replace(/^={2,}.*$/gmu, '')).split(/\r?\n/).map(l => l.trim()).find(Boolean) || ''
    : ''
  const verif = verifTijelo ? `✓ ${rezNaGranici(verifTijelo, 120)}` : ''

  const fiksno = [glava, spoken, verif, rep].filter(Boolean).join('\n\n').length
  const prostorTijela = Math.max(40, maxLen - fiksno - 8)
  const bodyMax = Math.min(prostorTijela, opts.bodyMax ?? prostorTijela)

  const izvor = summarySource(p)
  let tijelo = plainText(izvor).trim()
  if (!tijelo) tijelo = '(prazan rezultat)'
  tijelo = rezNaGranici(tijelo, bodyMax)

  const poruka = [glava, tijelo, spoken, verif, rep].filter(Boolean).join('\n\n')
  return poruka.length <= maxLen ? poruka : rezNaGranici(poruka, maxLen)
}

/** `voice` — VoiceServer. Najviše 16 riječi, bez formata. */
export function renderVoice(p: AgentOutput, maxWords = 16): string {
  const izvor = p.fields.spoken || summaryLine(p, 400)
  const rijeci = plainText(izvor).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (rijeci.length === 0) return ''
  return rijeci.length <= maxWords ? rijeci.join(' ') : rijeci.slice(0, maxWords).join(' ') + '…'
}

/**
 * `full` — TaskManager. Poslužitelj šalje GOTOVU strukturu, klijent je samo CRTA;
 * klijent NE parsira (inače nastaje druga gramatika u pregledniku).
 */
export interface ParsedForBoard {
  level: ParseLevel
  dialect: Dialect
  badge: Badge
  badgeEmoji: string
  badgeSource: string
  narrowed: boolean
  mismatch: boolean
  summary: string
  fields: Partial<Record<Field, string>>
  verification?: string
  stepOutput?: unknown
  declared?: { status: string; reason: string }
}

export function renderFull(
  p: AgentOutput,
  boardStatus: string | null | undefined,
  opts: { blockedReason?: string | null } = {},
): ParsedForBoard {
  const b = badgeFor(boardStatus, p, opts)
  return {
    level: p.level,
    dialect: p.dialect,
    badge: b.badge,
    badgeEmoji: BADGE_EMOJI[b.badge],
    badgeSource: b.izvor,
    narrowed: b.sazio,
    mismatch: b.neslaganje,
    summary: summaryLine(p, SAZETAK_MAXLEN),
    fields: p.fields,
    verification: p.verification,
    stepOutput: p.stepOutput,
    declared: p.declared,
  }
}

// ─── Rod u GOVORENOM tekstu (dorada TASK-4817) ───────────────────────────────

/**
 * „mogla" / „mogao". Parnjak `zavrsioZavrsila` — postoji jer glasovni kanal
 * sastavlja i NIJEČNU rečenicu („nije mogao izvršiti zadatak"), koju je
 * TASK-4815 ostavio u muškom rodu dok je potvrdnu popravio. Rečenica o
 * agentici u muškom rodu najglasnija je upravo ondje gdje se izgovara.
 */
export function mogaoMogla(agentId?: string | null): string {
  return agentice().has(String(agentId || '').toLowerCase().trim()) ? 'mogla' : 'mogao'
}

// ─── Prekidač prikaza — §4 dizajna TASK-4813 ─────────────────────────────────

export type RenderMode = 'full' | 'minimal' | 'voice'

/**
 * Tekst pripremljen za IZGOVARANJE. `plainText` čisti zapis za OKO (ostavlja
 * emoji, natuknice, URL-ove i putanje — na Telegramu su korisni); TTS ih čita
 * doslovno, pa „✅ vidi /srv/projekt/src/X.ts" postane nerazumljivo.
 * Ovdje se miču samo ZNAKOVI koji se ne izgovaraju, sadržaj ostaje.
 */
export function govorljiv(sIn?: string | null): string {
  try {
    return plainText(sIn)
      .replace(/https?:\/\/\S+/gu, '')                                   // poveznice
      .replace(/(?:^|\s)[~./][\w./\-]*\/[\w./\-]*/gu, ' ')               // putanje
      .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{2700}-\u{27BF}]/gu, '') // emoji/strelice
      .replace(/[*_`|#•]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
  } catch {
    return ''
  }
}

export interface RenderOpts extends MinimalOpts {
  mode: RenderMode
  /** `full`: status sa ZADATKA — ploča je mjerodavna za bedž (§3 dizajna). */
  boardStatus?: string | null
  blockedReason?: string | null
  /** `voice`: strop u riječima. */
  maxWords?: number
}

export type RenderResult =
  | { mode: 'full'; board: ParsedForBoard }
  | { mode: 'minimal'; text: string }
  | { mode: 'voice'; text: string }

/**
 * JEDAN prekidač kanala: „način je svojstvo KANALA, ne poziva" (§4 dizajna).
 *
 * Postoji da odluka „koji kanal dobiva koje polje" živi na JEDNOM mjestu. Prije
 * ove dorade svaki je pozivatelj zvao `renderMinimal` izravno i sam birao glavu,
 * strop i polja — točno onaj obrazac iz kojeg je i nastao ovaj zadatak (četiri
 * neovisne konvencije), i koji ADR-0004 zove „peta preslika pravila".
 *
 * `voice` NAMJERNO vraća prazno kad agent nema `🗣️` redak: dizajn (§4, stupac
 * `voice`) daje glasu SAMO `spoken`. Čitanje sirovog L3 teksta naglas — a to je
 * 79 % prometa — bilo bi gore od konzervirane rečenice koju pozivatelj već ima.
 * Prazan niz je time UGOVOR: „nemam što reći, zadrži svoju rečenicu".
 *
 * Nikad ne baca (fail-soft je glavni put, §5): nepoznat način pada na `minimal`.
 */
export function renderAgentOutput(p: AgentOutput, opts: RenderOpts): RenderResult {
  try {
    if (opts?.mode === 'full') {
      return { mode: 'full', board: renderFull(p, opts.boardStatus, { blockedReason: opts.blockedReason }) }
    }
    if (opts?.mode === 'voice') {
      const spoken = p?.fields?.spoken
      if (!spoken) return { mode: 'voice', text: '' }
      const rijeci = govorljiv(spoken).split(' ').filter(Boolean)
      const max = Math.max(1, opts.maxWords ?? 16)
      return {
        mode: 'voice',
        text: rijeci.length <= max ? rijeci.join(' ') : rijeci.slice(0, max).join(' ') + '…',
      }
    }
    return { mode: 'minimal', text: renderMinimal(p, opts || {}) }
  } catch {
    // Glas i poruka su NUSPOJAVA posla — nikad ne smiju srušiti pozivatelja.
    try { return { mode: 'minimal', text: renderMinimal(p, opts || {}) } } catch { return { mode: 'minimal', text: '' } }
  }
}
