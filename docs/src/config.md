# `src/config.ts`

> Source: `00_Workbench_工作台/mcp-server/src/config.ts`

Configuration loader for the **3GPP 6G MCP Server**.

`config.ts` is the single source of truth for runtime configuration. It reads `config.json` from the server root, resolves relative paths against the server directory, applies environment-variable overrides, and exposes one frozen-at-import-time `config` object that the rest of the server consumes. Downstream modules (`sync_specification`, `search_content`, the FTP client, etc.) import `config` and `ensureDataDirs` rather than reading `config.json` or `process.env` themselves.

The module's responsibilities are:

1. Define the configuration shape via three TypeScript interfaces (`FtpConfig`, `SyncConfig`, `ServerConfig`).
2. Locate and parse `config.json` (`loadConfigFile`).
3. Merge file values, environment-variable overrides, and hard-coded defaults into a fully populated `ServerConfig` (`buildConfig`, with helper `resolveMaybeRelative`).
4. Publish the merged result as the exported `config` constant.
5. Provide `ensureDataDirs` to create the on-disk data directories on startup.

---

## Interfaces

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

**Purpose:** Configuration for the 3GPP FTP/archive HTTP client used when downloading specification archives.

| Field | Type | Purpose |
|---|---|---|
| `userAgent` | `string` | `User-Agent` header sent with HTTP requests to `www.3gpp.org`. Defaults to a current Chrome desktop string. |
| `baseUrl` | `string` | Base URL of the 3GPP spec archive (the directory tree containing per-spec version folders). |
| `dynareportUrl` | `string` | Base URL of the 3GPP "dynareport" site (rendered spec pages / metadata). |
| `retryAttempts` | `number` | Number of retry attempts for a failed download request. |
| `retryDelayMs` | `number` | Delay in milliseconds between retry attempts. |
| `timeoutMs` | `number` | Per-request timeout in milliseconds. |

Defined at `config.ts:11-18`.

---

### `SyncConfig`

```ts
export interface SyncConfig {
  autoIndexOnDownload: boolean;
  maxConcurrentDownloads: number;
  delayBetweenSpecs: number;
}
```

**Purpose:** Configuration for the spec-sync pipeline (`sync_specification` and related tooling) that downloads specification archives and indexes their text.

| Field | Type | Purpose |
|---|---|---|
| `autoIndexOnDownload` | `boolean` | Whether a freshly downloaded spec is automatically extracted and added to the full-text index. |
| `maxConcurrentDownloads` | `number` | Maximum number of concurrent download operations. `1` (the default) means sequential downloads. |
| `delayBetweenSpecs` | `number` | Delay in milliseconds between downloading consecutive specs, used to throttle load on the 3GPP server. |

Defined at `config.ts:20-24`.

---

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

**Purpose:** The top-level configuration shape for the entire MCP server. This is the type of the exported `config` constant and the return type of `buildConfig`. It binds together the three path settings that locate the server's on-disk data with the two sub-configs that tune FTP behaviour and the sync pipeline.

| Field | Type | Purpose |
|---|---|---|
| `documentRoot` | `string` | Absolute path to the project document root (the workspace that contains `00_Workbench_工作台/`, the catalog, and other project material). Used to locate the curated spec catalog and related files. |
| `indexPath` | `string` | Absolute path to the SQLite full-text-search database file (e.g. `.../index/3gpp-fts.db`). |
| `downloadsDir` | `string` | Absolute path to the directory where spec `.zip` archives are stored after download. |
| `ftp` | `FtpConfig` | FTP/HTTP client configuration. |
| `sync` | `SyncConfig` | Spec-sync pipeline configuration. |

Defined at `config.ts:26-32`. `ServerConfig` is the only config type other modules need to refer to; `FtpConfig` and `SyncConfig` are reachable through its `ftp` and `sync` fields.

---

## Internal constants

### `SERVER_ROOT`

```ts
const SERVER_ROOT = path.resolve(__dirname, '..');
```

**Purpose:** Absolute path to the server root — the parent of the compiled `dist/` directory in which `config.js` lives. It is the anchor for two things:

- Locating `config.json` (expected at `${SERVER_ROOT}/config.json`).
- Resolving relative path values found in `config.json` or environment variables into absolute paths.

Declared at `config.ts:35`. Not exported.

---

## Internal functions

### `loadConfigFile`

```ts
function loadConfigFile(): Partial<ServerConfig>
```

**Purpose:** Read and parse `${SERVER_ROOT}/config.json`.

**Parameters:** None.

**Return value:** A `Partial<ServerConfig>` — whatever the JSON file contains, which may be empty or partial. On any error (file missing, unreadable, or containing invalid JSON) the function swallows the exception and returns `{}` so that `buildConfig` can fall back to defaults.

