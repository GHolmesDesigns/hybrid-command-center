import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, CircleAlert, Download, Upload } from 'lucide-react';
import { api } from '../api';
import {
  PLAYBOOK_SHEETS,
  SAMPLE_PLAYBOOK_DOWNLOAD_PATH,
  SAMPLE_PLAYBOOK_FILENAME,
  type ImportReceipt,
} from '../../../shared/playbook';
import { SAMPLE_SIGNAL_DOWNLOAD_PATH, SAMPLE_SIGNAL_FILENAME } from '../../../shared/signal-import';
import {
  INTEGRATION_ENTITY_LABEL,
  INTEGRATION_OPERATION_LABEL,
  INTEGRATION_OUTCOME_LABEL,
  INTEGRATION_SOURCE_LABEL,
  type IntegrationEvent,
} from '../../../shared/integration-log';
import { formatDateTime } from './formatting';
import { Empty } from './Primitives';
import { PageHead } from './Shell';

/**
 * The Import module: start a campaign playbook import, and read what past ones did.
 *
 * The receipts are the reason this is a page and not only a modal. An import's counts and
 * reasons are stored server-side (`import_receipts`), so the answer to "what did that import
 * actually create, and what did it skip" survives closing the modal, a reload, and a restart.
 *
 * Beneath them is the integration activity log (`integration_events`), which answers the
 * narrower question a receipt cannot: which records an integration actually left behind, by
 * id. It lives here rather than only in the database because a half-finished import is
 * diagnosed by whoever ran it.
 */
