/**
 * Zod schemas for workspace project/task/settings writes shared by HTTP and MCP (C130).
 */
import { isValid, parseISO } from 'date-fns';
import { z } from 'zod';
import {
  APP_VERSION,
  brandingIssues,
  DEFAULT_BRANDING,
  LOGO_URL_MAX,
  type Branding,
} from '../../shared/branding.ts';
import { normalizeHex } from '../../shared/contrast.ts';
import { TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES } from '../../shared/types.ts';
import { viewDefaultsIssues, type ViewDefaults } from '../../shared/view-defaults.ts';
import { clientBrandingIssues } from '../../shared/branding.ts';

export { APP_VERSION };

/** Optional text: omitted keeps stored value on PATCH; empty string clears to null. */
const nullable = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const trimmed = v.trim();
    return trimmed || null;
  });
const nullableDate = z
  .union([
    z.literal(''),
    z.null(),
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD format')
      .refine((v) => isValid(parseISO(v)), 'Not a real calendar date'),
  ])
  .optional()
  .transform((v) => (v === undefined ? undefined : v || null));
const nullableTaskType = z
  .union([z.literal(''), z.null(), z.enum(TASK_TYPES)])
  .optional()
  .transform((v) => (v === undefined ? undefined : v || null));

export const PROJECT_STATUSES = ['PLANNING', 'BUILDING', 'ACTIVE', 'ON_HOLD', 'COMPLETE'] as const;

const nullableText = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined || value === null) return value;
    return value.trim() || null;
  });
const nullableEmail = z
  .union([z.literal(''), z.string().email(), z.null()])
  .optional()
  .transform((value) => (value === undefined ? undefined : value || null));
const nullableUrl = z
  .union([z.literal(''), z.string().url(), z.null()])
  .optional()
  .transform((value) => (value === undefined ? undefined : value || null));
const nullableBranding = z
  .union([z.string().trim().max(500), z.null()])
  .optional()
  .transform((value) => (value === undefined || value === null ? value : value || null));

export const clientFields = {
  name: z.string().trim().min(2).max(120),
  contactName: nullableText,
  email: nullableEmail,
  phone: nullableText,
  website: nullableUrl,
  notes: nullableText,
  brandingLogoUrl: nullableBranding,
  brandingColorOne: nullableBranding,
  brandingColorTwo: nullableBranding,
};
const validateClientBranding = (
  data: {
    brandingLogoUrl?: string | null;
    brandingColorOne?: string | null;
    brandingColorTwo?: string | null;
  },
  ctx: z.RefinementCtx,
) => {
  for (const issue of clientBrandingIssues({
    logoUrl: data.brandingLogoUrl ?? '',
    colorOne: data.brandingColorOne ?? '',
    colorTwo: data.brandingColorTwo ?? '',
  }))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.field], message: issue.message });
};
export const clientInput = z.object(clientFields).superRefine(validateClientBranding);
export const clientPatch = z.object(clientFields).partial();
export const clientEditableInput = z.object({
  name: clientFields.name,
  contactName: clientFields.contactName,
  email: clientFields.email,
  phone: clientFields.phone,
  website: clientFields.website,
  notes: clientFields.notes,
});
const CLIENT_EDITABLE_FIELDS = [
  'name',
  'contactName',
  'email',
  'phone',
  'website',
  'notes',
] as const;
export const clientEditablePatch = clientEditableInput
  .partial()
  .refine((value) => CLIENT_EDITABLE_FIELDS.some((field) => value[field] !== undefined), {
    message: 'Provide at least one client field to update.',
  });
export const clientBrandingInput = z
  .object({
    brandingLogoUrl: nullableBranding,
    brandingColorOne: nullableBranding,
    brandingColorTwo: nullableBranding,
  })
  .superRefine(validateClientBranding);

const projectFields = {
  clientId: z.string().uuid(),
  name: z.string().trim().min(2).max(160),
  description: nullable,
  startDate: nullableDate,
  launchDate: nullableDate,
  targetDeadline: nullableDate,
  notes: nullable,
};
export const projectInput = z.object({
  ...projectFields,
  status: z.enum(PROJECT_STATUSES).default('ACTIVE'),
  priority: z.enum(TASK_PRIORITIES).default('MEDIUM'),
});
export const projectPatch = z
  .object({
    ...projectFields,
    status: z.enum(PROJECT_STATUSES),
    priority: z.enum(TASK_PRIORITIES),
  })
  .partial();

const taskFields = {
  projectId: z.string().uuid(),
  title: z.string().trim().min(2).max(200),
  description: nullable,
  taskType: nullableTaskType,
  dueDate: nullableDate,
  startDate: nullableDate,
  notes: nullable,
};
export const taskInput = z.object({
  ...taskFields,
  status: z.enum(TASK_STATUSES).default('BACKLOG'),
  priority: z.enum(TASK_PRIORITIES).default('MEDIUM'),
});
export const taskPatch = z
  .object({
    ...taskFields,
    status: z.enum(TASK_STATUSES),
    priority: z.enum(TASK_PRIORITIES),
  })
  .partial();
export const taskUpdateInput = taskPatch.extend({
  overrideBlocked: z.boolean().optional(),
});

export const checklistAddInput = z.object({
  text: z.string().trim().min(1).max(300),
});
export const checklistUpdateInput = z.object({
  text: z.string().trim().min(1).optional(),
  completed: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});
export const dependencyAddInput = z.object({
  dependencyId: z.string().uuid(),
});

const hexColor = (fallback: string) =>
  z
    .string()
    .trim()
    .default(fallback)
    .transform((value) => normalizeHex(value) ?? value)
    .pipe(z.string().regex(/^#[0-9a-f]{6}$/, 'Expected a hex colour such as #18201d'));

export const brandingInput = z
  .object({
    mark: z.string().trim().min(1).max(4),
    title: z.string().trim().min(1).max(40),
    subtitle: z.string().trim().min(1).max(60),
    tagline: z.string().trim().min(1).max(80),
    background: hexColor(DEFAULT_BRANDING.background),
    foreground: hexColor(DEFAULT_BRANDING.foreground),
    accent: hexColor(DEFAULT_BRANDING.accent),
    logoUrl: z.string().trim().max(LOGO_URL_MAX).default(''),
    logoAlt: z.string().trim().max(120).default(''),
  })
  .transform((branding) => ({ ...branding, logoAlt: branding.logoUrl ? branding.logoAlt : '' }))
  .superRefine((branding, ctx) => {
    for (const issue of brandingIssues(branding))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.field], message: issue.message });
  });

export const viewDefaultsInput = z
  .unknown()
  .superRefine((value, ctx) => {
    for (const issue of viewDefaultsIssues(value))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: issue.path ? issue.path.split('.') : [],
        message: issue.message,
      });
  })
  .transform((value) => value as ViewDefaults);

export type ProjectInput = z.infer<typeof projectInput>;
export type ProjectPatch = z.infer<typeof projectPatch>;
export type TaskInput = z.infer<typeof taskInput>;
export type TaskPatch = z.infer<typeof taskUpdateInput>;
export type BrandingInput = z.infer<typeof brandingInput>;
export type { Branding, ViewDefaults };
