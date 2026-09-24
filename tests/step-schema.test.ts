/**
 * tests/step-schema.test.ts — W3/TASK-4615.
 *
 * Drži dvije tvrdnje na kojima cijela stvar stoji:
 *   1. sud se donosi nad POLJIMA (dokaz koji se može ponoviti), ne nad prozom;
 *   2. u načinu `shadow` nevaljana shema NE zaustavlja ploču, u `on` zaustavlja.
 *
 * Konfiguracija se podmeće preko REGOC_STEP_SCHEMA_CONFIG — živa config/step-schema.json
 * se ne dira (isto pravilo kao LiveDbGuard: test ne smije pisati u pogon).
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  MIN_NAPRAVLJENO,
  OBAVEZNA_POLJA,
  SHEMA_MARKER,
  VRSTE_DOKAZA,
  blokShemeKoraka,
  formatSudKoraka,
  loadStepSchemaConfig,
  ocijeniIzlazKoraka,
  parsirajIzlazKoraka,
  provjeriPolja,
  provjeriStavkuDokaza,
  shemaSeProvodi,
  shemaUPromptu,
  zamjerkeZaAgenta,
  // W3b/TASK-4879 — razdvojeno provođenje po granama + izuzeće dosega.
  OZNAKA_BEZ_BLOKA,
  PRAG_TRENUTNOG_ZATVARANJA_MS,
  izuzetOdNedostajuceSheme,
  nedostajuciSeProvodi,
} from '../src/core/StepSchema'

const dir = mkdtempSync(join(tmpdir(), '.tmp-stepschema-'))
const cfgPut = join(dir, 'step-schema.json')
const starо = process.env.REGOC_STEP_SCHEMA_CONFIG

function postaviNacin(nacin: string) {
  writeFileSync(cfgPut, JSON.stringify({ nacin }))
  process.env.REGOC_STEP_SCHEMA_CONFIG = cfgPut
  return loadStepSchemaConfig(true)
}

/** W3b: način I zastavica za granu `schema_missing` (dvije neovisne ručice). */
function postavi(raw: Record<string, unknown>) {
  writeFileSync(cfgPut, JSON.stringify(raw))
  process.env.REGOC_STEP_SCHEMA_CONFIG = cfgPut
  return loadStepSchemaConfig(true)
}

afterAll(() => {
  if (starо === undefined) delete process.env.REGOC_STEP_SCHEMA_CONFIG
  else process.env.REGOC_STEP_SCHEMA_CONFIG = starо
  loadStepSchemaConfig(true)
  rmSync(dir, { recursive: true, force: true })
})

const DOBAR = {
  napravljeno: 'Dodala StepSchema.ts i ukopčala ga u CompletionGuard.',
  dokaz: [
    { vrsta: 'naredba', naredba: 'bun test tests/step-schema.test.ts', izlaz: '24 pass, 0 fail' },
    { vrsta: 'datoteka', datoteka: '/srv/tm/src/core/StepSchema.ts', izlaz: '420 redaka' },
  ],
  datoteke: ['/srv/tm/src/core/StepSchema.ts'],
  sljedeci_korak: 'mjerenje na 50 zadataka',
  nesigurnosti: [],
}

const odgovorS = (o: unknown, prije = 'Odradila sam posao.\n\n') =>
  `${prije}${SHEMA_MARKER}\n\`\`\`json\n${JSON.stringify(o, null, 2)}\n\`\`\`\n\nREGOC-STATUS: DONE — gotovo`

