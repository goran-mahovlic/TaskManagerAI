/**
 * TASK-5738 — Antigravity CLI (`agy`) kao AI servis: prijava Googleom u DATOTEČNU pohranu tokena,
 * spawn s istim uvjetom, prepoznavanje prijave, modeli za izbornike i razgovor.
 *
 * Mjereno 23.10.2026. (agy 1.4.6, macOS i Linux): bilo koja od SSH_CONNECTION / SSH_CLIENT /
 * SSH_TTY → „Using file-based token storage because SSH session detected"; bez njih token ide u
 * Keychain / secret-service, koji usluga pod launchd/systemd ne vidi.
 *
 * Autorica: Jelena (Engineer), TASK-5738.
 */
import { describe, expect, test } from 'bun:test'
import {
  AGY_MAPA, AGY_MODEL_ZADANO, AGY_NAREDBA_PRIJAVE, agyDatotekePrijave, agyPrijavljen,
  agyPrijavaUspjela, argumentiAgyja, modeliAgyja, nacinAgyja, okolinaAgyja, postaviNacinAgyja, stanjeAgyja,
  ukljuciAgyZaCilj,
} from '../src/core/Antigravity'

describe('okolinaAgyja — datotečna pohrana tokena', () => {
  test('bez SSH oznake → dodaje SSH_CONNECTION; PATH dobiva ~/.local/bin', () => {
    const o = okolinaAgyja({ HOME: '/h', PATH: '/usr/bin' })
    expect(o.SSH_CONNECTION).toBeTruthy()
    expect(o.PATH!.split(':')[0]).toBe('/h/.local/bin')
    expect(o.PATH!.split(':')).toContain('/usr/bin')
  })
  test('postojeća SSH oznaka ostaje kakva je (ista pohrana kao kod prijave preko SSH-a)', () => {
    const o = okolinaAgyja({ HOME: '/h', PATH: '/h/.local/bin:/usr/bin', SSH_CLIENT: '10.0.0.1 5 22' })
    expect(o.SSH_CLIENT).toBe('10.0.0.1 5 22')
    expect(o.SSH_CONNECTION).toBeUndefined()
    expect(o.PATH).toBe('/h/.local/bin:/usr/bin')
  })
  test('prijava u Claude ne ide tuđem CLI-ju', () => {
    const o = okolinaAgyja({ HOME: '/h', CLAUDE_CODE_OAUTH_TOKEN: 'x', ANTHROPIC_API_KEY: 'y' })
    expect(o.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(o.ANTHROPIC_API_KEY).toBeUndefined()
  })
  test('ulaz se ne mijenja', () => {
    const ulaz = { HOME: '/h' }
    okolinaAgyja(ulaz)
    expect(ulaz).toEqual({ HOME: '/h' })
  })
})

describe('argumentiAgyja', () => {
  test('agent: -p, tekstualni izlaz, alati bez potvrde, model', () => {
    const a = argumentiAgyja({ prompt: 'zadatak', model: 'gemini-3.8-flash', nacin: 'agent' })
    expect(a.slice(0, 2)).toEqual(['-p', 'zadatak'])
    expect(a).toContain('--dangerously-skip-permissions')
    expect(a.join(' ')).toContain('--output-format text')
    expect(a.join(' ')).toContain('--model gemini-3.8-flash')
  })
  test('zadani model → bez --model (agy bira svoj)', () => {
    expect(argumentiAgyja({ prompt: 'x', model: AGY_MODEL_ZADANO, nacin: 'agent' })).not.toContain('--model')
    expect(argumentiAgyja({ prompt: 'x', nacin: 'agent' })).not.toContain('--model')
  })
  test('razgovor: samo čitanje — način plan, bez preskakanja dozvola', () => {
    const a = argumentiAgyja({ prompt: 'x', nacin: 'razgovor' })
    expect(a).not.toContain('--dangerously-skip-permissions')
    expect(a.join(' ')).toContain('--mode plan')
  })
})

describe('prijava', () => {
  const ls = (popis: string[]) => (_: string) => popis
  test('mapa bez datoteke prijave (samo zapisi, keš) → nije prijavljen', () => {
    expect(agyPrijavljen('/h', ls(['cli.log', 'cache', 'installation_id', 'jetski_state.pbtxt', 'log']))).toBe(false)
  })
  test('datoteka tokena u mapi → prijavljen; vraća puni put za odjavu', () => {
    const f = ls(['cli.log', 'authstore.enc', 'cache'])
    expect(agyPrijavljen('/h', f)).toBe(true)
    expect(agyDatotekePrijave('/h', f)).toEqual([`/h/${AGY_MAPA}/authstore.enc`])
  })
  test('nečitljiva mapa → nije prijavljen (bez iznimke)', () => {
    expect(agyPrijavljen('/h', () => { throw new Error('ENOENT') })).toBe(false)
  })
  test('naredba prijave je agy -p (ispisuje URL i čeka kod; nakon prijave odgovori)', () => {
    expect(AGY_NAREDBA_PRIJAVE.startsWith('agy -p ')).toBe(true)
  })
  test('uspjeh se čita i iz izlaza CLI-ja', () => {
    expect(agyPrijavaUspjela('…OAuth: authentication completed successfully\n')).toBe(true)
    expect(agyPrijavaUspjela('Authentication required. Please visit the URL')).toBe(false)
  })
})

describe('način: Gemini ključ ili Google prijava (settings.json agy-ja, uputa #458)', () => {
  test('kljuc → modelProvider gemini; google → modelProvider maknut, ostalo ostaje', () => {
    const k = postaviNacinAgyja({ theme: 'x' }, 'kljuc')
    expect(k).toEqual({ theme: 'x', modelProvider: 'gemini' })
    expect(nacinAgyja(k)).toBe('kljuc')
    const g = postaviNacinAgyja(k, 'google')
    expect(g).toEqual({ theme: 'x' })
    expect(nacinAgyja(g)).toBe('google')
    expect(nacinAgyja(null)).toBe('google')
  })
  test('stanje: ključ vrijedi samo u načinu kljuc, token samo u načinu google', () => {
    expect(stanjeAgyja({ nacin: 'kljuc', kljuc: true, token: false })).toMatchObject({ prijavljen: true })
    expect(stanjeAgyja({ nacin: 'kljuc', kljuc: false, token: true }).prijavljen).toBe(false)
    expect(stanjeAgyja({ nacin: 'google', kljuc: true, token: false }).prijavljen).toBe(false)
    expect(stanjeAgyja({ nacin: 'google', kljuc: false, token: true })).toMatchObject({ prijavljen: true })
  })
})

describe('modeliAgyja', () => {
  test('bez prijave → ništa', () => {
    expect(modeliAgyja(false)).toEqual([])
  })
  test('ID-ovi modela bez razmaka (provjeriCilj odbija razmak); 3.6 Flash je ponuđen', () => {
    const m = modeliAgyja(true)
    expect(m.every(x => !/\s/.test(x.spec))).toBe(true)
    expect(m.map(x => x.model)).toContain('gemini-3.6-flash')
  })
  test('s prijavom → zadani model prvi, svi spawnable (agy ima alate)', () => {
    const m = modeliAgyja(true)
    expect(m[0]!.spec).toBe(`antigravity:${AGY_MODEL_ZADANO}`)
    expect(m.every(x => x.provider === 'antigravity' && x.spawnable)).toBe(true)
  })
})

describe('katalog i stanje prijave (davateljiAI, prijava-ai)', () => {
  test('davatelj antigravity: oauth-cli, cli agy, bez tajne; uputa za Config → Prijava', async () => {
    const { DAVATELJI_AI, koraciPrijave } = await import('../src/core/davateljiAI')
    const d = DAVATELJI_AI.find(x => x.id === 'antigravity')!
    expect(d).toMatchObject({ nacin: 'oauth-cli', cli: 'agy', tajne: [] })
    expect(d.prijavaDatoteka).toContain(AGY_MAPA)
    expect(koraciPrijave(d, 'darwin').join('\n')).toContain('Config → Prijava')
  })
  test('stanjePrijave: mapa agy-ja s tokenom → prijavljen; samo zapisi → nije', async () => {
    const { stanjePrijave } = await import('../scripts/prijava-ai')
    const { spojiSModelConfigom } = await import('../src/core/davateljiAI')
    const d = spojiSModelConfigom(null).find(x => x.id === 'antigravity')!
    const iz = (datoteke: string[], o: { kljuc?: boolean; settings?: any } = {}) => ({ os: 'darwin', env: {}, home: '/h',
      uSpremistu: (t: string) => !!o.kljuc && t === 'GEMINI_API_KEY', postoji: () => true, popis: () => datoteke,
      citajJson: () => o.settings ?? null })
    expect(stanjePrijave(d, iz(['cli.log', 'authstore.enc'])).prijavljen).toBe(true)
    expect(stanjePrijave(d, iz(['cli.log', 'cache'])).prijavljen).toBe(false)
    // način ključa: GEMINI_API_KEY u spremištu + modelProvider gemini
    expect(stanjePrijave(d, iz(['cli.log'], { kljuc: true, settings: { modelProvider: 'gemini' } })).prijavljen).toBe(true)
    expect(stanjePrijave(d, iz(['cli.log'], { kljuc: true })).prijavljen).toBe(false)
  })
})

describe('AntigravityPrijava — disk (Config → Prijava na ploči)', () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('fs')
  const { join } = require('path')
  const { tmpdir } = require('os')
  test('ključ: piše modelProvider; google: miče ga; odjava briše samo token, zapisi ostaju', async () => {
    const { zapisiNacinAgyja, stanjeAgyjaNaDisku, odjaviAgy } = await import('../src/core/AntigravityPrijava')
    const h = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tm-agy-'))
    try {
      const m = join(h, AGY_MAPA)
      mkdirSync(m, { recursive: true })
      writeFileSync(join(m, 'cli.log'), 'x')
      writeFileSync(join(m, 'settings.json'), JSON.stringify({ theme: 't' }))
      expect(stanjeAgyjaNaDisku(h, true).prijavljen).toBe(false)       // način google, nema tokena
      zapisiNacinAgyja(h, 'kljuc')
      expect(JSON.parse(readFileSync(join(m, 'settings.json'), 'utf-8'))).toEqual({ theme: 't', modelProvider: 'gemini' })
      expect(stanjeAgyjaNaDisku(h, true).prijavljen).toBe(true)
      expect(stanjeAgyjaNaDisku(h, false).prijavljen).toBe(false)
      zapisiNacinAgyja(h, 'google')
      writeFileSync(join(m, 'authstore.enc'), 'tok')
      expect(stanjeAgyjaNaDisku(h, false)).toMatchObject({ prijavljen: true, nacin: 'google' })
      odjaviAgy(h)
      expect(existsSync(join(m, 'authstore.enc'))).toBe(false)
      expect(existsSync(join(m, 'cli.log'))).toBe(true)
      expect(stanjeAgyjaNaDisku(h, true).prijavljen).toBe(false)
    } finally { rmSync(h, { recursive: true, force: true }) }
  })
  test('bez mape agy-ja: zapis načina stvori mapu i settings.json (0600)', async () => {
    const { zapisiNacinAgyja } = await import('../src/core/AntigravityPrijava')
    const { statSync } = require('fs')
    const h = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tm-agy-'))
    try {
      zapisiNacinAgyja(h, 'kljuc')
      const f = join(h, AGY_MAPA, 'settings.json')
      expect(JSON.parse(readFileSync(f, 'utf-8')).modelProvider).toBe('gemini')
      expect(statSync(f).mode & 0o777).toBe(0o600)
    } finally { rmSync(h, { recursive: true, force: true }) }
  })
})

describe('ukljuciAgyZaCilj — Model sustava na antigravity:*', () => {
  test('prijavljen, a davatelja nema ili je isključen → dodan/uključen', () => {
    const mc: any = { providers: {} }
    expect(ukljuciAgyZaCilj(mc, 'antigravity:gemini-3.6-flash', true)).toBe(true)
    expect(mc.providers.antigravity.enabled).toBe(true)
    const mc2: any = { providers: { antigravity: { enabled: false } } }
    expect(ukljuciAgyZaCilj(mc2, 'antigravity:zadano', true)).toBe(true)
    expect(mc2.providers.antigravity.enabled).toBe(true)
  })
  test('nije prijavljen, drugi davatelj ili već uključen → ništa', () => {
    const mc: any = { providers: {} }
    expect(ukljuciAgyZaCilj(mc, 'antigravity:zadano', false)).toBe(false)
    expect(ukljuciAgyZaCilj(mc, 'google:gemini-3.8-flash', true)).toBe(false)
    expect(mc.providers.antigravity).toBeUndefined()
    const mc3: any = { providers: { antigravity: { enabled: true } } }
    expect(ukljuciAgyZaCilj(mc3, 'antigravity:zadano', true)).toBe(false)
  })
})