**Role in the module:** This is the first step of the merge pipeline — it produces the file-sourced layer that `buildConfig` later overrides with environment variables and augments with defaults. Defined at `config.ts:37-46`.

---

### `resolveMaybeRelative`

```ts
function resolveMaybeRelative(p: string | undefined, fallback: string): string
```

**Purpose:** Normalise a path-setting into an absolute path, applying a fallback when the supplied value is missing or empty.

**Parameters:**

| Name | Type | Meaning |
|---|---|---|
| `p` | `string \| undefined` | The candidate path (typically `process.env.SPECS_*` or a field from `config.json`). |
| `fallback` | `string` | The default path to use when `p` is `undefined` or an empty string. May be absolute or relative. |

**Return value:** An absolute path string. If the chosen value is already absolute, it is returned unchanged; if it is relative, it is resolved against `SERVER_ROOT`. If `p` is absent or empty, `fallback` is used (and resolved the same way).

**Role in the module:** Centralises the "env var → file value → default, then make absolute" logic used for the three path fields (`documentRoot`, `indexPath`, `downloadsDir`). Defined at `config.ts:48-51`. Not exported.

---

### `buildConfig`

```ts
function buildConfig(): ServerConfig
```

**Purpose:** Produce the fully populated, ready-to-use `ServerConfig` by layering defaults, `config.json` values, and environment-variable overrides.

**Parameters:** None.

**Return value:** A complete `ServerConfig` object.

**Resolution order (highest priority first):**

1. **Environment variables** — for the three path fields, taken from `process.env`.
2. **`config.json`** — values loaded by `loadConfigFile()`.
3. **Hard-coded defaults** — used when neither of the above supplies a value.

### Path fields and their env-var overrides

Each path field is resolved through `resolveMaybeRelative`, so a relative value from any source is turned into an absolute path anchored at `SERVER_ROOT`.

| Field | Env var | File field | Default | Source |
|---|---|---|---|---|
| `documentRoot` | `SPECS_DOCUMENT_ROOT` | `file.documentRoot` | `D:\Work\6GStandard` | `config.ts:56-59` |
| `indexPath` | `SPECS_INDEX_PATH` | `file.indexPath` | `./index/3gpp-fts.db` | `config.ts:61-64` |
| `downloadsDir` | `SPECS_DOWNLOADS_DIR` | `file.downloadsDir` | `./downloads` | `config.ts:66-69` |

The environment variables are read with the `??` nullish-coalescing operator (`config.ts:57`, `config.ts:62`, `config.ts:67`), so an env var takes precedence over the file value only when it is defined and non-null; an empty-string env var is *not* treated as missing by `??` but is later replaced by the fallback inside `resolveMaybeRelative` (which treats `''` as absent at `config.ts:49`).

> **Hard-coded fallback for `documentRoot`.** When neither `SPECS_DOCUMENT_ROOT` nor `config.json` supplies a `documentRoot`, the loader falls back to the absolute Windows path `D:\Work\6GStandard` (`config.ts:58`). Because this value is already absolute, `resolveMaybeRelative` returns it verbatim. This fallback is project-specific and assumes the server is running on the same machine that holds the workspace; on other hosts set `SPECS_DOCUMENT_ROOT` or `config.json`'s `documentRoot`.

### Sub-config defaults

The `ftp` and `sync` sub-objects do **not** support environment-variable overrides; they are populated entirely from `config.json` with hard-coded defaults for each missing field. The file's `ftp`/`sync` objects are treated as `Partial<...>` (`config.ts:71-72`), so any subset of fields may be supplied.

**`ftp` defaults** (`config.ts:78-85`):

| Field | Default |
|---|---|
| `userAgent` | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36` |
| `baseUrl` | `https://www.3gpp.org/ftp/Specs/archive` |
| `dynareportUrl` | `https://www.3gpp.org/dynareport` |
| `retryAttempts` | `3` |
| `retryDelayMs` | `2000` |
| `timeoutMs` | `30000` |

**`sync` defaults** (`config.ts:86-90`):

| Field | Default |
|---|---|
| `autoIndexOnDownload` | `true` |
| `maxConcurrentDownloads` | `1` |
| `delayBetweenSpecs` | `1000` |

**Role in the module:** `buildConfig` is the constructor for the exported `config` object. It is called exactly once, at module-import time (`config.ts:95`). Defined at `config.ts:53-92`. Not exported.

---

## Exported symbols

### `config`

```ts
export const config: ServerConfig = buildConfig();
```

**Purpose:** The single, shared configuration object for the MCP server, computed once when the module is first imported and then reused by every other module.

**Type:** `ServerConfig`.

**Value:** The result of `buildConfig()` — a fully populated, paths-as-absolute-strings configuration with env-var overrides and defaults already applied.

**Lifecycle:** Loaded once at module import time (see the comment at `config.ts:94`). The value is not frozen or sealed, but it is treated as read-only by convention; nothing in the server mutates it after import.

