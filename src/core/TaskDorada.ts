/**
 * TaskDorada — dorada zatvorenog zadatka, bilješke i poruke o pogrešci (TASK-5164).
 *
 * Dizajn: DIZAJN-nesukladnosti-BCD.md §4 (nesukladnost D) u repozitoriju sustava domaćina.
 *
 * Zašto zaseban modul: ploča (TaskWebUI.ts, 15 000+ redaka) ovo samo spaja s bazom, a pravila
 * (koja ruta postoji, što 409 savjetuje, što dorada nasljeđuje) moraju se dati ispitati bez
 * podizanja poslužitelja. Funkcije su čiste — nema I/O-a.
 *
 *  - Dorada je NOVI zadatak povezan s izvornim (`dorada-od:TASK-X`), a ne ponovno otvaranje:
 *    `completed → pending` ne briše `completed_at`, miješa trošak dvaju poslova i odmah
 *    pokreće auto-spawn bez upute (dizajn §4.1).
 *  - Pogrešan poziv mora reći koji JE ispravan — 404 „Not Found” kao običan tekst i 400
 *    „expected array” bez uputa ruše agenta koji ne zna kamo dalje (M12, M13).
 */

/** Podrute pod `/api/tasks/<ID>/…` koje ploča poslužuje. Redoslijed = redoslijed u odgovoru. */
export const RUTE_ZADATKA: readonly string[] = [
  'PUT /api/tasks/<ID>',
  'GET /api/tasks/<ID>',
  'POST /api/tasks/<ID>/biljeska',
  'POST /api/tasks/<ID>/notes',
  'POST /api/tasks/<ID>/uputa',
  'GET /api/tasks/<ID>/upute',
  'POST /api/tasks/<ID>/dorada',
  'POST /api/tasks/<ID>/ponovno-otvori',
  'POST /api/tasks/<ID>/pitanje',
  'POST /api/tasks/<ID>/odluka',
  'POST /api/tasks/<ID>/pause',
  'POST /api/tasks/<ID>/resume',
  'POST /api/tasks/<ID>/reclaim',
  'GET /api/tasks/<ID>/revizija',
  'PUT /api/tasks/<ID>/progress',
  'GET /api/tasks/<ID>/telemetry',
]

/** Riječi koje agenti stvarno pišu, a nisu tipfeler nego drugi jezik ili sinonim. */
const SINONIMI: Record<string, string> = {
  note: 'biljeska', notes: 'biljeska', comment: 'biljeska', comments: 'biljeska',
  biljeske: 'biljeska', 'bilješka': 'biljeska', 'bilješke': 'biljeska',
  reopen: 'ponovno-otvori', otvori: 'ponovno-otvori', 'ponovo-otvori': 'ponovno-otvori',
  rework: 'dorada', fix: 'dorada', followup: 'dorada', 'follow-up': 'dorada',
  instruction: 'uputa', instructions: 'uputa', question: 'pitanje', ask: 'pitanje',
  close: 'PUT', complete: 'PUT', status: 'PUT', update: 'PUT',
}

function udaljenost(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return d[a.length][b.length]
}

/**
 * Najbliža postojeća ruta za nepoznatu podrutu (`notes` → `/biljeska`).
 * `null` kad ništa nije dovoljno blizu — kriv savjet je gori od nikakvog.
 */
export function predloziRutu(podruta: string): string | null {
  const p = String(podruta || '').toLowerCase().replace(/^\/+|\/+$/g, '')
  if (!p) return null
  const sin = SINONIMI[p]
  if (sin === 'PUT') return 'PUT /api/tasks/<ID>'
  if (sin) return RUTE_ZADATKA.find((r) => r.endsWith('/' + sin)) ?? null
  // Kandidati: kanonske podrute + sinonimi (sinonim vodi na kanonsku, npr. `notex` → `/biljeska`).
  const kandidati: Array<[string, string]> = []
  for (const r of RUTE_ZADATKA) {
    const zadnji = r.split('/').pop() || ''
    if (zadnji !== '<ID>' && !SINONIMI[zadnji]) kandidati.push([zadnji, r])
  }
  for (const [kljuc, cilj] of Object.entries(SINONIMI)) {
    const r = cilj === 'PUT' ? 'PUT /api/tasks/<ID>' : RUTE_ZADATKA.find((x) => x.endsWith('/' + cilj))
    if (r) kandidati.push([kljuc, r])
  }
  let najbolja: string | null = null
  let min = Infinity
  for (const [ime, r] of kandidati) {
    const u = udaljenost(p, ime)
    if (u < min) { min = u; najbolja = r }
  }
  // Prag: najviše trećina duljine (min. 1) — „pitnje”→„pitanje” da, „xyzzy”→išta ne.
  return min <= Math.max(1, Math.floor(p.length / 3)) ? najbolja : null
}

export interface Odgovor404 {
  error: 'Unknown route'
  details: string
  dostupno: string[]
  mislio_si: string | null
}

export function odgovor404Rute(taskId: string, podruta: string, metoda: string): Odgovor404 {
  const s = (r: string) => r.replace('<ID>', taskId)
  const prijedlog = predloziRutu(podruta)
  return {
    error: 'Unknown route',
    details: `${metoda} /api/tasks/${taskId}/${podruta} ne postoji.` +
      (prijedlog ? ` Vjerojatno tražiš: ${s(prijedlog)}.` : ''),
    dostupno: RUTE_ZADATKA.map(s),
    mislio_si: prijedlog ? s(prijedlog) : null,
  }
}

