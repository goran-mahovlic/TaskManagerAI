// ADR-0023 §7a (TASK-5622): jednosmjerni prijenos regoc → paket je zaključan.
// Skripta kopira CIJELE datoteke iz žive instalacije i time briše rad koji postoji samo u
// paketu (≈ 1730 redaka pri mjerenju TASK-5617). Pokretanje mora odmah izaći, prije ijedne
// kopije. Skripta je interna i nije u gitu, pa se u svježem klonu provjera preskače.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const KORIJEN = join(import.meta.dir, '..')
const SKRIPTA = join(KORIJEN, 'scripts/uskladi_s_regocem.sh')

describe('uskladi_s_regocem.sh — zaključano (ADR-0023)', () => {
  test.skipIf(!existsSync(SKRIPTA))('izlazi s porukom i ne kopira ništa', () => {
    // Lažni izvor: kad bi skripta krenula kopirati, uzela bi ovu datoteku umjesto prave.
    const lazni = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'uskladi-'))
    try {
      mkdirSync(join(lazni, 'TaskManagerMD/src'), { recursive: true })
      writeFileSync(join(lazni, 'TaskManagerMD/src/TaskWebUI.ts'), '// LAZNI IZVOR\n')
      const prije = readFileSync(join(KORIJEN, 'src/TaskWebUI.ts'), 'utf-8')
      const r = Bun.spawnSync(['bash', SKRIPTA], { env: { ...process.env, REGOC: lazni } })
      const izlaz = r.stdout.toString() + r.stderr.toString()
      expect(r.exitCode).not.toBe(0)
      expect(izlaz).toContain('zaključano')
      expect(izlaz).toContain('ADR-0023')
      expect(readFileSync(join(KORIJEN, 'src/TaskWebUI.ts'), 'utf-8')).toBe(prije)
    } finally {
      rmSync(lazni, { recursive: true, force: true })
    }
  })
})
