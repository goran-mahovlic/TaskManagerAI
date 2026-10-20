#!/usr/bin/env bun
/**
 * prijava-ai — čarobnjak za prijavu na AI servis po izboru (plan Mac v3 P12, odluka 6).
 *
 *   bun scripts/prijava-ai.ts                    # izbornik (u terminalu): odaberi servis → prijava
 *   bun scripts/prijava-ai.ts popis [--kratko] [--json] [--model-config F]
 *   bun scripts/prijava-ai.ts upute <id>         # koraci prijave za ovaj OS
 *   bun scripts/prijava-ai.ts prijavi <id>       # vodi kroz prijavu (tajna na upit, nikad argv)
 *
 * Isti posao radi ploča (Config → Prijava, Config → Tajne); ovo je put iz terminala čvora i
 * ono što install.sh ispisuje na kraju. Instalacija NIKAD ne bira servis ni ne upisuje ključ.
 * Ništa se ne ispisuje osim imena tajni i „postoji/ne" — vrijednost nikad.
 * Izlaz: 0 · 1 prijava nije dovršena · 2 pogrešna uporaba.
 */
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { koraciPrijave, spojiSModelConfigom, type StavkaPopisa } from '../src/core/davateljiAI'
import { kljucPrisutanUDatoteci } from '../src/LoginCreds'
import { datotekaTajni } from '../src/core/ConfigModul'

const PAKET = join(import.meta.dir, '..')
const OS = (process.env.TM_INSTALL_OS || process.platform).toLowerCase()
const args = process.argv.slice(2)
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }

function modelConfig(): { put: string | null; mc: any } {
  const kandidati = [arg('--model-config'), process.env.TM_MODEL_CONFIG,
    process.env.TM_HOME && join(process.env.TM_HOME, 'config', 'model-config.json'), join(PAKET, 'config', 'model-config.json')]
  for (const p of kandidati) {
    if (!p || !existsSync(p)) continue
    try { return { put: p, mc: JSON.parse(readFileSync(p, 'utf-8')) } } catch { /* sljedeći */ }
  }
  return { put: null, mc: null }
}

