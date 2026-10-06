# `src/api/ftp-client.ts`

> Source: `00_Workbench_工作台/mcp-server/src/api/ftp-client.ts`

3GPP FTP archive client for the `3gpp-6g-mcp-server` project. This module wraps the public 3GPP FTP archive with an HTTP client (axios) and exposes a small, typed surface for listing specification series, enumerating per-spec versions, and downloading version archives. It is the single I/O boundary between the MCP tools and the upstream 3GPP archive.

## Access pattern

The 3GPP archive is a plain HTTP-served directory tree rooted at `config.ftp.baseUrl`. Three request shapes are used (documented in the file header at `ftp-client.ts:7-22`):

1. **Series listing** — `GET {baseUrl}/{NN}_series/` returns HTML whose anchors link to per-spec subdirectories in dotted form (e.g. `23.700-40`).
2. **Per-spec listing** — `GET {baseUrl}/{NN}_series/{dotted}/` returns HTML whose anchors link to the spec's downloadable `.zip` archives (e.g. `23700-40-200.zip`).
3. **File download** — `GET {baseUrl}/{NN}_series/{dotted}/{file}.zip` returns the binary zip, which in turn wraps the authoritative `.docx`.

### Naming rules

- **Dotted directories.** Subdirectory names MUST keep their dotted form (`"23.700-40"`, never `"23700-40"`). The dotted form is the URL path segment; the dot-stripped form is only used in filenames (`ftp-client.ts:13`, `ftp-client.ts:84-95`).
- **`.zip`-only file serving.** The archive serves files only as `.zip`; requesting `.docx`/`.doc` directly yields HTTP 403 (`ftp-client.ts:14`). Callers must download the zip and extract the inner document themselves — see `downloadVersion`.
- **Browser User-Agent required.** The preconfigured axios instance sends a browser-like `User-Agent` plus standard `Accept` / `Accept-Language` headers from `config.ftp`; non-browser agents are rejected upstream (`ftp-client.ts:15`, `ftp-client.ts:104-108`).

### Version-code encoding

Filenames follow `<filePrefix>-<code>.zip` where `<code>` encodes the release and minor version (`ftp-client.ts:17-22`, decoded in `decodeVersionCode` at `ftp-client.ts:43-81`):

- **Letter first character** → formal release. `release = 10 + (ord(X) - ord('a'))`, so `a` = Rel-10, …, `j` = Rel-19. The remaining digits are the zero-padded minor version. `isDraft = false`.
- **Digit first character** → early/draft version. The first digit is the major version; remaining digits are the minor version. `release` and `releaseLabel` are `null`, `isDraft = true`.
- Codes shorter than two characters, or with an unrecognized first character, fall back to a degenerate draft record (`majorVersion: 0, minorVersion: 0, isDraft: true`).

## Dependencies

- `axios` (and `AxiosInstance` type) for HTTP (`ftp-client.ts:1`).
- `../config` for `config.ftp.baseUrl`, `timeoutMs`, `userAgent`, `retryAttempts`, and `retryDelayMs` (`ftp-client.ts:2`). All network behavior (base URL, headers, timeout, retry policy) is driven through this config object, so the client itself has no hard-coded endpoint.

## Exports

### `SpecVersion` (interface) — `ftp-client.ts:24`

A parsed, downloadable version of a single specification.

| Field | Type | Description |
|---|---|---|
| `versionCode` | `string` | Raw code extracted from the filename, e.g. `"200"`, `"j00"`, `"h00"`. |
| `filename` | `string` | Full archive filename, e.g. `"23700-40-200.zip"`. |
| `downloadUrl` | `string` | Absolute URL for the `.zip` archive. |
| `release` | `number \| null` | Release number for letter codes (e.g. `17`), `null` for numeric/draft codes. |
| `releaseLabel` | `string \| null` | Human label such as `"Rel-17"`; `null` for drafts. |
| `majorVersion` | `number` | Major version (only meaningful for numeric/draft codes; `0` for letter codes). |
| `minorVersion` | `number` | Zero-padded minor version from the trailing digits. |
| `isDraft` | `boolean` | `true` for numeric-first codes, `false` for release-letter codes. |

