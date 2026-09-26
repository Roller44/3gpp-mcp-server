import * as path from 'path';
import * as fs from 'fs';

export type Category = 'architecture' | 'ran' | 'media' | 'security' | 'management' | 'services' | 'tools';

export interface CatalogEntry {
  spec_number: string;
  title: string;
  series: string;
  working_group: string;
  document_type: 'TR' | 'TS';
  category: Category;
  notes: string;
}

export interface CatalogFile {
  version: string;
  description: string;
  specs: CatalogEntry[];
}

const SERVER_ROOT = path.resolve(__dirname, '..');

let cachedCatalog: CatalogFile | null = null;

export function loadCatalog(): CatalogFile {
  if (cachedCatalog) return cachedCatalog;

  // SERVER_ROOT is dist/ at runtime; the catalog lives under src/data/ in source
  // and dist/data/ in a packaged build. Try both.
  const candidates = [
    path.join(SERVER_ROOT, 'data', '6g-spec-catalog.json'),
    path.join(SERVER_ROOT, '..', 'src', 'data', '6g-spec-catalog.json'),
  ];
  let raw: string | undefined;
  for (const p of candidates) {
    try {
      raw = fs.readFileSync(p, 'utf-8');
      break;
    } catch {
      // try next
    }
  }
  if (raw === undefined) {
    throw new Error(`6G spec catalog not found in any of: ${candidates.join(', ')}`);
  }
  cachedCatalog = JSON.parse(raw) as CatalogFile;
  return cachedCatalog;
}

export function getCatalogSpecs(): CatalogEntry[] {
  return loadCatalog().specs;
}

export function findCatalogEntry(specNumber: string): CatalogEntry | undefined {
  return getCatalogSpecs().find((s) => s.spec_number === specNumber);
}

export function getCatalogStats(): { total: number; byCategory: Record<string, number> } {
  const specs = getCatalogSpecs();
  const byCategory: Record<string, number> = {};
  for (const s of specs) {
    byCategory[s.category] = (byCategory[s.category] ?? 0) + 1;
  }
  return { total: specs.length, byCategory };
}
