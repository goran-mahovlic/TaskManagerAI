#!/usr/bin/env bun
/**
 * Stvara praznu bazu iz `db/schema.sql`.
 *
 * Koristi SQLite ugrađen u Bun, pa ne treba zasebno instalirati `sqlite3`.
 * Sve naredbe u shemi su „CREATE ... IF NOT EXISTS", što znači da je skriptu
 * sigurno pokrenuti i nad postojećom bazom — postojeći podatci ostaju.
 *
 *   bun scripts/init-db.ts
 *   TM_HOME=/var/lib/taskmanager bun scripts/init-db.ts
 */
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { TM_DB, TM_DATA } from '../src/core/paths'
import { seedConcurrency } from '../src/core/ConcurrencySetting'
import { osigurajKolonuRadneMape } from '../src/core/ProjectManager'

const KORIJEN = join(dirname(new URL(import.meta.url).pathname), '..')
const SHEMA = join(KORIJEN, 'db', 'schema.sql')

if (!existsSync(SHEMA)) {
  console.error(`Nema sheme: ${SHEMA}`)
  process.exit(1)
}

const novo = !existsSync(TM_DB)
mkdirSync(TM_DATA, { recursive: true })

console.log(novo ? `Stvaram bazu: ${TM_DB}` : `Baza postoji, primjenjujem shemu: ${TM_DB}`)

const db = new Database(TM_DB)
// WAL je obavezan: ploča čita dok agenti pišu.
db.exec('PRAGMA journal_mode=WAL;')
// Starija baza bez `projects.root_path`: stupac mora postojati PRIJE sheme, jer pogled
// `v_projects_summary` u njoj taj stupac već navodi.
if (!novo && (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get())) {
  if (osigurajKolonuRadneMape(db)) console.log('  stupac projects.root_path dodan (migracija)')
}
db.exec(readFileSync(SHEMA, 'utf-8'))
// Zadane postavke (strop usporednih agenata = 3). Okolina se koristi samo ako postavke još
// nema; postojeća vrijednost se nikad ne prepisuje.
const seed = seedConcurrency(db, process.env as Record<string, string | undefined>)

const broj = (tip: string) =>
  (db.query(`SELECT count(*) AS n FROM sqlite_master WHERE type = ?`).get(tip) as { n: number }).n

console.log('')
console.log('Gotovo.')
console.log(`  baza:     ${TM_DB}`)
console.log(`  tablica:  ${broj('table')}`)
console.log(`  kazala:   ${broj('index')}`)
console.log(`  okidača:  ${broj('trigger')}`)
console.log(`  strop usporednih agenata: ${seed.value}${seed.seeded ? ' (upisano sada)' : ''}`)
console.log('')
console.log('Pokreni poslužitelj s:  bun run start')

db.close()
