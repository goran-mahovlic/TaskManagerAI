/**
 * WorkflowGate — prekidač za tijekove rada, tri razine (W0 / TASK-4620).
 *
 * NALOG (Goran, 04.09.2026., doslovno): „Dodao bih prekidač da radi ili ne radi preko tog
 * novog sustava, čisto da imamo mogućnost testa." Razrada:
 * `PLAN-workflow-integracija.md` (repozitorij sustava, nije u paketu) §6.1. Ovo je PRVI korak integracije tijekova — prije njega
 * se ne smije ukopčati ništa drugo, jer bi se ukopčalo bez ručke za gašenje.
 *
 * TRI RAZINE, OVIM REDOM SNAGE (jača gasi slabiju):
 *   1. PO ZADATKU — oznaka `bez-workflowa` UVIJEK pobjeđuje. I izričitu oznaku
 *      `workflow:<id>`, i okidače, i način `on`. To je Goranova kočnica za pojedini
 *      zadatak i ne smije je nadglasati ništa u konfiguraciji.
 *   2. PO TIJEKU — polje `enabled` u `agents/workflows.json`. `false` znači „kao da tijeka
 *      nema": ne bira ga ni okidač ni izričita oznaka.
 *   3. GLOBALNO — `config/workflow-gate.json` → `nacin`: `off` | `shadow` | `on`.
 *
 * ZAŠTO JE ZADANO `shadow`: isti obrazac kao `taskDecompose`, `criticGate` i ulazna vrata —
 * prvo mjeri, pa uključi. U sjeni se odluka izračuna i zapiše u `data/workflow_odluke.jsonl`,
 * a NIŠTA se ne materijalizira: novi put se uspoređuje sa starim na istom prometu, bez
 * ijednog spawna. `off` znači da se ni ne računa (ni retka u dnevniku).
 *
 * ŠTO OVAJ MODUL NAMJERNO NE RADI: ne pokreće procese, ne dira ploču, ne mijenja put
 * zadatka. Nema uvoza `child_process`, `Bun.spawn` ni mreže — „nula spawnova u sjeni" nije
 * obećanje nego svojstvo koda, i test `workflow-gate.test.ts` ga drži nad izvorom.
 *
 * POŠTENJE OKO NAČINA `on`: `on` znači „odluka smije imati učinak" i postavlja
 * `materijalizirati: true`. Sam učinak rade POZIVATELJI preko zatvarača — `primijeniOznaku`
 * (W1: oznaka na zadatku) i `materijaliziraj` (W2/TASK-4616: lanac zadataka, iza VLASTITOG
 * prekidača `materijalizacija` u istoj konfiguraciji). Polja `oznakaUpisana` i
 * `materijalizirano` zapisuju ono što je pozivatelj STVARNO napravio — vrata ne smiju
 * tvrditi da je nešto izvedeno. Bez zatvarača se ponaša bajt-identično sjeni.
 *
 * ODLUKA JE DETERMINISTIČKA — bez modela. Isti razlog kao u `tools/odaberi_workflow.py`:
 * LLM na ovom mjestu je kod nas već jednom promašio 92 % prometa (v. `regoc-modeclassify-e1-gate`).
 *
 * DVIJE PRESLIKE ISTOG PRAVILA: logika postoji i u `tools/odaberi_workflow.py` (CLI za ljude).
 * Da se ne raziđu (ADR-0004), `tests/workflow-gate-parity.test.ts` pušta iste ulaze kroz oba
 * puta i uspoređuje odluku.
 *
 * Autorica: Jelena (Engineer), TASK-4620.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'

import { isTestRuntime, realHomedir } from './LiveDbGuard'
import { parseWeightTag } from './WeightScore'
import { konfigPutanja, PAKET_DIR, stanjePutanja } from './paths'

/**
 * Inačica zapisa — izvještaj mora znati po kojim je pravilima redak nastao.
 * 2 (W1/TASK-4614): redak je dobio `oznaka` (koja bi se oznaka upisala) i `oznakaUpisana`
 * (je li stvarno upisana). Mjerilo mora razlikovati prijedlog od učinka, pa se stari
 * retci inačice 1 u izvještaju broje samo ondje gdje ta dva polja nisu potrebna.
 * 3 (W2/TASK-4616): `materijalizirano` više nije tvrdo `false` nego stvarni ishod, a uz
 * njega ide `lanac` — ID-evi koraka koji su nastali. Bez tog popisa se iz dnevnika ne bi
 * moglo provjeriti je li tijek dao posao ili samo oznaku.
 */
