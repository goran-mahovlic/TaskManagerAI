/**
 * bez-nasih-vrijednosti.test.ts — the public komplet must not carry private addresses,
 * home directories of real users, e-mail addresses, Telegram group ids or secrets
 * (plan Mac v3 P11 #2). Patterns come from tests/brane-opce.json, written by the export
 * (`gradi_komplet.sh --javno`) from the same list that gates the export itself.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync, lstatSync } from 'fs'
import { join, relative } from 'path'

const KORIJEN = join(import.meta.dir, '..')
const PRESKOCI = new Set(['.git', 'node_modules', 'data', 'config', 'tmp'])
const OPCE: Array<[string, string]> = JSON.parse(readFileSync(join(import.meta.dir, 'brane-opce.json'), 'utf-8')).opce
const TAJNE: string = JSON.parse(readFileSync(join(import.meta.dir, 'brane-opce.json'), 'utf-8')).tajne

function* datoteke(d: string): Generator<string> {
  for (const i of readdirSync(d)) {
    const p = join(d, i)
    const s = lstatSync(p)
    if (s.isDirectory()) { if (!PRESKOCI.has(i)) yield* datoteke(p) }
    else if (s.isFile()) yield p
  }
}

describe('no private values in the komplet', () => {
  const pravila = [...OPCE.map(([k, r]) => [k, new RegExp(r)] as const), ['secret', new RegExp(TAJNE)] as const]
  const pogodci: string[] = []
  let broj = 0
  for (const p of datoteke(KORIJEN)) {
    const b = readFileSync(p)
    if (b.subarray(0, 8192).includes(0)) continue
    broj++
    b.toString('utf-8').split('\n').forEach((red, i) => {
      for (const [k, r] of pravila) if (r.test(red)) pogodci.push(`${k}  ${relative(KORIJEN, p)}:${i + 1}`)
    })
  }

  test('the scan actually read the tree', () => {
    expect(broj).toBeGreaterThan(50)
    expect(pravila.length).toBeGreaterThan(5)
  })

  test('0 hits', () => {
    expect(pogodci).toEqual([])
  })
})
