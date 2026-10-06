# 3GPP 6G MCP Server — Documentation Index

The `3gpp-6g-mcp-server` is a TypeScript Model Context Protocol (MCP) server that exposes real FTP-based discovery, download, and local full-text search over 6G-related 3GPP specifications. It is distributed as the npm package `3gpp-6g-mcp-server` and boots over a stdio transport, wiring the MCP SDK to an `APIManager` that owns the FTP client, the curated spec catalog, the DOCX extractor, and a SQLite FTS5 search index. The server exposes seven MCP tools (`search_specifications`, `get_specification_details`, `compare_specifications`, `find_implementation_requirements`, `search_content`, `sync_specification`, `rebuild_index`) and is configured through a layered `config.json` + environment-variable + defaults mechanism.

This index lists every documentation file in the project, organized to mirror the source tree. Each entry has a one-line description extracted from the doc itself.

---

## `docs/`

Top-level project documentation. Read these first to understand the server's architecture, tool surface, configuration, and catalog.

- [architecture.md](./architecture.md) — Runtime architecture of the server: deployed entry point, wiring inside `src/index.ts`, `APIManager` orchestration role, end-to-end data flow from catalog discovery through download/extraction to full-text search, and an inventory of every exported symbol in `index.ts`.
- [mcp-tools.md](./mcp-tools.md) — **Canonical reference** for the seven MCP tools exposed by the server: each tool's declaration in `TOOL_DEFINITIONS`, its dispatch path through the `CallToolRequestSchema` handler, and its mapping onto an `APIManager` method. The dispatch tables in `architecture.md` and `src/index.md` mirror this file; when the three disagree, `mcp-tools.md` is the tiebreaker.
- [config.md](./config.md) — Configuration reference: the three layered mechanisms (`config.json`, environment-variable overrides, hard-coded fallbacks in `buildConfig`), every `config.example.json` field, and the divergence between the example file and the code for `documentRoot`.
- [catalog.md](./catalog.md) — Reference for `src/data/6g-spec-catalog.json`: the `CatalogFile`/`CatalogEntry` JSON shape, the catalog's verified size and category coverage, and every exported symbol in the `spec-catalog.ts` module that consumes the file.
- [build-and-deploy.md](./build-and-deploy.md) — Build, deploy, and test reference: `package.json` identity/scripts, `tsconfig.json` build configuration, the `dist/` build output, the deployed entry chain, how to consume the package from an MCP client, the consolidated runtime dependency list (including the LibreOffice best-effort dependency), and the testing story (there is no test suite).
- [index.md](./index.md) — This file: a navigable index of every documentation file in the project with one-line descriptions, organized by directory mirroring the source structure.

## `docs/bin/`

Per-file reference for the deployed CLI entry point.

- [run.md](./bin/run.md) — `bin/run.js`: the two-line Node shim that `npm` registers as the `3gpp-6g-mcp` CLI command. Its sole job is `require('../dist/index.js')`; it contains no business logic. Documents the shebang, the `require` side effects (which trigger the `require.main === module` entry point in `src/index.ts`), and how it fits the deployed chain.

## Root artifacts (reviewable but not under `docs/` or `src/`)

These files live at the package root and are part of the review surface. They are not separately documented files; instead, each is covered by the doc named in the "Documented in" column.

| Artifact | Purpose | Documented in |
|---|---|---|
| `README.md` | User-facing quickstart: requirements, installation, MCP-client config, tool summary, architecture overview. | Referenced throughout [build-and-deploy.md](./build-and-deploy.md); it *is* the user overview. |
| `package.json` | Package identity, npm scripts, dependencies, `bin` registration. | [build-and-deploy.md](./build-and-deploy.md) §Package identity, §npm scripts, §Runtime dependencies. |
| `tsconfig.json` | TypeScript compiler config. | [build-and-deploy.md](./build-and-deploy.md) §Build configuration. |
| `config.example.json` | Documented configuration template. | [config.md](./config.md). |
| `config.json` | Live configuration at the package root (gitignored). Differs from the example only in `documentRoot`. | [config.md](./config.md) §documentRoot default divergence. |
| `bin/run.js` | Deployed CLI shim. | [bin/run.md](./bin/run.md). |

## `src/`

Source-level documentation for individual TypeScript modules. These docs live under `docs/src/` and mirror the `src/` source tree — a developer can find the doc for `src/foo.ts` at `docs/src/foo.md`.

- [src/index.md](./src/index.md) — `src/index.ts`: the MCP server entry point and wiring layer — defines `TOOL_DEFINITIONS`, implements `ThreeGPP6GMCPServer` (tool registration + `CallToolRequest` dispatch to `APIManager`), and boots the server over stdio when executed directly.
- [src/config.md](./src/config.md) — `src/config.ts`: the single source of truth for runtime configuration — defines the `FtpConfig`/`SyncConfig`/`ServerConfig` interfaces, locates and parses `config.json`, merges file/env/defaults in `buildConfig`, exports the frozen `config` object, and provides `ensureDataDirs`.

## `src/api/`

Documentation for the four infrastructure modules composed by `APIManager`. These mirror `src/api/`.

- [src/api/api-manager.md](./src/api/api-manager.md) — `src/api/api-manager.ts`: the `APIManager` orchestrator class that composes the FTP client, spec catalog, DOCX extractor, and search index into the seven high-level operations exposed as MCP tools, plus four non-tool public helpers.
- [src/api/ftp-client.md](./src/api/ftp-client.md) — `src/api/ftp-client.ts`: the 3GPP FTP archive client — an axios-based HTTP wrapper exposing typed methods for listing spec series, enumerating per-spec versions, and downloading version `.zip` archives; the single I/O boundary between the MCP tools and the upstream archive.
- [src/api/docx-extractor.md](./src/api/docx-extractor.md) — `src/api/docx-extractor.ts`: extracts structured text from 3GPP specification documents — handles `.zip` → `.docx` extraction, `.docx` → HTML conversion, and HTML → structured section text for downstream indexing and search.
- [src/api/search-index.md](./src/api/search-index.md) — `src/api/search-index.ts`: the SQLite FTS5-backed full-text search index — indexes each extracted document section as a separate FTS5 row, tracks per-document metadata and schema version, and exposes the `SearchIndex` class plus a process-wide `getSearchIndex()` singleton factory.
- [src/api/spec-catalog.md](./src/api/spec-catalog.md) — `src/api/spec-catalog.ts`: loader and in-memory cache for the curated 6G specification catalog — reads `6g-spec-catalog.json`, parses it into typed `CatalogEntry` records, and exposes read-only accessors used by the MCP tool layer to discover which specs exist before download.

## `src/scripts/`

- [src/scripts/sync-all-6g.md](./src/scripts/sync-all-6g.md) — `src/scripts/sync-all-6g.ts`: standalone batch CLI script that iterates the entire curated 6G catalog and sequentially synchronizes every spec through `APIManager` (download + optional extract/index), with a configurable inter-spec delay, writing a structured JSON run report to the downloads directory on completion.
