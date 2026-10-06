# `src/api/api-manager.ts`

> Source: `00_Workbench_工作台/mcp-server/src/api/api-manager.ts`

## Module Purpose

`api-manager.ts` defines `APIManager`, the orchestrator class that composes the four infrastructure modules of the 3GPP 6G MCP server into the high-level operations exposed as MCP tools. It is the single seam between the MCP tool layer above and the supporting services below:

- **FTP client** (`./ftp-client`) — lists and downloads 3GPP specification versions from the FTP archive.
- **Spec catalog** (`./spec-catalog`) — the curated, in-memory catalog of 6G-relevant specifications and their metadata.
- **DOCX extractor** (`./docx-extractor`) — extracts text and section structure from a downloaded `.zip` spec archive.
- **Search index** (`./search-index`) — the FTS5-backed full-text index over extracted spec sections.

The class exposes seven operations that map one-to-one to the MCP tools (`searchSpecifications`, `getSpecificationDetails`, `compareSpecifications`, `findImplementationRequirements`, `searchContent`, `syncSpecification`, `rebuildIndex`), plus four non-tool public helpers (`downloadSpecification`, `getCatalogStats`, `getIndexStats`, `getIndexedSpecs`) used by other parts of the server.

## Imports and Dependencies

- `path`, `fs`, `os` — Node built-ins used for filesystem paths, writing downloaded `.zip` files, and locating the OS temp directory for extraction.
- `config, ensureDataDirs` from `../config` — application configuration and directory bootstrap; the constructor calls `ensureDataDirs()` so the downloads/index directories exist before any operation runs (`api-manager.ts:101`).
- `getFtpClient, specToPaths, SpecVersion` from `./ftp-client` — the shared FTP client singleton, the spec-number-to-file-prefix helper, and the version descriptor type.
- `getCatalogSpecs, findCatalogEntry, getCatalogStats, CatalogEntry` from `./spec-catalog` — catalog enumeration, lookup, and statistics.
- `extractDocument, ExtractedDocument` from `./docx-extractor` — extraction entry point and its result type.
- `getSearchIndex, SearchIndex, SearchResult` from `./search-index` — the shared search-index singleton and the result type returned by full-text queries.

## Exported Result Interfaces

The module exports six interfaces that shape the structured payloads returned to MCP tool callers. They are plain data contracts; no methods.

### `SearchSpecsResult`

Returned by `searchSpecifications`. Wraps a catalog search.

- `query: string` — the original query string echoed back.
- `totalFound: number` — number of results returned (post-limit).
- `results`: array of objects each containing `spec_number`, `title`, `working_group`, `category`, `notes` (from the catalog), `isIndexed` (whether any version is in the local FTS index), `latestVersion` (latest FTP version code or `null`), `releaseLabel` (release label for the latest version or `null`), and `availableVersions` (count of versions on the FTP archive).

### `SpecDetailsResult`

Returned by `getSpecificationDetails`. Describes one spec in depth.

- Top-level catalog fields: `spec_number`, `title`, `working_group`, `category`, `document_type`, `notes`. When the spec is not in the 6G catalog, `title` is `'(not in 6G catalog)'` and the metadata fields fall back to `'unknown'` / `''` (`api-manager.ts:196-200`).
- `versions`: array of per-version objects with `versionCode`, `filename`, `release` (numeric release or `null`), `releaseLabel`, `isDraft`, `isIndexed` (whether this specific version is in the FTS index), and `downloadUrl`.
- `indexedVersions`: array of `{ version, section_count, indexed_at }` for the versions of this spec currently in the local index.

### `ContentSearchResult`

Returned by `searchContent`. Wraps a full-text query.

- `query: string` — echoed query.
- `totalFound: number` — number of `SearchResult` items returned.
- `results: SearchResult[]` — straight pass-through from `SearchIndex.search`.
- `indexStats: { totalDocuments; totalSections }` — snapshot of index size at query time.

### `SyncResult`

Returned by `syncSpecification` and `downloadSpecification`.

- `spec_number: string`, `title: string` — identification (title falls back to the spec number when not in the catalog).
- `status: 'synced' | 'skipped' | 'failed' | 'no_versions'` — outcome bucket.
- `version?: string`, `releaseLabel?: string | null` — the version the operation targeted, when known.
- `message: string` — human-readable outcome or error detail.
- `sections?: number` — number of sections extracted and indexed (only for a successful indexed sync).
- `filePath?: string`, `fileSize?: number` — path and byte size of the saved `.zip` (set on download, including `downloadOnly`).

