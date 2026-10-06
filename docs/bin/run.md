# `bin/run.js` — Deployed CLI Shim

> **Source path:** `00_Workbench_工作台/mcp-server/bin/run.js`

## File Purpose

`bin/run.js` is the deployed entry point that `npm` registers as the `3gpp-6g-mcp` CLI command. It is a deliberately minimal Node shim whose only job is to load the compiled MCP server at `dist/index.js`. It contains no business logic, no argument parsing, and no error handling of its own — every failure mode it has is whatever `dist/index.js` raises.

The file exists because `package.json`'s `bin` field (`package.json:7-9`) needs a JavaScript file to point at:

```json
"bin": {
  "3gpp-6g-mcp": "./bin/run.js"
}
```

When a user runs `npm install -g 3gpp-6g-mcp-server` (or `npm link`), npm installs a `3gpp-6g-mcp` executable on the `PATH` that invokes this file. The full runtime chain is documented in [`build-and-deploy.md` → Deployed entry chain](../build-and-deploy.md#deployed-entry-chain); the wiring inside `dist/index.js` is documented in [`src/index.md`](../src/index.md) and [`architecture.md`](../architecture.md).

## Dependencies

The file imports nothing. It calls Node's built-in `require` directly; there are no `import` statements and no npm dependencies loaded here. The only thing it `require`s is `../dist/index.js`, which is the compiled output of `src/index.ts` (see [`build-and-deploy.md` → Build output](../build-and-deploy.md#build-output-dist)).

## File contents

The entire file is two lines (`bin/run.js:1-2`):

```js
#!/usr/bin/env node
require('../dist/index.js');
```

### Line 1 — shebang

`#!/usr/bin/env node` (`bin/run.js:1`) is a Unix shebang that tells the OS to execute the file with whatever `node` is on `PATH`. On Windows it is harmless — npm's bin shim handles invocation there. It is required for the `3gpp-6g-mcp` command to be directly executable on POSIX systems after a global install or `npm link`.

### Line 2 — `require('../dist/index.js')`

```js
require('../dist/index.js');
```
(`bin/run.js:2`)

- **Parameter:** the relative path `'../dist/index.js'`, resolved against `__dirname` (the `bin/` directory), so it always points at `<package-root>/dist/index.js` regardless of the process's current working directory.
- **Return value:** the exports of `dist/index.js` (the `ThreeGPP6GMCPServer` class, per `src/index.ts:368`). The return value is discarded — this shim does not use it.
- **Side effects:** Loading `dist/index.js` evaluates the module. Because `bin/run.js` `require`s it as the first module, `dist/index.js` becomes `require.main`, so the `require.main === module` guard at `src/index.ts:360` fires: it constructs `ThreeGPP6GMCPServer`, calls `run()`, and binds a `StdioServerTransport` to stdin/stdout. The server then runs until the stdio transport closes.
- **Error propagation:** Any uncaught rejection from `run()` (or throw from the constructor) is caught by the `.catch` at `src/index.ts:362-365`, which logs `'Fatal error starting server:'` to stderr and exits with code 1. `bin/run.js` itself does not wrap the `require` in `try/catch`, so a synchronous throw during module load would propagate as an uncaught exception and terminate the process with a non-zero exit code.

## How it fits the module

`bin/run.js` is the outermost layer of the deployed package. It is the only file `npm` registers as a `bin`, and it is the only thing an MCP client's `command: "3gpp-6g-mcp"` form (`README.md:88-98`) ever invokes. Everything inside the server — the MCP SDK wiring, the `APIManager`, the four infrastructure modules — is reached transitively from the single `require` on line 2.

The TypeScript source under `src/` is authoritative for the server's behavior; `bin/run.js` is hand-written JavaScript (not compiled from TypeScript) and is not part of the `tsc` build. It ships verbatim in the published package. Reviewers tracing the deployed entry point should read this file, then [`src/index.md`](../src/index.md) for the module it loads.

## Notes and verification

- The file's body (`require('../dist/index.js')`) was read from `bin/run.js:2` during this documentation pass; the shebang is `bin/run.js:1`.
- The `bin` registration at `package.json:7-9` and `main` at `package.json:5` (`"main": "dist/index.js"`) together establish that `bin/run.js → dist/index.js` is the deployed chain — see [`architecture.md` → Deployed entry point and runtime chain](../architecture.md#deployed-entry-point-and-runtime-chain).
- This file is not compiled by `tsc` and has no `.js.map`. It is plain JavaScript by design, so the `bin` target exists before any build step runs (a missing `dist/index.js` would still let `npm install` succeed; it would only fail at runtime).
