#!/usr/bin/env bun
/**
 * adversarial-provjeri — pokreni adversarijalnu provjeru nalaza jednog koraka (W5 / TASK-4618).
 *
 *   bun ~/.claude/regoc/tools/adversarial-provjeri.ts TASK-4611 [TASK-4612 …]
 *     --proba          ne piše u živi dnevnik (izlaz ide u ~/.tmp/)
 *     --sila           preskoči vrata prihvatljivosti (težina/okidač) — samo za mjerenje
 *     --maks N         najviše N nalaza po koraku (zadano iz configa)
 *     --rok MS         rok po leći (zadano 240000; poziv može čekati GPU)
 *     --modeli SPEC    RUČNI override panela za ovaj prolaz — ne dira config na disku
 *                      („anthropic:opus" = sve tri leće; „dokaz=claude:opus,doseg=ollama:x" = po leći)
 *                      „agent:kriticar" = agent-vratar (Sudac.ts, identitet + brane, bez alata);
 *                      „agent:kriticar/alati" = isti sudac S ALATIMA — leća `protuobjasnjenje`
 *                      svejedno ostaje tekstualna (dizajn TASK-4838 §5: ondje alati troše i ne donose)
 *     --log PUT        drugo odredište dnevnika
 *     --json           strojni ispis
 *
 * OVDJE, a ne u AdversarialVerify.ts, žive mreža i modeli. Modul je čista prosudba bez
 * ijednog izlaza prema van (isti razlog kao `_zasto_zatvoren_rjecnik` u critic-gate.json):
 * tekst agenta je podatak, a alat koji ga šalje modelu mora se moći pročitati u 200 redaka.
 *
 * PROVIDER: dispatch je u `adversarial-pozivac.ts` (ollama, anthropic/claude I agent). Do TASK-4837
 * je svaki spec koji nije „ollama:…" ovdje bacao grešku, pa se panel nije dao izmjeriti ničim
 * osim lokalnim 8B modelima — a baš su oni 05.09.2026. oborili svih 12 kalibracijskih nalaza.
 *
 * TRI OBITELJI MODELA, jedna po leći. Tri poziva istog modela s istim pitanjem daju
 * savršeno korelirane glasove — većina tada ne donosi ništa. Model po leći stoji u
 * config/adversarial-verify.json (`modeli`).
 *
 * GPU: cijela provjera drži jednu bravu (`withGpuLock`) i pozivi se unutar nje SERIJALIZIRAJU.
 * Brava je PID-vezana, pa bi tri usporedna zahtjeva iz istog procesa čekala sama sebe do
 * isteka roka — to je zamka koju ovaj alat izbjegava redom, ne paralelizmom.
 *
 * Autor: Malik (Security), TASK-4618.
 */
import { mkdirSync } from 'fs'
import { join } from 'path'

import {
  ADVERSARIAL_LOG_PATH, LECE, izvuciNalaze, loadAdversarialConfig, ocijeniPrihvatljivost,
  provjeriNalaze, zapisiIshode, type IshodNalaza, type Nalaz, type ProvjeraDeps,
} from '../../AdversarialVerify'
import { napraviPozivac, primijeniOverride } from './adversarial-pozivac'
import { withGpuLock } from '../modeli/ollama-gpu-lock'
import { homedir } from 'os'

const HOME = process.env.HOME || homedir()
const PLOCA = process.env.REGOC_TASKS_API || 'http://localhost:17781'

const argv = process.argv.slice(2)
const zastava = (n: string) => argv.includes(n)
const vrijednost = (n: string, z?: string) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : z
}
const idovi = argv.filter((a) => /^TASK-\d+$/i.test(a)).map((a) => a.toUpperCase())
const proba = zastava('--proba')
const sila = zastava('--sila')
const kaoJson = zastava('--json')
const rokPoLeciMs = Number(vrijednost('--rok', '240000'))

if (!idovi.length) {
  console.error('Uporaba: bun adversarial-provjeri.ts TASK-1234 [TASK-1235 …] [--proba] [--sila] [--maks N] [--rok MS] [--log PUT] [--json]')
  process.exit(2)
}

const cfg = loadAdversarialConfig(true)
const maksNalaza = Number(vrijednost('--maks', String(cfg.maksNalaza)))
const logPut = vrijednost('--log') || (proba ? join(HOME, '.tmp', 'adversarial_verify_proba.jsonl') : ADVERSARIAL_LOG_PATH)
if (proba) { try { mkdirSync(join(HOME, '.tmp'), { recursive: true }) } catch {} }

