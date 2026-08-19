import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Merge } from 'lucide-react';
import { send } from '../api';
import type { Client } from '../../../shared/types';
import {
  CLIENT_MERGE_NOTICES,
  type ClientMergePreview,
  type ClientMergeResult,
} from '../../../shared/client-merge';
import { Empty } from './Primitives';

/**
 * Merging one client into another, confirmed against a preview rather than a `window.confirm`.
 *
 * There is nothing to type: choosing a destination loads the server's own plan, and the plan is
 * what the dialog reads out — both names, every project that would move whatever its status, every
 * import identity that follows them, and the fixed statements in `CLIENT_MERGE_NOTICES` about what
 * a merge does not do. Confirm stays disabled until a clean preview is on screen, and it sends that
 * preview's hash back, so a workspace that moved in the meantime is refused with a 409 instead of
 * merging something nobody was shown.
 */
export function ClientMergeForm({
  source,
  clients,
  close,
  refresh,
  flash,
}: {
  source: Client;
  clients: Client[];
  close: () => void;
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const navigate = useNavigate();
  const [destinationId, setDestinationId] = useState('');
  const [preview, setPreview] = useState<ClientMergePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** A destination has to be a live client that is not this one and was not itself merged away. */
  const destinations = clients.filter(
    (candidate) =>
      candidate.status === 'ACTIVE' && candidate.id !== source.id && !candidate.mergedInto,
  );

  /** Reads the server's plan. Leaves any message already on screen alone — see `confirm`. */
  const readPlan = async (id: string) => {
    setBusy(true);
    try {
      setPreview(
        await send<ClientMergePreview>(`/clients/${source.id}/merge/preview`, 'POST', {
          destinationId: id,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const chooseDestination = (id: string) => {
    setDestinationId(id);
    setPreview(null);
    setError('');
    if (id) void readPlan(id);
  };

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const result = await send<ClientMergeResult>(`/clients/${source.id}/merge`, 'POST', {
        destinationId: preview.destination.id,
        planHash: preview.planHash,
      });
      await refresh();
      close();
      navigate(`/clients/${result.destination.id}`);
      flash(
        `${result.source.name} merged into ${result.destination.name}. ${result.movedProjectCount} project${
          result.movedProjectCount === 1 ? '' : 's'
        } moved.`,
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      /**
       * A stale plan is the one refusal the dialog can resolve by itself: re-read the merge, so
       * the next confirmation is taken against what the workspace says now. The message stays
       * on screen beside the fresh plan — the point is that this is a second look, not a retry
       * of the same one.
       */
      if ((err as { status?: number }).status === 409) {
        setPreview(null);
        await readPlan(preview.destination.id);
      }
    }
  };

  if (!destinations.length)
    return (
      <div className="form">
        <Empty
          compact
          title="No client to merge into"
          body="A merge needs another active client that has not itself been merged away. Create or unarchive one first."
        />
        <footer className="merge-actions">
          <button type="button" className="secondary" onClick={close}>
            Close
          </button>
        </footer>
      </div>
    );

  return (
    <div className="form client-merge">
      <label>
        Merge into
        <select
          name="destinationId"
          value={destinationId}
          onChange={(event) => chooseDestination(event.target.value)}
        >
          <option value="">Select the client to keep</option>
          {destinations.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
      <p className="field-hint">
        <strong>{source.name}</strong> keeps its own contact details and notes, and is archived once
        the merge is done.
      </p>

      {preview && (
        <section className="merge-plan" aria-label="Merge preview">
          <h3>
            {preview.source.name} → {preview.destination.name}
          </h3>
          <p>
            {preview.projects.length === 0
              ? `${preview.source.name} has no projects. The merge still records it as merged into ${preview.destination.name}.`
              : `${preview.projects.length} project${
                  preview.projects.length === 1 ? '' : 's'
                } will move to ${preview.destination.name}:`}
          </p>
          {preview.projects.length > 0 && (
            <ul className="merge-projects">
              {preview.projects.map((project) => (
                <li key={project.id}>
                  <strong>{project.name}</strong>
                  <span>{project.status.replace('_', ' ')}</span>
                </li>
              ))}
            </ul>
          )}
          {/*
            The identities the source is known by outside this workspace. Listed rather than
            counted: which id follows the work is the fact a later import turns on, and an
            identity nobody expected to see here is worth catching before the merge, not after.
          */}
          {preview.aliases.length > 0 && (
            <>
              <p>
                {preview.aliases.length === 1
                  ? 'One import identity moves'
                  : `${preview.aliases.length} import identities move`}{' '}
                with it, so a playbook naming {preview.source.name} at its own source will resolve
                to {preview.destination.name} afterwards:
              </p>
              <ul className="merge-aliases" aria-label="Import identities that move">
                {preview.aliases.map((alias) => (
                  <li key={`${alias.namespace} ${alias.externalId}`}>
                    <strong>{alias.externalId}</strong>
                    <code>{alias.namespace}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          <ul className="merge-notices">
            {CLIENT_MERGE_NOTICES.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="form-error" role="alert">
        {error && (
          <>
            <AlertTriangle /> {error}
          </>
        )}
      </div>
      <footer className="merge-actions">
        <button type="button" className="secondary" onClick={close}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={confirm} disabled={!preview || busy}>
          <Merge /> {busy ? 'Merging…' : 'Merge clients'}
        </button>
      </footer>
    </div>
  );
}
