/**
 * TASK-4815 — jedinični testovi produkcijskog parsera agent-outputa.
 *
 * Pokrivaju pravila iz dizajna (docs/TASK-4813_parser-agent-outputa.md §2.2, §3, §5)
 * i revizije (docs/TASK-4814_revizija-dizajna.md §E, §F, §H):
 *   P1 sidrenje · P2 granica sekcije · P3 prvi redak bedža · ploča je mjerodavna ·
 *   fail-soft (null/prazno/11 313 zn) · renderMinimal je ČISTI TEKST · rječnik markera.
 *
 * Slučajevi TASK-4809 / TASK-4803 nisu izmišljeni — to su izmjereni kvarovi
 * sa živog korpusa (summary 3762 zn, statusText 3417 zn) prije pravila P2/P3.
 */
import { describe, expect, test } from 'bun:test'
import {
  MARKER_VOCAB,
  MAX_MSG_LEN,
  badgeFor,
  parseAgentOutput,
  plainText,
  renderMinimal,
  renderVoice,
  summaryLine,
} from '../src/core/AgentOutputParser'

// ─── Fail-soft: parser NIKAD ne baca ─────────────────────────────────────────
describe('fail-soft (§5 — glavni put, ne rub)', () => {
  test('null ne baca i daje L3', () => {
    const p = parseAgentOutput(null)
    expect(p.level).toBe('L3')
    expect(p.raw).toBe('')
  })

  test('undefined ne baca', () => {
    expect(parseAgentOutput(undefined as any).level).toBe('L3')
  })

  test('prazan i bjelinski ulaz daju L3', () => {
    expect(parseAgentOutput('').level).toBe('L3')
    expect(parseAgentOutput('   \n\t  ').level).toBe('L3')
  })

  test('ne-string ulaz (broj, objekt) ne baca', () => {
    expect(parseAgentOutput(12345 as any).level).toBe('L3')
    expect(parseAgentOutput({} as any).level).toBe('L3')
  })

  test('sažetak nikad nije prazan', () => {
    expect(summaryLine(parseAgentOutput(null))).toBe('(prazan rezultat)')
    expect(summaryLine(parseAgentOutput('sirovi tekst bez formata')).length).toBeGreaterThan(0)
  })

  test('ulaz od 11 313 znakova (najdulji u korpusu) ne baca i poštuje strop', () => {
    const dug = '📋 REZULTAT: ' + 'a'.repeat(11313)
    const p = parseAgentOutput(dug)
    expect(p.raw.length).toBeGreaterThan(11313)      // raw ostaje NEREZAN (§H)
    expect(summaryLine(p).length).toBeLessThanOrEqual(240)
    expect(renderMinimal(p, { maxLen: MAX_MSG_LEN }).length).toBeLessThanOrEqual(MAX_MSG_LEN)
  })
})

