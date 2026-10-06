# Architecture

> Source: `00_Workbench_工作台/mcp-server/src/index.ts`

This document describes the runtime architecture of the `3gpp-6g-mcp-server` — a TypeScript MCP (Model Context Protocol) server that exposes real FTP-based discovery, download, and local full-text search over 6G-related 3GPP specifications. It covers the deployed entry point, the wiring inside `src/index.ts`, the orchestration role of `APIManager`, the data flow from catalog discovery through download/extraction to full-text search, and an inventory of every exported symbol in `index.ts`.

## Deployed entry point and runtime chain

The server is distributed as an npm package named `3gpp-6g-mcp-server` (`package.json:2`). When installed, the `3gpp-6g-mcp` CLI bin is registered (`package.json:7-8`):

```json
"bin": {
  "3gpp-6g-mcp": "./bin/run.js"
}
```

`bin/run.js` is a thin Node shim whose entire body is `require('../dist/index.js')` (`bin/run.js:2`). The runtime chain is therefore:

```
3gpp-6g-mcp (bin)  →  bin/run.js  →  dist/index.js  (compiled from src/index.ts)
```

`package.json` declares `"main": "dist/index.js"` (`package.json:5`) and `"type": "commonjs"` (`package.json:6`), so the compiled CommonJS output of `src/index.ts` is the package's main module. The build script (`package.json:11`) runs `tsc` and then copies `src/data` into `dist/data`, so static catalog data ships alongside the compiled code. At runtime, `dist/index.js` is the active module; the TypeScript source in `src/index.ts` is the authoritative version documented here.

> **Build, deploy, and test details live elsewhere.** This section covers only
> the runtime chain as it relates to architecture. For the full build
> configuration (`tsconfig.json`), the `npm` scripts, the `dist/` build-output
> tree, how to consume the package from an MCP client, the consolidated
> dependency list, and the testing story, see
> [`build-and-deploy.md`](./build-and-deploy.md). For the per-file reference on
> `bin/run.js`, see [`bin/run.md`](./bin/run.md).

## High-level architecture

`src/index.ts` is the MCP-facing layer. It owns three responsibilities:

1. Construct an MCP `Server` with the server identity and `tools` capability (`index.ts:190-197`).
2. Register request handlers for `ListToolsRequest` and `CallToolRequest` (`index.ts:205`, `index.ts:210`).
3. Connect the server to a `StdioServerTransport` and start listening on stdio (`index.ts:352-356`).

Everything that actually does work — catalog lookup, FTP download, DOCX extraction, and FTS5 search — is delegated to `APIManager`, which `index.ts` imports from `./api/api-manager` (`index.ts:9`) and instantiates in the constructor (`index.ts:199`). The `index.ts` module never touches the FTP client, the spec catalog, the DOCX extractor, or the SQLite/FTS5 index directly.

### How index.ts wires the MCP SDK

The wiring is concentrated in the `ThreeGPP6GMCPServer` class (`index.ts:185-357`):

- **Imports** pull in `Server` from `@modelcontextprotocol/sdk/server/index.js` (`index.ts:1`), `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js` (`index.ts:2`), and the request schemas / error types from `@modelcontextprotocol/sdk/types.js` (`index.ts:3-8`).
- **Constructor** (`index.ts:189-201`) creates the `Server` with name `3gpp-6g-mcp-server`, version `1.0.0`, a human description, and `capabilities: { tools: {} }` to advertise the tools capability. It then constructs `APIManager` and calls `setupHandlers()`.
- **`setupHandlers()`** (`index.ts:203-350`) registers two request handlers:
  - `ListToolsRequestSchema` → returns the static `TOOL_DEFINITIONS` array (`index.ts:205-207`).
  - `CallToolRequestSchema` → a `switch` over `request.params.name` that dispatches to the matching `APIManager` method, serializes the result as pretty-printed JSON inside a single `{ type: 'text' }` content block, and returns it (`index.ts:210-349`). Unknown tool names raise `McpError(ErrorCode.MethodNotFound)` (`index.ts:333`); missing required parameters raise `McpError(ErrorCode.InvalidParams)` (e.g. `index.ts:232`, `index.ts:248`, `index.ts:264`, `index.ts:282`, `index.ts:303`). Non-`McpError` exceptions are caught and returned as `{ isError: true }` content blocks rather than thrown (`index.ts:335-348`).
