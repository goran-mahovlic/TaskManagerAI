/**
 * TASK-5655 (plan Mac v3 P12, odluka 6): prijava na BILO KOJI ponuđeni AI servis — katalog
 * od 14 davatelja, tok po OS-u, čarobnjak koji nikad ne ispisuje vrijednost tajne.
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DAVATELJI_AI, koraciPrijave, spojiSModelConfigom, tajneIzApiKey } from '../src/core/davateljiAI'
import { imeZabranjeno } from '../src/LoginCreds'

const KORIJEN = join(import.meta.dir, '..')
// isti popis kao model-config kompleta na node-A (P12.1, izmjereno 20. 10. 2026.)
const MODEL_CONFIG = { providers: {
  anthropic: { apiKey: 'env:ANTHROPIC_API_KEY', enabled: true }, openai: { apiKey: 'env:OPENAI_API_KEY', enabled: false },
  google: { apiKey: 'env:GEMINI_API_KEY|GOOGLE_API_KEY', enabled: false }, ollama: { enabled: true }, custom: { enabled: false },
  openrouter: { apiKey: 'env:OPENROUTER_API_KEY' }, kimi: { apiKey: 'env:KIMI_API_KEY' }, kimicli: {}, geminicli: { apiKey: 'env:GEMINI_API_KEY|GOOGLE_API_KEY' },
  glm: { apiKey: 'env:GLM_API_KEY' }, minimax: { apiKey: 'env:MINIMAX_API_KEY' }, qwen: { apiKey: 'env:QWEN_API_KEY' },
  deepseek: { apiKey: 'env:DEEPSEEK_API_KEY' }, claude: {}, mojdavatelj: { name: 'Moj', apiKey: 'env:MOJ_API_KEY' },
} }

describe('katalog davatelja', () => {
  test('svih 14 iz model-configa kompleta, nijedan nije pretpostavljen', () => {
    expect(DAVATELJI_AI.map(d => d.id).sort()).toEqual(['anthropic', 'claude', 'custom', 'deepseek', 'geminicli', 'glm', 'google',
      'kimi', 'kimicli', 'minimax', 'ollama', 'openai', 'openrouter', 'qwen'])
  })
  test('spoj s model-configom: sve *_API_KEY tajne i davatelj kojeg katalog ne zna', () => {
    const l = spojiSModelConfigom(MODEL_CONFIG)
    const tajne = new Set(l.flatMap(d => d.tajne))
    for (const t of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'KIMI_API_KEY',
      'GLM_API_KEY', 'MINIMAX_API_KEY', 'QWEN_API_KEY', 'DEEPSEEK_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'MOJ_API_KEY']) expect(tajne.has(t)).toBe(true)
    expect(l.find(d => d.id === 'mojdavatelj')).toMatchObject({ ime: 'Moj', nacin: 'kljuc', uModelConfigu: true })
    expect(l.find(d => d.id === 'openai')?.ukljucen).toBe(false)
    expect(tajneIzApiKey('env:A_KEY|b-los|C_KEY')).toEqual(['A_KEY', 'C_KEY'])
  })
  test('svaka tajna iz kataloga smije u spremište (inače je prijava nemoguća)', () => {
    for (const t of spojiSModelConfigom(MODEL_CONFIG).flatMap(d => d.tajne)) expect(imeZabranjeno(t)).toBe(false)
  })
  test('iznimka je TOČNO CLAUDE_CODE_OAUTH_TOKEN; prefiks CLAUDE_ ostaje zabranjen (P12.3)', () => {
    expect(imeZabranjeno('CLAUDE_CODE_OAUTH_TOKEN')).toBe(false)
    for (const ime of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN_X', 'CLAUDE_CODE_X']) expect(imeZabranjeno(ime)).toBe(true)
  })
  test('tok po OS-u: Claude pretplata na macOS-u ide kroz setup-token (Keychain), na Linuxu kroz auth login', () => {
    const c = DAVATELJI_AI.find(d => d.id === 'claude')!
    expect(koraciPrijave(c, 'darwin').join('\n')).toMatch(/setup-token[\s\S]*tajna\.ts postavi CLAUDE_CODE_OAUTH_TOKEN/)
    expect(koraciPrijave(c, 'linux')[0]).toContain('claude auth login')
    const o = DAVATELJI_AI.find(d => d.id === 'openrouter')!
    expect(koraciPrijave(o, 'darwin').join(' ')).toContain('OPENROUTER_API_KEY')
  })
})

describe('čarobnjak scripts/prijava-ai.ts', () => {
  test('popis --json: stanje iz spremišta čvora, vrijednost nikad u izlazu', () => {
    const tm = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tm-prijava-'))
    try {
      mkdirSync(join(tm, 'config'))
      writeFileSync(join(tm, 'config/credentials.env'), 'OPENROUTER_API_KEY=sk-or-v1-NEVIDLJIVA-vrijednost\n', { mode: 0o600 })
      writeFileSync(join(tm, 'mc.json'), JSON.stringify(MODEL_CONFIG))
      const r = Bun.spawnSync(['bun', 'scripts/prijava-ai.ts', 'popis', '--json', '--model-config', join(tm, 'mc.json')],
        { cwd: KORIJEN, env: { PATH: process.env.PATH!, HOME: tm, TM_HOME: tm, TM_INSTALL_OS: 'darwin' } })
      const izlaz = r.stdout.toString()
      expect(r.exitCode).toBe(0)
      expect(izlaz).not.toContain('NEVIDLJIVA')
      const j = JSON.parse(izlaz)
      expect(j.davatelji.length).toBe(15)
      expect(j.davatelji.find((d: any) => d.id === 'openrouter')).toMatchObject({ prijavljen: true, kako: 'OPENROUTER_API_KEY u spremištu' })
      expect(j.davatelji.find((d: any) => d.id === 'claude').prijavljen).toBe(false)
      const kratko = Bun.spawnSync(['bun', 'scripts/prijava-ai.ts', 'popis', '--kratko'], { cwd: KORIJEN, env: { PATH: process.env.PATH!, HOME: tm, TM_HOME: tm } }).stdout.toString()
      expect(kratko).toContain('prijavljeno 1')
      expect(kratko).not.toContain('NEVIDLJIVA')
    } finally { rmSync(tm, { recursive: true, force: true }) }
  })
  test('nepoznat servis → izlaz 2 s popisom', () => {
    const r = Bun.spawnSync(['bun', 'scripts/prijava-ai.ts', 'upute', 'nema'], { cwd: KORIJEN })
    expect(r.exitCode).toBe(2)
    expect(r.stderr.toString()).toContain('openrouter')
  })
})
