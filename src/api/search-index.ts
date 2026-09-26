import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { config } from '../config';
import { ExtractedDocument, DocSection } from './docx-extractor';

/**
 * SQLite FTS5 full-text search index for 3GPP specification content.
 *
 * Each section of an extracted document is indexed as a separate row,
 * enabling section-level search with position references.
 *
 * Schema:
 *   spec_content (FTS5 virtual table):
 *     spec_number, version, section_title, section_level, content,
 *     position, document_path, file_size, indexed_at
 *
 *   spec_metadata (regular table):
 *     spec_number, version, document_path, file_size, section_count, indexed_at
 */

export interface SearchResult {
  spec_number: string;
  version: string;
  section_title: string;
  section_level: number;
  snippet: string;
  position: number;
  document_path: string;
  rank: number;
}

export interface SearchOptions {
  specNumber?: string;       // filter to a specific spec
  version?: string;          // filter to a specific version
  limit?: number;            // max results (default 20)
  snippetSize?: number;      // snippet length in tokens (default 32)
  orderBy?: 'rank' | 'position'; // sort order (default rank)
}

export interface IndexStats {
  totalDocuments: number;
  totalSections: number;
  specs: { spec_number: string; version: string; sections: number; indexed_at: string }[];
  dbPath: string;
  dbSizeBytes: number;
}

const DB_VERSION = 1;

export class SearchIndex {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const indexPath = dbPath ?? config.indexPath;
    const indexDir = path.dirname(indexPath);
    if (!fs.existsSync(indexDir)) {
      fs.mkdirSync(indexDir, { recursive: true });
    }

    this.db = new Database(indexPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initialize();
  }

