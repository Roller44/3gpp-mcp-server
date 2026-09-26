import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { config, ensureDataDirs } from '../config';
import { getFtpClient, specToPaths, SpecVersion } from './ftp-client';
import { getCatalogSpecs, findCatalogEntry, getCatalogStats, CatalogEntry } from './spec-catalog';
import { extractDocument, ExtractedDocument } from './docx-extractor';
import { getSearchIndex, SearchIndex, SearchResult } from './search-index';

/**
 * API Manager — orchestrates the FTP client, spec catalog, DOCX extractor,
 * and FTS5 search index to provide the high-level operations exposed as MCP tools.
 */

export interface SearchSpecsResult {
  query: string;
  totalFound: number;
  results: {
    spec_number: string;
    title: string;
    working_group: string;
    category: string;
    notes: string;
    isIndexed: boolean;
    latestVersion: string | null;
    releaseLabel: string | null;
    availableVersions: number;
  }[];
}

export interface SpecDetailsResult {
  spec_number: string;
  title: string;
  working_group: string;
  category: string;
  document_type: string;
  notes: string;
  versions: {
    versionCode: string;
    filename: string;
    release: number | null;
    releaseLabel: string | null;
    isDraft: boolean;
    isIndexed: boolean;
    downloadUrl: string;
  }[];
  indexedVersions: { version: string; section_count: number; indexed_at: string }[];
}

export interface ContentSearchResult {
  query: string;
  totalFound: number;
  results: SearchResult[];
  indexStats: { totalDocuments: number; totalSections: number };
}

export interface SyncResult {
  spec_number: string;
  title: string;
  status: 'synced' | 'skipped' | 'failed' | 'no_versions';
  version?: string;
  releaseLabel?: string | null;
  message: string;
  sections?: number;
  filePath?: string;
  fileSize?: number;
}

export interface CompareResult {
  specifications: {
    spec_number: string;
    title: string;
    working_group: string;
    category: string;
    document_type: string;
    latestVersion: string | null;
    releaseLabel: string | null;
    availableVersions: number;
    isIndexed: boolean;
    indexedVersions: string[];
  }[];
  comparison: {
    commonCategories: string[];
    commonWorkingGroups: string[];
    notes: string;
  };
}

export interface ImplementationRequirementsResult {
  feature: string;
  totalFound: number;
  results: SearchResult[];
  relatedSpecs: string[];
}

export class APIManager {
  private ftpClient = getFtpClient();
  private searchIndex: SearchIndex;

  constructor() {
    ensureDataDirs();
    this.searchIndex = getSearchIndex();
  }

  /**
   * Search the 6G spec catalog by keyword. Returns matching specs with
   * version info from the FTP archive and local index status.
   */
  async searchSpecifications(query: string, options: { limit?: number } = {}): Promise<SearchSpecsResult> {
    const limit = options.limit ?? 20;
    const q = query.toLowerCase().trim();

    const allSpecs = getCatalogSpecs();
    let matched: CatalogEntry[];

    if (!q) {
      matched = allSpecs;
    } else {
      matched = allSpecs.filter((s) => {
        return (
          s.spec_number.toLowerCase().includes(q) ||
          s.title.toLowerCase().includes(q) ||
          s.working_group.toLowerCase().includes(q) ||
          s.category.toLowerCase().includes(q) ||
          s.notes.toLowerCase().includes(q)
        );
      });
    }

    matched = matched.slice(0, limit);

    // Enrich with FTP version info and index status
    const results = await Promise.all(
      matched.map(async (spec) => {
        let latestVersion: string | null = null;
        let releaseLabel: string | null = null;
        let availableVersions = 0;

        try {
          const versions = await this.ftpClient.getSpecVersions(spec.spec_number);
          availableVersions = versions.length;
          if (versions.length > 0) {
            const latest = versions[0];
            latestVersion = latest.versionCode;
            releaseLabel = latest.releaseLabel;
          }
        } catch {
          // FTP may be unavailable; continue with what we have
        }

        const indexedSpecs = this.searchIndex.getIndexedSpecs();
        const isIndexed = indexedSpecs.some((s) => s.spec_number === spec.spec_number);

        return {
          spec_number: spec.spec_number,
          title: spec.title,
          working_group: spec.working_group,
          category: spec.category,
          notes: spec.notes,
          isIndexed,
          latestVersion,
          releaseLabel,
          availableVersions,
        };
      })
    );

    return {
      query,
      totalFound: results.length,
      results,
    };
  }

