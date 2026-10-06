# 6G Specification Catalog Reference

> **Source file:** `00_Workbench_工作台/mcp-server/src/data/6g-spec-catalog.json`
> **Companion TypeScript module:** `00_Workbench_工作台/mcp-server/src/api/spec-catalog.ts`

This document is a reference for the `6g-spec-catalog.json` data file — the curated catalog of 3GPP specifications relevant to 6G standardization that backs the MCP server's catalog tooling. It describes the JSON shape (`CatalogFile` / `CatalogEntry`), the catalog's verified size and category coverage, and every exported symbol in the `spec-catalog.ts` module that consumes the file. It is written for code reviewers and maintainers.

---

## 1. File overview

`6g-spec-catalog.json` is a static, hand-curated JSON file that lists 3GPP specifications the MCP server treats as in-scope for 6G standardization. The file's top-level `description` field (line 3) states:

> "Curated catalog of 3GPP specifications relevant to 6G standardization. Users can extend this by adding entries."

The catalog is the single source of truth for which spec numbers the server knows about before it reaches out to the 3GPP FTP archive. It is loaded at runtime by `spec-catalog.ts:loadCatalog()` (see §3) and feeds the catalog lookup, search, and statistics helpers used by the MCP tools.

The file has a simple two-level shape:

```json
{
  "version": "1.0.0",
  "description": "Curated catalog of 3GPP specifications relevant to 6G standardization. Users can extend this by adding entries.",
  "specs": [ { ...CatalogEntry }, ... ]
}
```

---

## 2. Data shapes

### 2.1 `CatalogFile` (top-level object)

The top-level JSON object. Defined in TypeScript at `spec-catalog.ts:16-20`.

| Field         | Type             | Purpose                                                                 |
| ------------- | ---------------- | ----------------------------------------------------------------------- |
| `version`     | `string`         | Catalog schema/content version. Current value: `"1.0.0"` (line 2).      |
| `description` | `string`         | Human-readable summary of what the catalog is (line 3).                 |
| `specs`       | `CatalogEntry[]` | Ordered list of 3GPP specification entries (lines 4–266).               |

### 2.2 `CatalogEntry` (element of `specs`)

One row per 3GPP specification. Defined in TypeScript at `spec-catalog.ts:6-14`. Each entry in the JSON has exactly these seven fields, in this order:

| Field           | Type                | Purpose                                                                                       |
| --------------- | ------------------- | --------------------------------------------------------------------------------------------- |
| `spec_number`   | `string`            | 3GPP specification number, e.g. `"23.700-40"`, `"38.211"`. Used as the lookup key.            |
| `title`         | `string`            | Official 3GPP title of the specification.                                                     |
| `series`        | `string`            | 3GPP series prefix, e.g. `"23"`, `"38"`, `"33"`.                                              |
| `working_group` | `string`            | Responsible 3GPP working group, e.g. `"SA2"`, `"RAN1"`, `"SA5"`.                              |
| `document_type` | `"TR" \| "TS"`      | Report (`TR`) vs. Technical Specification (`TS`).                                             |
| `category`      | `Category` (string) | Curated topic bucket. See §4 for the full set of values and a type/data mismatch warning.     |
| `notes`         | `string`            | Free-text maintainer note — typically the study-item code name or a brief relevance comment.  |

---

## 3. Exported symbols (`spec-catalog.ts`)

The TypeScript module `src/api/spec-catalog.ts` is the programmatic surface over the JSON file. It exports the following symbols.

### 3.1 `type Category`

**Definition site:** `spec-catalog.ts:4`

```ts
export type Category = 'architecture' | 'ran' | 'media' | 'security' | 'management' | 'services' | 'tools';
```

**Purpose:** The declared union of category string literals accepted by the typed `CatalogEntry.category` field.

**Members (7):** `architecture`, `ran`, `media`, `security`, `management`, `services`, `tools`.

> ⚠️ **Type/data mismatch — a maintainer should resolve this.**
> The JSON file actually contains **9** distinct `category` values (verified by `grep -o '"category": *"[^"]*"' 6g-spec-catalog.json | sort -u`, see §4). The two additional values present in the data but **missing** from the `Category` union are:
> - `ran-physical` — used by 5 entries: `38.211`, `38.212`, `38.213`, `38.214`, `38.215` (RAN1 physical-layer TSes, lines 60–103).
> - `ran-protocol` — used by 3 entries: `38.300`, `38.321`, `38.331` (RAN2 protocol TSes, lines 104–130).
>
> Consequences:
> - `loadCatalog()` casts the parsed JSON to `CatalogFile` via `as CatalogFile` (`spec-catalog.ts:47`), so the discrepancy is **not caught at load time** — TypeScript trusts the cast and the JSON values flow through unchecked at runtime.
> - `getCatalogStats()` (`spec-catalog.ts:59-66`) correctly counts entries per category because it uses a `Record<string, number>` keyed by the runtime string, so `ran-physical` and `ran-protocol` show up in `byCategory` even though they are not in the `Category` union.
> - Any code that narrows on `Category` (e.g. an exhaustive `switch`) will have an unhandled case for these two categories.
>
> **Recommended fix:** extend the union at `spec-catalog.ts:4` to:
> ```ts
> export type Category = 'architecture' | 'ran' | 'ran-physical' | 'ran-protocol' | 'media' | 'security' | 'management' | 'services' | 'tools';
> ```

