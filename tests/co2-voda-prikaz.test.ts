/**
 * ADR-0011 §4/TASK-4822 — pravila PRIKAZA za CO₂ i vodu.
 *
 * Zašto test nad izvorom ploče a ne nad DOM-om: ploča je jedan 13 000-redaka template
 * literal koji se ne uvozi kao modul. Ono što ovdje puca jest upravo ono što bi se tiho
 * izgubilo pri sljedećem uređivanju — obvezni znakovi procjene. Sam prikaz je provjeren
 * na sjeni (17791) prije restarta živoga.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'

const UI = readFileSync(new URL('../src/TaskWebUI.ts', import.meta.url).pathname, 'utf8')

describe('četiri obavezna znaka procjene vrijede i za CO₂ i za vodu (ADR-0010 §8.2)', () => {
  test('oba čipa nose znak ≈ (&asymp;) — nikad goli broj', () => {
    for (const fn of ['projectCo2Chip', 'projectVodaChip']) {
      const tijelo = UI.slice(UI.indexOf('function ' + fn), UI.indexOf('function ' + fn) + 1200)
      expect(tijelo).toContain('&asymp;')
    }
  })

  test('oba su u ŽUTOJ obitelji — ne uvodi se nova boja uz postojeće značenje', () => {
    expect(UI).toContain('.project-count.c-co2 b { color: #eab308; }')
    expect(UI).toContain('.project-count.c-voda b { color: #eab308; }')
  })

  test('riječ „procjena" stoji u VIDLJIVOJ oznaci panela, ne samo u tooltipu', () => {
    expect(UI).toContain("'procjena CO₂ (nije mjereno)'")
    expect(UI).toContain("'GRUBA procjena vode (nije mjereno)'")
  })

  test('oba čipa se crtaju na kartici projekta', () => {
    expect(UI).toContain('projectCo2Chip(project.id)')
    expect(UI).toContain('projectVodaChip(project.id)')
  })
})

describe('voda nosi JAČE označavanje od struje i CO₂ (ADR-0011 §3.4, §4)', () => {
  test('iscrtkan obrub — razlika se vidi i bez boje (crno-bijeli ispis, daltonizam)', () => {
    expect(UI).toContain('.project-count.c-voda { background: rgba(234,179,8,0.08); border: 1px dashed')
  })

  test('znak ⚠ stoji U ČIPU, ne samo u tooltipu — vidljiv bez hovera', () => {
    const tijelo = UI.slice(UI.indexOf('function projectVodaChip'), UI.indexOf('function projectEnergijaChip'))
    expect(tijelo).toContain('&#9888;')
  })

  test('nijedan znak izvan BMP-a — 💧 U+1F4A7 je tofu, izmjereno u pregledniku 12.09.', () => {
    // sirina glifa 💧 bila je TOCNO jednaka referentnoj sirini „nedostaje glif" (9,6 px),
    // dok ⚡ (11,2) i ⚠ (14,3) rendiraju. Emoji u cipu = prazan kvadratic kod korisnika.
    expect(UI).not.toContain('&#128167;')
    expect(UI.slice(UI.indexOf('function projectVodaChip'), UI.indexOf('function projectEnergijaChip')))
      .toContain('H&#8322;O')
  })

  test('tooltip vode počinje riječima NAJNESIGURNIJA, a struje/CO₂ ne', () => {
    expect(UI).toContain("'voda_naslov', 'NAJNESIGURNIJA od tri procjene")
    expect(UI).toContain("'co2_naslov', 'procjena CO₂")
  })

  test('tooltipi imenuju SVOJ pojas: ÷3…×3 struja, ÷4…×4 CO₂, ÷10…×6 voda', () => {
    expect(UI).toContain('(÷3…×3)')
    expect(UI).toContain('(÷4…×4)')
    expect(UI).toContain('(÷10…×6)')
  })

  test('tooltip vode imenuje granicu obračuna (lice mjesta vs proizvodnja struje)', () => {
    expect(UI).toContain('WUE broji SAMO vodu na licu mjesta')
  })

  test('tooltip CO₂ nosi ogradu da se model ne vrti na EU mreži', () => {
    expect(UI).toContain('modeli se NE vrte na EU mreži nego u SAD-u')
  })
})

describe('jedan izvor istine za konstante', () => {
  test('klijent NEMA vlastitu kopiju faktora ni WUE — čita ih iz odgovora poslužitelja', () => {
    const klijent = UI.slice(UI.indexOf('function co2Tekst'), UI.indexOf('function projectEnergijaChip'))
    expect(klijent).not.toMatch(/0\.21|1\.1\b/)          // konstante žive samo u CostTracker.ts
    expect(klijent).toContain('c.faktor')
    expect(klijent).toContain('v.wue')
  })

  test('P3 uzima faktor i WUE iz odgovora, a ne iz ugrađenog broja', () => {
    expect(UI).toContain('data.energija.co2) ? data.energija.co2.faktor : null')
    expect(UI).toContain('data.energija.voda) ? data.energija.voda.wue : null')
  })

  test('P3 NEMA nove stupce — CO₂ i voda idu u tooltip stupca struje (ADR-0011 §4.1)', () => {
    const zaglavlje = UI.slice(UI.indexOf("_T('energija_stupac'"), UI.indexOf("_T('energija_stupac'") + 200)
    expect(zaglavlje).toContain('</tr></thead>')          // struja je ZADNJI stupac tablice
  })
})

describe('zamka atributa title= (uhvaćena na sjeni 17791, 12.09.2026.)', () => {
  // co2Tekst/vodaTekst pune I tijelo HTML-a I title=. Entitet u atributu se NE razrješuje:
  // tooltip je doslovno pisao „kg CO&#8322;e". Build to ne vidi, testovi nad brojkama ne vide,
  // vidi se tek u pregledniku — zato brana ovdje.
  const tekstFn = UI.slice(UI.indexOf('function co2Tekst'), UI.indexOf('function co2Opis'))

  test('co2Tekst i vodaTekst ne vraćaju nijedan HTML entitet', () => {
    expect(tekstFn).not.toMatch(/&[a-zA-Z]+;|&#\d+;/)
  })

  test('vraćaju doslovne UTF-8 znakove koji rade u oba konteksta', () => {
    expect(tekstFn).toContain('kg CO₂e')
    expect(tekstFn).toContain('m³')
  })

  test('tooltip stupca u P3 nosi ≈ kao znak, ne kao entitet', () => {
    const p3 = UI.slice(UI.indexOf('var co2Faktor ='), UI.indexOf('var co2Faktor =') + 2500)
    expect(p3).toContain("'; ≈ ' + co2Tekst(")
    expect(p3).not.toContain("'; &asymp; ' + co2Tekst(")
  })
})

describe('zamka template literala (ADR-0010 §9)', () => {
  test('klijentski dio nema backtick ni obrnutu kosu crtu koji bi srušili cijelu ploču', () => {
    const klijent = UI.slice(UI.indexOf('function co2Tekst'), UI.indexOf('function projectEnergijaChip'))
    expect(klijent).not.toContain('`')
    expect(klijent).not.toMatch(/\\[wdsb]/)
  })
})
