import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Archive, ChevronRight, ExternalLink, Plus, Settings } from 'lucide-react';
import { send } from '../api';
import type { Client, Project } from '../../../shared/types';
import { type Modal } from './App';
import { formatDate, initials } from './formatting';
import { DriveBadge, Empty, SearchBox } from './Primitives';
import { PageHead } from './Shell';

export function Clients({
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
  const [query, setQuery] = useState('');
  const visible = clients.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
  const archive = async (c: Client) => {
    if (!confirm(`Archive ${c.name}? Its Drive folder and project history will remain intact.`))
      return;
    await send(`/clients/${c.id}/archive`, 'POST');
    await refresh();
    flash('Client archived.');
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
      <SearchBox value={query} set={setQuery} placeholder="Search clients…" />
      <div className="card-grid">
        {visible.map((c) => (
          <article className={`entity-card ${c.status === 'ARCHIVED' ? 'muted' : ''}`} key={c.id}>
            <div className="entity-top">
              <div className="monogram large">{initials(c.name)}</div>
              <DriveBadge status={c.driveStatus} />
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
            </div>
          </article>
        ))}
      </div>
      {!visible.length && (
        <Empty
          title="No clients found"
          body={query ? 'Try a different search.' : 'Create your first client to begin.'}
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
}: {
  clients: Client[];
  projects: Project[];
  open: (m: Modal) => void;
}) {
  const { id } = useParams();
  const client = clients.find((c) => c.id === id);
  if (!client)
    return <Empty title="Client not found" body="This client may have been archived or removed." />;
  const mine = projects.filter((p) => p.clientId === id);
  return (
    <>
      <div className="backline">
        <Link to="/clients">← All clients</Link>
      </div>
      <PageHead
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
            <button onClick={() => open({ type: 'project', clientId: client.id })}>
              <Plus /> New project
            </button>
          </div>
        }
      />
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
    </>
  );
}
