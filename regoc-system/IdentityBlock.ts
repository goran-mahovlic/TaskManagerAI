/**
 * Blok identiteta agenta (I1 / TASK-3650).
 *
 * KVAR KOJI OVO ZATVARA: pri spawnu se od 26 polja registra u prompt prenosilo troje —
 * `name`, `role`, `communication_style` (+ popis putanja znanja). `skills`, `tools`,
 * `context_file`, `description` i `rag_collections` nisu se čitali NIJEDNOM
 * (`grep -c agent.skills RegocDaemon.ts` = 0). Agent tako nije mogao znati koje skillove
 * "ima": harness mu isporuči katalog svih 45 skillova bez oznake koji su njegovi.
 * Izmjereno (124 sesije, 25.08.–03.09.2026.): vlastito znanje čitano u 11,3 % sesija,
 * vlastita kontekstna datoteka u 0 %. Puni nalaz: §10 u ~/.tmp/IZVJESTAJ_ALATI_SKILLOVI_v2.md.
 *
 * ZAŠTO ODVOJEN MODUL: `RegocDaemon.ts` i `AgentDaemon.ts` nemaju `import.meta.main`
 * granu, pa se iz testa ne mogu učitati bez pokretanja daemona. Ovdje je čista logika,
 * pokrivena testovima — isti razlog i isti obrazac kao `PromptProjectBlock.ts`.
 *
 * ZAMKA S KEŠOM: blok je za istog agenta uvijek bajt-identičan (bez vremena, bez
 * nasumičnog redoslijeda). Ide na sistemski kanal (`--append-system-prompt`), koji je
 * po agentu stabilan, pa prefiks prompta i dalje dijeli keš.
 *
 * NEPOSTOJEĆE PUTANJE SE NE ISPORUČUJU. 17 od 46 putanja u `required_knowledge` ne
 * postoji na disku (cijeli `emard`, po dvije kod `gita`/`grga`). Uputa koja ne može
 * uspjeti troši povjerenje u sve ostale upute u istom promptu, pa ovaj modul propušta
 * samo ono što stvarno postoji, a broj ispuštenih navodi.
 */

import { popisRedci } from './RagCollections'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { buildToolkitSection, type ToolkitSelection } from './TaskToolkit'
import { homedir } from 'os'

const HOME = process.env.HOME || process.env.USERPROFILE || ''

/** Naslov bloka. Testovi, daemoni i QA provjera ga dijele — ne prepisuj ga rukom. */
export const IDENTITY_BLOCK_HEADING = '## TVOJ IDENTITET (izvor: REGOC_AGENTS.json)'

/** Gornja granica duljine bloka u znakovima. Preko toga se popis skillova krati. */
export const IDENTITY_BLOCK_MAX = 4000

/**
 * Naslov odsjeka s katalogom alata. Test i QA provjera ga dijele s modulom.
 */
export const TOOLS_SECTION_HEADING = '### Alati koje već imamo'

