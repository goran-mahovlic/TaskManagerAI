// ─── TrivialResponder (P1-lite / TASK-2559) ──────────────────────────
// Uski, konzervativni filtar za STVARNO trivijalne poruke (pozdrav, hvala,
// potvrda, ping, status) + gotovi template odgovori — bez `claude --print`.
//
// ZAŠTO POSTOJI (a ne samo `ModeClassifier.effort === 'E1'`):
//   ModeClassifier E1 pravilo je `!actionVerb && (E1keyword || duljina < 50)`,
//   što je preširoko za GATING. Shadow log (07-21) je pokazao da
//   „trebam vizual REGOČ-a" (21 zn., nijedan glagol iz E2 liste) ispada E1 —
//   pod live gateom bi dobio template umjesto delegacije Giti. To je regresija.
//   Zato je live uvjet: `effort === 'E1'` **I** `classifyTrivial() !== null`.
//
// FILOZOFIJA: false-negative (trivijalna poruka ode starim putem) je besplatan,
// false-positive (pravi zahtjev dobije template) je regresija → sve je anchored
// (^...$) na normalizirani tekst, uz tvrde blokatore (kod, URL, [[AGENT:]], TASK-,
// znamenke, više redaka). Kad nismo sigurni → NIJE trivijalno.
//
// Autor: Jelena (Engineer) · Verzija 1.0.0

export type TrivialKind = 'greeting' | 'thanks' | 'ack' | 'ping' | 'status'

export interface TrivialMatch {
  kind: TrivialKind
  /** Normalizirani oblik na kojem je pravilo matchalo (za log/audit). */
  normalized: string
}

/** Iznad ovoga poruka sigurno nije „bok" — čuva nas od dugih zahtjeva. */
const MAX_RAW_CHARS = 60
const MAX_WORDS = 5

/**
 * Tvrdi blokatori — ako se ijedan pojavi, poruka NIKAD nije trivijalna.
 * Namjerno strogo: znamenke (TASK-2559, „23 pravila", portovi), kod/putanje,
 * URL-ovi, dispatch markeri i višeredne poruke uvijek idu starim putem.
 */
const HARD_BLOCKERS: RegExp[] = [
  /\n/,                       // višeredna poruka = nikad pozdrav
  /\[\[/,                     // [[AGENT:...]] dispatch marker
  /task-\d+|prj-\d+/i,        // referenca na task/projekt
  /https?:\/\//i,             // URL
  /[`{}()<>\\|]/,             // kod / shell / template
  /\//,                       // putanja ili URL fragment
  /@/,                        // mention / e-mail
  /\d/,                       // bilo koja znamenka
]

/** Sufiksi dopušteni uz pozdrav („bok regoč", „hvala ekipa"). */
const VOCATIVE = '(?: (?:regoc|regoč|ekipa|ljudi|svima|majstore|ti))?'

const PATTERNS: Array<{ kind: TrivialKind; re: RegExp }> = [
  {
    kind: 'greeting',
    re: new RegExp(`^(?:bok|hej|ej|cao|ćao|caos|pozdrav|zdravo|dobar dan|dobro jutro|dobra večer|dobra vecer|hello|hi|hey|yo)${VOCATIVE}$`),
  },
  {
    kind: 'thanks',
    re: new RegExp(`^(?:hvala|hvala ti|hvala lijepa|hvala puno|puno hvala|fala|thanks|thank you|thx|tnx)${VOCATIVE}$`),
  },
  {
    kind: 'ack',
    re: /^(?:ok|oke|okej|okay|u redu|dobro|može|moze|super|odlično|odlicno|savršeno|savrseno|ack|roger|primljeno|razumijem|jasno|važi|vazi|nema problema|da|ne|nema veze|bravo)$/,
  },
  {
    kind: 'ping',
    re: /^(?:ping|pong|test|jesi tu|jesi li tu|si tu|jesi živ|jesi ziv|jesi li živ|jesi li ziv|are you there|you there|still there)$/,
  },
  {
    kind: 'status',
    re: /^(?:status|kako si|kako ide|kako smo|kak si|how are you|sve ok|sve u redu|što ima|sto ima)$/,
  },
]

/**
 * Normalizacija: mala slova, makni emoji/interpunkciju (osim hrvatskih slova),
 * skupi razmake. Dijakritika se NE skida — obrasci pokrivaju oba oblika
 * („odlično"/„odlicno") jer korisnici pišu i bez kvačica.
 */
export function normalizeTrivial(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')   // interpunkcija, emoji, ? ! . , → razmak
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Vrati TrivialMatch samo za nedvojbeno trivijalne poruke, inače null.
 * Čista funkcija — bez I/O, bez mreže (sigurna za sinkroni poziv u hot pathu).
 */
export function classifyTrivial(content: string): TrivialMatch | null {
  if (!content) return null
  const raw = content.trim()
  if (raw.length === 0 || raw.length > MAX_RAW_CHARS) return null
  if (HARD_BLOCKERS.some(re => re.test(raw))) return null

  const normalized = normalizeTrivial(raw)

  // Poruka od samih emojija/interpunkcije („👍", „✅") → potvrda.
  if (normalized.length === 0) return { kind: 'ack', normalized: '' }

  if (normalized.split(' ').length > MAX_WORDS) return null

  for (const { kind, re } of PATTERNS) {
    if (re.test(normalized)) return { kind, normalized }
  }
  return null
}

/**
 * Template odgovor za trivijalnu poruku.
 * `null` → pozivatelj neka koristi postojeći generateSystemResponse
 * (kind 'status' već ima bogat, točan odgovor o daemonu — ne dupliramo ga).
 */
export function trivialResponse(match: TrivialMatch): string | null {
  switch (match.kind) {
    case 'greeting':
      return '👋 Bok! REGOČ ovdje — spreman. Reci što treba (zadatak, „status daemona" ili „lista agenata").'
    case 'thanks':
      return '🙂 Nema na čemu. Tu sam kad zatreba.'
    case 'ack':
      return '👍 Primljeno.'
    case 'ping':
      return '🟢 Tu sam — REGOČ radi. Za detalje: „status daemona".'
    case 'status':
      return null   // generateSystemResponse pokriva status/uptime točnije
  }
}
