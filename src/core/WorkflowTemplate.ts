/**
 * WorkflowTemplate — PREDLOŽAK PRVOG ZADATKA (U4 / TASK-4264).
 *
 * Razrada: `RAZRADA-3691_workflow_i_pragovi.md` (repozitorij sustava, nije u paketu) §4.
 *
 * ŠTO OVO RJEŠAVA. Zadatak koji nastane iz vlasnikove poruke dosad je dobivao samo naslov i
 * prepričan tekst. Što će se s njim raditi odlučivao je model u trenutku spawna — pa je isti
 * oblik posla svaki put išao drugim putem: nekad s istraživanjem, nekad bez, nekad s granom,
 * najčešće bez ijednog commita. Mjereno (A4/MergeGate): samo 1,4 % zadataka uopće dodiruje git
 * repozitorij. Ovdje popis koraka postaje FIKSAN i determinističan — nastaje BEZ MODELA, iz
 * težine i konfiguracije, i upisuje se u opis zadatka pri otvaranju.
 *
 * ZAŠTO U OPIS, A NE U PROMPT. Prompt živi jedan spawn; opis zadatka živi koliko i zadatak i
 * vidi ga svaki sljedeći izvršitelj, čovjek na ploči i vratar pri zatvaranju. Isti razlog zbog
 * kojeg `parent:<ID>` stoji u oznakama, a ne u memoriji daemona.
 *
 * ŠTO OVAJ MODUL NIJE: ne klasificira težinu (to rade `ModeClassifier`/`TaskTier`), ne stvara
 * zadatke (to radi `tools/lanac-otvori.ts` preko API-ja) i ne zove nijedan model.
 *
 * SSOT teksta koraka 2 je `ResearchRagGate.RESEARCH_STEP_OUTPUT_SPEC` — ovdje se UVOZI, ne
 * prepisuje (pravilo iz ADR-0004: pravilo u dvije kopije prestaje biti isto pravilo).
 *
 * Autorica: Kosjenka (Architect), TASK-4264.
 */

import { RESEARCH_STEP_OUTPUT_SPEC } from './ResearchRagGate'

// ─── Rječnik ─────────────────────────────────────────────────────────────────

/** Oznaka koju nosi svaki zadatak otvoren po ovom predlošku. Doseg vratara git-commita. */
export const CHAIN_TAG = 'lanac'

/**
 * Oznaka „samo tekst" iz koraka 4 — zadatak koji po prirodi ne ostavlja commit
 * (odgovor, procjena, razgovor). Jedini izlaz iz obveze git-commita.
 */
export const TEXT_ONLY_TAG = 'samo-tekst'

/** Inačice koje ploča već nosi (uvoz s Telegrama piše `razgovor`). */
export const TEXT_ONLY_TAG_ALIASES = [
  'samo-tekst', 'samo tekst', 'samotekst', 'text-only', 'razgovor',
] as const

export function isTextOnly(tags?: string[] | null): boolean {
  if (!Array.isArray(tags)) return false
  const wanted = new Set<string>(TEXT_ONLY_TAG_ALIASES as readonly string[])
  return tags.some(t => wanted.has(String(t).trim().toLowerCase()))
}

export function isChainTask(tags?: string[] | null): boolean {
  if (!Array.isArray(tags)) return false
  return tags.some(t => String(t).trim().toLowerCase() === CHAIN_TAG)
}

// ─── Git (razrada §4: obavezno i mjerljivo) ──────────────────────────────────

/**
 * Identitet u commitima. NIKAD `Co-Authored-By`.
 *
 * ADR-0001 O1.3: prije je ovdje kao KONSTANTA stajalo ime i e-pošta autora ovog paketa —
 * pa bi se tuđi rad potpisivao njegovim identitetom. Sada je to konfiguracija bez zadane
 * vrijednosti: `TM_GIT_NAME` / `TM_GIT_EMAIL` (ili `git.identity` u `orchestrator.json`).
 * Bez njih se `git config` NE dira i nasljeđuje se korisnikov globalni identitet.
 */
export const GIT_IDENTITY: { name: string; email: string } = {
  name: process.env.TM_GIT_NAME || '',
  email: process.env.TM_GIT_EMAIL || '',
}

/** Je li identitet zadan? Ako nije, naredbe idu bez `-c user.*` (ADR-0001 O1.3). */
export function imaGitIdentitet(): boolean {
  return !!(GIT_IDENTITY.name && GIT_IDENTITY.email)
}

/** `-c user.name=… -c user.email=…` ili prazno kad identitet nije konfiguriran. */
export function gitIdentityArgs(): string {
  return imaGitIdentitet()
    ? `-c user.name='${GIT_IDENTITY.name}' -c user.email='${GIT_IDENTITY.email}' `
    : ''
}

