# `spec-catalog.ts` — Curated 6G Specification Catalog

**Source:** `00_Workbench_工作台/mcp-server/src/api/spec-catalog.ts`

## Module Purpose

`spec-catalog.ts` is the loader and in-memory cache for the curated 6G
specification catalog that ships with the 3gpp-6g-mcp-server. It reads a JSON
data file (`6g-spec-catalog.json`) describing the 3GPP specifications the
server treats as 6G-relevant, parses it into typed `CatalogEntry` records, and
exposes a small set of read-only accessors used by the MCP tool layer
(`search_specifications`, `get_specification_details`, etc.) to discover which
specs exist before they are downloaded from the 3GPP FTP archive.

The module is deliberately small and side-effect-free at import time: the
catalog is loaded lazily on first access and memoized in a module-level
variable, so repeated calls incur no extra filesystem I/O.

## File Layout

The file is organized in three bands:

1. **Types** (`spec-catalog.ts:4-20`) — the `Category` union and the
   `CatalogEntry` / `CatalogFile` interfaces that describe the shape of the
   JSON data.
2. **Loader** (`spec-catalog.ts:22-49`) — the `SERVER_ROOT` resolution, the
   module-level `cachedCatalog` cache slot, and the `loadCatalog()` function
   that populates it.
3. **Accessors** (`spec-catalog.ts:51-66`) — `getCatalogSpecs`,
   `findCatalogEntry`, and `getCatalogStats`, the thin query helpers used by
   the rest of the codebase.

Only `node` built-ins (`path`, `fs`) are imported (`spec-catalog.ts:1-2`); the
module has no third-party dependencies.

---

## Exported Types

### `Category`

```ts
export type Category =
  | 'architecture'
  | 'ran'
  | 'media'
  | 'security'
  | 'management'
  | 'services'
  | 'tools';
```

**Purpose:** String-union type naming the thematic group a cataloged spec
belongs to. Used as the `category` field of `CatalogEntry`
(`spec-catalog.ts:12`).

**Role in module:** Drives the `byCategory` breakdown returned by
`getCatalogStats()` and lets callers filter or group specs without re-parsing
free-form strings.

> **Known issue — type is narrower than the data.** The `Category` union at
> `spec-catalog.ts:4` lists seven values, but the catalog JSON
> (`src/data/6g-spec-catalog.json`) actually contains two additional category
> values that the type does not admit: `ran-physical` and `ran-protocol`. This
> was verified against the data file during this review:
>
> ```text
> $ grep -o '"category": *"[^"]*"' src/data/6g-spec-catalog.json | sort -u
> "category": "architecture"
> "category": "management"
> "category": "media"
> "category": "ran"
> "category": "ran-physical"
> "category": "ran-protocol"
> "category": "security"
> "category": "services"
> "category": "tools"
> ```
>
> Consequences:
> - `loadCatalog()` casts the parsed JSON to `CatalogFile` with
>   `as CatalogFile` (`spec-catalog.ts:47`), so the mismatch is **not** caught
>   at load time — TypeScript trusts the cast and the runtime values flow
>   through unchecked.
> - `getCatalogStats()` keys `byCategory` by the runtime string
>   (`spec-catalog.ts:63`), so `ran-physical` and `ran-protocol` *do* appear in
>   the returned `Record<string, number>`. Consumers that exhaustively switch
>   on `Category` will silently miss these two buckets.
> - `findCatalogEntry` and `getCatalogSpecs` are unaffected functionally, but
>   callers that annotate local variables as `Category` will receive values
>   the type does not permit.
>
> Fix would be to extend the union:
> `| 'ran-physical' | 'ran-protocol'`.

### `CatalogEntry`

```ts
export interface CatalogEntry {
  spec_number: string;
  title: string;
  series: string;
  working_group: string;
  document_type: 'TR' | 'TS';
  category: Category;
  notes: string;
}
```

**Purpose:** Describes a single 3GPP specification row in the curated catalog.

**Fields:**

