// TASK-5336: test koji radi mkdtemp mora počistiti za sobom.
// /tmp je tmpfs od 100 MB; 07.10.2026. ga je napunilo tisuće zaostalih mapa (odl-filtar,
// energija, tm-*, vr5230…) i kritičar je rušio zadatke s ENOSPC umjesto zbog pravih kvarova.
// Brana je namjerno gruba: datoteka koja stvara privremenu mapu mora sadržavati i brisanje.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const MAPA = import.meta.dir

describe('privremene mape u testovima', () => {
  test('svaka datoteka s mkdtempSync( ima i rmSync( ili rm(', () => {
    const bezCiscenja = readdirSync(MAPA)
      .filter(f => f.endsWith('.ts'))
      .filter(f => {
        const s = readFileSync(join(MAPA, f), 'utf-8')
        return /\bmkdtempSync\(/.test(s) && !/\brmSync\(|\brm\(/.test(s)
      })
    expect(bezCiscenja).toEqual([])
  })
})