/**
 * Katalog postojećih alata — SKUPINE, ne popis (odluka Gorana, 03.09.2026.).
 *
 * KVAR KOJI OVO ZATVARA (R1 iz izvještaja TASK-3640): agenti 91,6 % posla obave Bashom,
 * a katalog alata ne stiže NIGDJE u prompt — `grep -c 'regoc_system/tools'` po cijelom
 * lancu spawna = 0. Šest dokazanih propuštenih prilika, gdje je agent rukom pisao ono
 * što već postoji: `webapp_screenshot.py`, `kicad_review.py`, `telegram_send_document.py`,
 * `transkript_arhiv.py`, `StaleCodeCheck.ts`, `session_usage.py`.
 *
 * ZAŠTO SKUPINE, NE SVIH 109: puni popis bi sam pojeo granicu `IDENTITY_BLOCK_MAX`
 * (blok je danas 670–1327 zn. po agentu). Skupina + mapa + 2–3 primjera daju agentu
 * dovoljno da pogodi `ls` u pravu mapu; ostalo nađe sam.
 *
 * SKUPINE SU ISTE ZA SVE AGENTE, pa su konstanta modula — ne gradi se po agentu.
 *
 * PRAVILO ODRŽAVANJA: svaka putanja navedena ovdje MORA postojati na disku. Uputa koja
 * ne može uspjeti troši povjerenje u sve ostale upute u istom promptu (isti razlog zbog
 * kojeg `required_knowledge` propušta samo postojeće putanje). Test
 * `tests/identity-block.test.ts` provjerava SVAKU putanju iz ovog kataloga na pravom
 * korijenu — ako alat preimenuješ ili makneš, test pukne umjesto agenta.
 *
 * IZVOR (ADR-0015, TASK-5106): skupine se više NE pišu rukom — generira ih `katalog md` iz
 * `~/.claude/regoc/catalog/katalog.json` u `catalog/tool_groups.json` (samo kanonski CLI sustava).
 * Ručni popis je upućivao na slabiju `kicad_review.py` i na krivo svrstan `ExtractTranscript.ts`
 * (INVENTURA_20261001 §4.5–4.6). Ispod je rezervna kopija (iste putanje, stanje 01.10.2026.) za
 * slučaj da generirana datoteka nedostaje ili ne prođe oblik — fail-safe, nikad prazan odsjek.
 */
type ToolGroup = { skupina: string; primjeri: string[] }

export const TOOL_GROUPS_REZERVA: ReadonlyArray<ToolGroup> = [
  { skupina: 'telemetrija i potrošnja', primjeri: [
    '~/.claude/regoc/tools/telemetrija/session_usage.py', '~/.claude/regoc/tools/telemetrija/tjedni_pregled.py',
    '~/.claude/regoc/tools/telemetrija/agent_telemetry.py'] },
  { skupina: 'transkripti i arhiv', primjeri: [
    '~/.claude/regoc/tools/transkripti/transkript_arhiv.py', '~/.claude/regoc/tools/telemetrija/run_tokens.py'] },
  { skupina: 'KiCad i sheme', primjeri: [
    '~/.claude/regoc/tools/hardver/kicad_review.py', '~/.claude/regoc/tools/hardver/kicad_netlist.py',
    '~/.claude/regoc/tools/hardver/pcb2sym.py'] },
  { skupina: 'dokumenti i PDF', primjeri: [
    '~/.claude/regoc/tools/dokumenti/md2pdf.py', '~/.claude/regoc/tools/dokumenti/mk-excalidraw.py',
    '~/.claude/regoc/tools/hardver/datasheet_extract.py'] },
  { skupina: 'Telegram i Nextcloud', primjeri: [
    '~/.claude/regoc/tools/telegram/tg_send.py', '~/.claude/regoc/tools/nextcloud/nc.py',
    '~/.claude/tools/Telegram/Telegram.ts'] },
  { skupina: 'RAG i znanje', primjeri: [
    '~/.claude/regoc/tools/rag/rag-query.ts', '~/.claude/regoc/tools/rag/rag-store.ts',
    '~/.claude/regoc/tools/rag/rag-list.ts'] },
  { skupina: 'stanje pogona i servisi', primjeri: [
    '~/.claude/regoc/StaleCodeCheck.ts', '~/.claude/regoc/regoc-services.sh',
    '~/.claude/regoc/tools/telemetrija/kpi-snapshot.sh'] },
  { skupina: 'web, modeli i snimke zaslona', primjeri: [
    '~/.claude/regoc/tools/web/webapp_screenshot/webapp_screenshot.py',
    '~/.claude/regoc/tools/modeli/consult-potjeh.ts'] },
  { skupina: 'katalog alata i karta sustava', primjeri: [
    '~/.claude/regoc/tools/katalog/katalog.py', '~/.claude/regoc/tools/katalog/system_map_check.py'] },
]