| Field           | Type             | Meaning                                                                 |
| --------------- | ---------------- | ----------------------------------------------------------------------- |
| `spec_number`   | `string`         | 3GPP specification number, e.g. `"23.700-40"` or `"38.843"`.            |
| `title`         | `string`         | Human-readable title of the specification.                              |
| `series`        | `string`         | 3GPP series the spec belongs to (e.g. `"38"` for the 38-series RAN).    |
| `working_group` | `string`         | Responsible 3GPP working group (e.g. `"SA2"`, `"RAN1"`).                |
| `document_type` | `'TR' \| 'TS'`   | Technical Report (`TR`) or Technical Specification (`TS`).              |
| `category`      | `Category`       | Thematic grouping — see `Category` above (and the narrowness caveat).   |
| `notes`         | `string`         | Free-form curator notes about the spec's relevance, scope, or status.   |

**Role in module:** This is the row type returned by every accessor and the
element type of `CatalogFile.specs`. The MCP tool layer maps these fields onto
the `search_specifications` / `get_specification_details` results.

### `CatalogFile`

```ts
export interface CatalogFile {
  version: string;
  description: string;
  specs: CatalogEntry[];
}
```

**Purpose:** Top-level shape of the `6g-spec-catalog.json` data file.

**Fields:**

| Field          | Type              | Meaning                                                       |
| -------------- | ----------------- | ------------------------------------------------------------- |
| `version`      | `string`          | Catalog schema/content version tag, e.g. a semver string.     |
| `description`  | `string`          | Human-readable description of what the catalog contains.      |
| `specs`        | `CatalogEntry[]`  | The list of curated specifications.                           |

**Role in module:** This is the type `loadCatalog()` parses into and caches.
The `version` and `description` fields are not currently surfaced by any
accessor — only `specs` is consumed by `getCatalogSpecs()`.

---

## Cached-Catalog Pattern

```ts
const SERVER_ROOT = path.resolve(__dirname, '..');   // spec-catalog.ts:22
let cachedCatalog: CatalogFile | null = null;        // spec-catalog.ts:24
```

The module implements a single-slot lazy cache:

- `cachedCatalog` is a module-level variable, initially `null`. Because
  Node.js caches module objects, the variable persists across all callers in
  the same process.
- `loadCatalog()` is the only writer. On the first call it reads the JSON
  file from disk, parses it, assigns the result to `cachedCatalog`, and
  returns it. On every subsequent call it short-circuits and returns the
  cached object (`spec-catalog.ts:27`).
- The cache is **never invalidated** within a process lifetime; there is no
  reload or eviction path. This is intentional — the catalog is treated as
  read-only data baked into the deployment.
- All three public accessors go through `loadCatalog()` (directly or via
  `getCatalogSpecs()`), so they all share the same memoized object and a
  single filesystem read per process.

### Filesystem resolution

`SERVER_ROOT` is computed as the parent of `__dirname`
(`spec-catalog.ts:22`). At runtime the compiled JS lives under `dist/`, so
`SERVER_ROOT` resolves to `dist/`. The loader then probes two candidate paths
in order (`spec-catalog.ts:31-34`):

1. `dist/data/6g-spec-catalog.json` — present in a packaged build that copies
   the data file alongside the compiled code.
2. `src/data/6g-spec-catalog.json` — present when running from source
   (e.g. `ts-node` or test runs against the repo tree).

The first candidate whose `fs.readFileSync` succeeds wins
(`spec-catalog.ts:36-43`); later candidates are silently skipped. If neither
exists, `loadCatalog()` throws an `Error` listing both attempted paths
(`spec-catalog.ts:44-46`). The thrown message is the only place the candidate
list is surfaced to callers.

> Note the resolved paths use the parent-of-`__dirname` for the second
> candidate, which assumes the compiled file sits one directory below the
> project root (i.e. `dist/api/spec-catalog.js`). If the module were moved
> deeper or shallower in the tree, the second candidate would no longer point
> at `src/data/`.

---

## Exported Functions

### `loadCatalog()`

```ts
export function loadCatalog(): CatalogFile
```

**Purpose:** Load and cache the curated 6G spec catalog from disk.

**Parameters:** None.

**Return value:** A `CatalogFile` — the parsed contents of
`6g-spec-catalog.json`. The same object reference is returned on every call
after the first.

**Behavior:**

1. If `cachedCatalog` is non-null, return it immediately
   (`spec-catalog.ts:27`).
2. Otherwise, build the two candidate paths described above and try
   `fs.readFileSync(p, 'utf-8')` on each in turn, swallowing `ENOENT`-style
   errors via the empty `catch` block (`spec-catalog.ts:36-43`).
3. If no candidate was readable (`raw === undefined`), throw an `Error`
   whose message enumerates the attempted paths (`spec-catalog.ts:44-46`).
