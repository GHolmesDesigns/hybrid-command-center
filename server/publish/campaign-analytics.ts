import { z } from 'zod';
import type { Db } from '../db.ts';
import {
  SIGNAL_CHANNELS,
  SIGNAL_DATE_PATTERN,
  isSignalDate,
  signalPostName,
  type SignalCampaign,
  type SignalChannel,
} from '../../shared/signal.ts';
import {
  summariseSignalCampaignAnalytics,
  SIGNAL_CAMPAIGN_NONE,
  type SignalCampaignAnalytics,
  type SignalCampaignAnalyticsDelivery,
  type SignalCampaignAnalyticsFilters,
  type SignalCampaignAnalyticsPost,
} from '../../shared/signal-campaign-analytics.ts';
import type { PostMetricDay } from '../../shared/publish-analytics.ts';

/**
 * Figures segmented by Signal campaign: the gather, and nothing else.
 *
 * Beside `analytics.ts` rather than inside it, because the two are different kinds of thing. That
 * service holds an `AnalyticsProvider` and is the one path in this app that reaches Post Bridge;
 * this module holds no provider, makes no network call, and has no statement that writes — it reads
 * the rows that service already stored and hands them to `shared/signal-campaign-analytics.ts`,
 * which draws every conclusion. Adding a provider call here would make opening a campaign view
 * spend a synchronisation, which is exactly what `analytics.ts` is built to prevent.
 *
 * The split is also what keeps the arithmetic reviewable in one place. `AGENTS.md` allows a per-day
 * gain and nothing further without a card deciding what it means; the addition this feature needs is
 * decided, documented, and performed in the shared module, and this file only supplies rows.
 */

/** Reserved by the campaign filter for the posts carrying none. */
const campaignId = z.union([z.literal(SIGNAL_CAMPAIGN_NONE), z.string().uuid()]);

const date = z
  .string()
  .regex(SIGNAL_DATE_PATTERN, 'Use a YYYY-MM-DD date.')
  .refine(isSignalDate, 'That date does not exist.');

/**
 * A provider account id, as the address spells one.
 *
 * Parsed from digits rather than coerced: `z.coerce.number()` would take `true` and an empty string
 * as numbers, and this value is compared against `signal_publication_targets.provider_account_id`,
 * where a silent `0` would filter to nothing and look like an empty workspace.
 */
const accountId = z
  .string()
  .regex(/^\d+$/, 'A provider account id is a positive whole number.')
  .transform(Number)
  .pipe(z.number().int().positive());

/**
 * A comma-separated list, as the address carries one.
 *
 * The same form the Projects view's `categories` parameter uses, and read the same way: an empty
 * parameter is no restriction rather than an empty set, so `?campaigns=` behaves exactly as leaving
 * it out does. An unparseable member fails the request rather than being dropped — a filter that
 * silently ignored half of what it was given would answer a question nobody asked.
 */
const commaList = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );

export const signalCampaignAnalyticsQuery = z
  .object({
    campaigns: commaList.pipe(z.array(campaignId)),
    channels: commaList.pipe(z.array(z.enum(SIGNAL_CHANNELS))),
    accounts: commaList.pipe(z.array(accountId)),
    from: date.optional(),
    to: date.optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'The range ends before it starts.',
    path: ['to'],
  });

export type SignalCampaignAnalyticsQuery = z.output<typeof signalCampaignAnalyticsQuery>;

const filtersFrom = (query: SignalCampaignAnalyticsQuery): SignalCampaignAnalyticsFilters => ({
  campaignIds: query.campaigns,
  channels: query.channels,
  accountIds: query.accounts,
  from: query.from ?? null,
  to: query.to ?? null,
});

interface PostRow {
  id: string;
  text: string;
  date: string | null;
}

interface CampaignJoinRow {
  post_id: string;
  id: string;
  name: string;
  color: string | null;
}

interface DeliveryRow {
  post_id: string;
  publication_id: string;
  provider_account_id: number;
  channel: string;
  handle: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  /** NULL where no reading is stored, which is what tells an absent figure from a zero one. */
  synced_at: string | null;
}

interface DayRow {
  publication_id: string;
  provider_account_id: number;
  date: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
}

const keyOf = (publicationId: string, accountId: number) => `${publicationId}:${accountId}`;

