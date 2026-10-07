/**
 * TASK-5311 — popravci odlučitelja s glavnog sustava prenijeti u paket:
 *  - TASK-5250: model koji „razmišlja" potroši tokene pa vrati prazan `content` uz pun `reasoning`;
 *    to NIJE odgovor — ponovi jednom bez razmišljanja (inače lažna odgoda).
 *  - TASK-5204 §11: rizici s popisa `rizicno_covjeku` uvijek idu čovjeku, i u samostalnom načinu.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ALATI = join(import.meta.dir, '..', 'tools')

function py(tijelo: string): any {
  const dom = mkdtempSync(join(tmpdir(), 'odl-prijenos-'))
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
})
