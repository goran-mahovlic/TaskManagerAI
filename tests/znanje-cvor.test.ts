/**
 * ADR-0006 §7 i mjerilo Z4: znanje čvora iz vlastite ploče i Telegrama, plan upisa u banku.
 */
import { describe, expect, test } from 'bun:test'
import { dokumentProjekti, dokumentRazgovor, dokumentStanje, dokumentZadatak, imaTajnu, planUpisa } from '../src/znanje/Cvor'

describe('Z4 — plan upisa', () => {
  test('isti korpus = ništa za upis', () => {
    const k = { 'sustav/a': '1', 'cvor/projekti': '2' }
    expect(planUpisa(k, { ...k })).toEqual({ novi: [], promijenjeni: [], nestali: [], isti: 2 })
  })
  test('novo, promijenjeno, nestalo', () => {
    const p = planUpisa({ 'sustav/a': '1', 'sustav/b': '9' }, { 'sustav/a': '1', 'sustav/c': '3', 'cvor/projekti': '4' })
    expect(p.novi).toEqual(['sustav/b'])
    expect(p.nestali).toEqual(['cvor/projekti', 'sustav/c'])
  })
  test('razgovor se ne briše kad dnevni zapis istekne; tuđi id (stara karta) se ne dira', () => {
    const p = planUpisa({}, { 'cvor/razgovor/x/2026-10-01': '1', 'system-map/agenti.md': '2' })
    expect(p.nestali).toEqual([])
  })
})

describe('brana tajni', () => {
  test.each([
    ['token bota', 'evo 123456789:AA' + 'b'.repeat(33)],
    ['ključ', 'sk-ant-' + 'a'.repeat(30)],
    ['heks', 'x'.repeat(0) + 'ab12'.repeat(16)],
    ['lozinka', 'lozinka: Tajna12345'],
  ])('%s → tajna', (_n, t) => expect(imaTajnu(t)).toBe(true))
  test('običan tekst nije tajna', () => expect(imaTajnu('Napravi PRJ-002 i TASK-12, chat -5112345678')).toBe(false))
})

describe('dokumenti čvora', () => {
  test('projekti: samo projekti ploče i napomena o ID-u', () => {
    const d = dokumentProjekti('cvor-x', [{ id: 'PRJ-002', name: 'Testiranje', status: 'active', task_count: 3, completed_task_count: 1 }])
    expect(d).toContain('## PRJ-002 — Testiranje')
    expect(d).toContain('vrijedi samo na ploči čvora cvor-x')
  })
  test('zadatak: rezultat skraćen, blok koda izostavljen', () => {
    const d = dokumentZadatak('c', { id: 'TASK-7', title: 'T', status: 'completed', assignee: 'jelena', resultSummary: 'ok\n```\nveliki\n```\n' + 'x'.repeat(3000) }, 100)
    expect(d).toContain('[blok koda izostavljen]')
    expect(d).not.toContain('veliki')
    expect(d.length).toBeLessThan(400)
  })
  test('razgovor: dan s tajnom se ne upisuje', () => {
    const r = dokumentRazgovor('c', 'Bot', '-1', '2026-10-07', [{ ts: '2026-10-07T10:00:00Z', smjer: 'ulaz', posiljateljIme: 'Ana', tekst: 'ključ je sk-ant-' + 'a'.repeat(30) }])
    expect(r.sadrzaj).toBeNull()
    expect(r.tajna).toBe(true)
  })
  test('razgovor: potezi s imenom i vremenom; bot pod svojim imenom', () => {
    const r = dokumentRazgovor('c', 'Bot', '-1', '2026-10-07', [
      { ts: '2026-10-07T10:00:00Z', smjer: 'ulaz', posiljateljIme: 'Ana', tekst: 'otvori projekt X' },
      { ts: '2026-10-07T10:01:00Z', smjer: 'izlaz', tekst: 'Otvoren PRJ-004.' },
    ])
    expect(r.sadrzaj).toContain('- 10:00 Ana: otvori projekt X')
    expect(r.sadrzaj).toContain('- 10:01 Bot: Otvoren PRJ-004.')
  })
  test('stanje: čvor bez RAG-a to izričito kaže', () => {
    const d = dokumentStanje({ cvor: 'c', mogucnosti: { rag: false, memorija: true }, banka: 'b' })
    expect(d).toContain('RAG NIJE uključen')
    expect(d).toContain('Hindsight banka `b`')
  })
})
