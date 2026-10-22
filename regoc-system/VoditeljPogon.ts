// ─── Voditelj lanca V2: pogon u daemonu (ADR-0024 §O1–O3, TASK-5677) ─────────
// Sve što RegocDaemon radi s voditeljem, a da se može testirati bez daemona: tick (predprolaz →
// buđenje), traka `voditeljSpawns` izvan stropa, ključ trajne sesije, disanje (za exclusionReason),
// prompt buđenja s ovlastima O4/O4a/O5, predaja nove generacije, plan modela kroz `provjeriPlan`
// i izvedba radnji kroz rute ploče. Daemon ubrizgava I/O (ploča, git, spawn, log) — modul NIŠTA
// ne uvozi iz RegocDaemona.
//
// Prekidač: features.json `voditeljLanca` {enabled, mode: shadow|on}; off = tick ne radi ništa.
// Shadow: predprolaz + odluka (i plan) samo u daemon.log kao `👁️ [voditelj SHADOW] …`, bez spawna.

import { existsSync, readFileSync } from 'fs'
import * as V from './VoditeljLanca'
import * as T from './VoditeljTrag'
import { odluciTrajniPut, ZADANE_POSTAVKE as TRAJNE_ZADANE, type Pokazivac, type TrajnePostavke, type TrajniPut, type Brava } from './TrajnaSesija'

export const TICK_MS = 60_000
export const AGENT_VODITELJA = 'kosjenka'

// ─── Prepoznavanje voditelja ────────────────────────────────────────────────

