import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { APIManager } from './api/api-manager';

/**
 * 3GPP 6G MCP Server
 *
 * Provides real FTP-based specification discovery, download, and local
 * full-text search over 6G-related 3GPP specifications.
 *
 * Tools:
 *   1. search_specifications       — search the 6G spec catalog
 *   2. get_specification_details   — get versions + release info for one spec
 *   3. compare_specifications      — compare metadata across specs
 *   4. find_implementation_requirements — search indexed content for requirements
 *   5. search_content              — full-text search across indexed specs
 *   6. sync_specification          — download + extract + index a spec
 *   7. rebuild_index               — rebuild the full-text index from downloads
 */

const TOOL_DEFINITIONS = [
  {
    name: 'search_specifications',
    description:
      'Search the curated 6G specification catalog by keyword (spec number, title, working group, or category). ' +
      'Returns matching specifications with their latest available version from the 3GPP FTP archive and local index status. ' +
      'Use this to discover which 6G-related 3GPP specifications exist.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Search query. Matched against spec number, title, working group, category, and notes. ' +
            'Use empty string to list all cataloged specs.',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default 20).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_specification_details',
    description:
      'Get detailed information about a single 3GPP specification: all available versions from the FTP archive, ' +
      'release labels, draft status, and which versions are locally indexed. ' +
      'Use this before downloading or to check what versions exist.',
    inputSchema: {
      type: 'object',
      properties: {
        spec_number: {
          type: 'string',
          description: 'Specification number, e.g. "23.700-40" or "38.843".',
        },
      },
      required: ['spec_number'],
    },
  },
  {
    name: 'compare_specifications',
    description:
      'Compare metadata across multiple 3GPP specifications: titles, working groups, categories, ' +
      'latest versions, and index status. Identifies shared categories and working groups.',
    inputSchema: {
      type: 'object',
      properties: {
        spec_numbers: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of specification numbers to compare, e.g. ["23.700-40", "38.843"].',
        },
      },
      required: ['spec_numbers'],
    },
  },
  {
    name: 'find_implementation_requirements',
    description:
      'Search the full-text index for implementation requirement content related to a feature. ' +
      'Returns matching sections with snippets, spec references, and section positions. ' +
      'Requires the specification to be synced (indexed) first.',
    inputSchema: {
      type: 'object',
      properties: {
        feature: {
          type: 'string',
          description: 'The feature or functionality to search for, e.g. "SUCI privacy protection" or "charging".',
        },
        domain: {
          type: 'string',
          description: 'Optional domain context to narrow the search, e.g. "security" or "mobility".',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default 30).',
        },
      },
      required: ['feature'],
    },
  },
  {
    name: 'search_content',
    description:
      'Full-text search across all indexed 3GPP specification content. Returns matching sections with ' +
      'highlighted snippets, spec number, version, section title, and position. ' +
      'Requires at least one specification to be synced first. Use search_specifications to discover specs, ' +
      'then sync_specification to download and index them.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Full-text search query. Supports prefix matching (e.g. "auth" matches "authentication").',
        },
        spec_number: {
          type: 'string',
          description: 'Optional: restrict search to a specific specification number.',
        },
        version: {
          type: 'string',
          description: 'Optional: restrict search to a specific version.',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default 20).',
        },
        snippet_size: {
          type: 'number',
          description: 'Number of tokens in each result snippet (default 32).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'sync_specification',
    description:
      'Download a 3GPP specification from the FTP archive, extract its text content, and add it to the ' +
      'local full-text index. By default, downloads the latest available version. ' +
      'After syncing, the spec content becomes searchable via search_content and find_implementation_requirements.',
    inputSchema: {
      type: 'object',
      properties: {
        spec_number: {
          type: 'string',
          description: 'Specification number, e.g. "23.700-40" or "38.843".',
        },
        version: {
          type: 'string',
          description: 'Optional: specific version code to download (e.g. "j00", "200"). If omitted, downloads latest.',
        },
        force: {
          type: 'boolean',
          description: 'If true, re-download and re-index even if this version is already indexed (default false).',
        },
        download_only: {
          type: 'boolean',
          description: 'If true, download the .zip file but do not extract/index (default false).',
        },
      },
      required: ['spec_number'],
    },
  },
  {
    name: 'rebuild_index',
    description:
      'Rebuild the full-text index from scratch by re-extracting all .zip files in the downloads directory. ' +
      'Use this after manual file additions or to fix a corrupted index.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

class ThreeGPP6GMCPServer {
  private server: Server;
  private apiManager: APIManager;

  constructor() {
    this.server = new Server(
      {
        name: '3gpp-6g-mcp-server',
        version: '1.0.0',
        description: '3GPP 6G MCP Server — real FTP download + local full-text search',
      },
      { capabilities: { tools: {} } }
    );

    this.apiManager = new APIManager();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOL_DEFINITIONS,
    }));

    // Call tool
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'search_specifications': {
            const query = (args as any)?.query ?? '';
            const limit = (args as any)?.limit;
            const result = await this.apiManager.searchSpecifications(query, { limit });
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'get_specification_details': {
            const specNumber = (args as any)?.spec_number;
            if (!specNumber) {
              throw new McpError(ErrorCode.InvalidParams, 'spec_number is required');
            }
            const result = await this.apiManager.getSpecificationDetails(specNumber);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'compare_specifications': {
            const specNumbers = (args as any)?.spec_numbers;
            if (!Array.isArray(specNumbers) || specNumbers.length < 2) {
              throw new McpError(ErrorCode.InvalidParams, 'spec_numbers must be an array of at least 2 spec numbers');
            }
            const result = await this.apiManager.compareSpecifications(specNumbers);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'find_implementation_requirements': {
            const feature = (args as any)?.feature;
            if (!feature) {
              throw new McpError(ErrorCode.InvalidParams, 'feature is required');
            }
            const domain = (args as any)?.domain;
            const limit = (args as any)?.limit;
            const result = await this.apiManager.findImplementationRequirements(feature, { domain, limit });
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'search_content': {
            const query = (args as any)?.query;
            if (!query) {
              throw new McpError(ErrorCode.InvalidParams, 'query is required');
            }
            const result = await this.apiManager.searchContent(query, {
              specNumber: (args as any)?.spec_number,
              version: (args as any)?.version,
              limit: (args as any)?.limit,
              snippetSize: (args as any)?.snippet_size,
            });
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'sync_specification': {
            const specNumber = (args as any)?.spec_number;
            if (!specNumber) {
              throw new McpError(ErrorCode.InvalidParams, 'spec_number is required');
            }
            const result = await this.apiManager.syncSpecification(specNumber, {
              version: (args as any)?.version,
              force: (args as any)?.force,
              downloadOnly: (args as any)?.download_only,
            });
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          case 'rebuild_index': {
            const result = await this.apiManager.rebuildIndex();
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          }

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error: any) {
        if (error instanceof McpError) {
          throw error;
        }
        return {
          content: [
            {
              type: 'text',
              text: `Error executing tool "${name}": ${error.message || String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('3GPP 6G MCP Server running on stdio');
  }
}

// Entry point
if (require.main === module) {
  const server = new ThreeGPP6GMCPServer();
  server.run().catch((error) => {
    console.error('Fatal error starting server:', error);
    process.exit(1);
  });
}

export { ThreeGPP6GMCPServer };