/** Generirane skupine iz kataloga; oblik se provjerava (7–10 skupina, 2–3 primjera), inače rezerva. */
export function ucitajToolGroups(put = join(process.env.HOME || homedir(), '.claude/regoc/catalog/tool_groups.json')): ReadonlyArray<ToolGroup> {
  try {
    const g = JSON.parse(readFileSync(put, 'utf-8'))
    const ok = Array.isArray(g) && g.length >= 7 && g.length <= 10 && g.every((x: any) =>
      typeof x?.skupina === 'string' && Array.isArray(x.primjeri) && x.primjeri.length >= 2 &&
      x.primjeri.length <= 3 && x.primjeri.every((p: unknown) => typeof p === 'string'))
    if (ok) return g
  } catch { /* nema datoteke ili nije JSON → rezerva */ }
  return TOOL_GROUPS_REZERVA
}

export const TOOL_GROUPS: ReadonlyArray<ToolGroup> = ucitajToolGroups()

/** Mapa u kojoj alati žive (ADR-0015: jedna mapa, domene kao podmape) — agent je otvara `ls`-om. */
export const TOOL_DIRS = ['~/.claude/regoc/tools'] as const

/** Odsjek s katalogom alata. Isti niz za svakog agenta (keš prefiksa ga voli). */
export function buildToolsSection(): string[] {
  const redci = [
    '',
    TOOLS_SECTION_HEADING,
    `Prije nego napišeš novu skriptu, pitaj katalog: \`katalog trazi <svrha>\` (popis: ~/.claude/regoc/catalog/KATALOG.md; mapa \`ls ${TOOL_DIRS.join(' ')}\`) — vjerojatno alat već postoji; ako postoji, NADOGRADI ga.`,
  ]
  for (const g of TOOL_GROUPS) redci.push(`- ${g.skupina}: ${g.primjeri.join(', ')}`)
  return redci
}

/**
 * Naslov odsjeka s VLASTITIM alatima agenta (ADR-0004 O4 / TASK-3671).
 * Test i QA provjera ga dijele s modulom — ne prepisuj ga rukom.
 */
export const OWN_TOOLS_SECTION_HEADING = '### Tvoji posebni alati'

/**
 * Odsjek s alatima KOJI SU TVOJI — iznad zajedničkog `TOOL_GROUPS` kataloga.
 *
 * KVAR KOJI OVO ZATVARA: `TOOL_GROUPS` je isti za svakoga, pa agentu kaže „ovo su svi
 * alati", nikad „ovo su tvoji". To je isti nalaz N2 zbog kojeg harness isporuči katalog
 * svih 45 skillova bez oznake čiji su — nerazlikovanje vlastitog od tuđeg. Polje `tools`
 * iz registra je jedino mjesto koje tu razliku zna, a do TASK-3671 ga nitko nije čitao
 * (`grep agent.tools` = 0 u pogonu; jedini je čitatelj bila ploča, i to samo za regoča).
 *
 * ZAŠTO TEK SADA: ADR-0004 O4 je slanje ovog polja izričito zabranio dok polje nije
 * normalizirano — od 32 imena razrješavalo se 14, jedno je vodilo u mrtav `HelpPipeline`,
 * a `regoc` je umjesto popisa imao kartu infrastrukture od ~2 KB. Uputa koja ne može
 * uspjeti troši povjerenje u sve ostale upute u istom promptu, a kanal
 * (`--append-system-prompt`) ima posluh ~100 %. Polje je normalizirano u TASK-3671;
 * branu drži `tools/verify-agent-tools.ts` (12/12) i test u `tests/identity-block.test.ts`.
 *
 * NEPOSTOJEĆE PUTANJE SE NE ISPORUČUJU — isto pravilo kao za `required_knowledge`.
 * Ne-putanje (program na PATH-u, ime skilla) prolaze; njih provjerava brana, ne prompt.
 */
