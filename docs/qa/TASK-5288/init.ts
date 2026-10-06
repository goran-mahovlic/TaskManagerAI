// TASK-5288 točka 1, deterministički: system/init CLI-ja (skills, slash_commands, mcp_servers, plugins, tools)
// s argv-om citanje iz isporučenog Ovlasti.ts — s IZOLACIJA i bez nje.
const SRC = process.env.HOME + '/TaskManagerAI/src'
const { argumentiOvlasti, okolinaRazgovora } = await import(SRC + '/razgovor/Ovlasti')
const rd = process.env.HOME + '/.tmp/TASK-5288/init-radni'; (await import('fs')).mkdirSync(rd, { recursive: true })
const a = argumentiOvlasti('citanje', { port: 17781, radniDir: rd, tmHome: process.env.HOME + '/TaskManagerAI', home: process.env.HOME! })
const bez = (() => { const x = [...a]; x.splice(x.indexOf('--setting-sources'), 2); return x.filter(y => y !== '--strict-mcp-config') })()
for (const [ime, args] of [['IZOLIRANO', a], ['KONTROLA', bez]] as const) {
  const p = Bun.spawnSync(['claude', '-p', 'Odgovori samo: ok', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--max-turns', '1', ...args],
    { cwd: rd, env: okolinaRazgovora(process.env, 'proba:init') as any })
  const init = p.stdout.toString().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).find(j => j?.type === 'system' && j?.subtype === 'init')
  if (!init) { console.log(ime, 'NEMA init', p.stderr.toString().slice(0, 200)); continue }
  console.log(`${ime}: tools=${JSON.stringify(init.tools)} skills=${(init.skills || []).length} ${JSON.stringify(init.skills || [])} slash=${(init.slash_commands || []).length} mcp=${JSON.stringify(init.mcp_servers)} plugins=${JSON.stringify(init.plugins || [])} agents=${(init.agents || []).length}`)
}