// ─── P1: sidrenje zaglavlja ──────────────────────────────────────────────────
describe('P1 — zaglavlje je sidreno na početak retka', () => {
  test('tekst koji format samo CITIRA ne postaje zaglavlje', () => {
    const citat = 'Spec: agent mora napisati redak 📋 SUMMARY: <jedna rečenica> i 📊 STATUS: <stanje>.'
    const p = parseAgentOutput(citat)
    expect(Object.keys(p.fields).length).toBe(0)
    expect(p.level).toBe('L3')
  })

  test('citat u sredini retka uz pravo zaglavlje ne krade sekciju', () => {
    const t = '📋 REZULTAT: gotovo\nU promptu piše 📊 STATUS: <stanje> kao predložak.'
    const p = parseAgentOutput(t)
    expect(p.fields.statusText).toBeUndefined()
    expect(p.fields.summary).toContain('gotovo')
  })

  test('ukrasi (>, #, *, _) pred zaglavljem su dopušteni', () => {
    expect(parseAgentOutput('> 📋 **REZULTAT:** ok').fields.summary).toBe('ok')
    expect(parseAgentOutput('**📊 STATUS:** Uspješno').fields.statusText).toBe('Uspješno')
  })

  test('pravi REGOČ-dijalekt daje L0', () => {
    const pravi = [
      '📋 REZULTAT: Popravljen parser',
      '📊 STATUS: Uspješno',
      '➡️ SLJEDEĆI KORACI: nema',
      '🗣️ Arhitekt: gotovo',
    ].join('\n')
    const p = parseAgentOutput(pravi)
    expect(p.level).toBe('L0')
    expect(p.dialect).toBe('regoc')
    expect(p.fields.summary).toBe('Popravljen parser')
    expect(p.fields.spoken).toBe('gotovo')
  })

  test('PAI-dijalekt i mješavina se prepoznaju', () => {
    const pai = '📋 SUMMARY: x\n🔍 ANALYSIS: y\n⚡ ACTIONS: z'
    expect(parseAgentOutput(pai).dialect).toBe('pai')
    expect(parseAgentOutput(pai).level).toBe('L0')
    expect(parseAgentOutput('📋 REZULTAT: x\n🔍 ANALYSIS: y').dialect).toBe('mjesovit')
  })
})

// ─── P2: granica sekcije ─────────────────────────────────────────────────────
describe('P2 — tijelo sekcije ima granicu', () => {
  test('markdown naslov zatvara sekciju (slučaj TASK-4809: 3762 → 68 zn)', () => {
    const t4809 = [
      '📋 REZULTAT: Naš tim više nije ugrađen u tipove ni u prikaz paketa TaskManagerAI.',
      '',
      '## Što je napravljeno (commit `60dbd06`)',
      '',
      '| Datoteka | Bilo | Sada |',
      '|---|---|---|',
      '| `src/types/task-types.ts` | ' + 'x'.repeat(3000) + ' | y |',
    ].join('\n')
    const p = parseAgentOutput(t4809)
    expect(p.fields.summary!.length).toBeLessThan(100)
    expect(p.fields.summary).toContain('TaskManagerAI')
  })

  test('novo zaglavlje zatvara sekciju', () => {
    const p = parseAgentOutput('📋 REZULTAT: prvo\nnastavak\n📊 STATUS: Uspješno')
    expect(p.fields.summary).toBe('prvo\nnastavak')
    expect(p.fields.statusText).toBe('Uspješno')
  })

  test('ograda ``` i REGOC-IZLAZ zatvaraju sekciju', () => {
    const p = parseAgentOutput('📋 REZULTAT: kratko\n```\nkod\n```')
    expect(p.fields.summary).toBe('kratko')
    const q = parseAgentOutput('📋 REZULTAT: kratko\nREGOC-IZLAZ\n{"napravljeno":"x","dokaz":[]}')
    expect(q.fields.summary).toBe('kratko')
  })

  test('=== VERIFIKACIJA === zatvara sekciju i puni vlastito polje', () => {
    const t = '📋 REZULTAT: ok\n=== VERIFIKACIJA ===\nnaredba: bun test\nizlaz: 24 pass\n=== KRAJ VERIFIKACIJE ==='
    const p = parseAgentOutput(t)
    expect(p.fields.summary).toBe('ok')
    expect(p.verification).toContain('24 pass')
    expect(p.verification).not.toContain('KRAJ VERIFIKACIJE')
  })

  test('🗣️ redak zatvara sekciju', () => {
    const p = parseAgentOutput('📋 REZULTAT: ok\n🗣️ Jelena: gotovo\njoš nešto')
    expect(p.fields.summary).toBe('ok')
    expect(p.fields.spoken).toBe('gotovo')
  })
})

