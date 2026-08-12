import { useRef, useState, type ChangeEvent } from 'react';
import { AlertCircle, CheckCircle2, FileSpreadsheet, RefreshCw, Upload } from 'lucide-react';
import { send } from '../api';
import {
  PLAYBOOK_SHEETS,
  totalCount,
  type ImportReceipt,
  type PlaybookIssue,
  type PlaybookPreview,
  type PlaybookSkip,
} from '../../../shared/playbook';

/** What the modal is showing: pick a playbook, read the dry run, read what happened. */
type Stage = 'choose' | 'preview' | 'done';

const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? '' : 's'}`;

/**
 * What stands between this playbook and a write, counted the way the author has to fix it:
 * rows where there are rows, and problems where the trouble is a whole tab — a missing
 * `Projects` tab is one problem and no rows at all.
 */
const blockers = (preview: PlaybookPreview) => {
  const rows = totalCount(preview.failures);
  return rows ? { count: rows, noun: 'row' } : { count: preview.issues.length, noun: 'problem' };
};

interface Source {
  filename?: string;
  contentBase64?: string;
  text?: string;
}

/** The file as base64, because a workbook crosses the API on a JSON body. */
const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });

/**
 * The campaign playbook import: choose a workbook or paste one, read the dry run, then commit.
 *
 * Every rule lives on the server — this asks for a preview, renders exactly what came back,
 * and enables the confirm button only when the server said the preview was clean. The plan is
 * never held here and never sent back: the commit posts the same playbook plus the
 * fingerprint the preview carried, so a file edited between the two is refused rather than
 * imported against a stale preview.
 */
export function ImportForm({
  close,
  imported,
  refresh,
  flash,
}: {
  close: () => void;
  /** Tells the Import page a receipt was written, so its list reloads. */
  imported: () => void;
  refresh: () => Promise<void>;
  flash: (message: string, tone?: 'success' | 'error') => void;
}) {
  const [stage, setStage] = useState<Stage>('choose');
  const [source, setSource] = useState<Source>({});
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<PlaybookPreview | null>(null);
  const [receipt, setReceipt] = useState<ImportReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      setSource({ filename: file.name, contentBase64: await readBase64(file) });
      setText('');
    } catch (problem) {
      setError((problem as Error).message);
    }
  };

  const body = (): Source =>
    source.contentBase64
      ? { filename: source.filename, contentBase64: source.contentBase64 }
      : { text };

  const check = async () => {
    setBusy(true);
    setError('');
    try {
      const next = await send<PlaybookPreview>('/import/playbook/preview', 'POST', body());
      setPreview(next);
      setStage('preview');
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await send<{ receipt: ImportReceipt; preview: PlaybookPreview }>(
        '/import/playbook',
        'POST',
        { ...body(), fingerprint: preview?.fingerprint },
      );
      setReceipt(result.receipt);
      setPreview(result.preview);
      setStage('done');
      imported();
      await refresh();
      flash(`Imported ${result.receipt.createdCount} records from the playbook.`);
    } catch (problem) {
      // A refused import answers 409 with the same preview and receipt the modal renders, so
      // the reasons replace the stale ones rather than becoming a single error line.
      const detail = (problem as { data?: { receipt?: ImportReceipt; preview?: PlaybookPreview } })
        .data;
      if (detail?.preview) setPreview(detail.preview);
      if (detail?.receipt) {
        setReceipt(detail.receipt);
        imported();
      }
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ready = Boolean(source.contentBase64) || text.trim().length > 0;
  const creates = preview ? totalCount(preview.creates) : 0;
  const blocking = preview ? blockers(preview) : null;

  return (
    <div className="form import-form">
      {stage === 'choose' && (
        <>
          <p className="field-hint">
            A campaign playbook is an .xlsx workbook with <code>Clients</code>,{' '}
            <code>Projects</code>, <code>Tasks</code>, <code>ChecklistItems</code>, and{' '}
            <code>Dependencies</code> tabs. Nothing is written until you confirm a clean preview,
            and no Drive folder is touched.
          </p>
          <label>
            Playbook workbook
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={chooseFile}
            />
          </label>
          {source.filename && (
            <p className="import-chosen">
              <FileSpreadsheet /> {source.filename}
            </p>
          )}
          <label>
            Or paste the tabs
            <textarea
              rows={6}
              spellCheck={false}
              placeholder={'[Clients]\nclient_key\tname\nCLI-A\tAcme Studio'}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                if (event.target.value) {
                  setSource({});
                  if (fileInput.current) fileInput.current.value = '';
                }
              }}
            />
          </label>
          <p className="field-hint">
            Paste each tab under its name in square brackets, with the cells separated by tabs —
            what a spreadsheet copies out.
          </p>
        </>
      )}

      {stage !== 'choose' && preview && (
        <PreviewPanel preview={preview} receipt={stage === 'done' ? receipt : null} />
      )}

      <div className="form-error" role="alert">
        {error}
      </div>

      <div className="import-actions">
        {stage === 'choose' && (
          <button className="submit" onClick={check} disabled={busy || !ready}>
            {busy ? (
              <>
                <RefreshCw className="spin" /> Checking…
              </>
            ) : (
              <>
                <Upload /> Check this playbook
              </>
            )}
          </button>
        )}
        {stage === 'preview' && (
          <>
            <button
              type="button"
              className="secondary"
              onClick={() => setStage('choose')}
              disabled={busy}
            >
              Choose another
            </button>
            <button className="submit" onClick={commit} disabled={busy || !preview?.ok}>
              {busy ? (
                <>
                  <RefreshCw className="spin" /> Importing…
                </>
              ) : preview?.ok ? (
                `Import ${count(creates, 'record')}`
              ) : (
                // Never a record count while the import is refused: a blocked playbook writes
                // nothing, so a disabled "Import 7 records" would promise a partial import.
                `Fix ${count(blocking?.count ?? 0, blocking?.noun ?? 'problem')} first`
              )}
            </button>
          </>
        )}
        {stage === 'done' && (
          <button type="button" className="submit" onClick={close}>
            Done
          </button>
        )}
      </div>
      {stage === 'preview' && !preview?.ok && (
        <p className="field-hint" role="status">
          Importing is blocked until every problem above is fixed. Nothing has been written.
        </p>
      )}
    </div>
  );
}

/** The dry run, or the receipt once one exists. Both carry the same lists. */
function PreviewPanel({
  preview,
  receipt,
}: {
  preview: PlaybookPreview;
  receipt: ImportReceipt | null;
}) {
  const committed = receipt?.outcome === 'COMMITTED';
  return (
    <div className="import-preview">
      <div
        className={`inline-warning ${committed || (!receipt && preview.ok) ? 'ready' : 'blocked'}`}
        role={receipt ? 'status' : undefined}
      >
        {preview.ok ? <CheckCircle2 /> : <AlertCircle />}
        <div>
          <strong>
            {receipt
              ? committed
                ? `Imported ${count(receipt.createdCount, 'record')}`
                : 'Nothing was imported'
              : preview.ok
                ? `Ready to create ${count(totalCount(preview.creates), 'record')}`
                : `${count(blockers(preview).count, blockers(preview).noun)} to fix first`}
          </strong>
          <span>
            {receipt
              ? committed
                ? `Skipped ${count(receipt.skippedCount, 'row')} already in this workspace and left them as they are.`
                : (receipt.error ?? 'Every problem below has to be fixed before importing.')
              : `${count(totalCount(preview.skips), 'row')} already here will be skipped. Schema version ${preview.schemaVersion}.`}
          </span>
        </div>
      </div>

      <table className="import-counts">
        <caption className="sr-only">What this playbook would do, per tab</caption>
        <thead>
          <tr>
            <th scope="col">Tab</th>
            <th scope="col">{committed ? 'Created' : 'To create'}</th>
            <th scope="col">Skipped</th>
            <th scope="col">Failed</th>
          </tr>
        </thead>
        <tbody>
          {PLAYBOOK_SHEETS.map((sheet) => (
            <tr key={sheet}>
              <th scope="row">{sheet}</th>
              <td>{(receipt ?? preview).creates[sheet]}</td>
              <td>{preview.skips[sheet]}</td>
              <td>{preview.failures[sheet]}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {preview.issues.length > 0 && <IssueList issues={preview.issues} />}
      {preview.skipped.length > 0 && <SkipList skipped={preview.skipped} />}

      <details className="import-rule">
        <summary>What counts as already imported</summary>
        <ul>
          {preview.duplicateRule.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

const where = (issue: PlaybookIssue) =>
  [issue.sheet, issue.row ? `row ${issue.row}` : '', issue.column ? `column ${issue.column}` : '']
    .filter(Boolean)
    .join(' · ');

function IssueList({ issues }: { issues: PlaybookIssue[] }) {
  return (
    <section className="import-list" aria-label="Problems to fix">
      <h3>Problems to fix</h3>
      <ul>
        {issues.map((issue, index) => (
          <li key={`${issue.sheet}-${issue.row ?? 0}-${index}`}>
            <span className="import-where">{where(issue)}</span>
            <span>{issue.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SkipList({ skipped }: { skipped: PlaybookSkip[] }) {
  return (
    <details className="import-list">
      <summary>{count(skipped.length, 'row')} already in this workspace</summary>
      <ul>
        {skipped.map((skip, index) => (
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
    </details>
  );
}
