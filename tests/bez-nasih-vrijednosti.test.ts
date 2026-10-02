/**
 * Brana: u paketu ne smije biti NAŠIH vrijednosti — ni adresa, ni imena, ni putanja.
 *
 * Provodi pravilo iz `docs/adr/ADR-0001-orchestrator-core.md` §8.
 *
 * ZAŠTO ZAPOR (ratchet), A NE TVRDA NULA. Izmjereno 10.09.2026. na commitu `f37d7b5`, nad
 * 107 datoteka koje git prati: 73 pojave `/home/klaudio` u 25 datoteka, 148 pojava
 * `.claude/regoc` u 47 datoteka, naši IP-ovi u 10 datoteka, Goranov osobni git identitet
 * kao konstanta u `src/core/WorkflowTemplate.ts`. Test s tvrdom nulom padao bi na `main`
 * od prvog dana, a test koji stalno pada biva isključen — točno onaj kvar zbog kojeg je
 * `SecurityValidator` hook godinama bio mrtav kod.
 *
 * Zato zapor: test pada SAMO ako broj pojava NARASTE ili se pojava javi u NOVOJ datoteci.
 * Svako čišćenje spušta osnovicu u istom commitu s popravkom, dok osnovica ne padne na nulu.
 * Time cilj „bez ijedne naše vrijednosti" prestaje biti izjava i postaje mjerena brojka.
 *
 * ŠTO SE PRETRAŽUJE: isključivo ono što **git prati** — to je definicija onoga što korisnik
 * skine s GitHuba. Radne datoteke, `node_modules` i `__pycache__` nisu paket.
 *
 * ŠTO SE NE PRETRAŽUJE: `docs/` (ADR i dizajnerski dokumenti moraju smjeti citirati kvar koji
 * opisuju) i sama ova datoteka (uzorci su joj sadržaj).
 *
 * Autorica: Kosjenka (Architect), TASK-4799.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const KORIJEN = join(import.meta.dir, '..')
const SAMA_BRANA = 'tests/bez-nasih-vrijednosti.test.ts'
const BINARNO = /\.(png|jpg|jpeg|gif|ico|webp|pdf|zip|db|lock)$/

/** Popis onoga što se isporučuje = ono što git prati. */
function pratiGit(): string[] {
  const r = Bun.spawnSync(['git', '-c', `safe.directory=${KORIJEN}`, 'ls-files'], { cwd: KORIJEN })
  if (r.exitCode !== 0) return []
  return r.stdout.toString().trim().split('\n')
    .filter(p => p && !p.startsWith('docs/') && p !== SAMA_BRANA && !BINARNO.test(p))
}

interface Pravilo {
  ime: string
  uzorak: string
  objasnjenje: string
  /** Izmjereno 10.09.2026. na `f37d7b5`. Smije samo padati. */
  osnovicaPojava: number
  osnovicaDatoteka: string[]
}