**Role in the module:** This is the public face of `config.ts`. Importers do `import { config } from './config'` and read fields such as `config.documentRoot`, `config.indexPath`, `config.ftp.baseUrl`, etc. Defined at `config.ts:95`.

---

### `ensureDataDirs`

```ts
export function ensureDataDirs(): void
```

**Purpose:** Make sure the on-disk directories that back `config.indexPath` and `config.downloadsDir` exist, creating them (and any missing parents) if necessary. Intended to be called once during server startup before any tool tries to read or write those locations.

**Parameters:** None.

**Return value:** `void`.

**Behaviour:**

1. Computes `indexDir = path.dirname(config.indexPath)` — the directory that must contain the SQLite index file (`config.ts:99`).
2. If `indexDir` does not exist, creates it with `fs.mkdirSync(indexDir, { recursive: true })` (`config.ts:100-102`).
3. If `config.downloadsDir` does not exist, creates it the same way (`config.ts:103-105`).

Both checks use `fs.existsSync` and are idempotent: calling `ensureDataDirs` when the directories already exist is a no-op. Because `mkdirSync` is invoked with `{ recursive: true }`, missing intermediate parent directories are created as well.

Note that `ensureDataDirs` does **not** create `config.documentRoot`; it assumes the document root (typically the workspace directory) already exists, which is consistent with the `D:\Work\6GStandard` fallback being a pre-existing project path.

**Role in the module:** Companion to `config` — `config` tells the server *where* its data lives, and `ensureDataDirs` makes sure those locations *exist* before they are used. Defined at `config.ts:98-106`.

---

## Module-level flow

Putting the pieces together, importing `config.ts` causes the following to happen, in order:

1. `SERVER_ROOT` is computed from `__dirname` (`config.ts:35`).
2. `buildConfig()` is invoked (`config.ts:95`):
   1. `loadConfigFile()` reads `${SERVER_ROOT}/config.json` (or returns `{}` on any error).
   2. The three path fields are resolved via `resolveMaybeRelative`, with env vars `SPECS_DOCUMENT_ROOT`, `SPECS_INDEX_PATH`, `SPECS_DOWNLOADS_DIR` taking precedence over file values, and the hard-coded defaults (including `D:\Work\6GStandard` for `documentRoot`) as a last resort.
   3. The `ftp` and `sync` sub-objects are assembled from file values plus per-field defaults.
3. The resulting `ServerConfig` is bound to the exported `config` constant.

After import, callers can invoke `ensureDataDirs()` (typically once at startup) to materialise the index and downloads directories on disk.

---

## Environment variable reference

| Variable | Affected field | Effect |
|---|---|---|
| `SPECS_DOCUMENT_ROOT` | `config.documentRoot` | Overrides `config.json`'s `documentRoot`; falls back to `D:\Work\6GStandard` if unset. Read at `config.ts:57`. |
| `SPECS_INDEX_PATH` | `config.indexPath` | Overrides `config.json`'s `indexPath`; falls back to `./index/3gpp-fts.db` if unset. Read at `config.ts:62`. |
| `SPECS_DOWNLOADS_DIR` | `config.downloadsDir` | Overrides `config.json`'s `downloadsDir`; falls back to `./downloads` if unset. Read at `config.ts:67`. |

There are no environment-variable overrides for `ftp` or `sync` fields; those are configurable only via `config.json`.

---

## Notes for reviewers

- **Side effects at import time.** Importing `config.ts` performs synchronous filesystem I/O (`readFileSync` of `config.json`) and binds the result to `config`. Modules that import it should not expect to be able to reconfigure the server by mutating `process.env` after import — the env vars are read once, during `buildConfig`.
- **Error tolerance of `loadConfigFile`.** A missing or malformed `config.json` is not fatal; the catch-all at `config.ts:42-45` returns `{}`, and `buildConfig` proceeds with defaults. This makes the server runnable without a `config.json` at all, but it also means a *typo* in an otherwise-present `config.json` will silently be ignored rather than reported. Reviewers should be aware that misconfiguration of `config.json` may present as "the defaults are being used" rather than as an explicit error.
- **Project-specific fallback.** The `D:\Work\6GStandard` default for `documentRoot` (`config.ts:58`) ties the default configuration to a specific Windows workspace path. Any deployment that does not live under that path must set `SPECS_DOCUMENT_ROOT` or supply `documentRoot` in `config.json`.
- **Path resolution anchor.** All relative paths — whether from env vars, `config.json`, or the hard-coded defaults — are resolved against `SERVER_ROOT` (the compiled server's parent directory), not against the current working directory. This means `./index/3gpp-fts.db` resolves to `${SERVER_ROOT}/index/3gpp-fts.db` regardless of where the server process is launched from.