// ─── P3: bedž čita samo prvi redak statusText ────────────────────────────────
describe('P3 — bedž čita SAMO prvi redak statusText (≤80 zn)', () => {
  test('slučaj TASK-4803: 3417 zn proze ne ulazi u bedž', () => {
    const t4803 = [
      '📋 REZULTAT: Pregled cjeline Config stranice',
      '',
      '📊 STATUS: Uspješno',
      '',
      'Zadatak je bio pregledati raspored. ' + 'proza '.repeat(600),
    ].join('\n')
    const p = parseAgentOutput(t4803)
    const b = badgeFor('completed', p)
    expect(b.badge).toBe('DONE')
    expect(p.statusHead.length).toBeLessThanOrEqual(80)
    expect(p.statusHead).toBe('Uspješno')
  })

  test('predugi prvi redak se reže na 80 zn', () => {
    const p = parseAgentOutput('📊 STATUS: ' + 'z'.repeat(500))
    expect(p.statusHead.length).toBeLessThanOrEqual(80)
  })
})

// ─── §3: ploča je mjerodavna ─────────────────────────────────────────────────
describe('§3 — ploča je mjerodavna, tekst smije SUZITI a nikad PODIĆI', () => {
  test('completed + DONE → 🟢 DONE', () => {
    const p = parseAgentOutput('REGOC-STATUS: DONE — sve ok')
    expect(badgeFor('completed', p).badge).toBe('DONE')
  })

  test('completed + DONE_WITH_CONCERNS → suženo na DONE_WITH_CONCERNS', () => {
    const p = parseAgentOutput('REGOC-STATUS: DONE_WITH_CONCERNS — ograde')
    const b = badgeFor('completed', p)
    expect(b.badge).toBe('DONE_WITH_CONCERNS')
    expect(b.sazio).toBe(true)
  })

  test('completed + proza „djelomično" → suženo', () => {
    const p = parseAgentOutput('📊 STATUS: Djelomično — dio nije provjeren')
    expect(badgeFor('completed', p).badge).toBe('DONE_WITH_CONCERNS')
  })

  test('blocked → BLOCKED bez obzira što tekst tvrdi', () => {
    const p = parseAgentOutput('📊 STATUS: Uspješno\nREGOC-STATUS: DONE — gotovo')
    const b = badgeFor('blocked', p, { blockedReason: 'BLOCKED: nema pristupa' })
    expect(b.badge).toBe('BLOCKED')
    expect(b.neslaganje).toBe(true)
  })

  test('blocked + NEEDS_CONTEXT u razlogu → NEEDS_CONTEXT', () => {
    const p = parseAgentOutput('nešto')
    expect(badgeFor('blocked', p, { blockedReason: 'NEEDS_CONTEXT: fali spec' }).badge).toBe('NEEDS_CONTEXT')
  })

  test('ZABRANJENO: in_progress + tekst tvrdi DONE → NIKAD zeleni DONE', () => {
    const p = parseAgentOutput('REGOC-STATUS: DONE — gotovo')
    const b = badgeFor('in_progress', p)
    expect(b.badge).not.toBe('DONE')
    expect(b.badge).toBe('IN_PROGRESS')
    expect(b.neslaganje).toBe(true)
  })

  test('pending + proza „uspješno" → NIKAD zeleni DONE, neslaganje se prikazuje', () => {
    const p = parseAgentOutput('📊 STATUS: Uspješno')
    const b = badgeFor('pending', p)
    expect(b.badge).toBe('IN_PROGRESS')
    expect(b.neslaganje).toBe(true)
  })

  test('nepoznat status ploče → UNKNOWN, ne DONE', () => {
    expect(badgeFor('' as any, parseAgentOutput('REGOC-STATUS: DONE')).badge).toBe('UNKNOWN')
    expect(badgeFor('cancelled', parseAgentOutput('REGOC-STATUS: DONE')).badge).toBe('UNKNOWN')
  })

  test('sva četiri deklarirana statusa se parsiraju (rupa iz §2.3)', () => {
    expect(parseAgentOutput('REGOC-STATUS: DONE').declared?.status).toBe('DONE')
    expect(parseAgentOutput('REGOC-STATUS: DONE_WITH_CONCERNS').declared?.status).toBe('DONE_WITH_CONCERNS')
    expect(parseAgentOutput('REGOC-STATUS: BLOCKED — nema alata').declared?.status).toBe('BLOCKED')
    expect(parseAgentOutput('REGOC-STATUS: NEEDS_CONTEXT — fali opis').declared?.status).toBe('NEEDS_CONTEXT')
  })

  test('DONE_WITH_CONCERNS ne smije biti pročitan kao goli DONE', () => {
    const d = parseAgentOutput('REGOC-STATUS: DONE_WITH_CONCERNS — uz ograde').declared
    expect(d?.status).toBe('DONE_WITH_CONCERNS')
    expect(d?.reason).toBe('uz ograde')
  })
})

