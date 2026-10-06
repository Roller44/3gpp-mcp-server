# `search-index.ts` — SQLite FTS5 Full-Text Search Index

**Source path:** `src/api/search-index.ts`

## Module overview

`search-index.ts` provides the SQLite-backed full-text search index for 3GPP specification content in the `3gpp-6g-mcp-server` project. It is built on [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) and uses SQLite's **FTS5** virtual table extension to enable section-level search over previously extracted specification documents.

Each section of an extracted document is indexed as a separate row in an FTS5 table. This makes it possible to return matches with section-level granularity — section title, nesting level, in-document position, and a relevance snippet — rather than whole-document matches. A companion regular table tracks per-document metadata (file path, size, section count, indexing timestamp), and a small key/value table records the database schema version.

The module exports:

- The `SearchIndex` class, which owns the database connection and exposes all indexing, search, and lifecycle methods.
- The `SearchResult`, `SearchOptions`, and `IndexStats` interfaces that describe the public data shapes.
- The `getSearchIndex()` factory, which returns a process-wide singleton `SearchIndex`.

A single module-private helper, `sanitizeFtsQuery`, prepares raw user input into a safe FTS5 MATCH expression; it is not exported.

### Dependencies

- `better-sqlite3` — synchronous SQLite driver (`search-index.ts:1`).
- Node `path` and `fs` — for resolving the index directory and reading DB file stats (`search-index.ts:2-3`).
- `../config` — supplies the default `indexPath` for the SQLite file (`search-index.ts:4`).
- `./docx-extractor` — provides the `ExtractedDocument` and `DocSection` types that `indexDocument` consumes (`search-index.ts:5`).

### Database connection & PRAGMAs

The constructor resolves the index file path (from the argument or `config.indexPath`), creates the parent directory if missing, opens the database, and sets two PRAGMAs (`search-index.ts:54-65`):

- `journal_mode = WAL` — write-ahead logging for concurrent reader/writer performance.
- `foreign_keys = ON` — enables foreign-key enforcement (no foreign keys are declared in the current schema, but the pragma is set defensively).

## Schema

The schema is initialized by the private `initialize()` method (`search-index.ts:67-109`), which runs each `CREATE ... IF NOT EXISTS` statement and seeds the schema-version row on first creation.