export const ODLUKE_VERZIJA = 3

/** Oznaka na zadatku koja gasi tijek bez obzira na sve ostalo (razina 1). */
export const BEZ_WORKFLOWA_OZNAKA = 'bez-workflowa'

/** Prefiks izričite oznake tijeka: `workflow:bug-fix`. */
export const OZNAKA_PREFIKS = 'workflow:'

const HOME = process.env.HOME || homedir()

export const WORKFLOW_GATE_CONFIG_PATH =
  process.env.REGOC_WORKFLOW_GATE_CONFIG || konfigPutanja('workflow-gate.json')

export const WORKFLOWS_KATALOG_PATH =
  process.env.REGOC_WORKFLOWS_KATALOG || join(PAKET_DIR, 'agents', 'workflows.json')

export const WORKFLOW_ODLUKE_LOG_PATH =
  process.env.REGOC_WORKFLOW_ODLUKE_LOG || stanjePutanja('workflow_odluke.jsonl')

/** Koliko znakova naslova ide u zapis — dnevnik nije preslika ploče. */
export const ISJECAK_NASLOVA = 160

// ─── Konfiguracija (razina 3) ────────────────────────────────────────────────

export type WorkflowNacin = 'off' | 'shadow' | 'on'

export const NACINI: readonly WorkflowNacin[] = ['off', 'shadow', 'on'] as const

export interface WorkflowGateConfig {
  nacin: WorkflowNacin
  /** Odakle je pročitana — ide u dnevnik da se odluka može vezati uz postavke. */
  izvor: string
}

export const DEFAULT_WORKFLOW_GATE_CONFIG: WorkflowGateConfig = {
  nacin: 'shadow',   // nalog §6.1: „Zadano je shadow"
  izvor: '(zadano)',
}

interface Otisak { mtimeMs: number; velicina: number }
interface KesUnos<T> { vrijednost: T; put: string; ucitanoU: number; otisak: Otisak }

/**
 * Keš s provjerom vremena izmjene. TTL sam (kao kod `CompletionGuard`/`ResearchRagGate`)
 * značio bi do 30 s kašnjenja pri prebacivanju načina; kriterij W0 traži prebacivanje
 * BEZ ponovnog pokretanja, pa se uz TTL gleda i `mtime` — jedan `stat` po zadatku je
 * ništa naspram toga da Goran pomakne prekidač i ne vidi učinak.
 */
const KES_TTL_MS = 30_000

function otisakOf(put: string): Otisak {
  try { const st = statSync(put); return { mtimeMs: st.mtimeMs, velicina: st.size } }
  catch { return { mtimeMs: -1, velicina: -1 } }
}

/**
 * Keš vrijedi samo ako je isti put, ista datoteka na disku (vrijeme izmjene I veličina)
 * i ako TTL nije istekao. Veličina je uz `mtime` jer dva upisa unutar iste milisekunde
 * (test, ali i skripta koja pomiče prekidač) inače izgledaju kao ista datoteka.
 */
function svjez<T>(kes: KesUnos<T> | null, put: string): boolean {
  if (!kes || kes.put !== put) return false
  if (Date.now() - kes.ucitanoU >= KES_TTL_MS) return false
  const o = otisakOf(put)
  return o.mtimeMs === kes.otisak.mtimeMs && o.velicina === kes.otisak.velicina
}

let _cfg: KesUnos<WorkflowGateConfig> | null = null

export interface UcitajOpcije { configPath?: string; katalogPath?: string; force?: boolean }

/** Način iz konfiguracije. Nedostajuća/neispravna datoteka → `shadow`, nikad `on`. */
export function loadWorkflowGateConfig(o: UcitajOpcije = {}): WorkflowGateConfig {
  const put = o.configPath || WORKFLOW_GATE_CONFIG_PATH
  if (!o.force && svjez(_cfg, put)) return _cfg!.vrijednost

  const cfg: WorkflowGateConfig = { ...DEFAULT_WORKFLOW_GATE_CONFIG, izvor: put }
  try {
    if (existsSync(put)) {
      const sirovo = JSON.parse(readFileSync(put, 'utf-8'))
      const n = String(sirovo?.nacin ?? '').trim().toLowerCase()
      if ((NACINI as readonly string[]).includes(n)) cfg.nacin = n as WorkflowNacin
    }
  } catch { /* neispravan JSON → shadow; prekidač nikad ne ruši pozivatelja */ }

  _cfg = { vrijednost: cfg, put, ucitanoU: Date.now(), otisak: otisakOf(put) }
  return cfg
}