/** Redak za prompt: tko potpisuje commit. Bez konfiguracije — korisnikov vlastiti git. */
export function opisGitIdentiteta(): string {
  return imaGitIdentitet()
    ? `${GIT_IDENTITY.name} <${GIT_IDENTITY.email}> — NIKAD Co-Authored-By`
    : 'tvoj vlastiti git identitet (TM_GIT_NAME/TM_GIT_EMAIL nisu postavljeni) — NIKAD Co-Authored-By'
}

/** Grana po zadatku. Isti oblik očekuje `MergeGate` i vratar commita. */
export function branchName(taskId: string): string {
  return `zadatak/${String(taskId || '').trim().toUpperCase()}`
}

/** Naredbe koraka 5 — doslovno, da izvršitelj ne izmišlja svoju inačicu. */
export function gitBranchCommands(taskId: string): string {
  return [
    `git ${gitIdentityArgs()}\\`,
    `    checkout -b ${branchName(taskId)}`,
  ].join('\n')
}

/** Naredba commita koraka 6 — ID zadatka je PRVI u poruci (po njemu vratar traži dokaz). */
export function gitCommitCommand(taskId: string, korak: number | string = '<korak>'): string {
  return `git ${gitIdentityArgs()}\\\n` +
    `    commit -m "${String(taskId).toUpperCase()} korak ${korak}: <što je napravljeno>"`
}

// ─── Pragovi grilla (razrada §4: „obavezno, ali s granicom") ─────────────────

export const GRILL_PRAG = { pun: 61, skraceni: 36 } as const
export type GrillRazina = 'pun' | 'skraceni' | 'preskace'

export function grillLevel(weight: number, prag = GRILL_PRAG): GrillRazina {
  const w = Number.isFinite(weight) ? Number(weight) : 0
  if (w >= prag.pun) return 'pun'
  if (w >= prag.skraceni) return 'skraceni'
  return 'preskace'
}

/** Tri pitanja skraćenog grilla — SSOT teksta (razrada §4). */
export const GRILL_TRI_PITANJA =
  'što je gotovo, što je izvan opsega, po čemu se zna da je gotovo'

// ─── Fiksni popis koraka (razrada §4, tablica) ───────────────────────────────

export interface WorkflowStep {
  /** Redni broj iz razrade — dio je ugovora, ne smije se premetati. */
  n: number
  key: string
  title: string
  /** Što se radi — jedna rečenica. */
  what: string
  executor: string
  tool: string
  /** Artefakt koji korak ostavlja iza sebe. */
  artifact: string
  /** Čime se dokazuje da je korak gotov. */
  proof: string
}

export const WORKFLOW_STEPS: readonly WorkflowStep[] = [
  {
    n: 0, key: 'prijem', title: 'Prijem',
    what: 'otvaranje zadatka: projekt, grupa, pošiljatelj, težina',
    executor: 'automatika (bez modela)', tool: '—',
    artifact: 'zadatak u TaskManageru s oznakama i izvorom',
    proof: 'zadatak postoji, ima projekt i težinu',
  },
  {
    n: 1, key: 'grill', title: 'Grill',
    what: 'zaoštravanje zahtjeva, rječnik pojmova, otvorena pitanja',
    executor: 'Kosjenka', tool: 'GrillWithDocs',
    artifact: 'dopuna specifikacije projekta + ADR ako je odluka značajna',
    proof: 'ADR ili zapis „nema značajne odluke"',
  },
  {
    n: 2, key: 'istrazivanje', title: 'Istraživanje',
    what: 'što već postoji (RAG, kod, ploča, web)',
    executor: 'Manda', tool: 'Research + rag-query.ts + rag-store.ts',
    artifact: 'dokument u RAG-u (project_id, tip=istrazivanje, task_id, --source po izvoru)',
    proof: 'ID dokumenta u result_summary (vratar ResearchRagGate)',
  },
  {
    n: 3, key: 'razlaganje', title: 'Razlaganje',
    what: '3–7 podzadataka s ulazima, izlazima i ovisnostima',
    executor: 'REGOČ', tool: 'TaskDecomposer',
    artifact: 'plan u data/decomposition_plans/<ID>.json',
    proof: 'plan prolazi normalizePlan (bez ciklusa, poznati agenti)',
  },
  {
    n: 4, key: 'ocjena', title: 'Ocjena',
    what: 'težina 1–100, potrebni skillovi i alati, je li zadatak „samo tekst"',
    executor: 'automatika + planer', tool: 'registar REGOC_AGENTS.json',
    artifact: 'polja i oznake na zadatku',
    proof: 'svaki imenovani skill/alat postoji u registru',
  },
  {
    n: 5, key: 'grana', title: 'Grana',
    what: 'git checkout -b zadatak/TASK-####',
    executor: 'izvršitelj', tool: 'git',
    artifact: 'grana zadatak/TASK-####',
    proof: 'grana postoji, radno stablo čisto',
  },
  {
    n: 6, key: 'izvedba', title: 'Izvedba',
    what: 'po koracima plana, TDD gdje ima testova',
    executor: 'Jelena i drugi', tool: 'TDD / DiagnosingBugs',
    artifact: 'izmjene + testovi',
    proof: 'bun test prolazi; commit po koraku s ID-em zadatka',
  },
  {
    n: 7, key: 'provjera', title: 'Provjera (dvije osi)',
    what: 'os A: standardi (kod, testovi); os B: sukladnost izvornom zahtjevu',
    executor: 'Potjeh, pa Malik za sigurnost', tool: 'code-review, security-guidance',
    artifact: 'nalaz s obje osi',
    proof: 'CriticGate bez `fail`; nalazi zatvoreni ili izrijekom prihvaćeni',
  },
  {
    n: 8, key: 'spajanje', title: 'Spajanje',
    what: 'merge u glavnu granu',
    executor: 'REGOČ', tool: 'MergeGate',
    artifact: 'commit u glavnoj grani',
    proof: 'lanac provjera zelen nakon spajanja',
  },
  {
    n: 9, key: 'dojava', title: 'Dojava',
    what: 'JEDAN sažetak korisniku u izvornu grupu',
    executor: 'Klaudio (zadatak tipa report-back)', tool: 'Telegram',
    artifact: 'jedna poruka u izvornoj grupi',
    proof: 'poruka poslana (report-back zadatak zatvoren), niz zatvoren',
  },
] as const

