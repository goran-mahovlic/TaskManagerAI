/**
 * PostaOdgovor.procitajProvjereno — provjera „u dopuštenoj mapi" NAKON otvaranja, prenosivo
 * (TASK-5691): prije je stvarnu putanju opisnika čitala iz /proc/self/fd, pa je na macOS-u (nema
 * /proc) ta provjera tiho otpadala. Sada: realpath putanje mora biti u mapi i voditi na isti inode
 * kao otvoreni opisnik — na Linuxu i na macOS-u jednako.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { procitajProvjereno } from '../src/PostaOdgovor'

let KOR = ''
beforeAll(() => { KOR = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'posta-prenosivo-')) })
afterAll(() => { try { rmSync(KOR, { recursive: true, force: true }) } catch {} })

describe('procitajProvjereno bez /proc', () => {
  test('datoteka u dopuštenoj mapi se čita', () => {
    const radni = join(KOR, 'radni'); mkdirSync(radni, { recursive: true })
    writeFileSync(join(radni, 'tablica.csv'), 'a;b\n')
    const r = procitajProvjereno(join(radni, 'tablica.csv'), [radni], 1024)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sadrzaj.toString()).toBe('a;b\n')
  })

  test('međumapa zamijenjena poveznicom van (nakon provjere pozivatelja) → izvan dopuštene mape', () => {
    const radni = join(KOR, 'radni2'); const van = join(KOR, 'tajno')
    mkdirSync(radni, { recursive: true }); mkdirSync(van, { recursive: true })
    writeFileSync(join(van, 'credentials.txt'), 'tajna\n')
    symlinkSync(van, join(radni, 'privitci'))
    const r = procitajProvjereno(join(radni, 'privitci', 'credentials.txt'), [radni], 1024)
    expect(r).toEqual({ ok: false, razlog: 'izvan dopuštene mape' })
  })

  test('posljednja sastavnica kao poveznica → odbijeno (O_NOFOLLOW)', () => {
    const radni = join(KOR, 'radni3'); mkdirSync(radni, { recursive: true })
    writeFileSync(join(KOR, 'van.txt'), 'x\n')
    symlinkSync(join(KOR, 'van.txt'), join(radni, 'p.txt'))
    expect(procitajProvjereno(join(radni, 'p.txt'), [radni], 1024).ok).toBe(false)
  })

  test('modul više ne čita /proc (brana prenosivosti K1)', () => {
    const izvor = readFileSync(join(import.meta.dir, '..', 'src', 'PostaOdgovor.ts'), 'utf-8')
    expect(/\/proc\b/.test(izvor)).toBe(false)
  })
})
