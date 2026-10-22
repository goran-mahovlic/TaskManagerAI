/**
 * AgentRouting — prepoznavanje imena agenata u hrvatskoj rečenici (TASK-2637, R3).
 *
 * Jedan izvor istine za: „kojeg agenta korisnik izrijekom traži" i „tko još sudjeluje".
 * Koristi ga RegocDaemon (`classifyAndRoute`, `createSequentialHelpers`) i može ga koristiti
 * svaki drugi put rutiranja — bez dupliciranja regexa po datotekama.
 *
 * Zašto: keyword-rutiranje je „daj Grgi da napravi vizual" slalo Giti (keyword „vizual"),
 * jer stari regex hvata samo nominativ na početku poruke. Ovdje su pokriveni svi padeži
 * (Grga/Grge/Grgi/Grgu/Grgo) i glagoli dodjele (daj/zadaj/dodijeli/predaj/proslijedi/neka…),
 * a lažni pogoci (`git`, `gitlab`, `mandat`, `doradi`) su isključeni granicom riječi.
 *
 * Bez ovisnosti (čiste funkcije) → izravno testabilno: bun test tests/agent-routing.test.ts
 */

/** Oblici imena po agentu (nominativ/genitiv/dativ/akuzativ/vokativ/instrumental). REGOČ NIJE meta delegacije. */
const AGENT_FORMS: Record<string, RegExp> = {
  kosjenka: /kosjenk[aeiou]/,
  jelena: /jelen[aeiou]/,
  malik: /malik(?:om|a|u|e)?/,
  manda: /mand[aeiou]/,
  dora: /dor[aeiou]/,
  gita: /git[aeiou]/,
  grga: /grg[aeiou]/,
  potjeh: /potjeh(?:om|a|u|e)?/,
  klaudio: /klaudi(?:jem|ja|ju|jo|o)/,
  stribor: /stribor(?:om|a|u|e)?/,
  emard: /emard(?:om|a|u|e)?/,
}

/** Glagoli/veznici kojima korisnik dodjeljuje posao agentu („daj Grgi…", „neka Potjeh…"). */
const ASSIGN_CUE = '(?:daj(?:te)?|zadaj(?:te)?|dodijeli|dodjeli|delegiraj|proslijedi|prosljedi|predaj|po[sš]alji|zamoli|pitaj|reci|javi|nek(?:a)?|tra[zž]i\\s+od)'

/** Riječi koje najavljuju drugog agenta u istom zadatku (pomoć/predaja/nastavak). */
const HELPER_CUE = /pomo|poma[žz]|zajedno|asist|proslij|prosljed|predaj|preda\s|zatim|sljede|nastav|dorad/i

