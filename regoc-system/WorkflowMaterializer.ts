/**
 * WorkflowMaterializer — W2/TASK-4616: odabrani TIJEK RADA postaje LANAC ZADATAKA NA PLOČI.
 *
 * Plan: `~/app/regoc_system/docs/PLAN-workflow-integracija.md` §3 W2.
 *
 * ZAŠTO OVAKO. Kod Anthropica je tijek efemeran — živi u jednom procesu i nestaje s njim.
 * Kod nas je svaki korak ZADATAK NA PLOČI: preživi restart, ima izvršitelja, trošak i
 * status koji čovjek vidi. To je jedina prednost koju u ovom poslu imamo i plan je
 * izrijekom traži graditi, a ne zamijeniti. Zato ovaj modul ne pokreće ništa — on
 * MATERIJALIZIRA: iz kataloga (`agents/workflows.json`) napravi lanac zadataka, poveže ih
 * recipročno i pusti ploču da radi ono što već zna (auto-unblock + auto-exec).
 *
 * TRI ZAMKE koje su ugrađene u kod, sve tri nađene čitanjem postojećeg koda prije pisanja:
 *
 *   1. REKURZIJA KROZ VLASTITA VRATA. Korak nosi oznaku `workflow:<id>`; da ga se otvara
 *      preko `POST /api/tasks`, `WorkflowGate` bi na njemu opet odlučio „ide po tijeku"
 *      (kod `oznaka`) i granao lanac iz lanca. Zato materijalizacija ide kroz PORT PLOČE
 *      (`TaskManagerSQL`), a ne kroz HTTP — i uz to stoji guard `jeKorakTijeka`.
 *
 *   2. `blocked` BEZ RAZLOGA. `TaskManagerSQL.createTask` sam postavlja `status='blocked'`
 *      čim je poslan `blockedBy`, ali razlog ostavlja prazan. Mjereno 29.07.: `blocked` je
 *      groblje — 87 zadataka, 67 bez ijednog razloga, medijan 8,3 dana. Svaki korak zato
 *      dobiva razlog s `DEP_HOLD_PREFIX`, ISTIM koji pumpa razlaganja prepoznaje kao
 *      sistemsku (a ne ljudsku) zadršku.
 *
 *   3. OZNAKA KOJA ČUVA OD AUTO-EXECA GASI I AUTO-UNBLOCK. `AutonomyQueue.DEFAULT_HUMAN_GATED_TAGS`
 *      i `TaskManagerSQL.HUMAN_GATED_UNBLOCK_TAGS` su ISTI popis. Korak se zato NE smije
 *      „privremeno zadržati" oznakom — time bi se izgubilo upravo ono što nalog traži
 *      dokazati (da se lanac odvrti sam). Tko treba lanac koji ne spawna (proba), koristi
 *      `paused`, jer pauza zaustavlja auto-exec, a auto-unblock ne dira.
 *
 * Autorica: Jelena (Engineer), TASK-4616.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { realHomedir, isTestRuntime } from './LiveDbGuard'
import { DEP_HOLD_PREFIX } from './TaskDecomposer'
import {
  OZNAKA_PREFIKS, WORKFLOW_GATE_CONFIG_PATH, tijekUkljucen,
  type Korak, type Tijek,
} from './WorkflowGate'

const HOME = process.env.HOME || realHomedir()

// ─── Prekidač (razina 4: „smije li se odluka IZVESTI") ───────────────────────
//
// Namjerno ZASEBNO polje, u istoj datoteci kao W0/W1 prekidač. Da materijalizacija visi o
// `nacin: 'on'`, prelazak W1 uživo (upis oznake — bezopasan) istog bi trena počeo otvarati
// lance zadataka i trošiti spawnove. W0 je to i zapisao kao obećanje: „`on` ne pokreće
// nijedan spawn". Dva različita rizika = dva prekidača.

export type MaterNacin = 'off' | 'shadow' | 'on'
export const MATER_NACINI: readonly MaterNacin[] = ['off', 'shadow', 'on'] as const
export const MATERIJALIZACIJA_ZADANA: MaterNacin = 'shadow'

export interface MaterijalizacijaCfg { nacin: MaterNacin; izvor: string }

interface Otisak { mtimeMs: number; velicina: number }
let _kes: { cfg: MaterijalizacijaCfg; put: string; ucitanoU: number; otisak: Otisak } | null = null
const KES_TTL_MS = 30_000

function otisakOf(put: string): Otisak {
  try { const st = statSync(put); return { mtimeMs: st.mtimeMs, velicina: st.size } }
  catch { return { mtimeMs: -1, velicina: -1 } }
}

/**
 * Način iz `config/workflow-gate.json`, polje `materijalizacija`. Nedostaje / neispravno /
 * nepoznata vrijednost → `shadow`. Nikad tiho `on` — isti dogovor kao kod svih vratara.
 * Mijenja se BEZ ponovnog pokretanja (keš pada na promjenu `mtime`/veličine).
 */