describe('parsiranje', () => {
  test('nalazi blok iza markera unutar ograde', () => {
    const p = parsirajIzlazKoraka(odgovorS(DOBAR))
    expect(p.nadjen).toBe(true)
    expect(p.objekt?.napravljeno).toBe(DOBAR.napravljeno)
  })

  test('nalazi blok i bez ograde i bez markera', () => {
    const p = parsirajIzlazKoraka(`tekst prije ${JSON.stringify(DOBAR)} tekst poslije`)
    expect(p.nadjen).toBe(true)
    expect(p.objekt).not.toBeNull()
  })

  test('vitičasta zagrada unutar teksta ne razbija blok', () => {
    const o = { ...DOBAR, napravljeno: 'Popravila sam {ovo} i "ono" — bez pucanja parsera.' }
    expect(parsirajIzlazKoraka(odgovorS(o)).objekt?.napravljeno).toBe(o.napravljeno)
  })

  test('uzima ZADNJI blok — agent smije citirati predložak iz prompta', () => {
    const predlozak = { napravljeno: '<što je konkretno napravljeno>', dokaz: [] }
    const tekst = `${SHEMA_MARKER}\n${JSON.stringify(predlozak)}\n…rad…\n${SHEMA_MARKER}\n${JSON.stringify(DOBAR)}`
    expect(parsirajIzlazKoraka(tekst).objekt?.napravljeno).toBe(DOBAR.napravljeno)
  })

  test('neispravan JSON se prijavi kao takav, ne kao „nema sheme"', () => {
    const v = ocijeniIzlazKoraka(`${SHEMA_MARKER}\n{"napravljeno": "x", "dokaz": [,]}`)
    expect(v.nadjen).toBe(true)
    expect(v.kod).toBe('neispravan_json')
    expect(v.strojnoProvjerljiv).toBe(false)
  })

  test('proza bez bloka → nema_sheme', () => {
    const v = ocijeniIzlazKoraka('Sve sam napravio i verificirao, radi savršeno.')
    expect(v.kod).toBe('nema_sheme')
    expect(v.strojnoProvjerljiv).toBe(false)
  })
})

describe('provjera stavke dokaza', () => {
  test('naredba bez izlaza nije dokaz', () => {
    const s = provjeriStavkuDokaza({ vrsta: 'naredba', naredba: 'bun test' })
    expect(s.provjerljiv).toBe(false)
    expect(s.razlog).toContain('izlaz')
  })

  test('naredba s izlazom je dokaz', () => {
    expect(provjeriStavkuDokaza({ vrsta: 'naredba', naredba: 'bun test x', izlaz: '3 pass' }).provjerljiv).toBe(true)
  })

  test('test traži brojčani izlaz', () => {
    expect(provjeriStavkuDokaza({ vrsta: 'test', naredba: 'bun test x', izlaz: 'prošlo je' }).provjerljiv).toBe(false)
    expect(provjeriStavkuDokaza({ vrsta: 'test', naredba: 'bun test x', izlaz: '24 pass, 0 fail' }).provjerljiv).toBe(true)
  })

  test('datoteka mora izgledati kao putanja', () => {
    expect(provjeriStavkuDokaza({ vrsta: 'datoteka', datoteka: 'onaj fajl gore' }).provjerljiv).toBe(false)
    expect(provjeriStavkuDokaza({ vrsta: 'datoteka', datoteka: 'tests/step-schema.test.ts' }).provjerljiv).toBe(true)
  })

  test('http traži statusni kod, commit sha, url adresu', () => {
    expect(provjeriStavkuDokaza({ vrsta: 'http', izlaz: 'ok' }).provjerljiv).toBe(false)
    expect(provjeriStavkuDokaza({ vrsta: 'http', izlaz: 'HTTP 200' }).provjerljiv).toBe(true)
    expect(provjeriStavkuDokaza({ vrsta: 'commit', izlaz: '82575f0' }).provjerljiv).toBe(true)
    expect(provjeriStavkuDokaza({ vrsta: 'url', izlaz: 'https://x.hr/a' }).provjerljiv).toBe(true)
  })

  // TASK-4810 — REGRESIJA NA MJERENE SLUČAJEVE. Doslovni nizovi iz dnevnika 08.–09.09.2026.:
  // tri zadatka (TASK-4766 analiticar, TASK-4783 sucelje, TASK-4797 arhitekt) pala su samo zato što
  // je RAG-upis prijavljen kao vrsta `datoteka`, a ID dokumenta nije putanja. Vrsta `rag`
  // te slučajeve prima, ali NE prima goli naziv kolekcije (TASK-4786) — to nije nalaz.
  test('rag prima ID dokumenta, odbija golu kolekciju', () => {
    expect(provjeriStavkuDokaza({ vrsta: 'rag', izlaz: 'RAG agent_analiticar doc_1788881642284_xhw97o' }).provjerljiv).toBe(true)
    expect(provjeriStavkuDokaza({ vrsta: 'rag', datoteka: 'RAG agent_sucelje doc_1788925087236_puos3m' }).provjerljiv).toBe(true)
    const bez = provjeriStavkuDokaza({ vrsta: 'rag', izlaz: 'RAG agent_arhitekt' })
    expect(bez.provjerljiv).toBe(false)
    expect(bez.razlog).toContain('doc_')
  })

  test('isti RAG-upis pod vrstom "datoteka" i dalje pada — vrsta se ne smije izmisliti', () => {
    expect(provjeriStavkuDokaza({ vrsta: 'datoteka', datoteka: 'RAG agent_arhitekt doc_1788958329155_jydtuo' }).provjerljiv).toBe(false)
  })

  test('rječnik vrsta je ZATVOREN — izmišljena vrsta je greška', () => {
    const s = provjeriStavkuDokaza({ vrsta: 'osjecaj', izlaz: 'dobro je' })
    expect(s.provjerljiv).toBe(false)
    expect(s.razlog).toContain(VRSTE_DOKAZA[0])
  })
})

