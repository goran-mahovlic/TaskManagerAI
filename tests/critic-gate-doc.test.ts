/**
 * CriticGate — doc-provjere L0/L1 (TASK-4833 dizajn §5.6 / izvedba TASK-4834)
 *
 * Regresija koju čuvaju: vratar je za isporuku koja je DOKUMENT planirao nula provjera, pa
 * je `.md` prolazio nevidljivo. Izmjereno 29.08.–12.09.2026. na data/critic_gate.jsonl:
 * 101 od 204 suda (49,5 %) završio je kao „izmijenjene datoteke nisu kod ni test" ili kao
 * prazan `pass`. Testovi drže pet stvari (dizajn §5.6):
 *   (a) neispravan dokument pada — svaki na SVOM razlogu,
 *   (b) stvarni dokumenti iz docs/ paketa prolaze — regresija na LAŽNE
 *       uzbune; provjera koja obara dobre dokumente ugasi se za tjedan dana kao šum,
 *   (c) `odjeljci:` — prazan odsjek pada, naslov sa sadržajem u istom retku prolazi,
 *   (d) `docMode:'shadow'` NIKAD ne postavlja `blocking` i ne ulazi u `failed`,
 *   (e) nepoznat ključ uz `[PROVJERA]` i dalje kvari cijeli blok.
 *
 * Sve privremene datoteke idu u ~/.tmp (/tmp je 100 MB tmpfs + noexec).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  DEFAULT_CRITIC_CONFIG,
  docCheckL0,
  docCheckL1,
  docProseOnly,
  docNormalize,
  docMatchesTargets,
  docCharCount,
  isDocIgnored,
  loadCriticConfig,
  runDocCheck,
  planChecks,
  parseDeclaredChecks,
  realRunner,
  realRunnerAsync,
  runChecks,
  judge,
  explainUnverified,
  critiqueSpawn,
  formatCritiqueLog,
  type CriticConfig,
  type ChangedFile,
  type CheckResult,
  type ScanResult,
} from '../src/core/CriticGate'
import { formatUnverifiedAlert } from '../src/core/UnverifiedReport'

const TMP = tmpdir()
// Korpus = dokumentacija samog paketa: stvarni tekstovi, koje nitko nije pisao za ovaj test.
const DOCS_KORPUS = join(import.meta.dir, '..', 'docs')

let dir = ''
beforeAll(() => {
  mkdirSync(TMP, { recursive: true })
  dir = mkdtempSync(join(TMP, 'critic-doc-'))
})
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

function cfg(over: Partial<CriticConfig> = {}): CriticConfig {
  return { ...DEFAULT_CRITIC_CONFIG, ...over }
}

/** Zdrav dokument: iznad obaju pragova, s naslovom, bez rupa. */
function zdravDokument(): string {
  const odlomak = 'Ovaj odlomak postoji zato da dokument prijeđe prag tvari od 800 znakova i 12 nepraznih redaka. '
  const linije = ['# Naslov dokumenta', '', '## Kontekst', '']
  for (let i = 0; i < 12; i++) linije.push(`${i + 1}. ${odlomak}`)
  linije.push('', '## Zaključak', '', odlomak)
  return linije.join('\n')
}

function pisi(name: string, text: string): string {
  const p = join(dir, name)
  writeFileSync(p, text)
  return p
}

function promijenjena(p: string): ChangedFile {
  return { path: p, mtimeMs: Date.now(), sizeBytes: 1 }
}

const praznoSkeniranje: ScanResult = { files: [], truncated: 0, missingRoots: [] }

// ─── (a) Neispravni dokumenti padaju, svaki na svom razlogu ──────────────────

