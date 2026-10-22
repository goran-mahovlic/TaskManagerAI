/**
 * Predložak zadatka — „zadatak nosi puni kontekst” (TASK-5159, dizajn TASK-5158 §3).
 *
 * NALOG (Goran, 03.10.2026.): „Kad sustav agentu upisuje zadatak u TaskManager, mora napuniti
 * kontekst: što treba, koje su mu zadaće i koje alate treba koristiti. Sustav isto tako
 * određuje koji će se workflow koristiti.”
 *
 * ŠTO RADI: `gradiPredlozak()` slaže šest odjeljaka (CILJ, KONTEKST, ZADAĆE, VJEŠTINE I ALATI,
 * TIJEK, GOTOVOST I DOKAZ) u omeđeni blok `<!-- predlozak:v1 … -->` na kraju opisa, plus
 * strojne oznake (`korak:<n>/<uk>`, `vjestina:<X>`). ČISTA funkcija — ne bira tijek, agenta ni
 * alate; prima odluke (WorkflowGate, TaskToolkit) i samo ih slaže. Bez mreže i bez baze.
 *
 * `mozdaPredlozak()` je pogonski omotač (ploča ga zove u `POST /api/tasks`), iza prekidača
 * `predlozak` u `config/workflow-gate.json`:
 *   off    → ništa, ni dnevnik;
 *   shadow → blok se izračuna i zapiše u `data/predlozak_zadatka.jsonl`; zadatak se NE dira (zadano);
 *   on     → blok ide u opis, oznake na zadatak, upozorenja u progressNotes.
 * Nikad ne baca — stoji na putu stvaranja zadatka.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { isTestRuntime, realHomedir } from './LiveDbGuard'
import type { Katalog, Korak, Tijek } from './WorkflowGate'
import { scaleSteps } from './WorkflowTemplate'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()

export const PREDLOZAK_VERZIJA = 'v1'
export const PREDLOZAK_POCETAK = `<!-- predlozak:${PREDLOZAK_VERZIJA}`
export const PREDLOZAK_KRAJ = '<!-- /predlozak -->'
/** Gornja granica bloka (dizajn §3.2). Nalog i sažetak režu se prvi, zadaće i gotovost nikad. */
export const BLOK_MAX = 4096
export const NALOG_MAX = 1500
export const SAZETAK_MAX = 600

export const PREDLOZAK_CONFIG_PATH =
  process.env.REGOC_WORKFLOW_GATE_CONFIG || join(HOME, '.claude/regoc/config/workflow-gate.json')
export const PREDLOZAK_LOG_PATH = join(HOME, '.claude/regoc/data/predlozak_zadatka.jsonl')
export const LIVE_PREDLOZAK_LOG_PATH = join(realHomedir(), '.claude/regoc/data/predlozak_zadatka.jsonl')

/** Oznake zbog kojih zadatak ne dobiva predložak (dojava bez modela; ručno isključenje). */
export const BEZ_PREDLOSKA_OZNAKE = ['report-back', 'bez-predloska'] as const

// ─── Ulaz ────────────────────────────────────────────────────────────────────

export interface BriefZadatak {
  id?: string | null
  naslov: string
  opis?: string | null
  assignee?: string | null
  oznake?: string[] | null
  projectId?: string | null
  tezina?: number | null
}

export interface BriefOdluka { workflow: string | null; kod: string; razlog: string }

export interface BriefPovezani {
  id: string
  odnos: 'prethodni' | 'nadzadatak' | 'dorada-od'
  naslov?: string | null
  agent?: string | null
  rezultat?: string | null
}

export interface BriefToolkit {
  vjestine: Array<{ ime: string; svrha?: string }>
  alati: Array<{ poziv?: string; putanja?: string; svrha?: string }>
}

export interface BriefUlaz {
  zadatak: BriefZadatak
  /** Nalog doslovno (kad je zadatak nastao iz naloga i opis ga ne nosi). */
  nalog?: { id?: string | null; tekst?: string | null } | null
  /** Odluka vrata za OVAJ zadatak (bez nje se tijek čita iz oznaka). */
  odluka?: BriefOdluka | null
  katalog?: Katalog | null
  povezani?: BriefPovezani[]
  toolkit?: BriefToolkit | null
  chatSazetak?: string | null
  kriteriji?: string[] | null
  provjera?: string | null
  /** Postoji li vještina na disku. Zadano: `~/.claude/skills/<X>/SKILL.md`. */
  vjestinaPostoji?: (ime: string) => boolean
}