Produced by `FtpClient.getSpecVersions`; consumed by tools that need to present or pick a version.

### `SeriesEntry` (interface) — `ftp-client.ts:35`

A single specification directory under a series.

| Field | Type | Description |
|---|---|---|
| `specDir` | `string` | Dotted directory name, e.g. `"23.700-40"`. |
| `specNumber` | `string` | Normalized spec number; equal to `specDir` for valid matches. |
| `url` | `string` | Absolute URL of the per-spec listing. |

Produced by `FtpClient.getSeriesListing`.

### `specToPaths` (function) — `ftp-client.ts:89`

Converts a normalized spec number into the three string fragments needed to build archive URLs and filenames.

```ts
function specToPaths(specNumber: string): { series: string; dottedDir: string; filePrefix: string }
```

- **Parameters**
  - `specNumber` — normalized spec number such as `"23.700-40"` or `"38.843"`.
- **Returns** `{ series, dottedDir, filePrefix }`:
  - `series` — leading numeric series, e.g. `"23"` (the segment before the first `.`).
  - `dottedDir` — the dotted directory name, equal to the input `specNumber`; this is the path segment used in URLs.
  - `filePrefix` — the dot-stripped form used in filenames, e.g. `"23700-40"`.
- **Role.** Centralizes the dotted-vs-stripped distinction so that `getSpecVersions` and `downloadVersion` build paths consistently. Pure and side-effect-free.

### `FtpClient` (class) — `ftp-client.ts:97`

The archive client. Owns a preconfigured axios instance (`httpClient`, `ftp-client.ts:98`) constructed in the constructor (`ftp-client.ts:100-112`) with `config.ftp.baseUrl` as the base URL, `config.ftp.timeoutMs` timeout, browser-style headers, `responseType: 'text'`, and `maxRedirects: 5`. Listing methods reuse this text-mode instance; `downloadVersion` overrides `responseType` to `arraybuffer` per call.

#### `getSeriesListing(series)` — `ftp-client.ts:118`

```ts
async getSeriesListing(series: string): Promise<SeriesEntry[]>
```

Lists all spec directories beneath a series.

- **Parameters** — `series`: the numeric series prefix, e.g. `"23"` (request path `/{series}_series/`).
- **Returns** — `SeriesEntry[]`, sorted lexicographically by `specDir` (`ftp-client.ts:145`). Each entry's `url` is the absolute per-spec listing URL.
- **Behavior** — fetches the series index HTML via `fetchWithRetry`, then scans `href="..."` attributes with `/href="([^"]*?)"/gi` (`ftp-client.ts:125`). For each link it strips the trailing slash and query/fragment, takes the last path segment, and keeps only segments matching `^\d{2}\.\d{3}(-\d{2})?$` (`ftp-client.ts:136`) — i.e. dotted `NN.NNN` or `NN.NNN-NN`. A `Set` deduplicates by directory name.

#### `getSpecVersions(specNumber)` — `ftp-client.ts:152`

```ts
async getSpecVersions(specNumber: string): Promise<SpecVersion[]>
```

Enumerates every downloadable version of a specification.

- **Parameters** — `specNumber`: e.g. `"23.700-40"` or `"38.843"`.
- **Returns** — `SpecVersion[]`, sorted so that non-draft (release-letter) versions come first in descending release order, followed by drafts in descending `majorVersion` then `minorVersion` order (`ftp-client.ts:188-193`).
- **Behavior** — splits `specNumber` via `specToPaths`, fetches `/{series}_series/{dottedDir}/`, and scans anchors for filenames that both end in `.zip` and start with `filePrefix + '-'` (`ftp-client.ts:167`). Each match is parsed with a `filePrefix`-anchored regex (escaped via the module-private `escapeRegex`) to recover the version code, which is then decoded by `decodeVersionCode`. Results are deduplicated by `versionCode`.