const kuci = (p: string) => p.replace(/^~\//, (process.env.HOME || homedir()) + '/')
function naPathu(bin: string): string | null {
  const H = process.env.HOME || homedir()
  for (const d of [...(process.env.PATH || '').split(':'), join(H, '.local/bin'), join(H, '.local/node/bin')]) {
    if (d && existsSync(join(d, bin))) return join(d, bin)
  }
  return null
}

export interface Stanje { prijavljen: boolean; kako: string }
export function stanje(d: StavkaPopisa, spremiste = datotekaTajni()): Stanje {
  for (const t of d.tajne) {
    if (process.env[t]) return { prijavljen: true, kako: `${t} u okolini` }
    if (kljucPrisutanUDatoteci(spremiste, t)) return { prijavljen: true, kako: `${t} u spremištu` }
  }
  if (d.prijavaDatoteka && existsSync(kuci(d.prijavaDatoteka)) && !(d.nacin === 'pretplata' && OS === 'darwin'))
    return { prijavljen: true, kako: `prijava ${d.prijavaDatoteka}` }
  if (d.nacin === 'lokalno') return { prijavljen: false, kako: 'bez prijave' }
  return { prijavljen: false, kako: d.tajne.length ? `nema ${d.tajne.join(' ni ')}` : 'nije prijavljen' }
}

function popis(): void {
  const { put, mc } = modelConfig()
  const lista = spojiSModelConfigom(mc)
  const redovi = lista.map(d => ({ ...d, stanje: stanje(d) }))
  if (args.includes('--json')) {
    console.log(JSON.stringify({ modelConfig: put, os: OS, davatelji: redovi.map(r => ({
      id: r.id, ime: r.ime, nacin: r.nacin, tajne: r.tajne, ukljucen: r.ukljucen, prijavljen: r.stanje.prijavljen, kako: r.stanje.kako })) }, null, 2))
    return
  }
  const n = redovi.filter(r => r.stanje.prijavljen).length
  console.log(`AI servisi (${lista.length}): prijavljeno ${n}${put ? ` · model-config ${put}` : ' · model-config nije pronađen (katalog paketa)'}`)
  for (const r of redovi) {
    const mc = r.ukljucen === null ? '' : r.ukljucen ? ' · uključen u model-configu' : ' · isključen u model-configu'
    console.log(`  ${r.stanje.prijavljen ? '✓' : '·'} ${r.id.padEnd(11)} ${r.ime.padEnd(34)} ${r.stanje.kako}${args.includes('--kratko') ? '' : mc}`)
  }
  if (!n) {
    console.log('  Nijedan servis nije prijavljen — to je tvoj izbor (instalacija ga ne pretpostavlja).')
    console.log(`  Prijava: bun ${PAKET}/scripts/prijava-ai.ts  (izbornik)  ili ploča → Config → Prijava / Tajne`)
    if (OS === 'darwin') console.log('  Claude pretplata na ovom Macu: claude setup-token, pa tajna.ts postavi CLAUDE_CODE_OAUTH_TOKEN')
  }
}

function nadji(id: string | undefined): StavkaPopisa {
  const lista = spojiSModelConfigom(modelConfig().mc)
  const d = lista.find(x => x.id === id)
  if (!d) { console.error(`nepoznat servis: ${id ?? '(nije zadan)'} — postoje: ${lista.map(x => x.id).join(', ')}`); process.exit(2) }
  return d
}

function upute(d: StavkaPopisa): void {
  console.log(`${d.ime} (${d.id}) — ${OS === 'darwin' ? 'macOS' : 'Linux'}`)
  koraciPrijave(d, OS, PAKET).forEach((k, i) => console.log(`  ${i + 1}. ${k}`))
  if (d.napomena) console.log(`  napomena: ${d.napomena}`)
}

function pokreni(argv: string[]): number {
  return Bun.spawnSync(argv, { stdio: ['inherit', 'inherit', 'inherit'], env: process.env }).exitCode ?? 1
}

function prijavi(d: StavkaPopisa): number {
  upute(d)
  const tajna = (ime: string) => pokreni(['bun', join(PAKET, 'scripts', 'tajna.ts'), 'postavi', ime])
  if (d.nacin === 'lokalno') return 0
  if (d.nacin === 'pretplata') {
    const cli = naPathu(d.cli!)
    if (!cli) { console.log(`  Claude CLI nije instaliran — bash ${PAKET}/scripts/install.sh --claude`); return 1 }
    if (OS === 'darwin') {
      console.log('\n  ▶ claude setup-token (kopiraj token koji ispiše; NE šalji ga nikome)')
      if (pokreni([cli, 'setup-token']) !== 0) return 1
      console.log('\n  ▶ zalijepi token (ne ispisuje se):')
      return tajna('CLAUDE_CODE_OAUTH_TOKEN')
    }
    return pokreni([cli, 'auth', 'login', '--claudeai'])
  }
  if (d.nacin === 'oauth-cli') {
    const cli = naPathu(d.cli!)
    if (!cli) { console.log(`  ${d.cli} nije instaliran (${d.instalacija}); ili ključ kroz Config → Tajne`); return d.tajne.length ? tajna(d.tajne[0]) : 1 }
    return pokreni(d.id === 'kimicli' ? [cli, 'login'] : [cli])
  }
  if (!d.tajne.length) { console.log('  upiši ime ključa: bun scripts/tajna.ts podesi --dodatno IME_API_KEY, pa tajna.ts postavi IME_API_KEY'); return 1 }
  console.log(`\n  ▶ ${d.tajne[0]} (vrijednost se ne ispisuje):`)
  return tajna(d.tajne[0])
}

async function izbornik(): Promise<number> {
  popis()
  const lista = spojiSModelConfigom(modelConfig().mc)
  console.log('\nOdaberi servis (broj) ili Enter za izlaz:')
  lista.forEach((d, i) => console.log(`  ${String(i + 1).padStart(2)}) ${d.ime}`))
  process.stdout.write('> ')
  const red = (await new Promise<string>(res => process.stdin.once('data', b => res(String(b))))).trim()
  process.stdin.pause()
  const i = Number(red)
  if (!red || !Number.isInteger(i) || i < 1 || i > lista.length) return 0
  return prijavi(lista[i - 1])
}

if (import.meta.main) {
  const [nar] = args
  if (nar === 'popis') popis()
  else if (nar === 'upute') upute(nadji(args[1]))
  else if (nar === 'prijavi') process.exit(prijavi(nadji(args[1])))
  else if (!nar && process.stdin.isTTY) process.exit(await izbornik())
  else if (!nar) popis()
  else { console.error('uporaba: prijava-ai.ts [popis [--kratko] [--json] [--model-config F] | upute <id> | prijavi <id>]'); process.exit(2) }
}