### 3.2 `interface CatalogEntry`

**Definition site:** `spec-catalog.ts:6-14`

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

**Purpose:** Typed shape of a single entry in `specs`. Mirrors the JSON object described in §2.2. The `document_type` field is narrowed to the literal union `'TR' | 'TS'`; `category` is typed as the `Category` union from §3.1 (with the caveat above).

### 3.3 `interface CatalogFile`

**Definition site:** `spec-catalog.ts:16-20`

```ts
export interface CatalogFile {
  version: string;
  description: string;
  specs: CatalogEntry[];
}
```

**Purpose:** Typed shape of the entire JSON file. `loadCatalog()` asserts the parsed JSON conforms to this interface (see §3.4).

### 3.4 `function loadCatalog(): CatalogFile`

**Definition site:** `spec-catalog.ts:26-49`

**Purpose:** Loads, parses, and caches the catalog JSON. This is the single entry point that materializes the file into a typed `CatalogFile`; every other exported helper goes through it (directly or via `getCatalogSpecs`).

**Signature:** `loadCatalog(): CatalogFile`

**Parameters:** none.

**Return value:** A `CatalogFile` (the parsed contents of `6g-spec-catalog.json`).

**Behavior:**
1. Returns the cached `cachedCatalog` if already loaded (`spec-catalog.ts:27`).
2. Otherwise resolves two candidate file paths (`spec-catalog.ts:31-34`):
   - `<SERVER_ROOT>/data/6g-spec-catalog.json` — the packaged-build location, where `SERVER_ROOT = path.resolve(__dirname, '..')` (`spec-catalog.ts:22`) is `dist/` at runtime.
   - `<SERVER_ROOT>/../src/data/6g-spec-catalog.json` — the source-tree location, used when running from source.
3. Reads the first candidate that exists; silently moves to the next on `readFileSync` failure (`spec-catalog.ts:36-43`).
4. If neither candidate is readable, throws `Error("6G spec catalog not found in any of: <candidate1>, <candidate2>")` (`spec-catalog.ts:44-46`).
5. Parses the raw text with `JSON.parse` and casts to `CatalogFile` via `as CatalogFile` (`spec-catalog.ts:47`), then caches and returns it.

**Caching:** The module-level `let cachedCatalog: CatalogFile | null = null` (`spec-catalog.ts:24`) is populated on first call and reused for the process lifetime; there is no invalidation path. Callers that edit the JSON on disk must restart the process (or mutate `cachedCatalog` out of band) to see changes.

**Type-safety note:** The `as CatalogFile` cast at line 47 is unsound with respect to the `Category` union — see the warning in §3.1.

### 3.5 `function getCatalogSpecs(): CatalogEntry[]`

**Definition site:** `spec-catalog.ts:51-53`

**Signature:** `getCatalogSpecs(): CatalogEntry[]`

**Parameters:** none.

**Return value:** The `specs` array from `loadCatalog()` (i.e. all 29 entries in load order).

**Purpose:** Convenience accessor for code that only needs the entry list and not the wrapper object. Internally delegates to `loadCatalog()`, so it triggers the same load/cache behavior on first call.

### 3.6 `function findCatalogEntry(specNumber: string): CatalogEntry | undefined`

**Definition site:** `spec-catalog.ts:55-57`

**Signature:** `findCatalogEntry(specNumber: string): CatalogEntry | undefined`

**Parameters:**
- `specNumber: string` — the 3GPP spec number to look up, e.g. `"38.211"`. Matched verbatim against `CatalogEntry.spec_number`; the function does no normalization, so leading zeros, dashes, and case must match the JSON exactly.

**Return value:** The first `CatalogEntry` whose `spec_number` equals `specNumber`, or `undefined` if no entry matches.

**Purpose:** Single-spec lookup. Used by the MCP server to fetch catalog metadata for a spec number before going to the FTP archive. The underlying `Array.prototype.find` (`spec-catalog.ts:56`) returns the first match; the catalog currently has no duplicate spec numbers, so this is unambiguous.

