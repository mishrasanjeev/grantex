import { useEffect, useMemo, useState } from 'react';
import {
  bulkIngestCommerceProducts,
  listCommerceProducts,
  updateCommerceProduct,
  type CommerceBulkProductIngestResponse,
  type CommerceBulkProductInput,
  type CommerceCatalogProductSummary,
} from '../../api/commerce';
import { useToast } from '../../store/toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { Input } from '../../components/ui/Input';
import { Table } from '../../components/ui/Table';
import { BlockerBanner, DateText, ErrorPanel, IdText, LoadingPanel, PageHeader, money, statusVariant } from './CommerceShared';

type CsvPreviewRow = {
  index: number;
  product_id: string | null;
  sku: string | null;
  status: 'valid' | 'invalid';
  field_errors: Record<string, string>;
};

const csvColumns = [
  'product_id',
  'title',
  'brand',
  'category_preset',
  'sku',
  'price_amount',
  'currency',
  'availability_status',
  'warranty_summary',
  'return_policy_summary',
];

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]!).map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    return headers.reduce<Record<string, string>>((row, header, index) => {
      row[header] = cells[index] ?? '';
      return row;
    }, {});
  });
}

function validateCsvRows(rows: Array<Record<string, string>>): {
  preview: CsvPreviewRow[];
  products: CommerceBulkProductInput[];
} {
  const grouped = new Map<string, CommerceBulkProductInput>();
  const preview = rows.map((row, index) => {
    const errors: Record<string, string> = {};
    const productId = row.product_id?.trim() || null;
    const sku = row.sku?.trim() || null;
    const price = Number.parseInt(row.price_amount ?? '', 10);
    for (const key of ['product_id', 'title', 'category_preset', 'sku', 'price_amount']) {
      if (!row[key]?.trim()) errors[key] = 'required';
    }
    if (row.category_preset && row.category_preset !== 'electronics_appliances') {
      errors.category_preset = 'must be electronics_appliances';
    }
    if (!Number.isSafeInteger(price) || price < 0) {
      errors.price_amount = 'must be a non-negative integer minor-unit amount';
    }
    if (row.currency && !/^[A-Z]{3}$/.test(row.currency)) {
      errors.currency = 'must be an uppercase ISO currency code';
    }
    if (Object.keys(errors).length === 0 && productId && sku) {
      const product: CommerceBulkProductInput = grouped.get(productId) ?? {
        product_id: productId,
        title: row.title ?? '',
        brand: row.brand || null,
        category_preset: row.category_preset ?? 'electronics_appliances',
        source_system: 'csv_dry_run',
        manually_maintained: false,
        variants: [],
      };
      product.variants.push({
        sku,
        price_amount: price,
        currency: row.currency || 'INR',
        tax_inclusive: true,
        availability_status: (row.availability_status || 'unknown') as CommerceBulkProductInput['variants'][number]['availability_status'],
        warranty_summary: row.warranty_summary || null,
        return_policy_summary: row.return_policy_summary || null,
        source_system: 'csv_dry_run',
      });
      grouped.set(productId, product);
    }
    return {
      index,
      product_id: productId,
      sku,
      status: Object.keys(errors).length === 0 ? 'valid' as const : 'invalid' as const,
      field_errors: errors,
    };
  });
  return { preview, products: Array.from(grouped.values()) };
}

