# Build, Deploy, and Test

> **Sources:** `00_Workbench_工作台/mcp-server/package.json`, `00_Workbench_工作台/mcp-server/tsconfig.json`, `00_Workbench_工作台/mcp-server/README.md`, `00_Workbench_工作台/mcp-server/bin/run.js`, and the `dist/` build output.

This document is the single reference for how the `3gpp-6g-mcp-server` is built, how the published package is consumed by an MCP client, what its runtime dependencies are, and what its testing story is. The per-module references in `src/` document the source; this file documents the build pipeline and the deployable artifact. For the runtime architecture and tool surface, see [`architecture.md`](./architecture.md) and [`mcp-tools.md`](./mcp-tools.md); for the deployed entry-point shim, see [`bin/run.md`](./bin/run.md).

---

## Package identity

Declared in `package.json`:

| Field | Value | Location |
|---|---|---|
| `name` | `3gpp-6g-mcp-server` | `package.json:2` |
| `version` | `1.0.0` | `package.json:3` |
| `description` | `3GPP 6G MCP Server — real FTP download + local full-text search over 6G specifications` | `package.json:4` |
| `main` | `dist/index.js` | `package.json:5` |
| `type` | `commonjs` | `package.json:6` |
| `license` | `BSD-3-Clause` | `package.json:28` |
| `engines.node` | `>=18.0.0` | `package.json:29-31` |

