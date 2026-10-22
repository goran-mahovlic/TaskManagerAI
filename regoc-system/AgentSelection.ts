/**
 * AgentSelection — korak „odabir” prije spawna (ADR-0018 §2.1–2.3, faza F1, TASK-5134).
 *
 * PITANJE KOJE OVO ZATVARA: nijedan korak do sada nije pitao *treba li* drugi agent. R2 lanac
 * (`createSequentialHelpers`) se palio na riječ-okidač + BILO KOJI spomen imena, pa je TASK-5114
 * dobio Potjeha zbog „(Goran ili Potjeh s vanjske mreže)”, a TASK-5121 zbog „(TASK-5116, Potjeh)”.
 * 86 pomoćnih zadataka u 30 dana, 22 % otkazano (ADR-0018 §1).
 *
 * ŠTO RADI: iz zadatka (naslov, opis, oznake, projekt, created_by, assignee) i registra
 * `REGOC_AGENTS.json` računa objekt `Odabir`:
 *   - primarni: ručni assignee se NE dira (`rucno`); inače izričita dodjela, pa bodovanje iz
 *     registra (BM25 iz `TaskToolkit` — isti tokenizer, upit i formula kao za vještine);
 *     kad pravila ne znaju (razlika vrha < 15 % ili zbroj 0) ostaje dosadašnja odluka (`zadano`);
 *   - lanac: SAMO po pravilu — QA-pogon, SIG-povrsina, izricito, tim-E5. Sam spomen nije okidač;
 *   - zastoNe: kandidati koji su ispali i zašto (za reviziju i mjerila M2/M4/M5);
 *   - vjestine: `TaskToolkit.selectToolkit` za primarnog („s čime” iz istog izvora).
 * Kanal i sustav (`klaudio`, `stribor`, `regoc`, `kriticar`) nikad nisu radnici.
 *
 * ČISTA FUNKCIJA, BEZ MREŽE: `odaberiAgenta` čita samo ono što mu se preda (+ katalog s diska
 * ako ga pozivatelj ne preda). Daemon u `shadow` načinu samo bilježi: bilješka `🧭 Odabir …`
 * na zadatak i redak u `data/odabir_agenta.jsonl`, jednom po zadatku. Spawn i lanac idu
 * STARIM putem dok F2 (`on`) ne prođe reviziju 13.10.2026.
 *
 * PREKIDAČ `settings.odabir.nacin` (off | shadow | on), audit u `settings_history` — isti obrazac
 * kao `memorija.*` (HindsightMemorija.ts). Pokvaren zapis ili kvar čitanja = `off`: uključenje
 * nikad nije posljedica kvara. `on` traži odobritelja (F2 čeka reviziju).
 *
 * CLI:  bun AgentSelection.ts nacin                       → trenutačni način
 *       bun AgentSelection.ts nacin shadow --by jelena     → promjena (audit)
 *       bun AgentSelection.ts probaj TASK-5114             → odabir za postojeći zadatak (ništa ne piše)
 *
 * Autorica: Jelena (Engineer) · 2026-10-02 · TASK-5134 · ADR-0018
 */

import { Database } from 'bun:sqlite'
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { ensureSettingsSchema } from './ConcurrencySetting'
import { bezCitata, findAssignedAgents, resolveExplicitAgent, isHelperEcho, isSecurityTask, isVisualTask, _internals as routingInternals } from './AgentRouting'
import { selectToolkit, loadCatalog, gradiIndeks, bm25, upit, loadPozadina, sadrzajneOznake, type CatalogItem, type TaskInfo } from './TaskToolkit'
import { getModeClassifier, type EffortTier } from './ModeClassifier'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()
export const ODABIR_LOG = join(HOME, '.claude/regoc/data/odabir_agenta.jsonl')
export const ODABIR_KLJUC = 'odabir.nacin'
const REGOC_DB = join(HOME, '.claude/regoc/data/regoc.db')

// ─── Tipovi ─────────────────────────────────────────────────────────────────