  /**
   * Get detailed information about a specific specification, including all
   * available versions from the FTP archive and which versions are indexed.
   */
  async getSpecificationDetails(specNumber: string): Promise<SpecDetailsResult> {
    const catalogEntry = findCatalogEntry(specNumber);

    // Get versions from FTP
    let versions: SpecVersion[] = [];
    try {
      versions = await this.ftpClient.getSpecVersions(specNumber);
    } catch {
      // FTP unavailable
    }

    // Get indexed versions
    const indexedSpecs = this.searchIndex.getIndexedSpecs().filter((s) => s.spec_number === specNumber);
    const indexedVersionSet = new Set(indexedSpecs.map((s) => s.version));

    return {
      spec_number: specNumber,
      title: catalogEntry?.title ?? '(not in 6G catalog)',
      working_group: catalogEntry?.working_group ?? 'unknown',
      category: catalogEntry?.category ?? 'unknown',
      document_type: catalogEntry?.document_type ?? 'unknown',
      notes: catalogEntry?.notes ?? '',
      versions: versions.map((v) => ({
        versionCode: v.versionCode,
        filename: v.filename,
        release: v.release,
        releaseLabel: v.releaseLabel,
        isDraft: v.isDraft,
        isIndexed: indexedVersionSet.has(v.versionCode),
        downloadUrl: v.downloadUrl,
      })),
      indexedVersions: indexedSpecs.map((s) => ({
        version: s.version,
        section_count: s.section_count,
        indexed_at: s.indexed_at,
      })),
    };
  }

  /**
   * Full-text search across indexed specification content.
   */
  async searchContent(query: string, options: {
    specNumber?: string;
    version?: string;
    limit?: number;
    snippetSize?: number;
  } = {}): Promise<ContentSearchResult> {
    const results = this.searchIndex.search(query, {
      specNumber: options.specNumber,
      version: options.version,
      limit: options.limit ?? 20,
      snippetSize: options.snippetSize ?? 32,
    });

    const stats = this.searchIndex.getStats();

    return {
      query,
      totalFound: results.length,
      results,
      indexStats: {
        totalDocuments: stats.totalDocuments,
        totalSections: stats.totalSections,
      },
    };
  }

