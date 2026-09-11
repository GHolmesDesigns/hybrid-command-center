import { parseProviderAgentCostList, type ProviderAgentCostList } from '../../shared/agent-cost.ts';
import type { AgentCostProvider } from './cost-provider.ts';

export interface CursorCostClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Cursor admin usage reader (C217 scaffold).
 *
 * The wire shape is documented here and validated with Zod before any row is stored. Live evidence
 * belongs in the owner-run `npm run probe:agent-cost -- --live` transcript — never CI.
 */
export class CursorCostProvider implements AgentCostProvider {
  readonly available: boolean;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly transport: typeof globalThis.fetch;

  constructor(options: CursorCostClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.cursor.com').replace(/\/$/, '');
    this.transport = options.fetch ?? globalThis.fetch;
    this.available = Boolean(this.apiKey);
  }

  async list(): Promise<ProviderAgentCostList> {
    if (!this.available) throw new Error('Agent cost needs CURSOR_ADMIN_API_KEY.');
    const response = await this.transport(`${this.baseUrl}/teams/v1/usage`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      throw new Error(
        `Cursor usage request failed (${response.status})${detail ? `: ${detail}` : ''}.`,
      );
    }
    const body: unknown = await response.json();
    return parseProviderAgentCostList(normalizeCursorUsage(body));
  }
}

/** Map the documented Cursor usage envelope into this app's validated list shape. */
export function normalizeCursorUsage(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const root = body as Record<string, unknown>;
  const rows = Array.isArray(root.usage)
    ? root.usage
    : Array.isArray(root.records)
      ? root.records
      : Array.isArray(root.data)
        ? root.data
        : null;
  if (!rows) return body;
  return {
    records: rows.map((row) => {
      if (!row || typeof row !== 'object') return row;
      const item = row as Record<string, unknown>;
      return {
        provider: 'cursor',
        model: item.model ?? item.model_name ?? 'unknown',
        quantity: item.quantity ?? item.token_count ?? item.amount,
        unit: item.unit ?? (item.currency ? 'usd' : 'tokens'),
        currency: item.currency ?? 'USD',
        windowStart: item.window_start ?? item.windowStart ?? item.period_start,
        windowEnd: item.window_end ?? item.windowEnd ?? item.period_end,
        ...(typeof item.attribution_confidence === 'string'
          ? { attributionConfidence: item.attribution_confidence }
          : typeof item.attributionConfidence === 'string'
            ? { attributionConfidence: item.attributionConfidence }
            : {}),
        ...(typeof item.agent_label === 'string'
          ? { agentLabel: item.agent_label }
          : typeof item.agentLabel === 'string'
            ? { agentLabel: item.agentLabel }
            : {}),
      };
    }),
    warnings: [],
  };
}
