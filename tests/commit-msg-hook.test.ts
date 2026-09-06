/**
 * Vratar identiteta commita — TASK-4723.
 *
 * Nalaz (Goran, 06.09.2026.): commit 241aa89 je otišao na javni GitHub s
 * `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` i s autorom
 * `REGOČ System <regoc@intergalaktik.eu>`, dok svi ostali commiti istog dana nose
 * `Goran Mahovlić <goran.mahovlic@gmail.com>` bez traga o alatu.
 *
 * Uzrok nije bio propust u kodu nego oslanjanje na pamćenje agenta: commit se radi rukom,
 * pa je dovoljno da jedan spawn ne prepiše zadani identitet harnessa. Zato provjera ne
 * gleda tekst upute nego ponašanje `git commit`-a: pravi repozitorij, pravi hook,
 * pravi izlazni status.
 *
 * Ugovor koji se ovdje mjeri:
 *   .githooks/commit-msg  odbija (exit != 0) poruku s tragom alata i tuđeg autora,
 *                         propušta ispravan identitet,
 *                         a izuzetak se otvara SAMO izričito (git config).
 */
import { describe, expect, test, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const KORIJEN = join(import.meta.dir, '..')
const HOOKS = join(KORIJEN, '.githooks')
const ISPRAVAN = 'goran.mahovlic@gmail.com'

// `/tmp` je u našem kontejneru montiran s `noexec` i zna biti pun (100 MB tmpfs),
// pa privremeni repozitoriji idu u ~/.tmp.
const privremeni: string[] = []
function noviRepo(email = ISPRAVAN, ime = 'Goran Mahovlic'): string {
  const put = mkdtempSync(join(homedir(), '.tmp', 'tmai-hook-'))
  privremeni.push(put)
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', put])
  Bun.spawnSync(['git', '-C', put, 'config', 'user.email', email])
  Bun.spawnSync(['git', '-C', put, 'config', 'user.name', ime])
  Bun.spawnSync(['git', '-C', put, 'config', 'commit.gpgsign', 'false'])
  // hook se uzima iz OVOG repozitorija — mjeri se datoteka koja se isporučuje
  Bun.spawnSync(['git', '-C', put, 'config', 'core.hooksPath', HOOKS])
  writeFileSync(join(put, 'a.txt'), 'a\n')
  Bun.spawnSync(['git', '-C', put, 'add', 'a.txt'])
  return put
}

function commit(put: string, poruka: string, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(['git', '-C', put, 'commit', '-m', poruka], {
    env: { ...process.env, ...env },
  })
  return {
    kod: r.exitCode,
    izlaz: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr),
  }
}

afterAll(() => {
  for (const p of privremeni) rmSync(p, { recursive: true, force: true })
})

describe('commit-msg — trag alata u poruci', () => {
  test('Co-Authored-By: Claude je odbijen', () => {
    const put = noviRepo()
    const r = commit(put, 'TASK-1: proba\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n')
    expect(r.kod).not.toBe(0)
    expect(r.izlaz).toContain('Co-Authored-By')
  })

  test('odbijanje ne ovisi o veličini slova', () => {
    const put = noviRepo()
    const r = commit(put, 'TASK-1: proba\n\nco-authored-by: claude <x@example.com>\n')
    expect(r.kod).not.toBe(0)
  })

  test('noreply@anthropic.com bilo gdje u poruci je odbijen', () => {
    const put = noviRepo()
    const r = commit(put, 'TASK-1: proba\n\nprijavio noreply@anthropic.com\n')
    expect(r.kod).not.toBe(0)
  })

  test('komentirani redci (# ...) se ne broje — git ih ionako reže', () => {
    const put = noviRepo()
    const r = commit(put, 'TASK-1: proba\n\n# Co-Authored-By: Claude <noreply@anthropic.com>\n')
    expect(r.kod).toBe(0)
  })
})

describe('commit-msg — identitet autora', () => {
  test('tuđi autor je odbijen', () => {
    const put = noviRepo('regoc@intergalaktik.eu', 'REGOC System')
    const r = commit(put, 'TASK-1: proba')
    expect(r.kod).not.toBe(0)
    expect(r.izlaz).toContain('regoc@intergalaktik.eu')
  })

  test('GIT_AUTHOR_EMAIL koji zaobilazi config je također odbijen', () => {
    const put = noviRepo()
    const r = commit(put, 'TASK-1: proba', { GIT_AUTHOR_EMAIL: 'regoc@intergalaktik.eu' })
    expect(r.kod).not.toBe(0)
  })

  test('tuđi committer je odbijen', () => {
    const put = noviRepo()
    const r = commit(put, 'TASK-1: proba', { GIT_COMMITTER_EMAIL: 'regoc@intergalaktik.eu' })
    expect(r.kod).not.toBe(0)
  })

  test('izuzetak se otvara izričito, preko git configa', () => {
    const put = noviRepo('netko@example.com', 'Netko Drugi')
    Bun.spawnSync(['git', '-C', put, 'config', 'taskmanagerai.dopusteniAutori', 'netko@example.com'])
    const r = commit(put, 'TASK-1: proba')
    expect(r.kod).toBe(0)
  })

  test('izuzetak vrijedi samo za navedenu adresu', () => {
    const put = noviRepo('treci@example.com', 'Treci')
    Bun.spawnSync(['git', '-C', put, 'config', 'taskmanagerai.dopusteniAutori', 'netko@example.com'])
    const r = commit(put, 'TASK-1: proba')
    expect(r.kod).not.toBe(0)
  })
})

describe('commit-msg — ispravan commit prolazi', () => {
  test('ispravan identitet i čista poruka prolaze', () => {
    const put = noviRepo()
    const r = commit(put, 'TASK-1: proba\n\nObičan opis promjene bez traga alata.\n')
    expect(r.kod).toBe(0)
  })

  test('riječ "claude" u tekstu opisa nije razlog za odbijanje', () => {
    const put = noviRepo()
    const r = commit(put, 'TASK-1: dodaj upute za claude agente\n')
    expect(r.kod).toBe(0)
  })
})
