# Configuration Reference

> Source: [`00_Workbench_工作台/mcp-server/config.example.json`](../config.example.json) and [`00_Workbench_工作台/mcp-server/src/config.ts`](../src/config.ts)

The 3GPP 6G MCP Server is configured through three layered mechanisms, applied in order of increasing precedence:

1. **`config.json`** at the server root (the sibling of `config.example.json`). This file is optional; if it is missing or unparseable, the loader silently falls back to defaults (see `loadConfigFile` at `src/config.ts:37-46`).
2. **Environment-variable overrides** for the three path settings (see [Environment-variable overrides](#environment-variable-overrides)).
3. **Hard-coded fallbacks** in `buildConfig()` for any field not supplied by either of the above.

`config.example.json` is a documented template that mirrors the default values baked into `src/config.ts`. Copy it to `config.json` and edit to customize. Every field shown in the example is also assigned a default in `buildConfig()`, so a server with no `config.json` at all will still run with the same defaults — except for `documentRoot`, whose default differs between the example file and the code (see [documentRoot](#documentroot)).

---

## `config.example.json` field reference

The example file is a flat JSON object with three top-level scalars (`documentRoot`, `indexPath`, `downloadsDir`) and two nested objects (`ftp`, `sync`). Each field maps directly to a member of the `ServerConfig` interface (`src/config.ts:26-32`).

### `documentRoot`

- **Example value:** `"/path/to/your/3gpp-documents"` (`config.example.json:2`)
- **Type:** `string`
- **Purpose:** Filesystem directory under which 3GPP specification documents live. This is the root the server's data tools operate against.
- **Resolution:** Resolved by `resolveMaybeRelative` (`src/config.ts:48-51`). If the supplied value is an absolute path it is used verbatim; if it is relative it is resolved against `SERVER_ROOT` (the compiled `dist/` directory's parent, `src/config.ts:35`).
- **Default divergence:** This is the one field whose example placeholder differs from the code's hard-coded fallback. The example uses `"/path/to/your/3gpp-documents"` (`config.example.json:2`), which is an obvious placeholder meant to be edited. The hard-coded fallback in `buildConfig()` is `"D:\\Work\\6GStandard"` (`src/config.ts:58`). When neither the `SPECS_DOCUMENT_ROOT` env var nor `config.json` sets `documentRoot`, the server uses `D:\Work\6GStandard`.

### `indexPath`

- **Example value:** `"./index/3gpp-fts.db"` (`config.example.json:3`)
- **Type:** `string`
- **Purpose:** Path to the SQLite full-text-search index database used by `search_content` and `find_implementation_requirements`.
- **Resolution:** Same `resolveMaybeRelative` rules as `documentRoot`. The example value matches the hard-coded fallback at `src/config.ts:63`.
- **Env override:** `SPECS_INDEX_PATH`.

### `downloadsDir`

- **Example value:** `"./downloads"` (`config.example.json:4`)
- **Type:** `string`
- **Purpose:** Directory where `sync_specification` writes downloaded `.zip` archives before they are extracted and indexed.
- **Resolution:** Same `resolveMaybeRelative` rules. The example value matches the hard-coded fallback at `src/config.ts:68`.
- **Env override:** `SPECS_DOWNLOADS_DIR`.

### `ftp` (object)

Nested block (`config.example.json:5-12`) holding FTP/dynareport fetch parameters. Maps to the `FtpConfig` interface (`src/config.ts:11-18`). All six fields have hard-coded defaults in `buildConfig()` (`src/config.ts:78-85`); the example file reproduces those defaults exactly.

| Field | Example value | Type | Purpose |
|---|---|---|---|
| `userAgent` | `"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"` | `string` | `User-Agent` header sent to `www.3gpp.org` when fetching spec archives and dynareport pages. Default at `src/config.ts:79`. |
| `baseUrl` | `"https://www.3gpp.org/ftp/Specs/archive"` | `string` | Base URL for the 3GPP FTP spec archive. Spec archives are resolved relative to this. Default at `src/config.ts:80`. |
| `dynareportUrl` | `"https://www.3gpp.org/dynareport"` | `string` | Base URL for the 3GPP dynareport site (used to discover spec lists and version metadata). Default at `src/config.ts:81`. |
| `retryAttempts` | `3` | `number` | Number of times to retry a failed FTP/HTTP fetch before giving up. Default at `src/config.ts:82`. |
| `retryDelayMs` | `2000` | `number` | Delay in milliseconds between retry attempts. Default at `src/config.ts:83`. |
| `timeoutMs` | `30000` | `number` | Per-request timeout in milliseconds. Default at `src/config.ts:84`. |

There are no environment-variable overrides for `ftp` fields; customization is via `config.json` only. If `config.json` provides a partial `ftp` object (or omits it entirely), `buildConfig()` merges field-by-field against the defaults via `??` — missing fields fall through to the hard-coded values.

### `sync` (object)

Nested block (`config.example.json:13-17`) controlling batch synchronization behavior. Maps to the `SyncConfig` interface (`src/config.ts:20-24`). All three fields have hard-coded defaults in `buildConfig()` (`src/config.ts:86-90`); the example reproduces them.

| Field | Example value | Type | Purpose |
|---|---|---|---|
| `autoIndexOnDownload` | `true` | `boolean` | When `true`, `sync_specification` extracts and indexes the spec text immediately after the download completes, so the spec becomes searchable without a separate `rebuild_index` call. Default at `src/config.ts:87`. |
| `maxConcurrentDownloads` | `1` | `number` | Maximum number of spec downloads allowed to run in parallel. `1` enforces strict sequential downloading. Default at `src/config.ts:88`. |
| `delayBetweenSpecs` | `1000` | `number` | Delay in milliseconds between consecutive spec downloads when iterating over a list, used to avoid hammering `www.3gpp.org`. Default at `src/config.ts:89`. |

There are no environment-variable overrides for `sync` fields. As with `ftp`, a partial `sync` object in `config.json` is merged field-by-field against the defaults.

---

## TypeScript interfaces (`src/config.ts`)

The configuration module exports three interfaces and one constant. They live in `00_Workbench_工作台/mcp-server/src/config.ts`.

### `FtpConfig`

```ts
export interface FtpConfig {
  userAgent: string;
  baseUrl: string;
  dynareportUrl: string;
  retryAttempts: number;
  retryDelayMs: number;
  timeoutMs: number;
}
```
*Defined at `src/config.ts:11-18`.*

Shape of the `ftp` block of `ServerConfig`. All six fields are required on the constructed `config` constant; the loader fills any field missing from `config.json` with a hard-coded default (see [ftp](#ftp-object)). Field semantics match the table above. There is no runtime validation — values from `config.json` are taken as-is, so a non-numeric `retryAttempts` would propagate as whatever type JSON parsed.

### `SyncConfig`

```ts
export interface SyncConfig {
  autoIndexOnDownload: boolean;
  maxConcurrentDownloads: number;
  delayBetweenSpecs: number;
}
```
*Defined at `src/config.ts:20-24`.*

Shape of the `sync` block of `ServerConfig`. All three fields are required on the constructed `config` constant; missing fields fall through to defaults via `??`. Field semantics match the table above.

### `ServerConfig`

```ts
export interface ServerConfig {
  documentRoot: string;
  indexPath: string;
  downloadsDir: string;
  ftp: FtpConfig;
  sync: SyncConfig;
}
```
*Defined at `src/config.ts:26-32`.*

The top-level configuration shape. It binds the three path scalars (`documentRoot`, `indexPath`, `downloadsDir`) and the two nested blocks (`ftp: FtpConfig`, `sync: SyncConfig`). This is the type of the exported `config` constant (`src/config.ts:95`), and therefore the type the rest of the server imports to read configuration.

### `config` (constant)

```ts
export const config: ServerConfig = buildConfig();
```
*Defined at `src/config.ts:95`.*

The singleton configuration object consumed by the rest of the server. It is constructed once at module-import time by `buildConfig()` (`src/config.ts:53-92`), which performs the layered resolution:

1. `loadConfigFile()` (`src/config.ts:37-46`) reads `<SERVER_ROOT>/config.json`. If the file is missing or JSON-parse fails, the catch block returns `{}` and the loader proceeds with defaults — it does not throw.
2. For each of `documentRoot`, `indexPath`, `downloadsDir`, the env var (if set) takes precedence, then the `config.json` value, then the hard-coded fallback. All three are passed through `resolveMaybeRelative` (`src/config.ts:48-51`) so relative paths become absolute relative to `SERVER_ROOT`.
3. The `ftp` and `sync` blocks are assembled field-by-field against their defaults via `??`, so partial objects in `config.json` are tolerated.

Because `config` is evaluated at import time, environment variables must be set before the module is imported — changing them later has no effect.

### `ensureDataDirs()`

```ts
export function ensureDataDirs(): void
```
*Defined at `src/config.ts:98-106`.*

Ensures the directories implied by the resolved `config` actually exist on disk. Concretely:

- Computes `indexDir = path.dirname(config.indexPath)` (`src/config.ts:99`) and creates it with `fs.mkdirSync(indexDir, { recursive: true })` if it does not already exist (`src/config.ts:100-102`).
- Creates `config.downloadsDir` with `fs.mkdirSync(config.downloadsDir, { recursive: true })` if it does not already exist (`src/config.ts:103-105`).

The `recursive: true` flag means no error is raised if a parent already exists. The function performs no validation on `documentRoot` — it does not create or check that directory. It is intended to be called once on server startup so that the index database and downloads cache have somewhere to land.

---

## Environment-variable overrides

Three environment variables override the path fields of `config.json`. All three are read inside `buildConfig()` (`src/config.ts:56-69`) and take precedence over both `config.json` and the hard-coded fallback. They are read exactly once, at module-import time.

| Variable | Field overridden | Code location | Hard-coded fallback (used when neither env var nor `config.json` supplies a value) |
|---|---|---|---|
| `SPECS_DOCUMENT_ROOT` | `documentRoot` | `src/config.ts:57-58` | `D:\Work\6GStandard` |
| `SPECS_INDEX_PATH` | `indexPath` | `src/config.ts:61-63` | `./index/3gpp-fts.db` |
| `SPECS_DOWNLOADS_DIR` | `downloadsDir` | `src/config.ts:66-68` | `./downloads` |

The `??` operator means an empty-string env var is treated as "not set" (because `??` only falls through on `null`/`undefined`, and `process.env` values are `string | undefined`; an explicit empty string `""` would NOT fall through under `??`). Note however that `resolveMaybeRelative` itself treats an empty string as "use the fallback" (`src/config.ts:49`: `const v = p && p.length > 0 ? p : fallback;`), so an empty-string env var still results in the fallback being used. The same empty-string-to-fallback behavior applies to `config.json` values for the three path fields.

There are no environment-variable overrides for `ftp.*` or `sync.*` fields — those are configurable only through `config.json`.

### Note on the `documentRoot` default divergence

The hard-coded fallback for `documentRoot` is `D:\Work\6GStandard` (`src/config.ts:58`), which is a real Windows path on the authoring machine. The example file instead ships the placeholder `"/path/to/your/3gpp-documents"` (`config.example.json:2`), which is not a usable default. Reviewers should be aware that:

- The example placeholder `"/path/to/your/3gpp-documents"` (`config.example.json:2`) begins with a leading `/`, so it is an **absolute** path on both POSIX and Windows (`path.isAbsolute('/path/to/your/3gpp-documents')` returns `true`). Per `resolveMaybeRelative` (`src/config.ts:48-51`), an absolute value is returned verbatim — it is *not* joined to `SERVER_ROOT`. So a fresh checkout that copies `config.example.json` to `config.json` unedited will resolve `documentRoot` to `/path/to/your/3gpp-documents` on POSIX, or to the drive-rooted `\<path\to\your\3gpp-documents>` interpretation on Windows (the leading `/` anchors at the current drive's root, e.g. `D:\path\to\your\3gpp-documents`), but in either case it is *not* placed under `SERVER_ROOT`. This is consistent with the resolution rule stated at [documentRoot](#documentroot) above.
- A fresh checkout with no `config.json` and no `SPECS_DOCUMENT_ROOT` env var will use the hard-coded `D:\Work\6GStandard`, which is a machine-specific path that will not exist on most other hosts.

Either way, operators are expected to set `documentRoot` explicitly via `config.json` or `SPECS_DOCUMENT_ROOT`.

---

## Path resolution semantics

All three path fields pass through `resolveMaybeRelative` (`src/config.ts:48-51`):

```ts
function resolveMaybeRelative(p: string | undefined, fallback: string): string {
  const v = p && p.length > 0 ? p : fallback;
  return path.isAbsolute(v) ? v : path.resolve(SERVER_ROOT, v);
}
```

- If the supplied value (env var or `config.json` field) is a non-empty string, it is used; otherwise the fallback is substituted.
- If the resulting value is an absolute path, it is returned verbatim.
- If it is a relative path, it is resolved against `SERVER_ROOT`, which is `path.resolve(__dirname, '..')` (`src/config.ts:35`) — i.e. the parent of the directory containing the compiled `config.js`, which is the server root (`dist/`'s parent). At runtime under the compiled build this resolves to the `mcp-server/` directory.

Because resolution happens at module-import time and `__dirname` reflects the location of the compiled `dist/` module, the same `config.json` resolves to the same absolute paths regardless of the process's current working directory.
