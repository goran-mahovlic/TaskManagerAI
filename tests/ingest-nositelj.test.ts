// TASK-5293: nalog koji izričito imenuje agenta („neka Ana napravi…", „@ana", „Ana, …")
// otvara zadatak s tim nositeljem — inače ga bira orkestrator. Dvosmisleno = bez nositelja.
import { describe, expect, test } from 'bun:test'
import { nositeljIzPoruke } from '../src/core/Ingest'

const agenti = [
  { id: 'ana', ime: 'Ana' },
  { id: 'ivan', ime: 'Ivan' },
  { id: 'kresimir', ime: 'Krešimir' },
  { id: 'botko', ime: 'Botko' },
]

describe('nositeljIzPoruke', () => {
  test('„neka <ime>" uz padež i bez dijakritike', () => {
    expect(nositeljIzPoruke('Bote, neka Ana napravi skriptu za disk', agenti)).toBe('ana')
    expect(nositeljIzPoruke('neka to Ivan pogleda', agenti)).toBe('ivan')
    expect(nositeljIzPoruke('Dodijeli Kresimiru provjeru mreže', agenti)).toBe('kresimir')
    expect(nositeljIzPoruke('zaduži Anu za izvještaj', agenti)).toBe('ana')
  })
  test('@id i obraćanje na početku poruke', () => {
    expect(nositeljIzPoruke('@ivan pogledaj log', agenti)).toBe('ivan')
    expect(nositeljIzPoruke('Krešimire, napravi tablicu', agenti)).toBe('kresimir')
  })
  test('ime bez naloga ne određuje nositelja', () => {
    expect(nositeljIzPoruke('Anin kod je spor, popravi ga', agenti)).toBeUndefined()
    expect(nositeljIzPoruke('što misliš o Ivanovom prijedlogu', agenti)).toBeUndefined()
    expect(nositeljIzPoruke('napravi skriptu za disk', agenti)).toBeUndefined()
  })
  test('dva različita agenta = dvosmisleno, bez nositelja', () => {
    expect(nositeljIzPoruke('neka Ana i neka Ivan naprave plan', agenti)).toBeUndefined()
  })
  test('riječ koja samo počinje imenom nije ime („Anatomija", „Ivanovićevi")', () => {
    expect(nositeljIzPoruke('neka Anatomija ostane', agenti)).toBeUndefined()
    expect(nositeljIzPoruke('neka Ivanovićevi dođu', agenti)).toBeUndefined()
  })
  test('prazan popis agenata = bez nositelja', () => {
    expect(nositeljIzPoruke('neka Ana napravi X', [])).toBeUndefined()
  })
})