describe('provjera polja', () => {
  test('valjan izlaz prolazi', () => {
    const s = provjeriPolja(DOBAR as any)
    expect(s.valjan).toBe(true)
    expect(s.provjerljivih).toBe(2)
    expect(s.greske).toEqual([])
  })

  test('svako obavezno polje koje fali imenuje se poimence', () => {
    for (const polje of OBAVEZNA_POLJA) {
      const o: any = { ...DOBAR }
      delete o[polje]
      const s = provjeriPolja(o)
      expect(s.valjan).toBe(false)
      expect(s.greske.some((g) => g.includes(`"${polje}"`))).toBe(true)
    }
  })

  test('prazan dokaz je gola tvrdnja', () => {
    const s = provjeriPolja({ ...DOBAR, dokaz: [] } as any)
    expect(s.valjan).toBe(false)
    expect(s.greske.join(' ')).toContain('prazan')
  })

  test('shema puna proze NE prolazi — to je ista laž u JSON-u', () => {
    const v = ocijeniIzlazKoraka(odgovorS({
      napravljeno: 'Sve je napravljeno i temeljito provjereno.',
      dokaz: [{ vrsta: 'mjerenje', izlaz: 'sve radi odlično' }],
      datoteke: [],
      sljedeci_korak: null,
      nesigurnosti: [],
    }))
    expect(v.strojnoProvjerljiv).toBe(false)
    expect(v.kod).toBe('nevaljana_polja')
  })

  test('prekratko "napravljeno" pada na pragu', () => {
    const s = provjeriPolja({ ...DOBAR, napravljeno: 'gotovo' } as any)
    expect(s.valjan).toBe(false)
    expect(s.greske.join(' ')).toContain(String(MIN_NAPRAVLJENO))
  })

  test('zamjerke za agenta imenuju polja, ne raspoloženje', () => {
    const v = ocijeniIzlazKoraka(odgovorS({ napravljeno: 'x', dokaz: 'bun test' }))
    const z = zamjerkeZaAgenta(v)
    expect(z).toContain(SHEMA_MARKER)
    expect(z).toContain('"dokaz"')
  })
})