const PRAVILA: Pravilo[] = [
  {
    ime: 'naš tailnet (Tailscale MagicDNS)',
    // Uzorak se slaže iz dijelova: doslovan niz u ovoj datoteci pao bi na `git grep`
    // kojim se nalaz B3 provjerava (brana sebe izuzima iz skeniranja, `git grep` ne).
    uzorak: ['tailc', '\\d+|', '\\.', 'ts', '\\.', 'net'].join(''),
    objasnjenje:
      'naziv tailneta je globalno jedinstven i vodi na NAŠ stroj — adresa ploče ide iz '
      + '`TM_BOARD_URL`, bez zadane vrijednosti (v. `boardUrl()` u src/core/ReportBackTask.ts)',
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  {
    ime: 'naš HOME kao zadana vrijednost',
    uzorak: '/home/klaudio',
    objasnjenje: 'koristi `src/core/paths.ts` (TM_ROOT), nikad tuđi $HOME kao rezervu (ADR-0001 O1.1)',
    // TASK-5108: 1 → 0, zakrpa za živu instalaciju izbačena iz paketa (scripts/zakrpe/ u .gitignore).
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  {
    ime: 'naši IP-ovi',
    uzorak: '192\\.168\\.10\\.\\d+',
    objasnjenje: 'adresa nikad nije zadana vrijednost — `null` + varijabla okoline (ADR-0001 §5.1)',
    // TASK-5108: 7 → 0. Alati čitaju `TM_OLLAMA_URL` / `TM_CHROMA_HOST` kroz tools/tm_putanje.py.
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  {
    ime: 'naša e-pošta / domena',
    uzorak: 'goran\\.mahovlic@gmail\\.com|@intergalaktik\\.hr',
    objasnjenje:
      'u README/LICENCI je autorstvo i to je u redu; u KODU je git identitet i mora biti '
      + 'konfiguracija bez zadane vrijednosti (ADR-0001 O1.3, v. src/core/WorkflowTemplate.ts)',
    osnovicaPojava: 7,
    osnovicaDatoteka: [
      '.githooks/commit-msg',
      'CONTRIBUTING.md',
      'README.hr.md',
      'README.md',
      'tests/commit-msg-hook.test.ts',
    ],
  },
  {
    ime: 'naš Telegram chat id',
    uzorak: '5161938429',
    objasnjenje: 'u primjerima koristi izmišljeni id (npr. -1001234567890)',
    // TASK-5108: 11 → 0, primjeri i testovi nose izmišljeni -1001234567890.
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  {
    ime: 'ime vlasnika kao podatak (pošiljatelj, korisnik)',
    // Slaže se iz dijelova iz istog razloga kao tailnet gore.
    uzorak: ['[\'"]', 'Gor', 'an', '[\'"]'].join(''),
    objasnjenje:
      'testovi i primjeri koriste neutralno ime (npr. „Korisnik"); popis korisnika je '
      + 'konfiguracija, ne kod (TASK-5108, v. tests/ingest.test.ts)',
    // TASK-5108: 1 → 0, nadimci korisnika su `korisnici` u uvoz-telegrama.json.
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  {
    ime: 'nazivi naših internih projekata i RAG kolekcija',
    // `ULX5M` samo kao literal u navodnicima (ID projekta): kao ključna riječ teme uz
    // ULX3S/ECP5 u tools/rag_izdvoji.py to je javni naziv pločice, ne naš podatak.
    uzorak: ['REGOC_', 'SYSTEM|Sport', 'AI|intergalaktik_', 'sportai|agent_', 'emard|[\'"]ULX', '5M[\'"]'].join(''),
    objasnjenje:
      'projekti i kolekcije su podatak instalacije — konfiguracija (npr. uvoz-telegrama.json) '
      + 'ili interni alat izvan paketa (TASK-5108, v. .gitignore)',
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  {
    ime: 'naš raspored mapa (~/.claude/regoc)',
    // TASK-5108: uzorak hvata i rastavljeni oblik — `join(HOME, '.claude', 'regoc', …)` i
    // `Path.home() / ".claude" / "regoc"` su isti raspored, a stari ga uzorak nije vidio
    // (11 pojava u src/, 3 u tools/ — sve očišćene u istom koraku).
    uzorak: '\\.claude/regoc|\\.claude[\'"]\\s*[,/]\\s*[\'"]regoc',
    objasnjenje: 'konfiguracija kroz `konfigPutanja()`, stanje kroz `stanjePutanja()` (src/core/paths.ts) '
      + 'ili `tools/tm_putanje.py` u Pythonu (ADR-0001 O1.4)',
    // TASK-5108: 120/34 → 0 (D3), zadnja dva interna alata izbačena iz paketa (D4).
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  {
    ime: 'naš repozitorij sustava (~/app/…_system)',
    // TASK-5109: hvata i slug Claude projekta (`-app-…-system`) i rastavljeni
    // `join(HOME, 'app', '…_system')` — sve su to imena NAŠE mape. Slaže se iz dijelova
    // iz istog razloga kao tailnet gore.
    uzorak: ['reg', 'oc[_-]system'].join(''),
    objasnjenje: 'repozitorij sustava domaćina dolazi samo iz `TM_SUSTAV_DIR` kroz `sustavPutanja()` '
      + '(src/core/paths.ts); bez varijable alat se traži uz paket (`PAKET_DIR/tools`)',
    // TASK-5109: 24/14 → 0 u istom koraku (izmjereno prije popravka na `2268db7`).
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
]

interface Nalaz { pojava: number; datoteke: string[] }

function prebroji(uzorak: string, popis: string[]): Nalaz {
  let pojava = 0
  const pogodjene: string[] = []
  for (const rel of popis) {
    let tekst: string
    try { tekst = readFileSync(join(KORIJEN, rel), 'utf-8') } catch { continue }
    const m = tekst.match(new RegExp(uzorak, 'g'))
    if (m && m.length) { pojava += m.length; pogodjene.push(rel) }
  }
  return { pojava, datoteke: pogodjene.sort() }
}

const POPIS = pratiGit()

describe('paket ne smije nositi naše vrijednosti (ADR-0001 §8)', () => {
  test('skener vidi paket (inače bi svako pravilo prolazilo prazno)', () => {
    expect(POPIS.length).toBeGreaterThan(50)
  })

  for (const p of PRAVILA) {
    test(`zapor — ${p.ime}`, () => {
      const nalaz = prebroji(p.uzorak, POPIS)

      // 1) Nijedna NOVA datoteka. Ovo hvata curenje u trenutku nastanka, prije nego se namnoži.
      const nove = nalaz.datoteke.filter(d => !p.osnovicaDatoteka.includes(d))
      expect(
        nove.length === 0
          ? 'nema novih'
          : `NOVO CURENJE (${p.ime}) u: ${nove.join(', ')} — ${p.objasnjenje}`,
      ).toBe('nema novih')

      // 2) Broj pojava smije samo padati.
      expect(nalaz.pojava).toBeLessThanOrEqual(p.osnovicaPojava)
    })
  }

  test('osnovica nije zastarjela (ako je posao napravljen, spusti brojke)', () => {
    const zaostalo: string[] = []
    for (const p of PRAVILA) {
      const n = prebroji(p.uzorak, POPIS)
      if (n.pojava < p.osnovicaPojava || n.datoteke.length < p.osnovicaDatoteka.length) {
        zaostalo.push(
          `${p.ime}: osnovica ${p.osnovicaPojava} pojava / ${p.osnovicaDatoteka.length} dat., `
          + `stvarno ${n.pojava} / ${n.datoteke.length} → spusti osnovicu u ${SAMA_BRANA}`,
        )
      }
    }
    // Ne ruši build — samo govori. Zastarjela osnovica je tiho popuštanje brane, pa mora biti vidljiva.
    if (zaostalo.length) console.warn('ℹ️  osnovica je zastarjela:\n   ' + zaostalo.join('\n   '))
    expect(zaostalo.length).toBeGreaterThanOrEqual(0)
  })
})

/**
 * STRUKTURNA BRANA (TASK-4808). Gornja pravila traže TEKSTUALNE uzorke — putanje, adrese,
 * e-poštu. Nalaz N1 iz `docs/QA_E2E_SAMOSTALNOST_2026-09-10.md` pokazao je rupu: naš tim je
 * u paket bio ugrađen kao STRUKTURA — zatvoren `z.enum` imena u `src/zod/schemas/task.ts` —
 * pa je tuđa instalacija odbijala svakog vlastitog nositelja, a nijedno tekstualno pravilo
 * to nije vidjelo jer je svako pojedino ime bezopasno.
 *
 * Mjeri se stoga koliko datoteka nabraja TRI ILI VIŠE naših imena: jedno ime je spomen,
 * tri su popis tima. Zapor je isti kao gore — nova datoteka pada odmah, broj smije samo
 * padati. `agents/regoc-tim.json` je namjerna iznimka po sadržaju (to JEST ponuda „instaliraj
 * naš tim") i ostaje u osnovici da se vidi cijena; mapa `REGOC/` je izuzeta jednim pravilom
 * (v. `IZUZETO_OD_POPISA_TIMA` niže).
 *
 * Osnovica izmjerena 10.09.2026. nakon popravka N1: `src/zod/schemas/task.ts` je ispao s
 * popisa jer popis nositelja sada dolazi iz `config/agents.json`/`TM_AGENTS`
 * (v. `src/core/AgentIds.ts`, `tests/agent-ids.test.ts`).
 *
 * TASK-4809 spušta osnovicu s 21 na 18: ispali su `src/types/task-types.ts` (tip `AgentId`,
 * `ALL_AGENTS`, `AGENT_NAMES`, `AGENT_CAPABILITIES`), `src/core/TaskManagerSQL.ts`
 * (`AgentId`, `AGENT_IDS`, zadani autor bilješke) i `src/core/MessageQueue.ts`
 * (`VALID_AGENTS`, primjeri u CLI-ju).
 */
const NASA_IMENA = [
  'regoc', 'klaudio', 'stribor', 'kosjenka', 'jelena',
  'malik', 'manda', 'potjeh', 'dora', 'gita', 'grga',
]

/** Datoteke koje su 10.09.2026. nabrajale ≥3 naša imena. Smije samo padati. */
const OSNOVICA_POPISI: string[] = [
  'README.hr.md',
  'README.md',
  'agents/alati.json',
  'agents/regoc-tim.json',
  'agents/workflows.json',
  'config/upute-po-tipu.json',
  'locales/en.json',
  'locales/hr.json',
  'src/TaskWebUI.ts',
  'src/core/DispatchGuard.ts',
  'src/core/ModeClassifier.ts',
  'src/core/ReportBackSweepLive.ts',
  'src/core/WorkflowTemplate.ts',
  'tests/integracije.test.ts',
  'tests/orchestrator.test.ts',
  'tools/rag_izdvoji.py',
  'tools/test_tjedni_pregled.py',
]

/**
 * IZUZEĆE MAPE `REGOC/` (GAP 24.09.2026. §5 J11, jedno pravilo umjesto osnovice po datoteci).
 *
 * `REGOC/` je po definiciji opis sustava iz kojega je paket izvučen — dakle NAŠEG tima — i
 * dijeli se na teme u parovima `X.md` + `X.en.md`. Svaka nova tema koja spomene uloge s
 * imenima bila bi „novi popis tima" i tražila bi proširenje osnovice; osnovica bi tada rasla
 * sa svakom stranicom dokumentacije, što je upravo suprotno pravilu „smije samo padati".
 *
 * Zato se mapa izuzima JEDNIM pravilom, a `REGOC/README.md` je istim potezom maknut iz
 * `OSNOVICA_POPISI` — zapor se i dalje mjeri nad kodom i ostatkom paketa. Tekstualna pravila
 * iz `PRAVILA` (adrese, putanje, e-pošta, chat id) NE izuzimaju `REGOC/`: opis tima smije
 * imenovati uloge, ali ne smije nositi ničiju adresu ni putanju.
 */
const IZUZETO_OD_POPISA_TIMA = 'REGOC/'

function popisiTima(): string[] {
  const pogodjene: string[] = []
  for (const rel of POPIS) {
    if (rel.startsWith(IZUZETO_OD_POPISA_TIMA)) continue
    let tekst: string
    try { tekst = readFileSync(join(KORIJEN, rel), 'utf-8').toLowerCase() } catch { continue }
    const nadena = NASA_IMENA.filter(ime => new RegExp(`\\b${ime}\\b`).test(tekst))
    if (nadena.length >= 3) pogodjene.push(rel)
  }
  return pogodjene.sort()
}

describe('strukturna brana — naš tim ugrađen kao popis, ne kao tekst (N1)', () => {
  test('nijedna NOVA datoteka ne nabraja tri ili više naših imena', () => {
    const nove = popisiTima().filter(d => !OSNOVICA_POPISI.includes(d))
    expect(
      nove.length === 0
        ? 'nema novih'
        : `NOVI POPIS TIMA u: ${nove.join(', ')} — imena agenata su konfiguracija `
          + `(config/agents.json / TM_AGENTS, v. src/core/AgentIds.ts), ne kod`,
    ).toBe('nema novih')
  })

  test('broj takvih datoteka smije samo padati', () => {
    expect(popisiTima().length).toBeLessThanOrEqual(OSNOVICA_POPISI.length)
  })

  /**
   * Datoteke jezgre koje su NEKAD nabrajale naš tim i sada ga NE SMIJU vratiti.
   *
   * `src/zod/schemas/task.ts` — nalaz N1 (TASK-4808): zatvoren `z.enum` nositelja.
   * Ostale tri — TASK-4809: `AgentId` kao unija naših imena, `ALL_AGENTS`/`AGENT_NAMES`/
   * `AGENT_CAPABILITIES` s NAŠIM ulogama, `AGENT_IDS`, `VALID_AGENTS`. Popis nositelja i
   * njihova imena dolaze iz `config/agents.json` (v. `src/core/AgentIds.ts`).
   *
   * Zašto poseban test uz zapor iznad: zapor broji datoteke s ≥3 imena, pa bi povratak
   * JEDNOG imena („samo zadana vrijednost `|| 'regoc'`") prošao nezapaženo. Ovdje pada već
   * na prvom imenu u KODU (komentari smiju citirati kvar koji opisuju).
   */
  const BEZ_UGRADENOG_POPISA = [
    'src/zod/schemas/task.ts',
    'src/types/task-types.ts',
    'src/core/TaskManagerSQL.ts',
    'src/core/MessageQueue.ts',
  ]

  test.each(BEZ_UGRADENOG_POPISA)('%s NE smije nositi naša imena u kodu (regresija N1)', rel => {
    const izvor = readFileSync(join(KORIJEN, rel), 'utf-8')
    const kod = izvor.split('\n').filter(r => !r.trim().startsWith('//') && !r.trim().startsWith('*'))
    for (const ime of NASA_IMENA) {
      expect(
        kod.some(r => new RegExp(`['"\`]${ime}['"\`]`).test(r))
          ? `ime „${ime}" je opet doslovno u ${rel}`
          : 'čisto',
      ).toBe('čisto')
    }
  })
})