describe('L0 — šest kvarova, šest različitih razloga', () => {
  const opts = { minChars: 800, minLines: 12 }

  test('prazan dokument: premalo sadržaja I premalo redaka I nema naslova', () => {
    const r = docCheckL0('', opts)
    expect(r.problems.some((p) => p.startsWith('premalo sadržaja'))).toBe(true)
    expect(r.problems.some((p) => p.startsWith('premalo redaka'))).toBe(true)
    expect(r.problems).toContain('nema nijednog naslova (#)')
    expect(r.measured).toEqual({ znakova: 0, redaka: 0 })
  })

  test('tri retka: prolazi naslov, pada tvar', () => {
    const r = docCheckL0('# Naslov\n\nGotovo.\n', opts)
    expect(r.problems).not.toContain('nema nijednog naslova (#)')
    expect(r.problems.some((p) => p.startsWith('premalo sadržaja'))).toBe(true)
    expect(r.problems.some((p) => p.startsWith('premalo redaka'))).toBe(true)
  })

  test('nezatvorena ograda: neparan broj ograda na početku retka', () => {
    const r = docCheckL0(zdravDokument() + '\n\n```bash\nnešto\n', opts)
    expect(r.problems).toContain('neparan broj ograda ``` — nezatvoren blok koda')
  })

  test('ostavljen TODO na početku retka', () => {
    const r = docCheckL0(zdravDokument() + '\n\nTODO: dovršiti odsjek o rizicima\n', opts)
    expect(r.problems).toContain('ostavljen TODO/TBD/FIXME')
  })

  test('redak koji je samo nepopunjen <ugao>', () => {
    const r = docCheckL0(zdravDokument() + '\n\n<ime autora>\n', opts)
    expect(r.problems).toContain('redak koji je samo nepopunjen <ugao>')
  })

  test('ispuna lorem ipsum (puna fraza)', () => {
    const r = docCheckL0(zdravDokument() + '\n\nLorem ipsum dolor sit amet, consectetur.\n', opts)
    expect(r.problems).toContain('ispuna „lorem ipsum"')
  })

  test('redak koji je samo trotočka', () => {
    const r = docCheckL0(zdravDokument() + '\n\n...\n', opts)
    expect(r.problems).toContain('redak koji je samo trotočka')
  })

  test('dokument koji je preslika opisa zadatka', () => {
    const opis = zdravDokument()
    const r = docCheckL0(opis, { ...opts, taskDescription: opis })
    expect(r.problems).toContain('dokument je uglavnom preslika opisa zadatka')
    // Isti dokument BEZ usporedbe s opisom prolazi — pravilo ne smije opaliti samo od sebe.
    expect(docCheckL0(opis, opts).problems).toEqual([])
  })

  test('zdrav dokument ne pada ni na čemu', () => {
    expect(docCheckL0(zdravDokument(), opts).problems).toEqual([])
  })
})

describe('L0 — suženja koja su nastala iz lažnih uzbuna (ne smiju se „očistiti")', () => {
  const opts = { minChars: 800, minLines: 12 }

  test('ograda spomenuta u UMETNUTOM kodu se ne broji kao otvorena', () => {
    // Mjereno na prototipu: ovo je oborilo sam dizajn-dokument dok se ograda brojila bilo gdje.
    const t = zdravDokument() + '\n\nOgrade se broje samo na početku retka, npr. `' + '```' + '` usred rečenice.\n'
    expect(docCheckL0(t, opts).problems).toEqual([])
  })

  test('`<div class=...>` unutar bloka koda nije rupa', () => {
    const t = zdravDokument() + '\n\n```html\n<div class="x">\n```\n'
    expect(docCheckL0(t, opts).problems).toEqual([])
  })

  test('citirana fraza „lorem ipsum dolor" nije ispuna', () => {
    const t = zdravDokument() + '\n\nPravilo hvata punu frazu „lorem ipsum dolor" u tekstu.\n'
    expect(docCheckL0(t, opts).problems).toEqual([])
  })

  test('`<ime>` usred proze je legitiman, samostalan redak nije', () => {
    expect(docCheckL0(zdravDokument() + '\n\nPredložak koristi `<ime>` kao mjesto za ime.\n', opts).problems).toEqual([])
    expect(docCheckL0(zdravDokument() + '\n\n<ime>\n', opts).problems).toContain('redak koji je samo nepopunjen <ugao>')
  })

  test('docProseOnly izbacuje blok koda, umetnuti kod i navod', () => {
    const t = '```\nTODO unutra\n```\n`TODO umetnuto`\n„TODO u navodu"\nostatak'
    const proza = docProseOnly(t)
    expect(proza).not.toContain('TODO unutra')
    expect(proza).not.toContain('TODO umetnuto')
    expect(proza).not.toContain('TODO u navodu')
    expect(proza).toContain('ostatak')
  })

  test('docNormalize izbacuje dijakritiku i interpunkciju', () => {
    expect(docNormalize('Rješenje — DA!')).toBe('rjes enje da')
  })

  // Prijenos je 1:1 s prototipom SAMO ako se znakovi broje isto. `String.length` broji
  // surogatni par kao dva, pa je dokument s emojijima u TS-u ispadao dulji nego u Pythonu
  // (ADR-0004: 31631 naspram 31627) — mjerilo prototipa tada više ne vrijedi za izvedbu.
  test('docCharCount broji KODNE TOČKE, kao Python len()', () => {
    expect(docCharCount('abc')).toBe(3)
    expect(docCharCount('čćž')).toBe(3)
    expect(docCharCount('🔎')).toBe(1)
    expect('🔎'.length).toBe(2)
    expect(docCharCount('a🔎b✅')).toBe(4)
  })

  test('izmjereni broj znakova u L0 je broj kodnih točaka', () => {
    const r = docCheckL0('# N\n🔎🔎\n', { minChars: 800, minLines: 12 })
    expect(r.measured.znakova).toBe(docCharCount('# N\n🔎🔎\n'))
    expect(r.measured.znakova).toBe(7) // '# N\n🔎🔎\n' = 7 kodnih točaka, 9 UTF-16 jedinica
  })
})