export function loadMaterijalizacijaNacin(o: { configPath?: string; force?: boolean } = {}): MaterijalizacijaCfg {
  const put = o.configPath || WORKFLOW_GATE_CONFIG_PATH
  if (!o.force && _kes && _kes.put === put && Date.now() - _kes.ucitanoU < KES_TTL_MS) {
    const sad = otisakOf(put)
    if (sad.mtimeMs === _kes.otisak.mtimeMs && sad.velicina === _kes.otisak.velicina) return _kes.cfg
  }

  const cfg: MaterijalizacijaCfg = { nacin: MATERIJALIZACIJA_ZADANA, izvor: put }
  try {
    if (existsSync(put)) {
      const sirovo = JSON.parse(readFileSync(put, 'utf-8'))
      const n = String(sirovo?.materijalizacija ?? '').trim().toLowerCase()
      if ((MATER_NACINI as readonly string[]).includes(n)) cfg.nacin = n as MaterNacin
    }
  } catch { /* pokvaren JSON → shadow; prekidač ne ruši pozivatelja */ }

  _kes = { cfg, put, ucitanoU: Date.now(), otisak: otisakOf(put) }
  return cfg
}

// ─── Oznake ──────────────────────────────────────────────────────────────────

export const OZNAKA_KORAK = 'korak:'
export const OZNAKA_VJESTINA = 'vjestina:'
/** Biljeg „ovaj zadatak JE korak tijeka" — nosi ga guard rekurzije i mjerilo W6. */
export const OZNAKA_LANAC = 'tijek-korak'
/**
 * Biljeg na NADZADATKU: `tijek-lanac:<id>` — „ovaj je zadatak već razložen u lanac".
 *
 * Zašto oznaka, a ne veza: korak 1 nije `blockedBy` nadzadatka (mora krenuti odmah), pa
 * `blocks` nadzadatka ostaje prazan i po njemu se lanac NE vidi. Bez ovog biljega drugi
 * poziv (ponovno otvaranje, ponovni prolaz vrata) otvara drugi lanac na istom poslu —
 * mjereno u testu prije nego što je biljeg postojao.
 */
export const OZNAKA_NADZADATKA = 'tijek-lanac:'

function oznakeNorm(o?: string[] | null): string[] {
  return (o || []).map(x => String(x).trim().toLowerCase()).filter(Boolean)
}

/** Je li zadatak i sam korak nekog lanca? Takav se NIKAD ne razlaže dalje (guard rekurzije). */
export function jeKorakTijeka(oznake?: string[] | null): boolean {
  const o = oznakeNorm(oznake)
  return o.includes(OZNAKA_LANAC) || o.some(t => t.startsWith(OZNAKA_KORAK))
}

/** Je li nadzadatak već razložen u lanac (biljeg `tijek-lanac:<id>`)? */
export function imaLanac(oznake?: string[] | null): boolean {
  return oznakeNorm(oznake).some(t => t.startsWith(OZNAKA_NADZADATKA))
}

// ─── Imenovana vještina ──────────────────────────────────────────────────────
//
// Nalog traži da svaki korak nosi IMENOVANU vještinu. Katalog je danas ne nosi svugdje
// (mjereno: 11 od 32 koraka nema polje `vjestina`), a izmišljena vještina je gora od
// nikakve — agent bi tražio spis kojeg nema. Zato tri razine, i svaka se PROVJERAVA
// na disku prije nego uđe u opis koraka.

/**
 * Katalog vještina i registar agenata su SUSTAVSKI resursi, a ne stanje pojedinog `$HOME`.
 * E2E testovi namjerno podmeću `HOME` (izolirana ploča), pa bi vezanje isključivo uz njega
 * značilo da u toj instanci nijedna vještina „ne postoji" i da svaki korak tiho padne na
 * zadanu — dakle da provjera imenovanja prođe, a ne mjeri ništa. Zato: `$HOME` ako ondje
 * stvarno jest, inače pravi home iz `/etc/passwd` (isti postupak kao `LiveDbGuard`).
 */