// ─── Katalog tijekova (razina 2) ─────────────────────────────────────────────

export interface Korak {
  agent: string
  uloga?: string
  vjestina?: string
  opis?: string
  treba?: string[]
  zamjena?: string
}

export interface Tijek {
  id?: string
  naziv?: string
  opis?: string
  najmanja_tezina?: number
  okidaci?: string[]
  koraci?: Korak[]
  /** Razina 2 prekidača. Nedostaje → smatra se uključenim (katalog ga već nosi svugdje). */
  enabled?: boolean
}

export interface Katalog {
  _meta?: Record<string, unknown>
  workflows: Record<string, Tijek>
}

const PRAZAN_KATALOG: Katalog = { workflows: {} }

let _katalog: KesUnos<Katalog | null> | null = null

/** Katalog s diska; `null` kad datoteke nema ili je neispravna (pozivatelj tada odustaje). */
export function loadWorkflowKatalog(o: UcitajOpcije = {}): Katalog {
  const k = ucitajKatalogIliNull(o)
  return k || PRAZAN_KATALOG
}

function ucitajKatalogIliNull(o: UcitajOpcije = {}): Katalog | null {
  const put = o.katalogPath || WORKFLOWS_KATALOG_PATH
  if (!o.force && svjez(_katalog, put)) return _katalog!.vrijednost

  let katalog: Katalog | null = null
  try {
    if (existsSync(put)) {
      const sirovo = JSON.parse(readFileSync(put, 'utf-8'))
      if (sirovo && typeof sirovo === 'object' && sirovo.workflows && typeof sirovo.workflows === 'object') {
        katalog = sirovo as Katalog
      }
    }
  } catch { /* neispravan katalog → null → zadatak ide starim putem */ }

  _katalog = { vrijednost: katalog, put, ucitanoU: Date.now(), otisak: otisakOf(put) }
  return katalog
}

/** Je li tijek uključen (razina 2). Nedostajuće polje = uključen. */
export function tijekUkljucen(t?: Tijek | null): boolean {
  return !!t && t.enabled !== false
}

// ─── Procjena težine ─────────────────────────────────────────────────────────

/**
 * Ista ljestvica i isti bodovi kao `tools/odaberi_workflow.py::procijeni_tezinu`.
 * Namjerno oprezna: bez dokaza da je posao velik ostaje nisko, jer je krivo pokrenut
 * tijek skuplji od propuštenog.
 */
const GLAGOLI_RADA =
  /\b(implementiraj|napravi|izradi|popravi|prepravi|dodaj|istraž|prouči|analiziraj|provjeri|testiraj|uskladi|prenesi|postavi)\w*/gi

export function procijeniTezinu(tekst: string): number {
  const t = String(tekst || '').trim()
  let bodovi = 10
  if (t.length > 120) bodovi += 10
  if (t.length > 400) bodovi += 10
  const glagoli = new Set<string>()
  for (const m of t.matchAll(GLAGOLI_RADA)) glagoli.add(m[0].toLowerCase())
  bodovi += Math.min(20, 5 * glagoli.size)
  if (/\n\s*[-*\d]/.test(t)) bodovi += 10
  if (/\b\d+\s*(dana|tjedn|mjesec)/i.test(t)) bodovi += 15
  return Math.max(1, Math.min(100, bodovi))
}

// ─── Odluka ──────────────────────────────────────────────────────────────────

/** Ulaz na kojem je odluka nastala. Nalog W1: „POST /api/tasks I ulazni kanal". */
export type IzvorOdluke = 'create' | 'ulaz' | 'replay' | 'cli'


export type OdlukaKod =
  | 'bez-workflowa'      // razina 1: oznaka na zadatku
  | 'oznaka'             // izričita oznaka workflow:<id>
  | 'oznaka-nepoznat'    // oznaka traži tijek kojeg u katalogu nema
  | 'oznaka-ugasen'      // oznaka traži tijek s enabled=false
  | 'okidac'             // okidač iz kataloga + težina iznad praga
  | 'prelagan'           // okidač pogađa, ali je posao ispod `najmanja_tezina`
  | 'ugasen'             // pogađali su samo ugašeni tijekovi
  | 'nema-okidaca'       // nijedan uzorak ne odgovara
  | 'nema-kataloga'      // katalog nedostupan/neispravan