/** Uputa uz 409 „Forbidden status transition” — što učiniti umjesto zabranjenog prijelaza. */
export function hintPrijelaza(iz: string, u: string, taskId: string): string {
  const t = `/api/tasks/${taskId}`
  if (iz === 'completed' || iz === 'cancelled') {
    return `Zadatak je zatvoren ('${iz}'). Za doradu otvori POVEZANI zadatak: POST ${t}/dorada ` +
      `{"razlog":"…","author":"…"} — izvorni ostaje zatvoren. Samo ako je zatvoren greškom: ` +
      `POST ${t}/ponovno-otvori {"razlog":"…","by":"…"}. Bilješka bez promjene statusa: POST ${t}/biljeska.`
  }
  if (iz === 'in_progress' && u === 'pending') {
    return `Zadatak u radu ne vraća se u 'pending' običnim PUT-om. Zaustavi ga: POST ${t}/pause ` +
      `(nastavak: POST ${t}/resume). Novu uputu agentu: POST ${t}/uputa. ` +
      `POST ${t}/reclaim je samo za nadzornika (siroče/zastoj).`
  }
  if (u === 'completed' && (iz === 'blocked' || iz === 'pending')) {
    return `Iz '${iz}' se ne zatvara izravno: najprije PUT ${t} {"status":"in_progress"}, ` +
      `pa {"status":"completed","resultSummary":"…"} (dva poziva, pravilo 12). ` +
      `Zatvaranje prolazi kroz kritičara (nesukladnost B).`
  }
  return `Dopušteni prijelazi su u polju allowedTransitions. Bilješka bez promjene statusa: POST ${t}/biljeska.`
}

/** `progressNotes: "x"` → `["x"]`. Tekst je nedvosmislen, pa odbijanje ne štiti ništa (M13). */
export function normalizirajBiljeske(v: unknown): { vrijednost: unknown; alias: boolean } {
  if (typeof v === 'string') {
    const t = v.trim()
    return { vrijednost: t ? [t] : [], alias: true }
  }
  return { vrijednost: v, alias: false }
}

/** Tekst bilješke iz tijela `/biljeska` ili `/notes`: `text`, `note` ili `biljeska`. */
export function tekstBiljeske(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const b = body as Record<string, unknown>
  for (const k of ['text', 'note', 'biljeska']) {
    if (typeof b[k] === 'string' && (b[k] as string).trim()) return (b[k] as string).trim()
  }
  return ''
}

// ─── DORADA ──────────────────────────────────────────────────────────────────

export interface IzvorniZadatak {
  id: string
  title: string
  status: string
  description?: string
  resultSummary?: string
  tags?: string[]
  projectId?: string | null
  assignee?: string | null
  priority?: number
}

export function naslovDorade(izvorniNaslov: string): string {
  const n = String(izvorniNaslov || '').trim()
  return /^dorada:/i.test(n) ? n : `Dorada: ${n}`
}

/** Retci `[PROVJERA] cmd: …` iz opisa — kritičar ih pokreće i nad doradom. */
export function izvuciProvjere(opis: string | undefined): string[] {
  return String(opis || '').split('\n').map((l) => l.trim()).filter((l) => /^\[PROVJERA\]/i.test(l))
}

function skrati(s: string, n: number): string {
  const t = String(s || '').trim()
  return t.length > n ? t.slice(0, n) + ' …[skraćeno]' : t
}

export function opisDorade(a: { izvorni: IzvorniZadatak; razlog: string; author: string; opis?: string }): string {
  const { izvorni } = a
  const dijelovi = [
    `DORADA zadatka ${izvorni.id} („${izvorni.title}”) — otvorio/la: ${a.author}.`,
    '',
    `## Što treba doraditi`,
    a.razlog.trim(),
  ]
  if (a.opis && a.opis.trim()) dijelovi.push('', a.opis.trim())
  dijelovi.push(
    '',
    `## Izvorni zadatak ${izvorni.id} (zatvoren, ostaje netaknut)`,
    skrati(izvorni.description || '', 1500) || '(bez opisa)',
    '',
    `## Što je izvorno isporučeno`,
    skrati(izvorni.resultSummary || '', 1500) || '(bez sažetka)',
  )
  const provjere = izvuciProvjere(izvorni.description)
  if (provjere.length) dijelovi.push('', '## Provjere (naslijeđene iz izvornog zadatka)', ...provjere)
  return dijelovi.join('\n')
}

/** Nasljeđuje se SAMO `chat:` (dojava ide u isti razgovor); dodaju se `dorada` i `dorada-od:`. */
export function oznakeDorade(izvorneOznake: string[] | undefined, izvorniId: string, dodatne: string[] = []): string[] {
  const out: string[] = []
  const dodaj = (t: string) => { if (t && !out.includes(t)) out.push(t) }
  for (const t of izvorneOznake || []) if (t.startsWith('chat:')) dodaj(t)
  dodaj('dorada')
  dodaj(`dorada-od:${izvorniId}`)
  for (const t of dodatne) dodaj(t)
  return out
}
