# 3GPP 6G MCP Server

A Model Context Protocol (MCP) server that provides **real 3GPP FTP archive access** and **local full-text search** over 6G-related specifications. No mock data — every download comes from `https://www.3gpp.org/ftp/Specs/archive`, and every search runs against a local SQLite FTS5 index built from the actual document text.

## What it does

- **Discover** 6G-related 3GPP specifications from a curated, extensible catalog (29 specs across SA1/SA2/SA3/SA4/SA5/RAN1/RAN2/RAN3).
- **Download** any specification version directly from the 3GPP FTP archive as a `.zip` (containing the `.docx`).
- **Extract** structured text from `.docx` files (section titles, levels, content) via `mammoth`.
- **Index** all extracted sections into a SQLite FTS5 full-text index for fast prefix-matching search.
- **Search** across all indexed specs with highlighted snippets and section-level references.

The server is designed as a **reusable tool**: clone it, point `config.json` at your document directory, and any MCP-compatible client (Claude Desktop, Cursor, VS Code, ZCode, etc.) can search and download 3GPP specs through it.

## Requirements

- **Node.js ≥ 18** (developed and tested on Node 24)
- **npm ≥ 10**
- Windows / macOS / Linux (better-sqlite3 ships prebuilt binaries for all three)
- Internet access to `www.3gpp.org` for FTP downloads

## Installation

```bash
git clone <repo-url> mcp-server
cd mcp-server
npm install
npm run build
```

The build step runs `tsc` and then copies `src/data/` into `dist/data/` so the spec catalog JSON is available at runtime.

## Configuration

Copy the example config and edit the paths for your environment:

```bash
cp config.example.json config.json
```

Then edit `config.json` in the server root:

```json
{
  "documentRoot": "/path/to/your/3gpp-documents",
  "indexPath": "./index/3gpp-fts.db",
  "downloadsDir": "./downloads",
  "ftp": {
    "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "baseUrl": "https://www.3gpp.org/ftp/Specs/archive",
    "retryAttempts": 3,
    "retryDelayMs": 2000,
    "timeoutMs": 30000
  },
  "sync": {
    "autoIndexOnDownload": true,
    "maxConcurrentDownloads": 1,
    "delayBetweenSpecs": 1000
  }
}
```

| Field | Description |
|---|---|
| `documentRoot` | Root directory for your 3GPP document library. |
| `indexPath` | Path to the SQLite FTS5 database (relative to server root). |
| `downloadsDir` | Where downloaded `.zip` files are stored. |
| `ftp.userAgent` | Browser User-Agent string — **required** by the 3GPP FTP server (returns 403 to non-browser UAs). |
| `ftp.baseUrl` | Base URL for the 3GPP spec archive. |
| `sync.autoIndexOnDownload` | If `true`, automatically extract and index after each download. |
| `sync.delayBetweenSpecs` | Delay (ms) between specs in batch sync, to avoid rate-limiting. |

## Connecting to an MCP client

Add the server to your MCP client config. For example, in Claude Desktop's `claude_desktop_config.json`:

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

Or use the bin entry after `npm link`:

```json
{
  "mcpServers": {
    "3gpp-6g": {
      "command": "3gpp-6g-mcp"
    }
  }
}
```

The server communicates over **stdio** (the standard MCP transport).

## MCP Tools

The server exposes 7 tools:

### 1. `search_specifications`
Search the curated 6G spec catalog by keyword (spec number, title, working group, category). Use empty query to list all cataloged specs.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search keyword (or empty string for all) |
| `limit` | number | no | Max results (default 20) |

### 2. `get_specification_details`
Get all available versions for a single spec from the FTP archive, with release labels and local index status.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `spec_number` | string | yes | e.g. `"23.700-40"` or `"38.843"` |

### 3. `compare_specifications`
Compare metadata (title, working group, category, latest version, index status) across multiple specs.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `spec_numbers` | string[] | yes | At least 2 spec numbers |

### 4. `find_implementation_requirements`
Full-text search for requirement-like content related to a feature. Returns matching sections with snippets and references. **Requires the spec to be synced first.**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `feature` | string | yes | e.g. `"SUCI privacy protection"` or `"charging"` |
| `domain` | string | no | Domain context to narrow results |
| `limit` | number | no | Max results (default 30) |

### 5. `search_content`
Full-text search across all indexed spec content. Supports prefix matching (`"auth"` matches `"authentication"`). Returns highlighted snippets with section references.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search terms |
| `spec_number` | string | no | Restrict to one spec |
| `version` | string | no | Restrict to one version |
| `limit` | number | no | Max results (default 20) |
| `snippet_size` | number | no | Tokens per snippet (default 32) |

### 6. `sync_specification`
Download a spec from the FTP archive, extract its text, and add it to the local full-text index. By default downloads the latest version.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `spec_number` | string | yes | e.g. `"23.700-40"` |
| `version` | string | no | Specific version code (e.g. `"j00"`, `"200"`) |
| `force` | boolean | no | Re-download even if already indexed (default false) |
| `download_only` | boolean | no | Download but don't extract/index (default false) |

