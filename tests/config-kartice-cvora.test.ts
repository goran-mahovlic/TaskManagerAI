/**
 * TASK-5368 — kartice Config na čvoru (nalaz TASK-5360, node-A).
 *
 * Četiri kvara koja je vlasnik vidio kao „ploča laže":
 *   1. Infrastruktura je pisala tvrde adrese (VoiceServer :8888, STT :8787) i „Ollama nije
 *      podešeno" dok je kartica AI Providers istu Ollamu vidjela online.
 *   2. Orkestrator je pisao „0 agenata" iako zadatke vodi RegocDaemon s 12 agenata.
 *   3. Na engleskom izgledu pola kartice ostaje hrvatski (ključevi bez prijevoda).
 *   4. Vremena: baza piše UTC, ploča ih je čitala kao preglednikov lokalni sat.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { stavkeInfrastrukture, probajInfrastrukturu } from '../src/core/InfraKartica'
import { tkoVodiZadatke } from '../src/core/orchestrator/TkoVodi'
import { parsirajVrijemeBaze, formatirajVrijeme, skriptaPrikazaVremena, OZNAKA_PRIKAZA_VREMENA } from '../src/core/PrikazVremena'

const KORIJEN = join(import.meta.dir, '..')

describe('Infrastruktura — adrese iz okoline i postavki, ne iz koda', () => {
  test('glas, Ollama i ploča dolaze iz postavki; tvrdih :8888 / :8787 nema', () => {
    const s = stavkeInfrastrukture({
      env: { TM_PORT: '17781' },
      ollamaUrl: 'http://10.0.0.4:11434',
      glasUrl: '',
    })
    const po = Object.fromEntries(s.map(x => [x.nameKey, x]))
    expect(po.infra_ploca.endpoint).toBe('localhost:17781')
    expect(po.infra_glas.endpoint).toBe('http://127.0.0.1:8899')
    expect(po.infra_ollama.endpoint).toBe('http://10.0.0.4:11434')
    expect(po.infra_ollama.izvor).toContain('model-config.json')
    const tekst = JSON.stringify(s)
    expect(tekst).not.toContain('8888')
    expect(tekst).not.toContain('8787')
    expect(tekst).not.toContain('17780')
  })

  test('Ollama bez postavke pada na TM_OLLAMA_URL; bez ičega je pošteno nije podešeno', () => {
    const a = stavkeInfrastrukture({ env: { TM_OLLAMA_URL: 'http://o:11434' }, ollamaUrl: null })
    expect(a.find(x => x.nameKey === 'infra_ollama')!.endpoint).toBe('http://o:11434')
    expect(a.find(x => x.nameKey === 'infra_ollama')!.izvor).toBe('TM_OLLAMA_URL')
    const b = stavkeInfrastrukture({ env: {}, ollamaUrl: null })
    const o = b.find(x => x.nameKey === 'infra_ollama')!
    expect(o.endpoint).toBeNull()
    expect(o.probaUrl).toBeNull()
  })

  test('postavljena adresa glasovnog servisa iz kartice Razgovor ima prednost', () => {
    const s = stavkeInfrastrukture({ env: {}, glasUrl: 'http://10.0.0.5:9000/' })
    const g = s.find(x => x.nameKey === 'infra_glas')!
    expect(g.endpoint).toBe('http://10.0.0.5:9000')
    expect(g.probaUrl).toBe('http://10.0.0.5:9000/health')
    expect(g.izvor).toBe('razgovor.glasUrl')
    // izvor je tehničko ime, isto na svakom jeziku (bez hrvatskog teksta u engleskom izgledu)
    for (const x of stavkeInfrastrukture({ env: {} })) expect(x.izvor).not.toMatch(/zadano|prazno|Razgovor/)
  })

  test('ChromaDB iz TM_CHROMA_HOST/PORT', () => {
    const s = stavkeInfrastrukture({ env: { TM_CHROMA_HOST: '10.0.0.9', TM_CHROMA_PORT: '18765' } })
    expect(s.find(x => x.nameKey === 'infra_chroma')!.endpoint).toBe('10.0.0.9:18765')
  })

  test('proba: odgovor = online, mrežna greška = offline, bez adrese = nije_podeseno', async () => {
    const s = stavkeInfrastrukture({ env: {}, ollamaUrl: 'http://o:11434', glasUrl: 'http://g:1' })
    const lazniFetch = (async (url: string) => {
      if (String(url).startsWith('http://o:11434')) return new Response('{}', { status: 200 })
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const r = await probajInfrastrukturu(s, lazniFetch, 200)
    const po = Object.fromEntries(r.map(x => [x.nameKey, x.stanje]))
    expect(po.infra_ploca).toBe('online')
    expect(po.infra_ollama).toBe('online')
    expect(po.infra_glas).toBe('offline')
    expect(po.infra_chroma).toBe('nije_podeseno')
  })
})

describe('Orkestrator — tko na čvoru vodi zadatke', () => {
  test('živ RegocDaemon: kartica kaže da vodi on i broji agente iz njegova registra', () => {
    const v = tkoVodiZadatke({
      daemon: { alive: true, pid: 1155303 },
      agenataSustava: 12,
      agenataPaketa: 0,
      paketUkljucen: true,
    })
    expect(v.vodi).toBe('regocdaemon')
    expect(v.agenata).toBe(12)
    expect(v.pid).toBe(1155303)
  })

  test('bez daemona i s uključenim orkestratorom paketa vodi paket (njegov registar)', () => {
    const v = tkoVodiZadatke({ daemon: { alive: false, pid: null }, agenataSustava: 12, agenataPaketa: 3, paketUkljucen: true })
    expect(v.vodi).toBe('paket')
    expect(v.agenata).toBe(3)
  })

  test('nitko: ni daemona ni uključenog paketa', () => {
    const v = tkoVodiZadatke({ daemon: { alive: false, pid: null }, agenataSustava: 0, agenataPaketa: 0, paketUkljucen: false })
    expect(v.vodi).toBe('nitko')
  })
})

describe('Vrijeme — baza piše UTC, prikaz u zoni čitatelja', () => {
  test('SQLite zapis bez zone je UTC, isto kao ISO sa Z', () => {
    const a = parsirajVrijemeBaze('2026-10-08 14:33:13')!
    const b = parsirajVrijemeBaze('2026-10-08T14:33:13.000Z')!
    expect(a.getTime()).toBe(b.getTime())
    expect(a.toISOString()).toBe('2026-10-08T14:33:13.000Z')
  })

  test('zapis s pomakom se poštuje; smeće je null', () => {
    expect(parsirajVrijemeBaze('2026-10-08T16:33:13+02:00')!.toISOString()).toBe('2026-10-08T14:33:13.000Z')
    expect(parsirajVrijemeBaze('')).toBeNull()
    expect(parsirajVrijemeBaze('nije datum')).toBeNull()
  })

  test('formatiranje u zadanoj zoni: 14:33 UTC = 16:33 u Zagrebu (CEST)', () => {
    expect(formatirajVrijeme('2026-10-08 14:33:13', 'Europe/Zagreb')).toBe('2026-10-08 16:33')
    expect(formatirajVrijeme('2026-10-08 14:33:13', 'America/New_York')).toBe('2026-10-08 10:33')
  })
})

describe('Vrijeme u pregledniku — ista pravila kao na poslužitelju', () => {
  test('skripta za preglednik radi sama za sebe i formatira u zoni ploče', () => {
    const src = skriptaPrikazaVremena('Europe/Zagreb')
    const fn = new Function(src + '; return [_kad("2026-10-08 14:33:13"), _sat("2026-10-08T14:33:13Z"), _dan("2026-10-08 23:30:00"), _kad(null)]')
    expect(fn()).toEqual(['2026-10-08 16:33', '16:33', '2026-10-09', ''])
  })

  test('skripta ploče nosi oznaku na koju se skripta ugrađuje', () => {
    const ui = readFileSync(join(KORIJEN, 'src/TaskWebUI.ts'), 'utf-8')
    expect(ui.split(OZNAKA_PRIKAZA_VREMENA).length - 1).toBe(1)
    expect(ui).toContain('ugradiPrikazVremena(HTML_TEMPLATE, zonaPrikaza())')
  })
})

describe('Vrijeme — nijedno vrijeme iz podataka ne ispisuje se sirovo (UTC) na ploči', () => {
  test('nema rezanja ISO zapisa (.slice(0, 19).replace(\'T\', \' \')) ni sirovog changedAt/updatedAt u ispisu', () => {
    const ui = readFileSync(join(KORIJEN, 'src/TaskWebUI.ts'), 'utf-8')
    const tijelo = ui.slice(ui.indexOf('const HTML_TEMPLATE = `'))
    expect(tijelo).not.toContain(".slice(0, 19).replace('T', ' ')")
    expect(tijelo).not.toMatch(/_esc\((r|d)\.(changedAt|changed_at|updatedAt) \|\| ''\)/)
    expect(tijelo).not.toMatch(/new Date\([^)]*\)\.toLocale(Time|Date)?String\(\)/)
  })
})

describe('Jezik — svaki ključ koji ploča koristi postoji u oba rječnika', () => {
  test('nijedan _T/_Tv/data-i18n ključ ne fali u en.json ni hr.json', () => {
    const ui = readFileSync(join(KORIJEN, 'src/TaskWebUI.ts'), 'utf-8')
    const en = JSON.parse(readFileSync(join(KORIJEN, 'locales/en.json'), 'utf-8'))
    const hr = JSON.parse(readFileSync(join(KORIJEN, 'locales/hr.json'), 'utf-8'))
    const kljucevi = new Set<string>()
    for (const m of ui.matchAll(/_Tv?\(\s*'([a-zA-Z0-9_]+)'/g)) kljucevi.add(m[1])
    for (const m of ui.matchAll(/data-i18n="([a-zA-Z0-9_]+)"/g)) kljucevi.add(m[1])
    // ključ koji završava s „_" je prefiks dinamičkog ključa (cfg_agent_role_ + id)
    const stvarni = [...kljucevi].filter(k => !k.endsWith('_'))
    expect(stvarni.filter(k => !(k in en))).toEqual([])
    expect(stvarni.filter(k => !(k in hr))).toEqual([])
  })

  test('kartice koje nose adrese iz postavki escapeaju ih (glasUrl upisuje korisnik)', () => {
    const ui = readFileSync(join(KORIJEN, 'src/TaskWebUI.ts'), 'utf-8')
    expect(ui).toContain("'<td><strong>' + _esc(r.name) + '</strong></td>'")
    expect(ui).toContain("+ _esc(r.summary) + '</td></tr>'")
    expect(ui).toContain("const adresa = s.endpoint ? _esc(s.endpoint) : '—';")
  })

  test('naslovi kartica Config su prevodivi (nema tvrdog teksta u naslovu)', () => {
    const ui = readFileSync(join(KORIJEN, 'src/TaskWebUI.ts'), 'utf-8')
    const naslovi = [...ui.matchAll(/<div class="info-card-title"><span class="icon">[^<]*<\/span>\s*([^\n]*)<\/div>/g)].map(m => m[1])
    expect(naslovi.length).toBeGreaterThan(20)
    expect(naslovi.filter(n => !n.includes('data-i18n='))).toEqual([])
  })
})
