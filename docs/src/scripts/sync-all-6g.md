# `src/scripts/sync-all-6g.ts`

> Source: `00_Workbench_工作台/mcp-server/src/scripts/sync-all-6g.ts`

Batch synchronization script for the `3gpp-6g-mcp-server` project. It iterates the entire curated 6G specification catalog and synchronizes every spec through `APIManager` — downloading each `.zip` archive from the 3GPP FTP server and (optionally) extracting and indexing its text content into the local full-text search index. Specs are processed **sequentially** with a configurable delay between them, to be polite to the upstream FTP server and avoid hammering it.

The script is a standalone CLI entry point. It is intended to be invoked through the package's npm script `sync-all` (see the usage block in the file header, `sync-all-6g.ts:5-9`), and writes a structured JSON report of the run to the downloads directory on completion.

## Module overview

The file has no exported runtime symbols — it is a script meant to be executed directly, not imported. Its top-level statement calls `main()` and rejects to a fatal-error handler (`sync-all-6g.ts:155-158`). The module's structure is therefore:

1. A single TypeScript interface, `SyncReport`, that shapes the JSON report written to disk.
2. An `async function main()` that contains all the script's logic.
3. The bootstrap `main().catch(...)` invocation at module load.

## CLI usage

Invoked via npm (the file-header docstring, `sync-all-6g.ts:5-9`):

```
npm run sync-all                      # sync all cataloged specs (latest version)
npm run sync-all -- --force           # re-download and re-index even if already indexed
npm run sync-all -- --download-only   # download .zip files without indexing
```

The two flags may be combined; both are detected by exact-element membership tests against the post-node arguments — `args.includes('--force')` / `args.includes('--download-only')` on `process.argv.slice(2)` (`sync-all-6g.ts:42-44`). Because `Array.prototype.includes` tests for exact element equality rather than substring containment, a token like `--forceful` would not match `--force`.

### Flags

| Flag              | Source line | Purpose                                                                 |
| ----------------- | ----------- | ----------------------------------------------------------------------- |
| `--force`         | `:43`       | Pass `force: true` to `APIManager.syncSpecification`, re-downloading and re-indexing even if the spec/version is already indexed. |
| `--download-only` | `:44`       | Pass `downloadOnly: true` to `APIManager.syncSpecification`, so `.zip` files are saved to the downloads directory but not extracted or indexed. |

## `SyncReport`

> Source: `sync-all-6g.ts:20-39`

The shape of the JSON report the script writes to `<downloadsDir>/sync-report.json` at the end of a run. It is **not exported** — it is only used internally to type the `report` constant built in `main()`.

```ts
interface SyncReport {
  total: number;
  synced: number;
  skipped: number;
  failed: number;
  noVersions: number;
  totalSections: number;
  details: {
    spec_number: string;
    title: string;
    status: string;
    version?: string;
    releaseLabel?: string | null;
    message: string;
    sections?: number;
  }[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}
```

### Fields

| Field           | Type                                                                                  | Meaning |
| --------------- | ------------------------------------------------------------------------------------- | ------- |
| `total`         | `number`                                                                              | Total number of catalog specs processed (`specs.length`, `sync-all-6g.ts:124`). |
| `synced`        | `number`                                                                              | Count of specs whose sync returned `status: 'synced'` (`:84-87`). |
| `skipped`       | `number`                                                                              | Count of specs already indexed and skipped because `--force` was not set (`:89-91`). |
| `failed`        | `number`                                                                              | Count of specs whose sync returned `status: 'failed'`, plus any spec that threw an unexpected exception in the loop body (`:93-95`, `:102-104`). |
| `noVersions`    | `number`                                                                              | Count of specs for which the FTP archive exposed no versions (`status: 'no_versions'`, `:97-99`). |
| `totalSections` | `number`                                                                              | Sum of `result.sections` across all `synced` specs — i.e. the total number of indexed document sections added during the run (`:85-86`). |
| `details`       | `Array<{ spec_number, title, status, version?, releaseLabel?, message, sections? }>`  | Per-spec outcome records, in the order processed. Each entry is built from a subset of the fields returned by `APIManager.syncSpecification` — `spec_number`, `title`, `status`, `version`, `releaseLabel`, `message`, and `sections` (`:73-81`). The two remaining `SyncResult` fields, `filePath` and `fileSize` (`api-manager.ts:65-66`), are deliberately omitted, so the recorded shape is narrower than the full result (`:73-81`). |
| `startedAt`     | `string` (ISO timestamp)                                                              | `new Date().toISOString()` captured immediately before the loop begins (`:61`). |
| `finishedAt`    | `string` (ISO timestamp)                                                              | `new Date().toISOString()` captured immediately after the loop ends (`:120`). |
| `durationMs`    | `number`                                                                              | Wall-clock duration of the run in milliseconds, computed as `Date.now() - new Date(startedAt).getTime()` (`:121`). |

## `main()`

> Source: `sync-all-6g.ts:41-153`

```ts
async function main(): Promise<void>
```

**Purpose.** Orchestrates the entire batch sync. Parses CLI flags, loads the catalog, instantiates an `APIManager`, walks the catalog list one spec at a time, classifies each result, then writes a JSON report and exits with a non-zero status code if any failures occurred.

**Parameters.** None — inputs come from `process.argv` and the loaded configuration.

