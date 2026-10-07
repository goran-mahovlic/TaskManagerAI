// TASK-5306 — E2E razgovora (Šaban) na node-A uz „prebaci sve" i simuliranu potrošenu Anthropic sesiju.
// Vrti ISPORUČENI kod (~/TaskManagerAI/src): stvoriRazgovor + izbor modela iz RazgovorPloca
// (modelPrebacen / modelIzKonfiguracije / ciljModelaRazgovora nad PRAVIM model-config.json) i pravi
// izvršitelj (claude -p). Kanal je lažan (bilježi, ne šalje u grupu). Vrata kvote su ista formula kao
// TaskWebUI.kvotaPuna (sesija ≥ sessionBlock iz Config-a), nad snimkom session_usage.cache.json.
// Upotreba: OZNAKA=R1 bun razgovor_proba.ts   → ispis jedne JSON linije REZULTAT {...}
import { readFileSync } from 'fs'
import { homedir } from 'os'
const HOME = process.env.HOME || homedir()
const SRC = HOME + '/TaskManagerAI/src'
const { stvoriRazgovor } = await import(SRC + '/razgovor/Razgovor')
const { izvrsiteljRazgovora } = await import(SRC + '/razgovor/Izvrsitelj')
const { modelPrebacen, modelIzKonfiguracije, ciljModelaRazgovora } = await import(SRC + '/razgovor/RazgovorPloca')
const { createRazgovorReader } = await import(SRC + '/razgovor/RazgovorPostavke')

const MC = HOME + '/.claude/regoc/models/model-config.json'
const OZN = process.env.OZNAKA || 'R'
const K = HOME + '/.tmp/TASK-5306'
const snimka = () => JSON.parse(readFileSync(HOME + '/.claude/regoc/data/session_usage.cache.json', 'utf-8')).entry
const pragovi = async () => (await (await fetch('http://127.0.0.1:17781/api/config/autonomy')).json())
let kvotaPitana = 0
const kvotaPuna = async () => {
  kvotaPitana++
  const u = snimka(); const t = await pragovi()
  return (typeof u.session_percent === 'number' && u.session_percent >= t.sessionBlock) ||
    (typeof u.weekly_percent === 'number' && u.weekly_percent >= t.weeklyBlock)
}

// Koji je model STVARNO odgovorio: polje message.model u transkriptu CLI sesije.
const modeliIzTranskripta = (sid?: string): string[] => {
  if (!sid) return []
  const { readdirSync, existsSync } = require('fs')
  const baza = HOME + '/.claude/projects'; const m = new Set<string>()
  for (const d of existsSync(baza) ? readdirSync(baza) : []) {
    const f = `${baza}/${d}/${sid}.jsonl`
    if (!existsSync(f)) continue
    for (const l of readFileSync(f, 'utf-8').trim().split('\n')) { try { const j = JSON.parse(l); if (j?.message?.model) m.add(j.message.model) } catch {} }
  }
  return [...m]
}
const izv = izvrsiteljRazgovora()
const orig = izv.run.bind(izv)
const pozivi: any[] = []
izv.run = async (r: any) => {
  const t = Date.now(); const x = await orig(r)
  pozivi.push({ model: r.model, baseUrl: r.extra?.env?.ANTHROPIC_BASE_URL ?? null, exit: x.exitCode, ms: Date.now() - t,
    sid: x.sessionId, modeliTranskripta: modeliIzTranskripta(x.sessionId), greska: x.greska ? String(x.greska).slice(0, 200) : null })
  return x
}
const zivo = createRazgovorReader({ dbPath: process.env.TM_DB! })().postavke
// Samo za probu: čitanje, bez memorije, mapa po chatu, kratki burst. Model se NE prepisuje (iz konfiguracije/prekidača).
const prepis = { ukljucen: true, ovlasti: 'citanje', radniDir: '', odgovaraNa: 'spomen', dopusteniKorisnici: [] as string[],
  memorijaRazgovor: 'off', preskociAkoSadrzi: [] as string[], burstMs: 200, dokumenti: false }
const r = stvoriRazgovor({
  postavke: () => ({ ...zivo, ...prepis }), izvrsitelj: izv, jePauza: () => false, kvotaPuna,
  modelZadano: () => modelIzKonfiguracije(MC), modelPrebacen: () => modelPrebacen(MC),
  ciljModela: (s: string | undefined) => ciljModelaRazgovora(MC, s),
  korijen: K + '/razgovor-' + OZN, tmHome: HOME + '/TaskManagerAI', home: HOME, port: 17781, plocaUrl: 'http://127.0.0.1:17781',
  instalacija: 'node-A (proba TASK-5306)', env: process.env, dokumentiMape: [],
  log: () => {},
} as any)
const poslano: string[] = []
const kanal = { ime: 'telegram', maxDuljinaPoruke: 4096, maxDokumentBajta: 50e6,
  async posaljiTekst(_c: string, t: string) { poslano.push(t); return true },
  async posaljiDokument(_c: string, p: string) { poslano.push('DOK ' + p); return true } }
const zeton = 'PONG-' + OZN + '-' + Math.random().toString(36).slice(2, 7)
r.primi({ kanal: 'telegram', chatId: '-5306' + OZN.length, porukaId: '1', posiljateljId: '777000111', posiljateljIme: 'Proba',
  posiljateljKorisnickoIme: 'x_regoc_proba', posiljateljJeBot: false, tekst: `Odgovori samo ovom riječju, bez ičega drugog: ${zeton}`,
  ts: new Date().toISOString(), privatno: false, obracanjeBotu: true } as any, kanal as any)
await Bun.sleep(400); await r.mirno()
const mc = JSON.parse(readFileSync(MC, 'utf-8'))
console.log('REZULTAT ' + JSON.stringify({
  oznaka: OZN, sesijaSnimka: snimka().session_percent, prekidac: mc._prebaciSvePrije?.cilj ?? null,
  razgovorOverride: mc.agentOverrides?.razgovor ?? null, kvotaPitana, pozivi, odgovor: poslano, zeton,
  zetonUOdgovoru: poslano.some(t => t.includes(zeton)),
}))
process.exit(0)
