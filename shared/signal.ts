/**
 * Signal Campaign: the scheduled-content vocabulary the API, the planner, and the calendar
 * all read.
 *
 * Signal is the authoritative scheduler (decision §5.7). It used to live outside this app as a
 * browser-only page with no interface to read, which is why nothing could consume its schedule;
 * it now lives here as its own module, and this file is the vocabulary that module speaks.
 * Nothing here has a database or an HTTP request in it.
 *
 * ## Dates and times
 *
 * A post carries a `date` and a `time` and never an instant. `date` is a `YYYY-MM-DD` value
 * interpreted in local time, exactly as task due dates are (`AGENTS.md`); `time` is an `HH:MM`
 * label shown beside the post. `createdAt` and `updatedAt` are UTC ISO strings, as everywhere
 * else in this app.
 *
 * **The cell rule: a post belongs to the calendar cell whose local date equals its `date`
 * string.** That is the whole rule. No instant is ever derived from the `date`/`time` pair, so
 * there is no zone conversion to disagree about and nothing shifts a day when the clock changes.
 * A post scheduled for the 14th is on the 14th in every view.
 *
 * A null `date` means the post is not scheduled at all. Those are the queue, ordered by
 * `position`, and they deliberately appear nowhere on a calendar — there is no cell to put them
 * in, and inventing one would make an unscheduled idea look scheduled.
 */

/** The channels a post can go out on. Fixed vocabulary, not user-managed. */
export const SIGNAL_CHANNELS = ['blog', 'ig', 'x', 'bsky', 'li', 'fb', 'tt', 'yt'] as const;
export type SignalChannel = (typeof SIGNAL_CHANNELS)[number];

export const SIGNAL_CHANNEL_LABEL: Record<SignalChannel, string> = {
  blog: 'Blog',
  ig: 'Instagram',
  x: 'X',
  bsky: 'Bluesky',
  li: 'LinkedIn',
  fb: 'Facebook',
  tt: 'TikTok',
  yt: 'YouTube',
};

/**
 * A short initial for a channel, for use *beside* a colour swatch and never instead of one, so
 * a channel is never carried by colour alone.
 */
export const SIGNAL_CHANNEL_INITIAL: Record<SignalChannel, string> = {
  blog: 'Bl',
  ig: 'IG',
  x: 'X',
  bsky: 'BS',
  li: 'in',
  fb: 'f',
  tt: 'TT',
  yt: 'YT',
};

/** What a post is, as a piece of work to produce. */
export const SIGNAL_FORMATS = [
  'BLOG_POST',
  'WHITEBOARD_VIDEO',
  'INFOGRAPHIC',
  'VIDEO',
  'IMAGE',
  'CAROUSEL',
  'REEL',
  'ARTICLE',
  'QUOTE_CARD',
  'TEXT',
  'STORY',
] as const;
export type SignalFormat = (typeof SIGNAL_FORMATS)[number];

export const SIGNAL_FORMAT_LABEL: Record<SignalFormat, string> = {
  BLOG_POST: 'Blog post',
  WHITEBOARD_VIDEO: 'Whiteboard video',
  INFOGRAPHIC: 'Infographic',
  VIDEO: 'Video',
  IMAGE: 'Image',
  CAROUSEL: 'Carousel',
  REEL: 'Reel / Short',
  ARTICLE: 'Article',
  QUOTE_CARD: 'Quote card',
  TEXT: 'Text',
  STORY: 'Story',
};

/**
 * How far along a post is.
 *
 * These describe the post's own progress and nothing about a publishing integration: `PUBLISHED`
 * is the user saying it went out, not this app having sent it anywhere. Nothing in this app
 * publishes (C19b).
 */
export const SIGNAL_STATUSES = ['DRAFT', 'SCHEDULED', 'PUBLISHED'] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

export const SIGNAL_STATUS_LABEL: Record<SignalStatus, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  PUBLISHED: 'Published',
};

/** What the post asks the reader to do. */
export const SIGNAL_CTAS = ['NONE', 'SOFT', 'CONVERSION'] as const;
export type SignalCta = (typeof SIGNAL_CTAS)[number];

export const SIGNAL_CTA_LABEL: Record<SignalCta, string> = {
  NONE: 'No ask',
  SOFT: 'Soft ask',
  CONVERSION: 'Conversion',
};

/** One planned piece of content. */
export interface SignalPost {
  id: string;
  /** What is being posted. The copy itself, not a title. */
  text: string;
  channels: SignalChannel[];
  /** `YYYY-MM-DD` in local time, or null when the post is in the unscheduled queue. */
  date: string | null;
  /** `HH:MM`, a label rather than an instant. Carried even by unscheduled posts. */
  time: string;
  format: SignalFormat;
  status: SignalStatus;
  /** Free text naming the campaign and week this belongs to. Null when it stands alone. */
  campaign: string | null;
  cta: SignalCta;
  /** Order within the unscheduled queue. Meaningless once the post has a date. */
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** The default time a post takes when one is not given. */
export const SIGNAL_DEFAULT_TIME = '09:00';

/** How many posts one range request may return. */
export const SIGNAL_RANGE_LIMIT = 500;

/** `YYYY-MM-DD`. Deliberately strict: this value is compared as a string, never parsed. */
export const SIGNAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `HH:MM`, 24-hour. */
export const SIGNAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Whether a post falls in a range, by the cell rule above: a plain string comparison on
 * `YYYY-MM-DD`, which orders lexicographically and chronologically at once. `from` and `to` are
 * both inclusive, so a month is its own first and last day and a single day is `from === to`.
 *
 * Unscheduled posts are in no range. That is the point of them.
 */
export const isSignalPostInRange = (
  post: Pick<SignalPost, 'date'>,
  from: string,
  to: string,
): boolean => post.date !== null && post.date >= from && post.date <= to;

const isLeapYear = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * How many days a month has, by the calendar's own rules.
 *
 * Deliberately arithmetic rather than `new Date(...)`: `Date.UTC` maps a year below 100 into the
 * 1900s, so year 1 silently becomes 1901 and every length it reports for such a year is a
 * different year's. Nothing here builds a moment, which is the same discipline the cell rule
 * keeps — a calendar boundary is a number, not an instant.
 *
 * `month` is 1-based. Returns 0 for a month outside 1–12, which is not a length any day can
 * satisfy, so an out-of-range month fails the same check an out-of-range day does.
 */
export function signalDaysInMonth(year: number, month: number): number {
  if (!Number.isInteger(month) || month < 1 || month > 12) return 0;
  if (month === 2 && isLeapYear(year)) return 29;
  return MONTH_LENGTHS[month - 1] as number;
}

/** Whether a `YYYY-MM-DD` string names a day that exists. Rejects `2026-02-31` and `2026-13-01`. */
export function isSignalDate(value: string): boolean {
  if (!SIGNAL_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return day >= 1 && day <= signalDaysInMonth(year, month);
}

/** The first and last day of the month a `YYYY-MM-DD` falls in, as the same kind of string. */
export function signalMonthBounds(date: string): { from: string; to: string } {
  const [year, month] = date.split('-').map(Number) as [number, number];
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = (day: number) => `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
  return { from: stamp(1), to: stamp(signalDaysInMonth(year, month)) };
}