function sustavskiPut(...dijelovi: string[]): string {
  const izHome = join(HOME, ...dijelovi)
  return existsSync(izHome) ? izHome : join(realHomedir(), ...dijelovi)
}

export const SKILLS_DIR = sustavskiPut('.claude', 'skills')
export const AGENTI_PATH = sustavskiPut('.claude', 'regoc', 'REGOC_AGENTS.json')
/** Vještina koju ima SVAKI agent u registru — zadnja postaja, nikad izmišljotina. */
export const ZADANA_VJESTINA = 'CORE'

/**
 * Uloga → vještina, poredano po prednosti. Prva koju izvršitelj STVARNO ima pobjeđuje;
 * ako nijednu nema, uzima se prva koja postoji na disku (i to se zapiše kao `vlastita:false`,
 * jer je to podatak za mjerilo, a ne sitnica: korak s tuđom vještinom je korak koji će
 * vjerojatno pasti na `zamjena`).
 */
export const ULOGA_VJESTINA: Readonly<Record<string, string[]>> = {
  research: ['Research', 'OSINT'],
  prikupljanje: ['OSINT', 'Research'],
  ovlastenje: ['OSINT'],
  analyze: ['FirstPrinciples'],
  korelacija: ['FirstPrinciples'],
  plan: ['GrillWithDocs', 'DocCoauthoring'],
  design: ['GrillWithDocs', 'FrontendDesign'],
  opseg: ['GrillWithDocs'],
  synthesize: ['DocCoauthoring', 'FirstPrinciples'],
  izvjestaj: ['DocCoauthoring'],
  pokretanje: ['DocCoauthoring', 'System'],
  taskmanager: ['THEALGORITHM', 'Agents'],
  izvedba: ['THEALGORITHM', 'System'],
  work: ['TDD', 'Development'],
  implement: ['TDD', 'Development'],
  fix: ['DiagnosingBugs', 'TDD'],
  repair: ['DiagnosingBugs', 'TDD'],
  test: ['TDD', 'WebappTesting'],
  regresija: ['TDD', 'WebappTesting'],
  verify: ['FirstPrinciples', 'TDD'],
  review: ['RedTeam', 'FirstPrinciples'],
  audit: ['RedTeam', 'Recon'],
}

/** Postoji li vještina stvarno na disku (`~/.claude/skills/<X>/SKILL.md`)? */
export function vjestinaPostoji(vjestina: string, skillsDir: string = SKILLS_DIR): boolean {
  const v = String(vjestina || '').trim()
  if (!v || /[\/\\]/.test(v)) return false
  return existsSync(join(skillsDir, v, 'SKILL.md'))
}

let _agenti: { put: string; mapa: Record<string, string[]> } | null = null

/** Vještine koje agent ima u registru (`REGOC_AGENTS.json`). Nepoznat agent → prazno. */
export function vjestineAgenta(agent: string, put: string = AGENTI_PATH): string[] {
  if (!_agenti || _agenti.put !== put) {
    const mapa: Record<string, string[]> = {}
    try {
      const sirovo = JSON.parse(readFileSync(put, 'utf-8'))
      for (const [ime, def] of Object.entries<any>(sirovo?.agents || {})) {
        mapa[ime.toLowerCase()] = Array.isArray(def?.skills) ? def.skills.map(String) : []
      }
    } catch { /* nedostupan registar → nitko nema ništa, pa se pada na zadanu vještinu */ }
    _agenti = { put, mapa }
  }
  return _agenti.mapa[String(agent || '').trim().toLowerCase()] || []
}

export interface RazrijesenaVjestina {
  vjestina: string
  /** `katalog` = polje `vjestina` na koraku, `uloga` = tablica gore, `zadana` = CORE. */
  izvor: 'katalog' | 'uloga' | 'zadana'
  /** Ima li je izvršitelj u svom kompletu. `false` je nalaz za mjerilo, ne greška. */
  vlastita: boolean
}