### `CompareResult`

Returned by `compareSpecifications`.

- `specifications`: array of per-spec objects (`spec_number`, `title`, `working_group`, `category`, `document_type`, `latestVersion`, `releaseLabel`, `availableVersions`, `isIndexed`, `indexedVersions[]`).
- `comparison`: `{ commonCategories: string[]; commonWorkingGroups: string[]; notes: string }`. `commonCategories`/`commonWorkingGroups` list categories/working groups shared by more than one of the input specs; `notes` is a one-line human summary that names the shared categories/working groups, or states that the specs belong to different categories and working groups (`api-manager.ts:473-475`).

### `ImplementationRequirementsResult`

Returned by `findImplementationRequirements`.

- `feature: string` — the feature string echoed back.
- `totalFound: number` — number of `SearchResult` items.
- `results: SearchResult[]` — matching index sections.
- `relatedSpecs: string[]` — de-duplicated list of `spec_number` values appearing in `results`.

## `APIManager`

The orchestrator class. Constructed once and held by the MCP server; each method maps to an MCP tool or a supporting query.

### Construction and Internal State

```ts
class APIManager {
  private ftpClient = getFtpClient();
  private searchIndex: SearchIndex;
  constructor();
}
```

- `ftpClient` — initialized eagerly to the shared FTP client singleton (`api-manager.ts:97`).
- `searchIndex` — initialized in the constructor by calling `getSearchIndex()` after `ensureDataDirs()` has run, guaranteeing the data directories exist before the index is opened (`api-manager.ts:100-103`).

There is no `dispose`/cleanup method; the singletons own their own resources.

### `searchSpecifications` — MCP tool

Search the curated 6G spec catalog by keyword and enrich each match with FTP version info and local index status.

```ts
async searchSpecifications(
  query: string,
  options: { limit?: number } = {}
): Promise<SearchSpecsResult>
```

- `query` — substring matched case-insensitively against `spec_number`, `title`, `working_group`, `category`, and `notes` after lower-casing and trimming. An empty/whitespace query returns the whole catalog (`api-manager.ts:116-117`).
- `options.limit` — maximum results to return; defaults to `20` (`api-manager.ts:110`). The filtered list is sliced to this length before enrichment.
- Returns a `SearchSpecsResult`.

Behavior: pulls the full in-memory catalog with `getCatalogSpecs()`, filters by substring, slices to `limit`, then for each match calls `this.ftpClient.getSpecVersions()` to compute `availableVersions`, `latestVersion`, and `releaseLabel` (`api-manager.ts:139-149`). FTP errors are swallowed so a missing FTP server degrades gracefully to catalog-only data. `isIndexed` is computed by checking whether any indexed spec matches the catalog `spec_number` (`api-manager.ts:151-152`). Enrichment runs concurrently via `Promise.all`.

### `getSpecificationDetails` — MCP tool

Return detailed information about a single specification: catalog metadata, every FTP version, and which versions are locally indexed.

```ts
async getSpecificationDetails(specNumber: string): Promise<SpecDetailsResult>
```

- `specNumber` — e.g. `"23.700-40"` or `"38.843"`.
- Returns a `SpecDetailsResult`.

Behavior: looks up the catalog entry with `findCatalogEntry()` (may be `undefined` for specs outside the curated 6G catalog), fetches versions from the FTP client inside a try/catch so an unavailable FTP server yields an empty `versions` array rather than throwing (`api-manager.ts:183-188`), then intersects the FTP versions with the locally indexed set for this spec to populate per-version `isIndexed` and the `indexedVersions` list (`api-manager.ts:191-214`).

### `compareSpecifications` — MCP tool

Compare metadata, available versions, and index status across multiple specifications, and report shared categories and working groups.

```ts
async compareSpecifications(specNumbers: string[]): Promise<CompareResult>
```

- `specNumbers` — list of spec numbers to compare.
- Returns a `CompareResult`.