- **`run()`** (`index.ts:352-356`) creates a `StdioServerTransport`, calls `server.connect(transport)`, and logs a startup line to stderr. MCP traffic flows over stdin/stdout; the stderr log keeps the protocol stream clean.
- **Entry point** (`index.ts:360-366`) guards on `require.main === module` so the module is both runnable and importable. When run directly it constructs the server, calls `run()`, and on a fatal error logs to stderr and exits with code 1.

### APIManager as orchestrator

`APIManager` (in `src/api/api-manager.ts`) is the single dependency `index.ts` uses for all real work. It orchestrates four collaborating modules, each in `src/api/`:

| Module file | Role in the pipeline |
|---|---|
| `spec-catalog.ts` | Curated 6G spec catalog — keyword search, single-spec details, multi-spec metadata comparison. Backed by static data under `src/data` (copied to `dist/data` at build). |
| `ftp-client.ts` | 3GPP FTP archive client — lists available versions for a spec, downloads a specific version's `.zip` archive. |
| `docx-extractor.ts` | Extracts text content from the `.docx` payload inside a downloaded `.zip` (uses `mammoth` and `adm-zip`, per `package.json:36-37`). |
| `search-index.ts` | Local full-text index backed by SQLite + FTS5 (via `better-sqlite3`, `package.json:35`). Stores extracted sections and runs prefix-aware full-text queries. |

`APIManager` exposes one method per MCP tool: `searchSpecifications`, `getSpecificationDetails`, `compareSpecifications`, `findImplementationRequirements`, `searchContent`, `syncSpecification`, and `rebuildIndex`. `index.ts` calls exactly these methods (see the dispatch table below) and never reaches past `APIManager` into the four submodules.

## Data flow: catalog → download → extract → index → search

The end-to-end pipeline is a discover-then-sync-then-search loop. Each step is a separate MCP tool so callers can drive the pipeline incrementally.

```
┌─────────────────────┐
│  spec-catalog.ts    │  (1) discover what exists
│  src/data catalog   │
└──────────┬──────────┘
           │  search_specifications / get_specification_details / compare_specifications
           ▼
┌─────────────────────┐
│  ftp-client.ts      │  (2) pick a version, download the .zip
│  3GPP FTP archive   │
└──────────┬──────────┘
           │  sync_specification
           ▼
┌─────────────────────┐
│  docx-extractor.ts  │  (3) unzip + extract text from .docx
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  search-index.ts    │  (4) write sections into SQLite + FTS5
│  SQLite / FTS5      │
└──────────┬──────────┘
           │  search_content / find_implementation_requirements / rebuild_index
           ▼
   MCP tool result (JSON over stdio)
```

1. **Catalog discovery.** A caller first runs `search_specifications` with a keyword (or empty string to list everything) to find candidate specs, then `get_specification_details` to see which versions the FTP archive has and which are already locally indexed. `compare_specifications` lets a caller diff metadata across several specs at once. These calls are served entirely from `spec-catalog.ts` plus the FTP client's version listing; no download is required.

2. **Download.** `sync_specification` resolves a spec number (and optional version code, defaulting to latest) through the catalog, then hands it to `ftp-client.ts` to fetch the version's `.zip` archive into the local downloads directory. `download_only: true` stops the pipeline here — useful when the caller just wants the artifact on disk.

3. **Extraction.** Unless `download_only` is set, the downloaded `.zip` is opened by `docx-extractor.ts` (using `adm-zip`), the embedded `.docx` is parsed (using `mammoth`), and the text is broken into sections with metadata (spec number, version, section title, position).

4. **Indexing.** The extracted sections are written into the SQLite/FTS5 index by `search-index.ts`. `force: true` re-downloads and re-indexes even if the version is already indexed. After this step the spec's content is searchable. `rebuild_index` is the offline-recovery path: it re-extracts every `.zip` already in the downloads directory and rebuilds the FTS5 index from scratch, without re-downloading.

5. **Search.** `search_content` runs a full-text query (with optional `spec_number`, `version`, `limit`, and `snippet_size` filters) and returns matching sections with highlighted snippets and positions. `find_implementation_requirements` is a narrower full-text search scoped to "implementation requirement" content for a named feature, with an optional `domain` filter (e.g. `security`, `mobility`). Both require at least one spec to have been synced first; if the index is empty they return no results rather than downloading on demand.

The two halves are deliberately decoupled: catalog tools never touch the index, and search tools never touch the network. `sync_specification` is the only tool that bridges them.

## Tool dispatch table

Each MCP tool name maps to one `APIManager` method. The table below lists the tool, the `index.ts` lines that handle it, the `APIManager` method invoked, and the parameter shape passed through.