export function razrijesiVjestinu(
  korak: Korak,
  o: { skillsDir?: string; agentiPath?: string } = {},
): RazrijesenaVjestina {
  const skillsDir = o.skillsDir || SKILLS_DIR
  const moje = new Set(vjestineAgenta(korak.agent, o.agentiPath || AGENTI_PATH))
  const ima = (v: string) => moje.has(v)

  const izKataloga = String(korak.vjestina || '').trim()
  if (izKataloga && vjestinaPostoji(izKataloga, skillsDir)) {
    return { vjestina: izKataloga, izvor: 'katalog', vlastita: ima(izKataloga) }
  }

  const kandidati = (ULOGA_VJESTINA[String(korak.uloga || '').trim().toLowerCase()] || [])
    .filter(v => vjestinaPostoji(v, skillsDir))
  const vlastiti = kandidati.find(ima)
  if (vlastiti) return { vjestina: vlastiti, izvor: 'uloga', vlastita: true }
  if (kandidati.length) return { vjestina: kandidati[0], izvor: 'uloga', vlastita: false }

  const agentova = vjestineAgenta(korak.agent, o.agentiPath || AGENTI_PATH)
    .find(v => vjestinaPostoji(v, skillsDir))
  if (agentova && agentova !== ZADANA_VJESTINA) {
    return { vjestina: agentova, izvor: 'zadana', vlastita: true }
  }
  return { vjestina: ZADANA_VJESTINA, izvor: 'zadana', vlastita: ima(ZADANA_VJESTINA) }
}

// ─── Plan lanca ──────────────────────────────────────────────────────────────

export interface ZadatakZaLanac {
  id: string
  title: string
  description?: string | null
  projectId?: string | null
  oznake?: string[] | null
  priority?: number | null
}

export interface KorakLanca {
  n: number
  ukupno: number
  agent: string
  uloga: string
  vjestina: string
  vjestinaIzvor: RazrijesenaVjestina['izvor']
  vlastitaVjestina: boolean
  naslov: string
  opis: string
  oznake: string[]
  treba: string[]
  zamjena: string | null
}

export const NASLOV_MAX = 120

function oznakeKoraka(a: { tijekId: string; n: number; vjestina: string; parentTaskId: string }): string[] {
  return [
    `${OZNAKA_PREFIKS}${a.tijekId}`,   // workflow:<id>
    `${OZNAKA_KORAK}${a.n}`,           // korak:<n>
    `${OZNAKA_VJESTINA}${a.vjestina}`, // vjestina:<X>
    `parent:${a.parentTaskId}`,
    OZNAKA_LANAC,
  ]
}

/**
 * Opis koji radnik stvarno dobije. Isti duh kao `TaskDecomposer.buildSubtaskDescription`
 * (ulazi, izlazi, opseg), uz dvije razlike koje traži nalog: IMENOVANA vještina i mjesto
 * u lancu. `prethodniTaskId` se popunjava tek pri materijalizaciji — prije nje taj zadatak
 * još ne postoji, pa se u planu spominje samo redni broj.
 */
export function opisKoraka(a: {
  tijekId: string
  tijek: Tijek
  korak: Korak
  n: number
  ukupno: number
  vjestina: RazrijesenaVjestina
  task: ZadatakZaLanac
  prethodniTaskId?: string | null
}): string {
  const L: string[] = []
  const nazivTijeka = a.tijek.naziv || a.tijekId
  L.push(`Korak ${a.n}/${a.ukupno} tijeka rada „${nazivTijeka}" (\`${a.tijekId}\`).`)
  L.push(`Nadzadatak: ${a.task.id} — „${a.task.title}".`)
  L.push('')
  L.push('## TVOJ DIO')
  L.push(String(a.korak.opis || `Uloga u tijeku: ${a.korak.uloga || 'nije navedena'}.`))
  L.push('')
  L.push(`## VJEŠTINA — ${a.vjestina.vjestina}`)
  L.push(`Radi po vještini \`${a.vjestina.vjestina}\` (\`~/.claude/skills/${a.vjestina.vjestina}/SKILL.md\`; pokreni je alatom Skill).`)
  if (!a.vjestina.vlastita) {
    L.push(`Napomena: ta vještina nije u tvom zadanom kompletu — ako je ne možeš učitati, radi po opisu koraka i zamjeni niže, i to reci u rezultatu.`)
  }
  L.push('')
  L.push('## ULAZ')
  if (a.n === 1) {
    L.push(`- opis nadzadatka ${a.task.id} (niže, „IZVORNI ZAHTJEV")`)
  } else {
    const prethodni = a.prethodniTaskId ? `korak ${a.n - 1} (${a.prethodniTaskId})` : `korak ${a.n - 1} istog lanca`
    L.push(`- rezultat prethodnog koraka: ${prethodni} — pročitaj mu \`resultSummary\` preko \`GET http://localhost:17781/api/tasks/${a.prethodniTaskId || '<ID>'}\``)
    L.push(`- ne kreći dok taj rezultat nisi pročitao; ako je prazan ili neupotrebljiv → status \`blocked\` s razlogom, NE \`completed\``)
  }
  L.push('')
  if ((a.korak.treba || []).length) {
    L.push(`## TRAŽI (sposobnosti): ${(a.korak.treba || []).join(', ')}`)
    L.push('')
  }
  if (a.korak.zamjena) {
    L.push('## ZAMJENA (ako ne možeš ispuniti gornje)')
    L.push(String(a.korak.zamjena))
    L.push('')
  }
  L.push('## IZLAZ (bez njega korak NIJE gotov)')
  L.push(`- \`resultSummary\` s dokazom izvršenja (naredba i njen izlaz, putanja datoteke, izmjeren broj, HTTP status ili commit)`)
  L.push(`- sve što sljedeći korak treba pročitati mora biti U TOM sažetku ili u datoteci koju on imenuje`)
  L.push('')
  L.push('## OPSEG — DRŽI GA SE')
  L.push(`Radi SAMO ovaj korak tijeka. Ostatak lanca rade drugi koraci; ne otvaraj nove teme i ne diraj njihov posao.`)
  L.push('')
  L.push('## IZVORNI ZAHTJEV (referenca, NE tvoj opseg)')
  L.push(String(a.task.description || '(nadzadatak nema opisa)').slice(0, 1500))
  return L.join('\n')
}