### 3.7 `function getCatalogStats(): { total: number; byCategory: Record<string, number> }`

**Definition site:** `spec-catalog.ts:59-66`

**Signature:** `getCatalogStats(): { total: number; byCategory: Record<string, number> }`

**Parameters:** none.

**Return value:** An object with:
- `total: number` — the count of catalog entries (currently `29`; equals `getCatalogSpecs().length`).
- `byCategory: Record<string, number>` — mapping from each distinct `category` string found in the data to the number of entries carrying it. Keys are the runtime strings from the JSON, **not** constrained to the `Category` union, so all 9 categories present in the data appear here (including `ran-physical` and `ran-protocol`).

**Purpose:** Summary statistics for dashboards / tool descriptions. Note that because `byCategory` is keyed by the runtime string (`spec-catalog.ts:62-64`), this function is **not** affected by the `Category`-union gap described in §3.1 — it correctly reports all categories that actually appear in the JSON.

---

## 4. Verified catalog contents

The following checks were run during this documentation pass against `00_Workbench_工作台/mcp-server/src/data/6g-spec-catalog.json`.

### 4.1 Entry count — 29 (verified)

Command:
```
grep -c '"spec_number"' "D:/Work/6GStandard/00_Workbench_工作台/mcp-server/src/data/6g-spec-catalog.json"
```
Output: `29`

This matches the `specs.length` value that `getCatalogStats().total` would return.

### 4.2 Category values — 9 distinct (verified)

Command:
```
grep -o '"category": *"[^"]*"' "D:/Work/6GStandard/00_Workbench_工作台/mcp-server/src/data/6g-spec-catalog.json" | sort -u
```
Output (9 lines):
```
"category": "architecture"
"category": "management"
"category": "media"
"category": "ran"
"category": "ran-physical"
"category": "ran-protocol"
"category": "security"
"category": "services"
"category": "tools"
```

Per-category counts (derived by reading the JSON):

| Category        | Count | Spec numbers                                                                                       |
| --------------- | ----- | -------------------------------------------------------------------------------------------------- |
| `architecture`  | 6     | `23.700-40`, `23.700-41`, `23.700-42`, `23.700-43`, `23.700-44`, `23.700-45`                       |
| `ran-physical`  | 5     | `38.211`, `38.212`, `38.213`, `38.214`, `38.215`                                                   |
| `ran-protocol`  | 3     | `38.300`, `38.321`, `38.331`                                                                       |
| `ran`           | 4     | `38.843`, `38.801`, `38.821`, `38.890`                                                             |
| `media`         | 1     | `26.870`                                                                                            |
| `services`      | 3     | `22.877`, `22.878`, `22.879`                                                                       |
| `security`      | 3     | `33.870`, `33.871`, `33.872`                                                                       |
| `management`    | 3     | `28.870`, `28.871`, `28.872`                                                                       |
| `tools`         | 1     | `21.918`                                                                                            |
| **Total**       | **29**|                                                                                                    |

### 4.3 Category union gap — `spec-catalog.ts:4` declares only 7 of 9

**Read from source** (`spec-catalog.ts:4`):
```ts
export type Category = 'architecture' | 'ran' | 'media' | 'security' | 'management' | 'services' | 'tools';
```

The union has 7 members. The JSON has 9 distinct category values (§4.2). The two values present in the data but **omitted** from the union are `ran-physical` and `ran-protocol`. See §3.1 for the consequence and recommended fix. This is a type/data mismatch a maintainer should resolve.

---

## 5. How the file fits the module

The data file and the TypeScript module form a small two-layer design:

1. **Data layer** — `6g-spec-catalog.json` is a plain, versioned, human-editable JSON file. It carries no logic and no types; maintainers add or revise entries directly. The `description` field explicitly invites extension ("Users can extend this by adding entries.", line 3).
2. **Access layer** — `spec-catalog.ts` provides typed, cached, fault-tolerant access to that file. `loadCatalog()` is the only function that touches the filesystem; `getCatalogSpecs()`, `findCatalogEntry()`, and `getCatalogStats()` are thin pure functions over the loaded array. The MCP tool dispatch in `src/index.ts` (the `setupHandlers` `switch` in `ThreeGPP6GMCPServer`, `index.ts:210-349`) calls these helpers via `APIManager` rather than reading the JSON directly, so the cached load happens exactly once per process. Note: there is no `src/tools/` directory — the seven MCP tools are declared and dispatched entirely inside `src/index.ts` (see [`mcp-tools.md`](./mcp-tools.md)).

The one structural seam to be aware of is the `Category`-union gap (§3.1, §4.3): the data file is the source of truth for which categories exist, but the TypeScript union is hand-maintained and currently lags behind the data by two values.