export interface BriefKorak { n: number; ukupno: number; agent: string; uloga: string; vjestina: string | null }

export interface BriefIzlaz {
  oznake: string[]
  blok: string
  upozorenja: string[]
  workflow: string | null
  korak: BriefKorak | null
  obvezne: string[]
}

// ─── Pomoćnici ───────────────────────────────────────────────────────────────

const oznakeNorm = (o?: string[] | null) => (o || []).map(x => String(x).trim()).filter(Boolean)

export function zadanaVjestinaPostoji(ime: string): boolean {
  const v = String(ime || '').trim()
  if (!v || /[\/\\]/.test(v)) return false
  // Kao `WorkflowMaterializer.sustavskiPut`: izolirani HOME (testovi) nema vještina, a vještine
  // su sustavske — zato se gleda i stvarni dom.
  return existsSync(join(HOME, '.claude/skills', v, 'SKILL.md')) || existsSync(join(realHomedir(), '.claude/skills', v, 'SKILL.md'))
}

/** `korak:3` ili `korak:3/5` → {n, ukupno}. */
export function korakIzOznaka(oznake?: string[] | null): { n: number; ukupno: number | null } | null {
  for (const o of oznakeNorm(oznake)) {
    const m = o.match(/^korak:(\d+)(?:\/(\d+))?$/i)
    if (m) return { n: Number(m[1]), ukupno: m[2] ? Number(m[2]) : null }
  }
  return null
}

function tijekIzOznaka(oznake?: string[] | null): string | null {
  const o = oznakeNorm(oznake).find(x => /^workflow:/i.test(x))
  return o ? o.slice('workflow:'.length).trim() || null : null
}

export function imaBlok(opis?: string | null): boolean {
  return String(opis || '').includes(PREDLOZAK_POCETAK)
}

/** Opis BEZ generiranog bloka (čovjekov dio). */
export function bezBloka(opis?: string | null): string {
  const s = String(opis || '')
  const i = s.indexOf(PREDLOZAK_POCETAK)
  if (i < 0) return s
  const j = s.indexOf(PREDLOZAK_KRAJ, i)
  const rep = j < 0 ? '' : s.slice(j + PREDLOZAK_KRAJ.length)
  return (s.slice(0, i) + rep).trimEnd()
}

export function izvadiBlok(opis?: string | null): string | null {
  const s = String(opis || '')
  const i = s.indexOf(PREDLOZAK_POCETAK)
  if (i < 0) return null
  const j = s.indexOf(PREDLOZAK_KRAJ, i)
  return j < 0 ? null : s.slice(i, j + PREDLOZAK_KRAJ.length).trim()
}

/** Blok na kraj opisa; postojeći se ZAMJENJUJE (ponovna gradnja), čovjekov tekst se ne dira. */
export function ugradiBlok(opis: string | null | undefined, blok: string): string {
  const ljudski = bezBloka(opis)
  return `${ljudski}${ljudski ? '\n\n' : ''}${blok.trim()}`
}

function rezi(s: string, max: number): string {
  const t = String(s || '').trim()
  return t.length > max ? t.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : t
}

function prvaRecenica(s: string, max = 240): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  const m = t.match(/^(.+?[.!?])(\s|$)/)
  return rezi(m ? m[1] : t, max)
}

const FORMAT_VJESTINA: Array<[RegExp, string]> = [
  [/\bpdf\b/i, 'Pdf'],
  [/\bdocx\b|\bword\b/i, 'Docx'],
  [/\bpptx\b|powerpoint/i, 'Pptx'],
  [/\bxlsx\b|excel/i, 'Xlsx'],
]
const FORMAT_SKUP = new Set(FORMAT_VJESTINA.map(x => x[1]))