export function buildOwnToolsSection(tools: string[] | undefined | null, home: string = HOME): string[] {
  const popis = (tools || [])
    .filter(t => typeof t === 'string' && t.trim() !== '')
    .filter(t => {
      if (t.startsWith('/')) return existsSync(t)
      if (t.startsWith('~/')) return existsSync(join(home, t.slice(2)))
      return true
    })
  if (popis.length === 0) return []
  return [
    '',
    `${OWN_TOOLS_SECTION_HEADING} (${popis.length}) — katalog niže je zajednički, ovo je tvoje`,
    ...popis.map(t => `- ${t}`),
  ]
}

/**
 * Redakcija za agente pod `security_isolation` (I9/TASK-3658).
 *
 * JEDAN IZVOR ISTINE: isti uzorci koje je dosad imao `UnifiedSpawnPipeline`
 * (koji ovo sada uvozi umjesto vlastite kopije). Dvije kopije redakcije znače
 * da jedna zaostane, a zaostala redakcija je gora od nikakve jer izgleda kao da radi.
 */
export function sanitizeForIsolation(content: string): string {
  let sanitized = content.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, '[REDACTED]')
  sanitized = sanitized.replace(/\blocalhost:\d+\b/g, '[REDACTED]')
  sanitized = sanitized.replace(/http:\/\/\[REDACTED\]/g, '[REDACTED]')
  sanitized = sanitized.replace(/(?:port|Port|PORT)\s*[:=]\s*\d+/g, 'port: [REDACTED]')
  sanitized = sanitized.replace(/(?:\/home\/\S+|~\/\S+)/g, '[PATH_REDACTED]')
  sanitized = sanitized.replace(/(?:password|credential|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, '[CREDENTIAL_REDACTED]')
  return sanitized
}

/**
 * Uzorci tajni koji NE SMIJU proći na sistemski kanal (I9/TASK-3658).
 *
 * ZAŠTO OVDJE, KAD REGISTAR DANAS NEMA TAJNU: `--append-system-prompt` stavlja blok u
 * `argv` (vidljiv u cmdlineu procesa, `ps`), u dijagnostičke dumpove spawna i u sesijski
 * transkript koji piše harness i koji se trajno arhivira. Sve troje je NEPOVRATNO —
 * tajna koja jednom prođe ovim kanalom ostaje na disku. Zato se blok provjerava PRIJE
 * slanja, a ne nakon incidenta: registar i `SKILL.md` frontmatter su obične datoteke
 * koje uređuju i agenti.
 */
