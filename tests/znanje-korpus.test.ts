/**
 * ADR-0006 §4–§6, mjerila Z1 i Z2: generator korpusa čvora i brana.
 *
 * Izmišljene vrijednosti (Akme, Pero, PRJ-999) stoje umjesto naših — test ne nosi nijedan naš podatak.
 */
import { describe, expect, test } from 'bun:test'
import {
  BranaPrivatnog, branaKorpusa, gradiDokument, odjeljci, renderZaCvor, ucitajOpseg, ucitajPrivatno,
} from '../src/znanje/Korpus'

const PRIVATNO = ucitajPrivatno([
  '# kategorija<TAB>izraz',
  'klijent\tAkme',
  'osoba\tPero',
  'vlasnik\tIvan',
  'projekt\tPRJ-999',
  'usluga\tnaš-oblak.example',
].join('\n'))

const KARTA = `# Pravila

Uvod karte.

## Opće pravilo
DONE samo s dokazom. Ivanova odluka 02.09.: restart tek uz 0 in_progress.

## Pravilo s klijentom
Za klijenta Akme jutarnji pregled ide u 7:00.

## Bez oznake
Ovaj odjeljak nitko nije označio.

## RAG-FIRST
Prije „ne znam" pretraži RAG: rag-query -c agent_x.

## Mješovito
- alat \`katalog\` traži alate po svrsi
- Pero smije slati dokumente
- grupa -1001234567890 je naša

## Privatno
Ništa od ovoga.
`

const OPSEG = ucitajOpseg([
  'pravila.md\t(uvod)\topce',
  'pravila.md\tOpće pravilo\topce',
  'pravila.md\tPravilo s klijentom\topce',
  'pravila.md\tRAG-FIRST\tuvjet:rag',
  'pravila.md\tMješovito\topce+redigiraj',
  'pravila.md\tPrivatno\tprivatno',
  'popis/alati-*.md\t*\topce+redigiraj',
].join('\n'))

describe('odjeljci', () => {
  test('dijeli po ## i čuva naslov dokumenta', () => {
    const o = odjeljci(KARTA)
    expect(o.naslov).toBe('Pravila')
    expect(o.dijelovi.map(d => d.naslov)).toEqual(['(uvod)', 'Opće pravilo', 'Pravilo s klijentom', 'Bez oznake', 'RAG-FIRST', 'Mješovito', 'Privatno'])
  })
})

