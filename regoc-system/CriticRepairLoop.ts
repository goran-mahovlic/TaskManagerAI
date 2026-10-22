#!/usr/bin/env bun
/**
 * CriticRepairLoop — W4 „vratar dobiva povratnu petlju" (TASK-4617, PRJ REGOC_SYSTEM).
 *
 * PROBLEM (mjereno, ne pretpostavljeno). `CriticGate` od 30.07.2026. sam pokreće provjere i
 * sudi o onome što je ostalo na disku. Njegov `decideNextAction` VEĆ razlikuje dvije stvari —
 * `repair` („kvar je nov, vrati izvođaču") i `escalate` („ne konvergira / potrošeni krugovi") —
 * i `formatRepairBrief` VEĆ složi točan izvještaj s naredbom kojom se kvar reproducira.
 * Samo što je `RegocDaemon` oba ishoda provodio ISTO: zadatak u `blocked`, brief u
 * `progress_notes`, i tu posao STANE. Izmjereno na `data/critic_gate.jsonl` (05.09.2026.):
 * 176 sudova, 6 odbijanja, svih 6 `enforced=true` — i nijedno od njih nikada nije dobilo
 * drugi krug, jer mehanizam vraćanja nije postojao. `blocked` je pritom mjereno groblje
 * (87 zadataka, medijan 8,3 dana), a `progress_notes` NE ulaze u prompt sljedećeg spawna
 * (`readTaskContext` čita samo `tags`, `project_id` i `description`). Drugim riječima:
 * kritičar je pisao nalaz kojemu nitko nije bio adresat.
 *
 * RJEŠENJE (Anthropicov evaluator–optimizer, u našem obliku): odbijeni korak se VRAĆA
 * izvršitelju s konkretnim nalazom vratara — najviše dva kruga — pa eskalacija čovjeku.
 *   1. nalaz se sprema kao datoteka (`data/critic_briefs/<TASK>.json`),
 *   2. zadatak dobiva oznaku `kritika:<n>` i vraća se u `pending` (`reclaim`),
 *   3. sljedeći prolaz auto-execa ubacuje nalaz U PROMPT (`criticRepairTail`), pa izvođač
 *      vidi TOČNO koja je naredba pala i s kojom greškom,
 *   4. iznad stropa ide stari put (`blocked` = traži čovjeka), ali s porukom koja nosi ID.
 *
 * ZAŠTO ODVOJEN BROJAČ (`kritika:` a ne `pokusaj:` / `resume:`): `pokusaj:<n>` broji PADOVE
 * SPAWNA (R7/TASK-2563), `resume:<n>` broji NASTAVKE nakon urednog gašenja (M4/TASK-4627).
 * Ovdje se broji nešto treće — spawn koji je uredno završio, ali je isporuka pala na
 * provjeri. Kad bi dijelili brojač, jedan restart daemona trošio bi kredit popravka (i
 * obratno), pa bi zadatak koji je samo preživio restart ostao bez ijednog kruga popravka.
 *
 * ODAKLE STROP: `maxRounds` iz `config/critic-gate.json` — JEDAN izvor istine. Ovdje se ne
 * prepisuje ni ne pogađa; `repair`/`escalate` presuđuje `CriticGate.decideNextAction`, a ovaj
 * modul samo PROVODI tu presudu. Bez toga bi se dva stropa vremenom razišla.
 *
 * MJERILO (plan §3 W4): „udio odbijenih koraka koji prođu u drugom krugu; ako je ispod
 * trećine, petlja se gasi kao neisplativa." Računa ga `ocijeniPetlju` iz ovog modula
 * (alat: `tools/critic-repair-mjera.ts`). Mjerilo je dio isporuke, a ne naknadna misao —
 * evaluator–optimizer je po Anthropicovu vlastitom tekstu obrazac koji se „isplati samo ako
 * ocjena mjerljivo popravlja izlaz".
 *
 * UGOVOR (pribijen u tests/critic-repair-loop.test.ts):
 *   1. nalaz i oznaka se upisuju PRIJE `reclaim`-a; ako upis padne, zadatak se NE vraća u red;
 *   2. strop krugova dolazi iz CriticGatea — iznad njega je `escalate`, nikad tihi treći krug;
 *   3. dira se SAMO zadatak koji je stvarno `in_progress`;
 *   4. `escalate` NIKAD ne zatvara zadatak (`cancelled` je terminalan) — traži čovjeka;
 *   5. shadow (`live=false`) samo zapisuje odluku — ne mijenja status i ne šalje poruku;
 *   6. ustajali nalaz (iz starijeg kruga) se NE ubacuje u prompt — bolje bez nalaza nego
 *      s krivim;
 *   7. nijedna iznimka ne smije pobjeći: ovo visi na izlaznoj putanji spawna.
 *
 * Sve nuspojave (mreža, disk, dnevnik) ulaze kroz `deps` → testira se bez daemona.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()

/** Dnevnik odluka petlje — ulaz za mjerilo iz plana §3 W4. */
export function criticRepairLogFile(): string {
  return process.env.REGOC_CRITIC_REPAIR_LOG || join(HOME, '.claude/regoc/data/critic_repair.jsonl')
}