// ─── (b) Regresija: stvarni korpus docs/ ne smije pasti ──────────────────────

describe('regresija nad stvarnim korpusom docs/ paketa', () => {
  test('svaki .md u docs/ prolazi L0 (nula lažnih uzbuna)', () => {
    if (!existsSync(DOCS_KORPUS)) {
      // Korpus je izvan ovog stabla; na stroju bez njega test nema što mjeriti, ali se
      // to MORA vidjeti — tiho preskakanje bi značilo da regresije nema, a izgleda da je ima.
      console.warn(`[doc-regresija] korpus ${DOCS_KORPUS} ne postoji — regresija nije izmjerena`)
      return
    }
    const docs = readdirSync(DOCS_KORPUS).filter((f) => f.endsWith('.md')).map((f) => join(DOCS_KORPUS, f))
    expect(docs.length).toBeGreaterThanOrEqual(10)
    const pali: string[] = []
    const t0 = Date.now()
    for (const p of docs) {
      const r = docCheckL0(readFileSync(p, 'utf-8'), { minChars: 800, minLines: 12 })
      if (r.problems.length) pali.push(`${p}: ${r.problems.join('; ')}`)
    }
    const ms = Date.now() - t0
    // Cijena se MJERI, a ne pretpostavlja: prototip je dao 1,2 ms/dok.
    expect(ms / docs.length).toBeLessThan(50)
    expect(pali).toEqual([])
  })
})

// ─── (c) L1 — traženi odsjeci ────────────────────────────────────────────────

describe('L1 — odsjeci moraju biti REDAK NASLOVA i imati sadržaj', () => {
  test('nema traženog odsjeka', () => {
    const r = docCheckL1('# Naslov\n\nTekst.\n', ['IZVORI'])
    expect(r.problems).toEqual(['nema traženog odsjeka „IZVORI"'])
    expect(r.measured.trazeno).toBe(1)
    expect(r.measured.odsjekaOk).toBe(0)
  })

  test('prazan odsjek pada', () => {
    const t = '# Naslov\n\n## IZVORI\n\n## Sljedeće\n\nTekst.\n'
    expect(docCheckL1(t, ['IZVORI']).problems).toEqual(['odsjek „IZVORI" postoji, ali je prazan'])
  })

  test('odsjek sa sadržajem ispod naslova prolazi', () => {
    const t = '# Naslov\n\n## IZVORI\n\n- src/core/CriticGate.ts r. 536\n- data/critic_gate.jsonl\n'
    const r = docCheckL1(t, ['IZVORI'])
    expect(r.problems).toEqual([])
    expect(r.measured.odsjekaOk).toBe(1)
  })

  test('naslov koji NOSI sadržaj u istom retku prolazi', () => {
    const t = '# Naslov\n\n**Odluka: DA na (b) — mjerenje je pokazalo da prag drži.**\n\n## Kraj\n'
    expect(docCheckL1(t, ['Odluka']).problems).toEqual([])
  })

  test('PROZNI redak s imenom odsjeka NIJE odsjek (lažan pogodak iz prototipa)', () => {
    const t = '# Naslov\n\nodluka TASK-2959 je zapisana drugdje i ovdje se samo spominje.\n'
    expect(docCheckL1(t, ['Odluka']).problems).toEqual(['nema traženog odsjeka „Odluka"'])
  })

  test('više odsjeka: jedan nedostaje, drugi prolazi', () => {
    const t = '# N\n\n## KONTEKST\n\nNešto konkretno je ovdje napisano.\n'
    const r = docCheckL1(t, ['KONTEKST', 'RASPON NESIGURNOSTI'])
    expect(r.problems).toEqual(['nema traženog odsjeka „RASPON NESIGURNOSTI"'])
    expect(r.measured.odsjekaOk).toBe(1)
  })

  test('bez traženih odsjeka L1 ne prigovara ništa', () => {
    expect(docCheckL1('bilo što', []).problems).toEqual([])
  })
})