export type TezinaIzvor = 'zadana' | 'oznaka' | 'procjena'

export interface OdlukaUlaz {
  taskId?: string | null
  naslov: string
  opis?: string | null
  tezina?: number | null
  oznake?: string[] | null
  projectId?: string | null
  assignee?: string | null
  /**
   * `create` = ploča (POST /api/tasks), `ulaz` = ulazni kanal (Telegram most, prije nego
   * zadatak uopće postoji), `replay` = ponovni prolaz kroz stari promet, `cli` = ručno.
   * Nalog W1 traži OBA živa ulaza; polje ih razlikuje da se ne zbroje kao jedan promet.
   */
  izvor?: IzvorOdluke
}

export interface WorkflowOdluka {
  workflow: string | null
  kod: OdlukaKod
  razlog: string
  tezina: number
  tezinaIzvor: TezinaIzvor
  koraci: Korak[]
  /** Smije li se odluka stvarno izvesti. `true` samo u načinu `on` i uz odabran tijek. */
  materijalizirati: boolean
}

function oznakeNorm(oznake?: string[] | null): string[] {
  return (oznake || []).map(o => String(o).trim().toLowerCase()).filter(Boolean)
}

function tezinaZa(ulaz: OdlukaUlaz): { tezina: number; izvor: TezinaIzvor } {
  if (typeof ulaz.tezina === 'number' && Number.isFinite(ulaz.tezina)) {
    return { tezina: Math.max(1, Math.min(100, Math.round(ulaz.tezina))), izvor: 'zadana' }
  }
  const izOznake = parseWeightTag(ulaz.oznake)
  if (izOznake !== null) return { tezina: izOznake, izvor: 'oznaka' }
  return { tezina: procijeniTezinu(`${ulaz.naslov || ''}\n${ulaz.opis || ''}`), izvor: 'procjena' }
}

/**
 * ČISTA funkcija: ide li zadatak po tijeku i po kojem. Ne čita konfiguraciju, ne piše ništa.
 * Način rada se primjenjuje iznad nje (`odluciZaZadatak`) — tako se ista odluka može
 * izračunati u sjeni, u pogonu i u ponovnom prolazu kroz stari promet.
 */
export function odaberiTijek(ulaz: OdlukaUlaz, katalog: Katalog): WorkflowOdluka {
  const { tezina, izvor: tezinaIzvor } = tezinaZa(ulaz)
  const osnova = { tezina, tezinaIzvor, koraci: [] as Korak[], materijalizirati: false }
  const oznake = oznakeNorm(ulaz.oznake)
  const tijekovi = katalog?.workflows || {}

  // Razina 1 — kočnica na zadatku. PRVA, jer „uvijek pobjeđuje" (nalog §6.1).
  // Namjerno prije izričite oznake `workflow:<id>`: ako zadatak nosi obje, pobjeđuje ona
  // koja GASI. Zaustavljanje je uvijek jeftinije od krivo pokrenutog tijeka.
  if (oznake.includes(BEZ_WORKFLOWA_OZNAKA)) {
    return { ...osnova, workflow: null, kod: 'bez-workflowa', razlog: `oznaka \`${BEZ_WORKFLOWA_OZNAKA}\` na zadatku` }
  }

  if (!katalog || Object.keys(tijekovi).length === 0) {
    return { ...osnova, workflow: null, kod: 'nema-kataloga', razlog: 'katalog tijekova nedostupan ili prazan' }
  }

  // Izričita oznaka `workflow:<id>` — preskače prag težine (čovjek je već odlučio), ali NE
  // preskače razinu 2: ugašen tijek se ne pokreće ni na zahtjev.
  for (const o of oznake) {
    if (!o.startsWith(OZNAKA_PREFIKS)) continue
    const wid = o.slice(OZNAKA_PREFIKS.length).trim()
    const t = tijekovi[wid]
    if (!t) {
      return { ...osnova, workflow: null, kod: 'oznaka-nepoznat', razlog: `oznaka traži nepoznat tijek „${wid}"` }
    }
    if (!tijekUkljucen(t)) {
      return { ...osnova, workflow: null, kod: 'oznaka-ugasen', razlog: `tijek „${wid}" je ugašen (enabled=false)` }
    }
    return {
      ...osnova, workflow: wid, kod: 'oznaka',
      razlog: 'izričita oznaka na zadatku', koraci: t.koraci || [],
    }
  }

  // Okidači iz kataloga. Ugašen tijek se preskače kao da ga nema, ali se PAMTI — inače bi
  // razlog „nijedan okidač ne odgovara" krio to da je tijek zapravo ručno isključen.
  const tekst = `${ulaz.naslov || ''}\n${ulaz.opis || ''}`.trim()
  const preskoceni: string[] = []
  for (const [wid, t] of Object.entries(tijekovi)) {
    for (const uzorak of t.okidaci || []) {
      let pogodak = false
      try { pogodak = new RegExp(uzorak, 'i').test(tekst) } catch { continue }  // loš uzorak ne ruši vrata
      if (!pogodak) continue
      if (!tijekUkljucen(t)) { preskoceni.push(wid); break }
      const prag = Number(t.najmanja_tezina ?? 0) || 0
      if (tezina < prag) {
        return {
          ...osnova, workflow: null, kod: 'prelagan',
          razlog: `okidač „${uzorak}" pogađa ${wid}, ali težina ${tezina} < ${prag}`,
        }
      }
      return { ...osnova, workflow: wid, kod: 'okidac', razlog: `okidač „${uzorak}"`, koraci: t.koraci || [] }
    }
  }

  if (preskoceni.length > 0) {
    return {
      ...osnova, workflow: null, kod: 'ugasen',
      razlog: `okidač pogađa, ali je tijek ugašen (enabled=false): ${preskoceni.join(', ')}`,
    }
  }
  return { ...osnova, workflow: null, kod: 'nema-okidaca', razlog: 'nijedan okidač ne odgovara' }
}

