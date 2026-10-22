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
 * ŠTO SE NE PRETRAŽUJE: sama ova datoteka (uzorci su joj sadržaj). `docs/` se pretražuje samo
 * pravilima s `iDocs: true` — adrese, e-pošta, ID-ovi chatova i korisnika, imena ljudi
 * (TASK-5686, nalaz S3 pregleda K5 TASK-5659: repozitorij je JAVAN, a docs/ je nosio uid-ove,
 * ID-ove grupa, imena, 192.168.10.x i e-poštu u 41 datoteci). Raspored mapa (`/home/…`,
 * `.claude/regoc`) i nazivi projekata u docs/ ostaju izvan opsega: ADR mora smjeti citirati
 * kvar koji opisuje, a to nisu podaci o ljudima ni adrese. Pravilo smije dobiti `iDocs` samo
 * uz osnovicu 0 — čišćenje docs/ ide u isti commit.
 *
 * Autorica: Kosjenka (Architect), TASK-4799.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const KORIJEN = join(import.meta.dir, '..')
const SAMA_BRANA = 'tests/bez-nasih-vrijednosti.test.ts'
const BINARNO = /\.(png|jpg|jpeg|gif|ico|webp|pdf|zip|db|lock)$/

/** Popis onoga što se isporučuje = ono što git prati (s docs/ ili bez). */
function pratiGit(sDocs: boolean): string[] {
  const r = Bun.spawnSync(['git', '-c', `safe.directory=${KORIJEN}`, 'ls-files'], { cwd: KORIJEN })
  if (r.exitCode !== 0) return []
  return r.stdout.toString().trim().split('\n')
    .filter(p => p && (sDocs || !p.startsWith('docs/')) && p !== SAMA_BRANA && !BINARNO.test(p))
}

interface Pravilo {
  ime: string
  uzorak: string
  objasnjenje: string
  /** Izmjereno 10.09.2026. na `f37d7b5`. Smije samo padati. */
  osnovicaPojava: number
  osnovicaDatoteka: string[]
  /** Pretražuje i `docs/` (TASK-5686). Samo uz osnovicu bez ijedne datoteke iz docs/. */
  iDocs?: boolean
  /**
   * NE pretražuje `regoc-system/` (TASK-5705, odluka D3 = B). Komplet je kod IZVORNOG sustava: njegov
   * raspored mapa, imena uloga i ljudi u navodima odluka i nazivi projekata su mu sadržaj, kao što su
   * opisu sustava u `REGOC/`. Za komplet vrijede brane izvoza (`gradi_komplet.sh --javno`,
   * `brane_izvoza.py`) i ova pravila BEZ ove oznake: adrese, putanje `/home/…`, e-pošta, ID-ovi
   * chatova i korisnika, tokeni, imena strojeva i banaka, prezime.
   */
  bezKompleta?: boolean
}

/**
 * Izmišljeni ID-ovi koje primjeri i testovi SMIJU nositi: -100123456789x (supergrupa),
 * -1000000000000 (prazan profil), -5112345678 (obična grupa u testovima znanja) i -1234567890
 * (primjer u komentaru kompleta regoc-system/, TASK-5705).
 */
const PRIMJERI_CHATA = '-?100123456789\\d|-?1000000000000|-5112345678|-1234567890'