/**
 * Katalog → koraci lanca. Tijek s manje od dva koraka NIJE lanac (jedan izvršitelj radi
 * isto bez ijednog reda režije), pa vraća prazno.
 */
export function planLanca(a: {
  tijekId: string
  tijek: Tijek
  task: ZadatakZaLanac
  o?: { skillsDir?: string; agentiPath?: string }
}): KorakLanca[] {
  const koraci = (a.tijek.koraci || []).filter(k => k && String(k.agent || '').trim())
  if (koraci.length < 2) return []
  const ukupno = koraci.length

  return koraci.map((k, i) => {
    const n = i + 1
    const v = razrijesiVjestinu(k, a.o || {})
    const uloga = String(k.uloga || 'korak')
    return {
      n, ukupno,
      agent: String(k.agent).trim(),
      uloga,
      vjestina: v.vjestina,
      vjestinaIzvor: v.izvor,
      vlastitaVjestina: v.vlastita,
      naslov: `${a.task.id} · korak ${n}/${ukupno} · ${k.agent}/${uloga}: ${a.tijek.naziv || a.tijekId}`.slice(0, NASLOV_MAX),
      opis: opisKoraka({ tijekId: a.tijekId, tijek: a.tijek, korak: k, n, ukupno, vjestina: v, task: a.task }),
      oznake: oznakeKoraka({ tijekId: a.tijekId, n, vjestina: v.vjestina, parentTaskId: a.task.id }),
      treba: (k.treba || []).map(String),
      zamjena: k.zamjena ? String(k.zamjena) : null,
    }
  })
}

// ─── Port ploče ──────────────────────────────────────────────────────────────
//
// Namjerno UZAK: samo ono što materijalizacija stvarno treba. Tako se ista funkcija vozi
// i nad živom pločom (TaskWebUI predaje `TaskManagerSQL`) i nad fixture bazom u testu,
// bez ijednog HTTP poziva — a time i bez rekurzije kroz vlastita vrata.

export interface PlocaZadatak {
  id: string
  status?: string | null
  tags?: string[] | null
  blockedBy?: string[] | null
  blocks?: string[] | null
  projectId?: string | null
  priority?: number | null
}

export interface PlocaPort {
  createTask(input: {
    title: string; description: string; assignee?: string; priority?: number
    tags?: string[]; blockedBy?: string[]; projectId?: string; createdBy?: string
  }): PlocaZadatak | null
  getTask(id: string): PlocaZadatak | null
  updateTask(id: string, updates: Record<string, unknown>): PlocaZadatak | null
  addProgressNote(id: string, agent: string, note: string): void
}

// ─── Reciprocitet ────────────────────────────────────────────────────────────

export interface LanacVeza { taskId: string; blockedBy: string[]; blocks: string[] }

/**
 * Rupe u recipročnosti: dijete zna roditelja (`blockedBy`), roditelj ne zna dijete (`blocks`).
 * ČISTA funkcija — ista provjera vrijedi i za lanac koji je složio netko drugi.
 *
 * Zašto baš ovaj smjer: auto-unblock u `TaskManagerSQL` na dovršetku iterira `blocks`
 * RODITELJA. Rupa u tom smjeru znači da dijete nikad ne izađe iz `blocked` — lanac tiho
 * stane, a nijedan status ne kaže da nešto ne valja (incident MUSZG 28.08.2026.).
 */