// ─── razine ──────────────────────────────────────────────────────────────────
describe('§5 — ljestvica razina', () => {
  test('L2: bez zaglavlja, ali ima strojni trag', () => {
    expect(parseAgentOutput('sve gotovo\nREGOC-STATUS: DONE — ok').level).toBe('L2')
    expect(parseAgentOutput('bla\n=== VERIFIKACIJA ===\nizlaz: 1').level).toBe('L2')
  })

  test('L1: jedno do dva polja', () => {
    expect(parseAgentOutput('📋 REZULTAT: x').level).toBe('L1')
    expect(parseAgentOutput('📋 REZULTAT: x\n📊 STATUS: y').level).toBe('L1')
  })

  test('L3: sirovo (79 % prometa) — ljestvica sažetka pada na sirovi tekst', () => {
    const p = parseAgentOutput('Zatvoreno, 5 commitova, sve provjereno.')
    expect(p.level).toBe('L3')
    expect(summaryLine(p)).toContain('Zatvoreno')
  })

  test('stepOutput se čita preko StepSchema (bez preslike)', () => {
    const t = 'REGOC-IZLAZ\n```json\n{"napravljeno":"x","dokaz":[{"vrsta":"naredba","naredba":"a","izlaz":"b"}]}\n```'
    const p = parseAgentOutput(t)
    expect(p.stepOutput).toBeTruthy()
    expect((p.stepOutput as any).napravljeno).toBe('x')
  })
})

