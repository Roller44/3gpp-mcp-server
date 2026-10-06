# `src/index.ts` — MCP Server Entry Point

> **Source path:** `00_Workbench_工作台/mcp-server/src/index.ts`

## File Purpose

`index.ts` is the entry point and wiring layer for the `3gpp-6g-mcp-server`. It owns three responsibilities:

1. Define the catalog of MCP tools the server exposes (`TOOL_DEFINITIONS`).
2. Implement the server class (`ThreeGPP6GMCPServer`) that registers those tools with the MCP SDK and dispatches incoming `CallToolRequest` messages to the appropriate `APIManager` methods.
3. Boot the server over a stdio transport when the file is executed directly (`require.main === module`, `index.ts:360`).

The module deliberately contains no business logic of its own — it is a thin adapter between the MCP SDK's request/response protocol and the `APIManager` that performs FTP discovery, download, indexing, and search. Reviewers should read this file as the contract surface: every public tool name, parameter, and error mode visible to MCP clients originates here.

## Dependencies

- `@modelcontextprotocol/sdk/server/index.js` — `Server` class (`index.ts:1`), the SDK's request-handling core.
- `@modelcontextprotocol/sdk/server/stdio.js` — `StdioServerTransport` (`index.ts:2`), the transport used to communicate with the MCP client over stdin/stdout.
- `@modelcontextprotocol/sdk/types.js` — `CallToolRequestSchema`, `ListToolsRequestSchema`, `ErrorCode`, and `McpError` (`index.ts:3`–`8`), used to register handlers and signal protocol-level errors.
- `./api/api-manager` — `APIManager` (`index.ts:9`), the implementation backing every tool call.

## Module-Level Documentation Block

Lines `index.ts:11`–`25` carry a JSDoc comment summarizing the server's purpose and enumerating the seven tools. This comment is the canonical, human-readable summary of the tool surface; the `TOOL_DEFINITIONS` array below it is the machine-readable counterpart.

---

## `TOOL_DEFINITIONS` (module-level constant)

**Location:** `index.ts:27`–`183`

