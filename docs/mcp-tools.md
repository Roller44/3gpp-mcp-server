# MCP Tools — `3gpp-6g-mcp-server`

> **Source:** `00_Workbench_工作台/mcp-server/src/index.ts`
>
> Reference for the seven Model Context Protocol (MCP) tools exposed by the
> `3gpp-6g-mcp-server`. Each tool is declared in the module-level
> `TOOL_DEFINITIONS` array (`index.ts:27-183`) and dispatched by the
> `CallToolRequestSchema` handler inside `ThreeGPP6GMCPServer.setupHandlers`
> (`index.ts:210-349`). The dispatch handler maps each tool name to a method on
> the injected `APIManager` (`index.ts:9`, `index.ts:199`).

> **Single source of truth for tool surfaces.** This document is the canonical
> reference for the seven MCP tools. The tool surface is also described in two
> companion documents, with the following division of labor — when you change a
> tool's name, parameters, or dispatch behavior, update **this** file and let
> the others inherit:
>
> | Document | Role | What to update it for |
> |---|---|---|
> | `mcp-tools.md` (this file) | **Canonical per-tool reference.** One section per tool with input schema, dispatch path, and `APIManager` mapping. | Any change to a tool's surface (name, params, defaults, validation, dispatch lines). |
> | [`architecture.md`](./architecture.md) | Architectural overview. Holds a condensed dispatch table (`architecture.md:107-115`) as part of the runtime-architecture narrative, not a per-tool reference. | Structural/architectural changes (new module, new wiring, data-flow changes). Keep its dispatch table in sync with §[Dispatch summary](#dispatch-summary) here. |
> | [`src/index.md`](./src/index.md) | Per-module reference for `src/index.ts`. Documents `TOOL_DEFINITIONS` and the `setupHandlers` dispatch table (`src/index.md:105-114`) as part of the file's exported-symbol inventory. | Changes to `index.ts`'s module structure (new exported symbol, new field, constructor behavior). Its tool table mirrors this file's; treat this file as authoritative when they differ. |
>
> If the three ever disagree, `mcp-tools.md` is the tiebreaker.

## File overview

`src/index.ts` is the server entry point. It wires the MCP SDK
(`@modelcontextprotocol/sdk`) to an `APIManager` instance that owns the
specification catalog, FTP download, and local full-text index. The file
exports exactly one symbol — the `ThreeGPP6GMCPServer` class
(`index.ts:368`) — and boots it from a `require.main === module` guard
(`index.ts:360-366`).

### Module-level symbols

| Symbol | Kind | Location | Role |
| --- | --- | --- | --- |
| `TOOL_DEFINITIONS` | `const` array | `index.ts:27-183` | Static catalog of the seven MCP tool definitions (name, description, JSON-Schema input schema) returned verbatim by the `ListToolsRequest` handler (`index.ts:205-207`). Not exported. |
| `ThreeGPP6GMCPServer` | `class` (exported) | `index.ts:185-357`, exported `index.ts:368` | The MCP server class. Owns a `Server` (`@modelcontextprotocol/sdk`) and an `APIManager`, registers request handlers, and exposes a `run()` method to start a stdio transport. |

### `TOOL_DEFINITIONS`

A top-level `const` array of seven plain objects, one per tool. Every object
has three fields:

- `name` (`string`) — the tool name a client sends in `CallToolRequest.params.name`.
- `description` (`string`) — human-readable purpose, surfaced to MCP clients by the
  `ListToolsRequest` handler (`index.ts:205-207`).
- `inputSchema` (`object`) — a JSON-Schema object describing the tool's
  arguments. Each schema has `type: 'object'`, a `properties` map, and a
  `required` array (omitted for the no-arg `rebuild_index` tool, whose
  `properties` is `{}`).

The array is consumed in two places: returned as `tools` by the
`ListToolsRequest` handler (`index.ts:206`), and used as the source of truth
that the `CallToolRequest` `switch` statement (`index.ts:214-333`) dispatches
against.

## Exported symbol: `ThreeGPP6GMCPServer`

```ts
class ThreeGPP6GMCPServer
```

Exported at `index.ts:368`. Encapsulates the entire MCP server: it constructs
the SDK `Server`, instantiates the `APIManager`, registers the
`ListToolsRequest` and `CallToolRequest` handlers, and provides a `run()`
method to start a stdio transport.

### Constructor

```ts
constructor()
```

`index.ts:189-201`. Performs three things:

1. Creates the SDK `Server` with server info
   `{ name: '3gpp-6g-mcp-server', version: '1.0.0', description: ... }` and
   capabilities `{ tools: {} }` (`index.ts:190-197`).
2. Instantiates `this.apiManager = new APIManager()` (`index.ts:199`). The
   `APIManager` is the single dependency that backs every tool dispatch.
3. Calls `this.setupHandlers()` (`index.ts:200`) to register request handlers.

### Private members

- `private server: Server` (`index.ts:186`) — the MCP SDK `Server` instance.
- `private apiManager: APIManager` (`index.ts:187`) — the manager that
  implements every tool's behavior. Imported from `./api/api-manager`
  (`index.ts:9`).

### `private setupHandlers(): void`

`index.ts:203-350`. Registers two request handlers:

1. **`ListToolsRequestSchema`** (`index.ts:205-207`) — returns
   `{ tools: TOOL_DEFINITIONS }`, advertising all seven tools to the client.
2. **`CallToolRequestSchema`** (`index.ts:210-349`) — the dispatch handler.
   Destructures `request.params` into `{ name, arguments: args }`
   (`index.ts:211`), then `switch`es on `name` (`index.ts:214-333`). Each case
   reads its arguments off `(args as any)`, calls the matching `APIManager`
   method, and returns `{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }`.

   Argument coercion notes:
   - Required params are validated inline; missing values throw
     `new McpError(ErrorCode.InvalidParams, ...)` (e.g. `index.ts:231-233`,
     `index.ts:247-249`, `index.ts:263-265`, `index.ts:281-283`,
     `index.ts:302-304`).
   - `search_specifications` defaults `query` to `''` (`index.ts:216`).
   - `compare_specifications` requires `spec_numbers` to be an array of
     length ≥ 2 (`index.ts:247-249`).
   - The `default` case throws
     `new McpError(ErrorCode.MethodNotFound, \`Unknown tool: ${name}\`)`
     (`index.ts:332-333`).
   - The `try/catch` (`index.ts:213`, `index.ts:335-348`) re-throws any
     `McpError` and wraps every other error into an `{ isError: true }` text
     content response with message `Error executing tool "${name}": ...`.

   The case-to-`APIManager` mapping is documented per tool below.

### `async run(): Promise<void>`

`index.ts:352-356`. Creates a `StdioServerTransport`, connects it to the SDK
server with `await this.server.connect(transport)`, and logs
`3GPP 6G MCP Server running on stdio` to stderr. Returns when the transport is
connected; the server then runs until the stdio transport closes.

### Module entry point

`index.ts:360-366`. The `if (require.main === module)` guard instantiates
`ThreeGPP6GMCPServer` and calls `run()`. On a rejected promise it logs
`Fatal error starting server:` and exits with code 1.

---

## Tool reference

The seven tools below are listed in the order they appear in
`TOOL_DEFINITIONS` and in the dispatch `switch`.

### 1. `search_specifications`

**Defined:** `index.ts:28-50` · **Dispatched:** `index.ts:215-227`

Search the curated 6G specification catalog by keyword (spec number, title,
working group, category, or notes). Use empty `query` to list all cataloged
specs. Returns matching specs with their latest available FTP-archive version
and local index status.

**Input schema** (`index.ts:34-49`)

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `query` | `string` | yes | — | Search query. Matched against spec number, title, working group, category, and notes. Use empty string to list all cataloged specs. |
| `limit` | `number` | no | `20` (per description, `index.ts:45`) | Maximum results to return. |

> Note: `required: ['query']` (`index.ts:48`) marks `query` as required, but
> the dispatcher defaults a missing `query` to `''` (`index.ts:216`), so an
> omitted `query` is tolerated at runtime and lists all cataloged specs.

**Dispatch → `APIManager`** (`index.ts:218`)

```ts
this.apiManager.searchSpecifications(query, { limit })
```

`query` is `(args as any)?.query ?? ''`; `limit` is `(args as any)?.limit`.
The result is returned as a pretty-printed JSON `text` content block.

---

### 2. `get_specification_details`

**Defined:** `index.ts:51-67` · **Dispatched:** `index.ts:229-243`

Get detailed information about a single 3GPP specification: all available
versions from the FTP archive, release labels, draft status, and which
versions are locally indexed. Use before downloading or to check what
versions exist.

**Input schema** (`index.ts:57-66`)

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `spec_number` | `string` | yes | — | Specification number, e.g. `"23.700-40"` or `"38.843"`. |

**Dispatch → `APIManager`** (`index.ts:234`)

```ts
this.apiManager.getSpecificationDetails(specNumber)
```

`specNumber` is `(args as any)?.spec_number`. A missing `spec_number` throws
`McpError(InvalidParams, 'spec_number is required')` (`index.ts:231-233`).

---

### 3. `compare_specifications`

**Defined:** `index.ts:68-84` · **Dispatched:** `index.ts:245-259`

Compare metadata across multiple 3GPP specifications: titles, working groups,
categories, latest versions, and index status. Identifies shared categories
and working groups.

**Input schema** (`index.ts:73-83`)

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `spec_numbers` | `string[]` | yes | — | List of specification numbers to compare, e.g. `["23.700-40", "38.843"]`. |

**Dispatch → `APIManager`** (`index.ts:250`)

```ts
this.apiManager.compareSpecifications(specNumbers)
```

`specNumbers` is `(args as any)?.spec_numbers`. The dispatcher enforces that
it must be an array of at least 2 entries, otherwise throwing
`McpError(InvalidParams, 'spec_numbers must be an array of at least 2 spec numbers')`
(`index.ts:247-249`). Note the input schema itself does not declare a minimum
length — the ≥ 2 constraint is enforced only in the dispatch handler.

---

### 4. `find_implementation_requirements`

**Defined:** `index.ts:85-109` · **Dispatched:** `index.ts:261-277`

Search the full-text index for implementation requirement content related to
a feature. Returns matching sections with snippets, spec references, and
section positions. Requires the specification to be synced (indexed) first.

**Input schema** (`index.ts:91-108`)

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `feature` | `string` | yes | — | The feature or functionality to search for, e.g. `"SUCI privacy protection"` or `"charging"`. |
| `domain` | `string` | no | — | Optional domain context to narrow the search, e.g. `"security"` or `"mobility"`. |
| `limit` | `number` | no | `30` (per description, `index.ts:104`) | Maximum results to return. |

**Dispatch → `APIManager`** (`index.ts:268`)

```ts
this.apiManager.findImplementationRequirements(feature, { domain, limit })
```

`feature` is `(args as any)?.feature`; `domain` is `(args as any)?.domain`;
`limit` is `(args as any)?.limit`. A missing `feature` throws
`McpError(InvalidParams, 'feature is required')` (`index.ts:263-265`).

---

### 5. `search_content`

**Defined:** `index.ts:110-143` · **Dispatched:** `index.ts:279-298`

Full-text search across all indexed 3GPP specification content. Returns
matching sections with highlighted snippets, spec number, version, section
title, and position. Requires at least one specification to be synced first.
Use `search_specifications` to discover specs, then `sync_specification` to
download and index them.

**Input schema** (`index.ts:117-142`)

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `query` | `string` | yes | — | Full-text search query. Supports prefix matching (e.g. `"auth"` matches `"authentication"`). |
| `spec_number` | `string` | no | — | Optional: restrict search to a specific specification number. |
| `version` | `string` | no | — | Optional: restrict search to a specific version. |
| `limit` | `number` | no | `20` (per description, `index.ts:134`) | Maximum results to return. |
| `snippet_size` | `number` | no | `32` (per description, `index.ts:138`) | Number of tokens in each result snippet. |

**Dispatch → `APIManager`** (`index.ts:284-289`)

```ts
this.apiManager.searchContent(query, {
  specNumber: (args as any)?.spec_number,
  version:    (args as any)?.version,
  limit:      (args as any)?.limit,
  snippetSize:(args as any)?.snippet_size,
})
```

A missing `query` throws `McpError(InvalidParams, 'query is required')`
(`index.ts:281-283`). Note the snake_case → camelCase mapping for
`spec_number` → `specNumber` and `snippet_size` → `snippetSize`.

---

### 6. `sync_specification`

**Defined:** `index.ts:144-172` · **Dispatched:** `index.ts:300-318`

Download a 3GPP specification from the FTP archive, extract its text content,
and add it to the local full-text index. By default, downloads the latest
available version. After syncing, the spec content becomes searchable via
`search_content` and `find_implementation_requirements`.

**Input schema** (`index.ts:150-171`)

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `spec_number` | `string` | yes | — | Specification number, e.g. `"23.700-40"` or `"38.843"`. |
| `version` | `string` | no | — (downloads latest) | Specific version code to download, e.g. `"j00"` or `"200"`. If omitted, downloads latest. |
| `force` | `boolean` | no | `false` | If true, re-download and re-index even if this version is already indexed. |
| `download_only` | `boolean` | no | `false` | If true, download the `.zip` file but do not extract/index. |

**Dispatch → `APIManager`** (`index.ts:305-309`)

```ts
this.apiManager.syncSpecification(specNumber, {
  version:      (args as any)?.version,
  force:        (args as any)?.force,
  downloadOnly: (args as any)?.download_only,
})
```

A missing `spec_number` throws `McpError(InvalidParams, 'spec_number is required')`
(`index.ts:302-304`). Note the snake_case → camelCase mapping
`download_only` → `downloadOnly`.

---

### 7. `rebuild_index`

**Defined:** `index.ts:173-182` · **Dispatched:** `index.ts:320-330`

Rebuild the full-text index from scratch by re-extracting all `.zip` files in
the downloads directory. Use after manual file additions or to fix a
corrupted index.

**Input schema** (`index.ts:178-181`)

| Parameter | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| — | — | — | — | No parameters. `properties: {}` and no `required` array. |

**Dispatch → `APIManager`** (`index.ts:321`)

```ts
this.apiManager.rebuildIndex()
```

No arguments are read from `args`; the call takes no options.

---

## Dispatch summary

| Tool name | `APIManager` method | Required params | Optional params | Dispatch lines |
| --- | --- | --- | --- | --- |
| `search_specifications` | `searchSpecifications(query, { limit })` | `query`¹ | `limit` | `index.ts:215-227` |
| `get_specification_details` | `getSpecificationDetails(specNumber)` | `spec_number` | — | `index.ts:229-243` |
| `compare_specifications` | `compareSpecifications(specNumbers)` | `spec_numbers` (≥ 2)² | — | `index.ts:245-259` |
| `find_implementation_requirements` | `findImplementationRequirements(feature, { domain, limit })` | `feature` | `domain`, `limit` | `index.ts:261-277` |
| `search_content` | `searchContent(query, { specNumber, version, limit, snippetSize })` | `query` | `spec_number`, `version`, `limit`, `snippet_size` | `index.ts:279-298` |
| `sync_specification` | `syncSpecification(specNumber, { version, force, downloadOnly })` | `spec_number` | `version`, `force`, `download_only` | `index.ts:300-318` |
| `rebuild_index` | `rebuildIndex()` | — | — | `index.ts:320-330` |

¹ `query` is listed as `required` in the schema (`index.ts:48`) but the
dispatcher defaults it to `''` (`index.ts:216`), so an omitted `query` is
tolerated at runtime.
² The minimum-length-2 constraint is enforced only in the dispatch handler
(`index.ts:247-249`), not in the JSON-Schema.

## Argument conventions

- **JSON-Schema vs. dispatch:** The `inputSchema` published to MCP clients is
  the source of truth for what clients should send. The dispatch handler
  re-validates required params and re-throws `McpError(InvalidParams, ...)`.
  For `compare_specifications` it adds a runtime constraint (≥ 2 entries) not
  expressed in the schema.
- **snake_case → camelCase:** Tool input schemas use snake_case
  (`spec_number`, `spec_numbers`, `snippet_size`, `download_only`). The
  dispatch handler maps these to the camelCase parameter names expected by
  `APIManager` methods (`specNumber`, `specNumbers`, `snippetSize`,
  `downloadOnly`).
- **Response shape:** Every successful dispatch returns
  `{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }`,
  i.e. a single text content block holding pretty-printed JSON. Errors that
  are not `McpError` are wrapped into
  `{ content: [{ type: 'text', text: 'Error executing tool "<name>": <msg>' }], isError: true }`
  (`index.ts:335-348`).