export type Izvor = 'rucno' | 'pravila' | 'klaudio' | 'model' | 'zadano'
export type Okidac = 'QA-pogon' | 'SIG-povrsina' | 'izricito' | 'tim-E5'
export type Pouzdanost = 'visoka' | 'srednja' | 'niska'

export interface Odabir {
  taskId: string | null
  izvor: Izvor
  primarni: string
  lanac: Array<{ agent: string; okidac: Okidac; razlog: string }>
  zastoNe: Array<{ agent: string; razlog: string }>
  vjestine: string[]
  razina: EffortTier | null
  pouzdanost: Pouzdanost
  pravila: string[]
  /** Kratko obrazloženje primarnog (ide u bilješku). */
  razlogPrimarnog: string
}

export interface ZadatakZaOdabir {
  id?: string | null
  title?: string | null
  description?: string | null
  tags?: string[] | null
  projectId?: string | null
  createdBy?: string | null
  assignee?: string | null
}

export interface RegistarAgent {
  id?: string; role?: string; description?: string; expertise?: unknown; skills?: string[]
  tools?: string[]; required_knowledge?: string[]; enabled?: boolean; [k: string]: unknown
}
export interface Registar { agents: Record<string, RegistarAgent> }

export interface OdabirUlaz {
  zadatak: ZadatakZaOdabir
  registar: Registar
  /** Katalog za vještine; zadano `loadCatalog()` s diska. */
  katalog?: CatalogItem[]
  /** Razina iz ModeClassifiera; zadano se računa ovdje (lokalno, bez mreže). */
  razina?: EffortTier | null
  /** Prijedlog tima (ModeClassifier.suggestedAgents) — samo za tim-E5. */
  timPrijedlog?: string[]
  /** Zastavica `teamChainLive` — bez nje tim-E5 nikad ne ulazi u lanac. */
  teamChainLive?: boolean
}

// ─── Konstante pravila ──────────────────────────────────────────────────────

/** Kanal i sustav — nikad radnici, ni kao primarni (pravila) ni u lancu (ADR-0018 §2.1). */
export const KANAL_I_SUSTAV = new Set(['klaudio', 'stribor', 'regoc', 'kriticar'])
/** Izvan lanca osim izričite dodjele: tajni FPGA specijalist (TASK-4992 crna lista). */
const SAMO_IZRICITO = new Set(['emard'])
/**
 * `created_by` čiji je assignee ručna odluka (§2.1.1): čovjek, REGOČ ili imenovani agent koji je
 * zadatak sam otvorio (npr. Kosjenkini J-zadatci). Strojni putovi bez odluke o osobi
 * (`regoc-chain`, `decomposer`, uvoz…) NISU ručni — za njih odlučuju pravila.
 */
const RUCNI_IZVORI = new Set(['goran', 'user', 'regoc', 'telegram'])
const MAX_LANAC = 2
const MAX_LANAC_IZRICITO = 3
/** Razlika vrha < 15 % → pravila ne znaju (§2.1.3). */
const PRAG_RAZLIKE = 0.15

/**
 * QA-pogon: imenovan DUGOTRAJNI proces sustava ili isporuka u pogon. Namjerno uže od
 * „port/restart/servis”: TASK-5114 („port 3090”) i TASK-5121 („restartao spremnik”) bi
 * inače dobili Potjeha na posve drugom poslu. Vlastita javna usluga ide kroz SIG-povrsina.
 * Generički „deploy” je izbačen: TASK-5089 (FPGA, „deploy na Pi” kao napomena o putanji) bi dobio QA.
 */