/** Mapa s nalazima koji čekaju isporuku u prompt. */
export function briefDir(): string {
  return process.env.REGOC_CRITIC_BRIEF_DIR || join(HOME, '.claude/regoc/data/critic_briefs')
}

/** Prag isplativosti iz plana: ispod trećine se petlja gasi. */
export const PRAG_ISPLATIVOSTI = 1 / 3

const REPAIR_TAG = /^kritika:(\d+)$/

// ============================================
// Brojač krugova (oznaka na zadatku)
// ============================================

/** Koliko je krugova popravka zadatak već potrošio (0 = nijedan). */
export function repairRound(tags: unknown): number {
  const list = Array.isArray(tags) ? tags.map((t) => String(t)) : []
  let n = 0
  for (const t of list) {
    const m = REPAIR_TAG.exec(t)
    if (m) n = Math.max(n, Number(m[1]))
  }
  return n
}

/** Oznake zadatka s postavljenim krugom `n` — stara oznaka se ZAMJENJUJE, ne gomila. */
export function withRepairTag(tags: unknown, n: number): string[] {
  const list = Array.isArray(tags) ? tags.map((t) => String(t)) : []
  const out: string[] = []
  for (const t of list) {
    if (REPAIR_TAG.test(t)) continue
    if (!out.includes(t)) out.push(t)
  }
  out.push(`kritika:${n}`)
  return out
}

// ============================================
// Nalaz vratara (ono što izvođač stvarno vidi)
// ============================================

export interface RepairBrief {
  taskId: string
  /** Krug u kojem je nalaz nastao — mora se poklopiti s oznakom `kritika:<n>`. */
  round: number
  ts: string
  agentId: string
  /** Tekst iz `CriticGate.formatRepairBrief` — kvar + naredba kojom se reproducira. */
  brief: string
  /** Potpisi kvara; po njima `decideNextAction` prepoznaje nekonvergenciju. */
  signatures: string[]
}