export function stepByKey(key: string): WorkflowStep | undefined {
  return WORKFLOW_STEPS.find(s => s.key === key)
}

// ─── Skaliranje po težini (koraci ostaju svi, mijenja se obveznost) ─────────

export type Obveznost = 'obvezno' | 'skraceno' | 'neobvezno' | 'preskace'

export interface ScaledStep extends WorkflowStep {
  obveznost: Obveznost
  /** Zašto je korak skaliran — ide u opis da odluka ne bude nevidljiva. */
  napomena?: string
}

export interface ScaleOptions {
  /** Težina 1–100 (razrada §3). */
  weight: number
  /** Prag B — ispod njega se ne ide u puni lanac (istraživanje + razlaganje). */
  pragB?: number
  grillPrag?: { pun: number; skraceni: number }
}

/**
 * Popis koraka ostaje FIKSAN (0–9) — mijenja se samo obveznost pojedinog koraka.
 * Namjerno se ništa ne briše: korak koji ispadne iz popisa nitko poslije ne primijeti,
 * a korak označen „preskače se (težina 12 < 36)" nosi i odluku i njezin razlog.
 */
export function scaleSteps(opts: ScaleOptions): ScaledStep[] {
  const w = Number.isFinite(opts.weight) ? Number(opts.weight) : 0
  const pragB = opts.pragB ?? 36
  const razina = grillLevel(w, opts.grillPrag ?? GRILL_PRAG)
  return WORKFLOW_STEPS.map(s => {
    if (s.key === 'grill') {
      if (razina === 'pun') return { ...s, obveznost: 'obvezno' as Obveznost, napomena: `puni grill (težina ${w} ≥ ${(opts.grillPrag ?? GRILL_PRAG).pun})` }
      if (razina === 'skraceni') return { ...s, obveznost: 'skraceno' as Obveznost, napomena: `skraćeni grill — tri pitanja: ${GRILL_TRI_PITANJA}` }
      return { ...s, obveznost: 'preskace' as Obveznost, napomena: `preskače se (težina ${w} < ${(opts.grillPrag ?? GRILL_PRAG).skraceni})` }
    }
    if ((s.key === 'istrazivanje' || s.key === 'razlaganje') && w < pragB) {
      return { ...s, obveznost: 'neobvezno' as Obveznost, napomena: `ispod praga B (težina ${w} < ${pragB}) — po prosudbi izvršitelja, uz zapis odluke` }
    }
    return { ...s, obveznost: 'obvezno' as Obveznost }
  })
}

const OBVEZNOST_OZNAKA: Record<Obveznost, string> = {
  obvezno: '[obvezno]',
  skraceno: '[skraćeno]',
  neobvezno: '[neobvezno]',
  preskace: '[preskače se]',
}

// ─── Opis prvog zadatka ──────────────────────────────────────────────────────