/**
 * Obvezne vještine koraka (dizajn §3.5 + Q4 iz TASK-5168).
 *   1. izričite oznake `vjestina:<X>` — čovjek/materijalizator je odlučio;
 *   2. vještina koraka tijeka; ako je ona vještina FORMATA (Pdf/Docx/Pptx/Xlsx), bira se po
 *      formatu iz teksta naloga — inače bi DOCX nalog dobio lažno „Pdf nije pozvana”.
 */
export function obvezneVjestine(a: {
  oznake?: string[] | null
  korakVjestina?: string | null
  uloga?: string | null
  tekst?: string | null
  vjestinaPostoji?: (ime: string) => boolean
}): string[] {
  const izOznaka = oznakeNorm(a.oznake)
    .filter(o => /^vjestina:/i.test(o))
    .map(o => o.slice('vjestina:'.length).trim())
    .filter(Boolean)
  const kandidati = izOznaka.length ? [...new Set(izOznaka)] : [String(a.korakVjestina || '').trim()].filter(Boolean)
  if (!kandidati.length) return []
  // Vještina formata (i kad je došla oznakom materijalizatora) prati format iz naloga.
  if (kandidati.every(v => FORMAT_SKUP.has(v))) {
    const postoji = a.vjestinaPostoji || zadanaVjestinaPostoji
    const poFormatu = FORMAT_VJESTINA.filter(([re]) => re.test(String(a.tekst || ''))).map(x => x[1]).filter(postoji)
    if (poFormatu.length) return poFormatu
  }
  return kandidati
}

/** Obrazac dokaza po ulozi koraka (dizajn §3.4). Putanje popunjava REGOČ — ovdje se ne izmišljaju. */
export function obrazacDokaza(uloga?: string | null): { dokaz: string; primjer: string } {
  const u = String(uloga || '').toLowerCase()
  if (/^(research|analyze|synthesize|prikupljanje|korelacija)/.test(u)) {
    return { dokaz: 'RAG ID + datoteka nalaza', primjer: 'bun ~/.claude/skills/CORE/Tools/rag-query.ts -c <kolekcija> -q "<tema>" -n 1' }
  }
  if (/^(design|plan|opseg)/.test(u)) {
    return { dokaz: 'dokument u repou + commit', primjer: 'test -s <putanja.md> && git -C <repo> log -1 --format=%h -- <putanja.md>' }
  }
  if (/^(qa|test|verify|regresija|review|audit)/.test(u)) {
    return { dokaz: 'tablica nalaza + snimke', primjer: 'test -s <izvjestaj_qa.md>' }
  }
  if (/^isporuka/.test(u)) {
    return { dokaz: 'zapis u report_back_sent.jsonl (bez modela)', primjer: '(provjerava ReportBackTask)' }
  }
  return { dokaz: 'test ili izvoz', primjer: 'bun test <put> · test -s <izlaz.pdf> && pdfinfo <izlaz.pdf>' }
}

// ─── Glavna funkcija ─────────────────────────────────────────────────────────