### 7. `rebuild_index`
Rebuild the full-text index from scratch by re-extracting all `.zip` files in the downloads directory. No parameters.

## Typical workflow

```
1. search_specifications(query="")          → see what 6G specs are cataloged
2. get_specification_details("23.700-40")   → check available versions
3. sync_specification("23.700-40")          → download + extract + index
4. search_content("network slicing")        → full-text search with snippets
5. find_implementation_requirements("QoS")  → find requirement sections
```

## Batch sync

To download and index all 21 cataloged 6G specs in one go:

```bash
npm run sync-all
```

Options:
- `--force` — re-download and re-index even if a version is already indexed
- `--download-only` — download `.zip` files without extracting/indexing

The script writes a `sync-report.json` summarizing success/failure/skip counts per spec. It processes specs sequentially with a configurable delay (`sync.delayBetweenSpecs`) to avoid FTP rate-limiting.

## How FTP access works

The 3GPP FTP archive is served over HTTPS at `https://www.3gpp.org/ftp/Specs/archive/<NN>_series/`. Key behaviors the server relies on:

- **Dotted spec directory names**: `23.700-40` (NOT `23700-40`). Non-dotted paths return 403.
- **Files are `.zip` only**: `.docx`/`.doc` direct downloads return 403. The `.zip` contains the clean `.docx`.
- **Browser User-Agent required**: non-browser UAs get 403. The configured UA string handles this.
- **Version codes**: `<specdir>-<X><YY>` where `X` is the release letter (`a`=Rel-10 … `j`=Rel-19) or a numeric Vmajor for early drafts, and `YY` is the zero-padded minor version.

## Spec catalog

The curated catalog lives at `src/data/6g-spec-catalog.json` and covers 29 specs:

| Category | Specs | Count |
|---|---|---|
| Architecture (SA2) | 23.700-40, 23.700-41, 23.700-42, 23.700-43, 23.700-44, 23.700-45 | 6 |
| RAN physical layer (RAN1) | 38.211, 38.212, 38.213, 38.214, 38.215 | 5 |
| RAN protocol (RAN2) | 38.300, 38.321, 38.331 | 3 |
| RAN studies | 38.843, 38.801, 38.821, 38.890 | 4 |
| Media (SA4) | 26.870 | 1 |
| Services (SA1) | 22.877, 22.878, 22.879 | 3 |
| Security (SA3) | 33.870, 33.871, 33.872 | 3 |
| Management (SA5) | 28.870, 28.871, 28.872 | 3 |
| Tools | 21.918 | 1 |

> **Note on currency:** Physical-layer and protocol specs (38.211–38.215, 38.300, 38.321, 38.331) are updated at every 3GPP meeting cycle. Use `sync_specification` (without a version argument) to always pull the latest published version from the FTP archive.

To add more specs, edit the JSON file and rebuild. Each entry supports: `spec_number`, `title`, `series`, `working_group`, `document_type` (TS/TR), `category`, `notes`.

## Architecture

```
mcp-server/
├── src/
│   ├── index.ts                  # MCP server entry — 7 tool definitions + handlers
│   ├── config.ts                 # Config loader (SERVER_ROOT resolution)
│   ├── api/
│   │   ├── ftp-client.ts         # 3GPP FTP client (series listing, version decode, download)
│   │   ├── spec-catalog.ts       # Catalog loader with dual-path fallback
│   │   ├── docx-extractor.ts     # .docx text extraction via mammoth (with .doc soffice fallback)
│   │   ├── search-index.ts       # SQLite FTS5 full-text index
│   │   └── api-manager.ts        # Orchestration layer (8 methods)
│   ├── scripts/
│   │   └── sync-all-6g.ts        # Batch sync script
│   └── data/
│       └── 6g-spec-catalog.json  # Curated 6G spec catalog (29 entries)
├── bin/run.js                    # CLI entry point
├── config.example.json           # Template — copy to config.json and edit
├── config.json                   # User configuration (gitignored)
├── downloads/                    # Downloaded .zip files (gitignored)
├── index/                        # SQLite FTS5 database (gitignored)
├── package.json
├── tsconfig.json
└── README.md
```

### Data flow

```
sync_specification("23.700-40")
  │
  ├─ FTPClient.getSpecVersions("23.700-40")
  │    → GET https://www.3gpp.org/ftp/Specs/archive/23_series/23.700-40/
  │    → parse HTML → version codes → decode release labels
  │
  ├─ FTPClient.downloadVersion("23.700-40", "h00")
  │    → GET .../23.700-40/23700-40-h00.zip → save to downloads/
  │
  ├─ DocxExtractor.extractDocument(zipPath)
  │    → adm-zip unzip → mammoth extractRawText → parse headings → sections[]
  │
  └─ SearchIndex.indexDocument(extractedDoc)
       → DELETE old rows for this spec+version
       → INSERT sections into FTS5 virtual table
       → ready for search_content / find_implementation_requirements
```

## License

BSD-3-Clause.