// ─── (e) Ključevi [PROVJERA] ─────────────────────────────────────────────────

describe('parseDeclaredChecks — novi ključevi `odjeljci:` i `doc:`', () => {
  test('odjeljci se čitaju kao popis odvojen zarezom', () => {
    const d = parseDeclaredChecks('[PROVJERA] odjeljci: IZVORI, RASPON NESIGURNOSTI, ZAKLJUČAK')
    expect(d.sections).toEqual(['IZVORI', 'RASPON NESIGURNOSTI', 'ZAKLJUČAK'])
    expect(d.issues).toEqual([])
    expect(d.present).toBe(true)
  })

  test('doc suzuje na točan dokument i trpi komentar iza vrijednosti', () => {
    const d = parseDeclaredChecks('[PROVJERA] doc: docs/ISTRAZIVANJE-xyz.md    # neobvezno')
    expect(d.docTargets).toEqual(['docs/ISTRAZIVANJE-xyz.md'])
    expect(d.issues).toEqual([])
  })

  test('odjeljci i cmd zajedno — jedan blok, oboje pročitano', () => {
    const d = parseDeclaredChecks([
      '[PROVJERA] cmd: bun test tests/x.test.ts',
      '[PROVJERA] odjeljci: IZVORI',
      '[PROVJERA] doc: docs/x.md',
    ].join('\n'))
    expect(d.checks.length).toBe(1)
    expect(d.sections).toEqual(['IZVORI'])
    expect(d.docTargets).toEqual(['docs/x.md'])
  })

  test('prazan `odjeljci` kvari blok', () => {
    const d = parseDeclaredChecks('[PROVJERA] cmd: bun test a.ts\n[PROVJERA] odjeljci:   ')
    expect(d.checks).toEqual([])
    expect(d.sections).toEqual([])
    expect(d.issues[0].reason).toContain('prazan `odjeljci` redak')
  })

  test('metaznak ljuske u `doc` se odbija i kvari blok', () => {
    const d = parseDeclaredChecks('[PROVJERA] doc: docs/x.md; rm -rf /')
    expect(d.docTargets).toEqual([])
    expect(d.issues[0].reason).toContain('metaznak ljuske')
  })

  test('`..` u `doc` se ne razrješava', () => {
    const d = parseDeclaredChecks('[PROVJERA] doc: ../../tudje/x.md')
    expect(d.docTargets).toEqual([])
    expect(d.issues[0].reason).toContain('`..`')
  })

  test('NEPOZNAT ključ i dalje kvari CIJELI blok (uključivo odjeljke)', () => {
    const d = parseDeclaredChecks([
      '[PROVJERA] cmd: bun test tests/x.test.ts',
      '[PROVJERA] odjeljci: IZVORI',
      '[PROVJERA] izmisljeno: da',
    ].join('\n'))
    expect(d.checks).toEqual([])
    expect(d.sections).toEqual([])
    expect(d.docTargets).toEqual([])
    expect(d.issues.some((i) => i.reason.includes('nepoznat ključ'))).toBe(true)
    // Popis poznatih ključeva mora imenovati i nove — inače dojava šalje na krivi trag.
    expect(d.issues.find((i) => i.reason.includes('nepoznat ključ'))!.reason).toContain('odjeljci')
  })
})

// ─── planChecks + __doc__ ────────────────────────────────────────────────────

