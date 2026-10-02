/**
 * `tools/tm_putanje.py` — Python zrcalo `src/core/paths.ts` (TASK-5108).
 *
 * Alati u `tools/` su imali vlastite zadane vrijednosti: naš LAN (Ollama, Chroma) i naš
 * raspored mapa. Na tuđem stroju to je tiho čitanje/pisanje u mapu koju nitko ne čita i
 * pozivanje adrese koje nema. Ovdje se provjerava da je korijen ISTI kao u `paths.ts`
 * i da adresa servisa bez varijable okoline ne postoji (nema zadane vrijednosti).
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ALATI = join(import.meta.dir, '..', 'tools')
const PAKET = join(import.meta.dir, '..')

/** Pokreni isječak Pythona s `tools/` na putu i čistom okolinom (samo ono što test zada). */
function py(kod: string, env: Record<string, string> = {}): { izlaz: string; kod: number } {
  const r = Bun.spawnSync(['python3', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(ALATI)})\n${kod}`], {
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: env.HOME || '/nepostojeci-home', ...env },
  })
  return { izlaz: (r.stdout.toString() + r.stderr.toString()).trim(), kod: r.exitCode ?? -1 }
}

describe('tools/tm_putanje.py — isti korijen kao src/core/paths.ts', () => {
  test('bez TM_HOME korijen je $HOME/.taskmanager, baza u data/tasks.db', () => {
    const r = py('import tm_putanje as t; print(t.TM_ROOT); print(t.TM_DB)', { HOME: '/h' })
    expect(r.izlaz).toBe('/h/.taskmanager\n/h/.taskmanager/data/tasks.db')
  })

  test('TM_HOME i TM_DB premještaju korijen i bazu', () => {
    const r = py('import tm_putanje as t; print(t.stanje("x.json")); print(t.TM_DB)',
      { TM_HOME: '/srv/tm', TM_DB: '/brzi/disk.db' })
    expect(r.izlaz).toBe('/srv/tm/data/x.json\n/brzi/disk.db')
  })

  test('konfiguracija: varijabla > $TM_HOME/config (ako postoji) > config/ uz paket', () => {
    const dom = mkdtempSync(join(tmpdir(), 'tm-putanje-'))
    mkdirSync(join(dom, 'config'))
    writeFileSync(join(dom, 'config', 'ima.json'), '{}')
    const kod = 'import tm_putanje as t; print(t.konfig("ima.json")); print(t.konfig("nema.json")); '
      + 'print(t.konfig("ima.json", "TM_X"))'
    const r = py(kod, { TM_HOME: dom, TM_X: '/izricito.json' })
    expect(r.izlaz.split('\n')).toEqual([
      join(dom, 'config', 'ima.json'),
      join(PAKET, 'config', 'nema.json'),
      '/izricito.json',
    ])
  })

  test('Ollama bez TM_OLLAMA_URL nema adresu (nema zadane vrijednosti)', () => {
    expect(py('import tm_putanje as t; print(repr(t.ollama_url()))').izlaz).toBe("''")
    expect(py('import tm_putanje as t; print(t.ollama_url())', { TM_OLLAMA_URL: 'http://o:11434/' }).izlaz)
      .toBe('http://o:11434')
  })

  test('Chroma bez TM_CHROMA_HOST odbija s porukom, s njom gradi v2 putanju', () => {
    const bez = py('import tm_putanje as t; t.chroma_kolekcije()')
    expect(bez.kod).not.toBe(0)
    expect(bez.izlaz).toContain('TM_CHROMA_HOST')
    const s = py('import tm_putanje as t; print(t.chroma_kolekcije())', { TM_CHROMA_HOST: 'c.lan', TM_CHROMA_PORT: '18765' })
    expect(s.izlaz).toBe('http://c.lan:18765/api/v2/tenants/default_tenant/databases/default_database/collections')
  })
})
