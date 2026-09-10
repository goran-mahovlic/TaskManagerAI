/**
 * Brana: skripta ploče mora se dati raščlaniti, a rukovatelji `onclick` moraju
 * nositi navodnike.
 *
 * Povod (TASK-4803, 10.09.2026.): cijeli `<script>` ploče (295 317 znakova) nije se
 * raščlanjivao. Uzrok je jedan znak — unutar predloška je pisalo `\'tel-token\'`
 * umjesto `\\'tel-token\\'`. Predložak pretvori `\'` u goli apostrof, taj apostrof
 * zatvori JS-niz u koji je ugrađen, i ostatak retka postane besmislen. Posljedica
 * nije bila jedna pokvarena kartica nego MRTVA PLOČA: nijedan `fetch` nije krenuo,
 * sve kartice su ostale na „Loading…", a veza je zauvijek pisala „Connecting…".
 *
 * Zašto ovakva brana: to je jedini kvar koji `bun test` nije mogao vidjeti — poslužitelj
 * se digne, `/` vrati 200, a stranica je slijepa. Ovdje se stranica raščlanjuje istim
 * mjerilom kojim je raščlanjuje preglednik.
 */
import { describe, expect, test } from 'bun:test'

const IZVOR = new URL('../src/TaskWebUI.ts', import.meta.url).pathname

/** Tijelo predloška `HTML_TEMPLATE` — bez izvođenja poslužitelja. */
function ploca(): string {
  const s = Bun.file(IZVOR)
  const tekst = require('node:fs').readFileSync(IZVOR, 'utf-8') as string
  void s
  const pocetak = tekst.indexOf('const HTML_TEMPLATE = `') + 'const HTML_TEMPLATE = `'.length
  let j = pocetak
  for (;;) {
    j = tekst.indexOf('`', j)
    if (tekst[j - 1] !== '\\') break
    j += 1
  }
  const tijelo = tekst.slice(pocetak, j)
  // Predložak nema nijednu živu zamjenu (svih 84 `${` je zaštićeno), pa se smije
  // razriješiti isto kako to čini izvođač kad učita modul.
  return new Function('return `' + tijelo + '`')() as string
}

function skripta(html: string): string {
  const i = html.indexOf('<script>')
  const j = html.indexOf('</script>', i)
  expect(i).toBeGreaterThan(-1)
  return html.slice(i + '<script>'.length, j)
}