// ─── Oznaka i razlog (W1 / TASK-4614) ────────────────────────────────────────
//
// NALOG, doslovno: „zapisati odluku kao oznaku `workflow:<id>` ili `bez-workflowa` UZ
// RAZLOG u progressNotes". Dvije stvari, i obje su ovdje čiste funkcije: vrata izračunaju
// ŠTO bi se upisalo, a upisuje pozivatelj koji ima ploču (`primijeniOznaku`). Razlog je
// zašto WorkflowGate i dalje nema uvoz baze — svojstvo „nula spawnova, ništa se ne dira"
// mora ostati provjerljivo nad izvorom, i u načinu `on`.
//
// ZAŠTO RAZLOG NIJE UKRAS: oznaka bez razloga tjera čovjeka da pogađa je li tijek izabran
// okidačem, težinom ili njegovom vlastitom ranijom oznakom. Upravo se po tome mjeri W1 —
// koliko je odluka čovjek POSLIJE promijenio — a ispravak bez vidljivog razloga nije
// ispravak nego preinaka naslijepo.

/** Oznaka koju odluka predlaže: `workflow:<id>` ili `bez-workflowa`. */
export function oznakaZaOdluku(odluka: { workflow: string | null }): string {
  return odluka.workflow ? `${OZNAKA_PREFIKS}${odluka.workflow}` : BEZ_WORKFLOWA_OZNAKA
}

/**
 * Bilješka za `progressNotes`. Nosi oznaku, kod odluke, razlog i težinu ZAJEDNO S IZVOROM
 * težine — jer „težina 25" iz procjene teksta i „težina 25" izmjerena na kanalu nisu isto,
 * a upravo o tom pragu ovisi je li tijek uopće ponuđen (nalaz iz plana §6.1).
 */
export function biljeskaZaOdluku(o: {
  oznaka: string
  kod: OdlukaKod
  razlog: string
  tezina: number
  tezinaIzvor: TezinaIzvor
}): string {
  return `[TIJEK RADA] ${o.oznaka} — ${o.razlog} (kod: ${o.kod}, težina ${o.tezina}/100, izvor težine: ${o.tezinaIzvor})`
}

/**
 * Nalog pozivatelju: upiši ovu oznaku i ovu bilješku na ovaj zadatak.
 * `noveOznake` je gotov popis (postojeće + nova), da pozivatelj ne mora ponavljati spajanje
 * i da se ne izgubi nijedna zatečena oznaka — ploča oznake sprema kao cijeli niz.
 */
