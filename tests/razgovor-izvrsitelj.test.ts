/**
 * ADR-0002 §6.1 — razgovor koristi ISTI izvođač kao orkestrator (`CliExecutor`), proširen za:
 * `--resume` (extra.resume + resumeFlag), zastavice ovlasti (extra.args), prepisanu okolinu
 * (extra.env — bijela lista, ne nasljeđivanje) i jasnu oznaku isteka roka.
 *
 * Pravi proces, lažna naredba: `bun -e` ispisuje argv i dio okoline kao JSON.
 *
 * Autorica: Jelena (Engineer), TASK-5277.
 */
import { describe, expect, test } from 'bun:test'
import { CliExecutor } from '../src/core/orchestrator/Executors'
import { izvrsiteljRazgovora } from '../src/razgovor/Izvrsitelj'

const SKRIPTA = `
const stdin = await Bun.stdin.text();
console.log(JSON.stringify({ result: JSON.stringify({ argv: process.argv.slice(process.argv.indexOf('--model')), stdin,
  tok: process.env.TM_TELEGRAM_BOT_TOKEN ?? null, cc: process.env.CLAUDECODE ?? null,
  razg: process.env.TM_RAZGOVOR ?? null }), session_id: 'S9', num_turns: 1 }))
`

describe('CliExecutor — proširenja za razgovor', () => {
  test('extra.resume, extra.args i extra.env; prompt kroz stdin (variadični --allowedTools ga ne guta)', async () => {
    const ex = new CliExecutor('t', {
      kind: 'cli', command: process.execPath, args: ['-e', SKRIPTA, '--'], promptChannel: 'stdin',
      modelFlag: '--model', systemPromptFlag: '--append-system-prompt', resumeFlag: '--resume',
    })
    process.env.TM_TELEGRAM_BOT_TOKEN = '1:TAJNA'
    process.env.CLAUDECODE = '1'
    try {
      const r = await ex.run({
        agentId: 'razgovor', model: 'm1', prompt: 'pitanje?', systemPrompt: 'identitet',
        extra: { resume: 'S1', args: ['--allowedTools', 'Read Grep'], env: { PATH: process.env.PATH!, TM_RAZGOVOR: 'telegram:1' } },
      })
      expect(r.exitCode).toBe(0)
      expect(r.sessionId).toBe('S9')
      const o = JSON.parse(r.resultText)
      expect(o.argv).toEqual(['--model', 'm1', '--append-system-prompt', 'identitet', '--resume', 'S1', '--allowedTools', 'Read Grep'])
      expect(o.stdin).toBe('pitanje?')
      expect(o.tok).toBeNull()
      expect(o.cc).toBeNull()
      expect(o.razg).toBe('telegram:1')
    } finally {
      delete process.env.TM_TELEGRAM_BOT_TOKEN
      delete process.env.CLAUDECODE
    }
  })

  test('istek roka → greska „rok istekao", ne generički exit', async () => {
    const ex = new CliExecutor('t', { kind: 'cli', command: 'sleep', args: ['5'], promptChannel: 'stdin' })
    const t0 = Date.now()
    const r = await ex.run({ agentId: 'a', prompt: '', timeoutMs: 150 })
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(r.exitCode).not.toBe(0)
    expect(r.greska).toContain('rok istekao')
  })
})

describe('izvrsiteljRazgovora — claude -p', () => {
  test('naredba: -p --output-format json, prompt kroz stdin, --resume', () => {
    const cfg = izvrsiteljRazgovora({ bin: '/x/claude' }).cfg
    expect(cfg.command).toBe('/x/claude')
    expect(cfg.args).toEqual(['-p', '--output-format', 'json'])
    expect(cfg.promptChannel).toBe('stdin')
    expect(cfg.resumeFlag).toBe('--resume')
    expect(cfg.systemPromptFlag).toBe('--append-system-prompt')
    expect(cfg.modelFlag).toBe('--model')
  })
})
