/**
 * regoc-system.test.ts — TASK-5705 (odluka D3 = B): komplet izvornog sustava je mapa regoc-system/
 * ovog paketa (isti repozitorij, isti commit), a ne zaseban repozitorij s komplet.lock.
 * Ovdje se provjerava ono što paket o mapi tvrdi; testovi samog kompleta vrte se u njoj
 * (`cd regoc-system && bun test`), jer komplet ima vlastite ovisnosti.
 */
import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const KORIJEN = join(import.meta.dir, '..')
const K = join(KORIJEN, 'regoc-system')
const citaj = (rel: string) => readFileSync(join(KORIJEN, rel), 'utf-8')

describe('regoc-system/ u paketu', () => {
  test('nosi daemon, manifest, registar tajni, prekidače i README na dva jezika', () => {
    for (const f of ['RegocDaemon.ts', 'MessageQueue.ts', 'MANIFEST.sha256', 'TAJNE.json', 'PREKIDACI.md', 'README.md', 'README.hr.md',
      'instalacija.sh', 'package.json', 'bun.lock', 'ULAZI.txt', 'POVEZNICE.tsv', 'KOMPLET.json']) expect(existsSync(join(K, f))).toBe(true)
  })

  test('KOMPLET.json kaže odredište instalacije relativno na HOME (paket ga ne zna sam, ADR-0001 O1.4)', () => {
    const o = JSON.parse(readFileSync(join(K, 'KOMPLET.json'), 'utf-8')).odrediste
    expect(typeof o).toBe('string')
    expect(o.length).toBeGreaterThan(0)
    expect(o.startsWith('/') || o.includes('..')).toBe(false)
  })

  test('svaka datoteka manifesta postoji s tim sha256 (ono što install.sh --komplet provjerava)', () => {
    const krivo: string[] = []
    for (const r of readFileSync(join(K, 'MANIFEST.sha256'), 'utf-8').trim().split('\n')) {
      const [h, f] = [r.slice(0, 64), r.slice(66)]
      const p = join(K, f)
      if (!existsSync(p) || new Bun.CryptoHasher('sha256').update(readFileSync(p)).digest('hex') !== h) krivo.push(f)
    }
    expect(krivo).toEqual([])
  })

  test('git paketa ne ignorira nijednu datoteku manifesta (klon paketa ima cijeli komplet)', () => {
    const popis = readFileSync(join(K, 'MANIFEST.sha256'), 'utf-8').trim().split('\n').map(r => `regoc-system/${r.slice(66)}`)
    const r = Bun.spawnSync(['git', 'check-ignore', '--no-index', '--stdin'], { cwd: KORIJEN, stdin: new TextEncoder().encode(popis.join('\n') + '\n') })
    expect(r.stdout.toString().trim()).toBe('')
  })

  test('nema komplet.lock ni zasebnog repozitorija regoc-komplet (D3 = B)', () => {
    expect(existsSync(join(KORIJEN, 'config', 'komplet.lock'))).toBe(false)
    expect(citaj('scripts/install.sh')).not.toContain('komplet.lock ne postoji')
    expect(citaj('scripts/install.sh')).not.toMatch(/git clone[^\n]*KOMPLET/)
  })

  test('testovi paketa ne vrte testove kompleta (bunfig.toml: root = tests)', () => {
    expect(citaj('bunfig.toml')).toMatch(/\[test\][\s\S]*root\s*=\s*"tests"/)
  })
})

describe('dokumentacija upućuje na regoc-system/README', () => {
  for (const [rel, cilj] of [
    ['README.md', 'regoc-system/README.md'], ['README.hr.md', 'regoc-system/README.hr.md'],
    ['REGOC/ARHITEKTURA.md', '../regoc-system/README.hr.md'], ['REGOC/ARHITEKTURA.en.md', '../regoc-system/README.md'],
  ] as const) {
    test(`${rel} → ${cilj}`, () => {
      expect(citaj(rel)).toContain(`](${cilj})`)
      expect(citaj(rel)).not.toContain('config/komplet.lock')
    })
  }

  test('README kompleta (HR i EN) ima sve tražene odjeljke', () => {
    const hr = readFileSync(join(K, 'README.hr.md'), 'utf-8'), en = readFileSync(join(K, 'README.md'), 'utf-8')
    for (const n of ['## Što je u kompletu', '## Ovisnosti', '## Instalacija', '## Pokretanje i zaustavljanje', '## Dnevnici',
      '## Postavke', '## Tajne', '## Tajne nakon instalacije', '## Nadogradnja', '## Deinstalacija', '## Ponovni izvoz', '## Provjera']) expect(hr).toContain(n)
    for (const n of ['## What is in the kit', '## Dependencies', '## Installing', '## Starting and stopping', '## Logs',
      '## Settings', '## Secrets', '## Secrets after installation', '## Upgrading', '## Uninstalling', '## Exporting the kit again', '## Verifying']) expect(en).toContain(n)
    for (const t of [hr, en]) for (const s of ['hr.regoc.daemon', 'regoc-daemon.service', 'gradi_komplet.sh --javno', 'bootcheck.sh', 'features.json'])
      expect(t).toContain(s)
    for (const s of ['vrata autonomije', 'strop usporednih', 'ručna kočnica']) expect(hr.toLowerCase()).toContain(s)
    for (const s of ['autonomy gate', 'concurrency cap', 'handbrake']) expect(en.toLowerCase()).toContain(s)
  })

  test('README kompleta nema neispunjenu oznaku tablice tajni', () => {
    for (const f of ['README.md', 'README.hr.md']) expect(readFileSync(join(K, f), 'utf-8')).not.toContain('<!-- TAJNE')
  })
})