export interface NalogOznake {
  taskId: string
  oznaka: string
  biljeska: string
  postojeceOznake: string[]
  noveOznake: string[]
}

export interface VrataOpcije extends UcitajOpcije {
  logPath?: string
  /** Dnevnik kvarova; zadano `console.error`. Pozivatelj ovamo šalje svoj `log()`. */
  log?: (poruka: string) => void
  /**
   * Upis oznake na zadatak. Zove se SAMO u načinu `on`, samo kad zadatak ima `id` i samo
   * kad oznake još nema. Vraća `true` ako je upis stvarno uspio — ta se vrijednost
   * doslovno prepisuje u `oznakaUpisana`, pa zapis ne može tvrditi učinak kojeg nema.
   * Iznimka iz njega se guta: prekidač ne smije srušiti ulaz na kojem stoji.
   */
  primijeniOznaku?: (nalog: NalogOznake) => boolean
  /**
   * W2/TASK-4616: IZVEDBA odluke — pretvaranje tijeka u lanac zadataka. Zove se samo kad
   * je odluka `materijalizirati` (dakle način `on` i odabran tijek) i kad zadatak postoji.
   *
   * Namjerno zaseban zatvarač, a ne poziv iz ovih vrata: `WorkflowGate` po ugovoru ne
   * dira ploču (čista odluka + jedan `append`), a materijalizacija je upravo suprotno —
   * stvara zadatke. Pozivatelj (ploča) zna kako, vrata znaju kada.
   *
   * Vraća ID-eve nastalih koraka i je li lanac potpun; oboje ide doslovno u zapis, pa
   * redak ne može tvrditi izvedbu koje nema. Iznimka se guta — kao i kod oznake.
   */
  materijaliziraj?: (nalog: NalogOznake) => { ok: boolean; taskIds: string[] } | null
}

/**
 * Odluka uz primijenjen način rada. `null` znači „vrata su isključena" (`off`) ili katalog
 * nije čitljiv — u oba slučaja zadatak ide starim putem, bajt-identično kao prije.
 */
export function odluciZaZadatak(ulaz: OdlukaUlaz, o: VrataOpcije = {}): WorkflowOdluka | null {
  const cfg = loadWorkflowGateConfig(o)
  if (cfg.nacin === 'off') return null            // `off` znači da se NE računa

  const katalog = ucitajKatalogIliNull(o)
  if (!katalog) return null

  const odluka = odaberiTijek(ulaz, katalog)
  return { ...odluka, materijalizirati: cfg.nacin === 'on' && !!odluka.workflow }
}

// ─── Zapis ───────────────────────────────────────────────────────────────────

export interface OdlukaZapis {
  ts: string
  verzija: number
  nacin: WorkflowNacin
  taskId: string | null
  naslov: string
  projectId: string | null
  assignee: string | null
  oznake: string[]
  workflow: string | null
  kod: OdlukaKod
  razlog: string
  tezina: number
  tezinaIzvor: TezinaIzvor
  koraka: number
  agenti: string[]
  /** Oznaka koju odluka PREDLAŽE: `workflow:<id>` ili `bez-workflowa`. Uvijek popunjeno. */
  oznaka: string
  /**
   * Je li ta oznaka stvarno upisana na zadatak. U sjeni uvijek `false` — to je cijeli
   * prihvatni kriterij W1 („oznaka se ne upisuje"). U načinu `on` `true` samo ako je
   * pozivatelj potvrdio upis; neuspjeh i iznimka ostaju `false`.
   */
  oznakaUpisana: boolean
  /** Bi li se odluka smjela izvesti (način `on` + odabran tijek). */
  materijalizirati: boolean
  /**
   * Je li stvarno izvedena — od W2 stvarni ishod pozivateljeve materijalizacije, a ne
   * više tvrdi `false`. `true` znači: lanac koraka POSTOJI na ploči.
   */
  materijalizirano: boolean
  /** ID-evi koraka nastalih materijalizacijom (prazno kad je nije bilo). */
  lanac: string[]
  izvor: IzvorOdluke
}

/**
 * ŽIVI dnevnik odluka, neovisno o podmetnutom `$HOME` — isti razlog kao u `LiveDbGuard`:
 * e2e testovi namjerno podmeću HOME, pa bi provjera vezana uz `$HOME` propustila baš onaj
 * slučaj zbog kojega guard postoji.
 */