// ─── §E: minimal je ČISTI TEKST ──────────────────────────────────────────────
describe('§E — renderMinimal vraća čisti tekst (Telegram nema parse_mode)', () => {
  const IZVJESTAJ = [
    '📋 REZULTAT: **Gotovo** uz `provjeru`.',
    '',
    '| Datoteka | Bilo | Sada |',
    '|---|---|---|',
    '| `x.ts` | staro | novo |',
    '',
    '📊 STATUS: Uspješno',
  ].join('\n')

  test('nema **, backtickova ni markdown tablice', () => {
    const m = renderMinimal(parseAgentOutput(IZVJESTAJ), { maxLen: MAX_MSG_LEN })
    expect(m).not.toMatch(/\*\*/)
    expect(m).not.toMatch(/`/)
    expect(m).not.toMatch(/^\s*\|.*\|\s*$/m)
    expect(m).not.toMatch(/^#{1,6}\s/m)
  })

  test('plainText čuva sadržaj, briše samo zapis', () => {
    expect(plainText('**Gotovo** uz `provjeru`')).toBe('Gotovo uz provjeru')
    expect(plainText('| a | b |\n|---|---|\n| 1 | 2 |')).toContain('a · b')
    expect(plainText('## Naslov')).toBe('Naslov')
    expect(plainText('[ploča](http://x)')).toContain('http://x')
  })

  test('poštuje strop i ne reže nasred niza', () => {
    const dug = parseAgentOutput('📋 REZULTAT: ' + 'x'.repeat(2500) + '\n🔍 ANALYSIS: ' + 'y'.repeat(2500))
    const m = renderMinimal(dug, { maxLen: 600 })
    expect(m.length).toBeLessThanOrEqual(600)
    expect(m).not.toContain('y'.repeat(50))   // ANALYSIS ne ulazi u minimalni kanal
  })

  test('rez pada na granicu rečenice, ne nasred riječi', () => {
    const p = parseAgentOutput('Prva rečenica je kratka. Druga rečenica je jako jako dugačka i ne stane.')
    const s = summaryLine(p, 40)
    expect(s.length).toBeLessThanOrEqual(40)
    expect(s).toContain('Prva rečenica')
  })

  test('glava i poveznica na ploču su opcionalne i čiste', () => {
    const m = renderMinimal(parseAgentOutput('📋 REZULTAT: ok'), {
      heading: '✅ Kosjenka završila zadatak TASK-1',
      boardUrl: 'http://ploca.primjer:17781',
      maxLen: MAX_MSG_LEN,
    })
    expect(m.startsWith('✅ Kosjenka završila zadatak TASK-1')).toBe(true)
    expect(m).toContain('Ploča: http://ploca.primjer:17781')
  })

  // Regresija s živog prometa: tijelo verifikacije počinje ogradom ``` pa je prvi
  // „redak" bio prazan i na Telegram je odlazio goli znak ✓ bez ijedne riječi.
  test('trag verifikacije nosi sadržaj ili ga uopće nema', () => {
    const sOgradom = parseAgentOutput('📋 REZULTAT: ok\n=== VERIFIKACIJA ===\n```\nnaredba: bun test\nizlaz: 211 pass\n```')
    const m = renderMinimal(sOgradom, { maxLen: MAX_MSG_LEN })
    expect(m).toContain('✓ naredba: bun test')
    const prazna = parseAgentOutput('📋 REZULTAT: ok\n=== VERIFIKACIJA ===\n```\n```')
    expect(renderMinimal(prazna, { maxLen: MAX_MSG_LEN })).not.toMatch(/✓\s*$/)
  })

  test('nikad prazna poruka, ni za null', () => {
    expect(renderMinimal(parseAgentOutput(null), { maxLen: 100 }).length).toBeGreaterThan(0)
  })
})

// ─── voice ───────────────────────────────────────────────────────────────────
describe('§4 — renderVoice ≤ 16 riječi', () => {
  test('uzima 🗣️ redak kad postoji', () => {
    expect(renderVoice(parseAgentOutput('📋 REZULTAT: x\n🗣️ Jelena: parser je gotov'))).toBe('parser je gotov')
  })

  test('pada na sažetak i reže na 16 riječi', () => {
    const v = renderVoice(parseAgentOutput('📋 REZULTAT: ' + 'riječ '.repeat(50)))
    expect(v.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(16)
  })

  test('prazan ulaz ne baca', () => {
    expect(typeof renderVoice(parseAgentOutput(null))).toBe('string')
  })
})

// ─── §F: rječnik markera ─────────────────────────────────────────────────────
describe('§F — MARKER_VOCAB je rječnik, svaka strana gradi svoj uzorak', () => {
  test('rječnik pokriva oba dijalekta i nosi emoji+ključnu riječ', () => {
    expect(MARKER_VOCAB.length).toBeGreaterThanOrEqual(11)
    for (const m of MARKER_VOCAB) {
      expect(typeof m.emoji).toBe('string')
      expect(typeof m.keyword).toBe('string')
      expect(['pai', 'regoc']).toContain(m.dialect)
    }
    expect(MARKER_VOCAB.some(m => m.keyword.includes('REZULTAT'))).toBe(true)
    expect(MARKER_VOCAB.some(m => m.keyword.includes('SUMMARY'))).toBe(true)
  })

  test('jedan strop za sve kanale', () => {
    expect(MAX_MSG_LEN).toBe(3900)
  })
})
