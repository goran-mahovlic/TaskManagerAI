// TASK-5306 — razgovor glavnog sustava (Klaudio): isti put kao telegram_agent.ts (readModelConfig →
// resolveKlaudioTarget → planKlaudioSpawn → spawn plana), nad PRAVIM model-config.json, bez slanja u Telegram.
// Upotreba: OZNAKA=K1 bun klaudio_proba.ts → REZULTAT {...}
import { writeFileSync } from 'fs'
const L = process.env.HOME + '/.claude/tools/Telegram/lib/KlaudioModel'
const { readModelConfig, resolveKlaudioTarget, planKlaudioSpawn, parseKlaudioOutput } = await import(L)
const OZN = process.env.OZNAKA || 'K'
const zeton = 'PONG-' + OZN + '-' + Math.random().toString(36).slice(2, 7)
const cfg = readModelConfig()
const target = resolveKlaudioTarget(cfg)
const pf = `/home/klaudio/app/tmp/TASK-5306/klaudio_prompt_${OZN}.txt`
const plan: any = planKlaudioSpawn({ target, prompt: `Odgovori samo ovom riječju, bez ičega drugog: ${zeton}`, config: cfg, promptFilePath: pf })
if (!plan.ok) { console.log('REZULTAT ' + JSON.stringify({ oznaka: OZN, target, greska: plan.error })); process.exit(0) }
if (plan.promptFile) writeFileSync(plan.promptFile.path, plan.promptFile.content)
// Za claude CLI put dodaj --max-turns 1 (jeftino) i ne nosi sesiju.
const cmd = plan.cmd[0] === 'claude' ? [...plan.cmd, '--max-turns', '1'] : plan.cmd
const t = Date.now()
const p = Bun.spawnSync(cmd, { env: plan.env, cwd: '/home/klaudio/app/tmp/TASK-5306', timeout: 180000 })
const out = p.stdout.toString()
const { text } = parseKlaudioOutput(out, plan.outputMode)
let modelUsage: string[] | null = null
try { modelUsage = Object.keys(JSON.parse(out).modelUsage || {}) } catch { /* plain izlaz */ }
console.log('REZULTAT ' + JSON.stringify({
  oznaka: OZN, target, izvrsitelj: cmd.slice(0, 2).join(' '), provider: plan.provider, model: plan.model,
  exit: p.exitCode, ms: Date.now() - t, modelUsage, odgovor: text.slice(0, 200), zeton, zetonUOdgovoru: text.includes(zeton),
  stderr: p.exitCode ? p.stderr.toString().slice(0, 300) : '',
}))
