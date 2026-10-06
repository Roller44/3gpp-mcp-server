# `docx-extractor`

> Source: `src/api/docx-extractor.ts`

## Module Purpose

`docx-extractor` extracts structured text from 3GPP specification documents so
the rest of the MCP server can index, search, and serve their content. 3GPP
specs are typically distributed as `.zip` archives that wrap a `.docx` (or, for
older releases, a legacy `.doc`) file, so this module is responsible for three
related concerns:

1. **`.zip` → `.docx` extraction** — open the archive, locate the inner Word
   document, and materialize it on disk so downstream extraction can read it.
2. **`.docx` → structured text** — convert the Word document to HTML via
   [`mammoth`](https://www.npmjs.com/package/mammoth), then parse the HTML into
   a flat list of `DocSection` objects, each carrying a heading level and body
   content.
3. **`.doc` (legacy) → `.docx` (best-effort)** — when only a legacy `.doc` is
   available, attempt a headless LibreOffice conversion to `.docx` and then
   reuse the `.docx` path. This path is explicitly best-effort: if LibreOffice
   is not installed the function returns `null` and callers are expected to
   degrade gracefully.

The module's top-level entry point, `extractDocument`, dispatches across these
three formats by file extension and returns a single `ExtractedDocument`
descriptor suitable for indexing.

### Dependencies

- `path`, `fs` — Node built-ins for filesystem path handling and I/O.
- `mammoth` — converts `.docx` to HTML (`mammoth.convertToHtml`).
- `adm-zip` — reads `.zip` archives and extracts individual entries.
- `child_process.execFileSync` — used (lazily, via `require`) to invoke
  LibreOffice headlessly for `.doc` conversion.

### Exports

| Symbol | Kind | Line | Role |
| --- | --- | --- | --- |
| `DocSection` | interface | 16 | Shape of a single extracted section. |
| `ExtractedDocument` | interface | 23 | Shape of the full extraction result returned by `extractDocument`. |
| `extractDocxFromZip` | function | 38 | Extracts the inner `.docx`/`.doc` from a `.zip` archive to disk. |
| `extractFromDocx` | async function | 61 | Parses a `.docx` file into `DocSection[]` via mammoth + an HTML pass. |
| `extractFromDoc` | async function | 122 | Best-effort `.doc` → `.docx` conversion via LibreOffice, then extracts. |
| `extractDocument` | async function | 169 | Main entry point: dispatches by extension and returns `ExtractedDocument`. |

Two module-private helpers — `stripHtml` (line 235) and `mergeUntitledSections`
(line 251) — are not exported; they are documented below in §Internal Helpers
because reviewers need to understand the structured-text pipeline.

---

## `DocSection` (interface, line 16)

Describes one section of an extracted document. The document is modeled as a
flat sequence of these sections rather than a tree; each section records its
own heading level so callers can reconstruct hierarchy if needed.

```ts
export interface DocSection {
  title: string;
  level: number;        // heading level: 1 = top-level, 0 = untitled body text
  content: string;
  position: number;     // sequential position in the document
}
```

### Fields

- **`title: string`** — The heading text for this section. When a section is
  synthesized from body content with no preceding heading, this is set to
  `'(untitled)'` by `extractFromDocx` (line 80). After
  `mergeUntitledSections` runs, untitled sections are folded into the preceding
  titled section, so a returned `DocSection` with `level === 0` typically
  indicates a document that began with body text before any heading.
- **`level: number`** — Heading level. `1` corresponds to a top-level heading
  (`<h1>`), `2` to `<h2>`, and so on through `6`. `0` denotes untitled body
  text that was not preceded by a heading (see comment on line 18). The value
  is derived from the digit in the matched `<h1>`–`<h6>` tag at line 99.
- **`content: string`** — The section body. Built by joining consecutive
  block-level elements (`<p>`, `<li>`, `<td>`, `<th>`) with newlines and
  stripping inner HTML tags/entities via `stripHtml`. For merged sections
  produced by `mergeUntitledSections`, this string concatenates the original
  section's content with the folded-in untitled sections separated by `'\n'`.
- **`position: number`** — Zero-based sequential index of the section within
  the document. Initially assigned during the flush at line 83 and renumbered
  by `mergeUntitledSections` after untitled sections are folded in (line 266).

### Role in the module

`DocSection` is the unit of structured text used by every extraction function.
`extractFromDocx` and `extractFromDoc` return `DocSection[]`, and
`extractDocument` embeds that array into the `ExtractedDocument` it returns.
Because positions and levels are present, callers can both linearly scan the
document and reconstruct its outline.

---

## `ExtractedDocument` (interface, line 23)

The full result of extracting a single 3GPP specification file. It bundles the
input metadata (spec number, version, file path, file size) together with the
parsed `DocSection[]` and a few derived conveniences.

```ts
export interface ExtractedDocument {
  specNumber: string;
  version: string;
  filePath: string;
  fileSize: number;
  sections: DocSection[];
  totalContent: string;
  sectionCount: number;
  extractedAt: string;
}
```

### Fields

- **`specNumber: string`** — Caller-supplied spec identifier (e.g. `"38.843"`).
  Passed through unchanged from `extractDocument`'s argument; this module does
  not validate or parse it.
- **`version: string`** — Caller-supplied version label (e.g. `"Rel-17"`).
  Also passed through unchanged.
- **`filePath: string`** — Path to the *original* input file as given to
  `extractDocument`. This is the `.zip`/`.docx`/`.doc`/plain-text path, not the
  temporary extracted `.docx` (which is deleted in the `finally` block at
  lines 211–216 before this object is constructed).
- **`fileSize: number`** — Size of `filePath` in bytes, from `fs.statSync` at
  line 176.
- **`sections: DocSection[]`** — The parsed sections. Empty if extraction
  yielded nothing. Three cases produce an empty array: an unsupported inner
  format inside a `.zip` (line 199, `sections = []`), or a `.doc` whose
  LibreOffice conversion failed, where the `null` returned by `extractFromDoc`
  is coerced to `[]` — this coercion occurs both on the `.zip`-wrapped `.doc`
  path (line 197) and the direct `.doc` path (line 205).
- **`totalContent: string`** — All section contents joined by `'\n\n'`
  (line 218). Convenience field for full-text indexing.
- **`sectionCount: number`** — `sections.length`, captured at construction
  time (line 226).
- **`extractedAt: string`** — ISO timestamp (`new Date().toISOString()`,
  line 228) recording when extraction completed.

### Role in the module

This is the canonical return type of `extractDocument` and the contract the
rest of the server consumes when indexing a spec. Every field is populated by
`extractDocument` itself; the inner extraction functions only produce the
`sections` array.

---

## `extractDocxFromZip` (function, line 38)

Opens a `.zip` archive, locates the `.docx` entry inside it (falling back to a
`.doc` entry if no `.docx` is present), writes that entry to disk, and returns
the path to the extracted file.

```ts
export function extractDocxFromZip(zipPath: string, extractToDir: string): string | null
```

### Parameters

- **`zipPath: string`** — Path to the source `.zip` archive. The archive is
  opened with `new AdmZip(zipPath)` (line 39) and read with `zip.getEntries()`
  (line 40).
- **`extractToDir: string`** — Directory to write the extracted Word document
  into. The output filename is the basename of the matched archive entry
  (`path.basename(docxEntry.entryName)`, line 51), and the final path is
  `path.join(extractToDir, filename)` (line 52). This directory must already
  exist; the function does not create it.

### Return value

- **`string`** — The absolute/relative path to the extracted `.docx` (or
  `.doc`) file on disk, written via `fs.writeFileSync(outPath, docxEntry.getData())`
  at line 53.
- **`null`** — Returned at line 49 if no non-directory entry with a `.docx` or
  `.doc` extension is found in the archive.

### Behavior notes

- **Entry selection (lines 43–47):** the function first looks for any entry
  whose name ends with `.docx` and is not a directory. If none is found, it
  falls back to entries ending with `.doc`. The module comment on line 42
  mentions a preference for a "clean" version when multiple candidates exist,
  but the implementation uses `Array.prototype.find` and therefore selects the
  *first* matching entry in archive order — there is no explicit "clean"
  heuristic in the code. Reviewers should note this gap between the comment
  and the implementation.
- **No cleanup:** this function only writes the file. Cleanup of the extracted
  temp file is the caller's responsibility; `extractDocument` handles it via
  its `finally` block (line 213).

### Role in the module

This is the first stage of the `.zip` pipeline. `extractDocument` calls it at
line 185, then inspects the returned path's extension (line 192) to decide
whether to invoke `extractFromDocx` (`.docx`) or `extractFromDoc` (`.doc`).

---

## `extractFromDocx` (async function, line 61)

Converts a `.docx` file to HTML via mammoth and parses the HTML into a flat
list of `DocSection` objects, with heading levels derived from `<h1>`–`<h6>`
tags and body content drawn from `<p>`, `<li>`, `<td>`, and `<th>` tags.

```ts
export async function extractFromDocx(docxPath: string): Promise<DocSection[]>
```

### Parameters

- **`docxPath: string`** — Path to the `.docx` file to read. Passed directly to
  `mammoth.convertToHtml({ path: docxPath })` at line 62.

### Return value

- **`Promise<DocSection[]>`** — The parsed sections after untitled sections
  have been merged into the preceding titled section by
  `mergeUntitledSections` (line 114). The array may be empty if the document
  contained no recognizable headings or body text.

### Algorithm

1. **Convert to HTML** (line 62): `mammoth.convertToHtml` returns
   `{ value: html, ... }`; only `result.value` is used (line 63). Mammoth
   messages are ignored.
2. **Stream-extract tags** (lines 73–108): a single global regex,
   `/<(h[1-6]|p|li|td|th)[^>]*>([\s\S]*?)<\/\1>/gi`, walks the HTML. For each
   match:
   - The inner HTML is stripped to plain text via the `stripHtml` helper
     (line 94) and trimmed.
   - If the tag is `h1`–`h6` (line 96): the current in-progress section is
     flushed via the `flushSection` closure (line 76), and a new section is
     started with the heading text as `title` and the heading digit as `level`.
   - Otherwise (line 102): the text is appended to the current section's
     `currentContent` buffer, but only if non-empty (line 104).
3. **Flush trailing section** (line 111): after the loop, any remaining buffered
   content is flushed.
4. **Merge untitled sections** (line 114): the result is passed through
   `mergeUntitledSections` so that body text which appeared before the first
   heading — or between headings without its own heading — is folded into the
   preceding titled section rather than emitted as standalone
   `'(untitled)'` sections.

### Behavior notes

- **`flushSection` (lines 76–87):** a section is only pushed if it has a title
  or non-empty content; the title defaults to `'(untitled)'` when absent
  (line 80). `position` is assigned from a monotonically increasing
  `currentPosition` counter (line 83).
- **Regex limitations:** the parser is a single regex, not a real HTML parser.
  Nested instances of the same tag (e.g. a `<p>` inside a `<p>`, or malformed
  HTML) may confuse the non-greedy `[\s\S]*?` capture. Mammoth's HTML output is
  generally well-formed, so this is usually fine in practice, but reviewers
  should be aware that exotic documents could produce mis-parsed sections.
- **Tables:** `<td>` and `<th>` are treated as body content (line 73). Cell
  structure is flattened — each cell becomes a line of text in the surrounding
  section; row/column layout is not preserved.

### Role in the module

This is the core structured-text extractor and the only function that produces
`DocSection[]` directly. Both `extractFromDoc` (for legacy `.doc`) and
`extractDocument` (for direct `.docx` inputs and `.zip`-wrapped `.docx`)
delegate to it.

---

## `extractFromDoc` (async function, line 122)

Best-effort extraction for legacy `.doc` files: attempts a headless
LibreOffice conversion to `.docx` in a caller-supplied temp directory, then
reuses `extractFromDocx` to parse the result.

```ts
export async function extractFromDoc(docPath: string, tempDir: string): Promise<DocSection[] | null>
```

### Parameters

- **`docPath: string`** — Path to the `.doc` file to convert.
- **`tempDir: string`** — Directory where LibreOffice should write the
  converted `.docx`. The function assumes LibreOffice names its output by
  replacing the `.doc` suffix of the input basename with `.docx`
  (line 154); the expected output path is `path.join(tempDir, docxName)`.

### Return value

- **`Promise<DocSection[] | null>`**
  - On success: the `DocSection[]` returned by `extractFromDocx` for the
    converted file (line 159).
  - **`null`** in three failure modes:
    1. No `soffice` binary is found on the candidate paths (line 143).
    2. The conversion command ran but the expected output `.docx` does not
       exist in `tempDir` (line 157).
    3. The conversion command itself threw (caught at line 160, returns
       `null` at line 161).

### Behavior notes

- **`require('child_process')` (line 123):** `execFileSync` is loaded lazily
  via `require` rather than a top-level `import`. This avoids pulling the
  module into environments that never exercise the `.doc` path, and keeps the
  static-dependency surface of the file smaller.
- **LibreOffice discovery (lines 126–141):** three candidate paths are probed
  by running `soffice --version` with a 5-second timeout and `stdio: 'ignore'`:
  1. Bare `soffice` (relies on `PATH` resolution),
  2. `C:\Program Files\LibreOffice\program\soffice.exe`,
  3. `C:\Program Files (x86)\LibreOffice\program\soffice.exe`.
  The first candidate whose probe exits cleanly is used; the list is
  Windows-centric, which matches the project's stated platform but means
  Linux/macOS deployments rely entirely on `soffice` being on `PATH`.
- **Conversion (lines 147–152):** invokes
  `soffice --headless --convert-to docx --outdir <tempDir> <docPath>` with a
  60-second timeout and silenced stdio. The 60-second cap is generous for most
  specs but very large documents could exceed it; in that case the throw is
  caught at line 160 and `null` is returned.
- **No cleanup of the converted `.docx`:** the function does not delete the
  `.docx` it asked LibreOffice to produce. When called via `extractDocument`,
  the cleanup is handled indirectly: `extractDocument` records the
  *originally extracted* path in `cleanupPath` (line 190), which for a
  `.zip`-wrapped `.doc` is the `.doc` itself — not the LibreOffice-produced
  `.docx`. Reviewers should note that the converted `.docx` from `extractFromDoc`
  is currently leaked in `tempDir` when invoked through the `.zip` path.
  (For the direct `.doc` path at lines 203–205 there is no cleanup of either
  file.)

### Role in the module

This is the legacy fallback for documents too old to be `.docx`. It is the
only function in the module that shells out to an external process, and its
best-effort nature (returns `null` rather than throwing on missing
LibreOffice) is what allows the server to operate on environments where
LibreOffice is not installed. Callers are expected to coerce `null` to an
empty section list, which is exactly what `extractDocument` does at lines 197
and 205.

---

## `extractDocument` (async function, line 169)

The module's main entry point. Dispatches on the input file's extension,
drives the appropriate extraction path, cleans up any temporary file it
created, and assembles the final `ExtractedDocument`.

```ts
export async function extractDocument(
  filePath: string,
  specNumber: string,
  version: string,
  tempDir: string
): Promise<ExtractedDocument>
```

### Parameters

- **`filePath: string`** — Path to the input file. May be `.zip`, `.docx`,
  `.doc`, or any other extension (the latter is treated as plain text; see
  below).
- **`specNumber: string`** — Spec identifier to embed verbatim in the result's
  `specNumber` field.
- **`version: string`** — Version label to embed verbatim in the result's
  `version` field.
- **`tempDir: string`** — Directory used for two purposes:
  1. As the extraction target for `.zip` contents (passed to
     `extractDocxFromZip`, line 185).
  2. As the LibreOffice output directory for `.doc` conversion (passed to
     `extractFromDoc`, lines 196 and 204).

### Return value

- **`Promise<ExtractedDocument>`** — Resolves with the assembled extraction
  result on success. This function has multiple throwing paths that propagate
  to the caller (cleanup in the `finally` block at lines 211–216 still runs
  before any throw escapes):
  1. **Missing input file:** `fs.statSync(filePath)` at line 176 has no
     surrounding try/catch and throws `ENOENT` (or the platform's equivalent)
     for a non-existent `filePath`.
  2. **`.zip`-with-no-Word-document:** when `extractDocxFromZip` returns
     `null`, the function throws
     `Error("No .docx or .doc file found inside <path>")` at line 187.
  3. **Corrupt or unreadable `.zip`:** the `new AdmZip(zipPath)` constructor
     inside `extractDocxFromZip` (line 39) propagates constructor errors for a
     malformed or unreadable archive.
  4. **Corrupt `.docx`:** `mammoth.convertToHtml` (line 62, reached via the
     `.docx` branch at line 194 or 202) can throw on a corrupt or
     unparseable `.docx` file.
  5. **Unreadable plain-text input:** on the fallback path for non-`.zip`/
     `.docx`/`.doc` extensions, `fs.readFileSync(filePath, 'utf-8')` at
     line 208 can throw on read errors.
  These throwing paths are also acknowledged in §Module-Level Behavior and
  Caveats. The function does *not* throw for empty or unsupported *content*
  when the file itself is readable: an unsupported inner format inside a
  `.zip` yields `sections = []` (line 199), and a `.doc` whose LibreOffice
  conversion failed yields `[]` via the `null` coercion at lines 197 and 205.

### Dispatch logic

The extension is taken from `path.extname(filePath).toLowerCase()` at line 175.
`fs.statSync(filePath)` at line 176 captures the file size for the result.

- **`.zip` (lines 183–200):**
  1. Calls `extractDocxFromZip(filePath, tempDir)`. If it returns `null`,
     throws `Error("No .docx or .doc file found inside <filePath>")`
     (line 187).
  2. Records the extracted path in `actualDocPath` and `cleanupPath`
     (lines 189–190) so the temp file is unlinked in `finally`.
  3. Re-checks the *inner* file's extension (line 192) and dispatches:
     - `.docx` → `extractFromDocx` (line 194).
     - `.doc` → `extractFromDoc`; `null` is coerced to `[]` (lines 196–197).
     - anything else → `sections = []` (line 199).

- **`.docx` (line 201–202):** calls `extractFromDocx(filePath)` directly. No
  temp file is created, so `cleanupPath` stays `null`.

- **`.doc` (lines 203–205):** calls `extractFromDoc(filePath, tempDir)` and
  coerces `null` to `[]`.

- **Other extensions (lines 206–209):** treats the file as plain text by
  reading it with `fs.readFileSync(filePath, 'utf-8')` and wrapping the entire
  contents in a single `DocSection` with `title: '(content)'`,
  `level: 0`, `position: 0`. This is a convenience fallback so the server can
  ingest stray `.txt` or similar files without a separate code path.

### Cleanup (lines 211–216)

A `finally` block unlinks `cleanupPath` if it was set and still exists. The
`unlinkSync` failure path is silently swallowed (line 214) so cleanup errors
never mask a real extraction result or a real extraction error.

### Result assembly (lines 218–229)

- `totalContent` is built by joining each section's `content` with `'\n\n'`
  (line 218).
- The returned object literal (lines 220–229) populates every field of
  `ExtractedDocument`:
  - `specNumber`, `version` — from the caller's arguments.
  - `filePath` — the *original* `filePath`, not the extracted temp path.
  - `fileSize` — from `stats.size`.
  - `sections` — the parsed array.
  - `totalContent` — the joined string.
  - `sectionCount` — `sections.length`.
  - `extractedAt` — `new Date().toISOString()`.

### Role in the module

This is the only function callers outside this module are expected to invoke.
It centralizes extension dispatch, temp-file lifecycle, and result shaping,
exposing a single uniform `Promise<ExtractedDocument>` contract regardless of
whether the input was a `.zip`, a `.docx`, a legacy `.doc`, or plain text.

---

## Internal Helpers

These functions are not exported; they support `extractFromDocx`. They are
documented here because reviewers need to understand the structured-text
pipeline.

### `stripHtml` (function, line 235)

```ts
function stripHtml(html: string): string
```

Strips all HTML tags and decodes a small set of common entities, then
normalizes whitespace. Applied to the inner HTML of every matched tag in
`extractFromDocx`.

Operations, in order (lines 236–245):

1. Remove every `<...>` tag: `html.replace(/<[^>]+>/g, '')`.
2. Decode `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, `&nbsp;` to their literal
   characters.
3. Normalize CRLF to LF: `/\r\n/g` → `'\n'`.
4. Collapse three-or-more consecutive newlines to exactly two:
   `/\n{3,}/g` → `'\n\n'`.

Note: the entity set is not exhaustive — numeric character references other
than `&#39;` and named entities outside the listed six are left untouched.
This is generally acceptable because mammoth's output uses a limited entity
vocabulary, but exotic characters could survive as raw entities in the
extracted text.

### `mergeUntitledSections` (function, line 251)

```ts
function mergeUntitledSections(sections: DocSection[]): DocSection[]
```

Folds consecutive untitled sections (`level === 0`) into the preceding titled
section's `content`, then renumbers positions.

- If `sections` is empty, returns it unchanged (line 252).
- Iterates the input; for each section with `level === 0` and a non-empty
  `merged` accumulator, appends `'\n' + section.content` to the last merged
  section's `content` (lines 256–259). Otherwise pushes a shallow copy of the
  section (line 261).
- Re-numbers `position` across the merged result (line 266) so positions are
  contiguous after folding.

The shallow copy on line 261 means the original `DocSection` objects from
`extractFromDocx` are not mutated when their content is later appended to
(lines 258–259 mutates `merged[merged.length - 1].content`, which is the copied
object, not the original). Reviewers verifying referential integrity should
note that the first titled section in `merged` *is* a copy, but the append on
line 259 mutates the copy that was pushed — original input objects are not
touched.

---

## Module-Level Behavior and Caveats

- **No file existence checks up front.** `extractDocument` calls
  `fs.statSync(filePath)` (line 176) without a try/catch; a missing input file
  throws `ENOENT` directly to the caller. `extractDocxFromZip` likewise lets
  `AdmZip` constructor errors propagate (line 39).
- **Temp directory must exist.** Neither `extractDocxFromZip` nor
  `extractFromDoc` creates `tempDir`; callers must ensure it exists.
- **LibreOffice is optional.** The `.doc` path is intentionally best-effort.
  Production deployments that need `.doc` support must install LibreOffice and
  either put `soffice` on `PATH` or place it at one of the two hardcoded
  Windows paths.
- **Single regex HTML parsing.** `extractFromDocx` uses one regex to extract
  headings and body blocks. This is fast and dependency-free but is not a
  conformant HTML parser; malformed or unusually nested HTML could produce
  incorrect sections.
- **Tables are flattened.** `<td>` and `<th>` cells are emitted as plain text
  lines; table structure is not represented in `DocSection`.
- **Cleanup gap for `.doc` conversion.** As noted under `extractFromDoc`, the
  `.docx` produced by LibreOffice is not cleaned up by `extractDocument` —
  only the file extracted from a `.zip` is unlinked. Reviewers tracking
  temp-file hygiene should flag this.
- **The "prefer clean version" comment (line 42) is aspirational.** The
  implementation selects the first matching `.docx` entry in archive order;
  there is no `clean`-vs-`track-changes` heuristic in the code.