const POGON_RE = /\b(RegocDaemon(?:\.ts)?|AgentDaemon(?:\.ts)?|TaskWebUI(?:\.ts)?|TaskManagerSQL(?:\.ts)?|telegram_agent\w*|TelegramAgent\w*|MessageQueue(?:\.ts)?|spawnAgentOnDemand|createSequentialHelpers|classifyAndRoute|manage\.sh|regoc-services\.sh|restart-service|daemon(?:a|u|om)?)\b/i
/** Primarni MIJENJA kod (ne samo čita/analizira). */
const IZMJENA_RE = /\b(popravi\w*|ispravi\w*|izmijeni\w*|promijeni\w*|implementiraj\w*|dodaj\w*|dopiši|dopisi|zakrp\w*|refaktor\w*|uvedi|uvesti|spoji|preradi|napiši|napisi|izvedi|fix\w*|implement\w*|patch\w*)\b/i
/** Zadatak je sam QA → ne treba mu QA. */
const QA_RE = /^\s*(QA|test|testiraj|provjera|regresij)\b/i
/** Vanjska površina (§2.2 SIG-povrsina). */
const POVRSINA_RE = /funnel|tailscale|izvana|prema van|vanjsk\w*\s+mre\w*|javn\w*\s+(adres|uslug|port|poveznic|url)|0\.0\.0\.0|\bprijav\w*|\blogin\b|lozink\w*|\btajn\w*|\btoken\w*|credential\w*|\bovlast\w*/i
/** „Malik (zadatak koji slijedi)” — pratitelj je već zaseban, najavljen zadatak. */
const ZASEBNO_RE = /zadatak koji slijedi|zasebn\w*\s+zadat\w*|posebn\w*\s+zadat\w*|sljedeć\w*\s+zadat\w*|nov\w*\s+zadat\w*/i
const AUTO_DELEGACIJA_RE = /\[AUTO-DELEGACIJA od Klaudija\]/i

/** Signali teksta koje sustav već ima (TAG_AGENT_MAP, TASK-4992) — dodatak bodovanju iz registra. */
const SIGNALI: Array<{ agent: string; re: RegExp; bod: number; ime: string }> = [
  { agent: 'malik', re: /security|sigurnost|ranjivost|pentest|owasp|exploit|napad/i, bod: 4, ime: 'sigurnost' },
  { agent: 'gita', re: /dijagram|diagram|ilustracij|excalidraw|svg\b|png\b|poster|crte[žz]|slik[aeu]/i, bod: 3, ime: 'vizual' },
  { agent: 'grga', re: /ui\/ux|ux\/ui|ui\s+dizajn|mockup|wireframe|frontend|izgled stranic/i, bod: 3, ime: 'UI/UX' },
  { agent: 'manda', re: /istraž\w*|istraz\w*|research|izvor[ia]?\b|pretraž\w*|literatur/i, bod: 3, ime: 'istraživanje' },
  { agent: 'kosjenka', re: /arhitektur\w*|\bADR\b|dizajniraj sustav|plan izvedbe|architecture/i, bod: 3, ime: 'arhitektura' },
  { agent: 'dora', re: /analiz\w* iz više|više perspektiv|multi-perspektiv|first principles|usporedi opcije/i, bod: 3, ime: 'analiza' },
  { agent: 'potjeh', re: /^\s*(QA|test)\b|regresij\w*|testiraj|e2e/i, bod: 3, ime: 'QA' },
  { agent: 'emard', re: /\bfpga\b|verilog|gatemate|ulx[35]|yosys|nextpnr/i, bod: 4, ime: 'FPGA' },
  { agent: 'jelena', re: /\.(ts|py|js|sh)\b|typescript|implementiraj|popravi|\bbug\b|pogreš\w*|greš\w*|\bkod\w*\b|\bTDD\b|\bCLI\b/i, bod: 3, ime: 'kod' },
]

// ─── Pomoćne ────────────────────────────────────────────────────────────────

const jeRadnik = (id: string, reg: Registar) => !!reg.agents?.[id] && !KANAL_I_SUSTAV.has(id) && reg.agents[id].enabled !== false

export function jeAutoDelegacija(z: ZadatakZaOdabir): boolean {
  return AUTO_DELEGACIJA_RE.test(`${z.title || ''}\n${z.description || ''}`) || (z.createdBy || '') === 'klaudio'
}

/** Dio auto-delegacije koji je rekao ČOVJEK. Klaudijeva proza („Klaudijev nalog: …”) je objašnjenje, ne dodjela (§2.4.4). */
export function korisnikovZahtjev(opis: string): string {
  const m = /Korisnikov zahtjev:\s*([\s\S]*?)(?:\n\s*Klaudijev nalog:|\n---|$)/i.exec(opis || '')
  return (m ? m[1] : '').replace(/\[OD:[^\]]*\]/g, '').trim()
}