**Kind:** `const` array of plain tool-descriptor objects (not typed against an exported schema; shaped to satisfy the MCP SDK's `Tool` shape at runtime).

**Purpose:** Declares the seven tools the server advertises to MCP clients. The array is returned verbatim by the `ListToolsRequest` handler (`index.ts:205`–`207`), so this single source of truth drives both tool advertisement and (by convention) the dispatch table in the `CallToolRequest` handler. Each entry has `name`, `description`, and `inputSchema` (a JSON Schema object describing the tool's arguments).

**Entries:**

| # | `name` | Required args | Optional args | Lines |
|---|--------|---------------|---------------|-------|
| 1 | `search_specifications` | `query: string` | `limit: number` | `index.ts:29`–`50` |
| 2 | `get_specification_details` | `spec_number: string` | — | `index.ts:52`–`67` |
| 3 | `compare_specifications` | `spec_numbers: string[]` | — | `index.ts:69`–`84` |
| 4 | `find_implementation_requirements` | `feature: string` | `domain: string`, `limit: number` | `index.ts:86`–`109` |
| 5 | `search_content` | `query: string` | `spec_number`, `version`, `limit`, `snippet_size` | `index.ts:111`–`143` |
| 6 | `sync_specification` | `spec_number: string` | `version`, `force: boolean`, `download_only: boolean` | `index.ts:145`–`172` |
| 7 | `rebuild_index` | — | — | `index.ts:174`–`182` |

**Role in module:** Single source of truth for the tool catalog. The `description` strings are shown to MCP clients (and ultimately to LLM callers) and contain usage guidance such as "Use this to discover which 6G-related 3GPP specifications exist" (`index.ts:33`) and prerequisite notes such as "Requires the specification to be synced (indexed) first" (`index.ts:90`). Reviewers changing a tool's surface must edit both this array and the corresponding `case` in `setupHandlers`.

---

## `ThreeGPP6GMCPServer` (exported class)

**Location:** `index.ts:185`–`357`; exported at `index.ts:368`.

**Kind:** `class`, exported via the `export { ThreeGPP6GMCPServer }` statement at `index.ts:368`.

**Purpose:** Encapsulates the MCP `Server`, owns the `APIManager` instance, registers request handlers, and provides the `run()` method that connects the server to a stdio transport. It is the only symbol this module exports.

### Fields

#### `private server: Server`
**Location:** `index.ts:186`

The underlying MCP SDK `Server` instance. Constructed in the constructor with server metadata (`name: '3gpp-6g-mcp-server'`, `version: '1.0.0'`, `description`) and the capabilities declaration `{ capabilities: { tools: {} } }` (`index.ts:190`–`197`), which advertises that this server implements the tools capability and nothing else.

#### `private apiManager: APIManager`
**Location:** `index.ts:187`

The `APIManager` instance that backs every tool call. Instantiated with no arguments in the constructor (`index.ts:199`). All seven tool dispatch cases delegate to a method on this object.

### Constructor

**Signature:** `new ThreeGPP6GMCPServer()` — `index.ts:189`–`201`

**Parameters:** None.

**Behavior:**
1. Creates the MCP `Server` with name `3gpp-6g-mcp-server`, version `1.0.0`, a human-readable description, and `capabilities: { tools: {} }` (`index.ts:190`–`197`).
2. Constructs a new `APIManager` and stores it on `this.apiManager` (`index.ts:199`).
3. Calls `this.setupHandlers()` to register the request handlers (`index.ts:200`).

**Return value:** A `ThreeGPP6GMCPServer` instance with handlers already wired.

### `private setupHandlers(): void`

**Location:** `index.ts:203`–`350`

**Purpose:** Registers the two MCP request handlers — one for listing tools, one for invoking a tool — on `this.server`. Called once from the constructor; not intended to be invoked again.

#### ListTools handler (`index.ts:205`–`207`)

Registered against `ListToolsRequestSchema`. It is an `async` handler that ignores its arguments and returns `{ tools: TOOL_DEFINITIONS }`. This is what makes the seven tools discoverable to MCP clients.

#### CallTool handler (`index.ts:210`–`349`)

Registered against `CallToolRequestSchema`. This is the dispatch core of the server.

**Parameters (destructured from the request):** `name` and `arguments: args` from `request.params` (`index.ts:211`).

**Return value:** A `CallToolResult`-shaped object. On success every case returns `{ content: [{ type: 'text', text: <JSON-stringified result> }] }` — the result of the delegated `APIManager` call, pretty-printed with a 2-space indent. On a non-`McpError` failure the handler returns `{ content: [{ type: 'text', text: 'Error executing tool "<name>": <message>' }], isError: true }` (`index.ts:339`–`347`).

**Dispatch table** — each `case` validates the required arguments, throws `McpError(ErrorCode.InvalidParams, ...)` when validation fails, delegates to `APIManager`, and JSON-stringifies the result:

> **Not the canonical tool reference.** This table is part of `index.ts`'s
> exported-symbol inventory. The single source of truth for each tool's name,
> input schema, validation, defaults, and dispatch lines is
> [`docs/mcp-tools.md`](../mcp-tools.md) (see its
> [Dispatch summary](../mcp-tools.md#dispatch-summary)); the architectural
> overview in [`docs/architecture.md`](../architecture.md) holds a third
> copy. When the three disagree, `docs/mcp-tools.md` is the tiebreaker; update
> it first and let this table inherit.

| Tool name | Validation | `APIManager` call | Lines |
|-----------|------------|-------------------|-------|
| `search_specifications` | `query` defaults to `''` when absent (no throw) | `searchSpecifications(query, { limit })` | `index.ts:215`–`227` |
| `get_specification_details` | throws if `spec_number` missing | `getSpecificationDetails(specNumber)` | `index.ts:229`–`243` |
| `compare_specifications` | throws if `spec_numbers` is not an array of length ≥ 2 | `compareSpecifications(specNumbers)` | `index.ts:245`–`259` |
| `find_implementation_requirements` | throws if `feature` missing | `findImplementationRequirements(feature, { domain, limit })` | `index.ts:261`–`277` |
| `search_content` | throws if `query` missing | `searchContent(query, { specNumber, version, limit, snippetSize })` | `index.ts:279`–`298` |
| `sync_specification` | throws if `spec_number` missing | `syncSpecification(specNumber, { version, force, downloadOnly })` | `index.ts:300`–`318` |
| `rebuild_index` | none | `rebuildIndex()` | `index.ts:320`–`330` |
| `default` | — | throws `McpError(ErrorCode.MethodNotFound, 'Unknown tool: <name>')` | `index.ts:332`–`333` |

**Argument-name mapping:** The handler translates the snake_case JSON Schema parameter names declared in `TOOL_DEFINITIONS` into the camelCase option keys expected by `APIManager` — e.g. `spec_number` → `specNumber`, `snippet_size` → `snippetSize`, `download_only` → `downloadOnly` (`index.ts:285`–`288`, `305`–`308`). This is the only place that mapping is performed.

**Error handling** (`index.ts:335`–`348`): the entire `switch` is wrapped in `try`/`catch`.
- If the caught error `instanceof McpError` (e.g. the `InvalidParams` or `MethodNotFound` throws above), it is re-thrown so the MCP SDK can translate it into a proper JSON-RPC error response (`index.ts:336`–`338`).
- Any other error — i.e. an unexpected failure from inside `APIManager` — is not propagated as a protocol error. Instead the handler returns a successful-shape `CallToolResult` whose `content` is a text block describing the error and whose `isError: true` flag marks it as a tool-level failure (`index.ts:339`–`347`). This keeps the MCP connection alive while still surfacing the failure to the client.

### `async run(): Promise<void>`

**Location:** `index.ts:352`–`356`

**Purpose:** Connects the configured `Server` to a `StdioServerTransport` and logs a readiness message to stderr.

**Parameters:** None.

**Return value:** `Promise<void>` that resolves once `this.server.connect(transport)` completes.

**Behavior:**
1. Constructs a new `StdioServerTransport` (`index.ts:353`) — MCP communication flows over process stdin/stdout.
2. Awaits `this.server.connect(transport)` (`index.ts:354`), which binds the request handlers registered in `setupHandlers` to the transport.
3. Writes `'3GPP 6G MCP Server running on stdio'` to `console.error` (`index.ts:355`). Stderr is used deliberately so the log line does not corrupt the stdio JSON-RPC stream that MCP uses on stdout.

---

## stdio Entry Point

**Location:** `index.ts:360`–`366`

```ts
if (require.main === module) {
  const server = new ThreeGPP6GMCPServer();
  server.run().catch((error) => {
    console.error('Fatal error starting server:', error);
    process.exit(1);
  });
}
```

**Purpose:** Boots the server only when `index.ts` is executed directly (e.g. `node dist/index.js`), not when it is imported as a module. The guard `require.main === module` (`index.ts:360`) is what makes the class importable for testing without triggering an automatic server start.

**Behavior:**
1. Constructs a `ThreeGPP6GMCPServer` — which synchronously creates the `Server`, the `APIManager`, and registers handlers (`index.ts:361`).
2. Calls `server.run()` and attaches a `.catch` (`index.ts:362`). If connecting to the stdio transport fails for any reason, the error is logged to `console.error` as `'Fatal error starting server:'` followed by the error, and the process exits with code `1` (`index.ts:363`–`365`).

**Note for reviewers:** Because the entry point uses `require.main === module`, it implicitly assumes CommonJS output. The build configuration confirms this: `package.json:6` declares `"type": "commonjs"` and `tsconfig.json:4` sets `"module": "node18"` with `"outDir": "./dist"`, so `tsc` emits CommonJS into `dist/` and `require.main === module` is the correct guard for the published package. A consumer building this module as a pure ESM bundle would need a different entry-point guard (e.g. an `import.meta.url` check); that is not how the package ships today. See [`build-and-deploy.md`](../build-and-deploy.md) for the full build/test/deploy reference.

---

## Export Summary

| Symbol | Kind | Location | Exported at |
|--------|------|----------|-------------|
| `ThreeGPP6GMCPServer` | `class` | `index.ts:185`–`357` | `index.ts:368` |

`TOOL_DEFINITIONS` is module-private (no `export`) and is surfaced to MCP clients only via the `ListToolsRequest` handler. The MCP SDK symbols (`Server`, `StdioServerTransport`, `McpError`, etc.) and `APIManager` are imported for internal use and are not re-exported.

## Module Data Flow

```
MCP client (stdio JSON-RPC)
        │
        ▼
StdioServerTransport ──► Server (MCP SDK)
                              │  setRequestHandler(ListToolsRequestSchema)  ──► returns TOOL_DEFINITIONS
                              │  setRequestHandler(CallToolRequestSchema)   ──► switch(name) dispatch
                              ▼
                        ThreeGPP6GMCPServer.setupHandlers()
                              │  validates args → throws McpError(InvalidParams | MethodNotFound)
                              │  delegates to ──► APIManager.searchSpecifications / getSpecificationDetails /
                              │                    compareSpecifications / findImplementationRequirements /
                              │                    searchContent / syncSpecification / rebuildIndex
                              ▼
                        { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
                              │  (or isError: true text block for non-McpError failures)
                              ▼
                        back through Server → StdioServerTransport → client
```

Reviewers tracking a tool bug should follow the path: tool name in `TOOL_DEFINITIONS` → matching `case` in `setupHandlers` (argument extraction + validation) → `APIManager` method (where the actual work happens, in `src/api/api-manager`).