describe('mjerilo i dnevnik', () => {
  test('strojnoProvjerljiv traži I valjana polja I bar jedan ponovljiv dokaz', () => {
    const v = ocijeniIzlazKoraka(odgovorS(DOBAR))
    expect(v.strojnoProvjerljiv).toBe(true)
    expect(v.provjerljivih).toBe(2)
    expect(v.datoteke).toEqual(DOBAR.datoteke)
    expect(v.sljedeciKorak).toBe('mjerenje na 50 zadataka')
  })

  test('redak dnevnika nosi brojke, ne pridjeve', () => {
    expect(formatSudKoraka(ocijeniIzlazKoraka(odgovorS(DOBAR)))).toBe(
      'step-schema: OK dokaz=2/2 datoteka=1',
    )
    expect(formatSudKoraka(ocijeniIzlazKoraka('proza'))).toContain('NEVALJAN nema_sheme')
  })
})

describe('tri načina', () => {
  beforeEach(() => loadStepSchemaConfig(true))

  test('off: nema bloka u promptu i ništa se ne provodi', () => {
    const c = postaviNacin('off')
    expect(c.nacin).toBe('off')
    expect(shemaUPromptu(c)).toBe(false)
    expect(shemaSeProvodi(c)).toBe(false)
    expect(blokShemeKoraka(c)).toBe('')
  })

  test('shadow: blok ide u prompt, ali se sud ne provodi', () => {
    const c = postaviNacin('shadow')
    expect(shemaUPromptu(c)).toBe(true)
    expect(shemaSeProvodi(c)).toBe(false)
    expect(blokShemeKoraka(c)).toContain(SHEMA_MARKER)
  })

  test('on: sud se provodi', () => {
    const c = postaviNacin('on')
    expect(shemaSeProvodi(c)).toBe(true)
    expect(blokShemeKoraka(c)).toContain('ODBIJA')
  })

  test('nepoznata vrijednost i neispravan JSON padaju na shadow, nikad na on', () => {
    expect(postaviNacin('ukljuceno').nacin).toBe('shadow')
    writeFileSync(cfgPut, '{ ovo nije json')
    expect(loadStepSchemaConfig(true).nacin).toBe('shadow')
  })

  test('blok u promptu nabraja sva obavezna polja i sve vrste dokaza', () => {
    const b = blokShemeKoraka(postaviNacin('shadow'))
    for (const p of OBAVEZNA_POLJA) expect(b).toContain(p)
    for (const v of VRSTE_DOKAZA) expect(b).toContain(v)
  })

  // TASK-4810: primjer za `rag` je zamalo ušao s pravim imenom kolekcije („agent_inzenjer"),
  // a ono u promptu ima značenje — `rag-collections.wiring` test pao je jer bi svaki agent
  // dobio tuđu kolekciju u primjeru. Primjer smije nositi SAMO rezervirano mjesto.
  test('primjer za rag ne smije sadržavati ime stvarne kolekcije (agent_…)', () => {
    const b = blokShemeKoraka(postaviNacin('shadow'))
    expect(b).not.toMatch(/agent_[a-z]+/)
    expect(b).toContain('doc_')
  })
})

/**
 * W3b/TASK-4879 — DVIJE GRANE, DVIJE RUČICE.
 *
 * Mjereno 15.09.2026. (TASK-4874/4878): način `on` bi odbio 7/50 zatvaranja, a u svih
 * sedam je posao STVARNO obavljen. Nijedno od tih odbijanja nije došlo iz grane
 * `schema_invalid` (0 u svim kohortama od 12.09.) nego iz `schema_missing`. Zato grana
 * koja kažnjava POKVAREN blok smije uživo s načinom `on`, a grana koja kažnjava IZOSTAO
 * blok čeka vlastitu zastavicu `provodiNedostajuci`. `nacin` ostaje off/shadow/on —
 * rollback mora i dalje biti jedna riječ.
 */