> **Not the canonical tool reference.** This table is a condensed architectural
> view. The single source of truth for each tool's name, input schema,
> validation, defaults, and dispatch lines is
> [`mcp-tools.md`](./mcp-tools.md) (see its
> [Dispatch summary](./mcp-tools.md#dispatch-summary)). The per-module reference
> in [`src/index.md`](./src/index.md) holds a third copy as part of its
> exported-symbol inventory. When the three disagree, `mcp-tools.md` is the
> tiebreaker; update it first and let this table and `src/index.md` inherit.

| Tool name | Handler (index.ts) | APIManager method | Argument mapping |
|---|---|---|---|
| `search_specifications` | `index.ts:215-227` | `searchSpecifications(query, { limit })` | `query` defaults to `''`; `limit` passed through. |
| `get_specification_details` | `index.ts:229-243` | `getSpecificationDetails(specNumber)` | `spec_number` required → `McpError(InvalidParams)` if absent. |
| `compare_specifications` | `index.ts:245-259` | `compareSpecifications(specNumbers)` | `spec_numbers` must be an array of length ≥ 2. |
| `find_implementation_requirements` | `index.ts:261-277` | `findImplementationRequirements(feature, { domain, limit })` | `feature` required. |
| `search_content` | `index.ts:279-298` | `searchContent(query, { specNumber, version, limit, snippetSize })` | `query` required; snake_case args mapped to camelCase options. |
| `sync_specification` | `index.ts:300-318` | `syncSpecification(specNumber, { version, force, downloadOnly })` | `spec_number` required; `download_only` → `downloadOnly`. |
| `rebuild_index` | `index.ts:320-330` | `rebuildIndex()` | No arguments. |

Every successful branch returns `{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }` — the tool result is always a pretty-printed JSON string in a single text content block. The catch-all at `index.ts:335-348` ensures any non-`McpError` thrown by `APIManager` becomes an `{ isError: true }` content block instead of crashing the server.

## Exported symbols

`src/index.ts` exports exactly one symbol: the `ThreeGPP6GMCPServer` class (`index.ts:368`). All other declarations — imports, the `TOOL_DEFINITIONS` constant, and the request-handler closures — are module-private.

### `TOOL_DEFINITIONS` (module-private constant)

- **Declaration:** `index.ts:27-183` — `const TOOL_DEFINITIONS = [...]`.
- **Purpose:** The static array of seven MCP tool definitions returned by the `ListToolsRequest` handler (`index.ts:205-207`). Each entry has `name`, `description`, and a JSON-Schema-shaped `inputSchema`. The seven tools are: `search_specifications`, `get_specification_details`, `compare_specifications`, `find_implementation_requirements`, `search_content`, `sync_specification`, `rebuild_index` (listed in the file's top-level doc comment, `index.ts:11-25`).
- **Visibility:** Not exported. It is the single source of truth for the tool list surfaced to MCP clients, and is also what the `CallToolRequest` handler's `switch` dispatches against.
- **Schema notes:** Each `inputSchema` lists its `required` fields (e.g. `['query']` for `search_specifications` at `index.ts:48`, `['spec_number']` for `get_specification_details` at `index.ts:65`, `['spec_numbers']` for `compare_specifications` at `index.ts:82`, `['feature']` for `find_implementation_requirements` at `index.ts:107`, `['query']` for `search_content` at `index.ts:141`, `['spec_number']` for `sync_specification` at `index.ts:170`). `rebuild_index` takes an empty `properties` object and no required fields (`index.ts:178-181`).

### `class ThreeGPP6GMCPServer` (exported)

- **Declaration:** `index.ts:185-357` — `class ThreeGPP6GMCPServer { ... }`.
- **Export:** `export { ThreeGPP6GMCPServer };` at `index.ts:368`.
- **Purpose:** Encapsulates the MCP server lifecycle: creates the `Server`, owns the `APIManager`, registers request handlers, and starts the stdio transport. It is the only class in the module and the only exported symbol.
- **Role in the module:** It is the composition root. Everything the MCP client sees — tool listings, tool dispatch, error normalization — is produced here. All domain work is delegated to `APIManager`.

#### Fields

- `private server: Server` (`index.ts:186`) — the MCP `Server` instance from `@modelcontextprotocol/sdk/server/index.js`. Created in the constructor (`index.ts:190-197`) with name `3gpp-6g-mcp-server`, version `1.0.0`, description `3GPP 6G MCP Server — real FTP download + local full-text search`, and `capabilities: { tools: {} }`.
- `private apiManager: APIManager` (`index.ts:187`) — the orchestrator imported from `./api/api-manager` (`index.ts:9`). Constructed in the constructor (`index.ts:199`). All seven tool handlers call methods on this instance.

#### Constructor

```ts
constructor()
```
(`index.ts:189-201`)

- **Parameters:** None.
- **Return value:** None (constructs the instance).
- **Behavior:** Instantiates `this.server` with the identity/capabilities above, instantiates `this.apiManager = new APIManager()`, then calls `this.setupHandlers()` to register the request handlers.
- **Side effects:** Constructs an `APIManager`, which in turn may open the SQLite database and load the spec catalog. Any failure here propagates to the entry point's `.catch()` (`index.ts:362-365`), which logs and exits with code 1.

#### `private setupHandlers(): void`

- **Declaration:** `index.ts:203-350`.
- **Signature:** `setupHandlers(): void` — no parameters, no return.
- **Purpose:** Registers the two MCP request handlers that turn the server into a working tools provider.
- **Behavior:**
  - **`ListToolsRequestSchema` handler** (`index.ts:205-207`): async, returns `{ tools: TOOL_DEFINITIONS }`. Stateless.
  - **`CallToolRequestSchema` handler** (`index.ts:210-349`): async, destructures `request.params` into `name` and `arguments` (`index.ts:211`), then `switch`es on `name`. Each case validates required params (raising `McpError(ErrorCode.InvalidParams)` when missing), calls the matching `APIManager` method, and returns the result as `{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }`. The `default` case raises `McpError(ErrorCode.MethodNotFound)` (`index.ts:332-334`). The outer `try/catch` (`index.ts:213`, `335-348`) re-throws `McpError` instances and converts any other thrown error into `{ content: [{ type: 'text', text: 'Error executing tool "<name>": <message>' }], isError: true }`.
- **Role:** This is the only place where MCP request schemas are wired to behavior. It is the bridge between the MCP SDK and `APIManager`.

#### `async run(): Promise<void>`

- **Declaration:** `index.ts:352-356`.
- **Signature:** `run(): Promise<void>` — no parameters.
- **Return value:** `Promise<void>` that resolves once the server is connected to the transport. The server then keeps the process alive listening on stdio.
- **Behavior:** Creates `new StdioServerTransport()`, awaits `this.server.connect(transport)`, and writes `'3GPP 6G MCP Server running on stdio'` to `console.error` (stderr, so it does not pollute the stdio protocol stream on stdout).
- **Role:** The runtime entry. Called from the module's `require.main === module` block (`index.ts:361-365`).

### Module-level entry point (not exported)

```ts
if (require.main === module) {
  const server = new ThreeGPP6GMCPServer();
  server.run().catch((error) => {
    console.error('Fatal error starting server:', error);
    process.exit(1);
  });
}
```
(`index.ts:360-366`)

- **Purpose:** Runs the server only when `dist/index.js` is executed directly (i.e. via `bin/run.js` → `dist/index.js`), not when it is `require`d as a library. The guard is what makes the same module usable both as the deployed CLI and as an importable `ThreeGPP6GMCPServer` class.
- **Error handling:** Any rejection from `run()` (or throw from the constructor) is caught, logged to stderr as `'Fatal error starting server:'`, and the process exits with code 1.

## Notes and verification

- The runtime chain `bin/run.js → dist/index.js` was verified against `bin/run.js:2` (`require('../dist/index.js')`) and `package.json:5` (`"main": "dist/index.js"`); the bin registration is at `package.json:7-8`.
- The seven tools and their order in `TOOL_DEFINITIONS` match the file's top-level doc comment (`index.ts:11-25`) and the `switch` cases in `setupHandlers` (`index.ts:214-334`).
- `APIManager` and the four submodules (`spec-catalog.ts`, `ftp-client.ts`, `docx-extractor.ts`, `search-index.ts`) were located via `ls src/api`; their internal APIs are documented in their own files and are not re-documented here. This document covers `src/index.ts` only, per the ask's scope.
- The dependency libraries named in the data-flow diagram (`mammoth`, `adm-zip`, `better-sqlite3`, `axios`) are taken from `package.json:32-37`; the FTS5-backed search claim is grounded in the MCP tool descriptions for `search_content` (`index.ts:113-116`) and `find_implementation_requirements` (`index.ts:88-90`), which describe prefix matching and snippet/position output.