export function CommerceCatalog() {
  const [merchantId, setMerchantId] = useState('');
  const [query, setQuery] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [products, setProducts] = useState<CommerceCatalogProductSummary[]>([]);
  const [selected, setSelected] = useState<CommerceCatalogProductSummary | null>(null);
  const [editForm, setEditForm] = useState({ title: '', brand: '', status: 'active', price_amount: '', currency: 'INR' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [csvText, setCsvText] = useState(csvColumns.join(','));
  const [csvPreview, setCsvPreview] = useState<CsvPreviewRow[]>([]);
  const [csvProducts, setCsvProducts] = useState<CommerceBulkProductInput[]>([]);
  const [bulkResult, setBulkResult] = useState<CommerceBulkProductIngestResponse | null>(null);
  const [bulkWriting, setBulkWriting] = useState(false);
  const [writeOpen, setWriteOpen] = useState(false);
  const { show } = useToast();

  async function load() {
    const id = merchantId.trim();
    if (!id) {
      show('Enter a merchant ID before loading catalog products', 'error');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await listCommerceProducts({
        merchantId: id,
        status: includeArchived ? 'all' : 'active',
        query: query || undefined,
        limit: 100,
      });
      setProducts(res.items);
      setSelected(res.items[0] ?? null);
    } catch {
      setError('Failed to load commerce catalog products.');
      show('Failed to load commerce catalog', 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!selected) {
      setEditForm({ title: '', brand: '', status: 'active', price_amount: '', currency: 'INR' });
      return;
    }
    const firstVariant = selected.variants_summary[0];
    setEditForm({
      title: selected.title,
      brand: selected.brand ?? '',
      status: 'active',
      price_amount: firstVariant ? String(firstVariant.price_amount) : '',
      currency: firstVariant?.currency ?? 'INR',
    });
  }, [selected]);

  async function saveSelected() {
    if (!selected || !merchantId.trim()) return;
    const firstVariant = selected.variants_summary[0];
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {
        title: editForm.title,
        brand: editForm.brand || null,
        status: editForm.status,
      };
      if (firstVariant && editForm.price_amount) {
        patch.variants = [{
          variant_id: firstVariant.variant_id,
          price_amount: Number.parseInt(editForm.price_amount, 10),
          currency: editForm.currency,
        }];
      }
      await updateCommerceProduct(selected.product_id, patch, merchantId.trim());
      show('Product updated', 'success');
      await load();
    } catch {
      show('Failed to update product', 'error');
    } finally {
      setSaving(false);
    }
  }

  function runLocalCsvDryRun() {
    const parsed = validateCsvRows(parseCsv(csvText));
    setCsvPreview(parsed.preview);
    setCsvProducts(parsed.products);
    setBulkResult(null);
    if (parsed.preview.length === 0) {
      show('CSV dry-run found no product rows', 'error');
    }
  }

  async function runBulkDryRun() {
    if (!merchantId.trim() || csvProducts.length === 0) return;
    try {
      const res = await bulkIngestCommerceProducts({ merchantId: merchantId.trim(), dryRun: true, products: csvProducts });
      setBulkResult(res);
      show('Bulk ingest dry-run completed', 'success');
    } catch {
      show('Bulk ingest dry-run failed', 'error');
    }
  }

  async function writeBulkProducts() {
    if (!merchantId.trim() || csvProducts.length === 0) return;
    setBulkWriting(true);
    try {
      const res = await bulkIngestCommerceProducts({ merchantId: merchantId.trim(), dryRun: false, products: csvProducts });
      setBulkResult(res);
      setWriteOpen(false);
      show('Bulk ingest write completed', 'success');
      await load();
    } catch {
      show('Bulk ingest write failed', 'error');
    } finally {
      setBulkWriting(false);
    }
  }

  const invalidPreviewCount = useMemo(
    () => csvPreview.filter((row) => row.status === 'invalid').length,
    [csvPreview],
  );

  return (
    <div>
      <PageHeader
        title="Commerce Catalog"
        description="Merchant catalog list, product patch, JSON bulk ingest dry-run, and local CSV validation surface for sandbox control-plane work."
        action={<Button variant="secondary" size="sm" onClick={load} disabled={loading}>{loading ? 'Loading' : 'Refresh'}</Button>}
      />
      <BlockerBanner />

      <Card className="mb-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] lg:items-end">
          <Input
            id="commerce-catalog-merchant"
            label="Merchant ID"
            placeholder="mch_..."
            value={merchantId}
            onChange={(e) => setMerchantId(e.target.value)}
          />
          <Input
            id="commerce-catalog-query"
            label="Search"
            placeholder="product title, SKU, brand"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="flex items-center gap-2 pb-2 text-sm text-gx-text">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            Include archived
          </label>
          <Button onClick={load} disabled={loading || !merchantId.trim()}>Load catalog</Button>
        </div>
      </Card>

      {loading ? <LoadingPanel /> : error ? <ErrorPanel message={error} /> : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
          <Card className="p-0">
            {products.length === 0 ? (
              <EmptyState title="No catalog products" description="Active products are excluded by current filters or have not been created yet." />
            ) : (
              <div className="p-4">
                <Table
                  data={products}
                  rowKey={(product) => product.id}
                  onRowClick={setSelected}
                  columns={[
                    {
                      key: 'product',
                      header: 'Product',
                      render: (product) => (
                        <div>
                          <span className="text-sm font-medium text-gx-text">{product.title}</span>
                          <IdText value={product.product_id} />
                        </div>
                      ),
                    },
                    { key: 'brand', header: 'Brand', render: (product) => <span className="text-gx-muted">{product.brand ?? 'none'}</span> },
                    {
                      key: 'variants',
                      header: 'Variants',
                      render: (product) => (
                        <div className="space-y-1">
                          {product.variants_summary.slice(0, 2).map((variant) => (
                            <div key={variant.variant_id} className="text-xs text-gx-muted">
                              {variant.sku} {money(variant.price_amount, variant.currency)}
                            </div>
                          ))}
                          {product.variants_summary.length > 2 && <Badge>{product.variants_summary.length} variants</Badge>}
                        </div>
                      ),
                    },
                    { key: 'updated', header: 'Updated', render: (product) => <DateText value={product.updated_at} /> },
                  ]}
                />
              </div>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 text-base font-semibold text-gx-text">Product patch</h2>
            {!selected ? (
              <p className="text-sm text-gx-muted">Select a product to patch mutable fields.</p>
            ) : (
              <div className="space-y-3">
                <IdText value={selected.product_id} />
                <Input
                  id="catalog-edit-title"
                  label="Title"
                  value={editForm.title}
                  onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
                />
                <Input
                  id="catalog-edit-brand"
                  label="Brand"
                  value={editForm.brand}
                  onChange={(e) => setEditForm({ ...editForm, brand: e.target.value })}
                />
                <div>
                  <label htmlFor="catalog-edit-status" className="mb-1.5 block text-sm font-medium text-gx-text">Status</label>
                  <select
                    id="catalog-edit-status"
                    value={editForm.status}
                    onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                    className="w-full rounded-md border border-gx-border bg-gx-bg px-3 py-2 text-sm text-gx-text focus:border-gx-accent focus:outline-none"
                  >
                    <option value="active">active</option>
                    <option value="archived">archived</option>
                  </select>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <Input
                    id="catalog-edit-price"
                    label="First variant price"
                    value={editForm.price_amount}
                    onChange={(e) => setEditForm({ ...editForm, price_amount: e.target.value })}
                  />
                  <Input
                    id="catalog-edit-currency"
                    label="Currency"
                    value={editForm.currency}
                    onChange={(e) => setEditForm({ ...editForm, currency: e.target.value.toUpperCase() })}
                  />
                </div>
                <p className="text-xs text-gx-muted">
                  Price changes update catalog rows only; existing cart and payment intent snapshots remain immutable server-side.
                </p>
                <Button onClick={saveSelected} disabled={saving}>{saving ? 'Saving' : 'Save product'}</Button>
              </div>
            )}
          </Card>

          <Card className="xl:col-span-2">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-gx-text">CSV import dry-run</h2>
                <p className="mt-1 text-xs text-gx-muted">
                  Local parsing validates rows first. API write is available only through the M12B bulk endpoint after a dry-run.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={runLocalCsvDryRun}>Local CSV dry-run</Button>
                <Button variant="secondary" size="sm" onClick={runBulkDryRun} disabled={!merchantId.trim() || csvProducts.length === 0 || invalidPreviewCount > 0}>
                  API bulk dry-run
                </Button>
                <Button size="sm" onClick={() => setWriteOpen(true)} disabled={!merchantId.trim() || csvProducts.length === 0 || invalidPreviewCount > 0}>
                  Write parsed products
                </Button>
              </div>
            </div>
            <label htmlFor="catalog-csv-input" className="mb-1.5 block text-sm font-medium text-gx-text">CSV rows</label>
            <textarea
              id="catalog-csv-input"
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              className="min-h-36 w-full rounded-md border border-gx-border bg-gx-bg px-3 py-2 font-mono text-xs text-gx-text focus:border-gx-accent focus:outline-none"
            />
            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-sm font-semibold text-gx-text">Local row results</span>
                  {csvPreview.length > 0 && <Badge variant={invalidPreviewCount > 0 ? 'warning' : 'success'}>{invalidPreviewCount} invalid</Badge>}
                </div>
                {csvPreview.length === 0 ? (
                  <p className="text-sm text-gx-muted">Run the local CSV dry-run to preview validation results.</p>
                ) : (
                  <Table
                    data={csvPreview}
                    rowKey={(row) => String(row.index)}
                    columns={[
                      { key: 'row', header: 'Row', render: (row) => <span className="font-mono text-xs text-gx-muted">{row.index + 1}</span> },
                      { key: 'product', header: 'Product', render: (row) => <IdText value={row.product_id} /> },
                      { key: 'sku', header: 'SKU', render: (row) => <IdText value={row.sku} /> },
                      { key: 'status', header: 'Status', render: (row) => <Badge variant={row.status === 'valid' ? 'success' : 'danger'}>{row.status}</Badge> },
                      {
                        key: 'errors',
                        header: 'Errors',
                        render: (row) => <span className="text-xs text-gx-muted">{Object.keys(row.field_errors).join(', ') || 'none'}</span>,
                      },
                    ]}
                  />
                )}
              </div>
              <div>
                <div className="mb-2 text-sm font-semibold text-gx-text">API bulk result</div>
                {!bulkResult ? (
                  <p className="text-sm text-gx-muted">Run the API bulk dry-run to validate the normalized product payload.</p>
                ) : (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant={bulkResult.dry_run ? 'warning' : 'success'}>{bulkResult.dry_run ? 'dry-run' : 'written'}</Badge>
                      {Object.entries(bulkResult.summary).map(([key, value]) => (
                        <Badge key={key}>{key}: {String(value)}</Badge>
                      ))}
                    </div>
                    <Table
                      data={bulkResult.rows}
                      rowKey={(row) => `${row.index}-${row.product_id ?? 'missing'}`}
                      columns={[
                        { key: 'row', header: 'Row', render: (row) => <span className="font-mono text-xs text-gx-muted">{row.index + 1}</span> },
                        { key: 'product', header: 'Product', render: (row) => <IdText value={row.product_id} /> },
                        { key: 'status', header: 'Status', render: (row) => <Badge variant={statusVariant(row.status)}>{row.status}</Badge> },
                        { key: 'errors', header: 'Errors', render: (row) => <span className="text-xs text-gx-muted">{Object.keys(row.field_errors ?? {}).join(', ') || 'none'}</span> },
                      ]}
                    />
                  </div>
                )}
              </div>
            </div>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={writeOpen}
        onClose={() => setWriteOpen(false)}
        onConfirm={writeBulkProducts}
        title="Write parsed products"
        message="Write the normalized CSV rows through the sandbox catalog bulk endpoint? This does not perform a production upload."
        confirmLabel="Write products"
        variant="primary"
        loading={bulkWriting}
      />
    </div>
  );
}