// Panel za OVAJ prolaz. Zadano ide iz configa; `--modeli` ga mijenja samo u memoriji, jer je
// mjerenje s drugim modelom ručni pokus, a ne promjena zadanog ponašanja sustava.
const { modeli, dirnuto } = primijeniOverride(cfg.modeli, vrijednost('--modeli'))
if (dirnuto) console.error(`⚙ panel za ovaj prolaz (config na disku netaknut): ${JSON.stringify(modeli)}`)

const pozivac = napraviPozivac({ modeli })
const deps: ProvjeraDeps = pozivac.deps

async function dohvatiZadatak(id: string): Promise<any | null> {
  try {
    const r = await fetch(`${PLOCA}/api/tasks/${id}`)
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

interface Redak {
  taskId: string
  kod: string
  razlog: string
  tezina: number
  nalaza: number
  provjerenih: number
  oborenih: number
  neprovjerenih: number
  ishodi: IshodNalaza[]
}

const izvjestaj: Redak[] = []

// ── 1) ŽETVA: svi nalazi svih zadataka prije ijednog poziva ──────────────────
// Tek onda ide jedan prolaz po leći. Razlog je mjeren: izmjena modela na lokalnom
// čvoru košta ponovno učitavanje (11 s vs 70 s na istom nalazu), pa poredak
// „nalaz → tri modela" plati tri učitavanja PO NALAZU. Ovako su tri ukupno.
interface Stavka { taskId: string; meta: any }
const svi: Nalaz[] = []
const meta = new Map<string, Stavka>()

for (const id of idovi) {
  const t = await dohvatiZadatak(id)
  if (!t) { console.error(`✘ ${id}: ploča ga ne poznaje`); continue }
  const p = ocijeniPrihvatljivost(
    { taskId: id, naslov: t.title, opis: t.description, oznake: t.tags, tezina: null },
    sila ? 0 : cfg.pragTezine,
  )
  if (!p.provjeriti && !sila) {
    izvjestaj.push({ taskId: id, kod: p.kod, razlog: p.razlog, tezina: p.tezina, nalaza: 0, provjerenih: 0, oborenih: 0, neprovjerenih: 0, ishodi: [] })
    if (!kaoJson) console.log(`— ${id}: preskočen (${p.kod}) — ${p.razlog}`)
    continue
  }
  const iz = izvuciNalaze(String(t.resultSummary || t.result_summary || ''), maksNalaza)
  if (!iz.nalazi.length) {
    izvjestaj.push({ taskId: id, kod: 'bez_nalaza', razlog: iz.upozorenja.join('; ') || 'iz rezultata se ne da izvući nijedna tvrdnja', tezina: p.tezina, nalaza: 0, provjerenih: 0, oborenih: 0, neprovjerenih: 0, ishodi: [] })
    if (!kaoJson) console.log(`— ${id}: nema nalaza za provjeru (${iz.upozorenja.join('; ')})`)
    continue
  }
  for (const n of iz.nalazi) {
    const kljuc = `${id}#${n.id}`
    svi.push({ ...n, id: kljuc })
    meta.set(kljuc, { taskId: id, meta: { p, iz, t } })
  }
  if (!kaoJson) console.log(`▶ ${id}: ${iz.nalazi.length} nalaza (izvor: ${iz.izvor}, težina ${p.tezina})`)
}

if (!svi.length) {
  if (!kaoJson) console.log('\nNema nijednog nalaza za provjeru.')
} else {
  if (!kaoJson) console.log(`\n▶ ukupno ${svi.length} nalaza × ${LECE.length} leće = ${svi.length * LECE.length} poziva (poredak: po leći)`)

  // ── 2) PROVJERA: jedna brava za cijeli prolaz, pozivi u redu ───────────────
  // Brava je za lokalni GPU. Panel bez ijednog Ollama modela nema što čuvati, pa se ne otima
  // za bravu koju drugi procesi stvarno trebaju.
  const uBravi = pozivac.koristiOllamu()
    ? <T,>(fn: () => Promise<T>) => withGpuLock('adversarial-verify', { maxWaitMs: 300_000, proceedOnTimeout: true }, fn)
    : <T,>(fn: () => Promise<T>) => fn()
  const r = await uBravi(async () =>
    provjeriNalaze(svi, { vrsta: null, opisPosla: 'REGOČ — dovršeni zadatci' }, deps, {
      rokPoLeciMs, ukupniProracunMs: Math.max(cfg.ukupniProracunMs, svi.length * LECE.length * 60_000),
      potrebnoZaPad: cfg.potrebnoZaPad, redoslijed: 'po-leci',
    }))

  // ── 3) RAZVRSTAVANJE i zapis, po zadatku ──────────────────────────────────
  const poZadatku = new Map<string, IshodNalaza[]>()
  for (const i of r.ishodi) {
    const m = meta.get(i.nalaz.id)
    if (!m) continue
    if (!poZadatku.has(m.taskId)) poZadatku.set(m.taskId, [])
    poZadatku.get(m.taskId)!.push(i)
  }

  for (const [id, ishodi] of poZadatku) {
    const { p, iz, t } = meta.get(ishodi[0].nalaz.id)!.meta
    try {
      zapisiIshode(ishodi, {
        taskId: id, agentId: String(t.assignee || ''), nacin: cfg.nacin, vrsta: p.vrsta,
        tezina: p.tezina, tezinaIzvor: p.tezinaIzvor, izvorNalaza: iz.izvor,
        // Ručni alat NIKAD ne materijalizira: bilježi sud, ne dira zadatak.
        materijalizirano: false,
      }, logPut)
    } catch (e: any) { console.error(`⚠ dnevnik ${id}: ${e?.message || e}`) }

    const oborenih = ishodi.filter((i) => i.oboren).length
    const neprovjerenih = ishodi.filter((i) => i.neprovjeren).length
    izvjestaj.push({
      taskId: id, kod: p.kod, razlog: p.razlog, tezina: p.tezina, nalaza: ishodi.length,
      provjerenih: ishodi.length - neprovjerenih, oborenih, neprovjerenih, ishodi,
    })

    if (!kaoJson) {
      console.log(`\n${id} (težina ${p.tezina}, ${p.kod}):`)
      for (const i of ishodi) {
        const znak = i.oboren ? '✘ OBOREN' : i.neprovjeren ? '⏳ NEPROVJEREN' : '✔ stoji'
        console.log(`   ${znak} ${i.nalaz.id} „${i.nalaz.tvrdnja.slice(0, 90)}"`)
        for (const g of i.glasovi) {
          console.log(`      ${g.leca.padEnd(17)} ${String(g.sud).padEnd(8)} ${g.greska ? `(${g.greska})` : (g.razlog || '').slice(0, 110)}`)
        }
      }
    }
  }
  if (!kaoJson) console.log(`\nProvjera trajala ${Math.round(r.trajanjeMs / 1000)} s, preskočeno ${r.preskoceno}`)
}

const ukupno = izvjestaj.reduce((a, r) => ({
  nalaza: a.nalaza + r.nalaza, provjerenih: a.provjerenih + r.provjerenih,
  oborenih: a.oborenih + r.oborenih, neprovjerenih: a.neprovjerenih + r.neprovjerenih,
}), { nalaza: 0, provjerenih: 0, oborenih: 0, neprovjerenih: 0 })

const cijena = { usd: pozivac.ukupnoUsd(), poziva: pozivac.trosak.length, bezCijene: pozivac.bezCijene(), modeli }

if (kaoJson) {
  console.log(JSON.stringify({ log: logPut, nacin: cfg.nacin, ukupno, cijena, zadatci: izvjestaj }, null, 2))
} else {
  const udio = ukupno.provjerenih ? (100 * ukupno.oborenih / ukupno.provjerenih) : 0
  console.log(`\nUKUPNO: ${ukupno.nalaza} nalaza, provjereno ${ukupno.provjerenih}, oboreno ${ukupno.oborenih} (${udio.toFixed(1)} %), neprovjereno ${ukupno.neprovjerenih}`)
  if (cijena.poziva) {
    console.log(`CIJENA: ${cijena.poziva} poziva, ${cijena.usd.toFixed(4)} USD${cijena.bezCijene ? ` (${cijena.bezCijene} poziva bez poznate cijene — lokalni model)` : ''}`)
  }
  console.log(`Dnevnik: ${logPut}${proba ? ' (proba — živi dnevnik netaknut)' : ''}`)
}