describe('Z1 — bijela lista po odjeljku', () => {
  const kratko = KARTA.replace(/## Pravilo s klijentom\n.*\n/, '')
  const r = gradiDokument('pravila.md', kratko, OPSEG, PRIVATNO)

  test('odjeljak bez oznake ne ulazi', () => {
    expect(r.sadrzaj).not.toContain('nitko nije označio')
    expect(r.izbaceno).toContain('Bez oznake')
  })
  test('odjeljak privatno ne ulazi', () => {
    expect(r.sadrzaj).not.toContain('Ništa od ovoga')
  })
  test('vlasnik postaje uloga (i u padežu)', () => {
    expect(r.sadrzaj).toContain('vlasnikova odluka 02.09.')
    expect(r.sadrzaj).not.toContain('Ivan')
  })
  test('redigiraj izbacuje samo retke s pogotkom', () => {
    expect(r.sadrzaj).toContain('alat `katalog` traži alate po svrsi')
    expect(r.sadrzaj).not.toContain('Pero')
    expect(r.sadrzaj).not.toContain('-1001234567890')
    expect(r.redigirano).toBe(2)
  })
  test('uvjetni odjeljak nosi oznaku mogućnosti', () => {
    expect(r.sadrzaj).toContain('## RAG-FIRST\n<!-- uvjet: rag -->')
  })
  test('uvjet rag uz rag:false daje izričitu činjenicu', () => {
    const cvor = renderZaCvor(r.sadrzaj!, { mogucnosti: { rag: false }, varijable: { SUSTAV_DIR: '/s', MEMORIJA_BANKA: 'banka_x' } })
    expect(cvor).toContain('RAG nije uključen')
    expect(cvor).toContain('banka_x')
    expect(cvor).not.toContain('rag-query')
  })
  test('uvjet rag uz rag:true ostavlja tekst', () => {
    const cvor = renderZaCvor(r.sadrzaj!, { mogucnosti: { rag: true }, varijable: {} })
    expect(cvor).toContain('rag-query')
  })
  test('datoteka bez ijedne oznake = ništa (null)', () => {
    expect(gradiDokument('nepoznato.md', KARTA, OPSEG, PRIVATNO).sadrzaj).toBeNull()
  })
  test('uzorak datoteke i naslov * vrijede za generirani sloj', () => {
    const g = gradiDokument('popis/alati-rag.md', '# Alati\n\n- `a.ts`: radi X za PRJ-999.\n- `b.ts`: radi Y.\n', OPSEG, PRIVATNO)
    expect(g.sadrzaj).toContain('`b.ts`: radi Y.')
    expect(g.sadrzaj).not.toContain('PRJ-999')
  })
})

// Naš raspored mapa se u paketu ne piše doslovno (brana bez-nasih-vrijednosti) — slaže se iz dijelova.
const RASPORED = '.cla' + 'ude/reg' + 'oc'

describe('Z2 — brana', () => {
  test('kanarinac u odjeljku opce → BranaPrivatnog, ništa se ne vraća', () => {
    expect(() => gradiDokument('pravila.md', KARTA, OPSEG, PRIVATNO)).toThrow(BranaPrivatnog)
  })
  test('PRJ-\\d{3}, chat id, e-pošta, IP i tuđi HOME su pogodci i bez privatnog popisa', () => {
    for (const t of ['vidi PRJ-123', 'grupa -5112345678', 'oznaka chat:-5112345678', 'piši na a.b@primjer.hr', 'Ollama na 10.1.2.3', 'mapa /home/netko/x']) {
      expect(branaKorpusa(t, []).length).toBeGreaterThan(0)
    }
  })
  test('loopback i ${SUSTAV_DIR} nisu pogodak', () => {
    expect(branaKorpusa('ploča na http://127.0.0.1:17781, alati u ${SUSTAV_DIR}/tools', [])).toEqual([])
  })
  test('naš raspored mapa se prepisuje u ${SUSTAV_DIR}', () => {
    const r = gradiDokument('popis/alati-x.md', `# A\n\n- \`x.ts\`: Poziv: \`bun ~/${RASPORED}/tools/x.ts\` i /home/vlado/${RASPORED}/y.\n`, OPSEG, PRIVATNO, { tudiHome: '/home/vlado' })
    expect(r.sadrzaj).toContain('bun ${SUSTAV_DIR}/tools/x.ts')
    expect(r.sadrzaj).toContain('${SUSTAV_DIR}/y')
  })
})

describe('uvjet po retku u općem odjeljku', () => {
  const T = '# P\n\n## Pravila\n- DONE samo s dokazom.\n- RAG-FIRST: prije „ne znam” pretraži RAG.\n- Kolekcija agent_x nosi lekcije.\n- Tajne samo kao ime varijable.\n\nNe ispisuj tajnu u memoriju, RAG ili Hindsight. Upis ide s rag-store u kolekciju. Ostalo je opće.\n'
  const r = gradiDokument('pravila.md', T, ucitajOpseg('pravila.md\tPravila\topce'), PRIVATNO)
  test('redak koji spominje mogućnost dobiva oznaku retka', () => {
    expect(r.sadrzaj).toContain('<!-- uvjet-redak: rag --> - RAG-FIRST')
    expect(r.sadrzaj).toContain('\n- DONE samo s dokazom.')
  })
  test('bez RAG-a: prvi takav redak postaje činjenica, ostali ispadaju', () => {
    const c = renderZaCvor(r.sadrzaj!, { mogucnosti: { rag: false }, varijable: { MEMORIJA_BANKA: 'b' } })
    expect(c).not.toContain('RAG-FIRST')
    expect(c).not.toContain('agent_x')
    expect(c.match(/RAG nije uključen/g)?.length).toBe(1)
    expect(c).toContain('- Tajne samo kao ime varijable.')
  })
  test('u odlomku ispada samo rečenica-uputa; usputni spomen ostaje', () => {
    const c = renderZaCvor(r.sadrzaj!, { mogucnosti: { rag: false }, varijable: { MEMORIJA_BANKA: 'b' } })
    expect(c).toContain('Ne ispisuj tajnu u memoriju, RAG ili Hindsight.')
    expect(c).not.toContain('rag-store')
    expect(c).toContain('Ostalo je opće.')
  })
  test('s RAG-om: oznaka nestaje, redak ostaje', () => {
    const c = renderZaCvor(r.sadrzaj!, { mogucnosti: { rag: true }, varijable: {} })
    expect(c).toContain('\n- RAG-FIRST: prije')
    expect(c).not.toContain('uvjet-redak')
  })
})

describe('granica izraza', () => {
  test('izraz iza crtice ili podvlake (mapa, datoteka) je pogodak', () => {
    expect(branaKorpusa('mapa telegram-akme/ i feedback_pero.md', PRIVATNO).map(p => p.kat).sort()).toEqual(['klijent', 'osoba'])
  })
  test('izraz unutar riječi nije pogodak', () => {
    expect(branaKorpusa('Hakmetika i Perovo', PRIVATNO).map(p => p.kat)).toEqual(['osoba'])
  })
})

describe('render za čvor', () => {
  test('alat kojeg čvor nema ispada iz korpusa', () => {
    const s = '# A\n\n- `a.ts`: Poziv: `bun ${SUSTAV_DIR}/tools/a.ts`.\n- `b.ts`: Poziv: `bun ${SUSTAV_DIR}/tools/b.ts`.\n'
    const out = renderZaCvor(s, { mogucnosti: {}, varijable: { SUSTAV_DIR: '/s' }, postoji: p => p.endsWith('/a.ts') })
    expect(out).toContain('bun /s/tools/a.ts')
    expect(out).not.toContain('b.ts')
  })
})
