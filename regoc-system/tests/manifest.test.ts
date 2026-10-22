/**
 * manifest.test.ts — MANIFEST.sha256 lists every file of the komplet with its sha256, and
 * nothing else (plan Mac v3 P11 #4: the package pins sha256(MANIFEST.sha256) in komplet.lock).
 * Run in a git clone, the set of files is `git ls-files`; elsewhere every file outside
 * ignored state directories.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync, readdirSync, lstatSync } from 'fs'
import { join, relative, basename } from 'path'
import { spawnSync } from 'child_process'

const KORIJEN = join(import.meta.dir, '..')
// The template (deploy/…/predlozak) is not a komplet: no sources, schema.sql, MANIFEST or generated
// lists until gradi_komplet.sh builds one. There the tests skip instead of failing (TASK-5662).
const PREDLOZAK = basename(KORIJEN) === 'predlozak' && !existsSync(join(KORIJEN, 'MANIFEST.sha256'))
const PRESKOCI = new Set(['.git', 'node_modules', 'data', 'config', 'tmp'])

function popisDatoteka(): string[] {
  if (existsSync(join(KORIJEN, '.git'))) {
    const r = spawnSync('git', ['-C', KORIJEN, 'ls-files', '-z'], { encoding: 'utf-8' })
    if (r.status === 0) return r.stdout.split('\0').filter(Boolean).filter(f => !lstatSync(join(KORIJEN, f)).isSymbolicLink())
  }
  const out: string[] = []
  const hod = (d: string) => {
    for (const i of readdirSync(d)) {
      const p = join(d, i), s = lstatSync(p)
      if (s.isDirectory()) { if (!PRESKOCI.has(i)) hod(p) } else if (s.isFile()) out.push(relative(KORIJEN, p))
    }
  }
  hod(KORIJEN)
  return out
}

const sha256 = (p: string) => new Bun.CryptoHasher('sha256').update(readFileSync(p)).digest('hex')

describe.skipIf(PREDLOZAK)('MANIFEST.sha256', () => {
  if (PREDLOZAK) { test('komplet only', () => {}); return }
  const redovi = readFileSync(join(KORIJEN, 'MANIFEST.sha256'), 'utf-8').trim().split('\n')
  const karta = new Map(redovi.map(r => { const m = r.match(/^([0-9a-f]{64}) {2}(.+)$/); if (!m) throw new Error(`bad line: ${r}`); return [m[2], m[1]] }))

  test('every listed file exists and matches its sha256', () => {
    const krivo = [...karta].filter(([f, h]) => !existsSync(join(KORIJEN, f)) || sha256(join(KORIJEN, f)) !== h).map(([f]) => f)
    expect(krivo).toEqual([])
  })

  test('every file of the komplet is listed (except MANIFEST.sha256 itself)', () => {
    const fali = popisDatoteka().filter(f => f !== 'MANIFEST.sha256' && !karta.has(f))
    expect(fali).toEqual([])
  })

  test('the daemon entry point is in the manifest', () => {
    expect(karta.has('RegocDaemon.ts')).toBe(true)
  })
})