  private initialize(): void {
    // FTS5 virtual table for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS spec_content USING fts5(
        spec_number,
        version,
        section_title,
        section_level UNINDEXED,
        content,
        position UNINDEXED,
        document_path UNINDEXED,
        file_size UNINDEXED,
        indexed_at UNINDEXED,
        tokenize = 'unicode61'
      );
    `);

    // Metadata table for document-level tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spec_metadata (
        spec_number TEXT NOT NULL,
        version TEXT NOT NULL,
        document_path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        section_count INTEGER NOT NULL,
        indexed_at TEXT NOT NULL,
        PRIMARY KEY (spec_number, version)
      );
    `);

    // Schema version tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_info (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const versionRow = this.db.prepare('SELECT value FROM schema_info WHERE key = ?').get('db_version') as { value: string } | undefined;
    if (!versionRow) {
      this.db.prepare('INSERT INTO schema_info (key, value) VALUES (?, ?)').run('db_version', String(DB_VERSION));
    }
  }

  /**
   * Index an extracted document. Removes any existing index entries for the
   * same spec+version before inserting.
   */
  indexDocument(doc: ExtractedDocument): void {
    const { specNumber, version, filePath, fileSize, sections, extractedAt } = doc;

    const removeOld = this.db.prepare(
      `DELETE FROM spec_content WHERE spec_number = ? AND version = ?`
    );
    const removeMeta = this.db.prepare(
      `DELETE FROM spec_metadata WHERE spec_number = ? AND version = ?`
    );
    const insertSection = this.db.prepare(
      `INSERT INTO spec_content (spec_number, version, section_title, section_level, content, position, document_path, file_size, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertMeta = this.db.prepare(
      `INSERT INTO spec_metadata (spec_number, version, document_path, file_size, section_count, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    const tx = this.db.transaction(() => {
      removeOld.run(specNumber, version);
      removeMeta.run(specNumber, version);
      for (const section of sections) {
        insertSection.run(
          specNumber,
          version,
          section.title,
          section.level,
          section.content,
          section.position,
          filePath,
          fileSize,
          extractedAt
        );
      }
      insertMeta.run(specNumber, version, filePath, fileSize, sections.length, extractedAt);
    });

    tx();
  }

  /**
   * Full-text search across indexed content.
   */
  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const limit = options.limit ?? 20;
    const snippetSize = options.snippetSize ?? 32;

    // Build FTS5 query — use simple token matching
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];

    let sql = `
      SELECT
        spec_number,
        version,
        section_title,
        section_level,
        snippet(spec_content, 4, '>>>', '<<<', ' ... ', ${snippetSize}) AS snippet,
        position,
        document_path,
        rank
      FROM spec_content
      WHERE spec_content MATCH ?
    `;
    const params: any[] = [ftsQuery];

    if (options.specNumber) {
      sql += ` AND spec_number = ?`;
      params.push(options.specNumber);
    }
    if (options.version) {
      sql += ` AND version = ?`;
      params.push(options.version);
    }

    if (options.orderBy === 'position') {
      sql += ` ORDER BY spec_number, version, position`;
    } else {
      sql += ` ORDER BY rank`;
    }

    sql += ` LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as any[];

    return rows.map((row) => ({
      spec_number: row.spec_number,
      version: row.version,
      section_title: row.section_title,
      section_level: row.section_level,
      snippet: row.snippet,
      position: row.position,
      document_path: row.document_path,
      rank: row.rank,
    }));
  }

  /**
   * Remove a document (all sections) from the index.
   */
  removeDocument(specNumber: string, version?: string): number {
    const tx = this.db.transaction(() => {
      if (version) {
        this.db.prepare('DELETE FROM spec_content WHERE spec_number = ? AND version = ?').run(specNumber, version);
        this.db.prepare('DELETE FROM spec_metadata WHERE spec_number = ? AND version = ?').run(specNumber, version);
      } else {
        this.db.prepare('DELETE FROM spec_content WHERE spec_number = ?').run(specNumber);
        this.db.prepare('DELETE FROM spec_metadata WHERE spec_number = ?').run(specNumber);
      }
    });
    tx();

    const count = version
      ? (this.db.prepare('SELECT COUNT(*) as c FROM spec_content WHERE spec_number = ? AND version = ?').get(specNumber, version) as any).c
      : (this.db.prepare('SELECT COUNT(*) as c FROM spec_content WHERE spec_number = ?').get(specNumber) as any).c;
    return count;
  }

  /**
   * Get all indexed documents.
   */
  getIndexedSpecs(): { spec_number: string; version: string; document_path: string; section_count: number; indexed_at: string }[] {
    return this.db.prepare(
      `SELECT spec_number, version, document_path, section_count, indexed_at FROM spec_metadata ORDER BY spec_number, version`
    ).all() as any[];
  }

  /**
   * Check if a specific spec+version is already indexed.
   */
  isIndexed(specNumber: string, version: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM spec_metadata WHERE spec_number = ? AND version = ?'
    ).get(specNumber, version);
    return !!row;
  }

  /**
   * Get index statistics.
   */
  getStats(): IndexStats {
    const totalDocs = (this.db.prepare('SELECT COUNT(*) as c FROM spec_metadata').get() as any).c;
    const totalSections = (this.db.prepare('SELECT COUNT(*) as c FROM spec_content').get() as any).c;

    const specs = this.db.prepare(
      `SELECT spec_number, version, section_count as sections, indexed_at FROM spec_metadata ORDER BY spec_number, version`
    ).all() as any[];

    const dbPath = this.db.name;
    const dbSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;

    return {
      totalDocuments: totalDocs,
      totalSections: totalSections,
      specs,
      dbPath,
      dbSizeBytes: dbSize,
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}

/**
 * Sanitize a user query for FTS5.
 * Wraps multi-word queries in implicit AND and quotes phrases.
 */
function sanitizeFtsQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return '';

  // If the query already contains FTS5 operators, pass through
  if (/["*+\-:( )]/.test(trimmed) && trimmed.length > 1) {
    return trimmed;
  }

  // For simple word queries, use prefix matching on each token
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return '';

  // Join with implicit AND and add prefix wildcard
  return tokens.map((t) => `${t.replace(/["']/g, '')}*`).join(' ');
}

// Singleton
let searchIndexInstance: SearchIndex | null = null;

export function getSearchIndex(): SearchIndex {
  if (!searchIndexInstance) {
    searchIndexInstance = new SearchIndex();
  }
  return searchIndexInstance;
}