export function gradiPredlozak(u: BriefUlaz): BriefIzlaz {
  const z = u.zadatak
  const oznake = oznakeNorm(z.oznake)
  const upozorenja: string[] = []
  const postoji = u.vjestinaPostoji || zadanaVjestinaPostoji
  const ljudskiOpis = bezBloka(z.opis)
  const tezina = typeof z.tezina === 'number' && Number.isFinite(z.tezina) ? z.tezina : 30

  // Tijek: oznaka je izvor istine, odluka vrata je druga postaja.
  const wid = tijekIzOznaka(oznake) || u.odluka?.workflow || null
  const tijek: Tijek | null = wid ? (u.katalog?.workflows?.[wid] || null) : null
  if (wid && !tijek) upozorenja.push(`tijek „${wid}” ne postoji u katalogu workflows.json`)
  const koraci: Korak[] = (tijek?.koraci || []).filter(k => k && String(k.agent || '').trim())
  const kOz = korakIzOznaka(oznake)

  let korak: BriefKorak | null = null
  let korakDef: Korak | null = null
  if (tijek && kOz && kOz.n >= 1 && kOz.n <= koraci.length) {
    korakDef = koraci[kOz.n - 1]
    korak = {
      n: kOz.n, ukupno: koraci.length, agent: String(korakDef.agent),
      uloga: String(korakDef.uloga || 'korak'), vjestina: korakDef.vjestina || null,
    }
  }

  const tekstNaloga = `${z.naslov || ''}\n${ljudskiOpis}\n${u.nalog?.tekst || ''}`
  const obvezne = obvezneVjestine({
    oznake, korakVjestina: korakDef?.vjestina, uloga: korakDef?.uloga, tekst: tekstNaloga, vjestinaPostoji: postoji,
  })
  for (const v of obvezne) if (!postoji(v)) upozorenja.push(`obvezna vještina „${v}” ne postoji u ~/.claude/skills`)

  // ── Oznake (strojni dio) ──
  const noveOznake: string[] = []
  if (korak) noveOznake.push(`korak:${korak.n}/${korak.ukupno}`)
  for (const v of obvezne) noveOznake.push(`vjestina:${v}`)
  if (u.nalog?.id) noveOznake.push(`nalog:${u.nalog.id}`)

  // ── 1. CILJ ──
  const cilj = korakDef?.opis
    ? `${prvaRecenica(String(korakDef.opis))} (nalog: „${rezi(z.naslov, 140)}”)`
    : prvaRecenica(z.naslov || ljudskiOpis || '(bez naslova)')

  // ── 3. ZADAĆE ──
  const zadace: string[] = []
  if (korakDef) {
    zadace.push(String(korakDef.opis || `Uloga u tijeku: ${korak?.uloga}.`))
    if ((korakDef.treba || []).length) zadace.push(`Traži sposobnosti: ${(korakDef.treba || []).join(', ')}.`)
    if (korakDef.zamjena) zadace.push(`Zamjena ako ne možeš: ${korakDef.zamjena}`)
  } else {
    zadace.push('Izvedi točno ono što traži opis iznad bloka — ni manje ni više.')
  }
  const izvrsitelj = String(z.assignee || korak?.agent || '').toLowerCase()
  zadace.push(`RAG prije rada: \`bun ~/.claude/skills/CORE/Tools/rag-query.ts -c ${izvrsitelj && izvrsitelj !== 'regoc' ? `agent_${izvrsitelj}` : 'pai_learning_system'} -q "<tema>" -n 5\`; pitanje o samom sustavu → \`-c regoc_popis\`.`)
  for (const s of scaleSteps({ weight: tezina })) {
    if (s.key === 'grill' && s.obveznost !== 'preskace') zadace.push(`Grill (${s.obveznost}): ${s.napomena || s.what}.`)
    if (s.key === 'izvedba') zadace.push('Commit po koraku s ID-em zadatka u poruci; TDD gdje ima testova.')
  }
  zadace.push('RAG poslije rada: upiši naučeno (`rag-store.ts … -p <projekt> --type lekcija --task <ID>`).')

  // ── 4. VJEŠTINE I ALATI ──
  const vjestineRedci: string[] = []
  if (obvezne.length) vjestineRedci.push(`OBVEZNO pozovi alatom Skill prije rada: ${obvezne.join(', ')}`)
  const preporucene = (u.toolkit?.vjestine || []).map(v => v.ime).filter(v => !obvezne.includes(v)).slice(0, 3)
  if (preporucene.length) vjestineRedci.push(`Preporučeno: ${preporucene.join(', ')}`)
  const alati = (u.toolkit?.alati || []).slice(0, 8).map(a => `${a.poziv || a.putanja}${a.svrha ? ` (${rezi(a.svrha, 60)})` : ''}`)
  if (alati.length) vjestineRedci.push(`Alati iz kataloga: ${alati.join(' · ')}`)
  vjestineRedci.push('Treba ti nešto drugo? `katalog trazi "<svrha>"` — postojeći alat nadogradi, ne piši novi.')

  // ── 5. TIJEK ──
  let tijekRedak: string
  if (tijek && korak) {
    const prije = koraci[korak.n - 2]
    const poslije = koraci[korak.n]
    const prethodni = (u.povezani || []).find(p => p.odnos === 'prethodni')
    tijekRedak = `Tijek \`${wid}\` (${tijek.naziv || wid}), korak ${korak.n}/${korak.ukupno} — ${korak.uloga}.`
      + (prije ? ` Prije: ${prije.agent} (${prije.uloga || 'korak'}${prethodni ? `, ${prethodni.id}` : ''}).` : ' Prvi korak.')
      + (poslije ? ` Poslije: ${poslije.agent} (${poslije.uloga || 'korak'}).` : ' Zadnji korak.')
  } else if (tijek) {
    const popis = koraci.map((k, i) => `${i + 1}. ${k.agent} · ${k.uloga || 'korak'}${k.vjestina ? ` (${k.vjestina})` : ''}`).join('\n')
    tijekRedak = `Tijek \`${wid}\` (${tijek.naziv || wid}) — ${koraci.length} koraka${u.odluka?.razlog ? `, ${u.odluka.razlog}` : ''}:\n${popis}`
  } else {
    tijekRedak = `Bez tijeka — ${u.odluka?.razlog || 'odluka nije donesena (vrata isključena ili korak ručnog lanca)'}.`
  }
  tijekRedak += '\nIzmjena tijeka: `~/app/TaskManager/TaskManagerAI/agents/workflows.json` ili oznaka `workflow:<id>` / `bez-workflowa`.'

  // ── 6. GOTOVOST I DOKAZ ──
  const gotovost: string[] = []
  ;(u.kriteriji || []).filter(Boolean).forEach((k, i) => gotovost.push(`${i + 1}. ${k}`))
  const provjeraUOpisu = /\[PROVJERA\]\s*cmd:/i.test(ljudskiOpis)
  if (u.provjera) {
    gotovost.push(`[PROVJERA] cmd: ${u.provjera}`)
  } else if (!provjeraUOpisu) {
    const ob = obrazacDokaza(korak?.uloga || null)
    gotovost.push(`Očekivani dokaz: ${ob.dokaz}. Obrazac: \`${ob.primjer}\` (putanje upisuje REGOČ).`)
    upozorenja.push('nema `[PROVJERA] cmd` — vratar neće moći provjeriti ishod')
  } else {
    gotovost.push('Provjera: naredba `PROVJERA` iz opisa iznad bloka (vratar je čita ondje).')
  }
  gotovost.push('Ishod: `REGOC-IZLAZ` JSON + zadnji redak `REGOC-STATUS: DONE|BLOCKED|NEEDS_CONTEXT — …`.')

  // ── 2. KONTEKST (reže se prvi) ──
  const povezani = (u.povezani || []).map(p =>
    `- ${p.odnos}: ${p.id}${p.naslov ? ` „${rezi(p.naslov, 80)}”` : ''}${p.agent ? ` (${p.agent})` : ''}${p.rezultat ? ` — ${rezi(String(p.rezultat).replace(/\s+/g, ' '), 160)}` : ''}`)
  const nalogTekst = u.nalog?.tekst && String(u.nalog.tekst).trim() && !ljudskiOpis.includes(String(u.nalog.tekst).trim().slice(0, 200))
    ? String(u.nalog.tekst) : ''

  const sastavi = (nalogMax: number, sazetakMax: number): string => {
    const kontekst: string[] = []
    if (nalogTekst && nalogMax > 0) kontekst.push(`Nalog${u.nalog?.id ? ` ${u.nalog.id}` : ''}: ${rezi(nalogTekst, nalogMax)}`)
    else if (!nalogTekst) kontekst.push('Nalog: opis iznad bloka.')
    if (u.chatSazetak && sazetakMax > 0) kontekst.push(`Razgovor (snimka pri otvaranju): ${rezi(String(u.chatSazetak).replace(/\s+/g, ' '), sazetakMax)}`)
    if (z.projectId) kontekst.push(`Projekt: ${z.projectId}`)
    kontekst.push(...povezani)
    const glava = `${PREDLOZAK_POCETAK}${u.nalog?.id ? ` nalog=${u.nalog.id}` : ''}${z.id ? ` zadatak=${z.id}` : ''} -->`
    return [
      glava,
      '## CILJ', cilj,
      '## KONTEKST', ...kontekst,
      '## ZADAĆE', ...zadace.map((t, i) => `${i + 1}. ${t}`),
      '## VJEŠTINE I ALATI', ...vjestineRedci,
      '## TIJEK', tijekRedak,
      '## GOTOVOST I DOKAZ', ...gotovost,
      PREDLOZAK_KRAJ,
    ].join('\n')
  }

  const bajt = (s: string) => Buffer.byteLength(s, 'utf-8')
  let blok = sastavi(NALOG_MAX, SAZETAK_MAX)
  // Rezanje redom: sažetak razgovora, pa nalog, pa oboje do nule.
  for (const [n, s] of [[NALOG_MAX, 300], [800, 200], [400, 0], [200, 0], [0, 0]] as Array<[number, number]>) {
    if (bajt(blok) <= BLOK_MAX) break
    blok = sastavi(n, s)
  }
  if (bajt(blok) > BLOK_MAX) upozorenja.push(`predložak je ${bajt(blok)} B (> ${BLOK_MAX}) i nakon rezanja konteksta`)

  return { oznake: [...new Set(noveOznake)], blok, upozorenja, workflow: wid, korak, obvezne }
}