The `bin` registration (`package.json:7-9`) maps the CLI name `3gpp-6g-mcp` to `./bin/run.js`, so an `npm install` of this package (or `npm link`) puts a `3gpp-6g-mcp` command on the PATH that ultimately runs `dist/index.js`. See [Deployed entry chain](#deployed-entry-chain) below.

---

## Build configuration (`tsconfig.json`)

The TypeScript compiler config (`tsconfig.json`) compiles `src/` into `dist/` as CommonJS:

| Option | Value | Effect |
|---|---|---|
| `target` | `ES2022` (`tsconfig.json:3`) | Emit modern JS; Node ≥ 18 supports all of it. |
| `module` | `node18` (`tsconfig.json:4`) | Emit Node-flavored CommonJS (`require`/`module.exports`). |
| `moduleResolution` | `Node16` (`tsconfig.json:12`) | Node's classic resolution, matching `module: node18`. |
| `outDir` | `./dist` (`tsconfig.json:6`) | Compiled `.js` + `.js.map` land in `dist/`. |
| `rootDir` | `./src` (`tsconfig.json:7`) | Source root; the `src/` prefix is dropped in `dist/`. |
| `strict` | `true` (`tsconfig.json:8`) | Full strict type-checking. |
| `sourceMap` | `true` (`tsconfig.json:14`) | Emits `.js.map` alongside each `.js`. |
| `declaration` | `false` (`tsconfig.json:13`) | No `.d.ts` emitted — the package does not publish a typed API. |
| `resolveJsonModule` | `true` (`tsconfig.json:15`) | Lets `spec-catalog.ts` import the catalog JSON directly. |
| `include` | `["src/**/*"]` (`tsconfig.json:18`) | Compiles everything under `src/`. |
| `exclude` | `["node_modules", "dist"]` (`tsconfig.json:19`) | Never compiles deps or the previous build. |

Because `module` is `node18` and `package.json:6` is `"type": "commonjs"`, the emitted `dist/index.js` is a CommonJS module, and the `require.main === module` entry-point guard in `src/index.ts:360` is the correct runtime check for the published package. An ESM build is not supported by the current configuration.

---

## npm scripts (`package.json:10-17`)

| Script | Command | Purpose |
|---|---|---|
| `build` | `tsc && node -e "require('fs').cpSync('src/data','dist/data',{recursive:true})"` (`package.json:11`) | Compile TypeScript, then copy `src/data/` into `dist/data/` so the catalog JSON ships with the build. |
| `dev` | `tsc --watch` (`package.json:12`) | Recompile on save. |
| `start` | `node dist/index.js` (`package.json:13`) | Run the compiled server directly over stdio. |
| `mcp` | `node dist/index.js` (`package.json:14`) | Alias of `start`; the name MCP clients expect. |
| `sync-all` | `node dist/scripts/sync-all-6g.js` (`package.json:15`) | Run the batch-sync CLI (see [`src/scripts/sync-all-6g.md`](./src/scripts/sync-all-6g.md)). |
| `clean` | `rmdir /s /q dist 2>nul & rmdir /s /q index 2>nul` (`package.json:16`) | Remove the `dist/` build output and `index/` SQLite directory. Windows-only syntax. |

There is **no `test` script**. See [Testing](#testing) below.

### Building from source

```bash
git clone <repo-url> mcp-server
cd mcp-server
npm install
npm run build
```

`npm run build` is the canonical build command. It runs `tsc` (which reads `tsconfig.json` and emits `dist/`), then copies `src/data/6g-spec-catalog.json` into `dist/data/`. The data copy is required because `spec-catalog.ts` resolves the catalog relative to the compiled module's location (see [`config.md` → `SERVER_ROOT`](./config.md#path-resolution-semantics)).

---

## Build output (`dist/`)

`npm run build` produces the following tree under `dist/` (verified by `ls dist/`, `ls dist/api/`, `ls dist/data/`, `ls dist/scripts/`):

```
dist/
├── index.js                  # compiled from src/index.ts — package main, MCP entry
├── index.js.map
├── config.js                 # compiled from src/config.ts
├── config.js.map
├── api/
│   ├── api-manager.js        # compiled from src/api/api-manager.ts
│   ├── api-manager.js.map
│   ├── docx-extractor.js     # compiled from src/api/docx-extractor.ts
│   ├── docx-extractor.js.map
│   ├── ftp-client.js         # compiled from src/api/ftp-client.ts
│   ├── ftp-client.js.map
│   ├── search-index.js       # compiled from src/api/search-index.ts
│   ├── search-index.js.map
│   ├── spec-catalog.js       # compiled from src/api/spec-catalog.ts
│   └── spec-catalog.js.map
├── data/
│   └── 6g-spec-catalog.json  # copied from src/data/ by the build script
└── scripts/
    ├── sync-all-6g.js        # compiled from src/scripts/sync-all-6g.ts
    └── sync-all-6g.js.map
```

The `dist/` directory is a build artifact, not source. The TypeScript source under `src/` is authoritative; `dist/` is regenerated by `npm run build` and removed by `npm run clean`. Source maps (`.js.map`) are emitted for every module so stack traces in the compiled output can be mapped back to the TypeScript source. `dist/` is not checked in.

---

## Deployed entry chain

The runtime chain from the registered bin to the compiled server is:

```
3gpp-6g-mcp (bin, package.json:8)  →  bin/run.js  →  dist/index.js  (compiled from src/index.ts)
```

`bin/run.js` is a two-line Node shim (`#!/usr/bin/env node` shebang plus `require('../dist/index.js')`, `bin/run.js:1-2`). Its entire purpose is to be the `bin` target so `npm` registers a `3gpp-6g-mcp` command; the real work is in `dist/index.js`. The per-file reference for the shim is [`bin/run.md`](./bin/run.md).

When `dist/index.js` is loaded, the `require.main === module` guard at `src/index.ts:360` fires (because `bin/run.js` `require`s it as the entry, making it `require.main`), constructs `ThreeGPP6GMCPServer`, and calls `run()` to bind a `StdioServerTransport` to stdin/stdout. The full wiring is documented in [`src/index.md`](./src/index.md) and [`architecture.md`](./architecture.md).

---

## Consuming the package from an MCP client

The server speaks MCP over **stdio** (the standard MCP transport). It is configured by editing `config.json` at the package root — see [`config.md`](./config.md) for the full configuration reference and [`README.md`](../README.md) for the quickstart.

After `npm install` (or `npm link`), register the server in the MCP client's config. Two equivalent forms work:

**Form A — invoke the bin directly** (works after `npm link` or a global install):

```json
{
  "mcpServers": {
    "3gpp-6g": {
      "command": "3gpp-6g-mcp"
    }
  }
}
```

**Form B — point `node` at the compiled entry** (works for a local clone without linking):

```json
{
  "mcpServers": {
    "3gpp-6g": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"]
    }
  }
}
```

Both forms are documented in `README.md:75-98`. In either case the server reads `config.json` from the package root at startup; environment variables `SPECS_DOCUMENT_ROOT`, `SPECS_INDEX_PATH`, and `SPECS_DOWNLOADS_DIR` override the path fields (see [`config.md` → Environment-variable overrides](./config.md#environment-variable-overrides)).

---

## Runtime dependencies

Declared in `package.json:32-38`. All five are `dependencies` (not `devDependencies`), so they ship with the published package.

### Production dependencies (`dependencies`)

| Package | Version range | Location | Purpose | Required at runtime? |
|---|---|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.18.0` (`package.json:33`) | Imported by `src/index.ts:1-8` | The MCP SDK — `Server`, `StdioServerTransport`, request schemas, `McpError`/`ErrorCode`. The protocol layer the entire server is built on. | Yes — required for the server to boot. |
| `axios` | `^1.6.0` (`package.json:34`) | Imported by `src/api/ftp-client.ts` | HTTP client for fetching spec archives and dynareport pages from `www.3gpp.org`. | Yes — required for any FTP/download tool. |
| `better-sqlite3` | `^13.0.0` (`package.json:35`) | Imported by `src/api/search-index.ts` | Native SQLite binding backing the FTS5 full-text index. Ships prebuilt binaries for Windows/macOS/Linux. | Yes — required for `search_content`, `find_implementation_requirements`, and `rebuild_index`. |
| `mammoth` | `^1.8.0` (`package.json:36`) | Imported by `src/api/docx-extractor.ts` | `.docx` → HTML/text extraction. | Yes — required for the extract step of `sync_specification`. |
| `adm-zip` | `^0.5.16` (`package.json:37`) | Imported by `src/api/docx-extractor.ts` | `.zip` archive handling — opens the downloaded spec `.zip` to reach the embedded `.docx`. | Yes — required for the extract step of `sync_specification`. |

### Development dependencies (`devDependencies`)

Declared in `package.json:39-44`. These are needed only to build, not to run the published package.

| Package | Version range | Location | Purpose |
|---|---|---|---|
| `@types/node` | `^24.5.0` (`package.json:40`) | `tsconfig.json:16` (`"types": ["node"]`) | Node.js type definitions for the compiler. |
| `@types/better-sqlite3` | `^7.6.11` (`package.json:41`) | Consumed by `src/api/search-index.ts` | Types for the `better-sqlite3` native binding. |
| `@types/adm-zip` | `^0.5.5` (`package.json:42`) | Consumed by `src/api/docx-extractor.ts` | Types for `adm-zip`. |
| `typescript` | `^5.9.2` (`package.json:43`) | `tsc` compiler | The TypeScript compiler invoked by `npm run build`. |

### Node.js standard-library modules

Beyond the npm packages, the source imports several Node.js built-ins. These are not declared in `package.json` (they ship with Node) but are worth listing for reviewers tracing imports:

| Built-in | Used by | Reference |
|---|---|---|
| `path` | `src/config.ts`, `src/api/spec-catalog.ts`, `src/api/search-index.ts`, `src/api/docx-extractor.ts` | `api-manager.md:18`; `config.md` |
| `fs` | `src/config.ts`, `src/api/spec-catalog.ts`, `src/api/search-index.ts`, `src/api/docx-extractor.ts` | `config.md` (`ensureDataDirs`) |
| `os` | `src/api/api-manager.ts` | `api-manager.md:18` |
| `child_process` | `src/api/docx-extractor.ts` (`execFileSync`) | `docx-extractor.md:30-35` |

### Optional / best-effort runtime dependency: LibreOffice

LibreOffice is the **only** dependency called out as best-effort. `docx-extractor.ts` uses `child_process.execFileSync` to invoke the `soffice` binary (LibreOffice's CLI) as a fallback for older `.doc` files that `mammoth` cannot parse. This is documented in `docx-extractor.md:23` and `docx-extractor.md:30-35`. LibreOffice is **not** declared in `package.json` — it is an external system dependency. If `soffice` is not on `PATH`, the fallback path fails gracefully; the extractor does not crash the server. No other dependency has this best-effort status.

### Version pinning

All version ranges in `package.json` are caret ranges (`^x.y.z`), which allow minor and patch updates within the same major. There are no exact pins (`"x.y.z"`) and no `package-lock.json`-enforced locks documented here, though a `package-lock.json` is present at the package root (verified by `ls`). Reviewers who need reproducible installs should rely on the lockfile rather than the `package.json` ranges.

---

## Testing

**There is no test suite.** This was verified during this documentation pass by:

- Reading `package.json:10-17`: the `scripts` block defines `build`, `dev`, `start`, `mcp`, `sync-all`, and `clean` — there is **no `test` script**.
- Running `find . -path ./node_modules -prune -o \( -name "*.test.ts" -o -name "*.test.js" -o -name "*.spec.ts" -o -name "*.spec.js" -o -name "test" -o -name "tests" -o -name "__tests__" \) -print` from the package root: it returned no results.

The only testing-adjacent mention in the source docs is `src/index.md:153`, which notes that the `require.main === module` guard makes the `ThreeGPP6GMCPServer` class "importable for testing" — i.e. the design does not preclude unit tests, but none have been written. A reviewer asking "where are the tests?" gets the answer: there are none in this repository as of this documentation pass.

The closest thing to an end-to-end smoke test is the batch-sync CLI (`npm run sync-all`, documented in [`src/scripts/sync-all-6g.md`](./src/scripts/sync-all-6g.md)) and the `README.md` "Typical workflow" (`README.md:161-169`), which exercises `search_specifications` → `get_specification_details` → `sync_specification` → `search_content` → `find_implementation_requirements` against the live FTP archive. These are manual workflows, not automated tests.

---

## Reviewable root artifacts

These files live at the package root and are part of the review surface but are not under `docs/` or `src/`. They are documented here so reviewers can locate them:

| Artifact | Purpose | Documented in |
|---|---|---|
| `package.json` | Package identity, scripts, dependencies, bin registration. | This file (§[Package identity](#package-identity), §[npm scripts](#npm-scripts-packagejson10-17), §[Runtime dependencies](#runtime-dependencies)). |
| `tsconfig.json` | TypeScript compiler config. | This file (§[Build configuration](#build-configuration-tsconfigjson)). |
| `config.example.json` | Documented configuration template. | [`config.md`](./config.md). |
| `config.json` | Live configuration at the package root (gitignored per `README.md:233`). Differs from `config.example.json` only in `documentRoot` (set to `D:\Work\6GStandard`, `config.json:2`). See [`config.md` → documentRoot default divergence](./config.md#note-on-the-documentroot-default-divergence). | [`config.md`](./config.md). |
| `README.md` | User-facing quickstart, requirements, installation, MCP-client config, tool summary, architecture overview. | Not separately documented — it *is* the user-facing overview. Referenced throughout this file. |
| `bin/run.js` | Deployed CLI shim. | [`bin/run.md`](./bin/run.md). |
