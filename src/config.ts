/**
 * Configuration loader for the 3GPP 6G MCP Server.
 *
 * Reads config.json from the server root, resolves relative paths against
 * the server directory, and applies environment-variable overrides.
 */

import * as path from 'path';
import * as fs from 'fs';

export interface FtpConfig {
  userAgent: string;
  baseUrl: string;
  dynareportUrl: string;
  retryAttempts: number;
  retryDelayMs: number;
  timeoutMs: number;
}

export interface SyncConfig {
  autoIndexOnDownload: boolean;
  maxConcurrentDownloads: number;
  delayBetweenSpecs: number;
}

export interface ServerConfig {
  documentRoot: string;
  indexPath: string;
  downloadsDir: string;
  ftp: FtpConfig;
  sync: SyncConfig;
}

/** Directory where the compiled server lives (dist/), used to resolve sibling paths. */
const SERVER_ROOT = path.resolve(__dirname, '..');

function loadConfigFile(): Partial<ServerConfig> {
  const configPath = path.join(SERVER_ROOT, 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    // config.json missing or invalid — fall back to defaults below
    return {};
  }
}

function resolveMaybeRelative(p: string | undefined, fallback: string): string {
  const v = p && p.length > 0 ? p : fallback;
  return path.isAbsolute(v) ? v : path.resolve(SERVER_ROOT, v);
}

function buildConfig(): ServerConfig {
  const file = loadConfigFile();

  const documentRoot = resolveMaybeRelative(
    process.env.SPECS_DOCUMENT_ROOT ?? file.documentRoot,
    'D:\\Work\\6GStandard'
  );

  const indexPath = resolveMaybeRelative(
    process.env.SPECS_INDEX_PATH ?? file.indexPath,
    './index/3gpp-fts.db'
  );

  const downloadsDir = resolveMaybeRelative(
    process.env.SPECS_DOWNLOADS_DIR ?? file.downloadsDir,
    './downloads'
  );

  const ftp: Partial<FtpConfig> = file.ftp ?? {};
  const sync: Partial<SyncConfig> = file.sync ?? {};

  return {
    documentRoot,
    indexPath,
    downloadsDir,
    ftp: {
      userAgent: ftp.userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      baseUrl: ftp.baseUrl ?? 'https://www.3gpp.org/ftp/Specs/archive',
      dynareportUrl: ftp.dynareportUrl ?? 'https://www.3gpp.org/dynareport',
      retryAttempts: ftp.retryAttempts ?? 3,
      retryDelayMs: ftp.retryDelayMs ?? 2000,
      timeoutMs: ftp.timeoutMs ?? 30000,
    },
    sync: {
      autoIndexOnDownload: sync.autoIndexOnDownload ?? true,
      maxConcurrentDownloads: sync.maxConcurrentDownloads ?? 1,
      delayBetweenSpecs: sync.delayBetweenSpecs ?? 1000,
    },
  };
}

// Load once at module import time.
export const config: ServerConfig = buildConfig();

/** Ensure the index directory and downloads directory exist. Call on startup. */
export function ensureDataDirs(): void {
  const indexDir = path.dirname(config.indexPath);
  if (!fs.existsSync(indexDir)) {
    fs.mkdirSync(indexDir, { recursive: true });
  }
  if (!fs.existsSync(config.downloadsDir)) {
    fs.mkdirSync(config.downloadsDir, { recursive: true });
  }
}