export function ImportView({
  open,
  openSignal,
  /** Bumped by the import modal on every receipt, which is this page's cue to reload. */
  importedAt,
}: {
  open: () => void;
  openSignal: () => void;
  importedAt: number;
}) {
  const [receipts, setReceipts] = useState<ImportReceipt[]>([]);
  const [error, setError] = useState('');
  const [events, setEvents] = useState<IntegrationEvent[]>([]);
  const [activityError, setActivityError] = useState('');
  const load = useCallback(async () => {
    // Two independent reads: a receipt list that fails must not hide the activity log, which
    // is the more diagnostic of the two, and the reverse.
    try {
      setReceipts(await api<ImportReceipt[]>('/import/receipts'));
      setError('');
    } catch (problem) {
      setError((problem as Error).message);
    }
    try {
      setEvents(await api<IntegrationEvent[]>('/integrations/activity'));
      setActivityError('');
    } catch (problem) {
      setActivityError((problem as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, importedAt]);

  /** An import's audit row, found by the receipt it was written with. */
  const eventByReceipt = useMemo(
    () =>
      new Map(
        events.flatMap((event) => (event.correlationId ? [[event.correlationId, event]] : [])),
      ),
    [events],
  );
  const receiptColumns = useMemo(
    () => [
      receipts.filter((_, index) => index % 2 === 0),
      receipts.filter((_, index) => index % 2 === 1),
    ],
    [receipts],
  );

  return (
    <>
      <PageHead
        eyebrow="Integrations"
        title="Import"
        body="Create a client, its projects, their tasks, checklists, and dependencies from one campaign playbook workbook."
        action={
          <div className="head-actions">
            <div className="sample-downloads" aria-label="Sample workbooks">
              {/*
                Plain links, not fetches: the API answers with `Content-Disposition: attachment`,
                so the browser saves each canonical workbook itself.
              */}
              <a
                className="secondary buttonlike"
                href={SAMPLE_PLAYBOOK_DOWNLOAD_PATH}
                download={SAMPLE_PLAYBOOK_FILENAME}
              >
                <Download /> Download sample playbook
              </a>
              <a
                className="secondary buttonlike"
                href={SAMPLE_SIGNAL_DOWNLOAD_PATH}
                download={SAMPLE_SIGNAL_FILENAME}
              >
                <Download /> Download sample Signal import
              </a>
            </div>
            <div className="import-actions" aria-label="Import actions">
              <button onClick={open}>
                <Upload /> Import a playbook
              </button>
              <button className="secondary" onClick={openSignal}>
                <Upload /> Import Signal queue
              </button>
            </div>
          </div>
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
            <strong>Download sample playbook</strong> above gives you the filled-in workbook to
            start from — every tab, in order, with the columns already named. The format itself is
            documented in <code>docs/campaign-playbook-import-format.md</code>, beside the same
            file.
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
          {receipts.length > 0 && (
            <div className="receipt-columns">
              {receiptColumns.map((column, index) => (
                <ul
                  className="receipt-list"
                  aria-label={`Import receipts column ${index + 1}`}
                  key={index}
                >
                  {column.map((receipt) => (
                    <li key={receipt.id}>
                      <Receipt receipt={receipt} event={eventByReceipt.get(receipt.id)} />
                    </li>
                  ))}
                </ul>
              ))}
            </div>
          )}
        </section>
        <section className="panel import-activity">
          <div className="section-title">
            <div>
              <span className="eyebrow">Append-only, newest first</span>
              <h2>Integration activity</h2>
            </div>
          </div>
          <p className="field-hint">
            One record for every operation an integration ran against this workspace — what it was,
            how it ended, and which clients, projects, and tasks it left behind. Nothing here can be
            edited, and the most recent 200 records are kept.
          </p>
          {activityError && (
            <div className="inline-warning" role="alert">
              <AlertCircle />
              <div>
                <strong>Activity unavailable</strong>
                <span>{activityError}</span>
              </div>
            </div>
          )}
          {!activityError && events.length === 0 && (
            <Empty
              compact
              title="No integration activity yet"
              body="Every import records what it changed here, successful or not, along with the records it created."
            />
          )}
          <ul className="activity-list">
            {events.map((event) => (
              <li key={event.id}>
                <ActivityRecord event={event} />
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

function Receipt({ receipt, event }: { receipt: ImportReceipt; event?: IntegrationEvent }) {
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
      {/* The audit row this receipt was written with, so the two are read as one record. */}
      {event && (
        <p className="receipt-audit">
          Recorded in integration activity as {INTEGRATION_OPERATION_LABEL[event.operation]} —{' '}
          {INTEGRATION_OUTCOME_LABEL[event.outcome].toLowerCase()}, {event.entityCount}{' '}
          {event.entityCount === 1 ? 'record' : 'records'} affected.
        </p>
      )}
    </details>
  );
}

/**
 * One row of the activity log. The entity list is collapsed because ids are for diagnosis, not
 * for reading: the summary and the outcome are what the page is scanned for.
 */
function ActivityRecord({ event }: { event: IntegrationEvent }) {
  const succeeded = event.outcome === 'SUCCESS';
  return (
    <div className="activity">
      <div className="activity-head">
        <span className={`receipt-badge ${event.outcome.toLowerCase()}`}>
          {succeeded ? <CheckCircle2 /> : <CircleAlert />}
          {INTEGRATION_OUTCOME_LABEL[event.outcome]}
        </span>
        <span className="activity-what">
          <strong>{INTEGRATION_SOURCE_LABEL[event.source] ?? event.source}</strong> ·{' '}
          {INTEGRATION_OPERATION_LABEL[event.operation] ?? event.operation}
        </span>
        <time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time>
      </div>
      <p className="activity-summary">{event.summary}</p>
      {event.error && (
        <p className="receipt-error" role="note">
          {event.error}
        </p>
      )}
      {event.entityCount > 0 && (
        <details className="import-list">
          <summary>
            {event.entityCount} {event.entityCount === 1 ? 'record' : 'records'} affected
          </summary>
          <ul>
            {event.entities.map((entity) => (
              <li key={entity.id}>
                <span className="import-where">{INTEGRATION_ENTITY_LABEL[entity.type]}</span>
                <span>
                  <strong>{entity.label}</strong> <code>{entity.id}</code>
                </span>
              </li>
            ))}
          </ul>
          {event.entities.length < event.entityCount && (
            <p className="field-hint">
              Listing the first {event.entities.length} of {event.entityCount}.
            </p>
          )}
        </details>
      )}
    </div>
  );
}
