import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  CircleAlert,
  Download,
  FileSpreadsheet,
  LoaderCircle,
  RotateCcw,
  Upload,
} from 'lucide-react';
import {
  productImportColumns,
  productImportTemplate,
  type ProductImportReport,
  type ProductImportRowInput,
  type ProductImportRowResult,
  type ProductImportRun,
} from '@medimart/shared';
import { useApp } from '../../lib/context';
import { Button, PageHeading } from '../../components/ui';
import { BackLink, ErrorBlock, Field } from './shared';
import { parseCsv, useAsync } from './lib';

/**
 * Bulk catalogue onboarding.
 *
 * The wizard never guesses: the same parse/validate/normalise pipeline runs in the preview, and a
 * preview that contains any error cannot be applied (the API refuses it). That means the shopkeeper
 * sees exactly which spreadsheet line is wrong, fixes the file, and re-uploads — nothing is written
 * half-way and no row is silently dropped.
 */
export function ProductImportPage() {
  const { api } = useApp();
  const navigate = useNavigate();
  const [rows, setRows] = useState<ProductImportRowInput[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [report, setReport] = useState<ProductImportReport | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const history = useAsync(
    () => api.request<{ runs: ProductImportRun[] }>('/api/products/import/runs'),
    [],
  );

  const visibleRows = useMemo(() => {
    if (!report) return [];
    return onlyErrors ? report.rows.filter((row) => row.action === 'error') : report.rows;
  }, [report, onlyErrors]);

  const onFile = async (file: File) => {
    setReport(null);
    setError(null);
    setParseErrors([]);
    setFileName(file.name);
    try {
      const text = await file.text();
      const { rows: parsed, errors } = parseCsv(text);
      setRows(parsed);
      setParseErrors(errors);
      if (parsed.length === 0 && errors.length === 0)
        setError('That file had a header but no data rows.');
    } catch {
      setError('That file could not be read. Save it as CSV and try again.');
      setRows([]);
    }
  };

  const run = async (preview: boolean) => {
    if (rows.length === 0) return;
    setBusy(preview ? 'preview' : 'apply');
    setError(null);
    try {
      const result = await api.request<ProductImportReport>('/api/products/import', 'POST', {
        rows,
        preview,
        updateExisting,
        fileName: fileName ?? undefined,
        // Reusing the key across preview and apply would replay the preview, so they differ.
        idempotencyKey: preview ? `${idempotencyKey}-preview` : idempotencyKey,
      });
      setReport(result);
      if (!preview && result.id) {
        history.reload();
        // A fresh key means the next upload is a new run rather than a replay of this one.
        setIdempotencyKey(crypto.randomUUID());
      }
    } catch (problem) {
      const failure = problem as Error & { code?: string };
      setError(
        failure.code === 'IMPORT_HAS_ERRORS'
          ? 'The file still contains errors, so nothing was written. Fix the rows marked in red and preview again.'
          : failure.message,
      );
    } finally {
      setBusy(null);
    }
  };

  const downloadTemplate = () => {
    const blob = new Blob([productImportTemplate], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'medimart-product-import-template.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const downloadErrors = () => {
    if (!report) return;
    const lines = [
      ['row', 'name', 'action', 'problem'].join(','),
      ...report.rows
        .filter((row) => row.action === 'error')
        .map((row) =>
          [row.row, quote(row.name), row.action, quote(row.messages.join('; '))].join(','),
        ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'medimart-import-errors.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  /**
   * A clean preview is what unlocks the write. Apply is a separate request carrying the same rows,
   * so the button must not depend on the report being a non-preview one.
   */
  const canApply =
    report !== null &&
    !report.blocked &&
    report.errorCount === 0 &&
    report.createCount + report.updateCount > 0;

  return (
    <>
      <BackLink to="/inventory/products">Products</BackLink>
      <PageHeading
        title="Import products"
        description="Bring in a whole supplier catalogue at once. Nothing is written until you have seen exactly what will happen."
        action={
          <Button variant="secondary" onClick={downloadTemplate}>
            <Download size={16} /> CSV template
          </Button>
        }
      />

      <ol className="wizard-steps">
        <li className={rows.length > 0 ? 'is-done' : 'is-current'}>
          <span>1</span> Choose a file
        </li>
        <li className={report ? 'is-done' : rows.length > 0 ? 'is-current' : ''}>
          <span>2</span> Preview
        </li>
        <li
          className={
            report && !report.preview && canApply ? 'is-done' : canApply ? 'is-current' : ''
          }
        >
          <span>3</span> Apply
        </li>
      </ol>

      {error && <ErrorBlock message={error} />}

      <section className="card">
        <div className="card-heading">
          <div>
            <h2>1. Your spreadsheet</h2>
            <p>
              Save your catalogue as CSV with a header row. Column names are matched
              case-insensitively; unknown columns are ignored rather than guessed at.
            </p>
          </div>
        </div>
        <div className="import-drop">
          <label className="drop-target">
            <input
              type="file"
              accept=".csv,text/csv"
              className="visually-hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onFile(file);
              }}
            />
            <FileSpreadsheet size={26} />
            <strong>{fileName ?? 'Choose a CSV file'}</strong>
            <span className="muted small">
              {fileName
                ? `${rows.length} data row${rows.length === 1 ? '' : 's'} read`
                : 'Or drag a file onto this area. Up to 5,000 rows per import.'}
            </span>
          </label>
        </div>
        <details className="import-columns">
          <summary>Columns MediMart understands</summary>
          <div className="column-chips">
            {productImportColumns.map((column) => (
              <code key={column}>{column}</code>
            ))}
          </div>
          <p className="muted small">
            <strong>name</strong> is the only required column. Prices are read as naira (
            <code>120.50</code>). <code>dosageForm</code> accepts everyday words — “tabs”, “caps”,
            “syrup” — and is normalised. <code>expiryTracked</code> accepts yes/no.
          </p>
        </details>
        {parseErrors.length > 0 && (
          <div className="notice notice-error" role="alert">
            <CircleAlert size={16} />
            <div>
              <strong>{parseErrors.length} problem(s) reading the file</strong>
              <ul>
                {parseErrors.slice(0, 6).map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-heading">
          <div>
            <h2>2. Preview before writing</h2>
            <p>
              A duplicate is matched on SKU first, then barcode, then name and strength. Matching
              rows are skipped unless you choose to update them.
            </p>
          </div>
          <div className="row-actions">
            <Button
              onClick={() => void run(true)}
              busy={busy === 'preview'}
              disabled={rows.length === 0 || busy !== null}
            >
              <Upload size={16} /> Preview import
            </Button>
          </div>
        </div>
        <div className="import-options">
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={updateExisting}
              onChange={(event) => {
                setUpdateExisting(event.target.checked);
                setReport(null);
              }}
            />
            <span>
              Update products that already exist
              <small>
                Off: an existing match is skipped and left untouched. On: its name, prices, pack
                size and strength are overwritten with the spreadsheet values.
              </small>
            </span>
          </label>
        </div>
        {report && (
          <div className="import-report">
            <div className="import-summary">
              <Summary label="Rows" value={report.totalRows} />
              <Summary label="New" value={report.createCount} tone="green" />
              <Summary label="Updates" value={report.updateCount} tone="green" />
              <Summary label="Skipped" value={report.skipCount} tone="neutral" />
              <Summary label="Errors" value={report.errorCount} tone="red" />
            </div>
            {report.errorCount > 0 ? (
              <div className="notice notice-error" role="alert">
                <CircleAlert size={16} />
                <span>
                  {report.errorCount} row{report.errorCount === 1 ? '' : 's'} need fixing. Import is
                  blocked until the file is clean — nothing has been written.
                </span>
                <Button variant="secondary" onClick={downloadErrors}>
                  <Download size={14} /> Error report
                </Button>
              </div>
            ) : report.preview ? (
              <div className="notice notice-info" role="status">
                <CheckCircle2 size={16} />
                <span>
                  Preview only — nothing written yet. Apply to create{' '}
                  {report.createCount + report.updateCount} product
                  {report.createCount + report.updateCount === 1 ? '' : 's'}.
                </span>
              </div>
            ) : (
              <div className="notice notice-success" role="status">
                <CheckCircle2 size={16} />
                <span>
                  Imported: {report.createCount} created, {report.updateCount} updated,{' '}
                  {report.skipCount} skipped.
                </span>
                <Button variant="secondary" onClick={() => navigate('/inventory/products')}>
                  View products
                </Button>
              </div>
            )}
          </div>
        )}
      </section>

      {report && (
        <section className="card">
          <div className="card-heading">
            <div>
              <h2>Row-by-row result</h2>
              <p>Row numbers match your spreadsheet, counting the header as row 1.</p>
            </div>
            <label className="chip toggle-chip">
              <input
                type="checkbox"
                checked={onlyErrors}
                onChange={(event) => setOnlyErrors(event.target.checked)}
              />
              Only rows with problems
            </label>
          </div>
          <div className="table-scroll import-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Name</th>
                  <th scope="col">Action</th>
                  <th scope="col">Matched on</th>
                  <th scope="col">Notes</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr key={`${row.row}-${row.name}`} className={`import-row-${row.action}`}>
                    <td className="numeric">{row.row}</td>
                    <td className="table-primary">
                      {row.name || <em className="muted">(no name)</em>}
                    </td>
                    <td>
                      <span className={`status-pill status-${actionTone(row.action)}`}>
                        {row.action === 'error' ? 'Error' : capitalise(row.action)}
                      </span>
                    </td>
                    <td className="muted small">{row.matchedOn ?? '—'}</td>
                    <td className="small">
                      {row.messages.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <ul className="import-messages">
                          {row.messages.map((message) => (
                            <li key={message}>{message}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-heading">
          <div>
            <h2>3. Apply</h2>
            <p>
              Writing is transactional: either the whole clean file is imported, or nothing is.
              Repeating the same import cannot create duplicates.
            </p>
          </div>
          <div className="row-actions">
            <Button
              onClick={() => void run(false)}
              busy={busy === 'apply'}
              disabled={!canApply || busy !== null}
            >
              <CheckCircle2 size={16} /> Apply import
            </Button>
          </div>
        </div>
        <div className="import-options">
          <Field label="This run's reference" hint="Kept so a repeat cannot import twice.">
            <code className="run-key">{idempotencyKey}</code>
          </Field>
        </div>
      </section>

      <section className="card">
        <div className="card-heading">
          <div>
            <h2>Past imports</h2>
            <p>Every applied import is recorded with who ran it and what it changed.</p>
          </div>
          <Button variant="secondary" onClick={history.reload}>
            <RotateCcw size={15} /> Refresh
          </Button>
        </div>
        {history.error ? (
          <ErrorBlock message={history.error} onRetry={history.reload} />
        ) : history.loading ? (
          <p className="card-empty muted">
            <LoaderCircle size={15} className="spin" /> Loading import history…
          </p>
        ) : (history.data?.runs.length ?? 0) === 0 ? (
          <p className="card-empty muted">No imports have been applied yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table compact">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">File</th>
                  <th scope="col" className="numeric">
                    Created
                  </th>
                  <th scope="col" className="numeric">
                    Updated
                  </th>
                  <th scope="col" className="numeric">
                    Skipped
                  </th>
                </tr>
              </thead>
              <tbody>
                {history.data!.runs.map((run) => (
                  <tr key={run.id}>
                    <td className="muted small">
                      {run.createdAt ? formatWhen(run.createdAt) : '—'}
                    </td>
                    <td>
                      <span className="table-primary">{run.fileName ?? 'Spreadsheet import'}</span>
                      {run.createdByName && (
                        <div>
                          <small className="muted">by {run.createdByName}</small>
                        </div>
                      )}
                    </td>
                    <td className="numeric">{run.createdRows}</td>
                    <td className="numeric">{run.updatedRows}</td>
                    <td className="numeric">{run.skippedRows}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="muted small import-footnote">
        Looking for one-off entry instead?{' '}
        <Link className="text-green" to="/inventory/products/new">
          Register a single product
        </Link>
        .
      </p>
    </>
  );
}

function Summary({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'green' | 'neutral' | 'red';
}) {
  return (
    <div className={`import-stat tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function actionTone(action: ProductImportRowResult['action'] | string) {
  if (action === 'error') return 'red';
  if (action === 'skip') return 'neutral';
  return 'green';
}

function capitalise(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function quote(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function formatWhen(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
}