describe('planChecks — doc-provjera se planira kao pseudo-naredba', () => {
  test('`.md` dobiva `kind:doc` i naredbu __doc__, bez spawna', () => {
    const p = pisi('plan.md', zdravDokument())
    const plan = planChecks([promijenjena(p)], cfg())
    expect(plan.length).toBe(1)
    expect(plan[0].kind).toBe('doc')
    expect(plan[0].cmd).toEqual(['__doc__', p])
    expect(plan[0].doc).toMatchObject({ minChars: 800, minLines: 12, sections: [] })
  })

  test('docMode:off ne planira ništa', () => {
    const p = pisi('off.md', zdravDokument())
    expect(planChecks([promijenjena(p)], cfg({ docMode: 'off' }))).toEqual([])
  })

  test('CHECKPOINT_ datoteka se preskače (docIgnore)', () => {
    const p = pisi('CHECKPOINT_TASK-1_biljeska.md', '# Kratko\n\nBilješka.\n')
    expect(planChecks([promijenjena(p)], cfg())).toEqual([])
    expect(isDocIgnored(p, cfg())).toBe(true)
  })

  test('`[PROVJERA] doc:` sužava na točan dokument', () => {
    const a = pisi('trazeni.md', zdravDokument())
    const b = pisi('drugi.md', zdravDokument())
    const plan = planChecks([promijenjena(a), promijenjena(b)], cfg(), () => false, [], { docTargets: ['trazeni.md'] })
    expect(plan.map((c) => c.target)).toEqual([a])
  })

  test('traženi odsjeci putuju uz plan (L1)', () => {
    const p = pisi('l1.md', zdravDokument())
    const plan = planChecks([promijenjena(p)], cfg(), () => false, [], { sections: ['IZVORI'] })
    expect(plan[0].doc!.sections).toEqual(['IZVORI'])
  })

  test('.txt i .adoc su također dokumenti', () => {
    const a = pisi('a.txt', zdravDokument())
    const b = pisi('b.adoc', zdravDokument())
    expect(planChecks([promijenjena(a), promijenjena(b)], cfg()).map((c) => c.kind)).toEqual(['doc', 'doc'])
  })

  test('docMatchesTargets: prazno suženje pušta sve, inače sufiks ili ime', () => {
    expect(docMatchesTargets('/x/y/a.md', [])).toBe(true)
    expect(docMatchesTargets('/x/y/a.md', ['y/a.md'])).toBe(true)
    expect(docMatchesTargets('/x/y/a.md', ['./y/a.md'])).toBe(true)
    expect(docMatchesTargets('/x/y/a.md', ['a.md'])).toBe(true)
    expect(docMatchesTargets('/x/y/a.md', ['b.md'])).toBe(false)
  })
})

describe('realRunner __doc__ — u procesu, bez spawna', () => {
  test('zdrav dokument → exit 0 i izmjereno u stdoutu', () => {
    const p = pisi('run-ok.md', zdravDokument())
    const out = realRunner({ kind: 'doc', target: p, cmd: ['__doc__', p], cwd: dir, doc: { minChars: 800, minLines: 12, sections: [] } }, 1000)
    expect(out.exitCode).toBe(0)
    expect(out.stderr).toBe('')
    expect(out.stdout).toContain('L0 run-ok.md')
    expect(out.stdout).toMatch(/\d+ znakova/)
  })

  test('pokvaren dokument → exit 1 i razlog u stderru', () => {
    const p = pisi('run-bad.md', '# N\n\nGotovo.\n')
    const out = realRunner({ kind: 'doc', target: p, cmd: ['__doc__', p], cwd: dir, doc: { minChars: 800, minLines: 12, sections: [] } }, 1000)
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain('premalo sadržaja')
  })

  test('nepostojeća datoteka → exit 1, nikad tihi prolaz', () => {
    const out = runDocCheck(join(dir, 'nema.md'), { minChars: 800, minLines: 12, sections: [] })
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain('ne postoji')
  })

  test('asinkroni put daje ISTI ishod (pseudo-naredba ne spawna)', async () => {
    const p = pisi('run-async.md', zdravDokument())
    const check = { kind: 'doc' as const, target: p, cmd: ['__doc__', p], cwd: dir, doc: { minChars: 800, minLines: 12, sections: [] } }
    const a = realRunner(check, 1000)
    const b = await realRunnerAsync(check, 1000)
    expect(b).toEqual(a)
  })

  test('L1 se vidi u izmjerenom', () => {
    const p = pisi('run-l1.md', '# N\n\n## IZVORI\n\n- nešto konkretno i dovoljno dugo\n')
    const out = runDocCheck(p, { minChars: 10, minLines: 3, sections: ['IZVORI'] })
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('odsjeka 1/1')
    expect(out.stdout).toContain('L1 ')
  })
})

// ─── (d) shadow NIKAD ne blokira ─────────────────────────────────────────────

function docRezultat(target: string, ok: boolean, sections: string[] = []): CheckResult {
  return {
    kind: 'doc', target, cmd: ['__doc__', target], cwd: '/x', doc: { minChars: 800, minLines: 12, sections },
    ok, exitCode: ok ? 0 : 1, ms: 1, timedOut: false, skipped: false,
    errorLine: ok ? '' : 'premalo sadržaja: 40 znakova < 800',
  }
}

