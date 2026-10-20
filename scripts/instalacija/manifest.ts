#!/usr/bin/env bun
/**
 * manifest — $TM_HOME/instalirano.json: sve što je instalacija stvorila IZVAN git stabla
 * (plan Mac v3 P3, P3.4). `deinstaliraj.sh --do-nule` briše PO OVOM POPISU, a ne po
 * pogađanju — zato se ovdje upisuje samo ono što je instalacija sama stvorila.
 *
 *   printf 'put|vrsta|korak\n…' | bun scripts/instalacija/manifest.ts <instalirano.json>
 *
 * Isti put se ne upisuje dvaput (drugo pokretanje instalacije → „dodano 0").
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export interface Stavka { put: string; vrsta: string; korak: string; kada: string }
export interface Manifest { verzija: 1; stvoreno: Stavka[] }

export function spoji(m: Manifest, retci: string[], kada = new Date().toISOString()): { m: Manifest; dodano: number } {
  const poznato = new Set(m.stvoreno.map(s => s.put))
  let dodano = 0
  for (const r of retci) {
    const [put, vrsta = 'datoteka', korak = ''] = r.split('|')
    if (!put || !put.startsWith('/') || poznato.has(put)) continue
    m.stvoreno.push({ put, vrsta, korak, kada }); poznato.add(put); dodano++
  }
  return { m, dodano }
}

if (import.meta.main) {
  const put = process.argv[2]
  if (!put) { console.error('uporaba: manifest.ts <instalirano.json> < retci'); process.exit(2) }
  let m: Manifest = { verzija: 1, stvoreno: [] }
  if (existsSync(put)) {
    try { m = JSON.parse(readFileSync(put, 'utf-8')) } catch { console.error(`${put} nije ispravan JSON — ne prepisujem ga`); process.exit(5) }
  }
  const { dodano } = spoji(m, (await Bun.stdin.text()).split('\n').filter(Boolean))
  if (dodano) {
    mkdirSync(dirname(put), { recursive: true })
    writeFileSync(`${put}.novo`, JSON.stringify(m, null, 2) + '\n', { mode: 0o600 })
    renameSync(`${put}.novo`, put); chmodSync(put, 0o600)
  }
  console.log(`manifest ${put}: dodano ${dodano}, ukupno ${m.stvoreno.length}`)
}
