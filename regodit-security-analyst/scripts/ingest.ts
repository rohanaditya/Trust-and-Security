/**
 * Usage:
 *   1. Download your Google Drive docs into ./raw-docs/ (keep original filenames)
 *   2. npm run ingest
 *
 * Supports .docx, .xlsx, .pdf, .txt/.md
 * Chunks .docx/.txt by heading (lines that look like "1. Purpose and Scope", "## Roles", etc.)
 * so each chunk is a coherent policy section — this matters a lot for retrieval quality
 * given how consistently your docs are already structured.
 */
import fs from 'fs';
import path from 'path';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
// @ts-ignore - no types shipped
import pdfParse from 'pdf-parse';
import { supabaseAdmin } from '../lib/supabase';
import { embed } from '../lib/embeddings';

const RAW_DIR = path.join(process.cwd(), 'raw-docs');

function inferSourceType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes('contract') || lower.includes('agreement')) return 'contract';
  if (lower.includes('vapt') || lower.includes('soc2') || lower.includes('soc_2') || lower.includes('assessment')) return 'assessment';
  if (lower.includes('diagram') || lower.includes('architecture') || lower.includes('logging') || lower.includes('segmentation')) return 'infra';
  if (lower.includes('policy') || lower.includes('policies')) return 'policy';
  return 'other';
}

// Split raw text into (sectionTitle, content) chunks using heading-like lines.
function chunkByHeading(text: string): { section: string | null; content: string }[] {
  const lines = text.split('\n');
  const headingRe = /^\s*(\d+(\.\d+)*\.?\s+[A-Z][^\n]{2,80}|#{1,3}\s+.+)$/;
  const chunks: { section: string | null; content: string }[] = [];
  let currentSection: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join('\n').trim();
    if (content.length > 30) chunks.push({ section: currentSection, content });
    buffer = [];
  };

  for (const line of lines) {
    if (headingRe.test(line.trim())) {
      flush();
      currentSection = line.trim();
    } else {
      buffer.push(line);
    }
  }
  flush();

  // Fallback: no headings detected at all — chunk by paragraph blocks instead.
  if (chunks.length === 0) {
    return text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 30)
      .map((content) => ({ section: null, content }));
  }
  return chunks;
}

async function extractText(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = fs.readFileSync(filePath);

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (ext === '.pdf') {
    const result = await pdfParse(buffer);
    return result.text;
  }
  if (ext === '.xlsx' || ext === '.xls') {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    return workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      return `--- Sheet: ${name} ---\n${csv}`;
    }).join('\n\n');
  }
  if (ext === '.txt' || ext === '.md') {
    return buffer.toString('utf-8');
  }
  throw new Error(`Unsupported file type: ${ext}`);
}

async function ingestFile(filePath: string) {
  const filename = path.basename(filePath);
  console.log(`Ingesting ${filename}...`);

  const text = await extractText(filePath);
  const chunks = chunkByHeading(text);

  if (chunks.length === 0) {
    console.warn(`  No usable content extracted from ${filename}, skipping.`);
    return;
  }

  const { data: doc, error: docError } = await supabaseAdmin
    .from('documents')
    .insert({ source_name: filename, source_type: inferSourceType(filename) })
    .select()
    .single();
  if (docError) throw docError;

  // Batch embed for speed
  const embeddings = await embed(chunks.map((c) => c.content), 'document');

  const rows = chunks.map((c, i) => ({
    document_id: doc.id,
    content: c.content,
    section_title: c.section,
    embedding: embeddings[i],
  }));

  const { error: chunkError } = await supabaseAdmin.from('chunks').insert(rows);
  if (chunkError) throw chunkError;

  console.log(`  -> ${rows.length} chunks stored.`);
}

async function main() {
  if (!fs.existsSync(RAW_DIR)) {
    console.error(`Missing ${RAW_DIR}. Create it and drop your downloaded docs inside.`);
    process.exit(1);
  }
  const files = fs.readdirSync(RAW_DIR).filter((f) => !f.startsWith('.'));
  if (files.length === 0) {
    console.error(`No files found in ${RAW_DIR}.`);
    process.exit(1);
  }
  for (const file of files) {
    await ingestFile(path.join(RAW_DIR, file));
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