/** Oznake iz retka baze (JSON tekst ili zarezima) ili s ploče (niz). */
export function oznakeIz(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try { const j = JSON.parse(raw); if (Array.isArray(j)) return j.map(String) } catch { /* zarezima */ }
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

/** `lanac:<x>` s voditelja; null = nije voditelj (sama oznaka `voditelj-lanca` bez lanca NIJE voditelj — npr. zadaci izvedbe ADR-0024). */
export function lanacVoditelja(raw: unknown): string | null {
  const o = oznakeIz(raw)
  if (!o.includes(V.OZNAKA_VODITELJA)) return null
  const l = o.find(t => t.startsWith('lanac:') && t.length > 'lanac:'.length)
  return l ? l.slice('lanac:'.length) : null
}

export const jeVoditelj = (raw: unknown): boolean => lanacVoditelja(raw) !== null

/** ADR-0024 O1: vlastiti ključ trajne sesije — nikad se ne poklapa s `kljucPokazivaca` obične Kosjenke. */
export const kljucSesijeVoditelja = (taskId: string): string =>
  `${AGENT_VODITELJA}@voditelj__${String(taskId).replace(/[^A-Za-z0-9_.-]/g, '-')}`

// ─── O3: traka `voditeljSpawns` izvan stropa ────────────────────────────────

export interface Trake<T> { aktivni: Map<string, T>; voditelji: Map<string, T> }

/** U koju kartu ide spawn. Voditelj NIKAD u `activeAgentSpawns` (ne broji se u strop, ne zauzima Kosjenku). */
export function trakaSpawna<T>(voditelj: boolean, t: Trake<T>): Map<string, T> {
  return voditelj ? t.voditelji : t.aktivni
}

/** Ima li mjesta. Voditelj gleda samo svoju traku (`maxIstodobno`), običan spawn samo strop agenata. */
export function mjestoUTraci<T>(voditelj: boolean, t: Trake<T>, maxAgenata: number, maxVoditelja: number): { ok: boolean; razlog?: string } {
  if (voditelj) {
    return t.voditelji.size < maxVoditelja ? { ok: true } : { ok: false, razlog: `traka voditelja puna (${t.voditelji.size}/${maxVoditelja})` }
  }
  return t.aktivni.size < maxAgenata ? { ok: true } : { ok: false, razlog: `strop agenata (${t.aktivni.size}/${maxAgenata})` }
}

// ─── O3: disanje (izuzeće u StaleWatchdog.exclusionReason) ──────────────────

export type StanjePogona = V.StanjeVoditelja & {
  /** Kad je javljeno „voditelj ne diše” (jednom); null kad opet diše. */
  alarmNeDise?: string | null
  /** Zadnji zapisani redak predprolaza (bez ponavljanja istog svakih 60 s). */
  zadnjiZapis?: string | null
}

/** Svjež = `sljedeceBudjenje` nije stariji od 2 × interval (ADR-0024 O3). */
export function disanje(s: V.StanjeVoditelja | null | 'pokvaren', p: V.PostavkeVoditelja, now: number): { svjez: boolean; razlog: string } {
  if (!s || s === 'pokvaren') return { svjez: false, razlog: s === 'pokvaren' ? 'stanje voditelja nečitljivo' : 'nema stanja voditelja' }
  const t = s.sljedeceBudjenje ? Date.parse(s.sljedeceBudjenje) : NaN
  if (!Number.isFinite(t)) return { svjez: false, razlog: 'bez sljedeceBudjenje' }
  const kasni = now - t
  const prag = 2 * p.intervalMin * 60_000
  return kasni <= prag
    ? { svjez: true, razlog: `sljedeće buđenje ${s.sljedeceBudjenje}` }
    : { svjez: false, razlog: `sljedeće buđenje kasni ${Math.round(kasni / 60_000)} min (> ${Math.round(prag / 60_000)} min)` }
}

/** Svaki prolaz ticka pomiče `sljedeceBudjenje` naprijed — daemon živ = voditelj diše i dok lanac miruje. */
export function osvjeziDisanje<S extends V.StanjeVoditelja>(s: S, p: V.PostavkeVoditelja, now: number): S {
  const zadnje = s.zadnjeBudjenje ? Date.parse(s.zadnjeBudjenje) : 0
  const sljedece = Math.max(zadnje + p.intervalMin * 60_000, now + TICK_MS)
  return { ...s, sljedeceBudjenje: new Date(sljedece).toISOString() }
}

// ─── Prikaz lanca (prompt, predaja) ─────────────────────────────────────────

const jedan = (x: unknown, n = 120) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

export function tablicaLanca(clanovi: V.Clan[], grane: V.GranaInfo[]): string {
  const red = ['| K | ID | status | izvršitelj | razlog | grana |', '|---|---|---|---|---|---|']
  for (const c of clanovi) {
    const g = grane.filter(x => x.taskId === c.id).map(x => `${x.grana}${x.spojena === true ? ' ✓main' : x.spojena === false ? ' ✗main' : ''}`).join(', ')
    red.push(`| ${V.kOznaka(c)} | ${c.id} | ${c.status} | ${c.assignee || '—'} | ${jedan(c.blockedReason, 100) || '—'} | ${g || '—'} |`)
  }
  return red.join('\n')
}

/** Kraj lanca (O6): svi članovi completed/cancelled i nijedna nespojena grana. */
export function lanacGotov(clanovi: V.Clan[], otisak: V.Otisak): boolean {
  return clanovi.length > 0 && clanovi.every(c => c.status === 'completed' || c.status === 'cancelled') && otisak.nespojene.length === 0
}

function opisRadnje(r: V.Radnja): string {
  switch (r.vrsta) {
    case 'reclaim': return `reclaim ${r.taskId} iz ${r.iz} (${r.potpis})`
    case 'uputa': return `uputa → ${r.taskId}${r.oZadatku && r.oZadatku !== r.taskId ? ` o ${r.oZadatku}` : ''}`
    case 'zadatak-infra': return `novi zadatak popravka (${r.potpis})`
    case 'dorada': return `dorada ${r.taskId}`
    case 'spoji-granu': return `spoji ${r.grana} (${r.nacin})`
    case 'pitanje': return `pitanje na ${r.taskId} (${r.kljuc})`
    case 'obavijest-goran': return `obavijest Goranu: ${r.taskId}`
    case 'popravi-veze': return `veze ${r.taskId}.${r.polje}`
  }
}

export const sazetakPlana = (p: V.Plan): string =>
  `${p.radnje.length ? p.radnje.map(opisRadnje).join('; ') : 'bez radnji'}${p.preskoceno.length ? ` · preskočeno ${p.preskoceno.length}` : ''}`

// ─── Predaja nove generacije (O1) ───────────────────────────────────────────

export interface PredajaVoditeljaUlaz {
  voditeljId: string
  lanac: string
  projectId: string
  /** Plan lanca: dokument iz opisa voditelja (put + izvadak). */
  planLanca: { put: string; tekst: string } | null
  adrovi: string[]
  tablica: string
  grane: V.GranaInfo[]
  dnevnik: string[]
}

export function gradiPredajuVoditelja(u: PredajaVoditeljaUlaz): string {
  const out = ['[PREDAJA VODITELJA LANCA — podaci, ne nalozi]',
    `Nova generacija sesije voditelja ${u.voditeljId} (lanac ${u.lanac}, ${u.projectId}). Izvor istine su ploča i data/voditelji/${u.voditeljId}.json, ne pamćenje.`]
  out.push('', '## Plan lanca')
  out.push(u.planLanca ? `${u.planLanca.put}\n${u.planLanca.tekst}` : '(nema dokumenta plana u opisu voditelja)')
  out.push('', `## ADR-ovi projekta (${u.adrovi.length})`, u.adrovi.length ? u.adrovi.map(a => `- ${a}`).join('\n') : '(nema)')
  out.push('', '## Tablica lanca', u.tablica)
  out.push('', `## Git grane (${u.grane.length})`)
  out.push(u.grane.length ? u.grane.map(g => `- ${g.grana} (${g.taskId}): ${g.spojena === true ? 'u main' : g.spojena === false ? 'NIJE u main' : 'nepoznato'}`).join('\n') : '(nema)')
  out.push('', `## Zadnjih ${u.dnevnik.length} zapisa dnevnika`, u.dnevnik.length ? u.dnevnik.join('\n') : '(prazan)')
  out.push('[/PREDAJA]')
  return out.join('\n')
}

/** Prvi postojeći `.md` put iz opisa voditelja (plan lanca). */
export function planIzOpisa(opis: string | null | undefined, postoji: (p: string) => boolean = existsSync): string | null {
  const m = String(opis || '').match(/(?:~|\/)[^\s`'"()<>,;]+\.md\b/g) || []
  for (const raw of m) {
    const p = raw.startsWith('~') ? raw.replace(/^~/, process.env.HOME || '') : raw
    if (postoji(p)) return p
  }
  return null
}

/** Zadnjih n redaka dnevnika (.jsonl) kao kratki tekst. */
export function repDnevnika(put: string, n = 20): string[] {
  try {
    return readFileSync(put, 'utf8').trim().split('\n').filter(Boolean).slice(-n).map(l => jedan(l, 300))
  } catch { return [] }
}

// ─── Prompt buđenja (O4, O4a, O5) ───────────────────────────────────────────

export const OZNAKA_PLANA = 'REGOC-VODITELJ-PLAN'

export interface PromptUlaz {
  voditeljId: string
  lanac: string
  projectId: string
  stablo: string
  razlog: string
  clanovi: V.Clan[]
  grane: V.GranaInfo[]
  posao: V.Posao
  prijedlog: V.Plan
  /** Za blokirane članove: doslovni razlog i izvještaj kritičara (O4a). */
  revizije: { taskId: string; blockedReason: string; izvjestaj: string }[]
  postavke: V.PostavkeVoditelja
}

export function gradiPromptBudjenja(u: PromptUlaz): string {
  const p = u.postavke
  const rev = u.revizije.length
    ? u.revizije.map(r => `### ${r.taskId}\nRazlog (doslovno): ${r.blockedReason.slice(0, 1500)}\nIzvještaj kritičara / zadnje bilješke:\n${r.izvjestaj.slice(0, 2000) || '(nema)'}`).join('\n\n')
    : '(nema blokiranih članova s padom)'
  return `# Buđenje voditelja lanca ${u.lanac} — ${u.voditeljId} (${u.projectId})

Ti si **voditelj lanca** (ADR-0024). Probudio te deterministički predprolaz jer ima posla: ${u.razlog}
Ovo je kratko buđenje (najviše ${p.maxTurns} koraka, rok ${p.rokMin} min). Stablo lanca: ${u.stablo}
Izvor istine su ploča (http://localhost:17781) i datoteka stanja, ne pamćenje.

## Stanje lanca
${tablicaLanca(u.clanovi, u.grane)}

Za rad: ${u.posao.zaRad.map(z => z.opis).join('; ') || '—'}
Čeka Gorana: ${u.posao.cekaGorana.join(', ') || '—'} · Radi: ${u.posao.radi.join(', ') || '—'} · Čeka prethodnika: ${u.posao.ceka.join(', ') || '—'}

## Revizija kritičara (O4a) — pročitaj PRIJE odluke
${rev}

## Prijedlog determinističkog planera (V1)
${u.prijedlog.radnje.length ? '```json\n' + JSON.stringify(u.prijedlog.radnje, null, 1).slice(0, 6000) + '\n```' : '(bez radnji)'}
Preskočeno: ${u.prijedlog.preskoceno.map(x => `${x.taskId || '—'}: ${x.razlog}`).join('; ') || '—'}

## Ovlasti (O4) — tablica je zakon
| Smiješ (radnju izvodi daemon kroz rute ploče) | NE smiješ |
|---|---|
| čitati ploču (GET), dnevnike, \`git log/branch/merge-base\`, izvještaje kritičara | \`PUT status\` (completed/cancelled/blocked) bilo kojem zadatku, ni sebi — zatvara kritičar (ADR-0012) |
| razvrstati pad: lažni (infra: krivo stablo, „filters did not match”, ENOSPC/disk, 401 mjerila, prekinut spawn, rok) ili stvarni (test pada na kodu zadatka) | dirati zadatke s \`no-watchdog\` / „radi isključivo Goran” (K7 push), osim čitanja |
| lažni → \`reclaim\` iz blocked, najviše ${p.maxReclaim24h}× po zadatku u 24 h; isti uzrok ${p.maxReclaim24h}× → \`zadatak-infra\` (Jelena), jedan po potpisu | \`git push\`, mijenjati features.json/konfiguraciju, restartati daemon/ploču/Klaudija |
| stvarni → \`uputa\` izvođaču + \`reclaim\`; \`dorada\` samo za completed člana | puštati \`blok:kriticar\` bez zapisane dijagnoze (potpis) |
| \`uputa\` zadatku u radu; \`popravi-veze\` (blockedBy/blocks) | otvarati zadatke izvan svog lanca i projekta |
| \`spoji-granu\` completed člana (D1: ${p.spajanjeGrana}) | više od ${p.maxNovihZadatakaBudjenje} nova zadatka po buđenju |

## Pravilo O4a — bez nove upute nema povrata (Goran, #422/#423)
1. Za svakog oborenog člana pročitaj što je kritičar napisao: koje provjere, s kojim izlazom, u kojem \`cwd\`.
2. Odluči je li pad stvaran ili infrastrukturni i zapiši potpis uzroka.
3. Uputa mora biti KONKRETNA: što kritičar traži, gdje je problem (datoteka/naredba/cwd), kako ga riješiti.
4. Adresat: stvarni pad → izvođaču u isti zadatak; uzrok u samom kritičaru (krivo stablo, okolina, krivo propisana provjera) → zadatku popravka kritičara (\`zadatak-infra\` ili \`uputa\` postojećem), izvođaču NIŠTA.
5. \`reclaim\` iz blocked samo uz novu uputu o tom nalazu u istom planu; ista uputa kao prošli put ne vrijedi kao nova.

## Pravilo O5 — Gorana pitaš samo kad stvarno čeka njega
Pitanje (\`pitanje\`: struka + ≥ 2 opcije + preporuka) ide na zadatak koji čeka Gorana, NIKAD na voditelja. Ključ je (zadatak, potpis uzroka): otvoreno pitanje s istim ključem se ne ponavlja. Samo-Goranov posao dobiva jednu \`obavijest-goran\` kad postane spreman. Ti se ne zaustavljaš i ne pitaš ništa drugo.

## Izlaz — OBAVEZAN
NE zovi rute za pisanje (POST/PUT) sam: daemon tvoj plan provjerava (\`provjeriPlan\`) i izvodi. Na kraju odgovora ispiši TOČNO jedan blok:

${OZNAKA_PLANA}
\`\`\`json
{"radnje": [ /* objekti kao u prijedlogu: {"vrsta":"uputa","taskId":"…","oZadatku":"…","potpis":"…","tekst":"…"}, {"vrsta":"reclaim","taskId":"…","iz":"blocked","potpis":"…","razlog":"…"}, … */ ], "biljeska": "jedna rečenica za progressNotes voditelja"}
\`\`\`

Dopuštene vrste: ${V.DOPUSTENE_RADNJE.join(', ')}. Prazan popis radnji je ispravan odgovor kad nema što raditi.
Zadnji redak: \`REGOC-VODITELJ: NASTAVAK\`. \`REGOC-STATUS: DONE\` piši SAMO kad su svi članovi completed/cancelled i sve grane u main — tada uz tablicu lanca i rezultat \`git merge-base --is-ancestor\`.
`
}

// ─── Plan modela → provjereni plan ──────────────────────────────────────────

export interface PlanModela { radnje: unknown[]; biljeska: string | null }

/** Zadnji blok `REGOC-VODITELJ-PLAN` + ```json```. null = nema bloka ili nije JSON objekt s `radnje`. */
export function izvuciPlanModela(tekst: string | null | undefined): PlanModela | null {
  const t = String(tekst || '')
  const i = t.lastIndexOf(OZNAKA_PLANA)
  if (i < 0) return null
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(t.slice(i))
  if (!m) return null
  try {
    const j = JSON.parse(m[1])
    if (!j || typeof j !== 'object' || !Array.isArray(j.radnje)) return null
    return { radnje: j.radnje, biljeska: typeof j.biljeska === 'string' ? j.biljeska.slice(0, 500) : null }
  } catch { return null }
}

const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '')

/**
 * Radnja koju je sastavio model → tipizirana radnja ili razlog odbijanja. Polja se uzimaju POIMENCE
 * (višak se ne prenosi u tijelo poziva); `status`/`tags` u radnji = odbijeno (ADR-0012), a način
 * spajanja određuje D1 iz postavki, ne model.
 */
export function normalizirajRadnju(raw: unknown, p: V.PostavkeVoditelja): V.Radnja | { odbijeno: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { odbijeno: 'radnja nije objekt' }
  const r = raw as Record<string, unknown>
  if ('status' in r) return { odbijeno: 'voditelj nikad ne postavlja status (ADR-0012: zatvara kritičar)' }
  if ('tags' in r) return { odbijeno: 'voditelj ne mijenja oznake zadataka' }
  const vrsta = str(r.vrsta)
  const taskId = str(r.taskId)
  const treba = (...polja: [string, string][]): string | null => {
    for (const [k, v] of polja) if (!v) return `${vrsta}: nedostaje '${k}'`
    return null
  }
  switch (vrsta) {
    case 'reclaim': {
      const iz = r.iz === 'in_progress' ? 'in_progress' : r.iz === 'blocked' ? 'blocked' : ''
      const razlog = str(r.razlog)
      const e = treba(['taskId', taskId], ['iz', iz], ['potpis', str(r.potpis)], ['razlog', razlog]); if (e) return { odbijeno: e }
      return { vrsta, taskId, iz: iz as 'blocked' | 'in_progress', potpis: str(r.potpis), razlog: razlog.startsWith('voditelj-lanca') ? razlog : `voditelj-lanca: ${razlog}` }
    }
    case 'zadatak-infra': {
      const e = treba(['potpis', str(r.potpis)], ['naslov', str(r.naslov)], ['opis', str(r.opis)]); if (e) return { odbijeno: e }
      return { vrsta, potpis: str(r.potpis), naslov: str(r.naslov).slice(0, 200), opis: str(r.opis), assignee: 'jelena', ...(str(r.oZadatku) ? { oZadatku: str(r.oZadatku) } : {}) }
    }
    case 'dorada': {
      const e = treba(['taskId', taskId], ['potpis', str(r.potpis)], ['assignee', str(r.assignee)], ['razlog', str(r.razlog)]); if (e) return { odbijeno: e }
      return { vrsta, taskId, potpis: str(r.potpis), assignee: str(r.assignee), razlog: str(r.razlog) }
    }
    case 'spoji-granu': {
      const e = treba(['taskId', taskId], ['grana', str(r.grana)]); if (e) return { odbijeno: e }
      return { vrsta, taskId, grana: str(r.grana), nacin: p.spajanjeGrana }
    }
    case 'pitanje': {
      const opcije = Array.isArray(r.opcije) ? r.opcije.map(str).filter(Boolean) : []
      const e = treba(['taskId', taskId], ['ekspert', str(r.ekspert)], ['pitanje', str(r.pitanje)], ['preporuka', str(r.preporuka)]); if (e) return { odbijeno: e }
      if (opcije.length < 2) return { odbijeno: 'pitanje: treba najmanje 2 opcije' }
      const kljuc = str(r.kljuc) || V.kljucPitanja(taskId, str(r.potpis) || 'model')
      return { vrsta, taskId, kljuc, ekspert: str(r.ekspert), pitanje: str(r.pitanje), opcije, preporuka: str(r.preporuka) }
    }
    case 'obavijest-goran': {
      const e = treba(['taskId', taskId], ['tekst', str(r.tekst)]); if (e) return { odbijeno: e }
      return { vrsta, taskId, kljuc: str(r.kljuc) || `${taskId}|spreman`, tekst: str(r.tekst) }
    }
    case 'popravi-veze': {
      if (r.polje !== 'blocks' && r.polje !== 'blockedBy') return { odbijeno: `popravi-veze: polje '${String(r.polje)}' nije blocks/blockedBy` }
      if (!taskId || !Array.isArray(r.nova) || !r.nova.every(x => typeof x === 'string')) return { odbijeno: 'popravi-veze: treba taskId i popis ID-ova' }
      return { vrsta, taskId, polje: r.polje, nova: r.nova as string[] }
    }
    case 'uputa': {
      const e = treba(['taskId', taskId], ['tekst', str(r.tekst)]); if (e) return { odbijeno: e }
      return { vrsta, taskId, tekst: str(r.tekst), ...(str(r.oZadatku) ? { oZadatku: str(r.oZadatku) } : {}), ...(str(r.potpis) ? { potpis: str(r.potpis) } : {}) }
    }
    default:
      return { odbijeno: `radnja '${vrsta || '—'}' nije u ovlastima voditelja (O4)` }
  }
}

/**
 * Plan modela kroz ista ograničenja kao deterministički (V1 `provjeriPlan`) + provjere koje
 * provjeriPlan ne zna jer radi nad radnjama koje je sastavio planer: O5 (pitanje/obavijest se ne
 * ponavljaju), grana mora stvarno biti nespojena grana tog člana, reclaim iz blocked samo blokiranom.
 */
export function provjeriPlanModela(raw: unknown[], u: { clanovi: V.Clan[]; stanje: V.StanjeVoditelja; postavke: V.PostavkeVoditelja; otisak: V.Otisak }): V.Plan {
  const kand: V.Radnja[] = []
  const preskoceno: V.Plan['preskoceno'] = []
  for (const x of raw) {
    const r = normalizirajRadnju(x, u.postavke)
    const taskId = (x as any)?.taskId
    if ('odbijeno' in r) { preskoceno.push({ taskId, razlog: r.odbijeno }); continue }
    if (r.vrsta === 'pitanje' && !V.smijePitati(u.stanje, r.kljuc)) { preskoceno.push({ taskId: r.taskId, razlog: `pitanje ${r.kljuc} već postavljeno — ne ponavljam (O5)` }); continue }
    if (r.vrsta === 'obavijest-goran' && u.stanje.obavijesti[r.kljuc]) { preskoceno.push({ taskId: r.taskId, razlog: `obavijest ${r.kljuc} već poslana (O5)` }); continue }
    if (r.vrsta === 'spoji-granu') {
      if (!u.otisak.nespojene.some(g => g.taskId === r.taskId && g.grana === r.grana)) { preskoceno.push({ taskId: r.taskId, razlog: `grana ${r.grana} nije nespojena grana completed člana ${r.taskId}` }); continue }
      if (u.stanje.grane[r.grana]) { preskoceno.push({ taskId: r.taskId, razlog: `grana ${r.grana} već obrađena` }); continue }
    }
    if (r.vrsta === 'reclaim') {
      const c = u.clanovi.find(k => k.id === r.taskId)
      if (c && c.status !== r.iz) { preskoceno.push({ taskId: r.taskId, razlog: `reclaim iz ${r.iz}, a ${r.taskId} je ${c.status}` }); continue }
    }
    kand.push(r)
  }
  const plan = V.provjeriPlan(kand, u)
  return { ...plan, preskoceno: [...preskoceno, ...plan.preskoceno] }
}

// ─── Izvedba plana (samo `on`) ──────────────────────────────────────────────

export interface Odgovor { ok: boolean; status: number; tijelo: any }

export interface IzvedbaOvisnosti {
  /** Poziv ploče; daemon dodaje ključ zatvarača za reclaim iz blocked. */
  zahtjev: (z: V.Zahtjev) => Promise<Odgovor>
  /** D1-A lokalno spajanje (privremeni worktree, --ff-only). */
  spoji?: (r: Extract<V.Radnja, { vrsta: 'spoji-granu' }>) => Promise<{ ok: boolean; razlog: string }>
  /** Obavijest Goranu (V3: Telegram). Bez nje se obavijest ne bilježi kao poslana. */
  obavijesti?: (r: Extract<V.Radnja, { vrsta: 'obavijest-goran' }>) => Promise<boolean>
  log: (s: string) => void
}

export interface Izvedba {
  izvedene: V.Radnja[]
  neuspjele: { radnja: V.Radnja; razlog: string }[]
  noviId: Record<string, string>
}

/** Radnje redom; neuspjela uputa o članu zaustavlja njegov reclaim u istom planu (#422). */
export async function izvediPlan(plan: V.Plan, ctx: { voditeljId: string; lanac: string; projectId: string }, d: IzvedbaOvisnosti): Promise<Izvedba> {
  const out: Izvedba = { izvedene: [], neuspjele: [], noviId: {} }
  const palaUputa = new Set<string>()
  for (let r of plan.radnje) {
    const ne = (razlog: string) => { out.neuspjele.push({ radnja: r, razlog }); d.log(`  ⚠️ [voditelj] ${ctx.voditeljId}: ${opisRadnje(r)} — ${razlog}`) }
    try {
      if (r.vrsta === 'reclaim' && r.iz === 'blocked' && palaUputa.has(r.taskId)) { ne('uputa o nalazu nije predana — bez nove upute nema povrata (#422)'); continue }
      if (r.vrsta === 'obavijest-goran') {
        if (!d.obavijesti) { ne('obavijest Goranu ide kroz V3 (TASK-5678) — nije poslana, ne bilježi se'); continue }
        if (await d.obavijesti(r)) out.izvedene.push(r); else ne('obavijest nije isporučena')
        continue
      }
      if (r.vrsta === 'spoji-granu' && r.nacin === 'sam') {
        const s = d.spoji ? await d.spoji(r) : { ok: false, razlog: 'spajanje nije dostupno' }
        if (s.ok) { out.izvedene.push(r); continue }
        d.log(`  ↪︎ [voditelj] ${ctx.voditeljId}: spajanje ${r.grana} nije uspjelo (${s.razlog}) — D1-B: zadatak „spoji granu”`)
        r = V.nakonNeuspjehaSpajanja(r)
      }
      if (r.vrsta === 'spoji-granu' && r.nacin === 'javi') { out.izvedene.push(r); continue }
      const z = V.uZahtjev(r, ctx)
      if (!z) { ne('radnja nema poziv ploče'); continue }
      const o = await d.zahtjev(z)
      if (!o.ok) {
        if (r.vrsta === 'uputa') palaUputa.add(r.oZadatku || r.taskId)
        ne(`HTTP ${o.status}: ${jedan(typeof o.tijelo === 'string' ? o.tijelo : JSON.stringify(o.tijelo), 200)}`)
        continue
      }
      if (r.vrsta === 'zadatak-infra') {
        const id = o.tijelo?.id || o.tijelo?.task?.id
        if (id) out.noviId[r.potpis] = String(id)
      }
      out.izvedene.push(r)
    } catch (e) {
      if (r.vrsta === 'uputa') palaUputa.add(r.oZadatku || r.taskId)
      ne(String(e))
    }
  }
  return out
}

// ─── Kraj buđenja ───────────────────────────────────────────────────────────

/** `zatvaranje` = model tvrdi DONE i lanac je stvarno gotov → normalni put (vratar + kritičar). Inače nastavak. */
export function ishodBudjenja(tekst: string | null | undefined, gotov: boolean): 'zatvaranje' | 'nastavak' {
  return /^\s*REGOC-STATUS:\s*DONE\b/m.test(String(tekst || '')) && gotov ? 'zatvaranje' : 'nastavak'
}

// ─── Tick (O2) ──────────────────────────────────────────────────────────────

export interface ZadatakVoditelja {
  id: string
  status: string
  tags: string[]
  projectId: string | null
  description?: string | null
  paused?: boolean
}

export interface BudjenjeUlaz {
  voditelj: ZadatakVoditelja
  lanac: string
  stanje: StanjePogona
  prompt: string
  predaja: string
  rokMs: number
  maxTurns: number
  maxIstodobno: number
  stablo: string
}

export interface TickOvisnosti {
  nacin: () => V.NacinVoditelja
  postavke: () => V.PostavkeVoditelja
  voditelji: () => ZadatakVoditelja[]
  clanovi: (lanac: string) => V.Clan[]
  stabloProjekta: (projectId: string | null) => string
  /** Grane completed članova i jesu li u main. */
  grane: (stablo: string, taskIds: string[]) => V.GranaInfo[]
  zivNajam: (taskId: string) => boolean
  statusZadatka?: (taskId: string) => string | undefined
  izvjestajKriticara?: (taskId: string) => string
  /** Globalna pauza ili pauza voditeljeva zadatka. */
  kocnica: (v: ZadatakVoditelja) => boolean
  vrataPustaju: () => boolean
  aktivnihVoditelja: () => number
  /** `on`: pending voditelj → in_progress (zadatak je u radu dok lanac nije gotov). */
  pokreni: (v: ZadatakVoditelja) => Promise<boolean>
  budi: (u: BudjenjeUlaz) => Promise<{ started: boolean; reason?: string }>
  predaja: (u: { voditelj: ZadatakVoditelja; lanac: string; stablo: string; clanovi: V.Clan[]; grane: V.GranaInfo[] }) => string
  alarm: (v: ZadatakVoditelja, tekst: string) => void
  log: (s: string) => void
  now: () => number
  dir?: string
  /** V3 (TASK-5678): poruke u grupu lanca (tg_send.py) i bilješke na voditelju. Bez njega nema traga izvan daemon.loga. */
  trag?: TragOvisnosti
}

export interface TragOvisnosti {
  /** Jedna poruka u grupu lanca (`chat:` voditelja); true = isporučeno. */
  posalji: (chatId: number, tekst: string) => Promise<boolean>
  biljeska: (taskId: string, tekst: string) => Promise<void>
}

type StanjeSTragom = StanjePogona & T.StanjeTraga

/** Poruka u grupu + zapis u daemon.log i dnevnik (svaka poruka je brojiva: `📨 [voditelj]`). */
async function posaljiUGrupu(tr: TragOvisnosti, v: { id: string }, chat: number, vrsta: string, tekst: string, log: (s: string) => void, dir?: string): Promise<boolean> {
  let ok = false
  try { ok = await tr.posalji(chat, tekst) } catch (e) { log(`⚠️ [voditelj] ${v.id}: slanje ${vrsta} palo: ${e}`) }
  log(`📨 [voditelj] ${v.id}: ${vrsta} → chat ${chat}: ${ok ? 'poslano' : 'NIJE poslano'} (${tekst.length} znakova)`)
  V.dopisiDnevnik(v.id, { poruka: vrsta, chat, ok, znakova: tekst.length }, dir)
  return ok
}

export interface IshodTicka { taskId: string; kod: V.KodPredprolaza | 'pokvaren' | 'bez-lanca' | 'pokrenut' | 'nije-krenuo'; budi: boolean; sjena: boolean }

const zadnjiZapisi = new Map<string, string>()

export async function prolazVoditelja(d: TickOvisnosti): Promise<IshodTicka[]> {
  const nacin = d.nacin()
  if (nacin === 'off') return []
  const p = d.postavke()
  const now = d.now()
  const sjena = nacin === 'shadow'
  const pfx = sjena ? '👁️ [voditelj SHADOW]' : '🧭 [voditelj]'
  const out: IshodTicka[] = []
  // Isti redak se ne ponavlja svakih 60 s: zadnji je u stanju (`zadnjiZapis`), a za nečitljivo
  // stanje u memoriji procesa (ključ uključuje mapu stanja, pa se testovi i čvorovi ne miješaju).
  const zapisi = (id: string, redak: string, uvijek = false, prosli?: string | null) => {
    const k = `${d.dir || ''}|${id}`
    if (!uvijek && (prosli ?? zadnjiZapisi.get(k)) === redak) return
    zadnjiZapisi.set(k, redak)
    d.log(`${pfx} ${redak}`)
  }

  for (let v of d.voditelji()) {
    if (v.status !== 'pending' && v.status !== 'in_progress') continue
    const lanac = lanacVoditelja(v.tags)
    if (!lanac) { out.push({ taskId: v.id, kod: 'bez-lanca', budi: false, sjena }); continue }

    const procitano = V.citajStanje(v.id, d.dir)
    if (procitano === 'pokvaren') {
      zapisi(v.id, `${v.id}: stanje ${V.putStanja(v.id, d.dir)} nečitljivo — ne prepisujem, voditelj stoji`)
      out.push({ taskId: v.id, kod: 'pokvaren', budi: false, sjena }); continue
    }
    const stablo = procitano?.stablo || d.stabloProjekta(v.projectId)
    let s: StanjePogona = procitano || V.novoStanje({ voditeljId: v.id, lanac, stablo, projectId: v.projectId || '' })

    // Disanje se mjeri PRIJE osvježavanja: kasni li, daemon nije disao (pad, restart, off).
    if (v.status === 'in_progress' && procitano) {
      const dis = disanje(s, p, now)
      if (!dis.svjez && !s.alarmNeDise) {
        d.alarm(v, `🫁 voditelj ${v.id} (lanac ${lanac}) ne diše: ${dis.razlog}`)
        s = { ...s, alarmNeDise: new Date(now).toISOString() }
      } else if (dis.svjez && s.alarmNeDise) s = { ...s, alarmNeDise: null }
    }

    if (!sjena && v.status === 'pending') {
      if (!(await d.pokreni(v))) { zapisi(v.id, `${v.id}: pending → in_progress nije uspjelo, pokušavam sljedeći prolaz`); continue }
      v = { ...v, status: 'in_progress' }
      zapisi(v.id, `${v.id}: voditelj lanca ${lanac} pokrenut (in_progress do kraja lanca)`, true)
    }

    const clanovi = d.clanovi(lanac)
    const gotovi = clanovi.filter(c => c.status === 'completed').map(c => c.id)
    const grane = gotovi.length ? d.grane(stablo, gotovi) : []
    const otisak = V.izracunajOtisak(clanovi, grane, d.zivNajam)
    const posao = V.procijeniPosao(clanovi, otisak, s.otvorenaPitanja, c => V.cekaPopravak(c, s, p, now, d.statusZadatka))
    const presude = T.presudeLanca(clanovi, otisak)
    const chat = T.chatVoditelja(v.tags)
    const kocnica = d.kocnica(v)
    let st = s as StanjeSTragom
    // O6/V3: u sjeni JEDINA poruka u grupu je najava (jednom po voditelju, zapis preživi restart).
    if (d.trag && chat !== null && !kocnica && T.trebaNajavu(st, nacin)) {
      const ok = await posaljiUGrupu(d.trag, v, chat, 'najava sjene', T.tekstNajave({ voditeljId: v.id, lanac, presude }), d.log, d.dir)
      st = { ...st, najavaSjene: `${new Date(now).toISOString()}${ok ? '' : ' (nije isporučeno)'}` }
    }
    // Dnevni sažetak 08:00 — samo ako se u 24 h nešto dogodilo; u sjeni samo zapis.
    const sz = T.odluciSazetak(st, { nacin, now, dnevnik: T.citajDnevnik(v.id, d.dir) })
    if (sz.obradi) {
      st = { ...st, sazetakDan: V.danKljuc(now) }
      let poslano = false
      if (sz.salji && d.trag && chat !== null) {
        const pd = V.danKljuc(now) === st.potrosnja.dan ? st.potrosnja : { budjenja: 0, usd: 0 }
        poslano = await posaljiUGrupu(d.trag, v, chat, 'dnevni sažetak', T.tekstSazetka({ voditeljId: v.id, lanac, dogadjaja: sz.dogadjaja, presude, potrosnja: pd }), d.log, d.dir)
      }
      if (sz.dogadjaja) zapisi(v.id, `${v.id}: dnevni sažetak — ${sz.razlog}${sz.salji ? (poslano ? ' · poslan' : ' · nije poslan') : ''}`, true)
      V.dopisiDnevnik(v.id, { sazetak: true, razlog: sz.razlog, dogadjaja: sz.dogadjaja, poslano }, d.dir)
    }
    s = st
    const pp = V.predprolaz({
      voditeljId: v.id, nacin, kocnica, vrataPustaju: d.vrataPustaju(),
      aktivnihVoditelja: d.aktivnihVoditelja(), now, postavke: p, stanje: s, otisak, posao,
    })
    s = osvjeziDisanje(pp.stanje as StanjePogona, p, now)

    if (!pp.budi) {
      zapisi(v.id, pp.zapis, false, procitano ? (procitano as StanjePogona).zadnjiZapis ?? null : null)
      s = { ...s, zadnjiZapis: pp.zapis }
      V.zapisiStanje(s, d.dir)
      out.push({ taskId: v.id, kod: pp.kod, budi: false, sjena })
      continue
    }

    const plan = V.planirajRadnje({
      voditeljId: v.id, lanac, projectId: v.projectId || '', clanovi, otisak, stanje: s, postavke: p, now,
      statusZadatka: d.statusZadatka, izvjestajKriticara: d.izvjestajKriticara,
    })

    if (sjena) {
      zapisi(v.id, `${v.id}: BI BUDIO model — ${pp.razlog} · plan: ${sazetakPlana(plan)}`, true)
      // V3: presuda po članu (lažni/stvarni pad, nespojena grana, Goranov posao) + jedna bilješka po promjeni.
      const biljeska = T.biljeskaSjene(presude, sazetakPlana(plan))
      const nova = biljeska !== (s as StanjeSTragom).zadnjaBiljeska
      if (nova || pp.kod === 'otisak') for (const pr of presude) zapisi(v.id, `${v.id}: presuda ${pr.taskId} — ${pr.tekst}`, true)
      if (nova && d.trag) { await d.trag.biljeska(v.id, biljeska).catch(e => d.log(`⚠️ [voditelj] ${v.id}: bilješka nije upisana (${e})`)); s = { ...s, zadnjaBiljeska: biljeska } as StanjeSTragom }
      V.dopisiDnevnik(v.id, { sjena: true, kod: pp.kod, promjena: pp.kod === 'otisak', razlog: pp.razlog, otisak: otisak.hash, presude, plan: plan.radnje, preskoceno: plan.preskoceno }, d.dir)
      // Sjena „troši” samo otisak i vrijeme (inače bi isti redak išao svake minute), ne proračun dana.
      const nakon = V.zabiljeziBudjenje(s, otisak.hash, now, p)
      V.zapisiStanje({ ...nakon, potrosnja: s.potrosnja, zadnjiZapis: pp.zapis } as StanjePogona, d.dir)
      out.push({ taskId: v.id, kod: pp.kod, budi: true, sjena })
      continue
    }

    const revizije = clanovi.filter(c => c.status === 'blocked' && String(c.blockedReason || '').trim() && !V.samoGoran(c))
      .map(c => ({ taskId: c.id, blockedReason: String(c.blockedReason), izvjestaj: d.izvjestajKriticara?.(c.id) || '' }))
    const prompt = gradiPromptBudjenja({ voditeljId: v.id, lanac, projectId: v.projectId || '', stablo, razlog: pp.razlog, clanovi, grane, posao, prijedlog: plan, revizije, postavke: p })
    const { maxTurns, rokMs } = V.argumentiBudjenja(p)
    const start = await d.budi({ voditelj: v, lanac, stanje: s, prompt, predaja: d.predaja({ voditelj: v, lanac, stablo, clanovi, grane }), rokMs, maxTurns, maxIstodobno: p.maxIstodobno, stablo })
    if (!start.started) {
      zapisi(v.id, `${v.id}: buđenje nije krenulo (${start.reason || '?'}) — pokušavam sljedeći prolaz`)
      V.zapisiStanje(s, d.dir)
      out.push({ taskId: v.id, kod: 'nije-krenuo', budi: true, sjena }); continue
    }
    const nakon = V.zabiljeziBudjenje(s, otisak.hash, now, p)
    V.zapisiStanje({ ...nakon, zadnjiZapis: pp.zapis } as StanjePogona, d.dir)
    V.dopisiDnevnik(v.id, { budjenje: true, kod: pp.kod, promjena: pp.kod === 'otisak', razlog: pp.razlog, otisak: otisak.hash, presude, prijedlog: plan.radnje.length }, d.dir)
    zapisi(v.id, pp.zapis, true)
    out.push({ taskId: v.id, kod: pp.kod, budi: true, sjena })
  }
  return out
}

/** Trošak buđenja u stanje (proračun dana `maxUsdDan`). */
export function zabiljeziTrosakVoditelja(voditeljId: string, usd: number, now: number, dir?: string): void {
  const s = V.citajStanje(voditeljId, dir)
  if (!s || s === 'pokvaren') return
  V.zapisiStanje(V.zabiljeziTrosak(s, usd, now), dir)
}

// ─── Kraj buđenja: plan modela → izvedba ────────────────────────────────────

export interface ZavrsetakOvisnosti extends IzvedbaOvisnosti {
  clanovi: (lanac: string) => V.Clan[]
  grane: (stablo: string, taskIds: string[]) => V.GranaInfo[]
  zivNajam: (taskId: string) => boolean
  postavke: () => V.PostavkeVoditelja
  biljeska: (taskId: string, tekst: string) => Promise<void>
  now: () => number
  dir?: string
  /** V3: jedna poruka u grupu po buđenju (obavijest Goranu ide u istu poruku). */
  trag?: TragOvisnosti
  nacin?: () => V.NacinVoditelja
}

export async function zavrsiBudjenje(v: { id: string; projectId: string | null; tags?: string[] }, lanac: string, tekst: string, d: ZavrsetakOvisnosti): Promise<{ ishod: 'zatvaranje' | 'nastavak'; izvedba: Izvedba | null; plan: V.Plan | null }> {
  const s = V.citajStanje(v.id, d.dir)
  if (!s || s === 'pokvaren') { d.log(`⚠️ [voditelj] ${v.id}: stanje nečitljivo nakon buđenja — plan se ne izvodi`); return { ishod: 'nastavak', izvedba: null, plan: null } }
  const p = d.postavke()
  const clanovi = d.clanovi(lanac)
  const gotovi = clanovi.filter(c => c.status === 'completed').map(c => c.id)
  const otisak = V.izracunajOtisak(clanovi, gotovi.length ? d.grane(s.stablo, gotovi) : [], d.zivNajam)
  const ishod = ishodBudjenja(tekst, lanacGotov(clanovi, otisak))
  if (ishod === 'zatvaranje') return { ishod, izvedba: null, plan: null }

  const pm = izvuciPlanModela(tekst)
  if (!pm) {
    d.log(`⚠️ [voditelj] ${v.id}: model nije dao ${OZNAKA_PLANA} — ništa se ne izvodi`)
    V.dopisiDnevnik(v.id, { kraj: true, plan: null, razlog: 'bez bloka plana' }, d.dir)
    return { ishod, izvedba: null, plan: null }
  }
  const plan = provjeriPlanModela(pm.radnje, { clanovi, stanje: s, postavke: p, otisak })
  const chat = T.chatVoditelja(v.tags)
  const tr = d.trag && chat !== null ? d.trag : null
  // Obavijest Goranu ne ide zasebno: skuplja se u JEDNU poruku buđenja (O6), a bilježi se tek kad je ta poruka isporučena.
  const obavijesti: string[] = []
  const izv = await izvediPlan(plan, { voditeljId: v.id, lanac, projectId: v.projectId || s.projectId },
    tr && !d.obavijesti ? { ...d, obavijesti: async r => { obavijesti.push(`${r.taskId}: ${r.tekst}`); return true } } : d)
  const now = d.now()
  let izvedene = izv.izvedene
  let porukaOtisak = (s as StanjeSTragom).porukaOtisak ?? null
  const odl = T.odluciPorukuBudjenja(s as StanjeSTragom, { nacin: d.nacin?.() ?? 'on', otisak: otisak.hash, izvedenih: izvedene.length })
  if (tr && odl.salji) {
    // Presude nad svježim stanjem ploče (nakon radnji), grane iz istog prolaza.
    const tekst = T.tekstPorukeBudjenja({ voditeljId: v.id, lanac, presude: T.presudeLanca(d.clanovi(lanac), otisak),
      radnje: izvedene.filter(r => r.vrsta !== 'obavijest-goran').map(opisRadnje), obavijesti })
    if (await posaljiUGrupu(tr, v, chat!, 'poruka buđenja', tekst, d.log, d.dir)) porukaOtisak = otisak.hash
    else izvedene = izvedene.filter(r => r.vrsta !== 'obavijest-goran')
  } else if (tr) d.log(`🔕 [voditelj] ${v.id}: bez poruke u grupu (${odl.razlog})`)
  const novo = { ...V.zabiljeziRadnje(s, izvedene, now, izv.noviId), porukaOtisak } as StanjeSTragom
  // N3 (TASK-5679): vlastiti povrat (član → pending) nije okidač O2. Ako se lanac dok je model radio nije
  // promijenio izvana (otisak = onaj iz buđenja), otisak nakon radnji voditelja postaje poznat — nema buđenja bez posla.
  if (otisak.hash === s.otisak && izvedene.some(r => r.vrsta === 'reclaim')) {
    const cl = d.clanovi(lanac)
    const gt = cl.filter(c => c.status === 'completed').map(c => c.id)
    Object.assign(novo, { otisak: V.izracunajOtisak(cl, gt.length ? d.grane(s.stablo, gt) : [], d.zivNajam).hash, otisakKandidat: null })
  }
  V.zapisiStanje(novo, d.dir)
  V.dopisiDnevnik(v.id, { kraj: true, izvedene, neuspjele: izv.neuspjele.map(n => ({ vrsta: n.radnja.vrsta, razlog: n.razlog })), preskoceno: plan.preskoceno, biljeska: pm.biljeska }, d.dir)
  const sazetak = izvedene.length ? izvedene.map(opisRadnje).join('; ') : 'bez radnji'
  await d.biljeska(v.id, `🧭 voditelj: ${pm.biljeska ? `${pm.biljeska} · ` : ''}${sazetak}${izv.neuspjele.length ? ` · neuspjelo ${izv.neuspjele.length}` : ''}${plan.preskoceno.length ? ` · odbijeno ${plan.preskoceno.length}` : ''}`)
  return { ishod, izvedba: { ...izv, izvedene }, plan }
}

// ─── Trajna sesija voditelja (O1) ───────────────────────────────────────────

/** Odluka sesije pod vlastitim ključem; opseg `dopusteniProjekti` obične trajne sesije ne vrijedi (vlastiti prekidač voditeljLanca). */
export function odlukaSesijeVoditelja(u: { taskId: string; stablo: string; model: string; provider: string; pokazivac: Pokazivac | null | 'pokvaren'; bravaZiva: (b: Brava) => boolean; now: number; postavke?: TrajnePostavke }): TrajniPut {
  const post: TrajnePostavke = { ...(u.postavke || TRAJNE_ZADANE), dopusteniProjekti: null, dopustenaStabla: null }
  return odluciTrajniPut({
    agentId: AGENT_VODITELJA, persistentEnabled: true, provider: u.provider, compat: false, tags: [],
    stablo: u.stablo, model: u.model, pokazivac: u.pokazivac, bravaZiva: u.bravaZiva,
    zivNajamUStablu: false, now: u.now, postavke: post,
  })
}