  /**
   * Sync a specification: download the latest version from FTP, extract text,
   * and add to the full-text index.
   */
  async syncSpecification(specNumber: string, options: {
    version?: string;        // specific version; if omitted, download latest
    force?: boolean;         // re-download even if already indexed
    downloadOnly?: boolean;  // download to document tree but don't index
  } = {}): Promise<SyncResult> {
    const catalogEntry = findCatalogEntry(specNumber);
    const title = catalogEntry?.title ?? specNumber;

    // Determine which version to download
    let targetVersion: SpecVersion | null = null;
    try {
      if (options.version) {
        const versions = await this.ftpClient.getSpecVersions(specNumber);
        targetVersion = versions.find((v) => v.versionCode === options.version) ?? null;
        if (!targetVersion) {
          return {
            spec_number: specNumber,
            title,
            status: 'no_versions',
            message: `Version ${options.version} not found on FTP for ${specNumber}`,
          };
        }
      } else {
        targetVersion = await this.ftpClient.getLatestVersion(specNumber);
      }
    } catch (err: any) {
      return {
        spec_number: specNumber,
        title,
        status: 'failed',
        message: `Failed to get version info from FTP: ${err.message}`,
      };
    }

    if (!targetVersion) {
      return {
        spec_number: specNumber,
        title,
        status: 'no_versions',
        message: `No versions found on FTP for ${specNumber}`,
      };
    }

    // Check if already indexed
    if (!options.force && !options.downloadOnly && this.searchIndex.isIndexed(specNumber, targetVersion.versionCode)) {
      return {
        spec_number: specNumber,
        title,
        status: 'skipped',
        version: targetVersion.versionCode,
        releaseLabel: targetVersion.releaseLabel,
        message: `Version ${targetVersion.versionCode} already indexed`,
      };
    }

    // Download the .zip file
    let zipBuffer: Buffer;
    try {
      zipBuffer = await this.ftpClient.downloadVersion(specNumber, targetVersion.versionCode);
    } catch (err: any) {
      return {
        spec_number: specNumber,
        title,
        status: 'failed',
        version: targetVersion.versionCode,
        releaseLabel: targetVersion.releaseLabel,
        message: `Download failed: ${err.message}`,
      };
    }

    // Save .zip to downloads dir
    const { filePrefix } = specToPaths(specNumber);
    const zipFilename = `${filePrefix}-${targetVersion.versionCode}.zip`;
    const zipPath = path.join(config.downloadsDir, zipFilename);
    fs.writeFileSync(zipPath, zipBuffer);

    if (options.downloadOnly) {
      return {
        spec_number: specNumber,
        title,
        status: 'synced',
        version: targetVersion.versionCode,
        releaseLabel: targetVersion.releaseLabel,
        message: `Downloaded to ${zipPath}`,
        filePath: zipPath,
        fileSize: zipBuffer.length,
      };
    }

    // Extract text and index
    const tempDir = path.join(os.tmpdir(), '3gpp-mcp-extract');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    try {
      const extracted = await extractDocument(zipPath, specNumber, targetVersion.versionCode, tempDir);
      this.searchIndex.indexDocument(extracted);

      return {
        spec_number: specNumber,
        title,
        status: 'synced',
        version: targetVersion.versionCode,
        releaseLabel: targetVersion.releaseLabel,
        message: `Downloaded and indexed ${extracted.sectionCount} sections`,
        sections: extracted.sectionCount,
        filePath: zipPath,
        fileSize: zipBuffer.length,
      };
    } catch (err: any) {
      return {
        spec_number: specNumber,
        title,
        status: 'failed',
        version: targetVersion.versionCode,
        releaseLabel: targetVersion.releaseLabel,
        message: `Extraction/indexing failed: ${err.message}`,
      };
    }
  }

  /**
   * Download a specification to the 6GStandard document tree (without indexing).
   */
  async downloadSpecification(specNumber: string, version?: string): Promise<SyncResult> {
    return this.syncSpecification(specNumber, { version, downloadOnly: true });
  }

  /**
   * Rebuild the full-text index by re-extracting all files in the downloads dir.
   */
  async rebuildIndex(): Promise<{ totalDocuments: number; totalSections: number; errors: string[] }> {
    const errors: string[] = [];

    // Scan downloads dir for .zip files
    if (!fs.existsSync(config.downloadsDir)) {
      return { totalDocuments: 0, totalSections: 0, errors: ['Downloads directory does not exist'] };
    }

    const files = fs.readdirSync(config.downloadsDir).filter((f) => f.endsWith('.zip'));
    const tempDir = path.join(os.tmpdir(), '3gpp-mcp-extract');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    let totalSections = 0;
    let totalDocs = 0;

    for (const file of files) {
      // Parse spec number and version from filename: <filePrefix>-<version>.zip
      const match = file.match(/^(.+)-([a-j]\d{2}|\d{3})\.zip$/);
      if (!match) {
        errors.push(`Could not parse filename: ${file}`);
        continue;
      }

      const filePrefix = match[1];
      const versionCode = match[2];
      // Convert file prefix back to spec number (insert dot after series)
      const specNumber = filePrefix.replace(/^(\d{2})(\d{3})/, '$1.$2');

      try {
        const zipPath = path.join(config.downloadsDir, file);
        const extracted = await extractDocument(zipPath, specNumber, versionCode, tempDir);
        this.searchIndex.indexDocument(extracted);
        totalSections += extracted.sectionCount;
        totalDocs++;
      } catch (err: any) {
        errors.push(`${file}: ${err.message}`);
      }
    }

    const stats = this.searchIndex.getStats();
    return {
      totalDocuments: stats.totalDocuments,
      totalSections: stats.totalSections,
      errors,
    };
  }

