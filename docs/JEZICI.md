# Interface languages

The board ships with **English** and **Croatian**. Adding another language needs no code — one
JSON file is enough.

## What is translated, and what is not

Only the **interface**: tabs, column headings, statistic labels, buttons, form fields,
placeholders and tooltips — 157 strings in total.

Task titles, descriptions, progress notes, project names and agent names are **never**
translated. They are your data, not interface, and translating them would corrupt what the
agents wrote.

## Choosing a language

| Where | How | Applies to |
|---|---|---|
| Header selector | pick from the drop-down | just you; remembered in the browser |
| `TM_LANG` | `TM_LANG=en bun run start` | everyone, until they choose otherwise |
| `config/jezik.json` | `{"zadani":"en"}` | same, but survives without an env variable |

`TM_LANG` wins over `config/jezik.json`; a choice made in the browser wins over both. If the
stored choice names a language that no longer exists in `locales/`, the default is used.

## Adding a language

```bash
cp locales/en.json locales/de.json
$EDITOR locales/de.json          # translate the VALUES; never touch the keys
bun run start                    # the language appears in the selector
```

The key stays the same in every file — only the value changes:

```json
{
  "pending": "Ausstehend",
  "blocked": "Blockiert",
  "completed": "Abgeschlossen"
}
```

**A partial translation is fine.** English is the fallback layer: any key you leave out is
served from `en.json`, so a file with three translated keys works — the rest simply stays in
English. That is what makes it practical to translate a language gradually.

To have the new language shown to everyone by default:

```bash
echo '{"zadani":"de"}' > config/jezik.json
```

### Naming

A language whose code is not in the built-in list (`hr`, `en`, `de`, `it`, `fr`, `es`, `sl`,
`sr`) shows up in the selector as its uppercase code, e.g. `PT`. Adding the display name is a
one-line change in `IMENA_JEZIKA` in `src/TaskWebUI.ts`.

The file name must be a two-letter code, optionally with a region: `de.json`, `pt-br.json`.
Anything else is rejected — the path is built from user input, so it is validated.

## How it works

The server reads the `locales/` folder at request time and returns the list at
`GET /api/jezici`; a single dictionary comes from `GET /api/jezik/<code>`, already merged over
the English base. In the page, every translatable element carries `data-i18n="<key>"` (or
`data-i18n-placeholder` / `data-i18n-title`), and only those elements are ever touched.

That last point is the safety property: an element without the attribute cannot be translated
by accident, which is why task content — rendered without those attributes — is untouchable
by design.