function briefPath(taskId: string, dir = briefDir()): string {
  // Naziv datoteke nastaje SAMO od [A-Za-z0-9_-] — ID zadatka dolazi izvana i ne smije
  // biti put ('../'). Ovo je isti razlog zbog kojeg CriticGate ima zatvoren rječnik naredbi.
  return join(dir, `${String(taskId).replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
}

export function saveRepairBrief(b: RepairBrief, dir = briefDir()): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(briefPath(b.taskId, dir), JSON.stringify(b, null, 2))
    return true
  } catch {
    return false
  }
}

export function readRepairBrief(taskId: string, dir = briefDir()): RepairBrief | null {
  try {
    const p = briefPath(taskId, dir)
    if (!existsSync(p)) return null
    const b = JSON.parse(readFileSync(p, 'utf-8')) as RepairBrief
    return b && typeof b.brief === 'string' ? b : null
  } catch {
    return null
  }
}

export function clearRepairBrief(taskId: string, dir = briefDir()): void {
  try { rmSync(briefPath(taskId, dir), { force: true }) } catch { /* brisanje ne ruši ništa */ }
}

/**
 * Nalaz za prompt sljedećeg kruga — ili prazno.
 *
 * USTAJALOST JE KVAR, NE SITNICA: nalaz vrijedi TOČNO za krug u kojem je nastao. Kad se
 * broj kruga iz nalaza ne poklapa s oznakom `kritika:<n>` na zadatku, izvođač bi dobio
 * uputu da popravlja kvar koji je možda već popravljen — a to je gore nego nikakva uputa,
 * jer zvuči autoritativno. Zato: ne poklapa se ⇒ ne ubacuje se.
 */
export function repairPromptTail(taskId: string, tags: unknown, maxRounds: number, dir = briefDir()): string {
  const b = readRepairBrief(taskId, dir)
  if (!b) return ''
  const round = repairRound(tags)
  if (round <= 0 || b.round !== round) return ''
  return formatRepairTail(b, maxRounds)
}

/** Oblik u kojem nalaz ulazi u prompt. Zapovjedni ton je namjeran — ovo je ispravak, ne prijedlog. */
export function formatRepairTail(b: RepairBrief, maxRounds: number): string {
  return `

## ⛔ PRETHODNI POKUŠAJ JE ODBIJEN — OVO JE KRUG ${b.round}/${maxRounds}
Nezavisni vratar (CriticGate) je SAM pokrenuo provjere nad onim što je ostalo na disku i
one su pale. Ovo NIJE nov zadatak nego POPRAVAK: prvo ukloni kvar ispod, pa tek onda nastavi.

${b.brief}

PRAVILA OVOG KRUGA:
1. Popravi TOČNO ono što je palo i pokreni istu naredbu da dokažeš da sada prolazi —
   njezin doslovni izlaz stavi u rezultat (bez toga vratar odbija i drugi put).
2. Ako je nalaz vratara po tvojoj procjeni POGREŠAN, nemoj ga tiho zaobići: napiši zašto
   i čime to dokazuješ. Neslaganje s obrazloženjem je uredan ishod, prešućivanje nije.
3. Ovo je krug ${b.round} od najviše ${maxRounds}. Nakon toga zadatak ide čovjeku, pa
   nema smisla „pokušati isto ponovno" — ako ne znaš uzrok, prijavi BLOCKED s razlogom.
`
}

// ============================================
// Odluka (čista funkcija)
// ============================================

export type RepairVerdict =
  /** Vrati izvođaču s nalazom — ima još krugova. */
  | 'repair'
  /** Strop/nekonvergencija ⇒ čovjek. Zadatak ostaje `blocked`, ali uz poruku. */
  | 'escalate'
  /** Sud nije odbijenica — petlja se ne pali. */
  | 'accept'
  | 'no-task'
  | 'not-in-progress'
  | 'failed'

export interface CriticRepairInput {
  agent: string
  taskId?: string | null
  status?: string
  tags?: unknown
  /** Presuda `CriticGate.decideNextAction` — SSOT za repair/escalate. */
  action: 'accept' | 'repair' | 'escalate'
  /** `loop.round` iz CriticGatea; postaje oznaka `kritika:<n>`. */
  round: number
}

export interface CriticRepairDecision {
  agent: string
  taskId: string | null
  round: number
  verdict: RepairVerdict
  reason: string
}

/**
 * Smije li se OVAJ zadatak vratiti u red?
 *
 * Namjerno NE ponavlja sud o krugovima — taj je već donesen u `CriticGate` i ovdje bi
 * druga kopija pravila značila dva stropa koja se razilaze (naučeno na `resume:`/`pokusaj:`).
 */
export function planCriticRepair(input: CriticRepairInput): CriticRepairDecision {
  const taskId = input.taskId ? String(input.taskId) : null
  const base = { agent: input.agent, taskId, round: input.round }
  if (input.action === 'accept') {
    return { ...base, verdict: 'accept', reason: 'vratar nije odbio korak — nema što vraćati' }
  }
  if (!taskId) {
    return { ...base, verdict: 'no-task', reason: 'spawn nema zadatak — nema koga vratiti u red' }
  }
  if (input.action === 'escalate') {
    return { ...base, verdict: 'escalate', reason: 'krugovi popravka su potrošeni ili popravak ne konvergira — odlučuje čovjek' }
  }
  if (input.status !== 'in_progress') {
    return { ...base, verdict: 'not-in-progress', reason: `status je '${input.status}' — netko ga je već zatvorio, ne diram` }
  }
  return { ...base, verdict: 'repair', reason: `vraćam izvođaču s nalazom vratara, krug ${input.round}` }
}

// ============================================
// Poruke (R1 kanal — odustajanje nikad nije tiho)
// ============================================

export function repairUserMessage(taskId: string, round: number, maxRounds: number, sazetak: string): string {
  return `↩︎ **${taskId}** vraćen izvođaču na popravak (krug ${round}/${maxRounds}) — vratar je odbio isporuku: ${sazetak}. `
    + `Sljedeći prolaz ga pokreće s konkretnim nalazom u promptu.`
}

export function escalateUserMessage(taskId: string, round: number, maxRounds: number, sazetak: string): string {
  return `🧑‍⚖️ **${taskId}** traži tvoju odluku — vratar ga je odbio i nakon ${maxRounds} kruga popravka (zadnje: ${sazetak}). `
    + `Petlja staje ovdje namjerno: sljedeći pokušaj ne bi bio ni jeftiniji ni pametniji. Zadatak je blocked.`
}

// ============================================
// Provedba (nuspojave kroz deps)
// ============================================

export interface CriticRepairEvent {
  ts: string
  taskId: string | null
  agent: string
  verdict: RepairVerdict
  round: number
  live: boolean
  /** Potpisi kvara — po njima se u mjerilu vidi je li drugi krug uklonio ISTI kvar. */
  signatures: string[]
  reason: string
}

export interface CriticRepairDeps {
  getTask(taskId: string): Promise<{ status?: string; tags?: unknown } | null>
  setTags(taskId: string, tags: string[], note: string): Promise<boolean>
  /** POST /api/tasks/:id/reclaim — jedini legalan put `in_progress -> pending`. */
  reclaim(taskId: string, reason: string): Promise<boolean>
  saveBrief(b: RepairBrief): boolean
  /**
   * Brisanje nalaza ide kroz ISTI spremnik kao spremanje. Dok je išlo mimo `deps`
   * (izravno na `briefDir()`), povlačenje neuspjelog kruga je čistilo drugu mapu od one
   * u koju je `saveBrief` upisao — u pogonu se poklapalo slučajno, jer je daemon predavao
   * zadanu mapu. Takav šav ostavlja ustajali nalaz, a to je točno ono što ugovor 6
   * zabranjuje.
   */
  clearBrief(taskId: string): void
  record(event: CriticRepairEvent): void
  log(msg: string): void
}

export interface CriticRepairFacts {
  agent: string
  agentName: string
  taskId: string | null
  /** `loop.action` iz CriticGatea. */
  action: 'accept' | 'repair' | 'escalate'
  /** `loop.round` iz CriticGatea. */
  round: number
  /** `formatRepairBrief(critique)` — kvar + naredba kojom se reproducira. */
  brief: string
  /** Kratki razlog iz `verdict.reason` (ide u poruku korisniku). */
  sazetak: string
  signatures: string[]
}

export interface CriticRepairOptions {
  live: boolean
  /** `maxRounds` iz config/critic-gate.json — samo za tekst poruke i prompta. */
  maxRounds: number
}

export interface CriticRepairResult {
  verdict: RepairVerdict
  round: number
  /**
   * `true` = MI smo postavili status zadatka (pending). Pozivatelj tada NE smije pisati
   * stari `blocked` — inače bi odmah poništio vraćanje u red.
   */
  handled: boolean
  /** Poruka za korisnika (R1 kanal) ili `null`. */
  userMessage: string | null
}

/**
 * Odbijeni korak → natrag izvođaču s nalazom (ili vidljiva eskalacija čovjeku).
 *
 * Nikad ne baca: pozivatelj je izlazna putanja spawna i mora ostati na nogama.
 */
export async function returnStepForRepair(
  facts: CriticRepairFacts,
  opts: CriticRepairOptions,
  deps: CriticRepairDeps,
): Promise<CriticRepairResult> {
  const stari = (verdict: RepairVerdict, round = facts.round, userMessage: string | null = null): CriticRepairResult =>
    ({ verdict, round, handled: false, userMessage })
  const ts = () => new Date().toISOString()
  const taskId = facts.taskId ? String(facts.taskId) : null

  try {
    if (facts.action === 'accept') return stari('accept')
    if (!taskId) return stari('no-task')

    // Eskalacija ne treba stanje zadatka: ona NE mijenja put (ostaje `blocked`), samo ga
    // prestaje šutjeti. Zato ide prije mrežnog dohvata — jedan poziv manje na putanji
    // koja se ionako događa tek kad je sve već palo.
    if (facts.action === 'escalate') {
      const d = planCriticRepair({ agent: facts.agent, taskId, action: 'escalate', round: facts.round })
      deps.record({ ts: ts(), taskId, agent: facts.agent, verdict: 'escalate', round: d.round, live: opts.live, signatures: facts.signatures, reason: d.reason })
      deps.log(`  🧑‍⚖️ [vratar→čovjek] ${taskId}: ${d.reason}`)
      // Nalaz više nema adresata — sljedeći put ga ne smije pokupiti novi spawn.
      deps.clearBrief(taskId)
      return stari('escalate', d.round,
        opts.live ? escalateUserMessage(taskId, d.round, opts.maxRounds, facts.sazetak) : null)
    }

    const task = await deps.getTask(taskId)
    if (!task) {
      deps.record({ ts: ts(), taskId, agent: facts.agent, verdict: 'failed', round: facts.round, live: opts.live, signatures: facts.signatures, reason: 'zadatak nedostupan (API)' })
      deps.log(`  ⚠️ [vratar→popravak] ${taskId}: zadatak nedostupan — ide starim putem (blocked)`)
      return stari('failed')
    }

    const d = planCriticRepair({ agent: facts.agent, taskId, status: task.status, tags: task.tags, action: 'repair', round: facts.round })
    deps.record({ ts: ts(), taskId, agent: facts.agent, verdict: d.verdict, round: d.round, live: opts.live, signatures: facts.signatures, reason: d.reason })

    if (d.verdict !== 'repair') {
      deps.log(`  ⏭️ [vratar→popravak] ${taskId}: ${d.reason}`)
      return stari(d.verdict, d.round)
    }

    deps.log(`${opts.live ? '  ↩︎ [vratar→popravak]' : '  👁️ [vratar→popravak SHADOW]'} ${taskId} (${facts.agent}): ${d.reason}/${opts.maxRounds}`)
    if (!opts.live) return stari('repair', d.round)

    // REDOSLIJED JE UGOVOR: nalaz → oznaka → tek onda vraćanje u red. Zadatak vraćen u
    // `pending` BEZ nalaza pokrenuo bi isti posao s istim promptom i pao na istoj provjeri —
    // to nije evaluator-optimizer nego skupa petlja koja ništa ne uči. `reclaim` se poslije
    // ne može poništiti, pa sve što može pasti pada PRIJE njega.
    const saved = deps.saveBrief({
      taskId, round: d.round, ts: ts(), agentId: facts.agent,
      brief: facts.brief, signatures: facts.signatures,
    })
    if (!saved) {
      deps.record({ ts: ts(), taskId, agent: facts.agent, verdict: 'failed', round: d.round, live: opts.live, signatures: facts.signatures, reason: 'nalaz nije spremljen' })
      deps.log(`  ⚠️ [vratar→popravak] ${taskId}: nalaz nije spremljen — NE vraćam u red (bez nalaza je krug uzaludan)`)
      return stari('failed', d.round)
    }

    const note = `↩︎ Vratar je odbio isporuku (krug ${d.round}/${opts.maxRounds}): ${facts.sazetak}\n`
      + `Zadatak se vraća izvođaču ${facts.agentName} umjesto da ostane blokiran; nalaz ulazi u prompt sljedećeg prolaza.\n${facts.brief}`
    const tagged = await deps.setTags(taskId, withRepairTag(task.tags, d.round), note)
    if (!tagged) {
      deps.clearBrief(taskId)
      deps.record({ ts: ts(), taskId, agent: facts.agent, verdict: 'failed', round: d.round, live: opts.live, signatures: facts.signatures, reason: 'upis oznake kritika nije prošao' })
      deps.log(`  ⚠️ [vratar→popravak] ${taskId}: oznaka nije upisana — NE vraćam u red (ide starim putem)`)
      return stari('failed', d.round)
    }

    const ok = await deps.reclaim(taskId, `vratar je odbio isporuku: ${facts.sazetak} (krug ${d.round}/${opts.maxRounds})`)
    if (!ok) {
      deps.clearBrief(taskId)
      deps.record({ ts: ts(), taskId, agent: facts.agent, verdict: 'failed', round: d.round, live: opts.live, signatures: facts.signatures, reason: 'reclaim nije prošao' })
      deps.log(`  ⚠️ [vratar→popravak] ${taskId}: reclaim nije prošao — ide starim putem`)
      return stari('failed', d.round)
    }

    return {
      verdict: 'repair', round: d.round, handled: true,
      userMessage: repairUserMessage(taskId, d.round, opts.maxRounds, facts.sazetak),
    }
  } catch (e) {
    try {
      deps.record({ ts: ts(), taskId, agent: facts.agent, verdict: 'failed', round: facts.round, live: opts.live, signatures: facts.signatures, reason: String(e) })
      deps.log(`  ⚠️ [vratar→popravak] ${taskId}: ${e} — ide starim putem`)
    } catch { /* dnevnik ne smije srušiti izlaznu putanju */ }
    return stari('failed')
  }
}

/** Zadani zapisivač u JSONL (daemon ga preda kao `deps.record`). */
export function recordCriticRepair(event: CriticRepairEvent): void {
  try {
    const f = criticRepairLogFile()
    mkdirSync(dirname(f), { recursive: true })
    appendFileSync(f, JSON.stringify(event) + '\n')
  } catch { /* dnevnik nikad ne ruši izlaznu putanju */ }
}

// ============================================
// Mjerilo iz plana §3 W4
// ============================================

/** Redak iz `data/critic_gate.jsonl` — samo ono što mjerilu treba. */
export interface SudRedak {
  ts: string
  taskId: string
  status: string
  signatures?: string[]
}

export interface IshodKruga {
  taskId: string
  round: number
  /** Sud vratara koji je PRVI došao nakon vraćanja. `null` = ishoda još nema. */
  sljedeciStatus: string | null
  /** SAMO `pass`. `unverifiable`/`partial` nisu uspjeh — v. `ocijeniPetlju`. */
  prosao: boolean
  /** Je li pao na ISTOM potpisu — mjeri „popravak ne hvata uzrok". */
  istiKvar: boolean
}

export interface PetljaMjera {
  vraceno: number
  /** Drugi krug je završio sudom `pass` — jedini ishod koji dokazuje da je popravak uhvatio. */
  prosli: number
  pali: number
  /** Vraćeni koraci kojima ishod još nije poznat (zadatak nije ponovno sudjen). */
  bezIshoda: number
  /**
   * Drugi krug je sudjen, ali sudom koji ništa ne dokazuje (`unverifiable`/`partial`).
   * Izvan nazivnika: takav ishod ne govori je li petlja pomogla, samo da se prestalo mjeriti.
   */
  neizmjereni: number
  istiKvarPonovno: number
  /** prosli / (prosli + pali); `null` kad nema nijednog razriješenog kruga. */
  udio: number | null
  prag: number
  /** `true` = petlja se isplati; `false` = gasi se; `null` = uzorak još nije pun. */
  isplativo: boolean | null
  obrazlozenje: string
}

/**
 * „Udio odbijenih koraka koji prođu u drugom krugu" (plan §3 W4).
 *
 * NAZIVNIK SU SAMO RAZRIJEŠENI KRUGOVI. Vraćeni korak koji još nije ponovno sudjen nije ni
 * uspjeh ni neuspjeh, i ubrojiti ga kao pad značilo bi da mjerilo na svježem uzorku UVIJEK
 * pokazuje neisplativost — pa bi se petlja ugasila zbog vlastite mladosti, a ne zbog učinka.
 * Broji se odvojeno (`bezIshoda`) da se ta rupa vidi, umjesto da se prešuti.
 *
 * USPJEH JE SAMO `pass`. `unverifiable` i `partial` po vlastitoj definiciji u `CriticGate`
 * znače „nije bilo što provjeriti" odnosno „kritičar nije sve stigao — nije isto što i
 * prošlo". Kad bi se brojali kao uspjeh, petlja bi ispala isplativa upravo ondje gdje je
 * postala nemjerljiva, a to je najskuplja vrsta laži u ovom sustavu: 84 od 179 sudova u
 * `data/critic_gate.jsonl` (05.09.2026.) je `unverifiable`. Zato idu u `neizmjereni`, izvan
 * nazivnika, gdje se vide.
 *
 * Gleda se SAMO `live` vraćanje: u sjeni zadatak nije ni vraćen, pa „drugi krug" ne postoji.
 */
export function ocijeniPetlju(
  events: CriticRepairEvent[],
  ledger: SudRedak[],
  prag = PRAG_ISPLATIVOSTI,
): PetljaMjera {
  const poZadatku = new Map<string, SudRedak[]>()
  for (const r of ledger) {
    if (!r?.taskId) continue
    const l = poZadatku.get(r.taskId) || []
    l.push(r)
    poZadatku.set(r.taskId, l)
  }
  for (const l of poZadatku.values()) l.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))

  const ishodi: IshodKruga[] = []
  for (const e of events) {
    if (e.verdict !== 'repair' || !e.live || !e.taskId) continue
    const rows = poZadatku.get(e.taskId) || []
    // Prvi sud NAKON vraćanja je ishod tog kruga. Namjerno kronološki, a ne po broju
    // kruga: `pass` i `fail` ne dijele isti brojač na isti način, pa bi uparivanje po
    // broju kruga tiho promašilo upravo uspjehe — dakle ono što se mjeri.
    const next = rows.find((r) => String(r.ts) > String(e.ts))
    const status = next?.status ?? null
    ishodi.push({
      taskId: e.taskId,
      round: e.round,
      sljedeciStatus: status,
      prosao: status === 'pass',
      istiKvar: status === 'fail' && (next?.signatures || []).some((s) => (e.signatures || []).includes(s)),
    })
  }

  const vraceno = ishodi.length
  const bezIshoda = ishodi.filter((i) => i.sljedeciStatus === null).length
  const prosli = ishodi.filter((i) => i.prosao).length
  const pali = ishodi.filter((i) => i.sljedeciStatus === 'fail').length
  const neizmjereni = vraceno - bezIshoda - prosli - pali
  const rijeseni = prosli + pali
  const udio = rijeseni > 0 ? prosli / rijeseni : null
  const isplativo = udio === null ? null : udio >= prag
  const obrazlozenje = udio === null
    ? `nema nijednog razriješenog kruga (vraćeno ${vraceno}, bez ishoda ${bezIshoda}, neizmjereno ${neizmjereni}) — mjerilo još ne sudi`
    : isplativo
      ? `${prosli}/${rijeseni} vraćenih koraka prošlo u sljedećem krugu (${(udio * 100).toFixed(1)} % ≥ prag ${(prag * 100).toFixed(1)} %) — petlja se isplati`
      : `${prosli}/${rijeseni} vraćenih koraka prošlo (${(udio * 100).toFixed(1)} % < prag ${(prag * 100).toFixed(1)} %) — petlja se NE isplati i gasi se`

  return { vraceno, prosli, pali, bezIshoda, neizmjereni, istiKvarPonovno: ishodi.filter((i) => i.istiKvar).length, udio, prag, isplativo, obrazlozenje }
}