export function reciprocitetRupe(veze: LanacVeza[]): Array<{ roditelj: string; dijete: string }> {
  const po = new Map(veze.map(v => [v.taskId, v]))
  const rupe: Array<{ roditelj: string; dijete: string }> = []
  for (const v of veze) {
    for (const r of v.blockedBy) {
      const roditelj = po.get(r)
      if (roditelj && !roditelj.blocks.includes(v.taskId)) rupe.push({ roditelj: r, dijete: v.taskId })
    }
  }
  return rupe
}

function veze(taskIds: string[], ploca: PlocaPort): LanacVeza[] {
  const out: LanacVeza[] = []
  for (const id of taskIds) {
    const t = ploca.getTask(id)
    if (!t) continue
    out.push({ taskId: id, blockedBy: (t.blockedBy || []).map(String), blocks: (t.blocks || []).map(String) })
  }
  return out
}

/**
 * Provjeri i po potrebi popravi recipročnost. Popravak ide kroz `updateTask` s
 * `blockedBy` — jedini put koji `TaskManagerSQL` ima za odražavanje veze na roditelja
 * (TASK-3521). Vraća broj popravljenih veza.
 */
export function popraviReciprocitet(taskIds: string[], ploca: PlocaPort): number {
  const rupe = reciprocitetRupe(veze(taskIds, ploca))
  let popravaka = 0
  for (const { dijete } of rupe) {
    const t = ploca.getTask(dijete)
    if (!t) continue
    const roditelji = (t.blockedBy || []).map(String)

    // MJERENO (a ne pretpostavljeno): ponovni upis ISTE vrijednosti NE popravlja ništa.
    // `TaskManagerSQL.updateTask` reciprocitet računa iz RAZLIKE (`dodani = novi \ stari`),
    // pa kad je roditelj već u `blockedBy`, skup `dodani` je prazan i `blocks` roditelja
    // ostaje kakav je bio. Popravak TASK-3521 dakle hvata PROMJENU veze, ne zatečenu
    // nesuglasnost — a upravo je nesuglasnost ono što lanac zaustavi.
    // Zato se veza kida pa ponovno uspostavlja: prvi upis ne dira ničiji `blocks`
    // (roditelj dijete ionako ne zna), drugi ga upisuje. Status se ne dira ni u jednom.
    ploca.updateTask(dijete, { blockedBy: [] })
    ploca.updateTask(dijete, { blockedBy: roditelji })
    popravaka++
  }
  return popravaka
}

// ─── Materijalizacija ────────────────────────────────────────────────────────

export interface MaterijalizacijaIshod {
  ok: boolean
  nacin: MaterNacin
  tijek: string
  parentTaskId: string
  koraka: number
  taskIds: string[]
  vjestine: string[]
  popravaka: number
  greske: string[]
  razlog: string
}

function ishod(p: Partial<MaterijalizacijaIshod> & { nacin: MaterNacin; tijek: string; parentTaskId: string; razlog: string }): MaterijalizacijaIshod {
  return {
    ok: false, koraka: 0, taskIds: [], vjestine: [], popravaka: 0, greske: [],
    ...p,
  }
}

export interface MaterijalizacijaArg {
  tijekId: string
  tijek: Tijek
  task: ZadatakZaLanac
  ploca: PlocaPort
  /** Kad nije zadan, čita se iz `config/workflow-gate.json`. */
  nacin?: MaterNacin
  configPath?: string
  skillsDir?: string
  agentiPath?: string
  /** Tko je naveden kao stvaratelj koraka — ide u `created_by`, mjerilo troška po izvoru. */
  createdBy?: string
}

/**
 * Napravi lanac zadataka iz tijeka. Sinkrono i bez mreže — pozivatelj je ploča sama.
 *
 * Redoslijed je namjeran:
 *   1. sva odbijanja PRIJE ijednog upisa (način, ugašen tijek, guard rekurzije, već postoji),
 *   2. koraci se stvaraju REDOM, svaki s `blockedBy` na prethodnika (tako `createTask` sam
 *      upiše reciprocitet), pa se blokiranima dopiše RAZLOG,
 *   3. na kraju se reciprocitet PROVJERI čitanjem natrag i popravi ako fali.
 *
 * Točka 3 nije paranoja nego ugovor: cijeli lanac ovisi o tome da roditelj zna svoju djecu,
 * a to je veza koju je sustav već jednom (TASK-3521) izgubio bez ijednog traga na ploči.
 */
