/**
 * Sudac — JEDAN sastavljač poziva agenta-vratara, za oba ušća (TASK-4839).
 *
 * ŠTO JE: tanak sloj koji od (agent, razina, rok) napravi JEDAN poziv modelu i vrati
 * VRIJEDNOST. Sud NIJE zadatak, nema status, nema zatvaranje — to je cijela razlika prema
 * `spawnAgentOnDemand` (dizajn TASK-4838 §2): taj je `: void`, odgovara porukom u
 * `messages.db`, dijeli bazen od `MAX_AGENT_CONCURRENT` utora i time bi vratar postao još
 * jedan agent kojemu treba vlastiti vratar — doslovno regres iz ADR-0012.
 *
 * ZAŠTO JEDAN MODUL, A NE DVA (pouka ADR-0004): četiri stvari se moraju razići jednako ili
 * nikako — razrješenje modela, brane, sažimanje identiteta i čitanje neuspjeha. Preslika
 * pravila se razilazi; `adversarial-pozivac.ts` je i nastao zato što su dva alata imala dvije
 * preslike istog dispatcha i razišle se do toga da je jedan bacao grešku, a drugi tiho rezao
 * prefiks.
 *
 * ŠTO OVDJE NIJE: prosudba. `AdversarialVerify.ts` i `CriticGate.ts` ostaju čiste funkcije
 * bez ijednog izlaza prema van; ovdje su procesi i disk.
 *
 * TRI MJERENJA KOJA SU OBLIKOVALA OVAJ KOD (dizajn §3.4/§3.5, izmjereno 12.09.2026.):
 *   • E2a: sudac koji ALATE IMA, a nije mu rečeno da ih upotrijebi, ne dotakne ih — i plati
 *     im definicije (+0,023 USD). Zato `razina: 'alati'` UVIJEK nosi `PREDGOVOR_ALATA`.
 *   • G: `--disallowed-tools Write` radi, ali `Bash` s `echo > datoteka` prolazi. Ne postoji
 *     zastavica koja sucu ostavlja Bash, a oduzima pisanje. Zato se pisanje po dokazu ne
 *     zabranjuje nego HVATA (`snimiDokaz` prije/poslije).
 *   • H: kad `--max-budget-usd` okine, izlazni kod je 1 i polja `result` NEMA. Takav ishod je
 *     `ne-znam`, nikad sud — inače bi vlastiti kvar vratara ispao kao presuda o tuđem radu.
 *
 * Autorica: Jelena (Engineer), TASK-4839. Dizajn: Kosjenka, TASK-4838.
 */
import { createHash } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs'
import { dirname, join } from 'path'

import { buildIdentityBlock, OWN_TOOLS_SECTION_HEADING, TOOLS_SECTION_HEADING } from './IdentityBlock'
import { resolveAgentTarget, type SpawnTarget } from './models/AgentModel'
import { currentAutonomyThresholds } from './WorkStateJournal'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()
const REGISTAR_PUT = join(HOME, '.claude/regoc/REGOC_AGENTS.json')

/** Alarmi (dirnuo-dokaz) — ne presuda, nego sigurnosni trag. Presudu piše POZIVATELJ. */
export const SUDAC_ALARM_LOG = join(HOME, '.claude/regoc/data/sudac_alarm.jsonl')

/** Zadani model kad `agentOverrides` nema ništa za tog agenta. Sonnet: razlučivost 1,00 (§3.3). */
export const ZADANI_MODEL = 'sonnet'

/** Vlastiti strop usporednosti. NAMJERNO 1 — bazen spawn utora se ne posuđuje (§2.1 t.3). */
export const MAKS_USPOREDNIH = 1

export type RazinaSuca = 'tekst' | 'alati'

export type GreskaSuca = 'rok' | 'proracun' | 'brana-pauza' | 'brana-strop' | 'dirnuo-dokaz' | 'pad' | null

/**
 * Nalog bez kojeg alati ostanu neupotrijebljeni (E2a). Tekst je onaj koji je u pokusu E2b
 * izmjeren kao djelotvoran: sudac je pokrenuo `grep` iz dokaza i našao da dokaz laže.
 */
