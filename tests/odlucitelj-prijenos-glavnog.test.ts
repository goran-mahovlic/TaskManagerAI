/**
 * TASK-5311 — popravci odlučitelja s glavnog sustava prenijeti u paket:
 *  - TASK-5250: model koji „razmišlja" potroši tokene pa vrati prazan `content` uz pun `reasoning`;
 *    to NIJE odgovor — ponovi jednom bez razmišljanja (inače lažna odgoda).
 *  - TASK-5204 §11: rizici s popisa `rizicno_covjeku` uvijek idu čovjeku, i u samostalnom načinu.
 */
import { describe, expect, test, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// TASK-5336: svaka privremena mapa ove datoteke briše se na kraju — /tmp je tmpfs od 100 MB,
// a zaostale mape su ga punile dok kritičar nije pao s ENOSPC.
const privremene: string[] = []
function privremenaMapa(prefiks: string): string { const d = mkdtempSync(prefiks); privremene.push(d); return d }
afterAll(() => { for (const d of privremene) rmSync(d, { recursive: true, force: true }) })

const ALATI = join(import.meta.dir, '..', 'tools')

function py(tijelo: string): any {
  const dom = privremenaMapa(join(tmpdir(), 'odl-prijenos-'))
  const kod = `import sys, json, io; sys.path.insert(0, ${JSON.stringify(ALATI)})
import odlucitelj as o
from pathlib import Path
o.ODGODE = Path(${JSON.stringify(join(dom, 'odgode.json'))})
${tijelo}`
  const r = Bun.spawnSync(['python3', '-c', kod], {
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: dom, TM_HOME: dom },
  })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return JSON.parse(r.stdout.toString().trim().split('\n').pop() || 'null')
}

/** Podmetnuti davatelj: vraća redom zadane poruke i bilježi tijela zahtjeva. */
const davatelj = (poruke: unknown[]) => `
odgovori = json.loads(${JSON.stringify(JSON.stringify(poruke))}); tijela = []
class Odg(io.BytesIO): pass
def urlopen(req, timeout=0):
    tijela.append(json.loads(req.data))
    return Odg(json.dumps({"choices": [{"message": odgovori[len(tijela) - 1]}]}).encode())
o.urllib.request.urlopen = urlopen
`

describe('odlucitelj.py — TASK-5250: prazan content uz reasoning nije odgovor', () => {
  test('ponovi jednom bez razmišljanja i uzmi content drugog odgovora', () => {
    const r = py(davatelj([
      { content: null, reasoning: 'We need answer in Croatian?' },
      { content: 'POKRENI', reasoning: null },
    ]) + `print(json.dumps({"o": o._pitaj_openai_oblik("http://x", "k", "m", "pitanje"), "n": len(tijela),
  "drugi": tijela[1].get("reasoning"), "max": tijela[0]["max_tokens"]}))`)
    expect(r.o).toBe('POKRENI')
    expect(r.n).toBe(2)
    expect(r.drugi).toEqual({ enabled: false })
    expect(r.max).toBeGreaterThanOrEqual(2000)
  })

  test('model koji odgovor stavlja u reasoning (content null oba puta) — uzima se reasoning', () => {
    const r = py(davatelj([
      { content: null, reasoning: 'razmišljam' },
      { content: null, reasoning: 'ODGODI' },
    ]) + `print(json.dumps(o._pitaj_openai_oblik("http://x", "k", "m", "p")))`)
    expect(r).toBe('ODGODI')
  })

  test('pun content iz prve — jedan zahtjev', () => {
    const r = py(davatelj([{ content: 'POKRENI' }]) +
      `print(json.dumps([o._pitaj_openai_oblik("http://x", "k", "m", "p"), len(tijela)]))`)
    expect(r).toEqual(['POKRENI', 1])
  })
})

describe('odlucitelj.py — TASK-5204 §11: rizicno_covjeku', () => {
  test('neispravna vrijednost = prazan popis', () => {
    expect(py(`print(json.dumps([o.rizicno_covjeku({}), o.rizicno_covjeku({"rizicno_covjeku": "novac"}), o.rizicno_covjeku({"rizicno_covjeku": ["novac"]})]))`))
      .toEqual([[], [], ['novac']])
  })

  test('rizik s popisa ide čovjeku i u samostalnom načinu (prije najave)', () => {
    const r = py(`p = {"ukljucen": True, "smije_rizicno": True, "rizicno_covjeku": ["novac"]}
z = {"id": "T-1", "title": "Plati račun", "description": "plati račun dobavljaču 500 EUR karticom"}
assert o.rizik(z) == "novac", o.rizik(z)
print(json.dumps(o.odluci(z, p)))`)
    expect(r.rijec).not.toBe('najava')
    expect(r.razlog).toContain('rizicno_covjeku')
  })
  test('zadatak s VIŠE rizika: dovoljan je bilo koji s popisa (ne samo prvi pogodak)', () => {
    // „novac" je u RIZIK prije „brisanje" — prvi pogodak (novac) NIJE na popisu, drugi jest
    const r = py(`p = {"ukljucen": True, "smije_rizicno": True, "rizicno_covjeku": [" Brisanje "]}
z = {"id": "T-2", "title": "Obriši stari račun i plati novi", "description": "obriši pretplatu pa plati 20 EUR"}
print(json.dumps({"rizici": o.rizici(z), "o": o.odluci(z, p)}))`)
    expect(r.rizici).toEqual(['novac', 'brisanje'])
    expect(r.o.razlog).toContain('rizicno_covjeku')
  })
})