// ─── Prekidač ────────────────────────────────────────────────────────────────

export type PredlozakNacin = 'off' | 'shadow' | 'on'
const NACINI: PredlozakNacin[] = ['off', 'shadow', 'on']

let _kes: { put: string; mtime: number; vel: number; v: PredlozakNacin } | null = null

/** Polje `predlozak` u workflow-gate.json. Nedostaje/neispravno → `shadow`, nikad tiho `on`. */
export function loadPredlozakNacin(o: { configPath?: string; force?: boolean } = {}): PredlozakNacin {
  const put = o.configPath || PREDLOZAK_CONFIG_PATH
  let mtime = -1, vel = -1
  try { const st = statSync(put); mtime = st.mtimeMs; vel = st.size } catch { /* nema datoteke */ }
  if (!o.force && _kes && _kes.put === put && _kes.mtime === mtime && _kes.vel === vel) return _kes.v
  let v: PredlozakNacin = 'shadow'
  try {
    if (existsSync(put)) {
      const n = String(JSON.parse(readFileSync(put, 'utf-8'))?.predlozak ?? '').trim().toLowerCase()
      if ((NACINI as string[]).includes(n)) v = n as PredlozakNacin
    }
  } catch { /* shadow */ }
  _kes = { put, mtime, vel, v }
  return v
}