export function materijalizirajTijek(arg: MaterijalizacijaArg): MaterijalizacijaIshod {
  const nacin = arg.nacin ?? loadMaterijalizacijaNacin({ configPath: arg.configPath }).nacin
  const osnova = { nacin, tijek: arg.tijekId, parentTaskId: arg.task.id }

  if (nacin !== 'on') {
    return ishod({ ...osnova, razlog: `način materijalizacije je \`${nacin}\` — lanac se ne stvara` })
  }
  if (!tijekUkljucen(arg.tijek)) {
    return ishod({ ...osnova, razlog: `tijek \`${arg.tijekId}\` je ugašen (enabled=false)` })
  }
  const postojeci = arg.ploca.getTask(arg.task.id)
  // Oznake se čitaju iz OBA izvora: pozivatelj ih šalje (ploča ih ima u ruci prije upisa),
  // ali zadatak na disku je izvor istine kad se vrata pozovu drugi put.
  const zatecene = [...new Set([...(arg.task.oznake || []), ...(postojeci?.tags || [])].map(String))]
  if (jeKorakTijeka(zatecene)) {
    return ishod({ ...osnova, razlog: 'zadatak je i sam korak tijeka — lanac iz lanca se ne radi (guard rekurzije)' })
  }
  if (imaLanac(zatecene)) {
    return ishod({ ...osnova, razlog: 'zadatak već ima materijaliziran lanac — drugi se ne radi (idempotencija)' })
  }

  const koraci = planLanca({
    tijekId: arg.tijekId, tijek: arg.tijek, task: arg.task,
    o: { skillsDir: arg.skillsDir, agentiPath: arg.agentiPath },
  })
  if (koraci.length < 2) {
    return ishod({ ...osnova, razlog: `tijek \`${arg.tijekId}\` nema barem dva koraka — jedan izvršitelj radi isto bez režije` })
  }

  const taskIds: string[] = []
  const greske: string[] = []
  const prioritet = Number.isFinite(Number(arg.task.priority)) ? Number(arg.task.priority) : 3

  for (const k of koraci) {
    const prethodni = taskIds.length ? taskIds[taskIds.length - 1] : null
    try {
      const stvoren = arg.ploca.createTask({
        title: k.naslov,
        description: opisKoraka({
          tijekId: arg.tijekId, tijek: arg.tijek,
          korak: (arg.tijek.koraci || [])[k.n - 1],
          n: k.n, ukupno: k.ukupno,
          vjestina: { vjestina: k.vjestina, izvor: k.vjestinaIzvor, vlastita: k.vlastitaVjestina },
          task: arg.task, prethodniTaskId: prethodni,
        }),
        assignee: k.agent,
        priority: prioritet,
        tags: k.oznake,
        ...(prethodni ? { blockedBy: [prethodni] } : {}),
        ...(arg.task.projectId ? { projectId: String(arg.task.projectId) } : {}),
        createdBy: arg.createdBy || 'workflow-materializer',
      })
      if (!stvoren?.id) {
        greske.push(`korak ${k.n} (${k.agent}) nije stvoren — prekidam da lanac ne ostane pola`)
        break
      }
      taskIds.push(String(stvoren.id))

      // `createTask` je već stavio `blocked` (jer ima `blockedBy`), ali BEZ razloga.
      // Razlog s `DEP_HOLD_PREFIX` je ono što ga razlikuje od ljudske zadrške — pumpa i
      // čovjek na ploči po njemu vide da čeka korak, a ne odluku.
      if (prethodni) {
        arg.ploca.updateTask(String(stvoren.id), {
          status: 'blocked',
          blockedReason: `${DEP_HOLD_PREFIX} ${prethodni} (tijek ${arg.tijekId}, korak ${k.n}/${k.ukupno})`,
        })
      }
    } catch (e: any) {
      greske.push(`korak ${k.n} (${k.agent}) pao: ${e?.message || e}`)
      break
    }
  }

  const popravaka = taskIds.length > 1 ? popraviReciprocitet(taskIds, arg.ploca) : 0
  const preostaleRupe = reciprocitetRupe(veze(taskIds, arg.ploca))
  for (const r of preostaleRupe) {
    greske.push(`reciprocitet nije uspostavljen: ${r.roditelj} ne zna za ${r.dijete}`)
  }

  const potpun = taskIds.length === koraci.length && greske.length === 0
  const rez = ishod({
    ...osnova,
    ok: potpun,
    koraka: koraci.length,
    taskIds,
    vjestine: koraci.map(k => k.vjestina),
    popravaka,
    greske,
    razlog: potpun
      ? `lanac od ${koraci.length} koraka materijaliziran`
      : `lanac NEPOTPUN (${taskIds.length}/${koraci.length})`,
  })

  // Biljeg na nadzadatku ide i kad je lanac nepotpun: pola lanca je stanje koje čovjek
  // mora vidjeti i popraviti, a ne razlog da idući prolaz otvori još pola.
  if (taskIds.length > 0) {
    try {
      const nove = [...zatecene, `${OZNAKA_NADZADATKA}${arg.tijekId}`]
      if (!arg.ploca.updateTask(arg.task.id, { tags: nove })) {
        rez.greske.push('biljeg lanca na nadzadatku nije upisan — idući prolaz bi otvorio drugi lanac')
      }
    } catch (e: any) {
      rez.greske.push(`biljeg lanca na nadzadatku nije upisan: ${e?.message || e}`)
    }
  }

  // Bilješka na nadzadatku: bez nje se lanac vidi tek pretragom oznaka, a čovjek koji
  // gleda nadzadatak ne bi imao odakle znati da posao uopće teče.
  try {
    arg.ploca.addProgressNote(arg.task.id, 'workflow-materializer', formatLanacBiljeska(rez, koraci))
  } catch (e: any) {
    rez.greske.push(`bilješka na nadzadatku nije upisana: ${e?.message || e}`)
  }

  // `ok` se računa NA KRAJU: upisi iznad mogu dodati grešku, a ishod koji tvrdi uspjeh uz
  // popis grešaka je isti onaj lažni ✅ zbog kojega vratari uopće postoje.
  rez.ok = rez.taskIds.length === koraci.length && rez.greske.length === 0
  if (!rez.ok && rez.razlog.startsWith('lanac od')) {
    rez.razlog = `lanac od ${koraci.length} koraka materijaliziran UZ GREŠKE (${rez.greske.length})`
  }
  return rez
}

