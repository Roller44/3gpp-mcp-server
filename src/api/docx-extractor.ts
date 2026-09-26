import * as path from 'path';
import * as fs from 'fs';
import mammoth from 'mammoth';
import AdmZip from 'adm-zip';

/**
 * Extract structured text from 3GPP specification documents.
 *
 * 3GPP specs are distributed as .zip archives containing a .docx file inside.
 * This module handles:
 *   - .zip → extract the .docx inside
 *   - .docx → extract structured text with section headings via mammoth
 *   - .doc (legacy) → attempt LibreOffice conversion (best-effort, may not be available)
 */

export interface DocSection {
  title: string;
  level: number;        // heading level: 1 = top-level, 0 = untitled body text
  content: string;
  position: number;     // sequential position in the document
}

export interface ExtractedDocument {
  specNumber: string;
  version: string;
  filePath: string;
  fileSize: number;
  sections: DocSection[];
  totalContent: string;
  sectionCount: number;
  extractedAt: string;
}

/**
 * Extract text from a .zip archive containing a .docx file.
 * Returns the path to the extracted .docx (temp) or null if no .docx found.
 */
export function extractDocxFromZip(zipPath: string, extractToDir: string): string | null {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  // Find the .docx file inside (prefer "clean" version if multiple)
  let docxEntry = entries.find((e) => e.entryName.endsWith('.docx') && !e.isDirectory);
  if (!docxEntry) {
    // Fallback: try .doc
    docxEntry = entries.find((e) => e.entryName.endsWith('.doc') && !e.isDirectory);
  }

  if (!docxEntry) return null;

  const filename = path.basename(docxEntry.entryName);
  const outPath = path.join(extractToDir, filename);
  fs.writeFileSync(outPath, docxEntry.getData());
  return outPath;
}

/**
 * Extract structured sections from a .docx file using mammoth.
 * Mammoth converts .docx to HTML, from which we parse heading levels.
 */
export async function extractFromDocx(docxPath: string): Promise<DocSection[]> {
  const result = await mammoth.convertToHtml({ path: docxPath });
  const html = result.value;

  // Parse HTML to extract sections with heading levels
  const sections: DocSection[] = [];
  let currentPosition = 0;
  let currentTitle = '';
  let currentLevel = 0;
  let currentContent: string[] = [];

  // Simple HTML parser: match <h1>...<h6> and <p> tags
  const tagRegex = /<(h[1-6]|p|li|td|th)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;

  const flushSection = () => {
    const content = currentContent.join('\n').trim();
    if (currentTitle || content) {
      sections.push({
        title: currentTitle || '(untitled)',
        level: currentLevel,
        content,
        position: currentPosition++,
      });
    }
    currentContent = [];
  };

  while ((match = tagRegex.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    const innerHtml = match[2];

    // Strip HTML tags from inner content
    const text = stripHtml(innerHtml).trim();

    if (/^h[1-6]$/.test(tag)) {
      // New heading — flush previous section, start new one
      flushSection();
      const level = parseInt(tag[1], 10);
      currentTitle = text;
      currentLevel = level;
    } else {
      // Body content (p, li, td, th) — append to current section
      if (text) {
        currentContent.push(text);
      }
    }
  }

  // Flush the last section
  flushSection();

  // Merge consecutive untitled sections into titled ones where possible
  return mergeUntitledSections(sections);
}

/**
 * Extract structured text from a .doc (legacy) file.
 * Tries LibreOffice headless conversion to .docx first.
 * Returns null if conversion is unavailable.
 */
export async function extractFromDoc(docPath: string, tempDir: string): Promise<DocSection[] | null> {
  const { execFileSync } = require('child_process');

  // Try common LibreOffice paths on Windows
  const sofficePaths = [
    'soffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ];

  let soffice: string | null = null;
  for (const p of sofficePaths) {
    try {
      execFileSync(p, ['--version'], { stdio: 'ignore', timeout: 5000 });
      soffice = p;
      break;
    } catch {
      // Try next path
    }
  }

  if (!soffice) return null;

  // Convert .doc to .docx
  try {
    execFileSync(soffice, [
      '--headless',
      '--convert-to', 'docx',
      '--outdir', tempDir,
      docPath,
    ], { timeout: 60000, stdio: 'ignore' });

    const docxName = path.basename(docPath, '.doc') + '.docx';
    const docxPath = path.join(tempDir, docxName);

    if (!fs.existsSync(docxPath)) return null;

    return await extractFromDocx(docxPath);
  } catch {
    return null;
  }
}

/**
 * Main entry: extract a 3GPP specification document.
 * Handles .zip (extract .docx inside), .docx, and .doc (best-effort).
 */
export async function extractDocument(
  filePath: string,
  specNumber: string,
  version: string,
  tempDir: string
): Promise<ExtractedDocument> {
  const ext = path.extname(filePath).toLowerCase();
  const stats = fs.statSync(filePath);

  let sections: DocSection[];
  let actualDocPath = filePath;
  let cleanupPath: string | null = null;

  try {
    if (ext === '.zip') {
      // Extract .docx from zip
      const extractedPath = extractDocxFromZip(filePath, tempDir);
      if (!extractedPath) {
        throw new Error(`No .docx or .doc file found inside ${filePath}`);
      }
      actualDocPath = extractedPath;
      cleanupPath = extractedPath;

      const innerExt = path.extname(extractedPath).toLowerCase();
      if (innerExt === '.docx') {
        sections = await extractFromDocx(extractedPath);
      } else if (innerExt === '.doc') {
        const result = await extractFromDoc(extractedPath, tempDir);
        sections = result ?? [];
      } else {
        sections = [];
      }
    } else if (ext === '.docx') {
      sections = await extractFromDocx(filePath);
    } else if (ext === '.doc') {
      const result = await extractFromDoc(filePath, tempDir);
      sections = result ?? [];
    } else {
      // Try reading as plain text
      const text = fs.readFileSync(filePath, 'utf-8');
      sections = [{ title: '(content)', level: 0, content: text, position: 0 }];
    }
  } finally {
    // Clean up extracted temp file
    if (cleanupPath && fs.existsSync(cleanupPath)) {
      try { fs.unlinkSync(cleanupPath); } catch { /* ignore */ }
    }
  }

  const totalContent = sections.map((s) => s.content).join('\n\n');

  return {
    specNumber,
    version,
    filePath,
    fileSize: stats.size,
    sections,
    totalContent,
    sectionCount: sections.length,
    extractedAt: new Date().toISOString(),
  };
}

/**
 * Strip HTML tags and decode common entities.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Merge consecutive untitled sections into the preceding titled section.
 */
function mergeUntitledSections(sections: DocSection[]): DocSection[] {
  if (sections.length === 0) return sections;

  const merged: DocSection[] = [];
  for (const section of sections) {
    if (section.level === 0 && merged.length > 0) {
      // Append to the last titled section
      const last = merged[merged.length - 1];
      last.content += '\n' + section.content;
    } else {
      merged.push({ ...section });
    }
  }

  // Re-number positions
  merged.forEach((s, i) => { s.position = i; });

  return merged;
}