#### `downloadVersion(specNumber, versionCode)` — `ftp-client.ts:200`

```ts
async downloadVersion(specNumber: string, versionCode: string): Promise<Buffer>
```

Downloads a specific version's `.zip` archive.

- **Parameters**
  - `specNumber` — normalized spec number, e.g. `"23.700-40"`.
  - `versionCode` — the `versionCode` field of a `SpecVersion` returned by `getSpecVersions` (e.g. `"200"`, `"j00"`).
- **Returns** — a Node `Buffer` containing the raw zip bytes. The caller is responsible for extracting the inner `.docx`.
- **Behavior** — builds the filename `${filePrefix}-${versionCode}.zip` and issues an `arraybuffer` GET to `/{series}_series/{dottedDir}/{filename}` (`ftp-client.ts:202-208`). Throws `Download failed: HTTP <status> for <url>` on any non-200 status (`ftp-client.ts:210-212`). Note that this method does **not** go through `fetchWithRetry` and so is single-attempt.

#### `getLatestVersion(specNumber)` — `ftp-client.ts:221`

```ts
async getLatestVersion(specNumber: string): Promise<SpecVersion | null>
```

Returns the most recent version of a spec, preferring formal releases over drafts.

- **Parameters** — `specNumber`: e.g. `"23.700-40"`.
- **Returns** — the first element of `getSpecVersions`'s sorted result (highest release, or the highest draft if no releases exist), or `null` if the spec has no versions at all.
- **Behavior** — a thin convenience wrapper over `getSpecVersions` that relies on its sort order (`ftp-client.ts:222-225`).

#### Private: `fetchWithRetry(url)` — `ftp-client.ts:231`

```ts
private async fetchWithRetry(url: string): Promise<string>
```

Internal helper used by both listing methods. Retries up to `config.ftp.retryAttempts` times with linear backoff (`config.ftp.retryDelayMs * (attempt + 1)`). HTTP 403 is treated as a hard block and re-thrown immediately without further retries (`ftp-client.ts:240-243`, `ftp-client.ts:246`); other failures (network errors or non-200/non-403 statuses) are recorded as `lastError` and retried. Throws the last error if all attempts fail.

### `getFtpClient` (function) — `ftp-client.ts:270`

```ts
function getFtpClient(): FtpClient
```

Module-level singleton factory. Lazily constructs a single `FtpClient` instance on first call and returns the same instance thereafter (`ftp-client.ts:268-275`). Use this rather than `new FtpClient()` so that the axios connection pool, headers, and retry configuration are shared across all MCP tool invocations in the process.

## Module-private helpers

These are not exported but are referenced by the documentation above for completeness.

- `decodeVersionCode(code)` (`ftp-client.ts:43-81`) — implements the letter/digit version-code decoding described in *Version-code encoding*. Returns `{ release, releaseLabel, majorVersion, minorVersion, isDraft }`.
- `RELEASE_LETTER_BASE` (`ftp-client.ts:41`) — `'a'.charCodeAt(0)`; the offset for the `a` = Rel-10 mapping.
- `escapeRegex(s)` (`ftp-client.ts:259-261`) — escapes regex metacharacters in `filePrefix` before it is interpolated into the version-code regex.
- `sleep(ms)` (`ftp-client.ts:263-265`) — promise-based `setTimeout` used by `fetchWithRetry`'s backoff.

## Notes for reviewers

- The class is intentionally stateless beyond its configured axios instance; all listing methods re-fetch on each call. Caching of series/version listings — if added — should live above this module so that this client remains a thin mirror of the upstream archive.
- `downloadVersion` is the only method that does not retry. If a download is interrupted mid-stream the caller must re-invoke; consider wrapping with an outer retry if resilience is required.
- The HTML parsers are regex-based and assume the archive's current link format (`href="..."`). A change in the archive's HTML structure would require updating the link regexes at `ftp-client.ts:125` and `ftp-client.ts:158`.
