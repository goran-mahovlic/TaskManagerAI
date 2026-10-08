/**
 * Ulaz na čvoru (TASK-5367, nalaz TASK-5360 — TASK-306 „napravi PDF + mp3" na node-A).
 *
 *   1. predložak na čvoru bez RAG-a ne traži dokument u RAG-u;
 *   2. nalog bez projekta dobiva projekt čvora (`defaultProject` ≠ pretinac), ne pretinac;
 *   3. zadani izvršitelj kanala ima prednost pred pogađanjem klasifikatora po riječi;
 *   4. nalog za dokument/zvuk bez traga koda je „samo tekst" — ne traži granu i commit.
 *
 *   bun test tests/ingest-cvor.test.ts
 */

import { describe, expect, test } from 'bun:test'

import { ZADANE_POSTAVKE } from '../src/core/IngestConfig'
import { procijeniIngest, odaberiIzvrsitelja, izgledaNekodno } from '../src/core/Ingest'
import { renderirajOpis } from '../src/core/IngestTemplate'

const cfg = (over: Record<string, unknown> = {}) => ({
  ...ZADANE_POSTAVKE, perSource: { '*': 'on' as const }, projectBySource: {}, ...over,
}) as any

const NALOG_306 = '@bot nalog (QA proba): 1) napravi PDF od jedne stranice s naslovom „Proba” i pošalji ga u ovu grupu ' +
  'kao dokument; 2) naredbom glas napravi mp3 iste rečenice i pošalji ga u grupu; 3) u rezultatu navedi ' +
  'putanje obje datoteke i alat kojim si napravio PDF.'

describe('predložak koraka bez RAG-a', () => {
  const osnova = { message: 'napravi PDF', weight: 26, source: 'konzola', taskId: 'TASK-1', pragB: 36 }

  test('RAG uključen: korak 2 traži dokument u RAG-u (kao prije)', () => {
    const o = renderirajOpis({ ...osnova, ragUkljucen: true })
    expect(o).toContain('OBVEZAN IZLAZ: dokument u RAG-u')
  })

  test('RAG isključen: nema zahtjeva za RAG dokumentom ni rag-store alata', () => {
    const o = renderirajOpis({ ...osnova, ragUkljucen: false })
    expect(o).not.toContain('dokument u RAG-u')
    expect(o).not.toContain('rag-store')
    expect(o).toContain('RAG je isključen na ovom čvoru')
  })
})

describe('projekt čvora', () => {
  test('defaultProject koji nije pretinac je projekt čvora', () => {
    const o = procijeniIngest({ source: 'telegram', text: NALOG_306 }, cfg({ defaultProject: 'PRJ-004' }))
    expect(o.projectId).toBe('PRJ-004')
    expect(o.projectSource).toBe('cvor')
  })

  test('bez postavke i dalje pretinac', () => {
    const o = procijeniIngest({ source: 'telegram', text: NALOG_306 }, cfg())
    expect(o.projectSource).toBe('pretinac')
  })
})

describe('izvršitelj', () => {
  test('zadani izvršitelj kanala ima prednost pred prijedlogom klasifikatora', () => {
    expect(odaberiIzvrsitelja({ tekst: 'xyz', prijedlozi: ['potjeh'], zadani: 'jelena', dopusteni: ['jelena', 'potjeh'] }))
      .toBe('jelena')
  })

  test('bez zadanog prijedlog klasifikatora i dalje vrijedi', () => {
    expect(odaberiIzvrsitelja({ tekst: 'xyz', prijedlozi: ['potjeh'], dopusteni: ['jelena', 'potjeh'] }))
      .toBe('potjeh')
  })

  test('nalog TASK-306 sa zadanim izvršiteljem ide njemu, ne QA-u', () => {
    const o = procijeniIngest({ source: 'telegram', text: NALOG_306, zadaniIzvrsitelj: 'jelena' }, cfg())
    expect(o.akcija).toBe('zadatak')
    expect(o.effort).toBe('E2')
    expect(o.zadatak!.assignee).toBe('jelena')
  })
})

describe('ne-kodni nalog je „samo tekst"', () => {
  test('PDF + mp3 bez traga koda', () => {
    expect(izgledaNekodno(NALOG_306)).toBe(true)
    const o = procijeniIngest({ source: 'telegram', text: NALOG_306 }, cfg())
    expect(o.zadatak!.tags).toContain('samo-tekst')
  })

  test('nalog koji dira kod NIJE samo tekst', () => {
    expect(izgledaNekodno('Popravi grešku u src/core/Ingest.ts i dodaj test.')).toBe(false)
    expect(izgledaNekodno('Napravi skriptu koja generira PDF izvještaj')).toBe(false)
  })

  test('nalog bez isporuke dokumenta nije proglašen samo-tekstom', () => {
    expect(izgledaNekodno('Popravi grešku u prikazu troška na kartici projekta.')).toBe(false)
  })
})
