/**
 * TASK-5198: nakon tihog pada mreže (mrtve keep-alive veze, bez FIN/RST) ploča je stajala
 * ≥ 3,5 min stara uz zeleno „Spojeno". Chrome po hostu drži najviše 6 HTTP/1.1 utičnica;
 * dohvati BEZ roka (fetchUnverified, fetchUputeStanje, ostali GET-ovi) sjede na mrtvim
 * utičnicama zauvijek, pa svaki novi /api/tasks čeka u redu za slobodno mjesto do svog
 * roka od 60 s (ERR_ABORTED). WebSocket ima zaseban bazen — zato se on spoji, a ploča ne.
 *
 * Ugovor: svaki GET dobiva zadani rok, dohvati u letu se mogu prekinuti kad se WS ponovo
 * spoji (oslobodi bazen), a zaglavlje kaže kad je ploča stara.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const IZVOR = new URL('../src/TaskWebUI.ts', import.meta.url).pathname
const tekst = readFileSync(IZVOR, 'utf-8')

/** Izvadi samostalnu funkciju iz skripte ploče po imenu (do retka koji je zatvara). */
function funkcija(ime: string): string {
  let i = tekst.indexOf(`    function ${ime}(`)
  if (i < 0) i = tekst.indexOf(`    async function ${ime}(`)
  expect(i).toBeGreaterThan(-1)
  const j = tekst.indexOf('\n    }\n', i)
  return tekst.slice(i, j + 6)
}

type Poziv = { url: string; init: any; razrijesi: (v: any) => void; odbij: (e: any) => void }

function lazniFetch() {
  const pozivi: Poziv[] = []
  const f = (url: string, init: any) => new Promise((razrijesi, odbij) => {
    const p: Poziv = { url, init, razrijesi, odbij }
    pozivi.push(p)
    init?.signal?.addEventListener('abort', () => odbij(new DOMException('aborted', 'AbortError')))
  })
  return { f, pozivi }
}

function napravi(rokMs: number) {
  const { f, pozivi } = lazniFetch()
  const tvornica = new Function(funkcija('napraviFetchSRokom') + '\nreturn napraviFetchSRokom;')()
  const s = tvornica(f, rokMs)
  return { s, pozivi }
}

const spavaj = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('napraviFetchSRokom — svaki GET ima rok', () => {
  test('GET bez signala istekne nakon roka i oslobodi mjesto (AbortError)', async () => {
    const { s, pozivi } = napravi(30)
    const p = s.fetch('/api/upute/stanje')
    expect(pozivi.length).toBe(1)
    expect(pozivi[0].init.signal).toBeDefined()
    await expect(p).rejects.toThrow()
    expect(s.uLetu()).toBe(0)
  })

  test('uspješan odgovor prolazi netaknut i izlazi iz popisa u letu', async () => {
    const { s, pozivi } = napravi(1000)
    const p = s.fetch('/api/tasks', { cache: 'no-store' })
    expect(s.uLetu()).toBe(1)
    pozivi[0].razrijesi({ ok: true, status: 200 })
    await expect(p).resolves.toEqual({ ok: true, status: 200 })
    expect(pozivi[0].init.cache).toBe('no-store')
    expect(s.uLetu()).toBe(0)
  })

  test('POST bez signala NE dobiva zadani rok (dugotrajne radnje korisnika)', async () => {
    const { s, pozivi } = napravi(20)
    const p = s.fetch('/api/x', { method: 'POST', body: '{}' })
    await spavaj(60)
    pozivi[0].razrijesi({ ok: true })
    await expect(p).resolves.toEqual({ ok: true })
  })

  test('vlastiti signal pozivatelja i dalje prekida', async () => {
    const { s } = napravi(10_000)
    const ctl = new AbortController()
    const p = s.fetch('/api/tasks', { signal: ctl.signal })
    ctl.abort()
    await expect(p).rejects.toThrow()
  })
})

describe('prekiniStare — WS se ponovo spojio, mrtve utičnice van iz bazena', () => {
  test('prekida samo dohvate starije od praga, mlađe ostavlja', async () => {
    const { s, pozivi } = napravi(10_000)
    const stari = s.fetch('/api/tasks')
    await spavaj(40)
    const novi = s.fetch('/api/critic/unverified')
    expect(s.prekiniStare(30)).toBe(1)
    await expect(stari).rejects.toThrow()
    pozivi[1].razrijesi({ ok: true })
    await expect(novi).resolves.toEqual({ ok: true })
    expect(s.uLetu()).toBe(0)
  })
})

describe('skripta ploče koristi rok', () => {
  test('window.fetch je omotan prije prvog dohvata', () => {
    const i = tekst.indexOf('window.fetch = fetchSRokom.fetch')
    expect(i).toBeGreaterThan(-1)
    expect(i).toBeLessThan(tekst.indexOf('async function fetchTasks('))
  })
  test('rok dohvata ploče je najviše 20 s (bio 60 s)', () => {
    const tijelo = funkcija('dohvatiZadatkePloce')
    const m = tijelo.match(/ctl\.abort\(\); \}, (\d+)\)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeLessThanOrEqual(20000)
  })
  test('fetchUnverified i fetchUputeStanje imaju vlastiti rok', () => {
    for (const ime of ['fetchUnverified', 'fetchUputeStanje']) {
      expect(funkcija(ime)).toMatch(/signal: rokSignal\(\d+\)/)
    }
  })
  test('WS onopen poslije pada prekida stare dohvate i odmah traži ploču', () => {
    const i = tekst.indexOf('sock.onopen = () => {')
    const tijelo = tekst.slice(i, tekst.indexOf('sock.onclose', i))
    expect(tijelo).toContain('fetchSRokom.prekiniStare(')
    expect(tijelo).toContain('fetchTasks(')
  })
  test('zaglavlje javlja staru ploču (> 2 min bez uspješnog dohvata)', () => {
    const t = funkcija('renderStanjeVeze')
    expect(t).toContain('tasksZadnjiUspjeh')
    expect(t).toContain('veza_ploca_stara')
    for (const j of ['hr', 'en']) {
      const r = JSON.parse(readFileSync(new URL(`../locales/${j}.json`, import.meta.url).pathname, 'utf-8'))
      expect(r.veza_ploca_stara).toContain('{min}')
    }
  })
})