export interface FirstTaskInput {
  /** Izvorna poruka korisnika, doslovno. */
  message: string
  /** Težina 1–100 (razrada §3). */
  weight: number
  /** Telegram grupa iz koje je poruka stigla — ide i na report-back zadatak. */
  chatId?: string | number | null
  /** Ime grupe, samo za čitljivost. */
  groupName?: string | null
  projectId?: string | null
  /** ID zadatka ako je već poznat (grana i commit ga nose). */
  taskId?: string | null
  /** ID zadatka dojave, ako je već otvoren. */
  reportBackId?: string | null
  pragB?: number
  /** Je li zadatak proglašen „samo tekst" (korak 4) — tada git nije obvezan. */
  textOnly?: boolean
  /** Vrijeme prijema (ISO); zadano: sada. */
  receivedAt?: string
}

/** Naslov zadatka iz poruke — prva rečenica, ≤ 200 znakova (granica sheme). */
export function titleFromMessage(message: string, max = 120): string {
  const t = String(message || '').replace(/\s+/g, ' ').trim()
  if (!t) return 'Zahtjev bez teksta'
  const prva = t.split(/(?<=[.!?])\s/)[0] || t
  const s = prva.length <= max ? prva : prva.slice(0, max - 1).trimEnd() + '…'
  return s.length <= max ? s : s.slice(0, max)
}

/**
 * Opis prvog zadatka: izvor, fiksni popis koraka, git obveza i tko javlja korisniku.
 * Čista funkcija — isti ulaz daje isti tekst (osim vremena prijema, koje se prosljeđuje).
 */
export function buildFirstTaskDescription(input: FirstTaskInput): string {
  const taskId = (input.taskId || 'TASK-####').toUpperCase()
  const w = Number.isFinite(input.weight) ? Number(input.weight) : 0
  const koraci = scaleSteps({ weight: w, pragB: input.pragB })
  const izvor = [
    input.groupName ? `grupa ${input.groupName}` : null,
    input.chatId != null ? `chatId ${input.chatId}` : null,
    `primljeno ${input.receivedAt || new Date().toISOString()}`,
  ].filter(Boolean).join(' · ')

  const redci = koraci.map(s => {
    const glava = `${s.n}. ${s.title.toUpperCase()} ${OBVEZNOST_OZNAKA[s.obveznost]} — ${s.what}`
    const tijelo = [
      `   izvršitelj: ${s.executor} · alat: ${s.tool}`,
      `   izlaz: ${s.artifact}`,
      `   dokaz: ${s.proof}`,
      s.napomena ? `   napomena: ${s.napomena}` : null,
    ].filter(Boolean).join('\n')
    return `${glava}\n${tijelo}`
  }).join('\n')

  const gitBlok = input.textOnly
    ? `GIT: zadatak je označen kao „${TEXT_ONLY_TAG}" (korak 4) — commit se ne traži.\n` +
      `Ako se tijekom rada ispostavi da ipak dira kod, makni oznaku i vrati se na korak 5.`
    : [
        `GIT JE OBVEZAN (razrada §4, pravilo 15 — napredak mora biti durabilan).`,
        `  grana:    ${branchName(taskId)}`,
        `  identitet: ${opisGitIdentiteta()}`,
        `  commit:   POSLIJE SVAKOG KORAKA, poruka počinje ID-em zadatka:`,
        `${gitCommitCommand(taskId, 6).split('\n').map(r => '            ' + r.trim()).join('\n')}`,
        ``,
        `Korak 5 (otvaranje grane):`,
        `${gitBranchCommands(taskId).split('\n').map(r => '  ' + r.trim()).join('\n')}`,
        ``,
        `Zadatak BEZ IJEDNOG COMMITA ne prolazi u completed (vratar GitCommitGate).`,
        `Jedini izlaz: oznaka „${TEXT_ONLY_TAG}" na zadatku, dodijeljena u koraku 4.`,
      ].join('\n')

  const dojava = input.reportBackId
    ? `Korisniku javlja ISKLJUČIVO zadatak dojave ${input.reportBackId} — jedna poruka za cijeli niz.\n` +
      `Ti ne šalji ništa na Telegram: tri zadatka moraju dati JEDNU poruku, ne tri.`
    : `Korisniku javlja ISKLJUČIVO zadatak dojave (tip report-back) na kraju niza — ne šalji poruke sam.`

  return [
    `## Zahtjev korisnika (izvor: ${izvor})`,
    String(input.message || '').trim() || '(poruka je bila prazna)',
    ``,
    `## Koraci — FIKSNI POPIS (razrada §4, bez modela)`,
    `Težina: ${w}/100 · grill: ${grillLevel(w)} · prag B: ${input.pragB ?? 36}` +
      (input.projectId ? ` · projekt: ${input.projectId}` : ''),
    ``,
    redci,
    ``,
    `## Git`,
    gitBlok,
    ``,
    `## Dojava`,
    dojava,
    ``,
    `## Korak 2 — obvezan izlaz`,
    RESEARCH_STEP_OUTPUT_SPEC,
  ].join('\n')
}
