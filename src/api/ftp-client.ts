import axios, { AxiosInstance } from 'axios';
import { config } from '../config';

/**
 * 3GPP FTP archive client.
 *
 * Access pattern (verified):
 *   Series listing:   GET {baseUrl}/{NN}_series/            → HTML with dotted spec dir links (e.g. "23.700-40")
 *   Per-spec listing: GET {baseUrl}/{NN}_series/{dotted}/   → HTML with .zip file links (e.g. "23700-40-200.zip")
 *   File download:    GET {baseUrl}/{NN}_series/{dotted}/{file}.zip  → binary zip (contains .docx inside)
 *
 * Rules:
 *   - Directory names MUST use dotted format ("23.700-40", not "23700-40")
 *   - Files are ONLY served as .zip (direct .docx/.doc → HTTP 403)
 *   - Browser User-Agent is required
 *
 * Version encoding in filenames:
 *   <specdir>-<X><YY>.zip where:
 *     X is a letter  → release = 10 + (ord(X) - ord('a')); a=Rel-10, ..., j=Rel-19
 *     X is a digit   → early/draft version; Vmajor = int(X)
 *     YY = zero-padded minor version
 */

export interface SpecVersion {
  versionCode: string;   // raw code from filename, e.g. "200", "j00", "h00"
  filename: string;      // full filename, e.g. "23700-40-200.zip"
  downloadUrl: string;   // full URL
  release: number | null; // null for numeric Vmajor drafts
  releaseLabel: string | null; // e.g. "Rel-17", null for drafts
  majorVersion: number;
  minorVersion: number;
  isDraft: boolean;
}

export interface SeriesEntry {
  specDir: string;       // dotted directory name, e.g. "23.700-40"
  specNumber: string;    // normalized spec number, e.g. "23.700-40"
  url: string;
}

const RELEASE_LETTER_BASE = 'a'.charCodeAt(0); // a = Rel-10

function decodeVersionCode(code: string): {
  release: number | null;
  releaseLabel: string | null;
  majorVersion: number;
  minorVersion: number;
  isDraft: boolean;
} {
  if (code.length < 2) {
    return { release: null, releaseLabel: null, majorVersion: 0, minorVersion: 0, isDraft: true };
  }
  const firstChar = code[0];
  const rest = code.slice(1);

  if (/[a-j]/.test(firstChar)) {
    // Release letter: a=Rel-10 ... j=Rel-19
    const release = 10 + (firstChar.charCodeAt(0) - RELEASE_LETTER_BASE);
    const minor = parseInt(rest, 10);
    return {
      release,
      releaseLabel: `Rel-${release}`,
      majorVersion: 0,
      minorVersion: isNaN(minor) ? 0 : minor,
      isDraft: false,
    };
  } else if (/\d/.test(firstChar)) {
    // Numeric Vmajor (early/draft versions)
    const major = parseInt(firstChar, 10);
    const minor = parseInt(rest, 10);
    return {
      release: null,
      releaseLabel: null,
      majorVersion: major,
      minorVersion: isNaN(minor) ? 0 : minor,
      isDraft: true,
    };
  }

  return { release: null, releaseLabel: null, majorVersion: 0, minorVersion: 0, isDraft: true };
}

/**
 * Convert a spec number like "23.700-40" to:
 *   - series: "23"
 *   - dottedDir: "23.700-40" (used in URL path)
 *   - filePrefix: "23700-40" (used in filenames, dots removed)
 */
export function specToPaths(specNumber: string): { series: string; dottedDir: string; filePrefix: string } {
  const parts = specNumber.split('.');
  const series = parts[0];
  const dottedDir = specNumber;
  const filePrefix = specNumber.replace(/\./g, '');
  return { series, dottedDir, filePrefix };
}

export class FtpClient {
  private httpClient: AxiosInstance;

  constructor() {
    this.httpClient = axios.create({
      baseURL: config.ftp.baseUrl,
      timeout: config.ftp.timeoutMs,
      headers: {
        'User-Agent': config.ftp.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      responseType: 'text',
      maxRedirects: 5,
    });
  }

  /**
   * List all spec directories under a series (e.g. "23" → 23_series).
   * Returns parsed entries with dotted directory names.
   */
  async getSeriesListing(series: string): Promise<SeriesEntry[]> {
    const url = `/${series}_series/`;
    const html = await this.fetchWithRetry(url);

    // Parse HTML for href links to spec directories.
    // Links look like: href="23.700-40/" or href="https://.../23_series/23.700-40/"
    const entries: SeriesEntry[] = [];
    const linkRegex = /href="([^"]*?)"/gi;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();

    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      // Extract the last path segment, strip trailing slash
      const trimmed = href.replace(/\/+$/, '').replace(/\?.*$/, '').replace(/#.*$/, '');
      const lastSegment = trimmed.split('/').pop() || '';

      // Must look like a spec directory: NN.NNN or NN.NNN-NN (dotted format)
      if (/^\d{2}\.\d{3}(-\d{2})?$/.test(lastSegment)) {
        if (!seen.has(lastSegment)) {
          seen.add(lastSegment);
          const fullUrl = `${config.ftp.baseUrl}/${series}_series/${lastSegment}/`;
          entries.push({ specDir: lastSegment, specNumber: lastSegment, url: fullUrl });
        }
      }
    }