describe('judge — način shadow', () => {
  test('pala doc-provjera u shadowu NE ulazi u failed i NE blokira', () => {
    const v = judge([docRezultat('/x/a.md', false)], praznoSkeniranje, [], [], cfg({ docMode: 'shadow' }))
    expect(v.failed).toEqual([])
    expect(v.blocking).toBe(false)
    expect(v.status).not.toBe('fail')
    expect(v.signatures).toEqual([])
    // Ne blokira, ali se NE prešućuje.
    expect(v.notes.some((n) => n.includes('doc-provjera u sjeni'))).toBe(true)
  })

  test('pala doc-provjera u načinu `on` JEST pad i blokira', () => {
    const v = judge([docRezultat('/x/a.md', false)], praznoSkeniranje, [], [], cfg({ docMode: 'on' }))
    expect(v.status).toBe('fail')
    expect(v.blocking).toBe(true)
    expect(v.failed.length).toBe(1)
    expect(v.signatures[0]).toContain('doc:')
  })

  test('pala doc-provjera u shadowu ne daje razinu (ništa nije potvrđeno)', () => {
    const v = judge([docRezultat('/x/a.md', false)], praznoSkeniranje, [], [], cfg({ docMode: 'shadow' }))
    expect(v.razina).toBeNull()
    expect(v.docChecked).toEqual(['/x/a.md'])
  })

  test('prošla doc-provjera bez odsjeka → razina L0', () => {
    const v = judge([docRezultat('/x/a.md', true)], praznoSkeniranje, [], [], cfg({ docMode: 'shadow' }))
    expect(v.status).toBe('pass')
    expect(v.razina).toBe('L0')
    expect(v.docChecked).toEqual(['/x/a.md'])
    // §6: ishod se IMENUJE razinom, nikad golim „pass".
    expect(v.reason).toContain('razine L0')
    expect(v.reason).toContain('SADRŽAJ NIJE provjeren')
  })

  test('prošla doc-provjera s odsjecima → razina L1', () => {
    const v = judge([docRezultat('/x/a.md', true, ['IZVORI'])], praznoSkeniranje, [], [], cfg({ docMode: 'shadow' }))
    expect(v.razina).toBe('L1')
    expect(v.reason).toContain('razine L1')
  })

  test('bez doc-provjere razina ostaje null', () => {
    expect(judge([], praznoSkeniranje, [], [], cfg()).razina).toBeNull()
    expect(judge([], praznoSkeniranje, [], [], cfg()).docChecked).toEqual([])
  })

  test('kritika stvarnog dokumenta u shadowu nikad ne zaustavlja zadatak', () => {
    const wt = mkdtempSync(join(TMP, 'critic-doc-wt-'))
    try {
      writeFileSync(join(wt, 'ljuska.md'), '# Naslov\n\nGotovo.\n')
      const o = critiqueSpawn(
        { taskId: null, agentId: 'test', sinceMs: Date.now() - 60_000, live: true, extraRoots: [wt] },
        cfg({ watchRoots: [], docMode: 'shadow' }),
      )
      expect(o.verdict.checks.some((c) => c.kind === 'doc')).toBe(true)
      expect(o.enforce).toBe(false)
      expect(o.verdict.blocking).toBe(false)
      expect(o.blockedReason).toBe('')
      expect(formatCritiqueLog(null, o, true)).toContain('doc=[✗ ljuska.md]')
    } finally { rmSync(wt, { recursive: true, force: true }) }
  })

  test('L0 nad stvarnim dokumentom prolazi kroz cijeli put i daje razinu', () => {
    const wt = mkdtempSync(join(TMP, 'critic-doc-ok-'))
    try {
      writeFileSync(join(wt, 'dobar.md'), zdravDokument())
      const o = critiqueSpawn(
        { taskId: null, agentId: 'test', sinceMs: Date.now() - 60_000, live: true, extraRoots: [wt] },
        cfg({ watchRoots: [], docMode: 'shadow' }),
      )
      expect(o.verdict.status).toBe('pass')
      expect(o.verdict.razina).toBe('L0')
      expect(o.verdict.docChecked.map((p) => p.split('/').pop())).toEqual(['dobar.md'])
      expect(formatCritiqueLog(null, o, true)).toContain('razina=L0')
    } finally { rmSync(wt, { recursive: true, force: true }) }
  })

  test('opis zadatka ulazi u pravilo „preslika opisa" i ondje pada', () => {
    const wt = mkdtempSync(join(TMP, 'critic-doc-echo-'))
    try {
      const opis = zdravDokument()
      writeFileSync(join(wt, 'jeka.md'), opis)
      const o = critiqueSpawn(
        { taskId: null, agentId: 'test', sinceMs: Date.now() - 60_000, live: true, extraRoots: [wt], taskDescription: opis },
        cfg({ watchRoots: [], docMode: 'on' }),
      )
      expect(o.verdict.status).toBe('fail')
      expect(o.verdict.failed[0].errorLine).toContain('preslika opisa zadatka')
    } finally { rmSync(wt, { recursive: true, force: true }) }
  })
})

