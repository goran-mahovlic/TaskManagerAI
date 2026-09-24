// Prazna baza s paketnom shemom (db/schema.sql) za testove koji instanciraju TaskManagerSQL.
// Nikad živa baza: test koji piše u pogonsku bazu jednom je već pustio fixture zadatke u rad.
import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'

const SHEMA = new URL('../../db/schema.sql', import.meta.url).pathname

export function createEmptyTaskDb(dbPath: string): string {
  const db = new Database(dbPath)
  db.exec(readFileSync(SHEMA, 'utf-8'))
  db.close()
  return dbPath
}
