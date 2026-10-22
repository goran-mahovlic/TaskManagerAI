/**
 * Radnik kuke SecurityValidator za branu brisanja (ADR-0020 §5.2, TASK-5403 — Malik H1/H2).
 *
 * Brana se sudi u ZASEBNOJ niti, a modul se učitava DINAMIČKI ovdje, ne statičkim uvozom u kuci:
 *  - H2: kvar u modulu brane (sintaksna greška, nedostaje bun:sqlite) ne ruši cijelu kuku (zaštitu tajni,
 *    katastrofalne naredbe) — kuka dobije poruku o grešci i sama odluči (fail-closed za naredbe koje brišu);
 *  - H1: kuka ima vlastiti rok — sinkronu presudu koja visi prekida `terminate()` i blokira, umjesto da
 *    istekne harnessov rok od 15 s (istek tamo = naredba prolazi).
 * Poruka: { modul, command, cwd } → { ok: true, brana } | { ok: false, greska }
 */
declare const self: Worker

self.onmessage = async (e: MessageEvent<{ modul: string; command: string; cwd: string }>) => {
  const { modul, command, cwd } = e.data
  try {
    const m = await import(modul)
    if (typeof m.presudaNaredbe !== 'function') throw new Error('modul brane nema presudaNaredbe')
    postMessage({ ok: true, brana: m.presudaNaredbe(command, cwd) })
  } catch (err) {
    postMessage({ ok: false, greska: (err as Error)?.message ?? String(err) })
  }
}