  /**
   * Compare multiple specifications — their metadata, available versions,
   * and index status.
   */
  async compareSpecifications(specNumbers: string[]): Promise<CompareResult> {
    const specs = await Promise.all(
      specNumbers.map(async (specNumber) => {
        const catalogEntry = findCatalogEntry(specNumber);
        let latestVersion: string | null = null;
        let releaseLabel: string | null = null;
        let availableVersions = 0;

        try {
          const versions = await this.ftpClient.getSpecVersions(specNumber);
          availableVersions = versions.length;
          if (versions.length > 0) {
            latestVersion = versions[0].versionCode;
            releaseLabel = versions[0].releaseLabel;
          }
        } catch { /* FTP unavailable */ }

        const indexedSpecs = this.searchIndex.getIndexedSpecs().filter((s) => s.spec_number === specNumber);

        return {
          spec_number: specNumber,
          title: catalogEntry?.title ?? '(not in catalog)',
          working_group: catalogEntry?.working_group ?? 'unknown',
          category: catalogEntry?.category ?? 'unknown',
          document_type: catalogEntry?.document_type ?? 'unknown',
          latestVersion,
          releaseLabel,
          availableVersions,
          isIndexed: indexedSpecs.length > 0,
          indexedVersions: indexedSpecs.map((s) => s.version),
        };
      })
    );

    // Compute common categories and working groups
    const categories = specs.map((s) => s.category).filter((c) => c !== 'unknown');
    const workingGroups = specs.map((s) => s.working_group).filter((w) => w !== 'unknown');

    const commonCategories = [...new Set(categories.filter((c) => categories.filter((x) => x === c).length > 1))];
    const commonWorkingGroups = [...new Set(workingGroups.filter((w) => workingGroups.filter((x) => x === w).length > 1))];

    const notes = commonCategories.length > 0 || commonWorkingGroups.length > 0
      ? `These specifications share ${commonCategories.length > 0 ? `categories: ${commonCategories.join(', ')}` : ''}${commonCategories.length > 0 && commonWorkingGroups.length > 0 ? '; ' : ''}${commonWorkingGroups.length > 0 ? `working groups: ${commonWorkingGroups.join(', ')}` : ''}.`
      : 'These specifications belong to different categories and working groups.';

    return {
      specifications: specs,
      comparison: { commonCategories, commonWorkingGroups, notes },
    };
  }

  /**
   * Search the full-text index for implementation requirement content
   * related to a feature.
   */
  async findImplementationRequirements(
    feature: string,
    options: { limit?: number; domain?: string } = {}
  ): Promise<ImplementationRequirementsResult> {
    const query = options.domain ? `${feature} ${options.domain}` : feature;
    const results = this.searchIndex.search(query, {
      limit: options.limit ?? 30,
      snippetSize: 48,
    });

    const relatedSpecs = [...new Set(results.map((r) => r.spec_number))];

    return {
      feature,
      totalFound: results.length,
      results,
      relatedSpecs,
    };
  }

  /**
   * Get catalog statistics.
   */
  getCatalogStats() {
    return getCatalogStats();
  }

  /**
   * Get index statistics.
   */
  getIndexStats() {
    return this.searchIndex.getStats();
  }

  /**
   * Get the list of indexed specs.
   */
  getIndexedSpecs() {
    return this.searchIndex.getIndexedSpecs();
  }
}