describe('W3b · zastavica provodiNedostajuci je ODVOJENA od načina', () => {
  beforeEach(() => loadStepSchemaConfig(true))

  test('zadano je false — sama nadogradnja ne smije nikoga početi odbijati', () => {
    expect(postaviNacin('on').provodiNedostajuci).toBe(false)
    expect(postaviNacin('shadow').provodiNedostajuci).toBe(false)
  })

  test('nacin=on bez zastavice: nevaljan blok se provodi, izostao blok NE', () => {
    const c = postaviNacin('on')
    expect(shemaSeProvodi(c)).toBe(true)
    expect(nedostajuciSeProvodi(c)).toBe(false)
  })

  test('nacin=on + provodiNedostajuci=true: provode se OBJE grane', () => {
    const c = postavi({ nacin: 'on', provodiNedostajuci: true })
    expect(shemaSeProvodi(c)).toBe(true)
    expect(nedostajuciSeProvodi(c)).toBe(true)
  })

  test('zastavica NE zaobilazi način — u shadowu se ne provodi ništa (rollback je jedna riječ)', () => {
    const c = postavi({ nacin: 'shadow', provodiNedostajuci: true })
    expect(shemaSeProvodi(c)).toBe(false)
    expect(nedostajuciSeProvodi(c)).toBe(false)
  })

  test('off gasi obje grane bez obzira na zastavicu', () => {
    const c = postavi({ nacin: 'off', provodiNedostajuci: true })
    expect(shemaUPromptu(c)).toBe(false)
    expect(nedostajuciSeProvodi(c)).toBe(false)
  })

  test('ne-boolean vrijednost i neispravan JSON padaju na false, nikad tiho na true', () => {
    expect(postavi({ nacin: 'on', provodiNedostajuci: 'da' }).provodiNedostajuci).toBe(false)
    expect(postavi({ nacin: 'on', provodiNedostajuci: 1 }).provodiNedostajuci).toBe(false)
    writeFileSync(cfgPut, '{ ovo nije json')
    const c = loadStepSchemaConfig(true)
    expect(c.nacin).toBe('shadow')
    expect(c.provodiNedostajuci).toBe(false)
  })
})

/**
 * W3b · IZUZEĆE DOSEGA za granu `schema_missing`.
 *
 * Načelo je prepisano iz `GitCommitGate`: kažnjava se pravilo koje je izvršitelj VIDIO.
 * Zatvaranje koje blok nikad nije nosilo u promptu ne smije pasti na tome što bloka nema.
 * Tri takva puta (izmjereno 15.09.2026.): trenutno knjigovodstveno zatvaranje
 * (`started_at == completed_at`, nikad spawnano — TASK-4840/4835), sažetak koji umjesto
 * agenta napiše orkestrator (TASK-4875/4876/4877) i čovjekovo zatvaranje s ploče.
 *
 * NEPOZNATO NIJE IZUZETO: izuzeće se mora DOKAZATI. Da je obrnuto, izostanak podatka
 * (npr. poziv bez konteksta) tiho bi ugasio vratara — to je fail-open, a vratari su
 * fail-closed.
 */
