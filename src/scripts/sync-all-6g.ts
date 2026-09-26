/**
 * Batch sync script — downloads and indexes all 6G-related specifications
 * from the 3GPP FTP archive.
 *
 * Usage:
 *   npm run sync-all              # sync all cataloged specs (latest version)
 *   npm run sync-all -- --force   # re-download and re-index even if already indexed
 *   npm run sync-all -- --download-only  # download .zip files without indexing
 *
 * The script processes specs sequentially with a delay between them to
 * avoid overloading the 3GPP FTP server.
 */

import { APIManager } from '../api/api-manager';
import { getCatalogSpecs } from '../api/spec-catalog';
import * as path from 'path';
import * as fs from 'fs';
import { config } from '../config';

interface SyncReport {
  total: number;
  synced: number;
  skipped: number;
  failed: number;
  noVersions: number;
  totalSections: number;
  details: {
    spec_number: string;
    title: string;
    status: string;
    version?: string;
    releaseLabel?: string | null;
    message: string;
    sections?: number;
  }[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const downloadOnly = args.includes('--download-only');

  const specs = getCatalogSpecs();
  console.error(`\n=== 6G Specification Batch Sync ===`);
  console.error(`Catalog: ${specs.length} specifications`);
  console.error(`Mode: ${downloadOnly ? 'download-only' : 'sync (download + index)'}`);
  console.error(`Force: ${force}`);
  console.error(`Downloads dir: ${config.downloadsDir}\n`);

  const apiManager = new APIManager();
  const details: SyncReport['details'] = [];
  let synced = 0;
  let skipped = 0;
  let failed = 0;
  let noVersions = 0;
  let totalSections = 0;

  const startedAt = new Date().toISOString();

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    console.error(`[${i + 1}/${specs.length}] Syncing ${spec.spec_number} — ${spec.title}...`);

    try {
      const result = await apiManager.syncSpecification(spec.spec_number, {
        force,
        downloadOnly,
      });

      details.push({
        spec_number: result.spec_number,
        title: result.title,
        status: result.status,
        version: result.version,
        releaseLabel: result.releaseLabel,
        message: result.message,
        sections: result.sections,
      });

      switch (result.status) {
        case 'synced':
          synced++;
          totalSections += result.sections ?? 0;
          console.error(`  ✓ ${result.message}`);
          break;
        case 'skipped':
          skipped++;
          console.error(`  → ${result.message}`);
          break;
        case 'failed':
          failed++;
          console.error(`  ✗ ${result.message}`);
          break;
        case 'no_versions':
          noVersions++;
          console.error(`  ⊘ ${result.message}`);
          break;
      }
    } catch (err: any) {
      failed++;
      const message = `Unexpected error: ${err.message}`;
      details.push({
        spec_number: spec.spec_number,
        title: spec.title,
        status: 'failed',
        message,
      });
      console.error(`  ✗ ${message}`);
    }

    // Delay between specs to be polite to the FTP server
    if (i < specs.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, config.sync.delayBetweenSpecs));
    }
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - new Date(startedAt).getTime();

  const report: SyncReport = {
    total: specs.length,
    synced,
    skipped,
    failed,
    noVersions,
    totalSections,
    details,
    startedAt,
    finishedAt,
    durationMs,
  };

  // Write report to downloads dir
  const reportPath = path.join(config.downloadsDir, 'sync-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.error(`\n=== Sync Complete ===`);
  console.error(`Total:   ${report.total}`);
  console.error(`Synced:  ${synced} (${totalSections} sections indexed)`);
  console.error(`Skipped: ${skipped}`);
  console.error(`Failed:  ${failed}`);
  console.error(`No FTP:  ${noVersions}`);
  console.error(`Duration: ${(durationMs / 1000).toFixed(1)}s`);
  console.error(`Report:  ${reportPath}\n`);

  // Exit with error code if any failures
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
