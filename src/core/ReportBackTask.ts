import { MAX_MSG_LEN, parseAgentOutput, summaryLine } from './AgentOutputParser'
/**
 * ReportBackTask — ZADATAK DOJAVE: niz zadataka daje JEDNU poruku korisniku (U4 / TASK-4264).
 *
 * Razrada: `RAZRADA-3691_workflow_i_pragovi.md` (repozitorij sustava, nije u paketu) §4, korak 9.
 *
 * KVAR KOJI OVO ZATVARA. Dojava je dosad bila usputna: svaki agent koji je nešto završio slao
 * je svoju poruku (ili je nije slao nitko — v. `kosjenka-self-analysis-delivery-rot`, 13
 * izvještaja koji nikad nisu isporučeni). Za korisnika je razlika između tri poruke o jednom
 * poslu i jedne poruke o tri zadatka razlika između šuma i vijesti.
 *
 * ── ZAŠTO BILJEG U OPISU, A NE `blockedBy` ───────────────────────────────────────────────
 * `TaskManagerSQL.updateTask` pri zatvaranju roditelja BRIŠE `blocked_by` djeteta — i onda kad
 * ga ljudska oznaka zadrži u statusu `blocked` (linija „auto_unblock_held", TASK-3599). Da se
 * okidanje oslanja na `blockedBy`, zadnji zatvoreni zadatak niza ostavio bi dojavu s praznim
 * popisom i ona ne bi znala o čemu javlja. Zato niz živi u OPISU zadatka dojave, u biljegu
 * koji nijedna automatika ne dira:
 *
 *     [report-back chatId=-1001234567890 tasks=TASK-4270,TASK-4271,TASK-4272]
 *
 * Isti razlog zbog kojeg `parent:<ID>` stoji u oznakama (RegocDaemon, R2 helper).
 *
 * ── ZAŠTO OZNAKA `no-autonomy` ───────────────────────────────────────────────────────────
 * Zadatak dojave ne treba model: tekst poruke se SASTAVLJA iz rezultata zadataka niza. Bez te
 * oznake auto-unblock bi ga prebacio u `pending`, a `AutonomyQueue` bi na njega potrošila
 * Opus spawn da napiše ono što je već napisano. Oznaka drži i status `blocked` (ljudska
 * zadrška nadjačava auto-unblock), pa je zadatak dojave sve do slanja vidljiv kao „čeka niz".
 *
 * ── IDEMPOTENCIJA ────────────────────────────────────────────────────────────────────────
 * Prije slanja se provjerava dnevnik poslanih (`data/report_back_sent.jsonl`), a ne status
 * zadatka: slanje i zatvaranje su dva koraka i pad između njih ne smije proizvesti drugu
 * poruku. Dnevnik je jedini izvor istine o tome je li korisnik nešto DOBIO.
 *
 * Autorica: Kosjenka (Architect), TASK-4264.
 */

import { konfigPutanja } from './paths'

// ─── Rječnik ─────────────────────────────────────────────────────────────────

/** Oznaka koja zadatak čini zadatkom dojave. Doseg pometnje je isključivo ona. */
export const REPORT_BACK_TAG = 'report-back'

/** Oznaka koja sprječava spawn modela nad zadatkom dojave (v. zaglavlje). */
export const NO_AUTONOMY_TAG = 'no-autonomy'

/** Statusi koji zadatak niza smatraju zatvorenim. */
export const CLOSED_STATUSES = new Set(['completed', 'cancelled'])

export function isReportBackTask(tags?: string[] | null): boolean {
  if (!Array.isArray(tags)) return false
  return tags.some(t => String(t).trim().toLowerCase() === REPORT_BACK_TAG)
}

// ─── Biljeg niza ─────────────────────────────────────────────────────────────

export interface ReportBackMarker {
  chatId: number
  taskIds: string[]
}

export const MARKER_RE = /\[report-back\s+chatId=(-?\d{3,20})\s+tasks=([^\]]*)\]/i

export function formatReportBackMarker(m: ReportBackMarker): string {
  const ids = normalizeTaskIds(m.taskIds)
  return `[report-back chatId=${m.chatId} tasks=${ids.join(',')}]`
}