// ─── explainUnverified: razina se imenuje ────────────────────────────────────

describe('explainUnverified — L0/L1 više nije „nema što provjeriti"', () => {
  test('kad je razina prošla, rečenica IMENUJE razinu i ono što nije provjereno', () => {
    const v = judge([docRezultat('/x/a.md', true)], { files: [{ path: '/x/a.md', mtimeMs: 1, sizeBytes: 1 }], truncated: 0, missingRoots: [] }, [], [], cfg())
    const razlozi = explainUnverified({ ...v, status: 'unverifiable' }, cfg(), { roots: ['/x'] })
    const r = razlozi.join(' | ')
    expect(r).toContain('provjeren do razine L0')
    expect(r).toContain('SADRŽAJ')
    expect(r).not.toContain('nema što prevesti')
  })

  test('pala doc-provjera se imenuje u razlozima', () => {
    const v = judge([docRezultat('/x/a.md', false)], { files: [{ path: '/x/a.md', mtimeMs: 1, sizeBytes: 1 }], truncated: 0, missingRoots: [] }, [], [], cfg({ docMode: 'shadow' }))
    const r = explainUnverified({ ...v, status: 'unverifiable' }, cfg({ docMode: 'shadow' }), { roots: ['/x'] }).join(' | ')
    expect(r).toContain('doc-provjera je pala')
    expect(r).toContain('docMode=shadow')
  })

  test('doc-only isporuka ne dobiva krivu rečenicu o testu uz modul', () => {
    const v = judge([docRezultat('/x/a.md', true)], { files: [{ path: '/x/a.md', mtimeMs: 1, sizeBytes: 1 }], truncated: 0, missingRoots: [] }, [], [], cfg())
    const r = explainUnverified({ ...v, status: 'unverifiable' }, cfg(), { roots: ['/x'] }).join(' | ')
    expect(r).not.toContain('nema pripadnog testa')
  })

  test('popis traženih vrsta uključuje dokumente kad docMode nije off', () => {
    const v = judge([], { files: [{ path: '/x/a.png', mtimeMs: 1, sizeBytes: 1 }], truncated: 0, missingRoots: [] }, [], [], cfg())
    const r = explainUnverified(v, cfg(), { roots: ['/x'] }).join(' | ')
    expect(r).toContain('.md')
    expect(r).toContain('ni dokument')
  })
})



// ─── §5.3 Dojava: razina se imenuje ──────────────────────────────────────────

describe('dojava criticUnverifiedAlert — više ne tvrdi da nije provjereno NIŠTA', () => {
  const osnova = { taskId: 'TASK-4834', agentId: 'jelena', status: 'unverifiable' as const, reasons: ['zadatak nema ključ `[PROVJERA] cmd:`'], costUsd: 1.5, durationS: 100 }

  test('bez razine tekst ostaje kakav je bio', () => {
    const t = formatUnverifiedAlert({ ...osnova })
    expect(t).toContain('vratar NIJE mogao provjeriti NIŠTA')
  })

  test('s razinom L0 dojava imenuje razinu i ono što NIJE provjereno', () => {
    const t = formatUnverifiedAlert({ ...osnova, razina: 'L0', docChecked: ['/x/docs/DIZAJN.md'] })
    expect(t).not.toContain('NIJE mogao provjeriti NIŠTA')
    expect(t).toContain('(L0)')
    expect(t).toContain('DIZAJN.md')
    expect(t).toContain('NIJE provjereno')
    expect(t).toContain('L2')
  })

  test('s razinom L1 imenuje i traženu strukturu', () => {
    const t = formatUnverifiedAlert({ ...osnova, razina: 'L1', docChecked: ['/x/a.md'] })
    expect(t).toContain('oblik i traženu strukturu')
    expect(t).toContain('traženi odsjeci')
  })
})

