import { z } from 'zod';

export const APP_HEALTH_STATES = ['healthy', 'degraded', 'unavailable'] as const;
export type AppHealthState = (typeof APP_HEALTH_STATES)[number];

export const appHealthSignalSchema = z.object({
  state: z.enum(APP_HEALTH_STATES),
  label: z.string(),
  detail: z.string(),
  checkedAt: z.string().nullable(),
  freshness: z.string(),
});

export const appHealthResponseSchema = z.object({
  generatedAt: z.string(),
  overall: z.enum(APP_HEALTH_STATES),
  signals: z.object({
    process: appHealthSignalSchema,
    database: appHealthSignalSchema,
    agentActivity: appHealthSignalSchema,
    remoteAgents: appHealthSignalSchema,
  }),
});

export type AppHealthResponse = z.infer<typeof appHealthResponseSchema>;