export const PREDGOVOR_ALATA =
  'IMAŠ ALATE (Bash, Read, Grep) I DUŽAN SI IH UPOTRIJEBITI. Prije nego presudiš, POKRENI '
  + 'naredbu iz dokaza (ili ekvivalentnu) i PROČITAJ datoteku na koju se navod poziva. Sudi po '
  + 'onome što si IZMJERIO, ne po onome što ti tekst tvrdi. U obrazloženju navedi naredbu koju '
  + 'si pokrenuo i njezin stvarni izlaz. NE MIJENJAJ NIJEDNU DATOTEKU — svaka izmjena dokaza '
  + 'poništava tvoj glas.'

export interface Upit {
  prompt: string
  /** Trag u zapisu troška (leća + nalaz, ili ime dokumenta). */
  oznaka: string
  rokMs: number
}

export interface Odgovor {
  tekst: string
  /** Stvarno upotrijebljen spec (`anthropic:sonnet`), za trag. */
  model: string
  cijenaUsd: number | null
  latencyMs: number
  okreta: number | null
  /** Kad je postavljeno, `tekst` NIJE sud nego objašnjenje zašto ga nema. */
  greska: GreskaSuca
}

export interface TrosakSuca {
  oznaka: string
  model: string
  razina: RazinaSuca
  cijenaUsd: number | null
  latencyMs: number
  okreta: number | null
  greska: GreskaSuca
  /** Popunjeno kad je razina spuštena s `alati` na `tekst` — nikad tiho (§4.2). */
  silazak?: string
}

/** Snimka potrošnje — isti oblik kao `SpawnTelemetry.readSessionUsage`. */
export interface PotrosnjaLike {
  sessionPercent: number | null
  weeklyPercent?: number | null
  status?: string | null
  httpError?: string | null
  stale: boolean
  ageMs: number
}

export interface PozivArgumenti {
  model: string
  /** Ide na `--append-system-prompt`; identitet je sistemski kanal, ne korisnički tekst. */
  sistemski: string
  prompt: string
  rokMs: number
  alati: boolean
  proracunUsd: number | null
  cwd: string
}

