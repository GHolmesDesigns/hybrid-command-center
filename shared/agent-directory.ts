import { z } from 'zod';

/** Maximum length for the operator-maintained descriptive charter on an agent profile. */
export const AGENT_PROFILE_CHARTER_MAX = 4_000;

export const updateAgentCharterSchema = z
  .object({
    charter: z
      .union([z.string().trim().max(AGENT_PROFILE_CHARTER_MAX), z.null()])
      .transform((value) => (value === null || value === '' ? null : value)),
  })
  .strict();

export type UpdateAgentCharter = z.infer<typeof updateAgentCharterSchema>;