    return entries.sort((a, b) => a.specDir.localeCompare(b.specDir));
  }

  /**
   * Get all available versions for a specification.
   * @param specNumber e.g. "23.700-40" or "38.843"
   */
  async getSpecVersions(specNumber: string): Promise<SpecVersion[]> {
    const { series, dottedDir, filePrefix } = specToPaths(specNumber);
    const url = `/${series}_series/${dottedDir}/`;
    const html = await this.fetchWithRetry(url);

    const versions: SpecVersion[] = [];
    const linkRegex = /href="([^"]*?)"/gi;
    let match: RegExpExecArray | null;
    const seen = new Set<string>();

    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      const filename = href.split('/').pop() || '';

      // Must be a .zip file starting with the spec's file prefix
      if (filename.endsWith('.zip') && filename.startsWith(filePrefix + '-')) {
        // Extract version code: "<filePrefix>-<code>.zip" → code
        const codeMatch = filename.match(new RegExp('^' + escapeRegex(filePrefix) + '-(.+)\\.zip$'));
        if (codeMatch) {
          const versionCode = codeMatch[1];
          if (!seen.has(versionCode)) {
            seen.add(versionCode);
            const decoded = decodeVersionCode(versionCode);
            const downloadUrl = `${config.ftp.baseUrl}/${series}_series/${dottedDir}/${filename}`;
            versions.push({
              versionCode,
              filename,
              downloadUrl,
              ...decoded,
            });
          }
        }
      }
    }

    // Sort: non-draft (release letter) versions first, by release desc; then drafts by major desc
    return versions.sort((a, b) => {
      if (a.isDraft !== b.isDraft) return a.isDraft ? 1 : -1;
      if (a.release !== null && b.release !== null) return b.release - a.release;
      if (a.majorVersion !== b.majorVersion) return b.majorVersion - a.majorVersion;
      return b.minorVersion - a.minorVersion;
    });
  }

  /**
   * Download a specific version's .zip file.
   * Returns a Buffer containing the zip archive (caller extracts .docx).
   */
  async downloadVersion(specNumber: string, versionCode: string): Promise<Buffer> {
    const { series, dottedDir, filePrefix } = specToPaths(specNumber);
    const filename = `${filePrefix}-${versionCode}.zip`;
    const url = `/${series}_series/${dottedDir}/${filename}`;

    const response = await this.httpClient.get(url, {
      responseType: 'arraybuffer',
      maxRedirects: 5,
    });

    if (response.status !== 200) {
      throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
    }

    return Buffer.from(response.data as ArrayBuffer);
  }

  /**
   * Get the latest non-draft version for a spec.
   * Falls back to the highest draft if no release versions exist.
   */
  async getLatestVersion(specNumber: string): Promise<SpecVersion | null> {
    const versions = await this.getSpecVersions(specNumber);
    if (versions.length === 0) return null;
    // Versions are sorted: non-draft first by release desc, then drafts
    return versions[0];
  }

  /**
   * Fetch with retry logic and browser headers.
   */
  private async fetchWithRetry(url: string): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < config.ftp.retryAttempts; attempt++) {
      try {
        const response = await this.httpClient.get(url);
        if (response.status === 200) {
          return response.data as string;
        }
        if (response.status === 403) {
          // 403 is a hard block, don't retry — throw immediately
          throw new Error(`HTTP 403 Forbidden: ${url}`);
        }
        lastError = new Error(`HTTP ${response.status}: ${url}`);
      } catch (err: any) {
        if (err.message?.includes('403')) throw err;
        lastError = err;
      }

      if (attempt < config.ftp.retryAttempts - 1) {
        await sleep(config.ftp.retryDelayMs * (attempt + 1));
      }
    }

    throw lastError ?? new Error(`Failed to fetch ${url} after ${config.ftp.retryAttempts} attempts`);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Singleton
let ftpClientInstance: FtpClient | null = null;

export function getFtpClient(): FtpClient {
  if (!ftpClientInstance) {
    ftpClientInstance = new FtpClient();
  }
  return ftpClientInstance;
}