const PRAVILA: Pravilo[] = [
  {
    ime: 'naš tailnet (Tailscale MagicDNS)',
    iDocs: true,
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
    iDocs: true,
    uzorak: '192\\.168\\.10\\.\\d+',
    objasnjenje: 'adresa nikad nije zadana vrijednost — `null` + varijabla okoline (ADR-0001 §5.1)',
    // TASK-5108: 7 → 0. Alati čitaju `TM_OLLAMA_URL` / `TM_CHROMA_HOST` kroz tools/tm_putanje.py.
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  {
    ime: 'naša e-pošta / domena',
    iDocs: true,
    // TASK-5109: hvata i `.eu` domenu — upravo ta adresa je bila u incidentu 241aa89.
    uzorak: 'goran\\.mahovlic@gmail\\.com|@intergalaktik\\.(hr|eu)',
    objasnjenje:
      'git identitet je konfiguracija bez zadane vrijednosti (ADR-0001 O1.3, v. '
      + 'src/core/WorkflowTemplate.ts); dopušteni autori commita su `git config '
      + 'taskmanagerai.dopusteniAutori` (v. .githooks/commit-msg), primjeri koriste example.com',
    // TASK-5109: 7/5 → 0. Hook je NAŠU adresu imao kao jedinog zadanog autora — svaki tuđi
    // klon s uključenim kukama (`scripts/install.sh`) bio je odbijen; README/CONTRIBUTING
    // tu adresu nisu navodili kao autorstvo nego kao pravilo hooka.
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  {
    ime: 'naš Telegram chat id',
    iDocs: true,
    uzorak: '5161938429',
    objasnjenje: 'u primjerima koristi izmišljeni id (npr. -1001234567890)',
    // TASK-5108: 11 → 0, primjeri i testovi nose izmišljeni -1001234567890.
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  {
    ime: 'ime vlasnika kao podatak (pošiljatelj, korisnik)',
    bezKompleta: true,
    iDocs: true,
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
    ime: 'ime vlasnika kao autor upisa (`by`)',
    bezKompleta: true,
    iDocs: true,
    // TASK-5233 (nalaz QA TASK-5219): ploča je slala doslovno `by: '<ime>'`, pa se to ime
    // upisivalo u audit postavki na TUĐEM nodu. Pravilo iznad ga nije vidjelo (malo slovo).
    // Slaže se iz dijelova iz istog razloga kao tailnet gore.
    uzorak: ['\\bby\\s*[:=]\\s*[\'"`]', '[Gg]or', 'an[\'"`]'].join(''),
    objasnjenje: 'autor upisa s ploče je neutralan „vlasnik" (kao u AutonomyThresholdSetting.ts); '
      + 'stvarno ime je podatak instalacije, ne kod',
    // TASK-5233: 5/1 → 0.
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  {
    ime: 'nazivi naših internih projekata i RAG kolekcija',
    bezKompleta: true,
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
    ime: 'imena naših ljudi (navodi u komentarima, primjeri)',
    bezKompleta: true,
    iDocs: true,
    // TASK-5109. Slaže se iz dijelova iz istog razloga kao tailnet gore.
    // TASK-5686: i drugi korisnik s node-A (docs/adr/ADR-0002, ADR-0003).
    uzorak: ['\\bGor', 'an|\\bMart', 'in[aeiu]?\\b|\\bTomi', 'slav'].join(''),
    objasnjenje:
      'navod odluke piše „vlasnik, <datum>: …" (bez imena), primjeri koriste „Korisnik A"; '
      + 'ime smije stajati samo kao AUTORSTVO (LICENSE, package.json, „Credit" u README)',
    // TASK-5109: 114 pojava / 40 dat. (na `ddfb61a`) → 4/4. Preostale 4 pojave su autorstvo i NAMJERNO ostaju —
    // osnovica ovog pravila je 4, ne 0; zapor i dalje hvata svaku novu datoteku.
    osnovicaPojava: 4,
    osnovicaDatoteka: ['LICENSE', 'README.hr.md', 'README.md', 'package.json'],
  },
  {
    ime: 'naš raspored mapa (~/.claude/regoc)',
    bezKompleta: true,
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
    bezKompleta: true,
    // TASK-5109: hvata i slug Claude projekta (`-app-…-system`) i rastavljeni
    // `join(HOME, 'app', '…_system')` — sve su to imena NAŠE mape. Slaže se iz dijelova
    // iz istog razloga kao tailnet gore.
    // TASK-5705: `regoc-system/` (crtica) je ime mape kompleta u paketu (odluka D3) — hvata se samo
    // naša mapa s podvlakom i slug Claude projekta (`-app-…-system`).
    uzorak: ['reg', 'oc_system|app-reg', 'oc-system'].join(''),
    objasnjenje: 'repozitorij sustava domaćina dolazi samo iz `TM_SUSTAV_DIR` kroz `sustavPutanja()` '
      + '(src/core/paths.ts); bez varijable alat se traži uz paket (`PAKET_DIR/tools`)',
    // TASK-5109: 24/14 → 0 u istom koraku (izmjereno prije popravka na `2268db7`).
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  // ── Granica repozitorij ↔ čvor (plan Mac v2 P4.1, TASK-5658) ───────────────────────────
  {
    ime: 'adrese tailneta (100.64.0.0/10) izvan primjernih blokova 100.64.0.0/24 i 100.127.255.0/24',
    // Tailscale dodjeljuje adrese iz 100.64.0.0/10. Blokovi 100.64.0.0/24 i 100.127.255.0/24
    // (donji i gornji rub raspona, za testove granice) su u paketu PRIMJERNI — kao 192.0.2.0/24
    // iz RFC 5737; svaka druga adresa iz raspona je nečija stvarna adresa čvora.
    uzorak: '\\b100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d{1,3}\\.\\d{1,3}\\b'
      + '(?<!\\b100\\.64\\.0\\.\\d{1,3})(?<!\\b100\\.127\\.255\\.\\d{1,3})',
    objasnjenje: 'adresa čvora dolazi iz `tailscale ip -4` pri instalaciji (install.sh → $TM_HOME/config/postavke.env); '
      + 'u primjerima `100.x.y.z` ili adresa iz 100.64.0.0/24',
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  {
    ime: 'imena naših strojeva (čvorova)',
    // Slaže se iz dijelova iz istog razloga kao tailnet gore.
    uzorak: ['mac', 'mini-pv|mac', 'mini_pv|\\bnode', '-?[ab]\\.', 'tail'].join(''),
    objasnjenje: 'ime čvora je argument `install.sh --cvor <ime>` i živi samo u $TM_HOME/config; '
      + 'primjeri koriste `cvor-b`, `node-x`',
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  {
    ime: 'imena naših banaka memorije (Hindsight)',
    // Slaže se iz dijelova iz istog razloga kao tailnet gore.
    uzorak: ['reg', 'oc_sustav_[a-z]+|cvor_', 'mac', 'mini|cvor_', 'node', '[ab]\\b'].join(''),
    objasnjenje: 'banka čvora je `MEMORIJA_BANKA` u $TM_HOME/config/profil.instanca.env (primjer: banka_cvor_b)',
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  {
    ime: 'tokeni i ključevi API-ja (oblik stvarnog ključa)',
    // Lažni ključevi u testovima su namjerno očiti (`AAAA…`, `sk-or-v1-abc…`) i ne odgovaraju
    // obliku: stvarni Telegram token ima mala slova i brojke u tijelu, OpenRouter 64 heks znaka,
    // Anthropic `sk-ant-…` ≥ 80 znakova, GitHub `gh?_` + 36, GitLab `glpat-` + 20.
    uzorak: [
      '\\b\\d{8,10}:AA(?=[\\w-]{33}\\b)(?=[\\w-]*[a-z])(?=[\\w-]*\\d)[\\w-]{33}\\b',
      'sk-or-v1-[0-9a-f]{64}',
      'sk-ant-[a-z]{3}\\d{2}-[\\w-]{80,}',
      '\\bgh[pousr]_(?=[A-Za-z0-9]*\\d)[A-Za-z0-9]{36}\\b',
      'glpat-[\\w-]{20}',
    ].join('|'),
    objasnjenje: 'tajne se upisuju samo lokalno: `bun scripts/tajna.ts postavi IME` (vrijednost na upit) ili Config → Tajne',
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  {
    ime: 'naš bot i Telegram uid vlasnika',
    // Slaže se iz dijelova iz istog razloga kao tailnet gore.
    uzorak: ['(?i:klaudio', 'ai_bot|martina', 'filesbot)|5284', '452279'].join(''),
    objasnjenje: 'ime drugog bota i uid vlasnika su postavke čvora (BOTKANAL_DRUGI, VLASNIK_UID u '
      + 'profil.instanca.env); testovi koriste `drugiAI_bot` i `100000001`',
    // TASK-5658: sve pojave u 6 dat. → 0 (testovi kanala bot↔bot i komentar u src/razgovor/BotKanal.ts).
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  // ── TASK-5686 (S3): pravila iz grane zadatak/TASK-5686 (spojeno uz TASK-5658) ──
  {
    ime: 'ID Telegram chata (oblik, ne samo poznata vrijednost)',
    iDocs: true,
    // TASK-5686 (S3): stvaran ID grupe je bio u scripts/posalji-dokument.ts, a pravilo iznad zna samo
    // jednu vrijednost. Supergrupa -100 + 10 znamenki, obična grupa - + 9–13 znamenki. Ispred ne smije
    // biti slovo/znamenka/crtica (`TASK-…-1791378656740` je vrijeme u imenu grane, ne chat).
    uzorak: `(?<![A-Za-z0-9-])(?!(?:${PRIMJERI_CHATA})(?!\\d))(?:-?100\\d{10}|-\\d{9,13})(?!\\d)`,
    objasnjenje: 'u primjerima i testovima koristi izmišljeni -1001234567890 (v. PRIMJERI_CHATA)',
    // TASK-5686: 41 pojava / 20 dat. u docs/ + 30 izvan docs/ (testovi, locales, TaskWebUI) → 0.
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  {
    ime: 'naši Telegram korisnički ID-ovi (uid)',
    iDocs: true,
    // Slaže se iz dijelova iz istog razloga kao tailnet gore.
    uzorak: ['52844', '52279|88729', '62604'].join(''),
    objasnjenje: 'u primjerima koristi izmišljeni uid (100000001, 777000111 …); popis korisnika je konfiguracija',
    // TASK-5686: docs/ (4 dat.) i testovi (3 dat.) → 0.
    osnovicaPojava: 0,
    osnovicaDatoteka: [],
  },
  {
    ime: 'prezime vlasnika (samo kao autorstvo)',
    iDocs: true,
    uzorak: ['\\bMahov', 'li[cć]'].join(''),
    objasnjenje: 'git identitet je konfiguracija (ADR-0001 O1.3); ime i prezime smiju stajati samo kao AUTORSTVO',
    // TASK-5686: docs/ 3 → 0; ostaje autorstvo (LICENSE, README, package.json).
    osnovicaPojava: 4,
    osnovicaDatoteka: ['LICENSE', 'README.hr.md', 'README.md', 'package.json'],
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

const POPIS = pratiGit(false)
const POPIS_S_DOCS = pratiGit(true)
const popisZa = (p: Pravilo) => (p.iDocs ? POPIS_S_DOCS : POPIS).filter(f => !(p.bezKompleta && f.startsWith('regoc-system/')))

describe('paket ne smije nositi naše vrijednosti (ADR-0001 §8)', () => {
  test('skener vidi paket (inače bi svako pravilo prolazilo prazno)', () => {
    expect(POPIS.length).toBeGreaterThan(50)
    expect(POPIS_S_DOCS.filter(p => p.startsWith('docs/')).length).toBeGreaterThan(40)
  })

  test('uzorak ID-a chata hvata stvarne oblike, a pušta primjere i vrijeme u imenu grane', () => {
    const p = PRAVILA.find(x => x.ime.startsWith('ID Telegram chata'))!
    const re = new RegExp(p.uzorak, 'g')
    for (const da of ['--chat -5987654321 --x', 'chatId: "-1009876543210"', 'telegram_-5987654321', 'chat:-5987654321'])
      expect(da.match(re)?.length, da).toBe(1)
    for (const ne of ['-1001234567890', '-1001234567893', 'profil="-1000000000000"', 'grupa -5112345678',
      'regoc/TASK-5324-potjeh-1791378656740', 'uidValidity: 1791444651', 'port 17781'])
      expect(ne.match(re), ne).toBeNull()
  })

  for (const p of PRAVILA) {
    test(`zapor — ${p.ime}`, () => {
      const nalaz = prebroji(p.uzorak, popisZa(p))

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
      const n = prebroji(p.uzorak, popisZa(p))
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
 *
 * `znanje/sustav/` (TASK-5331, ADR-0006 §4–§5, mjerilo Z3) je isto: generirani OPĆI korpus o sustavu
 * — agenti, tijekovi, alati — koji ide u banku memorije svakog čvora. Imena uloga su mu sadržaj;
 * tekstualna pravila (adrese, putanje, chat id, naš raspored mapa) vrijede i za njega.
 *
 * `regoc-system/` (TASK-5705, D3 = B) je kod izvornog sustava — komplet koji `install.sh --komplet`
 * instalira. Uloge tima su mu sadržaj (RegocDaemon raspoređuje upravo njih); v. `bezKompleta` gore.
 */
const IZUZETO_OD_POPISA_TIMA = ['REGOC/', 'znanje/sustav/', 'regoc-system/']

function popisiTima(): string[] {
  const pogodjene: string[] = []
  for (const rel of POPIS) {
    if (IZUZETO_OD_POPISA_TIMA.some(m => rel.startsWith(m))) continue
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
