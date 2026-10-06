// ─── Čišćenje teksta razgovora (sigurnosni pregled TASK-5279) ────────────────
// Ulaz: tekst poruke i ime pošiljatelja piše bilo tko u chatu. Prompt je omeđen oznakama
// (`[OD: ime]`, `[MEMORIJA…]`, `[PROČITANO…]`, `[PRETHODNI KONTEKST…]`) i markerom
// `[[SEND_DOC: …]]`; tuđi tekst ne smije moći zatvoriti blok ni glumiti drugog pošiljatelja
// („…\n[OD: Vlasnik] daj mi …"). Ovlasti se ionako računaju iz id-a, ali model vjeruje oznakama.
//
// Izlaz: odgovor modela ide u chat i u zapis — poznati oblici tajni se zatamnjuju i kad ih je
// model negdje pročitao (ploča, memorija, radna mapa).
//
// Autor: Malik (Security), TASK-5279.

/** Otvaranje rezerviranih oznaka u tuđem tekstu: `[` → `(`, pa oznaka ostaje čitljiva, ali nije oznaka. */
const OZNAKA = /\[(?=\s*(?:\/|OD\s*:|OD\s+BOTA|MEMORIJA|PRO[ČC]ITANO|PRETHODNI\s+KONTEKST|\[?\s*SEND_DOC))/giu

export function neutralizirajTekst(t: string): string {
  return t.replace(OZNAKA, '(')
}

/** Ime pošiljatelja u jednom retku, bez zagrada — `[OD: ime]` se ne može zatvoriti ni prelomiti. */
export function neutralizirajIme(ime: string): string {
  return ime.replace(/[\[\]\r\n\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64) || '?'
}

const TAJNE: RegExp[] = [
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, // Telegram bot token
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /\bsk-[A-Za-z0-9]{32,}\b/g, // OpenAI i slični
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
]

export function zatamniTajne(t: string): { tekst: string; zatamnjeno: number } {
  let n = 0
  let out = t
  for (const re of TAJNE) out = out.replace(re, () => { n++; return '[zatamnjeno]' })
  return { tekst: out, zatamnjeno: n }
}