/**
 * ── ČETIRI IZMJERENE LAŽNE UZBUNE (TASK-4836 → TASK-4839) ────────────────────
 *
 * Mjereno `tools/mjeri-doc-vratar-korpus.ts --dani 60` nad 120 dokumenata u `watchRoots` i
 * 29 povijesnih doc-only isporuka iz `regoc.db`: 12 padova, od kojih su ovo četiri klase
 * dobrih dokumenata koje je L0 pogrešno obarao. Svaka klasa ima svoj primjer IZ KORPUSA i
 * po jedan protuprimjer — jer popravak koji ugasi i pravu uzbunu nije popravak.
 */
describe('L0 — naslov nije samo `#` (TASK-4839, klase a i d)', () => {
  const opts = { minChars: 10, minLines: 2 }
  const nemaNaslov = (t: string) => docCheckL0(t, opts).problems.includes('nema nijednog naslova (#)')

  test('(a) Unicode banner „═══ naslov ═══" u istom retku je naslov (tests/GOLDEN_NT-D_IZVJESTAJ.txt)', () => {
    expect(nemaNaslov('\n═══ NT-D golden-set — točnost ModeClassifiera ═══\n\nTočnost tiera: 30 %\n')).toBe(false)
  })

  test('(a) ASCII okvir „====" iznad naslovnog retka je naslov (TaskManagerMD/TASK-065-COMPLETE.txt)', () => {
    const t = '='.repeat(80) + '\n  TASK-065: P1 AUTO-EXECUTE BACKEND\n' + '='.repeat(80) + '\n\nAGENT: Jelena\n'
    expect(nemaNaslov(t)).toBe(false)
  })

  test('(a) okvir od crtica ispod naslova (setext) je naslov', () => {
    expect(nemaNaslov('Izvještaj o mjerenju\n--------------------\n\nTijelo.\n')).toBe(false)
  })

  test('(d) PAI memory: YAML zaglavlje s `name:` + podebljani redak je naslov (memory/*.md)', () => {
    const t = '---\nname: primjer-projekt\ndescription: "Primjer projekta"\nmetadata:\n  type: project\n---\n\n'
      + 'Primjer = FPGA ploča na M.2 kartici.\n\n**VERZIJE (kritično):** v1 = commit `abc1234`.\n'
    expect(nemaNaslov(t)).toBe(false)
  })

  test('protuprimjer: gola proza bez ijednog naslova I DALJE pada', () => {
    expect(nemaNaslov('Ovo je samo tekst.\nDrugi redak teksta.\nTreći redak.\n')).toBe(true)
  })

  test('protuprimjer: YAML zaglavlje BEZ imena i bez podebljanog retka i dalje pada', () => {
    expect(nemaNaslov('---\nfoo: bar\n---\n\nsamo proza bez naslova\ni još proze\n')).toBe(true)
  })

  test('protuprimjer: vodoravna crta `---` sama, bez naslovnog retka, nije naslov', () => {
    expect(nemaNaslov('\n\n---\n\n')).toBe(true)
  })
})

describe('L0 — `<ugao>` ne smije hvatati HTML/Vue tagove (TASK-4839, klasa b)', () => {
  const opts = { minChars: 10, minLines: 2 }
  const rupa = (t: string) => docCheckL0('# N\n\n' + t, opts).problems.includes('redak koji je samo nepopunjen <ugao>')

  test('Slidev/Vue predložak: `<div class=…>`, `</div>`, `<v-clicks>`, `<style>` nisu rupe', () => {
    for (const redak of ['<div class="pt-12">', '</div>', '  </span>', '<v-clicks>', '</v-clicks>', '<style>', '</style>', '<br/>', '<img src="x.png" />']) {
      expect(rupa(redak)).toBe(false)
    }
  })

  test('protuprimjer: nepopunjeno mjesto `<ime autora>` i `<opis>` I DALJE pada', () => {
    expect(rupa('<ime autora>')).toBe(true)
    expect(rupa('<opis>')).toBe(true)
    expect(rupa('- <TBD>')).toBe(true)
  })
})

describe('L0/plan — `templates/` se ne provjerava kao isporuka (TASK-4839, klasa c)', () => {
  test('predložak pod `templates/` je izuzet, kao i CHECKPOINT_', () => {
    const c = DEFAULT_CRITIC_CONFIG
    expect(isDocIgnored('/srv/instalacija/templates/spec-upgrade.md', c)).toBe(true)
    expect(isDocIgnored('/srv/instalacija/docs/DIZAJN.md', c)).toBe(false)
    // Podniz mora biti omeđen kosim crtama — `mojitemplates.md` nije predložak.
    expect(isDocIgnored('/srv/instalacija/mojitemplates.md', c)).toBe(false)
  })
})