### `spec_content` — FTS5 virtual table (`search-index.ts:69-82`)

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS spec_content USING fts5(
  spec_number,
  version,
  section_title,
  section_level UNINDEXED,
  content,
  position UNINDEXED,
  document_path UNINDEXED,
  file_size UNINDEXED,
  indexed_at UNINDEXED,
  tokenize = 'unicode61'
);
```

This is the searchable core of the module. The FTS5 tokenizer is `unicode61`, so tokenization is case-insensitive and Unicode-aware. The columns:

| Column           | Indexed? | Purpose                                                          |
| ---------------- | -------- | ---------------------------------------------------------------- |
| `spec_number`    | yes      | 3GPP spec number, e.g. `23.700-40`. Also filterable in `search`. |
| `version`        | yes      | Spec version code, e.g. `j00`. Also filterable in `search`.      |
| `section_title`  | yes      | Heading text of the section.                                     |
| `section_level`  | no       | Heading nesting level (UNINDEXED — stored, not tokenized).       |
| `content`        | yes      | Full text of the section; the primary search corpus.             |
| `position`       | no       | In-document section position (UNINDEXED).                        |
| `document_path`  | no       | Filesystem path of the source document (UNINDEXED).              |
| `file_size`      | no       | Size of the source document in bytes (UNINDEXED).                |
| `indexed_at`     | no       | ISO timestamp of indexing (UNINDEXED).                           |

The `UNINDEXED` columns are stored on the FTS5 shadow tables but excluded from the token index, so they can be returned in `SELECT` results and used in `WHERE` equality filters without contributing to MATCH scoring.

### `spec_metadata` — regular table (`search-index.ts:85-95`)

```sql
CREATE TABLE IF NOT EXISTS spec_metadata (
  spec_number TEXT NOT NULL,
  version TEXT NOT NULL,
  document_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  section_count INTEGER NOT NULL,
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (spec_number, version)
);
```

One row per indexed `(spec_number, version)` pair. The composite primary key enforces that a given spec version is indexed at most once; re-indexing replaces the existing row (see `indexDocument`). `getIndexedSpecs`, `isIndexed`, and `getStats` read from this table.

### `schema_info` — schema version tracking (`search-index.ts:98-103`)

```sql
CREATE TABLE IF NOT EXISTS schema_info (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

A generic key/value table used for database version tracking. The module-level constant `DB_VERSION = 1` (`search-index.ts:49`) is the current schema version. On initialization, `initialize()` reads the `db_version` key; if it is absent (a fresh database), it inserts `('db_version', '1')` (`search-index.ts:105-108`). This row is the hook a future migration step would consult before applying schema changes.

## Exported types

### `SearchResult` (`search-index.ts:22-31`)

Describes one matched section returned by `SearchIndex.search`.

```ts
export interface SearchResult {
  spec_number: string;
  version: string;
  section_title: string;
  section_level: number;
  snippet: string;
  position: number;
  document_path: string;
  rank: number;
}
```

- `spec_number`, `version` — identify the spec version the hit came from.
- `section_title`, `section_level` — the matched section's heading text and nesting depth.
- `snippet` — FTS5 `snippet()` excerpt of the `content` column, wrapped in `>>>`/`<<<` markers with ` ... ` ellipses. Length is controlled by `SearchOptions.snippetSize`.
- `position` — the section's in-document position, useful for ordering hits in reading order.
- `document_path` — filesystem path of the source document.
- `rank` — FTS5 relevance rank; lower is more relevant when ordering by `rank`.

### `SearchOptions` (`search-index.ts:33-39`)

Optional parameters for `SearchIndex.search`.

```ts
export interface SearchOptions {
  specNumber?: string;       // filter to a specific spec
  version?: string;          // filter to a specific version
  limit?: number;            // max results (default 20)
  snippetSize?: number;      // snippet length in tokens (default 32)
  orderBy?: 'rank' | 'position'; // sort order (default rank)
}
```

When `specNumber` and/or `version` are provided, they are appended to the SQL `WHERE` clause as equality predicates against the corresponding FTS5 columns (`search-index.ts:181-188`). `orderBy: 'position'` sorts by `spec_number, version, position`; otherwise results are ordered by FTS5 `rank` (`search-index.ts:190-194`).

### `IndexStats` (`search-index.ts:41-47`)

Returned by `SearchIndex.getStats`.

```ts
export interface IndexStats {
  totalDocuments: number;
  totalSections: number;
  specs: { spec_number: string; version: string; sections: number; indexed_at: string }[];
  dbPath: string;
  dbSizeBytes: number;
}
```

- `totalDocuments` — count of rows in `spec_metadata` (one per indexed spec version).
- `totalSections` — count of rows in `spec_content` (one per indexed section).
- `specs` — per-document summary rows ordered by `spec_number, version`.
- `dbPath` — filesystem path of the SQLite file, taken from `this.db.name`.
- `dbSizeBytes` — size of the SQLite file in bytes, via `fs.statSync`; `0` if the file is not present.

## The `SearchIndex` class

`SearchIndex` owns the `better-sqlite3` connection and exposes all public operations. It is the only class exported from the module.

### Constructor

```ts
constructor(dbPath?: string)
```

- **Parameters**
  - `dbPath` (optional) — filesystem path for the SQLite index file. When omitted, `config.indexPath` is used.
- **Behavior** — creates the parent directory if it does not exist (`search-index.ts:57-59`), opens the database, sets `journal_mode = WAL` and `foreign_keys = ON`, and calls `initialize()` to create the schema and seed `schema_info` (`search-index.ts:61-64`).
- **Role** — every other method depends on the connection and schema established here.

### `indexDocument(doc: ExtractedDocument): void` (`search-index.ts:115-153`)

Indexes one extracted document, replacing any prior index entries for the same `spec_number` + `version`.

- **Parameters**
  - `doc` — an `ExtractedDocument` from `./docx-extractor`, carrying `specNumber`, `version`, `filePath`, `fileSize`, `sections` (an array of `DocSection` with `title`, `level`, `content`, `position`), and `extractedAt`.
- **Behavior** — prepares four statements (delete old sections, delete old metadata, insert a section, insert metadata) and runs them inside a single transaction (`search-index.ts:133-150`):
  1. `DELETE FROM spec_content WHERE spec_number = ? AND version = ?`
  2. `DELETE FROM spec_metadata WHERE spec_number = ? AND version = ?`
  3. For each section, `INSERT INTO spec_content (...) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)` with the section's title, level, content, position, plus the document's path, size, and `extractedAt`.
  4. `INSERT INTO spec_metadata (...) VALUES (?, ?, ?, ?, ?, ?)` with `section_count = sections.length`.
- **Return value** — none.
- **Role** — the write path. The delete-then-insert pattern makes re-indexing idempotent: calling `indexDocument` on an already-indexed spec version fully replaces its prior content. Wrapping the deletes and inserts in one transaction guarantees the metadata table and the FTS5 table stay consistent.

### `search(query: string, options: SearchOptions = {}): SearchResult[]` (`search-index.ts:158-211`)

Runs an FTS5 full-text query against `spec_content`.

- **Parameters**
  - `query` — raw user query string.
  - `options` — `SearchOptions` (all fields optional; defaults: `limit = 20`, `snippetSize = 32`, `orderBy = 'rank'`).
- **Behavior**
  1. Sanitizes the query via the module-private `sanitizeFtsQuery`. Returns `[]` immediately if the sanitized query is empty (`search-index.ts:163-164`).
  2. Builds a `SELECT` against `spec_content` that uses FTS5's `snippet(spec_content, 4, '>>>', '<<<', ' ... ', ${snippetSize})` to excerpt column index 4 (the `content` column) (`search-index.ts:172`). Match markers are `>>>`/`<<<` with ` ... ` as the ellipsis.
  3. Appends `AND spec_number = ?` and/or `AND version = ?` filters when `options.specNumber` / `options.version` are set (`search-index.ts:181-188`).
  4. Appends `ORDER BY` — either `spec_number, version, position` for `orderBy: 'position'`, or `rank` otherwise (`search-index.ts:190-194`).
  5. Appends `LIMIT ?` (`search-index.ts:196-197`) and runs the parameterized statement.
- **Return value** — `SearchResult[]`, one element per matched section, mapped row-by-row from the statement output (`search-index.ts:201-210`).
- **Role** — the read path; the only public way to query the index.

### `removeDocument(specNumber: string, version?: string): number` (`search-index.ts:216-232`)

Removes a document (all of its sections and its metadata row) from the index.

- **Parameters**
  - `specNumber` — the spec number to remove.
  - `version` (optional) — a specific version. When omitted, **all** versions of `specNumber` are removed.
- **Behavior** — inside a single transaction, deletes from both `spec_content` and `spec_metadata`. With `version` given the deletes are scoped to `(spec_number, version)`; without it they are scoped to `spec_number` only (`search-index.ts:217-225`).
- **Return value** — the number of rows remaining in `spec_content` for the given scope **after** deletion, computed by a follow-up `COUNT(*)` query (`search-index.ts:228-231`). For a successful full removal this is `0`.
- **Role** — the delete path. Used to evict a spec version before re-indexing from a different source, or to clear a superseded spec entirely.

### `getIndexedSpecs(): { spec_number; version; document_path; section_count; indexed_at }[]` (`search-index.ts:237-241`)

Lists every indexed spec version.

- **Parameters** — none.
- **Return value** — array of `{ spec_number: string; version: string; document_path: string; section_count: number; indexed_at: string }`, ordered by `spec_number, version`, read directly from `spec_metadata`.
- **Role** — supports "what is already indexed?" introspection, e.g. before deciding whether to (re)download a spec.

### `isIndexed(specNumber: string, version: string): boolean` (`search-index.ts:246-251`)

Tests whether a specific spec version is present in the index.

- **Parameters**
  - `specNumber` — spec number to check.
  - `version` — version code to check.
- **Return value** — `true` if a row exists in `spec_metadata` for the `(spec_number, version)` pair, `false` otherwise. Implemented via `SELECT 1 FROM spec_metadata WHERE spec_number = ? AND version = ?` and coercing the row to a boolean (`search-index.ts:247-250`).
- **Role** — the cheap existence check used by callers to skip re-indexing when an up-to-date version is already present.

### `getStats(): IndexStats` (`search-index.ts:256-274`)

Returns aggregate statistics about the index.

- **Parameters** — none.
- **Behavior**
  - `totalDocuments` — `COUNT(*)` over `spec_metadata` (`search-index.ts:257`).
  - `totalSections` — `COUNT(*)` over `spec_content` (`search-index.ts:258`).
  - `specs` — `SELECT spec_number, version, section_count AS sections, indexed_at FROM spec_metadata ORDER BY spec_number, version` (`search-index.ts:260-262`).
  - `dbPath` — `this.db.name` (`search-index.ts:264`).
  - `dbSizeBytes` — `fs.statSync(dbPath).size`, or `0` if the file is not present (`search-index.ts:265`).
- **Return value** — an `IndexStats` object as described above.
- **Role** — powers status/health reporting for the index (size, document count, recency).

### `close(): void` (`search-index.ts:279-281`)

Closes the underlying `better-sqlite3` database connection.

- **Parameters** — none.
- **Return value** — none.
- **Role** — lifecycle cleanup. After `close()`, the `SearchIndex` instance must not be used. Note that the module-level singleton returned by `getSearchIndex()` is **not** automatically recreated after `close()` — callers that close the singleton and then call `getSearchIndex()` again will receive the already-closed instance.

## Module-private helper

### `sanitizeFtsQuery(query: string): string` (`search-index.ts:288-303`)

Not exported. Transforms a raw user query into a safe FTS5 MATCH expression.

- If the trimmed query is empty, returns `''` (the caller treats this as "no results").
- If the query already contains FTS5 operators / special characters (`"`, `*`, `+`, `-`, `:`, `(`, `)`, space) and is more than one character long, it is passed through unchanged, on the assumption the caller is constructing an explicit FTS5 query.
- Otherwise the query is split on whitespace, quotes are stripped from each token, and each token is given a trailing `*` to enable **prefix matching**. Tokens are joined with spaces, which FTS5 interprets as implicit AND.

This is the only place user input is converted into a MATCH expression, and it is what `SearchIndex.search` calls before issuing the query.

## Singleton factory

### `getSearchIndex(): SearchIndex` (`search-index.ts:308-313`)

Returns a process-wide singleton `SearchIndex` instance, creating it on first call via the default constructor (so the database path comes from `config.indexPath`).

- **Parameters** — none.
- **Return value** — the shared `SearchIndex` instance.
- **Role** — the conventional entry point for callers that want the index without managing connection lifecycle themselves. The singleton is stored in the module-private `searchIndexInstance` (`search-index.ts:306`). Because the singleton is not reset by `close()`, callers that need a fresh connection after closing should construct a `new SearchIndex(...)` directly rather than using the factory.

## How the pieces fit together

`SearchIndex` is the persistence and search layer for the spec-indexing pipeline. A typical flow:

1. A caller obtains the index via `getSearchIndex()` (or constructs `new SearchIndex(dbPath)` for tests / custom locations).
2. After extracting a spec with `docx-extractor`, the caller passes the resulting `ExtractedDocument` to `indexDocument`, which atomically replaces any prior entries for that spec version and inserts one row per section into `spec_content` plus one row into `spec_metadata`.
3. `isIndexed` is the cheap guard used before re-downloading or re-indexing; `getIndexedSpecs` and `getStats` provide broader introspection.
4. `search` runs an FTS5 MATCH query, returning section-level `SearchResult` rows with snippets and positions for the MCP server to surface to its clients.
5. `removeDocument` evicts a spec version (or an entire spec) when it is superseded or no longer wanted.
6. `close` releases the database connection on shutdown.

The `schema_info` table and `DB_VERSION` constant provide the forward-compatibility seam: any future schema change would bump `DB_VERSION` and run a migration in `initialize()` keyed off the persisted value.