export interface SiroviOdgovor {
  rc: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface SudacDogadjaj {
  vrsta: 'dirnuo-dokaz'
  agentId: string
  oznaka: string
  model: string
  putovi: string[]
  ts: string
}

export interface SudacDeps {
  pozovi?: (a: PozivArgumenti) => Promise<SiroviOdgovor>
  pauzirano?: () => boolean
  potrosnja?: () => PotrosnjaLike | null
  identitet?: (agentId: string) => string
  razrijesi?: (agentId: string, fallback: string) => SpawnTarget
  sada?: () => number
  dnevnik?: (d: SudacDogadjaj) => void
}

export interface SudacSpec {
  /** Ključ u `agentOverrides` i u `REGOC_AGENTS.json`. */
  agentId: string
  razina: RazinaSuca
  rokMs: number
  /** → `--max-budget-usd`. OSIGURAČ, ne proračun: probio je granicu 1,7× (§3.5 H). */
  proracunUsd?: number
  /** Korijen za alate; zadano `~/.claude/regoc`. */
  cwd?: string
  /** Datoteke/mape koje sudac SMIJE čitati, a ne smije mijenjati (§7.3). */
  korijeniDokaza?: string[]
  deps?: SudacDeps
}

export interface Sudac {
  pitaj(u: Upit): Promise<Odgovor>
  trosak: TrosakSuca[]
  ukupnoUsd(): number
}

// ─── Identitet: sažimanje, ne grananje (§6.2) ────────────────────────────────

/**
 * Odsjeci koje sudac NE treba. `buildIdentityBlock` ostaje netaknut (jedan izvor istine,
 * ADR-0004 O1) — ovdje je samo filtar nad gotovim blokom.
 *
 * Mjereno na Maliku: od 2267 znakova bloka ~1470 je katalog alata namijenjen agentu koji
 * PIŠE NOVU SKRIPTU, a sudac ne piše skripte. Uz „Tvoje znanje" (tri putanje koje sucu s
 * alatima nude da potroši okrete na čitanje RedTeam dokumentacije) to je 64 % mrtva tereta.
 */
const ODSJECI_VAN = [
  TOOLS_SECTION_HEADING,
  OWN_TOOLS_SECTION_HEADING,
  '### Tvoji skillovi',
  '### Tvoje znanje',
  '### Tvoja RAG memorija',
  '### Tvoj kontekst',
] as const

/**
 * Ostavi ime, ulogu, opis i komunikacijski stil; izbaci sve odsjeke iz `ODSJECI_VAN`.
 * Filtar je strojan (naslovi su izvezene konstante), ne pogađanje po tekstu.
 */
export function sazmiZaSudca(blok: string): string {
  if (!blok) return ''
  const redci = blok.split('\n')
  const van: string[] = []
  let preskacem = false
  for (const r of redci) {
    if (r.startsWith('### ') || r.startsWith('## ')) {
      preskacem = r.startsWith('### ') && ODSJECI_VAN.some((h) => r.startsWith(h))
    }
    if (!preskacem) van.push(r)
  }
  return van.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function ucitajRegistar(): unknown {
  try { return JSON.parse(readFileSync(REGISTAR_PUT, 'utf-8')) } catch { return null }
}

/** Blok identiteta bez odsjeka koji sucu ne pripadaju. Greška u registru ne ruši poziv. */
function zadaniIdentitet(agentId: string): string {
  try {
    const reg = ucitajRegistar() as any
    // Bez `ragCollections`: sudac nema RAG upis ni RAG memoriju — on vraća sud pozivatelju.
    return sazmiZaSudca(buildIdentityBlock(agentId, reg, { home: HOME }))
  } catch { return '' }
}

// ─── Dokaz: zabrana se ne pokušava, hvata se (§7.3) ──────────────────────────

/** Iznad ovoga se ne hashira sadržaj — `mtime:veličina` je i dalje dovoljan trag izmjene. */
const MAKS_HASH_BAJTOVA = 8 * 1024 * 1024
const MAKS_DATOTEKA_DOKAZA = 400
const MAKS_DUBINA_DOKAZA = 4

function otisak(put: string): string {
  try {
    const st = statSync(put)
    if (st.size > MAKS_HASH_BAJTOVA) return `big:${st.mtimeMs}:${st.size}`
    const h = createHash('sha256').update(readFileSync(put)).digest('hex')
    return `${st.mtimeMs}:${st.size}:${h}`
  } catch {
    return 'NEMA'   // brisanje je izmjena kao i svaka druga
  }
}

/**
 * `(mtime, veličina, sha256)` za svaku dokaznu putanju. Mapa se uspoređuje prije i poslije
 * poziva; svaka razlika znači da je sudac pisao ondje gdje nije smio.
 */
export function snimiDokaz(putovi: string[] | undefined | null): Map<string, string> {
  const m = new Map<string, string>()
  const obidji = (p: string, dubina: number): void => {
    if (m.size >= MAKS_DATOTEKA_DOKAZA) return
    let st: ReturnType<typeof statSync>
    try { st = statSync(p) } catch { m.set(p, 'NEMA'); return }
    if (st.isDirectory()) {
      if (dubina > MAKS_DUBINA_DOKAZA) return
      let djeca: string[]
      try { djeca = readdirSync(p) } catch { return }
      for (const d of djeca) obidji(join(p, d), dubina + 1)
      return
    }
    m.set(p, otisak(p))
  }
  for (const p of putovi || []) obidji(p, 0)
  return m
}

function razlikaDokaza(prije: Map<string, string>, poslije: Map<string, string>): string[] {
  const van: string[] = []
  for (const [p, v] of prije) if (poslije.get(p) !== v) van.push(p)
  for (const p of poslije.keys()) if (!prije.has(p)) van.push(p)
  return van
}

function zapisiAlarm(d: SudacDogadjaj): void {
  try {
    mkdirSync(dirname(SUDAC_ALARM_LOG), { recursive: true })
    appendFileSync(SUDAC_ALARM_LOG, JSON.stringify(d) + '\n', 'utf-8')
  } catch { /* alarm koji se ne da zapisati ne smije srušiti sud */ }
}

// ─── Poziv CLI-ju ────────────────────────────────────────────────────────────

/**
 * `claude --print` s vlastitim argumentima. NE ide kroz `AnthropicProvider` jer taj na
 * izlazni kod ≠ 0 BACA — a pokus H pokazuje da je rc=1 bez polja `result` normalan ishod
 * osigurača proračuna koji se mora pročitati kao `ne-znam`, ne kao iznimka.
 */
const zadaniPoziv = (a: PozivArgumenti): Promise<SiroviOdgovor> => new Promise((resolve) => {
  const { spawn } = require('child_process') as typeof import('child_process')
  const args = ['--print', '--model', a.model]
  if (a.sistemski) args.push('--append-system-prompt', a.sistemski)
  if (a.alati) {
    // `--allowed-tools` NIJE ograničenje nego popis za samoodobravanje (pokus F) — zato ga
    // ovdje nema. `--disallowed-tools` radi za imenovane alate; Bash i dalje može pisati,
    // pa je prava brana `snimiDokaz` prije/poslije, a ovo je samo prvi pojas.
    args.push('--dangerously-skip-permissions', '--disallowed-tools', 'Write', 'Edit', 'NotebookEdit')
  } else {
    args.push('--restricted')
  }
  if (a.proracunUsd && Number.isFinite(a.proracunUsd)) args.push('--max-budget-usd', String(a.proracunUsd))
  args.push('--output-format', 'json', '-p', a.prompt)

  const proc = spawn('claude', args, {
    cwd: a.cwd,
    env: {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME, USER: process.env.USER || 'klaudio',
      SHELL: process.env.SHELL || '/bin/bash', TERM: 'xterm-256color',
      BUN_INSTALL: process.env.BUN_INSTALL || `${HOME}/.bun`,
    },
  })
  let stdout = '', stderr = '', timedOut = false
  proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
  proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
  const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL') } catch {} }, a.rokMs)
  proc.on('close', (rc: number | null) => {
    clearTimeout(timer)
    resolve({ rc: timedOut ? null : rc, stdout, stderr, timedOut })
  })
  proc.on('error', (e: Error) => {
    clearTimeout(timer)
    resolve({ rc: null, stdout: '', stderr: String(e?.message || e), timedOut: false })
  })
})

/** Trag da je osigurač proračuna okinuo, i onda kad omotnice nema. */
const TRAG_PRORACUNA = /max[- ]budget|budget (exceeded|limit)|proračun/i

interface Raspakirano {
  tekst: string
  cijenaUsd: number | null
  okreta: number | null
  greska: GreskaSuca
}

/**
 * Omotnica `--output-format json` → sud ili objašnjenje zašto ga nema.
 *
 * JEDNO PRAVILO (§7.4): svaki ishod bez raščlanjiva suda znači `ne-znam`, nikad „stoji" i
 * nikad „obori". Vratar koji zbog vlastita kvara blokira tuđi rad gori je od onoga koji šuti.
 */
export function raspakirajOdgovor(r: SiroviOdgovor): Raspakirano {
  if (r.timedOut) return { tekst: 'sudac nije odgovorio u roku', cijenaUsd: null, okreta: null, greska: 'rok' }

  let o: any = null
  try { o = JSON.parse(r.stdout.trim()) } catch { /* nije omotnica */ }
  const cijena = o && Number.isFinite(Number(o.total_cost_usd)) ? Number(o.total_cost_usd) : null
  const okreta = o && Number.isFinite(Number(o.num_turns)) ? Number(o.num_turns) : null

  if (o && typeof o.result === 'string' && o.result.trim()) {
    return { tekst: o.result, cijenaUsd: cijena, okreta, greska: null }
  }
  if (o) {
    // Omotnica postoji, suda u njoj nema. Pokus H: točno tako izgleda okinut osigurač.
    const proracun = r.rc !== 0 || TRAG_PRORACUNA.test(`${o.subtype || ''} ${o.stop_reason || ''} ${r.stderr}`)
    return {
      tekst: `sudac nije vratio sud (rc=${r.rc}, stop_reason=${o.stop_reason ?? '?'}, subtype=${o.subtype ?? '?'})`,
      cijenaUsd: cijena, okreta, greska: proracun ? 'proracun' : 'pad',
    }
  }
  if (r.rc === 0 && r.stdout.trim()) {
    // Bez omotnice, ali s tekstom: sud se ne baca. Cijena je NEPOZNATA (null), nikad nula —
    // nula bi u zbroju izgledala kao besplatan poziv.
    return { tekst: r.stdout.trim(), cijenaUsd: null, okreta: null, greska: null }
  }
  return {
    tekst: `sudac je pao (rc=${r.rc}): ${(r.stderr || r.stdout || 'bez izlaza').slice(0, 300)}`,
    cijenaUsd: cijena, okreta: null,
    greska: TRAG_PRORACUNA.test(r.stderr) ? 'proracun' : 'pad',
  }
}

// ─── Brane koje se posuđuju od spawn puta (§2.1) ─────────────────────────────

/**
 * Tjedni strop — ZADANO; uživo vrijedi isti broj kao u vratima autonomije
 * (`currentAutonomyThresholds().weeklyBlock`, postavka TaskManagera — TASK-5028).
 */
export const TJEDNI_STROP_POSTO = 90

/** Zaustavlja li potrošnja sudca? Sesijski prag NE zaustavlja — sudac ne vuče posao iz reda. */
export function branaPotrosnje(p: PotrosnjaLike | null | undefined): string | null {
  if (!p) return null   // nema snimke → sudac ne odlučuje o autonomiji, samo o jednom sudu
  if (p.status === 'rejected' || /\b429\b/.test(p.httpError || '')) {
    return `kvota je odbila zahtjev (${p.httpError || p.status})`
  }
  const w = p.weeklyPercent
  const strop = currentAutonomyThresholds().weeklyBlock
  if (typeof w === 'number' && Number.isFinite(w) && w >= strop) {
    return `tjedan ${w} % ≥ ${strop} % — sudac troši isti račun`
  }
  return null
}

function zadanaPauza(): boolean {
  try { return require('./PauseControl').isGloballyPaused() } catch { return false }
}

function zadanaPotrosnja(): PotrosnjaLike | null {
  try { return require('./SpawnTelemetry').readSessionUsage() } catch { return null }
}

// ─── Sastavljač ──────────────────────────────────────────────────────────────

export function napraviSuca(spec: SudacSpec): Sudac {
  const d = spec.deps || {}
  const sada = d.sada || (() => Date.now())
  const pozovi = d.pozovi || zadaniPoziv
  const pauzirano = d.pauzirano || zadanaPauza
  const potrosnja = d.potrosnja || zadanaPotrosnja
  const identitet = d.identitet || zadaniIdentitet
  const razrijesi = d.razrijesi || ((id: string, f: string) => resolveAgentTarget(id, f))
  const dnevnik = d.dnevnik || zapisiAlarm
  const cwd = spec.cwd || join(HOME, '.claude/regoc')
  const trosak: TrosakSuca[] = []

  // Vlastiti red. Strop je 1 i to je namjera: bazen spawn utora se NE posuđuje, jer bi
  // vratar čekao utor koji drže spawnovi koje još nije sudio (tihi zastoj, §2.1 t.3).
  let red: Promise<unknown> = Promise.resolve()
  const uRedu = <T,>(fn: () => Promise<T>): Promise<T> => {
    const p = red.then(fn, fn)
    red = p.catch(() => {})
    return p
  }

  const pitaj = (u: Upit): Promise<Odgovor> => uRedu(async () => {
    const t0 = sada()
    const cilj = razrijesi(spec.agentId, ZADANI_MODEL)
    const modelSpec = `${cilj.provider}${cilj.node ? '@' + cilj.node : ''}:${cilj.model}`

    // Spec koji nije Anthropic nema `claude --print`, dakle nema alata. Silazak se ZAPISUJE:
    // inače bi prebacivanje na `ollama:` izgledalo kao ušteda, a bilo bi vraćanje na panel
    // razlučivosti −0,11 (gore od novčića).
    const anthropic = cilj.provider === 'anthropic'
    const razina: RazinaSuca = spec.razina === 'alati' && !anthropic ? 'tekst' : spec.razina
    const silazak = razina !== spec.razina
      ? `provider „${cilj.provider}" nema claude --print — razina spuštena s alati na tekst`
      : undefined

    const zabiljezi = (o: Odgovor): Odgovor => {
      trosak.push({
        oznaka: u.oznaka, model: o.model, razina, cijenaUsd: o.cijenaUsd,
        latencyMs: o.latencyMs, okreta: o.okreta, greska: o.greska, ...(silazak ? { silazak } : {}),
      })
      return o
    }
    const bez = (greska: GreskaSuca, tekst: string): Odgovor =>
      zabiljezi({ tekst, model: modelSpec, cijenaUsd: null, latencyMs: sada() - t0, okreta: null, greska })

    // ── Brane PRIJE poziva. Goranova „⏸ Pauza" mora zaustaviti i sudca.
    try {
      if (pauzirano()) return bez('brana-pauza', 'ručna kočnica je podignuta — sudac se ne zove')
    } catch { /* pokvarena datoteka stanja znači „nije pauzirano", nikad „zauvijek pauzirano" */ }
    let snap: PotrosnjaLike | null = null
    try { snap = potrosnja() } catch { snap = null }
    const stop = branaPotrosnje(snap)
    if (stop) return bez('brana-strop', `${stop} — nalaz/dokument ostaje NEPROVJEREN, nikad „prošao"`)

    const prije = snimiDokaz(spec.korijeniDokaza)
    const prompt = razina === 'alati' ? `${PREDGOVOR_ALATA}\n\n${u.prompt}` : u.prompt
    const rok = Math.max(5_000, Math.min(u.rokMs || spec.rokMs, spec.rokMs))

    let sirovo: SiroviOdgovor
    try {
      sirovo = await pozovi({
        model: cilj.model, sistemski: identitet(spec.agentId), prompt, rokMs: rok,
        alati: razina === 'alati', proracunUsd: spec.proracunUsd ?? null, cwd,
      })
    } catch (e: any) {
      return bez('pad', `poziv sudcu je pukao: ${String(e?.message || e).slice(0, 300)}`)
    }

    const r = raspakirajOdgovor(sirovo)
    const odgovor: Odgovor = {
      tekst: r.tekst, model: modelSpec, cijenaUsd: r.cijenaUsd,
      latencyMs: sada() - t0, okreta: r.okreta, greska: r.greska,
    }

    // ── Brana POSLIJE poziva: je li sudac dirao dokaz o kojem sudi?
    const dirnuto = razlikaDokaza(prije, snimiDokaz(spec.korijeniDokaza))
    if (dirnuto.length) {
      const dog: SudacDogadjaj = {
        vrsta: 'dirnuo-dokaz', agentId: spec.agentId, oznaka: u.oznaka,
        model: modelSpec, putovi: dirnuto, ts: new Date().toISOString(),
      }
      try { dnevnik(dog) } catch { /* alarm ne smije srušiti sud */ }
      return zabiljezi({
        ...odgovor, greska: 'dirnuo-dokaz',
        tekst: `sudac je izmijenio dokaz o kojem sudi — glas se poništava. Dirnuto: ${dirnuto.join(', ')}`,
      })
    }
    return zabiljezi(odgovor)
  })

  return {
    pitaj,
    trosak,
    ukupnoUsd: () => trosak.reduce((a, t) => a + (t.cijenaUsd ?? 0), 0),
  }
}