/**
 * Every post, every delivery on one, and whatever figures are stored against it.
 *
 * Four statements over the whole workspace rather than a filtered query, because the shared module
 * needs the unfiltered delivery set anyway: the channel and account controls offer what this
 * workspace has ever delivered to, and narrowing the SQL would make choosing a channel remove the
 * others from the control that chose it. Signal is one person's planner, so this is a few hundred
 * rows; if it ever is not, the filter belongs in the SQL and the offered lists in a second query.
 *
 * `LEFT JOIN` on the metrics is what keeps the difference between *unmeasured* and *zero* intact all
 * the way from the table to the panel: a delivery with no row gets no `totals` field, and a total is
 * therefore never rendered as a count of nothing.
 */
export function readSignalCampaignAnalytics(
  db: Db,
  query: SignalCampaignAnalyticsQuery,
): SignalCampaignAnalytics {
  const posts = db
    .prepare('SELECT id, text, date FROM signal_posts ORDER BY date IS NULL, date, time, id')
    .all() as unknown as PostRow[];
  const campaignRows = db
    .prepare(
      `SELECT pc.post_id, c.id, c.name, c.color
         FROM signal_post_campaigns pc
         JOIN signal_campaigns c ON c.id = pc.campaign_id
        ORDER BY c.name COLLATE NOCASE, c.id`,
    )
    .all() as unknown as CampaignJoinRow[];
  const deliveryRows = db
    .prepare(
      `SELECT p.post_id, t.publication_id, t.provider_account_id, t.channel, t.handle,
              m.views, m.likes, m.comments, m.shares, m.synced_at
         FROM signal_publication_targets t
         JOIN signal_publications p ON p.id = t.publication_id
         LEFT JOIN signal_post_metrics m
                ON m.publication_id = t.publication_id
               AND m.provider_account_id = t.provider_account_id
        ORDER BY p.created_at, p.id, t.rowid`,
    )
    .all() as unknown as DeliveryRow[];
  const dayRows = db
    .prepare(
      `SELECT publication_id, provider_account_id, date, views, likes, comments, shares
         FROM signal_post_metric_days ORDER BY date`,
    )
    .all() as unknown as DayRow[];

  const campaignsByPost = new Map<string, SignalCampaign[]>();
  const campaigns = new Map<string, SignalCampaign>();
  for (const row of campaignRows) {
    const campaign: SignalCampaign = {
      id: row.id,
      name: row.name,
      ...(row.color ? { color: row.color } : {}),
    };
    campaigns.set(row.id, campaign);
    campaignsByPost.set(row.post_id, [...(campaignsByPost.get(row.post_id) ?? []), campaign]);
  }
  // A campaign with no posts at all is still in the workspace's list, so the filter can name it.
  for (const row of db
    .prepare('SELECT id, name, color FROM signal_campaigns')
    .all() as unknown as Omit<CampaignJoinRow, 'post_id'>[])
    if (!campaigns.has(row.id))
      campaigns.set(row.id, {
        id: row.id,
        name: row.name,
        ...(row.color ? { color: row.color } : {}),
      });

  const daysByDelivery = new Map<string, PostMetricDay[]>();
  for (const row of dayRows) {
    const key = keyOf(row.publication_id, row.provider_account_id);
    daysByDelivery.set(key, [
      ...(daysByDelivery.get(key) ?? []),
      {
        date: row.date,
        views: row.views,
        likes: row.likes,
        comments: row.comments,
        shares: row.shares,
      },
    ]);
  }

  const inputPosts: SignalCampaignAnalyticsPost[] = posts.map((post) => ({
    id: post.id,
    // The post's own first line, through the one function that names a post anywhere in this app.
    name: signalPostName(post.text),
    date: post.date,
    campaigns: campaignsByPost.get(post.id) ?? [],
  }));
  const deliveries: SignalCampaignAnalyticsDelivery[] = deliveryRows.map((row) => {
    const key = keyOf(row.publication_id, row.provider_account_id);
    return {
      postId: row.post_id,
      publicationId: row.publication_id,
      accountId: row.provider_account_id,
      channel: row.channel as SignalChannel,
      handle: row.handle,
      // Stored only where the metrics row exists. `synced_at` is the row's own NOT NULL column, so
      // it is the honest test for *is there a reading* — a views count of zero is a reading.
      ...(row.synced_at
        ? {
            totals: {
              views: row.views ?? 0,
              likes: row.likes ?? 0,
              comments: row.comments ?? 0,
              shares: row.shares ?? 0,
            },
          }
        : {}),
      days: daysByDelivery.get(key) ?? [],
    };
  });

  return summariseSignalCampaignAnalytics(
    { posts: inputPosts, deliveries, campaigns: [...campaigns.values()] },
    filtersFrom(query),
  );
}
