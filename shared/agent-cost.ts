import { z } from 'zod';

/**
 * Provider-reported agent usage snapshots (C217).
 *
 * Nothing here has a database or a network call in it. Figures are the provider's own — never
 * locally estimated token counts — and attribution confidence describes how the provider matched
 * usage to an agent, not a margin of error on the quantity.
 */

export const AGENT_COST_PROVIDERS = ['cursor'] as const;
export type AgentCostProviderId = (typeof AGENT_COST_PROVIDERS)[number];

export const AGENT_COST_UNITS = ['tokens', 'requests', 'usd'] as const;
export type AgentCostUnit = (typeof AGENT_COST_UNITS)[number];

/** Append-only row retention — oldest rows pruned after each refresh. */
export const AGENT_COST_SNAPSHOT_RETENTION = 500;

const attributionToken = /^[a-z0-9_-]{1,40}$/;

export const providerAgentCostRecordSchema = z.object({
  provider: z.string().min(1).max(40),
  model: z.string().min(1).max(120),
  quantity: z.number().finite().nonnegative(),
  unit: z.enum(AGENT_COST_UNITS),
  currency: z.string().min(1).max(8),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  attributionConfidence: z.string().optional(),
  agentLabel: z.string().min(1).max(64).optional(),
});

export type ProviderAgentCostRecord = z.infer<typeof providerAgentCostRecordSchema>;

export const providerAgentCostListSchema = z.object({
  records: z.array(providerAgentCostRecordSchema),
  warnings: z.array(z.string().max(500)),
});

export type ProviderAgentCostList = z.infer<typeof providerAgentCostListSchema>;

const providerAgentCostListEnvelopeSchema = z.object({
  records: z.array(z.unknown()),
  warnings: z.array(z.string().max(500)).default([]),
});

/** One stored snapshot row as the API and UI read it. */
export interface AgentCostSnapshot {
  id: string;
  provider: string;
  model: string;
  quantity: number;
  unit: AgentCostUnit;
  currency: string;
  windowStart: string;
  windowEnd: string;
  attributionConfidence?: string;
  agentLabel?: string;
  snapshotAt: string;
  refreshId: string;
}

/** The latest snapshot per agent label (including one unassigned bucket). */
export interface AgentCostSummary {
  available: boolean;
  lastRefreshAt?: string;
  reason?: string;
  snapshots: AgentCostSnapshot[];
}

/**
 * Documented attribution values from the Cursor admin usage surface (unverified until the owner
 * probe records live evidence). Same pattern as `ANALYTICS_MATCH_CONFIDENCE_LABEL`: words for
 * known values, the provider's own token for anything else, and nothing defaulted.
 */
export const AGENT_COST_ATTRIBUTION_CONFIDENCES = ['exact', 'estimated'] as const;
export type AgentCostAttributionConfidence = (typeof AGENT_COST_ATTRIBUTION_CONFIDENCES)[number];

export const AGENT_COST_ATTRIBUTION_CONFIDENCE_LABEL: Record<
  AgentCostAttributionConfidence,
  string
> = {
  exact: 'Exact',
  estimated: 'Estimated',
};

export const AGENT_COST_ATTRIBUTION_HEADING = 'Provider attribution';
export const AGENT_COST_ATTRIBUTION_DETAIL =
  'Attribution is how the provider says it matched this usage to an agent. It does not qualify or discount the quantity above — that figure is the provider’s own.';

export const AGENT_COST_PROVIDER_REPORTED =
  'These figures are reported by the provider. This app stores them verbatim and does not estimate token usage locally.';

export interface AgentCostAttributionPhrase {
  known: boolean;
  text: string;
}

export function agentCostAttributionPhrase(value: string): AgentCostAttributionPhrase {
  const label = (AGENT_COST_ATTRIBUTION_CONFIDENCE_LABEL as Record<string, string | undefined>)[
    value
  ];
  return label
    ? { known: true, text: `${AGENT_COST_ATTRIBUTION_HEADING}: ${label}` }
    : { known: false, text: `${AGENT_COST_ATTRIBUTION_HEADING} — Provider value: ${value}` };
}

export const agentCostAttributionStorable = (value: string): boolean =>
  attributionToken.test(value);

/** Parse and normalise one provider record, dropping refused attribution with a warning. */
export function parseProviderAgentCostRecord(raw: unknown): {
  record?: ProviderAgentCostRecord;
  warning?: string;
} {
  const parsed = providerAgentCostRecordSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      warning: issue
        ? `Refused a provider usage row: ${issue.path.join('.') || 'record'} ${issue.message}.`
        : 'Refused a provider usage row that did not pass validation.',
    };
  }
  const record = parsed.data;
  if (record.attributionConfidence && !agentCostAttributionStorable(record.attributionConfidence)) {
    const { attributionConfidence: _dropped, ...rest } = record;
    void _dropped;
    return {
      record: rest,
      warning: `Refused attribution confidence on a ${record.provider} row for ${record.model}: value was not a short lower-case token.`,
    };
  }
  return { record };
}

export function parseProviderAgentCostList(raw: unknown): ProviderAgentCostList {
  const parsed = providerAgentCostListEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Provider usage response did not pass validation.');
  const records: ProviderAgentCostRecord[] = [];
  const warnings = [...parsed.data.warnings];
  for (const row of parsed.data.records) {
    const outcome = parseProviderAgentCostRecord(row);
    if (outcome.record) records.push(outcome.record);
    if (outcome.warning) warnings.push(outcome.warning);
  }
  return { records, warnings };
}
