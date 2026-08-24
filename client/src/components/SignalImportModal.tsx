import { useRef, useState, type ChangeEvent } from 'react';
import { AlertCircle, CheckCircle2, FileSpreadsheet, RefreshCw, Upload } from 'lucide-react';
import { send } from '../api';
import { formatFileSize } from '../../../shared/drive';
import { SIGNAL_CHANNEL_LABEL, type SignalChannel } from '../../../shared/signal';
import {
  SIGNAL_IMPORT_SHEETS,
  SIGNAL_IMPORT_VERDICT_DURABILITY_LABEL,
  signalImportTotal,
  type SignalImportCapabilityVerdict,
  type SignalImportPreview,
  type SignalImportReceipt,
  type SignalImportResolvedMedia,
} from '../../../shared/signal-import';

type Source = { filename?: string; contentBase64?: string; text?: string };

const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });

export function SignalImportForm({
  close,
  imported,
  refresh,
  flash,
}: {
  close: () => void;
  imported: () => void;
  refresh: () => Promise<void>;
  flash: (message: string, tone?: 'success' | 'error') => void;
}) {
  const [source, setSource] = useState<Source>({});
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<SignalImportPreview | null>(null);
  const [receipt, setReceipt] = useState<SignalImportReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stage, setStage] = useState<'choose' | 'preview' | 'done'>('choose');
  const fileInput = useRef<HTMLInputElement>(null);

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setSource({ filename: file.name, contentBase64: await readBase64(file) });
      setText('');
      setError('');
    } catch (problem) {
      setError((problem as Error).message);
    }
  };
  const body = () => (source.contentBase64 ? source : { text });
  const check = async () => {
    setBusy(true);
    setError('');
    try {
      setPreview(await send<SignalImportPreview>('/import/signal/preview', 'POST', body()));
      setStage('preview');
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const result = await send<{ receipt: SignalImportReceipt; preview: SignalImportPreview }>(
        '/import/signal',
        'POST',
        { ...body(), fingerprint: preview.fingerprint },
      );
      setReceipt(result.receipt);
      setPreview(result.preview);
      setStage('done');
      imported();
      await refresh();
      flash(`Imported ${result.receipt.createdCount} Signal posts.`);
    } catch (problem) {
      const detail = (
        problem as { data?: { receipt?: SignalImportReceipt; preview?: SignalImportPreview } }
      ).data;
      if (detail?.receipt) {
        setReceipt(detail.receipt);
        imported();
      }
      if (detail?.preview) setPreview(detail.preview);
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ready = Boolean(source.contentBase64) || text.trim().length > 0;
  return (
    <div className="form import-form">
      {stage === 'choose' && (
        <>
          <p className="field-hint">
            Import planned Signal posts from an .xlsx workbook or pasted tabs. Drive links are
            resolved during preview; no publishing provider is contacted.
          </p>
          <label>
            Signal import workbook
            <input ref={fileInput} type="file" accept=".xlsx" onChange={chooseFile} />
          </label>
          {source.filename && (
            <p className="import-chosen">
              <FileSpreadsheet /> {source.filename}
            </p>
          )}
          <label>
            Or paste the tabs
            <textarea
              rows={8}
              spellCheck={false}
              placeholder={'[SignalPosts]\npost_key\ttext\nPOST-001\tA planned post'}
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
        </>
      )}
      {stage !== 'choose' && preview && (
        <SignalImportPreviewPanel preview={preview} receipt={receipt} />
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
                <Upload /> Check Signal import
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
              {busy
                ? 'Importing…'
                : preview?.ok
                  ? `Import ${signalImportTotal(preview.creates)} records`
                  : 'Fix problems first'}
            </button>
          </>
        )}
        {stage === 'done' && (
          <button className="submit" onClick={close}>
            Done
          </button>
        )}
      </div>
    </div>
  );
}

function SignalImportPreviewPanel({
  preview,
  receipt,
}: {
  preview: SignalImportPreview;
  receipt: SignalImportReceipt | null;
}) {
  const committed = receipt?.outcome === 'COMMITTED';
  const driveShort = preview.driveNamed > preview.driveResolved;
  const capability = receipt?.capabilitySummary ?? preview.capabilitySummary;
  const verdicts = receipt?.capabilityVerdicts ?? preview.capabilityVerdicts;
  return (
    <div className="import-preview">
      <div
        className={`inline-warning ${committed || (!receipt && preview.ok) ? 'ready' : 'blocked'}`}
      >
        {preview.ok ? <CheckCircle2 /> : <AlertCircle />}
        <div>
          <strong>
            {receipt
              ? committed
                ? `Imported ${receipt.createdCount} records`
                : 'Nothing was imported'
              : preview.ok
                ? 'Ready to import'
                : `${preview.issues.length} problems to fix first`}
          </strong>
          <span>
            {receipt?.error ??
              `${signalImportTotal(preview.updates)} updates, ${signalImportTotal(preview.skips)} fallback skips. Schema version ${preview.schemaVersion}.`}
          </span>
        </div>
      </div>
      {capability.postsEvaluated > 0 && (
        <div
          className={`inline-warning ${capability.postsWithWarnings === 0 ? 'ready' : 'attention'}`}
          role="status"
        >
          {capability.postsWithWarnings === 0 ? <CheckCircle2 /> : <AlertCircle />}
          <div>
            <strong>
              {capability.postsClean} of {capability.postsEvaluated} posts import clean for
              publishing
            </strong>
            <span>
              {capability.postsWithWarnings === 0
                ? 'No capability warnings against the content or connected accounts.'
                : `${capability.postsWithWarnings} post${capability.postsWithWarnings === 1 ? '' : 's'} ${capability.postsWithWarnings === 1 ? 'carries' : 'carry'} ${verdicts.length} warning${verdicts.length === 1 ? '' : 's'} — import still proceeds.`}
            </span>
          </div>
        </div>
      )}
      {driveShort && (
        <div className="inline-warning blocked" role="alert">
          <AlertCircle />
          <div>
            <strong>
              Resolved {preview.driveResolved} of {preview.driveNamed} Drive files
            </strong>
            <span>
              Every Drive media row the workbook names has to bind before confirmation is available.
            </span>
          </div>
        </div>
      )}
      <table className="import-counts">
        <caption className="sr-only">What this Signal import would do, per tab</caption>
        <thead>
          <tr>
            <th scope="col">Tab</th>
            <th scope="col">Create</th>
            <th scope="col">Update</th>
            <th scope="col">Skip</th>
          </tr>
        </thead>
        <tbody>
          {SIGNAL_IMPORT_SHEETS.map((sheet) => (
            <tr key={sheet}>
              <th scope="row">{sheet}</th>
              <td>{preview.creates[sheet]}</td>
              <td>{preview.updates[sheet]}</td>
              <td>{preview.skips[sheet]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {verdicts.length > 0 && <CapabilityVerdictList verdicts={verdicts} />}
      {preview.resolvedMedia.length > 0 && <ResolvedMediaList items={preview.resolvedMedia} />}
      {preview.issues.length > 0 && (
        <section className="import-list" aria-label="Problems to fix">
          <h3>Problems to fix</h3>
          <ul>
            {preview.issues.map((item, index) => (
              <li key={`${item.sheet}-${item.row ?? 0}-${index}`}>
                <span className="import-where">
                  {[
                    item.sheet,
                    item.row && `row ${item.row}`,
                    item.column && `column ${item.column}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span>{item.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function CapabilityVerdictList({ verdicts }: { verdicts: SignalImportCapabilityVerdict[] }) {
  const durable = verdicts.filter((item) => item.durability === 'DURABLE');
  const momentary = verdicts.filter((item) => item.durability === 'MOMENTARY');
  return (
    <section className="import-list" aria-label="Publishing capability warnings">
      <h3>Publishing capability warnings</h3>
      <p className="field-hint">
        These do not block the import. Fix copy and media in Signal, or reconnect accounts later.
      </p>
      {durable.length > 0 && (
        <VerdictGroup
          title="About the content"
          hint={SIGNAL_IMPORT_VERDICT_DURABILITY_LABEL.DURABLE}
          verdicts={durable}
        />
      )}
      {momentary.length > 0 && (
        <VerdictGroup
          title="About right now"
          hint={SIGNAL_IMPORT_VERDICT_DURABILITY_LABEL.MOMENTARY}
          verdicts={momentary}
        />
      )}
    </section>
  );
}

function VerdictGroup({
  title,
  hint,
  verdicts,
}: {
  title: string;
  hint: string;
  verdicts: SignalImportCapabilityVerdict[];
}) {
  return (
    <div className="import-verdict-group">
      <h4>{title}</h4>
      <p className="field-hint">{hint}</p>
      <ul>
        {verdicts.map((item, index) => (
          <li key={`${item.postKey}-${item.channel}-${index}`}>
            <span className="import-where">
              {item.postKey}
              {item.row ? ` · row ${item.row}` : ''} ·{' '}
              {SIGNAL_CHANNEL_LABEL[item.channel as SignalChannel] ?? item.channel}
              {item.publishWouldRefuse ? ' · would refuse publish' : ' · would warn on publish'}
            </span>
            <span>{item.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResolvedMediaList({ items }: { items: SignalImportResolvedMedia[] }) {
  return (
    <section className="import-list" aria-label="Media this import would write">
      <h3>Media this import would write</h3>
      <ul>
        {items.map((item) => (
          <li key={`${item.postKey}-${item.order}-${item.row}`}>
            <span className="import-where">
              {item.postKey} · order {item.order}
              {item.row ? ` · row ${item.row}` : ''}
            </span>
            <span>
              {item.source === 'DRIVE' ? (
                item.resolved ? (
                  <>
                    <strong>{item.driveName}</strong>
                    {` · ${item.mimeType} · ${formatFileSize(item.sizeBytes ?? null)}`}
                    {item.resolvedAt ? ` · resolved ${item.resolvedAt}` : ''}
                  </>
                ) : (
                  <>Drive file did not resolve</>
                )
              ) : (
                <>Public URL · {item.url}</>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