export const LIVE_ODLUKE_LOG_PATH = join(realHomedir(), '.taskmanager', 'data', 'workflow_odluke.jsonl')

/**
 * Smije li se u OVOM procesu pisati u OVU datoteku.
 *
 * ZAŠTO POSTOJI (mjereno, ne pretpostavljeno): čim je W1 ukopčao vrata u `obradiUlaz`,
 * `bun test tests/ingest-gate-live.test.ts` je upisao 7 fixture-redaka („napravi mi skriptu
 * koja svakih pola sata provjeri DNS…") ravno u produkcijski `workflow_odluke.jsonl`.
 * Šteta nije kozmetička: taj dnevnik JE mjerilo po kojem se odlučuje ide li W1 uživo, pa bi
 * izmišljeni promet pomicao i nazivnik i udio ispravaka. Ista vrsta kvara kao fixture
 * taskovi u živoj `regoc.db` (TASK-3020) — i zato koristi isti, provjereni `isTestRuntime`.
 *
 * Guard opali samo kad su OBA uvjeta istinita: vrtimo se u test-runneru I cilj je baš živi
 * dnevnik. Test koji preusmjeri `logPath` (kako i treba) ne osjeti ništa.
 */
export function smijePisati(logPath: string): boolean {
  if (!isTestRuntime()) return true
  return resolve(logPath) !== resolve(LIVE_ODLUKE_LOG_PATH)
}

/**
 * Dopiši redak. Namjerno `appendFileSync` bez brave: jedan redak JSON-a je ispod PIPE_BUF,
 * a `O_APPEND` u jezgri jamči da se dva pisca ne izmiješaju usred retka (ista odluka kao za
 * dnevnik daemona i ulazna vrata).
 */