const UZORCI_TAJNI: ReadonlyArray<{ ime: string; re: RegExp }> = [
  { ime: 'sk-/ghp-/AIza-token', re: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|hf_[A-Za-z0-9]{20,})/ },
  { ime: 'ključ=vrijednost', re: /(?:password|passwd|secret|token|api[_-]?key|bearer)\s*[:=]\s*['"]?[A-Za-z0-9_\-\/+]{12,}/i },
  { ime: 'privatni ključ', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

/** Ime prvog pogođenog uzorka tajne, ili `null`. NIKAD ne vraća samu vrijednost. */
export function secretPatternHit(text: string): string | null {
  for (const u of UZORCI_TAJNI) if (u.re.test(text)) return u.ime
  return null
}

export interface AgentEntry {
  id?: string
  name?: string
  full_name?: string
  role?: string
  description?: string
  communication_style?: string
  skills?: string[]
  /** ADR-0004 O4 / TASK-3671: ravan popis VLASTITIH alata (putanja, skill ili program). */
  tools?: string[]
  required_knowledge?: string[]
  context_file?: string
  /**
   * I9/TASK-3658: registar ovo polje nosi za `gita` i `grga` uz napomenu
   * „NE SMIJE znati: IP adrese, portove, putanje, šifre". Blok identiteta ide na
   * SISTEMSKI kanal, koji nijedan postojeći filtar ne dira — pa se pravilo mora
   * poštovati OVDJE, na mjestu gdje se blok sastavlja.
   */
  security_isolation?: boolean
  security_isolation_note?: string
}

export interface AgentRegistryLike {
  agents?: Record<string, AgentEntry>
  rag_collections?: Record<string, string>
}

export interface IdentityBlockOptions {
  /** Korijen korisnika (test ga preusmjerava u sandbox). */
  home?: string
  /**
   * Kolekcije za koje je POZIVATELJ provjerio da postoje. Bez ovoga se RAG redak
   * izostavlja — modul namjerno ne ide na mrežu (I6/TASK-3655 dovodi popis).
   */
  ragCollections?: Iterable<string>
  /** Gornja granica duljine (za testove). */
  maxLength?: number
  /**
   * ADR-0016 (TASK-5107): odabir vještina i alata PO ZADATKU (`TaskToolkit.selectToolkit`).
   * Kad je zadan, zamjenjuje statične odsjeke „Tvoji skillovi”, „Tvoji posebni alati” i
   * „Alati koje već imamo”. Pozivatelj ga daje samo u načinu `on`; bez njega blok je
   * bajt-identičan dosadašnjem.
   */
  toolkit?: ToolkitSelection | null
  /**
   * TASK-5159 (dizajn TASK-5158 §3.5): OBVEZNE vještine zadatka (iz oznaka `vjestina:*`).
   * Ne ovisi o prekidaču task-toolkit — dolazi iz tijeka, ne iz BM25 odabira.
   */
  obvezneVjestine?: string[] | null
  /** TASK-5159 R1: pozivatelj je provjerio da je `regoc_popis` dostupan (`popisDostupan()`). */
  regocPopis?: boolean
}

export const OBVEZNE_VJESTINE_HEADING = '### OBVEZNE vještine za ovaj zadatak'

export interface ResolvedKnowledge {
  /** Original iz registra, npr. `skills/CORE/CoreStack.md`. */
  raw: string
  /** Apsolutna putanja nakon proširenja korijena. */
  path: string
  exists: boolean
}

/**
 * Proširenje putanja znanja — JEDAN izvor istine za oba daemona.
 *
 * `RegocDaemon.buildAgentPrompt` je ovo radio ispravno, `AgentDaemon.buildPrompt` je
 * putanje ispisivao sirovo uz `cwd: HOME`, pa se `skills/CORE/CoreStack.md` razrješavao
 * u `~/skills/CORE/CoreStack.md` — na tom su putu SVE putanje znanja bile
 * nerješive (I3/TASK-3652).
 */
export function resolveKnowledgePaths(paths: string[] | undefined | null, home: string = HOME): ResolvedKnowledge[] {
  if (!paths || paths.length === 0) return []
  return paths.map(raw => {
    let path = raw
    if (raw.startsWith('skills/')) path = join(home, '.claude', raw)
    else if (raw.startsWith('regoc_system/')) path = join(home, 'app', raw)
    else if (raw.startsWith('HDL-GuideLines/')) path = join(home, 'fpga-AI-projects/ulx3s', raw)
    else if (raw.startsWith('~/')) path = join(home, raw.slice(2))
    return { raw, path, exists: existsSync(path) }
  })
}

/** Prva rečenica `description:` iz frontmattera skilla, skraćena. `null` ako SKILL.md nema. */
export function skillSummary(skill: string, home: string = HOME, maxLen = 150): string | null {
  const file = join(home, '.claude/skills', skill, 'SKILL.md')
  if (!existsSync(file)) return null
  try {
    const head = readFileSync(file, 'utf-8').slice(0, 4000)
    const m = /^description:\s*(.+?)\s*$/m.exec(head)
    if (!m) return null
    // Frontmatter zna biti u navodnicima i preko više redaka — uzima se prva rečenica.
    const clean = m[1].replace(/^["']|["']$/g, '').trim()
    const prva = clean.split(/(?<=\.)\s+(?=[A-ZČĆŠĐŽ])/)[0] || clean
    return prva.length > maxLen ? prva.slice(0, maxLen - 1).trimEnd() + '…' : prva
  } catch {
    return null
  }
}

/**
 * Gradi blok identiteta. Prazan niz = agent nije u registru (pozivatelj tada ne mijenja
 * ništa i ponaša se kao dosad — fail-safe, nikad iznimka).
 */
export function buildIdentityBlock(
  agentId: string,
  registry: AgentRegistryLike | null | undefined,
  opts: IdentityBlockOptions = {}
): string {
  const agent = registry?.agents?.[agentId]
  if (!agent) return ''

  const home = opts.home ?? HOME
  const maxLength = opts.maxLength ?? IDENTITY_BLOCK_MAX
  const zbirka = new Set(opts.ragCollections ? Array.from(opts.ragCollections) : [])
  // I9/TASK-3658: `gita` i `grga` po registru NE SMIJU vidjeti putanje. Odsjeci koji su
  // SAMO putanje (znanje, kontekstna datoteka, katalog alata) im se ne grade; ostatak
  // prolazi kroz `sanitizeForIsolation` kao mreža za slučaj da putanja uđe kroz `description`.
  const izoliran = agent.security_isolation === true

  const ime = agent.name || agentId
  const puno = agent.full_name && agent.full_name !== ime ? ` (${agent.full_name})` : ''
  const redci: string[] = [
    IDENTITY_BLOCK_HEADING,
    `Ti si **${ime}**${puno} — ${agent.role || 'agent REGOČ sustava'}.`,
  ]
  if (agent.description) redci.push(agent.description)
  if (agent.communication_style) redci.push(`Komunikacijski stil: ${agent.communication_style}.`)

  // ── TASK-5159: obvezne vještine koraka — PRIJE popisa vlastitih, jer su naredba, ne ponuda.
  const obvezne = (opts.obvezneVjestine || []).map(v => String(v).trim()).filter(v => /^[\w-]{1,40}$/.test(v))
  if (obvezne.length) {
    redci.push('', OBVEZNE_VJESTINE_HEADING)
    for (const v of obvezne) {
      redci.push(`Pozovi alatom \`Skill\` (\`${v}\`) PRIJE prvog koraka; ako je ne možeš učitati, radi po zamjeni iz opisa i to reci u rezultatu.`)
    }
  }

  // ── Skillovi: harness isporučuje katalog svih 45 bez oznake čiji su. Ovdje su TVOJI.
  const toolkit = opts.toolkit && (opts.toolkit.vjestine.length || opts.toolkit.alati.length) ? opts.toolkit : null
  const skills = toolkit ? [] : (agent.skills || []).filter(Boolean)
  if (toolkit) redci.push(...buildToolkitSection(toolkit, izoliran))
  if (skills.length > 0) {
    redci.push('')
    redci.push(`### Tvoji skillovi (${skills.length}) — ostali iz kataloga nisu tvoji`)
    redci.push(izoliran
      ? 'Pokreni ih alatom `Skill` (ime skilla je dovoljno — putanje ti nisu potrebne).'
      : 'Pokreni ih alatom `Skill`, ili pročitaj `~/.claude/skills/<Ime>/SKILL.md`.')
    for (const s of skills) {
      const sazetak = skillSummary(s, home)
      redci.push(sazetak ? `- **${s}** — ${sazetak}` : `- **${s}** (nema SKILL.md na disku)`)
    }
  }

  // ── Vlastita RAG memorija: samo ako je pozivatelj potvrdio da kolekcija postoji.
  const kolekcija = registry?.rag_collections?.[agentId]
  if (kolekcija && zbirka.has(kolekcija) && !izoliran) {
    redci.push('')
    redci.push('### Tvoja RAG memorija')
    redci.push(`- \`bun ~/.claude/skills/CORE/Tools/rag-query.ts -c ${kolekcija} -q "[tema]" -n 5\``)
  }

  // ── TASK-5159 R1: popis sustava (RAG-FIRST) — samo uz potvrdu pozivatelja, nikad izoliranima.
  if (opts.regocPopis === true && !izoliran) {
    redci.push('', ...popisRedci())
  }

  // ── Znanje: samo postojeće putanje, apsolutne.
  const znanje = izoliran ? [] : resolveKnowledgePaths(agent.required_knowledge, home)
  const postoji = znanje.filter(z => z.exists)
  const nedostaje = znanje.length - postoji.length
  if (postoji.length > 0) {
    redci.push('')
    redci.push('### Tvoje znanje (pročitaj prije rada)')
    for (const z of postoji) redci.push(`- ${z.path}`)
    if (nedostaje > 0) {
      // Hrvatska sklonidba uz broj: 1 → jednina, 2–4 → množina, 5+ → genitiv množine.
      const zadnja = nedostaje % 10, pretposljednja = nedostaje % 100
      const rijec = (zadnja === 1 && pretposljednja !== 11) ? 'putanja iz registra ne postoji na disku i namjerno je izostavljena'
        : (zadnja >= 2 && zadnja <= 4 && (pretposljednja < 12 || pretposljednja > 14)) ? 'putanje iz registra ne postoje na disku i namjerno su izostavljene'
        : 'putanja iz registra ne postoji na disku i namjerno su izostavljene'
      redci.push(`(${nedostaje} ${rijec}.)`)
    }
  }

  // ── Kontekstna datoteka: format izlaza koji registar propisuje, a kod ga dosad nije čitao.
  if (agent.context_file && !izoliran) {
    const cf = agent.context_file.startsWith('~/') ? join(home, agent.context_file.slice(2)) : agent.context_file
    if (existsSync(cf)) {
      redci.push('')
      redci.push(`### Tvoj kontekst i format izlaza\n- ${cf}`)
    }
  }

  // ── Katalog postojećih alata (I7/TASK-3656). Isti za sve agente — v. TOOL_GROUPS.
  if (izoliran) {
    redci.push('')
    redci.push('### Sigurnosna izolacija')
    redci.push(agent.security_isolation_note
      ? `Ti si u SECURITY ISOLATION modu. ${agent.security_isolation_note}. Ako ti za posao treba putanja, port ili adresa — zatraži ih porukom, ne pogađaj.`
      : 'Ti si u SECURITY ISOLATION modu — nemaš pristup putanjama, portovima ni adresama.')
  } else {
    // Redoslijed je propisan (ADR-0004 O4): najprije TVOJI alati, pa zajednički katalog.
    if (!toolkit) {
      redci.push(...buildOwnToolsSection(agent.tools, home))
      redci.push(...buildToolsSection())
    }
  }

  let blok = redci.join('\n')
  if (izoliran) blok = sanitizeForIsolation(blok)

  // I9/TASK-3658: fail-safe. Kanal je nepovratan (argv + dump + transkript), pa se blok
  // radije NE šalje nego da tajna trajno padne na disk. Oba pozivatelja hvataju iznimku
  // i spawnaju bez bloka — isto ponašanje kao kad agenta nema u registru.
  const tajna = secretPatternHit(blok)
  if (tajna) throw new Error(`blok identiteta odbijen: sadrži uzorak tajne (${tajna}) — provjeri REGOC_AGENTS.json i SKILL.md`)

  // Duljina: krati se popis skillova (najduži dio), nikad zaglavlje ni znanje.
  if (blok.length > maxLength) {
    const kratki = redci.map(r => (r.startsWith('- **') ? r.split(' — ')[0] : r))
    blok = kratki.join('\n')
    if (blok.length > maxLength) blok = blok.slice(0, maxLength - 1).trimEnd() + '…'
  }
  return blok
}
