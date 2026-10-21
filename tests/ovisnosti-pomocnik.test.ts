/**
 * TASK-5657 (uputa #421): instalacijski testovi posuđuju ovisnosti iz node_modules izvornog stabla
 * (TM_POSUDI_IZ). U svježoj kopiji (git worktree kritičara) node_modules nema, pa je install.sh
 * padao s izlazom 8 („zod" nedostaje). Pomoćnik zato sam pokrene `bun install --frozen-lockfile`.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { osigurajOvisnosti } from './helpers/ovisnosti'

const privremena = () => { const d = process.env.TMPDIR || tmpdir(); mkdirSync(d, { recursive: true }); return mkdtempSync(join(d, 'tm-ovis-')) }

describe('osigurajOvisnosti', () => {
  test('zod već postoji → ne pokreće bun install, vraća node_modules', () => {
    const d = privremena()
    try {
      mkdirSync(join(d, 'node_modules/zod'), { recursive: true })
      const pozivi: string[][] = []
      expect(osigurajOvisnosti(d, a => { pozivi.push(a); return 0 })).toBe(join(d, 'node_modules'))
      expect(pozivi).toEqual([])
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  test('nema node_modules → bun install --frozen-lockfile u korijenu', () => {
    const d = privremena()
    try {
      const pozivi: string[][] = []
      osigurajOvisnosti(d, a => { pozivi.push(a); mkdirSync(join(d, 'node_modules/zod'), { recursive: true }); return 0 })
      expect(pozivi).toEqual([['bun', 'install', '--frozen-lockfile']])
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  test('bun install ne uspije → jasna greška s uputom, ne tihi pad install.sh-a', () => {
    const d = privremena()
    try {
      expect(() => osigurajOvisnosti(d, () => 1)).toThrow(/bun install/)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})