export function zapisiOdluku(zapis: OdlukaZapis, logPath: string = WORKFLOW_ODLUKE_LOG_PATH): void {
  if (!smijePisati(logPath)) {
    throw new Error(
      `test-proces ne smije pisati u živi dnevnik odluka (${logPath}) — preusmjeri logPath na privremenu datoteku`)
  }
  const dir = dirname(logPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  appendFileSync(logPath, JSON.stringify(zapis) + '\n', 'utf-8')
}

/**
 * JEDINA funkcija koju pozivatelj (TaskWebUI pri otvaranju zadatka) treba zvati.
 * Vraća zapis ako je nastao, inače `null`.
 *
 * NIKAD NE BACA i povratna se vrijednost smije zanemariti. Ovo stoji na putu stvaranja
 * zadatka: iznimka ovdje značila bi da ploča prestane primati posao zbog prekidača koji je
 * u sjeni i po definiciji ne smije ni na što utjecati.
 */
export function mozdaZapisiOdluku(ulaz: OdlukaUlaz, o: VrataOpcije = {}): OdlukaZapis | null {
  try {
    if (!String(ulaz?.naslov || '').trim() && !String(ulaz?.opis || '').trim()) return null
    const odluka = odluciZaZadatak(ulaz, o)
    if (!odluka) return null

    const cfg = loadWorkflowGateConfig(o)
    const oznaka = oznakaZaOdluku(odluka)

    // ── W1: materijalizacija odluke kao OZNAKE (samo `on`) ──────────────────
    // Redoslijed je namjeran: upis se pokušava PRIJE nego što redak ode u dnevnik, da
    // `oznakaUpisana` opisuje stvarnost, a ne namjeru. Tri uvjeta moraju vrijediti
    // zajedno, i svaki je tu zbog konkretnog kvara:
    //   • `nacin === 'on'`  — u sjeni se oznaka NE upisuje (prihvatni kriterij naloga);
    //   • postoji `taskId`  — kanal odlučuje prije nego zadatak postoji, nema što označiti;
    //   • oznake još nema   — čovjekova ranija oznaka se ne dira i ne duplira. Ista
    //     provjera pokriva i `bez-workflowa`: tko ga je već stavio, ostaje pri svome.
    const postojece = oznakeNorm(ulaz.oznake)
    let oznakaUpisana = false
    if (cfg.nacin === 'on' && ulaz.taskId && o.primijeniOznaku && !postojece.includes(oznaka)) {
      const nalog: NalogOznake = {
        taskId: String(ulaz.taskId),
        oznaka,
        biljeska: biljeskaZaOdluku({ oznaka, kod: odluka.kod, razlog: odluka.razlog, tezina: odluka.tezina, tezinaIzvor: odluka.tezinaIzvor }),
        postojeceOznake: postojece,
        noveOznake: [...postojece, oznaka],
      }
      // Iznimka pozivatelja NE smije srušiti vrata: ona stoje na putu stvaranja zadatka.
      try { oznakaUpisana = o.primijeniOznaku(nalog) === true }
      catch (e: any) {
        oznakaUpisana = false
        try { (o.log || console.error)(`[WORKFLOW-VRATA] upis oznake nije uspio: ${e?.message || e}`) } catch { /* prazno */ }
      }
    }

    // ── W2: IZVEDBA odluke u lanac zadataka (samo `on` + vlastiti prekidač) ──
    // Ide POSLIJE oznake i po istom pravilu: prvo se pokuša, pa se zapiše što je bilo.
    // Uvjet `materijalizirati` već nosi „način je `on` i tijek je odabran"; drugi prekidač
    // (`materijalizacija` u istoj konfiguraciji) provjerava sam pozivatelj, jer on je taj
    // koji dira ploču. Ako zatvarača nema, ponašanje je bajt-identično W1 stanju.
    let materijalizirano = false
    let lanac: string[] = []
    if (odluka.materijalizirati && ulaz.taskId && o.materijaliziraj) {
      const nalog: NalogOznake = {
        taskId: String(ulaz.taskId),
        oznaka,
        biljeska: biljeskaZaOdluku({ oznaka, kod: odluka.kod, razlog: odluka.razlog, tezina: odluka.tezina, tezinaIzvor: odluka.tezinaIzvor }),
        postojeceOznake: postojece,
        noveOznake: [...postojece, oznaka],
      }
      try {
        const ishod = o.materijaliziraj(nalog)
        materijalizirano = ishod?.ok === true
        lanac = (ishod?.taskIds || []).map(String)
      } catch (e: any) {
        materijalizirano = false
        try { (o.log || console.error)(`[WORKFLOW-VRATA] materijalizacija nije uspjela: ${e?.message || e}`) } catch { /* prazno */ }
      }
    }

    const zapis: OdlukaZapis = {
      ts: new Date().toISOString(),
      verzija: ODLUKE_VERZIJA,
      nacin: cfg.nacin,
      taskId: ulaz.taskId ? String(ulaz.taskId) : null,
      naslov: String(ulaz.naslov || '').replace(/\s+/g, ' ').trim().slice(0, ISJECAK_NASLOVA),
      projectId: ulaz.projectId ? String(ulaz.projectId) : null,
      assignee: ulaz.assignee ? String(ulaz.assignee) : null,
      oznake: oznakeNorm(ulaz.oznake),
      workflow: odluka.workflow,
      kod: odluka.kod,
      razlog: odluka.razlog,
      tezina: odluka.tezina,
      tezinaIzvor: odluka.tezinaIzvor,
      koraka: odluka.koraci.length,
      agenti: odluka.koraci.map(k => String(k?.agent || '')).filter(Boolean),
      oznaka,
      oznakaUpisana,
      materijalizirati: odluka.materijalizirati,
      materijalizirano,          // W2/TASK-4616: stvarni ishod pozivatelja, ne pretpostavka
      lanac,
      izvor: ulaz.izvor || 'create',
    }
    zapisiOdluku(zapis, o.logPath || WORKFLOW_ODLUKE_LOG_PATH)
    return zapis
  } catch (e: any) {
    try { (o.log || console.error)(`[WORKFLOW-VRATA] zapis preskočen: ${e?.message || e}`) } catch { /* ni dnevnik ne ruši ploču */ }
    return null
  }
}

/** Jednoredni sažetak za dnevnik ploče — isti oblik kao ostali vratari. */
export function formatOdlukaLog(z: OdlukaZapis): string {
  return `workflow-gate[${z.nacin}]: ${z.taskId || '(bez id)'} → ${z.workflow || 'bez tijeka'} `
    + `(${z.kod}, težina ${z.tezina}/${z.tezinaIzvor}, ulaz ${z.izvor}`
    + `${z.materijalizirati ? ', materijalizirati' : ''}${z.oznakaUpisana ? `, oznaka upisana: ${z.oznaka}` : ''}`
    + `${z.materijalizirano ? `, lanac: ${(z.lanac || []).join(' → ')}` : ''})`
}
