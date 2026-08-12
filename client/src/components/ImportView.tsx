import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, CircleAlert, Upload } from 'lucide-react';
import { api } from '../api';
import { PLAYBOOK_SHEETS, type ImportReceipt } from '../../../shared/playbook';
import { formatDateTime } from './formatting';
import { Empty } from './Primitives';
import { PageHead } from './Shell';

/**
 * The Import module: start a campaign playbook import, and read what past ones did.
 *
 * The receipts are the reason this is a page and not only a modal. An import's counts and
 * reasons are stored server-side (`import_receipts`), so the answer to "what did that import
 * actually create, and what did it skip" survives closing the modal, a reload, and a restart.
 */
export function ImportView({
  open,
  /** Bumped by the import modal on every receipt, which is this page's cue to reload. */
  importedAt,
}: {
  open: () => void;
  importedAt: number;
}) {
  const [receipts, setReceipts] = useState<ImportReceipt[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setReceipts(await api<ImportReceipt[]>('/import/receipts'));
      setError('');
    } catch (problem) {
      setError((problem as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, importedAt]);

  return (
    <>
      <PageHead
        eyebrow="Integrations"
        title="Import"
        body="Create a client, its projects, their tasks, checklists, and dependencies from one campaign playbook workbook."
        action={
          <button className="top-action" onClick={open}>
            <Upload /> Import a playbook
          </button>
        }
      />
      <div className="import-layout">
        <section className="panel import-about">
          <h2>How an import behaves</h2>
          <ul>
            <li>
              Every import is previewed first. Nothing is written until the preview is clean and you
              confirm it.
            </li>
            <li>
              Records already in this workspace are skipped and listed, never edited or duplicated —
              so importing the same playbook twice creates nothing the second time.
            </li>
            <li>
              The whole import is one database transaction. A failure part way through leaves this
              workspace exactly as it was.
            </li>
            <li>
              No Google Drive folder is created, renamed, or touched. Imported clients and projects
              are picked up the next time you sync Drive from Settings.
            </li>
          </ul>
          <p className="field-hint">
            The format is documented in <code>docs/campaign-playbook-import-format.md</code>, with a
            sample workbook beside it.
          </p>
        </section>
        <section className="panel import-receipts">
          <div className="section-title">
            <div>
              <span className="eyebrow">Kept after the modal closes</span>
              <h2>Import receipts</h2>
            </div>
          </div>
          {error && (
            <div className="inline-warning" role="alert">
              <AlertCircle />
              <div>
                <strong>Receipts unavailable</strong>
                <span>{error}</span>
              </div>
            </div>
          )}
          {!error && receipts.length === 0 && (
            <Empty
              compact
              title="No imports yet"
              body="Once you import a playbook, its counts and every skipped or failed row stay here."
            />
          )}
          <ul className="receipt-list">
            {receipts.map((receipt) => (
              <li key={receipt.id}>
                <Receipt receipt={receipt} />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

const OUTCOME_LABEL = {
  COMMITTED: 'Imported',
  REJECTED: 'Refused',
  FAILED: 'Failed',
} as const;

function Receipt({ receipt }: { receipt: ImportReceipt }) {
  const committed = receipt.outcome === 'COMMITTED';
  return (
    <details className="receipt">
      <summary>
        <span className={`receipt-badge ${receipt.outcome.toLowerCase()}`}>
          {committed ? <CheckCircle2 /> : <CircleAlert />}
          {OUTCOME_LABEL[receipt.outcome] ?? receipt.outcome}
        </span>
        <span className="receipt-title">
          {receipt.filename ?? (receipt.inputKind === 'text' ? 'Pasted playbook' : 'Workbook')}
        </span>
        <span className="receipt-counts">
          {receipt.createdCount} created · {receipt.skippedCount} skipped · {receipt.failedCount}{' '}
          failed
        </span>
        <time dateTime={receipt.createdAt}>{formatDateTime(receipt.createdAt)}</time>
      </summary>
      {receipt.error && (
        <p className="receipt-error" role="note">
          {receipt.error}
        </p>
      )}
      <table className="import-counts">
        <caption className="sr-only">What this import did, per tab</caption>
        <thead>
          <tr>
            <th scope="col">Tab</th>
            <th scope="col">Created</th>
            <th scope="col">Skipped</th>
          </tr>
        </thead>
        <tbody>
          {PLAYBOOK_SHEETS.map((sheet) => (
            <tr key={sheet}>
              <th scope="row">{sheet}</th>
              <td>{receipt.creates[sheet]}</td>
              <td>{receipt.skips[sheet]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {receipt.issues.length > 0 && (
        <section className="import-list" aria-label="Rows that failed">
          <h3>Rows that failed</h3>
          <ul>
            {receipt.issues.map((issue, index) => (
              <li key={`${issue.sheet}-${issue.row ?? 0}-${index}`}>
                <span className="import-where">
                  {[issue.sheet, issue.row ? `row ${issue.row}` : '', issue.column ?? '']
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {receipt.skipped.length > 0 && (
        <section className="import-list" aria-label="Rows that were skipped">
          <h3>Rows already in this workspace</h3>
          <ul>
            {receipt.skipped.map((skip, index) => (
              <li key={`${skip.sheet}-${skip.row}-${index}`}>
                <span className="import-where">
                  {skip.sheet} · row {skip.row}
                </span>
                <span>
                  <strong>{skip.label}</strong> — {skip.reason}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </details>
  );
}