// ─── Pogonski omotač ─────────────────────────────────────────────────────────

export interface PredlozakPloca {
  /** Upis opisa i oznaka (cijeli niz). Vraća je li uspjelo. */
  azuriraj: (taskId: string, u: { description: string; tags: string[] }) => boolean
  biljeska: (taskId: string, tekst: string) => void
}

export interface PredlozakOpcije {
  configPath?: string
  logPath?: string
  force?: boolean
  ploca?: PredlozakPloca
  log?: (poruka: string) => void
}

export interface PredlozakZapis {
  ts: string
  nacin: PredlozakNacin
  taskId: string | null
  workflow: string | null
  korak: string | null
  obvezne: string[]
  oznake: string[]
  upozorenja: string[]
  bajtova: number
  upisano: boolean
}

function smijePisati(logPath: string): boolean {
  if (!isTestRuntime()) return true
  return resolve(logPath) !== resolve(LIVE_PREDLOZAK_LOG_PATH)
}

/** Spoji oznake: nove `korak:n/uk` zamjenjuju gole `korak:n`; ništa se ne gubi ni ne duplira. */
export function spojiOznake(postojece: string[], nove: string[]): string[] {
  const imaKorakUk = nove.some(o => /^korak:\d+\/\d+$/.test(o))
  const zadrzane = oznakeNorm(postojece).filter(o => !(imaKorakUk && /^korak:\d+$/i.test(o)))
  const out = [...zadrzane]
  for (const o of nove) if (!out.some(x => x.toLowerCase() === o.toLowerCase())) out.push(o)
  return out
}