describe('skripta ploče', () => {
  test('raščlanjuje se — inače je cijela ploča mrtva', () => {
    const kod = skripta(ploca())
    expect(kod.length).toBeGreaterThan(100_000)
    expect(() => new Function(kod)).not.toThrow()
  })

  test('svaki rukovatelj u atributu nosi dvostruko zaštićen navodnik', () => {
    const tekst = require('node:fs').readFileSync(IZVOR, 'utf-8') as string
    const redci = tekst.split('\n')
    const lose: string[] = []
    redci.forEach((r, i) => {
      if (!/on(click|change|input|submit)="/.test(r)) return
      // `\'` u predlošku daje goli apostrof; ispravno je `\\'`, koje daje `\'`.
      const kriv = /(^|[^\\])\\'/.test(r)
      if (kriv) lose.push(`${i + 1}: ${r.trim().slice(0, 110)}`)
    })
    expect(lose).toEqual([])
  })
})

/**
 * Brana: svaka CSS varijabla koja se rabi mora i biti definirana.
 *
 * Povod (TASK-4803): `.info-card` je tražila `var(--card-bg)` i `var(--border-color)`,
 * a `:root` ih nikad nije imao. Nepoznata varijabla u kratici `border` ne pada natrag na
 * zadanu boju — cijelo svojstvo postaje nevaljano, pa je `border-style` ispao `none`.
 * Izmjereno u pregledniku prije ispravka: `background rgba(0,0,0,0)`, `border 0px none`.
 * Osamnaest kartica Configa stajalo je bez ijednog obruba i bez pozadine — ploča na kojoj
 * kartice nisu kartice. Takav kvar se ne vidi ni u jednom `bun test`-u koji gleda podatke.
 */
describe('CSS varijable ploče', () => {
  test('nijedna se ne rabi a da nije definirana', () => {
    const html = ploca()
    const definirane = new Set(Array.from(html.matchAll(/(--[a-z0-9-]+)\s*:/g), (m) => m[1]))
    const rabljene = new Set(Array.from(html.matchAll(/var\((--[a-z0-9-]+)/g), (m) => m[1]))
    const nedostaju = [...rabljene].filter((v) => !definirane.has(v)).sort()
    expect(nedostaju).toEqual([])
  })
})

/**
 * Brana: rječnici se u ploču ubacuju kroz `textContent` (v. `prevediElement`), pa HTML-ov
 * entitet ondje ne postaje znak nego ostaje ispisan doslovno. Povod: naslov kartice
 * „Telegram notifications &mdash; bot token…" doista se tako i vidio na zaslonu.
 */
describe('rječnici', () => {
  const jezici = ['hr', 'en']
  for (const j of jezici) {
    test(`${j}.json nema HTML entiteta (textContent ih ne razrješava)`, () => {
      const putanja = new URL(`../locales/${j}.json`, import.meta.url).pathname
      const r = JSON.parse(require('node:fs').readFileSync(putanja, 'utf-8')) as Record<string, string>
      const lose = Object.entries(r)
        .filter(([, v]) => typeof v === 'string' && /&[a-zA-Z]+;|&#\d+;/.test(v))
        .map(([k, v]) => `${k}: ${v}`)
      expect(lose).toEqual([])
    })
  }
})

/**
 * Brana: nijedan backslash u predlošku ne smije biti pojeden.
 *
 * Unutar predloška (obrnuti navodnik) prežive samo `\\`, `` \` `` i `\$`. Sve ostalo —
 * `\.`, `\s`, `\'` — predložak razriješi PRIJE nego kod dođe u stranicu, pa u pregledniku
 * radi nešto drugo od onoga što u izvoru piše. Kvar je nevidljiv: kod izgleda ispravno.
 *
 * Mjereno na ovom izvoru (TASK-4803) — četiri nalaza, dva sa stvarnom posljedicom:
 *   • `staza.replace(/\./g, '-')` → u stranici `/./g`, koje pogađa SVAKI znak. Sva polja
 *     integracija dobila su id od samih crtica; dva polja s imenom iste duljine dijelila su
 *     isti id, pa je „Spremi" čitao vrijednost TUĐEG polja.
 *   • `input.split(/\s+/)` → u stranici `/s+/`, izraz koji dijeli po slovu „s". Konzola je
 *     zato „ls -la" vidjela kao rečenicu (prva riječ „l"), a ne kao naredbu.
 */
describe('predložak ploče', () => {
  test('nijedan backslash nije pojeden pri razrješavanju predloška', () => {
    const tekst = require('node:fs').readFileSync(IZVOR, 'utf-8') as string
    const pocetak = tekst.indexOf('const HTML_TEMPLATE = `')
    let j = pocetak + 'const HTML_TEMPLATE = `'.length
    for (;;) {
      j = tekst.indexOf('`', j)
      if (tekst[j - 1] !== '\\') break
      j += 1
    }
    const tijelo = tekst.slice(pocetak, j)
    const prijeRedaka = tekst.slice(0, pocetak).split('\n').length - 1
    const nalazi: string[] = []
    for (let k = 0; k < tijelo.length - 1; k++) {
      if (tijelo[k] !== '\\') continue
      const idu = tijelo[k + 1]
      if (idu === '\\' || idu === '`' || idu === '$') { k += 1; continue }
      const redak = prijeRedaka + tijelo.slice(0, k).split('\n').length
      nalazi.push(`${redak}: \\${idu}`)
    }
    expect(nalazi).toEqual([])
  })
})
