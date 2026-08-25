#!/usr/bin/env bun
/**
 * Sigurnosna preslika baze.
 *
 * Baza radi u WAL načinu, pa obična kopija datoteke dok poslužitelj piše daje nedovršeno
 * stanje. SQLite za to ima naredbu `VACUUM INTO`, koja radi i usred pisanja i usput sažme
 * datoteku. Preslika ide u `$TM_HOME/backups/` s vremenskom oznakom u nazivu.
 *
 *   bun scripts/backup.ts
 *   TM_HOME=/var/lib/taskmanager bun scripts/backup.ts
 */
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { TM_DB, TM_ROOT } from '../src/core/paths'

const ZADRZI = Number(process.env.TM_BACKUP_KEEP) || 14

if (!existsSync(TM_DB)) {
  console.error(`Nema baze na ${TM_DB}. Pokreni prvo: bun run init`)
  process.exit(1)
}

const mapa = join(TM_ROOT, 'backups')
mkdirSync(mapa, { recursive: true })

const oznaka = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const cilj = join(mapa, `tasks-${oznaka}.db`)

const db = new Database(TM_DB, { readonly: true })
db.exec(`VACUUM INTO '${cilj.replace(/'/g, "''")}'`)
db.close()

console.log(`Preslika: ${cilj}  (${(statSync(cilj).size / 1024).toFixed(0)} kB)`)

// Zadrži zadnjih N preslika, ostale ukloni.
const stare = readdirSync(mapa)
  .filter(f => f.startsWith('tasks-') && f.endsWith('.db'))
  .sort()
  .slice(0, -ZADRZI)

for (const f of stare) {
  unlinkSync(join(mapa, f))
  console.log(`Uklonjena stara preslika: ${f}`)
}