/** Tekstovi koje sustav sam generira za pomoćne taskove — ne smiju ponovno okinuti lanac (anti-kaskada). */
// TASK-255 (node-A, prijenos TASK-5323): dodan T1 tim-oblik i marker „Originalni zahtjev korisnika:" —
// prije je regex hvatao SAMO R2 oblik, pa je tim-opis proklizao i re-triggao lanac.
const HELPER_ECHO = /Sekvencijalni multi-agent|Multi-agent lanac \(sustav je sam rasporedio tim\)|Originalni zahtjev korisnika:|doradi rad \(/i

const ALL_AGENTS = Object.keys(AGENT_FORMS)

function anyFormSource(): string {
  return ALL_AGENTS.map(id => AGENT_FORMS[id].source).join('|')
}

/** Kojem agentu pripada pogođeni oblik imena. */
function agentOfForm(form: string): string | null {
  const f = form.toLowerCase()
  for (const id of ALL_AGENTS) {
    if (new RegExp(`^(?:${AGENT_FORMS[id].source})$`, 'i').test(f)) return id
  }
  return null
}

export interface ExplicitAgentMatch {
  /** id agenta iz REGOC_AGENTS.json */
  agent: string
  /** doslovan oblik imena iz poruke (npr. „Grgi") */
  form: string
  /** kako je prepoznat: 'pocetak' (ime na početku poruke) ili 'glagol' (daj/zadaj/neka + ime) */
  via: 'pocetak' | 'glagol'
}

/**
 * Vrati agenta kojeg je korisnik IZRIJEKOM imenovao (ili null).
 * Pravila (bira se ono koje se pojavi ranije u poruci):
 *   1. ime u bilo kojem padežu na POČETKU poruke — „Kosjenka, napravi plan", „Striboru pošalji…"
 *   2. glagol dodjele + (do 2 umetnute riječi) + ime — „daj Grgi da…", „zadaj Jeleni…", „neka Potjeh…"
 */
export function resolveExplicitAgent(content: string): ExplicitAgentMatch | null {
  const text = (content || '').trim()
  if (!text) return null

  const candidates: Array<{ index: number; form: string; via: 'pocetak' | 'glagol' }> = []

  const startRe = new RegExp(`^\\s*(${anyFormSource()})\\b`, 'i')
  const mStart = text.match(startRe)
  if (mStart) candidates.push({ index: 0, form: mStart[1], via: 'pocetak' })

  const cueRe = new RegExp(`\\b${ASSIGN_CUE}\\b(?:\\s+\\S+){0,2}\\s+(${anyFormSource()})\\b`, 'i')
  const mCue = text.match(cueRe)
  if (mCue && mCue.index !== undefined) candidates.push({ index: mCue.index, form: mCue[1], via: 'glagol' })

  candidates.sort((a, b) => a.index - b.index)
  for (const c of candidates) {
    const agent = agentOfForm(c.form)
    if (agent) return { agent, form: c.form, via: c.via }
  }
  return null
}

/** Svi agenti spomenuti u poruci (bilo koji padež), redoslijedom pojavljivanja, bez duplikata. */
export function findMentionedAgents(content: string): string[] {
  const text = content || ''
  const re = new RegExp(`\\b(${anyFormSource()})\\b`, 'gi')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const id = agentOfForm(m[1])
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/** Poruka najavljuje sudjelovanje/predaju drugom agentu („Gita pomaže", „pa daj Grgi"). */
export function hasHelperCue(content: string): boolean {
  const text = content || ''
  if (HELPER_CUE.test(text)) return true
  return new RegExp(`\\b${ASSIGN_CUE}\\b(?:\\s+\\S+){0,2}\\s+(?:${anyFormSource()})\\b`, 'i').test(text)
}

/** Sadržaj je sustavom generiran helper-opis (spriječi kaskadu helper→helper). */
export function isHelperEcho(content: string): boolean {
  return HELPER_ECHO.test(content || '')
}

/**
 * Svi agenti kojima je posao IZRIJEKOM dodijeljen glagolom dodjele („pa neka Potjeh provjeri”,
 * „zatim daj Maliku”), redom pojavljivanja, bez duplikata. Sam spomen imena („TASK-5116, Potjeh”)
 * NIJE dodjela (ADR-0018 §2.2, pravilo `izricito`).
 */
export function findAssignedAgents(content: string): string[] {
  const re = new RegExp(`\\b${ASSIGN_CUE}\\b(?:\\s+\\S+){0,2}?\\s+(${anyFormSource()})\\b`, 'gi')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(content || '')) !== null) {
    const id = agentOfForm(m[1])
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * Citati nisu nalozi: izreži `kod`, „…”, "…", '…' i “…” prije traženja dodjele (ADR-0018 §2.2).
 * Opis koji NAVODI primjer („testovi na 'zatim neka Malik pregleda'”) ne smije sam okinuti lanac.
 */
export function bezCitata(t: string): string {
  return (t || '').replace(/`[^`\n]*`|„[^”“\n]*[”“]|"[^"\n]*"|'[^'\n]*'|“[^”\n]*”/g, ' ')
}

/** Kanal i sustav nikad nisu radnici u lancu (ADR-0018 §2.1/§2.2). */
export const KANAL_I_SUSTAV = new Set(['klaudio', 'stribor', 'regoc', 'kriticar'])
/** Strop pomoćnika: 2, a uz izričitu dodjelu 3 (ADR-0018 §2.2). */
export const R2_STROP = 2
export const R2_STROP_IZRICITO = 3

/**
 * ADR-0018 F0b (TASK-5135): pomoćnici R2 lanca SAMO iz izričite dodjele — oznaka
 * `lanac:<a>[,<b>]` (prednost, redom) pa glagol dodjele + ime u tekstu bez citata.
 * Sam spomen imena („TASK-5116, Potjeh”, „agent_gita”) NIJE okidač. Kanal/sustav, primarni
 * agent i imena izvan registra oblika se odbacuju; strop je R2_STROP_IZRICITO.
 */
export function r2Pomocnici(content: string, tags: string[] | null | undefined, primaryAgent: string):
  { helpers: string[]; razlog: string; odbaceni: string[] } {
  const kandidati: Array<{ agent: string; izvor: string }> = []
  const odbaceni: string[] = []
  const dodaj = (a: string, izvor: string) => {
    if (!a || kandidati.some(k => k.agent === a) || odbaceni.includes(a)) return
    if (a === primaryAgent || KANAL_I_SUSTAV.has(a) || !AGENT_FORMS[a]) { odbaceni.push(a); return }
    kandidati.push({ agent: a, izvor })
  }
  for (const t of (Array.isArray(tags) ? tags : []).map(String).filter(t => /^lanac:/i.test(t))) {
    for (const a of t.slice(6).split(/[,\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean)) dodaj(a, t)
  }
  for (const a of findAssignedAgents(bezCitata(content))) dodaj(a, 'glagol dodjele + ime')
  const helpers = kandidati.slice(0, R2_STROP_IZRICITO).map(k => k.agent)
  for (const k of kandidati.slice(R2_STROP_IZRICITO)) odbaceni.push(k.agent)
  const izvori = [...new Set(kandidati.slice(0, R2_STROP_IZRICITO).map(k => k.izvor))]
  return { helpers, razlog: helpers.length ? `izričito: ${izvori.join(' + ')}` : 'nema izričite dodjele (spomen imena nije okidač)', odbaceni }
}

/**
 * TASK-4992 (premješteno iz RegocDaemon.ts radi jednog izvora, ADR-0018): vizualni zadatak.
 * `ui\b`/`ux\b` su namjerno izostavljeni — „TaskManager UI”, „WebUI” nisu posao za Gitu/Grgu.
 */
export const VISUAL_KEYWORDS_RE =
  /vizual|visual|slika|dijagram|diagram|ilustracij|ui\/ux|ux\/ui|ui\s+dizajn|ui\s+design|napravi\s+ui|mockup|wireframe|prezentacij|presentation|poster|grafik|icon\b|ikona|svg\b|png\b|excalidraw|artis|crtež|crtez/i

/** TASK-4992: sigurnosni zadatak (Malik). Premješteno iz RegocDaemon.ts (ADR-0018). */
export const SECURITY_KEYWORDS_RE =
  /security|sigurnost|ranjivost|vulnerability|cve\b|pentest|audit\b|owasp|threat|prijetnja|napad|exploit|injection|xss|csrf/i

export function isVisualTask(text: string): boolean {
  return VISUAL_KEYWORDS_RE.test(text || '')
}

export function isSecurityTask(text: string): boolean {
  return SECURITY_KEYWORDS_RE.test(text || '')
}

/** Izvoz za dijagnostiku/testove. */
export const _internals = { AGENT_FORMS, ASSIGN_CUE }
