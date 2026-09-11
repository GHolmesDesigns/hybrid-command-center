import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CalendarClock, Play, RefreshCw } from 'lucide-react';
import { api, send } from '../api';
import { formatDateTime } from './formatting';
import { Empty } from './Primitives';
import {
  AGENT_SCHEDULE_FAILURE_POLICIES,
  AGENT_SCHEDULE_LIMITS,
  type AgentSchedule,
} from '../../../shared/agent-schedules';
import {
  AGENT_HANDOFF_SUBJECT_TYPES,
  type AgentHandoffSubjectType,
} from '../../../shared/agent-coordination';

const blank = {
  ownerAgentLabel: '',
  toAgentLabel: '',
  subjectType: 'freeform' as AgentHandoffSubjectType,
  subjectId: '',
  messageTemplate: '',
  dedupeKey: '',
  cronExpression: '',
  nextRunAt: '',
  failurePolicy: 'RETRY' as (typeof AGENT_SCHEDULE_FAILURE_POLICIES)[number],
};

export function AgentSchedulesCard({
  flash,
}: {
  flash: (message: string, type?: 'success' | 'error') => void;
}) {
  const [schedules, setSchedules] = useState<AgentSchedule[]>([]);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api<{ schedules?: AgentSchedule[] }>('/agent-schedules');
      setSchedules(Array.isArray(result.schedules) ? result.schedules : []);
      setError('');
    } catch (problem) {
      setError((problem as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setCreating(true);
    try {
      await send('/agent-schedules', 'POST', {
        ownerAgentLabel: form.ownerAgentLabel,
        toAgentLabel: form.toAgentLabel || null,
        subjectType: form.subjectType,
        subjectId: form.subjectType === 'freeform' ? null : form.subjectId || null,
        messageTemplate: form.messageTemplate,
        dedupeKey: form.dedupeKey,
        cronExpression: form.cronExpression || null,
        nextRunAt: new Date(form.nextRunAt).toISOString(),
        failurePolicy: form.failurePolicy,
      });
      setForm(blank);
      flash('Schedule created.');
      await load();
    } catch (problem) {
      flash((problem as Error).message, 'error');
    } finally {
      setCreating(false);
    }
  };

  const update = async (schedule: AgentSchedule, action: 'pause' | 'run') => {
    setBusy(`${action}-${schedule.id}`);
    try {
      if (action === 'pause') {
        await send(`/agent-schedules/${schedule.id}`, 'PATCH', { paused: !schedule.paused });
        flash(schedule.paused ? 'Schedule resumed.' : 'Schedule paused.');
      } else {
        await send(`/agent-schedules/${schedule.id}/run-now`, 'POST');
        flash('Run-now created a handoff.');
      }
      await load();
    } catch (problem) {
      flash((problem as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const runDue = async () => {
    setBusy('due');
    try {
      const result = await send<{ runs: Array<{ status: string }> }>(
        '/agent-schedules/run-due',
        'POST',
      );
      const created = result.runs.filter((run) => run.status === 'SUCCEEDED').length;
      flash(`${created} due schedule${created === 1 ? '' : 's'} ran.`);
      await load();
    } catch (problem) {
      flash((problem as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className="panel settings-card"
      id="agent-schedules"
      aria-labelledby="agent-schedules-heading"
    >
      <div className="settings-icon neutral">
        <CalendarClock />
      </div>
      <div className="section-title">
        <div>
          <span className="eyebrow">Unattended work</span>
          <h2 id="agent-schedules-heading">Scheduled agent runs</h2>
        </div>
        <button
          type="button"
          className="text-btn"
          onClick={() => void load()}
          aria-label="Refresh schedules"
        >
          <RefreshCw /> Refresh
        </button>
      </div>
      <p>
        Schedules create ordinary handoffs for an agent to claim. Pause unattended work or run a due
        schedule manually during development.
      </p>
      {error && (
        <div className="inline-warning" role="alert">
          {error}
        </div>
      )}
      {!error && schedules.length === 0 && (
        <Empty
          compact
          title="No schedules yet"
          body="Add a schedule below to make recurring agent work visible in the handoff inbox."
        />
      )}
      {schedules.length > 0 && (
        <ul className="agent-credential-list">
          {schedules.map((schedule) => (
            <li key={schedule.id}>
              <div>
                <strong>
                  {schedule.ownerAgentLabel} → {schedule.toAgentLabel ?? 'any agent'}
                </strong>
                <small>{schedule.messageTemplate}</small>
                <small>
                  Next run:{' '}
                  {schedule.nextRunAt
                    ? formatDateTime(schedule.nextRunAt)
                    : 'One-time run complete'}{' '}
                  · {schedule.cronExpression ? `Cron ${schedule.cronExpression}` : 'One-time'}
                </small>
                <small>
                  Last outcome: {schedule.lastRunStatus ?? 'Not run'}
                  {schedule.lastError ? ` — ${schedule.lastError}` : ''}
                </small>
              </div>
              <div className="agent-credential-actions">
                <span className={`status-pill ${schedule.paused ? 'unknown' : 'available'}`}>
                  {schedule.paused ? 'Paused' : 'Active'}
                </span>
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => void update(schedule, 'pause')}
                  disabled={busy !== null}
                >
                  {schedule.paused ? 'Resume' : 'Pause'}
                </button>
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => void update(schedule, 'run')}
                  disabled={busy !== null}
                >
                  <Play /> Run now
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form className="agent-credential-form agent-schedule-form" onSubmit={create}>
        <fieldset disabled={creating}>
          <legend>New schedule</legend>
          <label>
            Owner agent{' '}
            <input
              required
              value={form.ownerAgentLabel}
              onChange={(event) => setForm({ ...form, ownerAgentLabel: event.target.value })}
              placeholder="cursor"
            />
          </label>
          <label>
            To agent (optional){' '}
            <input
              value={form.toAgentLabel}
              onChange={(event) => setForm({ ...form, toAgentLabel: event.target.value })}
              placeholder="claude"
            />
          </label>
          <label>
            Message skeleton{' '}
            <textarea
              required
              maxLength={2000}
              rows={3}
              value={form.messageTemplate}
              onChange={(event) => setForm({ ...form, messageTemplate: event.target.value })}
              placeholder="Review the latest draft and report blockers."
            />
          </label>
          <label>
            Dedupe key{' '}
            <input
              required
              maxLength={AGENT_SCHEDULE_LIMITS.dedupeKey}
              value={form.dedupeKey}
              onChange={(event) => setForm({ ...form, dedupeKey: event.target.value })}
              placeholder="weekly-review"
            />
          </label>
          <label>
            First / next run{' '}
            <input
              required
              type="datetime-local"
              value={form.nextRunAt}
              onChange={(event) => setForm({ ...form, nextRunAt: event.target.value })}
            />
          </label>
          <label>
            Cron expression (optional, UTC){' '}
            <input
              maxLength={AGENT_SCHEDULE_LIMITS.cronExpression}
              value={form.cronExpression}
              onChange={(event) => setForm({ ...form, cronExpression: event.target.value })}
              placeholder="0 9 * * 1"
            />
          </label>
          <label>
            Subject type{' '}
            <select
              value={form.subjectType}
              onChange={(event) =>
                setForm({ ...form, subjectType: event.target.value as AgentHandoffSubjectType })
              }
            >
              {AGENT_HANDOFF_SUBJECT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          {form.subjectType !== 'freeform' && (
            <label>
              Subject id{' '}
              <input
                required
                value={form.subjectId}
                onChange={(event) => setForm({ ...form, subjectId: event.target.value })}
              />
            </label>
          )}
          <label>
            Failure policy{' '}
            <select
              value={form.failurePolicy}
              onChange={(event) =>
                setForm({ ...form, failurePolicy: event.target.value as typeof form.failurePolicy })
              }
            >
              {AGENT_SCHEDULE_FAILURE_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {policy}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="primary-btn">
            {creating ? 'Creating…' : 'Create schedule'}
          </button>
        </fieldset>
      </form>
      <button
        type="button"
        className="secondary"
        onClick={() => void runDue()}
        disabled={busy !== null}
      >
        <RefreshCw /> {busy === 'due' ? 'Running due schedules…' : 'Run due schedules'}
      </button>
    </section>
  );
}