**Return value.** Resolves with `void` when the run completes cleanly (or with `failed === 0`). On any failure it does not reject; instead it ends the process with `process.exit(1)` (`:150-152`). The bootstrap `main().catch(...)` at `:155-158` only fires if `main` itself throws an unexpected exception (e.g. an unhandled rejection inside the loop that escaped the per-spec `try/catch`), in which case it logs `Fatal error:` and exits with code 1.

### Behavior, step by step

1. **Flag parsing** (`:42-44`). `process.argv.slice(2)` is scanned for `--force` and `--download-only` using `Array.prototype.includes`, which tests for exact element equality (not substring containment). Both default to `false` when absent.
2. **Catalog load** (`:46`). `getCatalogSpecs()` (from `../api/spec-catalog`) returns the curated array of `CatalogEntry` records. The catalog size is logged to `stderr`.
3. **Banner** (`:47-51`). Prints run parameters to `stderr`: catalog size, mode (`download-only` vs `sync (download + index)`), `force` flag state, and the configured downloads directory (`config.downloadsDir`).
4. **Manager + counters** (`:53-61`). A fresh `APIManager` is constructed. Counters `synced`, `skipped`, `failed`, `noVersions`, `totalSections` are initialized to zero, and `startedAt` is captured.
5. **Sequential loop** (`:63-118`). For each spec in the catalog, in order:
   - Logs progress as `[i/N] Syncing <spec_number> — <title>...` (`:65`).
   - Calls `await apiManager.syncSpecification(spec.spec_number, { force, downloadOnly })` (`:68-71`). The options object is built directly from the parsed flags; `version` is intentionally omitted so the manager selects the latest available version from the FTP archive.
   - Pushes the result's display fields into the `details` array (`:73-81`).
   - Switches on `result.status` to bump the corresponding counter and log a glyph-prefixed message:
     - `synced` → `✓`, plus `result.sections` (defaulting to `0`) is added to `totalSections` (`:84-87`).
     - `skipped` → `→` (`:89-91`).
     - `failed` → `✗` (`:93-95`).
     - `no_versions` → `⊘` (`:97-99`).
   - If `syncSpecification` throws (the APIManager method normally catches its own errors and returns `failed`, so this is a defensive guard), the spec is recorded as `failed` with message `Unexpected error: <err.message>` (`:102-112`).
   - **Inter-spec delay** (`:114-117`). After every spec except the last, `await new Promise(resolve => setTimeout(resolve, config.sync.delayBetweenSpecs))` pauses the loop. The delay defaults to `1000` ms when not overridden in the config file (see `config.ts:89`).
6. **Report assembly** (`:120-134`). `finishedAt` and `durationMs` are captured, and a `SyncReport` object is built from the accumulated counters and details.
7. **Report persistence** (`:137-138`). The report is serialized to `<config.downloadsDir>/sync-report.json` with 2-space indentation via `fs.writeFileSync`. The downloads directory is not created by `config` initialization: at module load `config.ts` only runs `buildConfig()` (`config.ts:95`), which resolves `downloadsDir` as a path string but does not materialise it on disk. The directory is created by `ensureDataDirs()` (`config.ts:98-106`), which is invoked by the `APIManager` constructor (`api-manager.ts:101`). Because `main()` constructs `new APIManager()` at `:53` before reaching the report write, the directories are guaranteed to exist by the time `fs.writeFileSync` runs — but the guarantee comes from the `APIManager` constructor, not from `config` import.
8. **Summary banner** (`:140-147`). Prints totals, sections indexed, counts of skipped/failed/no-FTP specs, the duration in seconds, and the absolute report path — all to `stderr`.
9. **Exit status** (`:150-152`). If `failed > 0`, the process exits with code `1`; otherwise `main` returns normally and the process exits with code `0`.

### How it fits the module

`main()` is the entire executable surface of the script. The file's top-level `main().catch(...)` invocation (`:155-158`) is the only statement that runs on import, so the file is meant to be a process entry point rather than a library module. The script's contract with the rest of the codebase is narrow: it consumes the catalog (`getCatalogSpecs`), drives synchronization through `APIManager.syncSpecification`, reads two values from `config` (`downloadsDir`, `sync.delayBetweenSpecs`), and writes one JSON artifact (`sync-report.json`). Everything else is logged to `stderr`, leaving `stdout` clean.

## Dependencies

| Import                  | From                | Role in this script |
| ----------------------- | ------------------- | ------------------- |
| `APIManager`            | `../api/api-manager` (`:14`) | Provides `syncSpecification(specNumber, { force, downloadOnly })`, the per-spec workhorse. Returns a `SyncResult` (`api-manager.ts:57-67`) whose `status` is one of `'synced' \| 'skipped' \| 'failed' \| 'no_versions'`. |
| `getCatalogSpecs`       | `../api/spec-catalog` (`:15`) | Returns the array of `CatalogEntry` records to iterate. Each entry supplies `spec_number` and `title` used in log lines and the report. |
| `path`                  | Node built-in (`:16`) | Used to join `config.downloadsDir` with `sync-report.json` (`:137`). |
| `fs`                    | Node built-in (`:17`) | Used to write the JSON report to disk (`:138`). |
| `config`                | `../config` (`:18`) | Supplies `downloadsDir` (report destination, banner) and `sync.delayBetweenSpecs` (inter-spec delay). |

## Exit codes

| Code | Condition |
| ---- | --------- |
| `0`  | `main` returned without `failed > 0`. |
| `1`  | Any per-spec result had `status: 'failed'` (or threw inside the loop), or `main` itself threw an unexpected exception caught by the bootstrap handler. |
