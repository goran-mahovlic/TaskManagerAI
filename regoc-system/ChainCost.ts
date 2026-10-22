/**
 * ChainCost — UKUPAN TROŠAK LANCA, zapisan na roditeljskom zadatku (U5 / TASK-4265).
 *
 * Razrada: `~/app/regoc_system/docs/RAZRADA-3691_workflow_i_pragovi.md` §2 („zašto pragovi
 * uopće postoje — brojke") i §4.
 *
 * ZAŠTO POSTOJI. Razlaganje jedan zadatak pretvori u 4–8 zadataka. Trošak se pritom
 * razmaže po podzadatcima, pa na roditelju — jedinom mjestu koje čovjek gleda — piše
 * gotovo ništa. Pitanje „je li se lanac isplatio" tada se ne može postaviti, a ono je
 * jedini razlog zbog kojeg pragovi iz §2 uopće imaju broj.
 *
 * IZVOR I NJEGOVA GRANICA. Zbraja se `cost_log` iz `data/regoc.db` po `task_id`.
 * `cost_log` NIJE potpun izvor: mjereno 30.08.2026. pokriva oko četvrtine ukupnog
 * troška (spawn koji ne javi cijenu ne ostavlja redak). Zato zapis na zadatku UVIJEK
 * nosi i broj redaka — brojka bez broja redaka laže samouvjereno, a s njim je donja
 * granica koju se smije uspoređivati s drugim lancima mjerenima istim mjerilom.
 *
 * Baza se otvara SAMO ZA ČITANJE.
 *
 * Autorica: Kosjenka (Architect), TASK-4265.
 */

import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import { join } from 'path'

const HOME = process.env.HOME || process.env.USERPROFILE || ''

export function regocDbPath(): string {
  return process.env.REGOC_DB_PATH || join(HOME, '.claude', 'regoc', 'data', 'regoc.db')
}

export interface ChainCostRow {
  taskId: string
  costUsd: number
  records: number
  models: string[]
  /** Vrijeme prvog i zadnjeg zapisa (za „koliko je lanac trajao"). */
  first?: string
  last?: string
}

export interface ChainCostResult {
  parentTaskId: string
  /** Roditelj + svi podzadatci. */
  ukupno: number
  roditelj: ChainCostRow
  podzadaci: ChainCostRow[]
  /** Ukupan broj redaka u `cost_log` — bez njega je iznos neusporediv. */
  zapisa: number
  /** Zadatci lanca za koje `cost_log` nema nijedan redak. */
  bezZapisa: string[]
}

const PRAZNO = (taskId: string): ChainCostRow => ({ taskId, costUsd: 0, records: 0, models: [] })

/**
 * Zbroji trošak roditelja i podzadataka. Nepostojeća baza ili pokvaren upit vraćaju
 * nule — mjerilo koje ruši pozivatelja gore je od mjerila koje prizna da ne zna
 * (isti razlog kao fail-open u `loadIngestGateConfig`).
 */
export function chainCost(parentTaskId: string, subtaskIds: string[] = [], opts: { dbPath?: string } = {}): ChainCostResult {
  const parent = String(parentTaskId || '').trim().toUpperCase()
  const djeca = [...new Set(subtaskIds.map(x => String(x || '').trim().toUpperCase()).filter(x => x && x !== parent))]
  const prazno: ChainCostResult = {
    parentTaskId: parent, ukupno: 0, roditelj: PRAZNO(parent),
    podzadaci: djeca.map(PRAZNO), zapisa: 0, bezZapisa: [parent, ...djeca],
  }
  const dbPath = opts.dbPath || regocDbPath()
  if (!parent || !existsSync(dbPath)) return prazno

  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const svi = [parent, ...djeca]
    const upitnici = svi.map(() => '?').join(',')
    const redci = db.query(`
      SELECT task_id AS taskId,
             SUM(COALESCE(cost_usd, 0)) AS costUsd,
             COUNT(*) AS records,
             GROUP_CONCAT(DISTINCT model) AS models,
             MIN(timestamp) AS first,
             MAX(timestamp) AS last
        FROM cost_log
       WHERE UPPER(task_id) IN (${upitnici})
       GROUP BY UPPER(task_id)
    `).all(...svi) as Array<{ taskId: string; costUsd: number; records: number; models: string | null; first: string; last: string }>

    const poZadatku = new Map<string, ChainCostRow>()
    for (const r of redci) {
      const id = String(r.taskId || '').toUpperCase()
      poZadatku.set(id, {
        taskId: id,
        costUsd: Number(r.costUsd) || 0,
        records: Number(r.records) || 0,
        models: String(r.models || '').split(',').map(s => s.trim()).filter(Boolean),
        first: r.first, last: r.last,
      })
    }

    const roditelj = poZadatku.get(parent) || PRAZNO(parent)
    const podzadaci = djeca.map(id => poZadatku.get(id) || PRAZNO(id))
    const ukupno = roditelj.costUsd + podzadaci.reduce((s, p) => s + p.costUsd, 0)
    const zapisa = roditelj.records + podzadaci.reduce((s, p) => s + p.records, 0)
    return {
      parentTaskId: parent, ukupno, roditelj, podzadaci, zapisa,
      bezZapisa: [roditelj, ...podzadaci].filter(r => r.records === 0).map(r => r.taskId),
    }
  } catch {
    return prazno
  } finally {
    try { db?.close() } catch {}
  }
}

/** Iznos u hrvatskom zapisu (decimalni zarez), uvijek s dvije znamenke. */
export function usd(n: number): string {
  return `${(Number(n) || 0).toFixed(2).replace('.', ',')} USD`
}

/**
 * Redak koji ide u `progressNotes` roditelja. Nosi iznos, broj zapisa i razdiobu —
 * i izričitu ogradu o pokrivenosti `cost_log`, da se donja granica ne čita kao mjerenje.
 */
export function formatChainCostNote(r: ChainCostResult, opts: { plannerNote?: string } = {}): string {
  const djeca = r.podzadaci.filter(p => p.records > 0)
  const razdioba = djeca.length
    ? djeca.map(p => `${p.taskId} ${usd(p.costUsd)}`).join(', ')
    : 'podzadatci još nemaju zapis'
  const L = [
    `TROŠAK LANCA ${r.parentTaskId}: ${usd(r.ukupno)} ukupno ` +
      `(roditelj ${usd(r.roditelj.costUsd)} + ${r.podzadaci.length} podzadataka ${usd(r.ukupno - r.roditelj.costUsd)}).`,
    `Razdioba: ${razdioba}.`,
    `Izvor: cost_log, ${r.zapisa} zapisa` +
      (r.bezZapisa.length ? `; bez zapisa: ${r.bezZapisa.join(', ')}` : '') + '.',
    `Ograda: cost_log pokriva samo spawnove koji jave cijenu (mjereno ~25 % ukupnog troška) — ovo je DONJA GRANICA, ne mjerenje.`,
  ]
  if (opts.plannerNote) L.push(opts.plannerNote)
  return L.join(' ')
}

/** Svi zadatci lanca iz plana razlaganja (roditelj + materijalizirani koraci). */
export function collectChainTaskIds(plan: { taskId: string; steps: Array<{ taskId?: string }> }): string[] {
  return [plan.taskId, ...plan.steps.map(s => s.taskId).filter((x): x is string => !!x)]
}
