import crypto from 'node:crypto';
import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { getSetting, setSetting } from '../drive/service.ts';
import { recordIntegrationEvent, redactSecrets } from '../integration-log.ts';
import {
  AGENT_COST_SNAPSHOT_RETENTION,
  type AgentCostSnapshot,
  type AgentCostSummary,
  parseProviderAgentCostList,
  type ProviderAgentCostRecord,
} from '../../shared/agent-cost.ts';
import type { AgentCostProvider } from './cost-provider.ts';

export const AGENT_COST_SYNC_KEY = 'agent_cost_sync';

interface StoredAgentCostRecord {
  lastRefreshAt?: string;
  reason?: string;
}

interface SnapshotRow {
  id: string;
  provider: string;
  model: string;
  quantity: number;
  unit: string;
  currency: string;
  window_start: string;
  window_end: string;
  attribution_confidence: string | null;
  agent_label: string | null;
  snapshot_at: string;
  refresh_id: string;
}

export function readAgentCostSync(db: Db): StoredAgentCostRecord {
  const raw = getSetting(db, AGENT_COST_SYNC_KEY);
  if (!raw) return {};
  try {
    const stored = JSON.parse(raw) as StoredAgentCostRecord;
    return {
      ...(typeof stored.lastRefreshAt === 'string' ? { lastRefreshAt: stored.lastRefreshAt } : {}),
      ...(typeof stored.reason === 'string' ? { reason: stored.reason } : {}),
    };
  } catch {
    return {};
  }
}

const writeAgentCostSync = (db: Db, record: StoredAgentCostRecord): void => {
  setSetting(
    db,
    AGENT_COST_SYNC_KEY,
    JSON.stringify({
      ...(record.lastRefreshAt ? { lastRefreshAt: record.lastRefreshAt } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
    }),
  );
};

const toSnapshot = (row: SnapshotRow): AgentCostSnapshot => ({
  id: row.id,
  provider: row.provider,
  model: row.model,
  quantity: row.quantity,
  unit: row.unit as AgentCostSnapshot['unit'],
  currency: row.currency,
  windowStart: row.window_start,
  windowEnd: row.window_end,
  ...(row.attribution_confidence ? { attributionConfidence: row.attribution_confidence } : {}),
  ...(row.agent_label ? { agentLabel: row.agent_label } : {}),
  snapshotAt: row.snapshot_at,
  refreshId: row.refresh_id,
});

const agentKey = (label: string | null | undefined) => label ?? '';

/** Latest snapshot per agent label, including one row for unassigned usage. */
export const latestAgentCostSnapshots = (rows: SnapshotRow[]): AgentCostSnapshot[] => {
  const latest = new Map<string, SnapshotRow>();
  for (const row of rows) {
    const key = agentKey(row.agent_label);
    const current = latest.get(key);
    if (!current || row.snapshot_at > current.snapshot_at) latest.set(key, row);
  }
  return [...latest.values()].map(toSnapshot).sort((left, right) =>
    (left.agentLabel ?? '').localeCompare(right.agentLabel ?? '', undefined, {
      sensitivity: 'base',
    }),
  );
};

export const readAgentCostSnapshots = (db: Db): SnapshotRow[] =>
  db
    .prepare(
      `SELECT id, provider, model, quantity, unit, currency, window_start, window_end,
              attribution_confidence, agent_label, snapshot_at, refresh_id
         FROM agent_cost_snapshots
        ORDER BY snapshot_at DESC, id`,
    )
    .all() as unknown as SnapshotRow[];

const pruneAgentCostSnapshots = (db: Db): void => {
  db.prepare(
    `DELETE FROM agent_cost_snapshots
      WHERE id NOT IN (
        SELECT id FROM agent_cost_snapshots
         ORDER BY snapshot_at DESC, id
         LIMIT ?
      )`,
  ).run(AGENT_COST_SNAPSHOT_RETENTION);
};

export class AgentCostService {
  private readonly db: Db;
  private readonly provider: AgentCostProvider;
  private readonly clock: () => Date;

  constructor(db: Db, provider: AgentCostProvider, clock: () => Date = () => new Date()) {
    this.db = db;
    this.provider = provider;
    this.clock = clock;
  }

  /** Stored snapshots only — no provider call on any path through this method. */
  read(): AgentCostSummary {
    const record = readAgentCostSync(this.db);
    return {
      available: this.provider.available,
      snapshots: latestAgentCostSnapshots(readAgentCostSnapshots(this.db)),
      ...(record.lastRefreshAt ? { lastRefreshAt: record.lastRefreshAt } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
    };
  }

  /**
   * One person-pressed refresh: read the provider, validate every row, append snapshots, or leave
   * prior rows untouched when the read fails.
   */
  async refresh(): Promise<AgentCostSummary> {
    const stored = this.read();
    if (!this.provider.available)
      return {
        ...stored,
        reason: 'Agent cost needs CURSOR_ADMIN_API_KEY.',
      };

    let listed;
    try {
      listed = await this.provider.list();
      listed = parseProviderAgentCostList(listed);
    } catch (error) {
      return this.failed(stored, error as Error);
    }
    if (!listed.records.length) {
      const reason = 'The provider returned no usage rows, so nothing was stored.';
      writeAgentCostSync(this.db, {
        ...(stored.lastRefreshAt ? { lastRefreshAt: stored.lastRefreshAt } : {}),
        reason,
      });
      return { ...stored, reason };
    }
    return this.store(listed.records, listed.warnings);
  }

  private store(records: ProviderAgentCostRecord[], warnings: string[]): AgentCostSummary {
    const snapshotAt = this.clock().toISOString();
    const refreshId = crypto.randomUUID();
    transaction(this.db, () => {
      const insert = this.db.prepare(
        `INSERT INTO agent_cost_snapshots(
           id, provider, model, quantity, unit, currency, window_start, window_end,
           attribution_confidence, agent_label, snapshot_at, refresh_id
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const record of records) {
        insert.run(
          crypto.randomUUID(),
          record.provider,
          record.model,
          record.quantity,
          record.unit,
          record.currency,
          record.windowStart,
          record.windowEnd,
          record.attributionConfidence ?? null,
          record.agentLabel ?? null,
          snapshotAt,
          refreshId,
        );
      }
      pruneAgentCostSnapshots(this.db);
      writeAgentCostSync(this.db, { lastRefreshAt: snapshotAt });
      recordIntegrationEvent(this.db, {
        source: 'agent-hub',
        operation: 'agent.cost-refresh',
        outcome: 'SUCCESS',
        summary: [
          `Stored ${records.length} provider-reported usage ${records.length === 1 ? 'snapshot' : 'snapshots'}.`,
          ...warnings,
        ].join(' '),
      });
    });
    return this.read();
  }

  private failed(stored: AgentCostSummary, error: Error): AgentCostSummary {
    const message = redactSecrets(error.message);
    const reason = `The provider could not be read, so the snapshots below are the last ones it gave: ${message}`;
    transaction(this.db, () => {
      writeAgentCostSync(this.db, {
        ...(stored.lastRefreshAt ? { lastRefreshAt: stored.lastRefreshAt } : {}),
        reason,
      });
      recordIntegrationEvent(this.db, {
        source: 'agent-hub',
        operation: 'agent.cost-refresh',
        outcome: 'FAILURE',
        summary: 'Agent usage could not be read; no snapshot row was added.',
        error: message,
      });
    });
    return { ...stored, reason };
  }
}