describe('W3b · izuzetOdNedostajuceSheme', () => {
  test('bez konteksta NIJE izuzet (nepoznato ≠ izuzeto)', () => {
    expect(izuzetOdNedostajuceSheme().izuzet).toBe(false)
    expect(izuzetOdNedostajuceSheme(null).izuzet).toBe(false)
    expect(izuzetOdNedostajuceSheme({}).izuzet).toBe(false)
  })

  test('čovjekovo zatvaranje s ploče → izuzet', () => {
    const i = izuzetOdNedostajuceSheme({ izvor: 'covjek' })
    expect(i.izuzet).toBe(true)
    expect(i.kod).toBe('covjek')
    expect(i.razlog.toLowerCase()).toContain('čovjek')
  })

  test('sažetak koji piše orkestrator umjesto agenta → izuzet', () => {
    const i = izuzetOdNedostajuceSheme({ izvor: 'orkestrator' })
    expect(i.izuzet).toBe(true)
    expect(i.kod).toBe('orkestrator')
  })

  test('trajna oznaka `bez-bloka` → izuzet (kanal koji preživi do mjerila)', () => {
    const i = izuzetOdNedostajuceSheme({ oznake: ['chat:-1', OZNAKA_BEZ_BLOKA] })
    expect(i.izuzet).toBe(true)
    expect(i.kod).toBe('oznaka')
  })

  // Stvarne oznake s ploče: TASK-4840 (start 15:33:09.490, kraj 15:33:09.520 = 30 ms).
  test('knjigovodstveno zatvaranje (start ≈ kraj) → izuzet, i kad razmak nije nula', () => {
    const i = izuzetOdNedostajuceSheme({
      pocetoU: '2026-09-12T15:33:09.490Z', zavrsenoU: '2026-09-12T15:33:09.520Z',
    })
    expect(i.izuzet).toBe(true)
    expect(i.kod).toBe('knjigovodstveno')
  })

  test('mješovit zapis vremena (ISO Z vs SQLite razmak) se svodi na istu skalu', () => {
    expect(izuzetOdNedostajuceSheme({
      pocetoU: '2026-09-12T12:49:03.484Z', zavrsenoU: '2026-09-12 12:49:03',
    }).izuzet).toBe(true)
  })

  // Stvarne oznake: TASK-4877 (start 12:18:42.646, kraj 12:27:52.162 = 9 min 9 s).
  test('pravi spawn (minute razmaka) NIJE izuzet — taj je prompt blok nosio', () => {
    const i = izuzetOdNedostajuceSheme({
      pocetoU: '2026-09-15T12:18:42.646Z', zavrsenoU: '2026-09-15T12:27:52.162Z',
    })
    expect(i.izuzet).toBe(false)
    expect(i.kod).toBe('nije-izuzet')
  })

  test('granica praga: ispod je izuzet, iznad nije', () => {
    const t0 = Date.parse('2026-09-12T15:33:09.000Z')
    const par = (dt: number) => ({
      pocetoU: new Date(t0).toISOString(), zavrsenoU: new Date(t0 + dt).toISOString(),
    })
    expect(izuzetOdNedostajuceSheme(par(PRAG_TRENUTNOG_ZATVARANJA_MS - 1)).izuzet).toBe(true)
    expect(izuzetOdNedostajuceSheme(par(PRAG_TRENUTNOG_ZATVARANJA_MS + 1)).izuzet).toBe(false)
  })

  test('nedostaje jedna oznaka vremena ili je neispravna → NIJE izuzet i ne baca', () => {
    expect(izuzetOdNedostajuceSheme({ pocetoU: '2026-09-12T15:33:09.490Z' }).izuzet).toBe(false)
    expect(izuzetOdNedostajuceSheme({ zavrsenoU: '2026-09-12T15:33:09.490Z' }).izuzet).toBe(false)
    expect(izuzetOdNedostajuceSheme({ pocetoU: 'bezveze', zavrsenoU: 'bezveze' }).izuzet).toBe(false)
    expect(izuzetOdNedostajuceSheme({ pocetoU: null, zavrsenoU: null }).izuzet).toBe(false)
  })

  // Bez ovoga bi izvršitelj sam sebi pisao oslobođenje: dopiši oznaku, blok preskoči.
  test('izvor=agent VETIRA i oznaku i vremensko izuzeće — taj je prompt blok nosio', () => {
    expect(izuzetOdNedostajuceSheme({
      izvor: 'agent', oznake: [OZNAKA_BEZ_BLOKA],
    }).izuzet).toBe(false)
    expect(izuzetOdNedostajuceSheme({
      izvor: 'agent',
      pocetoU: '2026-09-12T15:33:09.490Z', zavrsenoU: '2026-09-12T15:33:09.520Z',
    }).izuzet).toBe(false)
  })
})

describe('modul ne smije ništa izvršavati', () => {
  test('nema child_process/Bun.spawn u izvoru — dokaz[].naredba je podatak, ne naredba', () => {
    const izvor = require('fs').readFileSync(join(import.meta.dir, '..', 'src', 'core', 'StepSchema.ts'), 'utf-8')
    const kod = izvor.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')
    expect(kod).not.toContain('child_process')
    expect(kod).not.toContain('Bun.spawn')
    expect(kod).not.toContain('execSync')
  })
})
