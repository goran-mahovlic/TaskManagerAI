/**
 * VerificationGate — strojni verifikacijski gate (skela za slabe modele)
 *
 * Podzadatak TASK-2569 [F2] P3: prije nego RegocDaemon/AgentDaemon prihvate
 * `completed`, agent MORA u odgovoru citirati blok:
 *
 *   === VERIFIKACIJA ===
 *   naredba: <naredba koju je pokrenuo>
 *   izlaz: <stvarni izlaz te naredbe — neprazan, nije placeholder>
 *   === KRAJ VERIFIKACIJE ===
 *
 * Primarna provjera je REGEX (deterministička, radi bez mreže/modela).
 * Ollama poziv je ISKLJUČIVO advisory — best-effort drugo mišljenje,
 * nikad ne mijenja regex-rezultat i nikad ne blokira gate (fail-OPEN):
 * ako Ollama nije dostupna, padne, ili istekne (≤3s timeout), rezultat
 * regexa ostaje mjerodavan.
 *
 * NAMJERNO samostalan modul — ne dira RegocDaemon.ts ni AgentDaemon.ts;
 * spajanje na vrući put je zaseban korak nadzadatka TASK-2569.
 */

import { ollamaUrl } from './lib/okolina-sustava' // TASK-5700 (K3a)

export interface VerificationResult {
  ok: boolean
  reason: string
  advisory?: string
}

const BLOCK_RE =
  /===\s*VERIFIKACIJA\s*===\s*\n([\s\S]*?)\n?===\s*KRAJ VERIFIKACIJE\s*===/i
const NAREDBA_RE = /^\s*naredba:\s*(.*)$/im
const IZLAZ_RE = /^\s*izlaz:\s*([\s\S]*)$/im

// Placeholderi koje slab model voli ubaciti umjesto stvarnog izlaza.
const PLACEHOLDER_RE =
  /^(<.*>|\[.*\]|todo|tbd|n\/a|na|\.\.\.|-|—|\(.*\))$/i

const MISSING_BLOCK_REASON = 'missing_block'
const MISSING_FIELDS_REASON = 'missing_fields'
const EMPTY_OUTPUT_REASON = 'empty_output'
const PLACEHOLDER_OUTPUT_REASON = 'placeholder_output'

const INSTRUCTION_TEXT =
  'Ne mogu zatvoriti zadatak: nedostaje citirani izlaz verifikacijske naredbe. ' +
  'Ponovi korak i priloži blok u točnom obliku:\n\n' +
  '=== VERIFIKACIJA ===\n' +
  'naredba: <naredba koju si stvarno pokrenuo>\n' +
  'izlaz: <stvarni izlaz te naredbe, ne placeholder>\n' +
  '=== KRAJ VERIFIKACIJE ==='

/**
 * Izvadi sadržaj izlaz: polja iz tijela bloka (sve do sljedećeg poznatog
 * polja ili kraja bloka), da izlaz s više redaka ne pojede naredna polja.
 */
function extractOutput(blockBody: string): string | null {
  const m = blockBody.match(IZLAZ_RE)
  if (!m) return null
  // izlaz: traje do kraja bloka (jednostavan format — jedno polje po retku,
  // ali izlaz smije imati više redaka jer je zadnje polje u bloku).
  return m[1]
}

function isBlankOrPlaceholder(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0) return true
  // Provjeri svaki redak — ako SVI redci pojedinačno izgledaju kao
  // placeholder/prazni, tretiraj kao placeholder. Ako barem jedan redak
  // nosi stvaran sadržaj, izlaz je valjan.
  const lines = trimmed.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  if (lines.length === 0) return true
  return lines.every(l => PLACEHOLDER_RE.test(l))
}

/**
 * Primarna, deterministička provjera. Nikad ne baca, nikad ne zove mrežu.
 */
function checkRegex(text: string): VerificationResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, reason: MISSING_BLOCK_REASON }
  }

  const blockMatch = text.match(BLOCK_RE)
  if (!blockMatch) {
    return { ok: false, reason: MISSING_BLOCK_REASON }
  }

  const body = blockMatch[1]
  const hasNaredba = NAREDBA_RE.test(body)
  const output = extractOutput(body)

  if (!hasNaredba || output === null) {
    return { ok: false, reason: MISSING_FIELDS_REASON }
  }

  if (isBlankOrPlaceholder(output)) {
    const trimmed = output.trim()
    const looksLikePlaceholder =
      trimmed.length > 0 &&
      trimmed.split('\n').map(l => l.trim()).filter(Boolean).every(l => PLACEHOLDER_RE.test(l))
    return {
      ok: false,
      reason: looksLikePlaceholder ? PLACEHOLDER_OUTPUT_REASON : EMPTY_OUTPUT_REASON,
    }
  }

  return { ok: true, reason: 'ok' }
}

function getOllamaBaseUrl(): string {
  return ollamaUrl()  // TASK-5700: OLLAMA_HOST → model-config → memory-config
}

const OLLAMA_TIMEOUT_MS = 3000
const OLLAMA_MODEL = process.env.VERIFICATION_GATE_OLLAMA_MODEL || 'qwen3:8b'

/**
 * Best-effort drugo mišljenje od lokalnog Ollama modela: "izgleda li ovaj
 * blok kao stvaran, konkretan izlaz naredbe?". SAMO advisory tekst —
 * nikad ne utječe na `ok`. Timeout ≤3s; svaki kvar → undefined (tiho).
 */
async function getOllamaAdvisory(text: string, blockOk: boolean): Promise<string | undefined> {
  if (!blockOk) return undefined // nema smisla pitati Ollamu za nešto što regex već odbija

  const blockMatch = text.match(BLOCK_RE)
  if (!blockMatch) return undefined

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS)

  try {
    const response = await fetch(`${getOllamaBaseUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        messages: [
          {
            role: 'system',
            content:
              'Odgovori JEDNOM riječju: "vjerodostojno" ako blok izgleda kao stvaran izlaz ' +
              'naredbe, ili "sumnjivo" ako izgleda izmišljeno/generičko.',
          },
          { role: 'user', content: blockMatch[0] },
        ],
        options: { num_predict: 16, temperature: 0 },
      }),
      signal: controller.signal,
    })

    if (!response.ok) return undefined

    const data = (await response.json()) as { message?: { content?: string } }
    const content = data?.message?.content?.trim()
    return content ? content : undefined
  } catch {
    return undefined // fail-OPEN: Ollama nedostupna/timeout/greška ne mijenja regex-rezultat
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Glavna provjera. Regex je mjerodavan za `ok`; Ollama (ako je dostupna
 * unutar 3s) samo dodaje `advisory` tekst na uvid, nikad ne mijenja `ok`.
 */
export async function checkVerificationBlock(text: string): Promise<VerificationResult> {
  const regexResult = checkRegex(text)

  let advisory: string | undefined
  try {
    advisory = await getOllamaAdvisory(text, regexResult.ok)
  } catch {
    advisory = undefined // dodatna sigurnosna mreža — fail-OPEN i ovdje
  }

  return advisory === undefined
    ? regexResult
    : { ...regexResult, advisory }
}

/**
 * Gotov tekst upute koji se vraća agentu kad ok=false.
 */
export function buildRejectionInstruction(_result: VerificationResult): string {
  return INSTRUCTION_TEXT
}