/** ID-evi bez ponavljanja, velikim slovima, u redoslijedu nalaza. */
export function normalizeTaskIds(ids?: readonly string[] | null): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of ids || []) {
    const id = String(raw || '').trim().toUpperCase()
    if (!/^TASK-\d+$/.test(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export function parseReportBackMarker(description?: string | null): ReportBackMarker | null {
  const m = MARKER_RE.exec(String(description || ''))
  if (!m) return null
  const chatId = Number(m[1])
  if (!Number.isFinite(chatId) || chatId === 0) return null
  return { chatId, taskIds: normalizeTaskIds(m[2].split(/[,\s]+/)) }
}

/** Čitljivi redak koji ponavlja sadržaj biljega — mora se mijenjati ZAJEDNO s njim. */
export const NIZ_LINE_RE = /^Niz \(\d+\):.*$/m

/**
 * Dopuni biljeg novim zadacima (razlaganje u koraku 3 otvara podzadatke POSLIJE dojave).
 * Vraća `null` ako opis nema biljeg — dopisivanje na krivo mjesto bilo bi gore od pogreške.
 *
 * Uz biljeg se osvježava i čitljivi redak „Niz (N): …". Biljeg je izvor istine, ali redak
 * koji mu proturječi je gori od nepostojećeg: čovjek na ploči čita prozu, ne zagrade.
 */
export function addTasksToMarker(description: string, dodatni: readonly string[]): string | null {
  const m = parseReportBackMarker(description)
  if (!m) return null
  const spojeni = normalizeTaskIds([...m.taskIds, ...dodatni])
  return String(description)
    .replace(MARKER_RE, formatReportBackMarker({ chatId: m.chatId, taskIds: spojeni }))
    .replace(NIZ_LINE_RE, `Niz (${spojeni.length}): ${spojeni.join(', ')}`)
}

// ─── Otvaranje zadatka dojave ────────────────────────────────────────────────

export interface ReportBackInput {
  chatId: number | string
  /** Zadaci niza — svi moraju biti zatvoreni prije nego dojava krene. */
  chainTaskIds: readonly string[]
  /** Naslov posla o kojem se javlja (naslov prvog zadatka). */
  subject: string
  projectId?: string | null
  /** Ime grupe, samo za čitljivost naslova. */
  groupName?: string | null
}

export interface ReportBackTaskBody {
  title: string
  description: string
  assignee: string
  priority: number
  status: string
  tags: string[]
  blockedBy: string[]
  blockedReason: string
  projectId?: string
}

/**
 * Tijelo za `POST /api/tasks`. `blockedBy` se i dalje šalje (ploča iz njega crta lanac i
 * `blocks` na roditeljima), ali okidanje se na njega NE oslanja — v. zaglavlje.
 */
export function buildReportBackTaskBody(input: ReportBackInput): ReportBackTaskBody {
  const ids = normalizeTaskIds(input.chainTaskIds)
  const chatId = Number(input.chatId)
  const subject = String(input.subject || '').replace(/\s+/g, ' ').trim() || 'zahtjev korisnika'
  const naslov = `📣 Dojava: ${subject}`.slice(0, 200)
  const marker = formatReportBackMarker({ chatId, taskIds: ids })
  const description = [
    `Zadatak dojave (tip report-back, U4/TASK-4264). Kad se SVI zadaci niza zatvore, korisniku`,
    `ide JEDNA poruka u izvornu grupu — ne jedna po zadatku.`,
    ``,
    marker,
    ``,
    `Niz (${ids.length}): ${ids.join(', ') || '(prazan)'}`,
    `Izvorna grupa: chatId ${chatId}${input.groupName ? ` (${input.groupName})` : ''}`,
    ``,
    `Poruku sastavlja i šalje pometnja \`ReportBackTask.runReportBackSweep\` — bez modela, iz`,
    `rezultata zadataka niza. Oznaka \`${NO_AUTONOMY_TAG}\` je namjerna: sprječava spawn agenta`,
    `nad zadatkom koji ne treba misliti. Ne zatvaraj ga ručno dok niz nije gotov.`,
  ].join('\n')
  const body: ReportBackTaskBody = {
    title: naslov,
    description,
    assignee: 'klaudio',
    priority: 2,
    status: 'blocked',
    tags: [REPORT_BACK_TAG, NO_AUTONOMY_TAG],
    blockedBy: [...ids],
    blockedReason: `Čeka zatvaranje niza (${ids.length} zadataka)`,
  }
  if (input.projectId) body.projectId = input.projectId
  return body
}

// ─── Sud: je li niz gotov ────────────────────────────────────────────────────

export interface ChainTaskView {
  id: string
  title?: string | null
  status?: string | null
  assignee?: string | null
  resultSummary?: string | null
  blockedReason?: string | null
}

export type ReportBackCode = 'ready' | 'waiting' | 'no_marker' | 'empty_chain' | 'missing_tasks'

export interface ReportBackVerdict {
  ready: boolean
  code: ReportBackCode
  done: string[]
  open: string[]
  /** ID-evi iz biljega kojih na ploči nema (obrisani zadatak ne smije zauvijek držati dojavu). */
  missing: string[]
  reason: string
}

/**
 * `missing` (zadatak iz biljega više ne postoji) NE zaustavlja dojavu: obrisan zadatak bi
 * inače zauvijek držao poruku, a šutnja je upravo kvar koji ovo liječi. Nestanak se navodi
 * u poruci, da razlika bude vidljiva korisniku, a ne samo u dnevniku.
 */
export function evaluateReportBack(
  marker: ReportBackMarker | null,
  lookup: (id: string) => ChainTaskView | null | undefined,
): ReportBackVerdict {
  if (!marker) {
    return { ready: false, code: 'no_marker', done: [], open: [], missing: [], reason: 'zadatak dojave nema biljeg [report-back …] u opisu' }
  }
  if (marker.taskIds.length === 0) {
    return { ready: false, code: 'empty_chain', done: [], open: [], missing: [], reason: 'biljeg ne navodi nijedan zadatak niza' }
  }
  const done: string[] = []
  const open: string[] = []
  const missing: string[] = []
  for (const id of marker.taskIds) {
    const t = lookup(id)
    if (!t) { missing.push(id); continue }
    if (CLOSED_STATUSES.has(String(t.status || '').trim().toLowerCase())) done.push(id)
    else open.push(id)
  }
  if (open.length > 0) {
    return {
      ready: false, code: 'waiting', done, open, missing,
      reason: `čeka ${open.length} od ${marker.taskIds.length}: ${open.join(', ')}`,
    }
  }
  return {
    ready: true,
    code: missing.length ? 'missing_tasks' : 'ready',
    done, open, missing,
    reason: missing.length
      ? `niz zatvoren (${done.length}), ali ${missing.length} zadataka više nema na ploči: ${missing.join(', ')}`
      : `svi zadaci niza zatvoreni (${done.length})`,
  }
}

// ─── Poruka ──────────────────────────────────────────────────────────────────

/**
 * Telegram propušta ~4096 znakova; ostatak se reže, ne šalje se druga poruka.
 * TASK-4815: vrijednost više ne živi ovdje — jedan strop za sve kanale stoji u
 * `AgentOutputParser`, a ovdje se samo re-izvozi radi zatečenih uvoznika.
 */
export { MAX_MSG_LEN }

/**
 * Adresa ploče kakvu korisnik otvara s VLASTITOG stroja — iz `TM_BOARD_URL`, bez zadane
 * vrijednosti.
 *
 * KVAR KOJI OVO ZATVARA (revizija TASK-4801, nalaz B3): ovdje je stajala tvrdo upisana
 * adresa našeg tailneta, pa je svaki korisnik paketa u svojoj dojavi dobivao poveznicu na
 * TUĐI stroj. Zadana vrijednost ovdje ne postoji ni kao `localhost`: poslužitelj ne zna na
 * kojem imenu i kojim vratima ga korisnik doista otvara (obrnuti posrednik, Docker,
 * preusmjerena vrata). Kad varijabla nije postavljena, redak „Ploča:" se izostavlja —
 * poruka bez poveznice je točna, poruka s tuđom poveznicom nije.
 */
export function boardUrl(): string | null {
  const v = String(process.env.TM_BOARD_URL || '').trim()
  return v || null
}

function sazetakRetka(t: ChainTaskView, maxLen: number): string {
  // TASK-4815: jedan redak po zadatku, iz ISTOG parsera kao ploča — prije je ovdje stajao
  // `replace(/\s+/g,' ')` + `slice(n)`, rez je padao nasred zaglavlja, a markdown je išao
  // korisniku doslovno.
  const izvor = String(t.resultSummary || t.blockedReason || '')
  if (!izvor.trim()) return ''
  if (maxLen <= 0) return ''
  return summaryLine(parseAgentOutput(izvor), maxLen)
}

export interface ReportBackMessageInput {
  subject: string
  tasks: ChainTaskView[]
  missing?: string[]
  projectId?: string | null
  /** ID zadatka dojave — da se poruka može povezati s pločom. */
  reportBackId?: string | null
  maxLen?: number
}

/**
 * Zadnji redak poruke. Bez `TM_BOARD_URL` nema poveznice, ali oznaka dojave ostaje —
 * po njoj se poruka i dalje može naći na ploči koju korisnik ionako zna otvoriti.
 */
function podnozjePloce(reportBackId?: string | null): string {
  const url = boardUrl()
  const dojava = reportBackId ? `dojava ${reportBackId}` : ''
  if (url) return `Ploča: ${url}${dojava ? ` (${dojava})` : ''}`
  return dojava ? `Dojava: ${reportBackId}` : ''
}

/**
 * JEDNA poruka za cijeli niz. Redoslijed je redoslijed biljega (redoslijed rada), a ne
 * abecedni: korisnik čita niz kako se dogodio.
 */
export function buildReportBackMessage(input: ReportBackMessageInput): string {
  const maxLen = input.maxLen ?? MAX_MSG_LEN
  const zavrseni = input.tasks.filter(t => String(t.status).toLowerCase() === 'completed')
  const otkazani = input.tasks.filter(t => String(t.status).toLowerCase() === 'cancelled')
  const glava = [
    `✅ Gotovo: ${String(input.subject || '').replace(/\s+/g, ' ').trim()}`,
    `Niz od ${input.tasks.length} ${input.tasks.length === 1 ? 'zadatka' : 'zadataka'}: ` +
      `${zavrseni.length} završeno${otkazani.length ? `, ${otkazani.length} otkazano` : ''}` +
      (input.projectId ? ` · projekt ${input.projectId}` : ''),
    '',
  ].join('\n')
  const rep = [
    '',
    (input.missing && input.missing.length)
      ? `⚠️ Zadataka više nema na ploči: ${input.missing.join(', ')}`
      : '',
    podnozjePloce(input.reportBackId),
  ].filter(Boolean).join('\n')

  // Prostor za tijelo je ono što ostane; po zadatku dijelimo ravnomjerno, ali nikad ispod
  // naslova — poruka bez naslova zadatka ne kaže ništa.
  const prostor = Math.max(200, maxLen - glava.length - rep.length)
  const poZadatku = Math.max(80, Math.floor(prostor / Math.max(1, input.tasks.length)))
  const stavke = input.tasks.map(t => {
    const status = String(t.status || '').toLowerCase() === 'cancelled' ? 'otkazano' : 'gotovo'
    const naslov = String(t.title || '').replace(/\s+/g, ' ').trim() || '(bez naslova)'
    const glavaStavke = `• ${t.id} ${naslov} — ${status}`
    const s = sazetakRetka(t, Math.max(0, poZadatku - glavaStavke.length - 4))
    return s ? `${glavaStavke}\n   ${s}` : glavaStavke
  }).join('\n')

  const cijela = `${glava}${stavke}${rep}`
  return cijela.length <= maxLen ? cijela : cijela.slice(0, maxLen - 1).trimEnd() + '…'
}

// ─── Konfiguracija (hot-reload, isti obrazac kao ResearchRagGate) ────────────

export interface ReportBackConfig {
  /** Pometnja uopće radi. */
  enabled: boolean
  /** true = poruka se STVARNO šalje; false = SHADOW (samo zapis „BIH POSLALA"). */
  live: boolean
  maxLen: number
}

export const DEFAULT_REPORT_BACK_CONFIG: ReportBackConfig = {
  enabled: true,
  live: true,   // doseg su isključivo zadaci s oznakom `report-back`, kojih bez ovog mehanizma nema
  maxLen: MAX_MSG_LEN,
}

const CONFIG_TTL_MS = 30_000
let _cfg: ReportBackConfig | null = null
let _loadedAt = 0
let _loadedFrom = ''

function configPath(): string {
  return (
    process.env.REGOC_REPORT_BACK_CONFIG ||
    konfigPutanja('report-back.json')
  )
}

export function loadReportBackConfig(force = false): ReportBackConfig {
  const p = configPath()
  const now = Date.now()
  if (!force && _cfg && p === _loadedFrom && now - _loadedAt < CONFIG_TTL_MS) return _cfg
  const cfg = { ...DEFAULT_REPORT_BACK_CONFIG }
  try {
    const { readFileSync, existsSync } = require('fs') as typeof import('fs')
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      if (typeof raw?.enabled === 'boolean') cfg.enabled = raw.enabled
      if (typeof raw?.live === 'boolean') cfg.live = raw.live
      if (Number.isInteger(raw?.maxLen) && raw.maxLen >= 200 && raw.maxLen <= 4096) cfg.maxLen = raw.maxLen
    }
  } catch { /* neispravan JSON → defaulti; dojava nikad ne ruši pozivatelja */ }
  _cfg = cfg
  _loadedAt = now
  _loadedFrom = p
  return cfg
}

// ─── Pometnja ────────────────────────────────────────────────────────────────

export interface ReportBackTaskView extends ChainTaskView {
  description?: string | null
  tags?: string[] | null
  projectId?: string | null
}

export interface SweepDeps {
  /** Zadaci dojave koji još nisu zatvoreni (status ≠ completed/cancelled). */
  listOpenReportBacks(): ReportBackTaskView[]
  getTask(id: string): ChainTaskView | null | undefined
  /** Vraća true SAMO ako je poruka stvarno isporučena. */
  send(chatId: number, text: string): boolean
  /** Zatvaranje zadatka dojave — poziva se TEK nakon uspješnog slanja. */
  close(id: string, resultSummary: string): void
  /** Dnevnik poslanih (idempotencija). */
  alreadySent(id: string): boolean
  markSent(id: string, chatId: number, text: string): void
  log?(msg: string): void
  cfg?: ReportBackConfig
}

export interface SweepOutcome {
  id: string
  code: ReportBackCode | 'sent' | 'shadow' | 'send_failed' | 'duplicate'
  reason: string
}

export interface SweepResult {
  fired: SweepOutcome[]
  held: SweepOutcome[]
}

/**
 * Prođi otvorene zadatke dojave i pošalji one kojima je niz gotov.
 *
 * Sve što dira svijet (ploča, Telegram, dnevnik) dolazi kroz `deps` — modul se testira bez
 * baze i bez mreže, a jedina razlika između probe i pogona je tko popuni ovisnosti.
 */
export function runReportBackSweep(deps: SweepDeps): SweepResult {
  const cfg = deps.cfg ?? loadReportBackConfig()
  const log = deps.log ?? (() => {})
  const fired: SweepOutcome[] = []
  const held: SweepOutcome[] = []
  if (!cfg.enabled) {
    log('report-back: pometnja isključena (config/report-back.json → enabled=false)')
    return { fired, held }
  }

  for (const rb of deps.listOpenReportBacks()) {
    if (!isReportBackTask(rb.tags)) continue
    const marker = parseReportBackMarker(rb.description)
    const v = evaluateReportBack(marker, id => deps.getTask(id))
    if (!v.ready) {
      held.push({ id: rb.id, code: v.code, reason: v.reason })
      continue
    }
    if (deps.alreadySent(rb.id)) {
      held.push({ id: rb.id, code: 'duplicate', reason: 'poruka je već poslana (dnevnik) — druga se ne šalje' })
      continue
    }
    const tasks = v.done
      .map(id => deps.getTask(id))
      .filter((t): t is ChainTaskView => !!t)
    const subject = String(rb.title || '').replace(/^📣\s*Dojava:\s*/i, '').trim() || rb.id
    const text = buildReportBackMessage({
      subject,
      tasks,
      missing: v.missing,
      projectId: rb.projectId,
      reportBackId: rb.id,
      maxLen: cfg.maxLen,
    })
    const chatId = marker!.chatId
    if (!cfg.live) {
      log(`report-back: SHADOW ${rb.id} → chatId ${chatId} (${tasks.length} zadataka, ${text.length} znakova)`)
      held.push({ id: rb.id, code: 'shadow', reason: 'live=false — poruka nije poslana, samo zapisana' })
      continue
    }
    let ok = false
    try { ok = deps.send(chatId, text) } catch (e) { log(`report-back: slanje palo ${rb.id}: ${String(e).slice(0, 200)}`) }
    if (!ok) {
      held.push({ id: rb.id, code: 'send_failed', reason: 'Telegram nije potvrdio isporuku — pokušava se u sljedećoj pometnji' })
      continue
    }
    // Redoslijed je namjeran: dnevnik PRIJE zatvaranja. Pad između dvaju koraka smije
    // ostaviti otvoren zadatak (vidljiv na ploči), ali NIKAD drugu poruku korisniku.
    deps.markSent(rb.id, chatId, text)
    try {
      deps.close(rb.id, `Poslana JEDNA dojava za niz od ${v.done.length} zadataka u grupu ${chatId}.\n` +
        `Zadaci: ${v.done.join(', ')}${v.missing.length ? ` · nedostaju: ${v.missing.join(', ')}` : ''}\n` +
        `Poruka (${text.length} znakova):\n${text}`)
    } catch (e) {
      log(`report-back: poruka POSLANA ali zatvaranje ${rb.id} palo: ${String(e).slice(0, 200)}`)
    }
    log(`report-back: SENT ${rb.id} → chatId ${chatId} (${tasks.length} zadataka)`)
    fired.push({ id: rb.id, code: 'sent', reason: `jedna poruka za ${v.done.length} zadataka` })
  }
  return { fired, held }
}
