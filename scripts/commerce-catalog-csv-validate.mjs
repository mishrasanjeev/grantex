#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_COLUMNS = new Set([
  'merchant_id',
  'product_id',
  'title',
  'category_preset',
  'sku',
  'price_amount',
]);
const OPTIONAL_COLUMNS = new Set([
  'brand',
  'description',
  'image_url',
  'source_system',
  'manually_maintained',
  'parent_sku',
  'model',
  'variant_title',
  'attributes',
  'currency',
  'tax_inclusive',
  'gst_slab',
  'tax_rate',
  'hsn_code',
  'availability_status',
  'warranty_summary',
  'return_policy_summary',
]);
const AVAILABILITY = new Set(['in_stock', 'out_of_stock', 'pre_order', 'back_order', 'unknown']);
const SECRET_PATTERNS = [
  /Bearer\s+/i,
  /grtx_(?:sk|agent)_/i,
  /passport/i,
  /idempotency/i,
  /secret/i,
  /api[_-]?key/i,
  /provider[_-]?credential/i,
];

function usage() {
  console.error('Usage: node scripts/commerce-catalog-csv-validate.mjs --input=docs/examples/commerce-catalog-import.sample.csv [--dry-run]');
}

function parseArgs(argv) {
  const args = { input: null, dryRun: true, runRequested: false };
  for (const arg of argv) {
    if (arg.startsWith('--input=')) args.input = arg.slice('--input='.length);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--run' || arg === '--execute') args.runRequested = true;
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((value) => value.trim().length > 0));
}

function asBool(value) {
  if (value === '') return null;
  const normalized = value.toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

function validateRow(row, index, seenSkus) {
  const errors = {};
  for (const col of REQUIRED_COLUMNS) {
    if (!row[col]) errors[col] = 'required';
  }
  if (row.category_preset && row.category_preset !== 'electronics_appliances') {
    errors.category_preset = 'must be electronics_appliances for V1';
  }
  if (row.price_amount && !/^\d+$/.test(row.price_amount)) {
    errors.price_amount = 'must be non-negative integer minor units';
  }
  if (row.currency && !/^[A-Z]{3}$/.test(row.currency)) {
    errors.currency = 'must be ISO 4217 uppercase code';
  }
  if (row.tax_inclusive && asBool(row.tax_inclusive) === null) {
    errors.tax_inclusive = 'must be true or false';
  }
  if (row.manually_maintained && asBool(row.manually_maintained) === null) {
    errors.manually_maintained = 'must be true or false';
  }
  if (row.tax_rate && Number.isNaN(Number(row.tax_rate))) {
    errors.tax_rate = 'must be numeric';
  }
  if (row.availability_status && !AVAILABILITY.has(row.availability_status)) {
    errors.availability_status = 'invalid availability status';
  }
  if (row.image_url && !row.image_url.startsWith('https://')) {
    errors.image_url = 'must be HTTPS URL';
  }
  if (row.attributes) {
    try {
      const parsed = JSON.parse(row.attributes);
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
        errors.attributes = 'must be a JSON object';
      }
    } catch {
      errors.attributes = 'must be valid JSON object';
    }
  }
  if (row.sku) {
    if (seenSkus.has(row.sku)) errors.sku = 'duplicate SKU in file';
    seenSkus.add(row.sku);
  }
  const joined = Object.values(row).join(' ');
  if (SECRET_PATTERNS.some((pattern) => pattern.test(joined))) {
    errors.row = 'secret-like value refused';
  }
  return {
    index,
    product_id: row.product_id || null,
    sku: row.sku || null,
    status: Object.keys(errors).length === 0 ? 'valid' : 'invalid',
    field_errors: errors,
  };
}

function normalizeRow(row) {
  const attrs = row.attributes ? JSON.parse(row.attributes) : {};
  return {
    merchant_id: row.merchant_id,
    product_id: row.product_id,
    title: row.title,
    category_preset: row.category_preset,
    brand: row.brand || null,
    description: row.description || null,
    image_url: row.image_url || null,
    source_system: row.source_system || 'csv',
    manually_maintained: asBool(row.manually_maintained) ?? false,
    variants: [{
      sku: row.sku,
      price_amount: Number(row.price_amount),
      parent_sku: row.parent_sku || null,
      model: row.model || null,
      variant_title: row.variant_title || null,
      attributes: attrs,
      currency: row.currency || 'INR',
      tax_inclusive: asBool(row.tax_inclusive) ?? true,
      gst_slab: row.gst_slab || null,
      tax_rate: row.tax_rate ? Number(row.tax_rate) : null,
      hsn_code: row.hsn_code || null,
      availability_status: row.availability_status || 'unknown',
      warranty_summary: row.warranty_summary || null,
      return_policy_summary: row.return_policy_summary || null,
      source_system: row.source_system || 'csv',
    }],
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    usage();
    process.exit(2);
  }
  if (args.runRequested) {
    throw new Error('CSV importer write mode is not implemented in M12B; dry-run validation only');
  }
  const inputPath = resolve(repoRoot, args.input);
  const rel = relative(repoRoot, inputPath);
  if (rel.startsWith('..') || rel === '' || rel.includes('..\\')) {
    throw new Error('Refusing to read CSV outside the repository workspace');
  }
  const text = readFileSync(inputPath, 'utf8');
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error('Refusing CSV with secret-like content');
  }
  const parsed = parseCsv(text);
  if (parsed.length < 2) throw new Error('CSV must include a header and at least one data row');
  const headers = parsed[0].map((h) => h.trim());
  const allowedHeaders = new Set([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);
  const headerErrors = {};
  for (const col of REQUIRED_COLUMNS) {
    if (!headers.includes(col)) headerErrors[col] = 'missing required column';
  }
  for (const col of headers) {
    if (!allowedHeaders.has(col)) headerErrors[col] = 'unknown column';
  }
  const seenSkus = new Set();
  const rows = parsed.slice(1).map((values, index) => {
    const row = Object.fromEntries(headers.map((header, i) => [header, (values[i] ?? '').trim()]));
    return { raw: row, validation: validateRow(row, index, seenSkus) };
  });
  const validRows = rows.filter((row) => row.validation.status === 'valid');
  const invalidRows = rows.filter((row) => row.validation.status === 'invalid');
  const output = {
    dry_run: true,
    input: rel.replaceAll('\\', '/'),
    header_errors: headerErrors,
    summary: {
      rows: rows.length,
      valid: validRows.length,
      invalid: invalidRows.length,
    },
    row_results: rows.map((row) => row.validation),
    normalized_preview: validRows.map((row) => normalizeRow(row.raw)),
  };
  console.log(JSON.stringify(output, null, 2));
  process.exit(Object.keys(headerErrors).length === 0 && invalidRows.length === 0 ? 0 : 1);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