export function mozdaPredlozak(u: BriefUlaz, o: PredlozakOpcije = {}): PredlozakZapis | null {
  try {
    const nacin = loadPredlozakNacin({ configPath: o.configPath, force: o.force })
    if (nacin === 'off') return null
    const oznake = oznakeNorm(u.zadatak.oznake).map(x => x.toLowerCase())
    if (BEZ_PREDLOSKA_OZNAKE.some(b => oznake.includes(b))) return null
    if (!String(u.zadatak.naslov || '').trim()) return null

    const r = gradiPredlozak(u)
    let upisano = false
    if (nacin === 'on' && u.zadatak.id && o.ploca) {
      try {
        upisano = o.ploca.azuriraj(String(u.zadatak.id), {
          description: ugradiBlok(u.zadatak.opis, r.blok),
          tags: spojiOznake(u.zadatak.oznake || [], r.oznake),
        }) === true
        if (upisano && r.upozorenja.length) {
          o.ploca.biljeska(String(u.zadatak.id), `[PREDLOŽAK] ${r.upozorenja.join(' · ')}`)
        }
      } catch (e: any) {
        upisano = false
        try { (o.log || console.error)(`[PREDLOŽAK] upis nije uspio: ${e?.message || e}`) } catch { /* prazno */ }
      }
    }

    const zapis: PredlozakZapis = {
      ts: new Date().toISOString(), nacin,
      taskId: u.zadatak.id ? String(u.zadatak.id) : null,
      workflow: r.workflow,
      korak: r.korak ? `${r.korak.n}/${r.korak.ukupno}` : null,
      obvezne: r.obvezne, oznake: r.oznake, upozorenja: r.upozorenja,
      bajtova: Buffer.byteLength(r.blok, 'utf-8'), upisano,
    }
    const put = o.logPath || PREDLOZAK_LOG_PATH
    if (smijePisati(put)) {
      if (!existsSync(dirname(put))) mkdirSync(dirname(put), { recursive: true })
      appendFileSync(put, JSON.stringify(zapis) + '\n', 'utf-8')
    }
    return zapis
  } catch (e: any) {
    try { (o.log || console.error)(`[PREDLOŽAK] preskočen: ${e?.message || e}`) } catch { /* prazno */ }
    return null
  }
}

// ─── Povezani zadaci (ploča dovodi `getTask`) ───────────────────────────────

export interface PovezaniIzvor {
  title?: string | null
  assignee?: string | null
  resultSummary?: string | null
}

/**
 * Prethodni korak (`blockedBy`), nadzadatak (`parent:`) i zadatak koji se dorađuje
 * (`dorada-od:`), svaki s naslovom i jednim retkom rezultata. Nedostupan zadatak se preskače.
 */
export function povezaniZadaci(
  z: { oznake?: string[] | null; blockedBy?: string[] | null },
  getTask: (id: string) => PovezaniIzvor | null | undefined,
): BriefPovezani[] {
  const out: BriefPovezani[] = []
  const dodaj = (id: string, odnos: BriefPovezani['odnos']) => {
    const cist = String(id || '').trim().toUpperCase()
    if (!/^TASK-\d+$/.test(cist) || out.some(p => p.id === cist)) return
    let t: PovezaniIzvor | null | undefined = null
    try { t = getTask(cist) } catch { t = null }
    out.push({ id: cist, odnos, naslov: t?.title ?? null, agent: t?.assignee ?? null, rezultat: t?.resultSummary ?? null })
  }
  for (const b of z.blockedBy || []) dodaj(b, 'prethodni')
  for (const o of oznakeNorm(z.oznake)) {
    const m = o.match(/^(parent|dorada-od):(.+)$/i)
    if (m) dodaj(m[2], m[1].toLowerCase() === 'parent' ? 'nadzadatak' : 'dorada-od')
  }
  return out.slice(0, 5)
}

/** Iz izlaza `chatContextTail()` uzima samo teme i poruke, bez upute o sesiji. */
export function sazetakRazgovora(tail: string | null | undefined): string {
  const s = String(tail || '')
  if (!s.trim()) return ''
  const bez = s.replace(/^[\s\S]*?\n(?=\*\*)/, '').split('\n\nOvo NIJE ista sesija')[0]
  return bez.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
}