/** REGOČ-ov okvir opisa („## Originalni zahtjev od: …”, „**Zašto:** …”) nije sadržaj zadatka. */
function bezOkvira(t: string): string {
  return (t || '').split('\n').filter(l => !/^\s*(## Originalni zahtjev od:|\*\*Zašto:\*\*)/.test(l)).join('\n').replace(/\[OD:[^\]]*\]/g, '')
}

/** Tekst nad kojim pravila odlučuju. Za auto-delegaciju samo korisnikov zahtjev. */
export function radniTekst(z: ZadatakZaOdabir): string {
  if (jeAutoDelegacija(z)) return korisnikovZahtjev(z.description || '') || korisnikovZahtjev(z.title || '')
  return bezOkvira(`${z.title || ''}\n${z.description || ''}`)
}

/**
 * Citat nije nalog: TASK-5135 opisuje test „'zatim neka Malik pregleda' (lanac)” — primjer u
 * navodnicima ili `kodu` ne smije dodijeliti Malika samom zadatku koji ga opisuje.
 */
export { bezCitata }

/** Je li agent u tekstu najavljen kao ZASEBAN zadatak („Malik (zadatak koji slijedi)”). */
function najavljenZasebno(tekst: string, agent: string): boolean {
  const oblik = routingInternals.AGENT_FORMS[agent]
  if (!oblik) return false
  const re = new RegExp(`\\b(?:${oblik.source})\\b[^.\\n]{0,40}?(?:${ZASEBNO_RE.source})|(?:${ZASEBNO_RE.source})[^.\\n]{0,40}?\\b(?:${oblik.source})\\b`, 'i')
  return re.test(tekst)
}

const kratko = (s: string, n = 60) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }

/** Profil agenta iz registra (uloga, opis, stručnost, vještine, alati, znanje) — tekst za BM25. */
function profilAgenta(a: RegistarAgent): string {
  const baza = (p: string) => p.split('/').pop()!.replace(/\.(md|ts|py|sh)$/, '').replace(/[_-]/g, ' ')
  const exp = Array.isArray(a.expertise) ? a.expertise.join(' ') : typeof a.expertise === 'string' ? a.expertise : ''
  const sk = (a.skills || []).filter(s => s !== 'CORE').map(s => s.replace(/([a-z])([A-Z])/g, '$1 $2'))
  return [a.role, a.role, a.description, exp, ...sk, ...(a.tools || []).map(baza), ...(a.required_knowledge || []).map(baza)].filter(Boolean).join(' ')
}

/** Bodovi po radniku: BM25 nad profilom iz registra (isti upit kao TaskToolkit) + signali teksta. */
export function bodujAgente(z: ZadatakZaOdabir, tekst: string, reg: Registar): Array<{ agent: string; bod: number; razlog: string }> {
  const ids = Object.keys(reg.agents || {}).filter(id => jeRadnik(id, reg))
  const idx = gradiIndeks(ids, id => profilAgenta(reg.agents[id]))
  const q = upit({ title: '', description: tekst, tags: z.tags || [], projectId: z.projectId }, loadPozadina())
  const sig = SIGNALI.filter(s => s.re.test(tekst))
  return idx.docs.map(d => {
    const { bod, pogoci } = bm25(q, idx, d)
    const s = sig.filter(x => x.agent === d.item)
    const b = bod + s.reduce((acc, x) => acc + x.bod, 0)
    const razlog = [s.map(x => x.ime).join(', '), pogoci.length ? `registar: ${pogoci.slice(0, 3).join(', ')}` : ''].filter(Boolean).join(' · ')
    return { agent: d.item, bod: Math.round(b * 100) / 100, razlog }
  }).sort((a, b) => b.bod - a.bod || a.agent.localeCompare(b.agent))
}

// ─── Odabir ─────────────────────────────────────────────────────────────────

export function odaberiAgenta(ulaz: OdabirUlaz): Odabir {
  const { zadatak: z, registar: reg } = ulaz
  const tags = (z.tags || []).map(t => String(t).trim())
  const auto = jeAutoDelegacija(z)
  const tekst = radniTekst(z)
  const pravila: string[] = []
  const zastoNe: Odabir['zastoNe'] = []
  const ne = (agent: string, razlog: string) => { if (!zastoNe.some(x => x.agent === agent)) zastoNe.push({ agent, razlog }) }

  let razina: EffortTier | null = ulaz.razina ?? null
  let timPrijedlog = ulaz.timPrijedlog
  if (razina === null || !timPrijedlog) {
    try {
      const cls = getModeClassifier().classify({ title: auto ? tekst : (z.title || ''), description: auto ? '' : bezOkvira(z.description || ''), tags })
      if (razina === null) razina = cls.effort
      if (!timPrijedlog) timPrijedlog = cls.suggestedAgents
    } catch {}
  }

  // ── Primarni
  const assignee = (z.assignee || '').trim().toLowerCase() || null
  const bodovi = bodujAgente(z, tekst, reg)
  let izvor: Izvor
  let primarni: string
  let pouzdanost: Pouzdanost
  let razlogPrimarnog: string
  const izricitPrimarni = resolveExplicitAgent(tekst)
  if (assignee && !auto && (RUCNI_IZVORI.has(z.createdBy || '') || !!reg.agents?.[z.createdBy || ''])) {
    izvor = 'rucno'; primarni = assignee; pouzdanost = 'visoka'; razlogPrimarnog = `ručno (${z.createdBy})`
    pravila.push('rucno')
  } else if (izricitPrimarni && jeRadnik(izricitPrimarni.agent, reg)) {
    izvor = 'pravila'; primarni = izricitPrimarni.agent; pouzdanost = 'visoka'
    razlogPrimarnog = `izričito imenovan („${izricitPrimarni.form}”, ${izricitPrimarni.via})`
    pravila.push('primarni:izricito')
  } else {
    const [prvi, drugi] = bodovi
    const razlika = prvi && prvi.bod > 0 ? (prvi.bod - (drugi?.bod || 0)) / prvi.bod : 0
    const zadani = assignee && jeRadnik(assignee, reg) ? assignee : null
    if (!prvi || prvi.bod <= 0 || razlika < PRAG_RAZLIKE) {
      // Pravila ne znaju → dosadašnja odluka routera (F3 tek ako M5 pokaže da se model isplati).
      izvor = 'zadano'; pouzdanost = 'niska'
      primarni = zadani || prvi?.agent || 'jelena'
      razlogPrimarnog = prvi && prvi.bod > 0 ? `pravila ne razlikuju ${prvi.agent}/${drugi?.agent} (${Math.round(razlika * 100)} %)` : 'nema signala u tekstu'
      pravila.push('primarni:zadano')
    } else {
      izvor = 'pravila'; primarni = prvi.agent
      pouzdanost = razlika >= 0.5 ? 'visoka' : 'srednja'
      razlogPrimarnog = prvi.razlog || 'bodovanje registra'
      pravila.push('primarni:bodovanje')
    }
    if (auto && assignee && jeRadnik(assignee, reg) && izvor === 'zadano') izvor = 'klaudio'
    if (assignee && KANAL_I_SUSTAV.has(assignee)) ne(assignee, 'kanal/sustav, ne radnik')
  }

  // ── Lanac (§2.2): samo po pravilu
  const nalog = tags.some(t => t.toLowerCase() === 'nalog')
  const odjek = isHelperEcho(`${z.title || ''}\n${z.description || ''}`)
  const kandidati: Odabir['lanac'] = []
  const dodaj = (agent: string, okidac: Okidac, razlog: string) => {
    if (agent === primarni) return
    if (KANAL_I_SUSTAV.has(agent)) { ne(agent, `${okidac}: kanal/sustav, ne radnik`); return }
    if (!reg.agents?.[agent]) { ne(agent, `${okidac}: nije u registru`); return }
    if (SAMO_IZRICITO.has(agent) && okidac !== 'izricito') { ne(agent, `${okidac}: samo uz izričitu dodjelu`); return }
    if (kandidati.some(k => k.agent === agent)) return
    kandidati.push({ agent, okidac, razlog })
  }
  // izricito: oznaka lanac:<a>[,<b>] ili glagol dodjele + ime (nikad Klaudijeva proza — tekst je već samo zahtjev)
  for (const t of tags.filter(t => /^lanac:/i.test(t))) {
    for (const a of t.slice(6).split(/[,\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean)) dodaj(a, 'izricito', `oznaka ${t}`)
  }
  for (const a of findAssignedAgents(bezCitata(tekst))) dodaj(a, 'izricito', 'glagol dodjele + ime u zahtjevu')
  // QA-pogon
  const pogon = POGON_RE.exec(tekst)
  const qaKandidat = !!pogon && IZMJENA_RE.test(tekst) && !QA_RE.test(z.title || '') && primarni !== 'potjeh'
  // SIG-povrsina
  const povrsina = POVRSINA_RE.exec(tekst)
  // Oznake nose temu („sigurnost”, „docuseal”) — za prepoznavanje sigurnosnog/vizualnog zadatka vrijede kao tekst.
  const tema = `${tekst}\n${sadrzajneOznake(tags).filter(t => !/^(lanac|nalog|skill|alat):?/i.test(t)).join(' ')}`
  const sigKandidat = isSecurityTask(tema) && !!povrsina && primarni !== 'malik'
  const pravilni: Array<[string, Okidac, string]> = []
  if (qaKandidat) pravilni.push(['potjeh', 'QA-pogon', `${primarni} dira ${pogon![0]} (dugotrajni proces) — provjeri u pogonu (PID, StaleCodeCheck, ponašanje)`])
  if (sigKandidat) pravilni.push(['malik', 'SIG-povrsina', `sigurnost + vanjska površina („${povrsina![0]}”) — pregled ulaza, tajni, ovlasti`])
  if (razina === 'E5' && ulaz.teamChainLive) {
    const viz = isVisualTask(tema), sig = isSecurityTask(tema)
    for (const a of timPrijedlog || []) {
      if ((a === 'gita' || a === 'grga') && !viz) { ne(a, 'tim-E5: nije vizualni zadatak'); continue }
      if (a === 'malik' && !sig) { ne(a, 'tim-E5: nije sigurnosni zadatak'); continue }
      pravilni.push([a, 'tim-E5', `E5 tim: ${reg.agents?.[a]?.role || a}`])
    }
  } else if (razina === 'E5' && (timPrijedlog || []).length) {
    pravila.push('tim-E5:ugaseno')
  }
  for (const [a, okidac, razlog] of pravilni) {
    if (odjek) { ne(a, `${okidac}: sustavni odjek lanca — bez novog lanca`); continue }
    if (nalog) { ne(a, `${okidac}: zadatak je nalog — bez automatskog lanca`); continue }
    if (najavljenZasebno(tekst, a)) { ne(a, `${okidac}: već najavljen kao zaseban zadatak`); continue }
    dodaj(a, okidac, razlog)
  }
  const imaIzricito = kandidati.some(k => k.okidac === 'izricito')
  const strop = imaIzricito ? MAX_LANAC_IZRICITO : MAX_LANAC
  const lanac = odjek ? [] : kandidati.slice(0, strop)
  for (const k of kandidati.slice(strop)) ne(k.agent, `${k.okidac}: strop lanca ${strop}`)
  if (odjek) for (const k of kandidati) ne(k.agent, `${k.okidac}: sustavni odjek lanca`)
  for (const l of lanac) if (!pravila.includes(l.okidac)) pravila.push(l.okidac)
  // Spomenuti, a nedodijeljeni agenti — vidljivo ZAŠTO nisu ušli (stari R2 bi ih uzeo).
  for (const a of mentioned(tekst)) if (a !== primarni && !lanac.some(l => l.agent === a)) ne(a, 'samo spomenut — spomen nije dodjela')

  // Razlozi pravila imaju prednost; bodovanje se dopisuje samo za one koji još nemaju razlog.
  for (const b of bodovi.slice(0, 4)) if (b.agent !== primarni && b.bod > 0) ne(b.agent, `manje bodova (${b.bod}${b.razlog ? `: ${b.razlog}` : ''})`)

  // ── Vještine: isti izvor kao alati po zadatku (ADR-0016)
  let vjestine: string[] = []
  try {
    const info: TaskInfo = { id: z.id ?? null, title: z.title, description: z.description, tags, projectId: z.projectId }
    vjestine = selectToolkit(info, primarni, reg.agents?.[primarni] as any, ulaz.katalog ?? loadCatalog()).vjestine.map(v => v.ime)
  } catch {}

  return { taskId: z.id ?? null, izvor, primarni, lanac, zastoNe, vjestine, razina, pouzdanost, pravila, razlogPrimarnog }
}

function mentioned(tekst: string): string[] {
  const forms = routingInternals.AGENT_FORMS
  const out: string[] = []
  for (const [id, re] of Object.entries(forms)) if (new RegExp(`\\b(?:${re.source})\\b`, 'i').test(tekst)) out.push(id)
  return out
}

// ─── Bilješka i zapis (§2.3) ────────────────────────────────────────────────

export function formatBiljeska(o: Odabir, max = 700): string {
  const sk = o.vjestine.length ? ` (skills ${o.vjestine.join(', ')})` : ''
  const lanac = o.lanac.length ? o.lanac.map(l => `${l.agent} (${l.okidac}: ${kratko(l.razlog, 70)})`).join(', ') : '—'
  const ne = o.zastoNe.slice(0, 4).map(z => `${z.agent} (${kratko(z.razlog, 50)})`).join(', ')
  const b = `🧭 Odabir [${o.izvor}, ${o.pouzdanost}]: ${o.primarni} — ${kratko(o.razlogPrimarnog, 80)}${sk} · razina ${o.razina ?? '?'} · lanac: ${lanac}${ne ? ` · zašto ne: ${ne}` : ''}`
  return b.length > max ? b.slice(0, max - 1) + '…' : b
}

/** Je li za zadatak odabir već zapisan (pri prvom spawnu se piše, kasnije ne). */
export function vecOdabrano(taskId: string, put: string = ODABIR_LOG): boolean {
  try {
    if (!existsSync(put)) return false
    return readFileSync(put, 'utf-8').includes(`"task":${JSON.stringify(taskId)}`)
  } catch { return false }
}

/** Jedan JSON redak po zadatku; nikad ne baca. */
export function zapisiOdabir(o: Odabir, nacin: Nacin, extra: Record<string, unknown> = {}, put: string = ODABIR_LOG): void {
  try {
    appendFileSync(put, JSON.stringify({ ts: new Date().toISOString(), task: o.taskId, nacin, ...extra, odabir: o }) + '\n')
  } catch {}
}

export function zadatakIzRetka(r: { id?: string; title?: string | null; description?: string | null; tags?: string | null; project_id?: string | null; created_by?: string | null; assignee?: string | null } | null | undefined): ZadatakZaOdabir | null {
  if (!r) return null
  let tags: string[] = []
  try { const t = JSON.parse(r.tags || '[]'); if (Array.isArray(t)) tags = t.map(String) } catch {}
  return { id: r.id ?? null, title: r.title ?? '', description: r.description ?? '', tags, projectId: r.project_id ?? null, createdBy: r.created_by ?? null, assignee: r.assignee ?? null }
}

// ─── Prekidač odabir.nacin (obrazac memorija.*) ─────────────────────────────

export type Nacin = 'off' | 'shadow' | 'on'
const NACINI: readonly Nacin[] = ['off', 'shadow', 'on']
const jeNacin = (v: unknown): v is Nacin => typeof v === 'string' && (NACINI as readonly string[]).includes(v)

export function parseOdabirNacin(raw: unknown): { ok: true; value: Nacin } | { ok: false; error: string } {
  return jeNacin(raw) ? { ok: true, value: raw } : { ok: false, error: `odabir.nacin mora biti off | shadow | on (dobio '${String(raw)}')` }
}

export interface OdabirPostavka { nacin: Nacin; izvor: 'settings' | 'default'; updatedBy: string | null; updatedAt: string | null }

/** Kvar čitanja, nepostojeći ili pokvaren zapis = `off` (fail-open prema STAROM ponašanju). */
export function getOdabirNacin(db: Database): OdabirPostavka {
  try {
    const r = db.query('SELECT value, updated_by, updated_at FROM settings WHERE key = ?').get(ODABIR_KLJUC) as { value: string; updated_by: string; updated_at: string } | null
    if (r && jeNacin(r.value)) return { nacin: r.value, izvor: 'settings', updatedBy: r.updated_by, updatedAt: r.updated_at }
  } catch {}
  return { nacin: 'off', izvor: 'default', updatedBy: null, updatedAt: null }
}

/** Promjena uz audit. Baca na nevaljan ulaz (ništa se ne upisuje); `on` traži odobritelja (F2). */
export function setOdabirNacin(db: Database, raw: unknown, by: string, source = 'cli', odobrio?: string | null): { staro: Nacin | null; novo: Nacin; changed: boolean } {
  const p = parseOdabirNacin(raw)
  if (!p.ok) throw new Error(p.error)
  if (p.value === 'on' && !(typeof odobrio === 'string' && odobrio.trim())) {
    throw new Error('`on` (lanac samo iz odabira, F2) samo uz odobrenje nakon revizije — pošalji odobritelja')
  }
  ensureSettingsSchema(db)
  const who = (by || 'unknown').slice(0, 64)
  const src = (p.value === 'on' ? `${source};odobrio=${odobrio!.trim()}` : source).slice(0, 64)
  let staro: Nacin | null = null
  db.transaction(() => {
    const cur = getOdabirNacin(db)
    staro = cur.izvor === 'settings' ? cur.nacin : null
    db.query(`INSERT INTO settings(key, value, updated_by, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(ODABIR_KLJUC, p.value, who)
    db.query('INSERT INTO settings_history(key, old_value, new_value, changed_by, source) VALUES (?, ?, ?, ?, ?)')
      .run(ODABIR_KLJUC, staro, p.value, who, src)
  })()
  return { staro, novo: p.value, changed: staro !== p.value }
}

let nacinKes: { t: number; v: Nacin } | null = null
/** Za daemon: čita regoc.db, keš ≤ 5 s. Kvar = `off`. */
export function odabirNacin(dbPut: string = REGOC_DB): Nacin {
  if (nacinKes && Date.now() - nacinKes.t < 5000) return nacinKes.v
  let v: Nacin = 'off'
  try { const db = new Database(dbPut, { readonly: true }); try { v = getOdabirNacin(db).nacin } finally { db.close() } } catch {}
  nacinKes = { t: Date.now(), v }
  return v
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [cmd, arg, ...ostalo] = process.argv.slice(2)
  const opt = (k: string) => { const i = ostalo.indexOf(k); return i >= 0 ? ostalo[i + 1] : undefined }
  if (cmd === 'nacin') {
    const db = new Database(REGOC_DB)
    if (arg) console.log(JSON.stringify(setOdabirNacin(db, arg, opt('--by') || 'cli', 'cli', opt('--odobrio'))))
    console.log(JSON.stringify(getOdabirNacin(db)))
  } else if (cmd === 'probaj' && arg) {
    const db = new Database(REGOC_DB, { readonly: true })
    const z = zadatakIzRetka(db.query('SELECT id, title, description, tags, project_id, created_by, assignee FROM tasks WHERE id = ?').get(arg) as any)
    if (!z) { console.error(`nema zadatka ${arg}`); process.exit(1) }
    const registar = JSON.parse(readFileSync(join(HOME, '.claude/regoc/REGOC_AGENTS.json'), 'utf-8'))
    const o = odaberiAgenta({ zadatak: z, registar })
    console.log(formatBiljeska(o)); console.log(JSON.stringify(o, null, 1))
  } else {
    console.log('bun AgentSelection.ts nacin [off|shadow|on] [--by ime] [--odobrio ime] | probaj TASK-ID')
  }
}
