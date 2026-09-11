import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  ExternalLink,
  Merge,
  Plus,
  Settings,
} from 'lucide-react';
import { send } from '../api';
import { DEFAULT_BRANDING } from '../../../shared/branding';
import type { Client, Project } from '../../../shared/types';
import {
  CLIENT_VISIBILITIES,
  resolveViewChoice,
  type ViewDefaults,
} from '../../../shared/view-defaults';
import { type Modal } from './App';
import { formatDate, initials } from './formatting';
import { DriveBadge, Empty, SearchBox } from './Primitives';
import { PageHead } from './Shell';
import { DiscussionPanel } from './DiscussionPanel';

export function Clients({
  clients,
  projects,
  viewDefaults,
  open,
  refresh,
  flash,
}: {
  clients: Client[];
  projects: Project[];
  viewDefaults: ViewDefaults;
  open: (m: Modal) => void;
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const [query, setQuery] = useState('');
  const [params, setParams] = useSearchParams();
  const visibility = resolveViewChoice(
    params.get('visibility'),
    CLIENT_VISIBILITIES,
    viewDefaults.clients.visibility,
  );
  const visible = clients.filter(
    (c) =>
      (visibility === 'all' || c.status === visibility.toUpperCase()) &&
      c.name.toLowerCase().includes(query.toLowerCase()),
  );
  const setVisibility = (next: (typeof CLIENT_VISIBILITIES)[number]) => {
    const updated = new URLSearchParams(params);
    if (next === viewDefaults.clients.visibility) updated.delete('visibility');
    else updated.set('visibility', next);
    setParams(updated);
  };
  const archive = async (c: Client) => {
    if (!confirm(`Archive ${c.name}? Its Drive folder and project history will remain intact.`))
      return;
    await send(`/clients/${c.id}/archive`, 'POST');
    await refresh();
    flash('Client archived.');
  };
  const unarchive = async (c: Client) => {
    await send(`/clients/${c.id}/unarchive`, 'POST');
    await refresh();
    flash('Client restored to Active.');
  };
  return (
    <>
      <PageHead
        eyebrow="Relationships"
        title="Clients"
        body="A clear view of every client, their work, and Drive connection."
        action={
          <button onClick={() => open({ type: 'client' })}>
            <Plus /> New client
          </button>
        }
      />
      <div className="client-tools">
        <div
          className="segmented-control client-visibility"
          role="group"
          aria-label="Client visibility"
        >
          {(['active', 'archived', 'all'] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={visibility === value}
              onClick={() => setVisibility(value)}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
        <SearchBox value={query} set={setQuery} placeholder="Search clients…" />
      </div>
      <div className="card-grid">
        {visible.map((c) => (
          <article className={`entity-card ${c.status === 'ARCHIVED' ? 'muted' : ''}`} key={c.id}>
            <div className="entity-top">
              <div
                className="monogram large"
                style={{
                  background: c.branding?.colorOne || DEFAULT_BRANDING.background,
                  color: c.branding?.colorTwo || DEFAULT_BRANDING.foreground,
                }}
              >
                {c.branding?.logoUrl ? (
                  <img src={c.branding.logoUrl} alt={c.name} />
                ) : (
                  initials(c.name)
                )}
              </div>
              <div className="entity-badges">
                {c.status === 'ARCHIVED' && <span className="archived-badge">Archived</span>}
                {c.mergedInto && (
                  <span className="merged-badge">Merged into {c.mergedInto.name}</span>
                )}
                <DriveBadge status={c.driveStatus} />
              </div>
            </div>
            <Link className="entity-title" to={`/clients/${c.id}`}>
              <h2>{c.name}</h2>
              <span>
                {projects.filter((p) => p.clientId === c.id && p.status !== 'ARCHIVED').length}{' '}
                active projects
              </span>
            </Link>
            <div className="entity-contact">
              {c.contactName && <span>{c.contactName}</span>}
              {c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}
            </div>
            <div className="card-actions">
              {c.driveFolderUrl ? (
                <a className="secondary" href={c.driveFolderUrl} target="_blank" rel="noreferrer">
                  Drive <ExternalLink />
                </a>
              ) : (
                <span />
              )}
              <button
                className="icon-btn"
                onClick={() => open({ type: 'client', value: c })}
                aria-label={`Edit ${c.name}`}
              >
                <Settings />
              </button>
              {c.status === 'ACTIVE' && (
                <button
                  className="icon-btn danger"
                  onClick={() => archive(c)}
                  aria-label={`Archive ${c.name}`}
                >
                  <Archive />
                </button>
              )}
              {/* A merged client stays archived, so it is not offered a button the API answers
                  with a 409. The badge above says where its work went instead. */}
              {c.status === 'ARCHIVED' && !c.mergedInto && (
                <button
                  className="icon-btn"
                  onClick={() => unarchive(c)}
                  aria-label={`Unarchive ${c.name}`}
                >
                  <ArchiveRestore />
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {!visible.length && (
        <Empty
          title="No clients found"
          body={
            query
              ? `No ${visibility === 'all' ? '' : `${visibility} `}clients match this search.`
              : visibility === 'active'
                ? 'No active clients. Create one or switch views.'
                : visibility === 'archived'
                  ? 'No archived clients.'
                  : 'Create your first client to begin.'
          }
          action={
            !query ? (
              <button onClick={() => open({ type: 'client' })}>
                <Plus /> New client
              </button>
            ) : undefined
          }
        />
      )}
    </>
  );
}

export function ClientDetail({
  clients,
  projects,
  open,
  refresh,
  flash,
}: {
  clients: Client[];
  projects: Project[];
  open: (m: Modal) => void;
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const { id } = useParams();
  const client = clients.find((c) => c.id === id);
  if (!client)
    return <Empty title="Client not found" body="This client may have been archived or removed." />;
  const mine = projects.filter((p) => p.clientId === id);
  const unarchive = async () => {
    await send(`/clients/${client.id}/unarchive`, 'POST');
    await refresh();
    flash('Client restored to Active.');
  };
  /**
   * A merge needs somewhere for the work to go: another live client that was not itself merged
   * away. With none, the action stays visible and explains why it cannot be used, rather than
   * disappearing from a page where it is sometimes there and sometimes not.
   */
  const destinations = clients.filter(
    (candidate) =>
      candidate.status === 'ACTIVE' && candidate.id !== client.id && !candidate.mergedInto,
  );
  return (
    <>
      <div className="backline">
        <Link to="/clients">← All clients</Link>
      </div>
      <PageHead
        focusOnMount
        eyebrow="Client portfolio"
        title={client.name}
        body={client.notes || 'Client details and every project in one place.'}
        action={
          <div className="head-actions">
            {client.driveFolderUrl && (
              <a
                className="secondary buttonlike"
                href={client.driveFolderUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open Drive <ExternalLink />
              </a>
            )}
            {/* Offered on an active or an archived client, because a duplicate is usually
                archived already. A client that has itself been merged has nothing left to give. */}
            {!client.mergedInto && (
              <button
                className="secondary"
                disabled={!destinations.length}
                title={
                  destinations.length
                    ? undefined
                    : 'A merge needs another active client to move this work into.'
                }
                onClick={() => open({ type: 'clientMerge', source: client })}
              >
                <Merge /> Merge client
              </button>
            )}
            {client.status === 'ACTIVE' && (
              <button onClick={() => open({ type: 'project', clientId: client.id })}>
                <Plus /> New project
              </button>
            )}
          </div>
        }
      />
      {!destinations.length && !client.mergedInto && (
        <p className="field-hint merge-unavailable">
          Merge is unavailable: there is no other active client to move this work into.
        </p>
      )}
      {client.mergedInto ? (
        <div className="inline-warning merged-client-state" role="status">
          <Merge />
          <div>
            <strong>This client was merged into {client.mergedInto.name}</strong>
            <span>
              Its projects moved on {formatDate(client.mergedInto.mergedAt)}. Its own contact
              details and notes are kept here, its Drive folder was left where it was, and it cannot
              be unarchived.
            </span>
          </div>
          <Link className="secondary buttonlike" to={`/clients/${client.mergedInto.id}`}>
            Open {client.mergedInto.name} <ChevronRight />
          </Link>
        </div>
      ) : (
        client.status === 'ARCHIVED' && (
          <div className="inline-warning archived-client-state" role="status">
            <Archive />
            <div>
              <strong>This client is archived</strong>
              <span>Its history is intact, but new projects and tasks are paused.</span>
            </div>
            <button className="secondary" onClick={unarchive}>
              <ArchiveRestore /> Unarchive client
            </button>
          </div>
        )
      )}
      <div className="detail-grid">
        <section className="panel detail-info">
          <h2>Client information</h2>
          <dl>
            <dt>Contact</dt>
            <dd>{client.contactName || 'Not added'}</dd>
            <dt>Email</dt>
            <dd>{client.email || 'Not added'}</dd>
            <dt>Phone</dt>
            <dd>{client.phone || 'Not added'}</dd>
            <dt>Drive</dt>
            <dd>
              <DriveBadge status={client.driveStatus} />
              {client.driveError && <small>{client.driveError}</small>}
            </dd>
          </dl>
          <div
            className="client-branding-preview"
            style={{
              background: client.branding?.colorOne || DEFAULT_BRANDING.background,
              color: client.branding?.colorTwo || DEFAULT_BRANDING.foreground,
            }}
          >
            {client.branding?.logoUrl ? (
              <img src={client.branding.logoUrl} alt={client.name} />
            ) : (
              <span>{client.branding ? 'Client palette' : 'Global branding'}</span>
            )}
          </div>
          <button className="secondary" onClick={() => open({ type: 'client', value: client })}>
            Edit details
          </button>
        </section>
        <section className="panel span2">
          <div className="section-title">
            <div>
              <span className="eyebrow">Portfolio</span>
              <h2>Projects</h2>
            </div>
          </div>
          {mine.length ? (
            <div className="project-table">
              {mine.map((p) => (
                <Link to={`/projects/${p.id}`} key={p.id}>
                  <span className="priority-stripe" data-priority={p.priority} />
                  <div>
                    <strong>{p.name}</strong>
                    <span>
                      {p.status.replace('_', ' ')} ·{' '}
                      {p.targetDeadline ? `Due ${formatDate(p.targetDeadline)}` : 'No deadline'}
                    </span>
                  </div>
                  <DriveBadge status={p.driveStatus} />
                  <ChevronRight />
                </Link>
              ))}
            </div>
          ) : (
            <Empty
              compact
              title="No projects yet"
              body="Create the first project for this client."
            />
          )}
        </section>
      </div>
      <DiscussionPanel
        scopeType="client"
        scopeId={client.id}
        subjectLabel={client.name}
        subjectPath={`/clients/${client.id}`}
      />
    </>
  );
}