export function formatLanacBiljeska(i: MaterijalizacijaIshod, koraci: KorakLanca[]): string {
  const popis = koraci.map((k, idx) => `${k.n}. ${k.agent}/${k.vjestina}${i.taskIds[idx] ? ` → ${i.taskIds[idx]}` : ' → (nije stvoren)'}`).join('; ')
  return `[TIJEK RADA · W2] ${i.tijek} materijaliziran u lanac od ${i.koraka} koraka: ${popis}`
    + `${i.popravaka ? ` · popravljenih veza: ${i.popravaka}` : ''}`
    + `${i.greske.length ? ` · GREŠKE: ${i.greske.join(' | ')}` : ''}`
}

/** Jednoredni sažetak za dnevnik ploče — isti oblik kao ostali vratari. */
export function formatLanacLog(i: MaterijalizacijaIshod): string {
  return `workflow-lanac[${i.nacin}]: ${i.parentTaskId} → ${i.tijek} `
    + `(${i.taskIds.length}/${i.koraka} koraka${i.taskIds.length ? `: ${i.taskIds.join(' → ')}` : ''}`
    + `${i.popravaka ? `, popravaka ${i.popravaka}` : ''}${i.greske.length ? `, GREŠKE ${i.greske.length}` : ''}) — ${i.razlog}`
}

// ─── Dnevnik lanaca ──────────────────────────────────────────────────────────

export const LANCI_LOG_PATH = join(HOME, '.claude', 'regoc', 'data', 'tijek_lanci.jsonl')
export const LIVE_LANCI_LOG_PATH = join(realHomedir(), '.claude', 'regoc', 'data', 'tijek_lanci.jsonl')
export const LANCI_VERZIJA = 1

/**
 * Ista brana kao `WorkflowGate.smijePisati` i iz istog razloga: čim su vrata ukopčana u
 * živi put, test-runner je počeo upisivati izmišljene retke u dnevnik koji JE mjerilo.
 */
export function smijePisatiLanac(logPath: string): boolean {
  if (!isTestRuntime()) return true
  return resolve(logPath) !== resolve(LIVE_LANCI_LOG_PATH)
}

export function zapisiLanac(i: MaterijalizacijaIshod, logPath: string = LANCI_LOG_PATH): void {
  if (!smijePisatiLanac(logPath)) {
    throw new Error(`test-proces ne smije pisati u živi dnevnik lanaca (${logPath}) — preusmjeri logPath`)
  }
  const dir = dirname(logPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), verzija: LANCI_VERZIJA, ...i }) + '\n', 'utf-8')
}