Behavior: enriches each spec in parallel with `Promise.all`, reusing the same catalog/FTP/index pattern as `getSpecificationDetails` but yielding the compact compare-shaped object (`api-manager.ts:433-464`). After enrichment it computes `commonCategories` and `commonWorkingGroups` as the values appearing more than once across the input (ignoring `'unknown'`), and synthesizes a `notes` string naming the shared facets, or stating the specs share none (`api-manager.ts:466-475`).

### `findImplementationRequirements` — MCP tool

Full-text search of the indexed spec content for implementation requirement material related to a feature, optionally scoped by a domain keyword.

```ts
async findImplementationRequirements(
  feature: string,
  options: { limit?: number; domain?: string } = {}
): Promise<ImplementationRequirementsResult>
```

- `feature` — the feature or functionality to look for (e.g. `"SUCI privacy protection"`).
- `options.limit` — maximum results; defaults to `30` (`api-manager.ts:493`).
- `options.domain` — optional domain context (e.g. `"security"`) prepended to the feature to form the FTS query string `${feature} ${domain}` (`api-manager.ts:491`).
- Returns an `ImplementationRequirementsResult`. The search is delegated to `SearchIndex.search` with `snippetSize: 48`, and `relatedSpecs` is the de-duplicated list of `spec_number` values from the results.

### `searchContent` — MCP tool

Full-text search across all indexed specification content, with optional spec/version filters.

```ts
async searchContent(
  query: string,
  options: { specNumber?: string; version?: string; limit?: number; snippetSize?: number } = {}
): Promise<ContentSearchResult>
```

- `query` — FTS query string; supports prefix matching at the index layer.
- `options.specNumber` — restrict to a single spec.
- `options.version` — restrict to a single version.
- `options.limit` — defaults to `20`.
- `options.snippetSize` — number of tokens per result snippet; defaults to `32`.
- Returns a `ContentSearchResult`. Delegates to `SearchIndex.search` and appends a snapshot of `SearchIndex.getStats()` as `indexStats` (`api-manager.ts:227-244`).

### `syncSpecification` — MCP tool

Download a specification version from the FTP archive, optionally extract its text and add it to the full-text index.

```ts
async syncSpecification(
  specNumber: string,
  options: { version?: string; force?: boolean; downloadOnly?: boolean } = {}
): Promise<SyncResult>
```

- `specNumber` — spec to sync.
- `options.version` — specific version code to download; when omitted the latest version is selected via `ftpClient.getLatestVersion()` (`api-manager.ts:273-275`).
- `options.force` — when `true`, re-download and re-index even if the version is already in the index. Without `force` (and without `downloadOnly`), an already-indexed version returns `status: 'skipped'` without re-downloading (`api-manager.ts:295-304`).
- `options.downloadOnly` — when `true`, save the `.zip` to the downloads directory but do not extract or index it; returns `status: 'synced'` with `filePath` and `fileSize` (`api-manager.ts:327-338`).
- Returns a `SyncResult`.

Algorithm:

1. Resolve the catalog entry for the title; fall back to the raw spec number (`api-manager.ts:256-257`).
2. Determine the target version. If `options.version` is given, fetch the version list and find the matching code, returning `status: 'no_versions'` if it is not present (`api-manager.ts:262-272`). Otherwise ask the FTP client for the latest version. Any FTP error returns `status: 'failed'` with the underlying message (`api-manager.ts:276-283`).
3. Skip-if-indexed check using `searchIndex.isIndexed(specNumber, versionCode)` unless `force` or `downloadOnly` is set (`api-manager.ts:295`).
4. Download the `.zip` into a `Buffer` via `ftpClient.downloadVersion`; a download failure returns `status: 'failed'` (`api-manager.ts:307-319`).
5. Write the buffer to `${config.downloadsDir}/${filePrefix}-${versionCode}.zip`, where `filePrefix` comes from `specToPaths` (`api-manager.ts:322-325`).
6. If `downloadOnly`, return early with `status: 'synced'`.
7. Otherwise extract the document under `${os.tmpdir()}/3gpp-mcp-extract` (created lazily) via `extractDocument`, then call `searchIndex.indexDocument` to ingest the extracted sections. On success return `status: 'synced'` with `sections`, `filePath`, `fileSize`; on extraction/indexing failure return `status: 'failed'` with the error message (`api-manager.ts:340-368`).

All error paths return a `SyncResult` rather than throwing, so callers always get a structured outcome.

### `rebuildIndex` — MCP tool