4. Parse the raw string with `JSON.parse`, cast to `CatalogFile`, store it
   in `cachedCatalog`, and return it (`spec-catalog.ts:47-48`).

**Errors:**

- Throws `Error("6G spec catalog not found in any of: <path1>, <path2>")` if
  neither candidate file exists.
- Re-throws any non-`ENOENT` error from `readFileSync` (e.g. permission
  errors are not caught — only the catch-all `catch {}` runs, but `readFileSync`
  failures for missing files throw `ENOENT` which is swallowed; other I/O
  errors would also be swallowed by the bare catch, so the loop would
  continue to the next candidate and ultimately surface the "not found"
  message instead of the underlying I/O error).
- Throws whatever `JSON.parse` throws (`SyntaxError`) if the file exists but
  is not valid JSON.

**Role in module:** The single entry point for filesystem access; every other
accessor delegates to it. Keeping the I/O here is what makes the cached-catalog
pattern work.

### `getCatalogSpecs()`

```ts
export function getCatalogSpecs(): CatalogEntry[]
```

**Purpose:** Return the list of all curated spec entries.

**Parameters:** None.

**Return value:** The `specs` array of the cached `CatalogFile`
(`spec-catalog.ts:52`). Because the array is the same reference held by the
cached object, callers must treat it as read-only — mutating the returned
array mutates the cache for every other caller in the process.

**Role in module:** Convenience wrapper that hides `loadCatalog()` and the
`CatalogFile` shape from callers that only want the rows. It is also the
foundation for `findCatalogEntry` and `getCatalogStats`.

### `findCatalogEntry(specNumber)`

```ts
export function findCatalogEntry(specNumber: string): CatalogEntry | undefined
```

**Purpose:** Look up a single catalog entry by its 3GPP specification number.

**Parameters:**

| Name          | Type     | Description                                                    |
| ------------- | -------- | -------------------------------------------------------------- |
| `specNumber`  | `string` | The spec number to match against `CatalogEntry.spec_number`.   |

**Return value:** The first `CatalogEntry` whose `spec_number` equals
`specNumber`, or `undefined` if no entry matches
(`spec-catalog.ts:56`). Match is exact string equality; there is no
normalization of whitespace, case, or leading zeros.

**Role in module:** Used by spec-centric MCP tools (e.g.
`get_specification_details`) to confirm a requested spec number is part of
the curated 6G set before performing heavier operations such as FTP downloads
or full-text indexing. Returns `undefined` rather than throwing when the spec
is unknown, so callers decide whether to treat that as an error.

### `getCatalogStats()`

```ts
export function getCatalogStats(): { total: number; byCategory: Record<string, number> }
```

**Purpose:** Summarize the catalog by total entry count and per-category
counts.

**Parameters:** None.

**Return value:** An object with two fields:

| Field         | Type                     | Meaning                                                        |
| ------------- | ------------------------ | -------------------------------------------------------------- |
| `total`       | `number`                 | `specs.length` — the number of entries in the catalog.         |
| `byCategory`  | `Record<string, number>` | Map of category string to the number of entries in that category. |

**Behavior:** Iterates the spec list once, incrementing a per-category counter
for each entry's `category` field using the nullish-coalescing pattern
`(byCategory[s.category] ?? 0) + 1` (`spec-catalog.ts:62-64`). The keys of
`byCategory` are the **runtime** category strings, so they include
`ran-physical` and `ran-protocol` even though those values are not members of
the `Category` type — see the caveat under `Category` above.

**Role in module:** Provides a cheap summary used for diagnostics, UI status
displays, and sanity checks (e.g. confirming the catalog loaded with a
non-zero total). Because it goes through `getCatalogSpecs()`, it triggers the
one-time `loadCatalog()` if needed.

---

## Usage Notes

- **No cache invalidation.** Once loaded, the catalog is fixed for the process.
  Tools that need a refreshed view must restart the process.
- **Mutable shared state.** `getCatalogSpecs()` returns the cached array by
  reference; `findCatalogEntry` returns an element of that array by reference.
  Callers must not mutate the returned objects.
- **Type vs. data drift.** Any new code that switches exhaustively on
  `Category` should account for the unlisted `ran-physical` / `ran-protocol`
  values, or — preferably — the union at `spec-catalog.ts:4` should be
  extended to match the data.