Rebuild the full-text index by re-extracting every `.zip` file in the downloads directory.

```ts
async rebuildIndex(): Promise<{ totalDocuments: number; totalSections: number; errors: string[] }>
```

- No parameters.
- Returns the post-rebuild `totalDocuments` and `totalSections` from `searchIndex.getStats()`, plus an `errors` array of per-file failure messages.

Behavior: if `config.downloadsDir` does not exist, returns zeroed stats with a single error message (`api-manager.ts:385-387`). Otherwise it scans the directory for `*.zip` files, parses each filename with the regex `/^(.+)-([a-j]\d{2}|\d{3})\.zip$/` to recover the file prefix and version code (`api-manager.ts:398`), and converts the prefix back to a spec number by inserting a dot after the two-digit series (`api-manager.ts:407`). Each archive is extracted and indexed; failures are captured into `errors` without aborting the loop. After processing, the final stats are read back from the index. Note that the returned `totalDocuments`/`totalSections` reflect the entire index state (which `indexDocument` upserts into), not just the files processed in this call.

## Non-Tool Public Methods

These are not exposed directly as MCP tools but support other parts of the server (status endpoints, tool descriptions, decision logic).

### `downloadSpecification`

```ts
async downloadSpecification(specNumber: string, version?: string): Promise<SyncResult>
```

Thin wrapper around `syncSpecification` that forces `downloadOnly: true` (`api-manager.ts:374-376`). Use it to place a spec archive into the 6GStandard document tree without extracting or indexing it. The returned `SyncResult` carries `filePath` and `fileSize` on success.

### `getCatalogStats`

```ts
getCatalogStats()
```

Pass-through to the catalog module's `getCatalogStats()` (`api-manager.ts:510-512`). Returns aggregate statistics about the curated 6G spec catalog (e.g. total specs, category/working-group counts). Synchronous.

### `getIndexStats`

```ts
getIndexStats()
```

Returns `this.searchIndex.getStats()` (`api-manager.ts:517-519`) — a snapshot of the FTS index size (total documents and sections). Synchronous.

### `getIndexedSpecs`

```ts
getIndexedSpecs()
```

Returns `this.searchIndex.getIndexedSpecs()` (`api-manager.ts:524-526`) — the list of `{ spec_number, version, section_count, indexed_at }` records currently in the index. Used by the search/spec-details tools to compute `isIndexed` flags and by status surfaces. Synchronous.

## How the Pieces Compose

The orchestrator pattern keeps each collaborator focused on one concern and lets `APIManager` own the workflow:

1. **Catalog-first discovery.** `searchSpecifications` and `compareSpecifications` start from `getCatalogSpecs()` / `findCatalogEntry()` so the catalog — not the live FTP server — is the source of truth for *which* specs exist and their metadata. This keeps listing queries fast and offline-capable.
2. **FTP for versioning and bytes.** Whenever a method needs version availability or the actual archive bytes, it calls the FTP client. Every FTP call is wrapped in a try/catch so a missing/unreachable FTP server degrades the response to catalog-only data instead of failing the whole tool call (`api-manager.ts:139-149`, `183-188`, `440-447`).
3. **Index for content queries.** `searchContent` and `findImplementationRequirements` go straight to the FTS index without touching FTP — content search only works on material that has been synced and indexed.
4. **`syncSpecification` is the join point.** It is the only method that touches all four collaborators: catalog (for the title), FTP (for the version list and the bytes), the docx extractor (to turn the `.zip` into sections), and the search index (to ingest those sections). `downloadSpecification` reuses the same pipeline with the indexing leg switched off.
5. **`rebuildIndex` operates offline.** It bypasses FTP entirely and re-ingests whatever `.zip` files are already on disk, making it safe to run without network access.

## Error-Handling Conventions

- The tool-shaped methods never throw for expected failures; they return a `SyncResult` with a `status` of `'failed'` or `'no_versions'` and a human-readable `message` (`api-manager.ts:266-291`, `310-319`, `359-368`). This makes MCP tool output predictable.
- Catalog and index lookups are total — they return fallback strings (`'(not in 6G catalog)'`, `'unknown'`, `''`) rather than `null`/`undefined` for missing entries.
- FTP unavailability is treated as soft: caught and silently skipped for listing/details/compare, surfaced as a structured failure for sync.
