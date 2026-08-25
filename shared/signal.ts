import { mixHex } from './contrast.ts';
import { normalizeTagName, sameTagName } from './types.ts';
import { signalMediaKindForMime, type SignalPostMedia } from './signal-media.ts';

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
 * A scheduling API wants an instant, which is why this file does not hand one out and no caller
 * builds one. `docs/publishing-integration.md` §5 specifies the single outbound conversion a
 * publisher does: one function, in the publishing module rather than here, in a configured
 * zone, producing an argument that is never stored on the post or read back into a view.
 *
 * A null `date` means the post is not scheduled at all. Those are the queue, ordered by
 * `position`, and they deliberately appear nowhere on a calendar — there is no cell to put them
 * in, and inventing one would make an unscheduled idea look scheduled.
 */

/** The channels a post can go out on. Fixed vocabulary, not user-managed. */
export const SIGNAL_CHANNELS = ['blog', 'bsky', 'fb', 'ig', 'li', 'th', 'tt', 'x', 'yt'] as const;
export type SignalChannel = (typeof SIGNAL_CHANNELS)[number];

/** Media kind inferred from a public URL's extension. No network request is made. */
export const SIGNAL_MEDIA_KINDS = ['image', 'video', 'pdf', 'unknown'] as const;
export type SignalMediaKind = (typeof SIGNAL_MEDIA_KINDS)[number];

const SIGNAL_VIDEO_EXTENSION = /\.(mp4|mov|m4v|webm|avi|mkv)$/i;
const SIGNAL_PDF_EXTENSION = /\.pdf$/i;
const SIGNAL_IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;
const SIGNAL_LINK_TLDS = [
  'com',
  'net',
  'org',
  'io',
  'co',
  'ai',
  'app',
  'dev',
  'me',
  'us',
  'uk',
  'ca',
  'au',
  'de',
  'fr',
  'nl',
  'es',
  'it',
  'design',
  'studio',
  'video',
  'agency',
  'xyz',
  'info',
  'biz',
  'tv',
  'fm',
  'link',
  'page',
  'site',
  'online',
  'store',
  'shop',
  'blog',
  'news',
  'media',
  'digital',
  'email',
  'live',
  'life',
  'world',
  'tech',
  'space',
  'cloud',
  'club',
  'art',
  'photo',
  'pics',
  'gallery',
  'film',
  'productions',
  'production',
  'works',
  'group',
  'team',
  'company',
  'solutions',
  'services',
  'consulting',
  'marketing',
  'social',
].join('|');
const SIGNAL_LINK_PATTERN = new RegExp(
  `(?:https?:\\/\\/|www\\.)[^\\s<>()]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${SIGNAL_LINK_TLDS})\\b(?:\\/[^\\s<>()]*)?`,
  'i',
);

/**
 * Whether text carries a link that X will remove from the post body.
 *
 * The TLD anchor is deliberate: it catches bare domains without treating abbreviations and
 * decimals as links. This detects only; callers warn and never rewrite the post.
 */
export const signalTextHasLink = (text: string): boolean => SIGNAL_LINK_PATTERN.test(text);

/**
 * Classifies a media reference from its pathname alone, matching the proven publisher artifact.
 * An extensionless URL is deliberately `unknown`: guessing from a hostname or query string would
 * claim a video exists when the publisher's own preflight cannot know that.
 *
 * This is the rule for a **public URL reference**. A Drive reference is classified from the MIME
 * type Drive reported and this app stored — `signalMediaKindFor` picks between the two, and it is
 * what every caller holding a whole descriptor should use. Passing a Drive row's `url` here would
 * answer `unknown` for every Drive file, because a share link addresses a viewer page.
 */
export function signalMediaKind(url: string): SignalMediaKind {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return 'unknown';
  }
  if (SIGNAL_VIDEO_EXTENSION.test(pathname)) return 'video';
  if (SIGNAL_PDF_EXTENSION.test(pathname)) return 'pdf';
  if (SIGNAL_IMAGE_EXTENSION.test(pathname)) return 'image';
  return 'unknown';
}

/**
 * The kind of one media reference, from whichever evidence its source actually has.
 *
 * A Drive row is classified from the MIME type Drive reported when the reference was resolved,
 * which is why preflight can tell a video from an image **without a Drive call**: the answer was
 * recorded at paste time and is stored on the row. A URL row is classified from its pathname, the
 * rule above and the only one a public URL supports.
 */
export function signalMediaKindFor(
  media: Pick<SignalPostMedia, 'source' | 'url' | 'mimeType'>,
): SignalMediaKind {
  return media.source === 'DRIVE'
    ? signalMediaKindForMime(media.mimeType)
    : signalMediaKind(media.url);
}

export const SIGNAL_CHANNEL_LABEL: Record<SignalChannel, string> = {
  blog: 'Blog',
  bsky: 'Bluesky',
  fb: 'Facebook',
  ig: 'Instagram',
  li: 'LinkedIn',
  th: 'Threads',
  tt: 'TikTok',
  x: 'X',
  yt: 'YouTube',
};

/**
 * A short initial for a channel, for use *beside* a colour swatch and never instead of one, so
 * a channel is never carried by colour alone.
 */
export const SIGNAL_CHANNEL_INITIAL: Record<SignalChannel, string> = {
  blog: 'Bl',
  bsky: 'BS',
  fb: 'f',
  ig: 'IG',
  li: 'in',
  th: 'TH',
  tt: 'TT',
  x: 'X',
  yt: 'YT',
};

/**
 * The colours one channel chip is painted in. Three tokens and no more: what it sits on, the
 * outline that separates it from the page, and the text drawn on it.
 *
 * They live here, beside the label and the initial, because a channel's treatment is part of
 * the vocabulary rather than a detail of whichever view happens to be drawing it — the planner
 * tile, the calendar row, and the editor's channel selector all read this one map, so a chip
 * cannot mean one thing in one place and another somewhere else.
 */
export interface SignalChannelTreatment {
  /** Chip fill. */
  surface: string;
  /** Chip outline, derived below rather than chosen by hand a third time. */
  border: string;
  /** Chip text, and the bar every pair here is measured against. */
  text: string;
}

/**
 * How far the outline is faded from the text toward the fill. Kept the same for every channel
 * so the set reads as one family, and kept this shallow so the outline clears 3:1 against the
 * fill inside it *and* against the paper outside it — `Signal.channels.test.tsx` measures both
 * with `shared/contrast.ts` rather than trusting the number.
 */
const CHANNEL_BORDER_MIX = 0.22;

const treatment = (text: string, surface: string): SignalChannelTreatment => ({
  surface,
  border: mixHex(text, surface, CHANNEL_BORDER_MIX),
  text,
});

/**
 * One treatment per channel. The hues nod to where the post is going without borrowing
 * anything from anyone: these are ordinary colours, and this app ships no logo, no icon, and
 * no externally hosted asset for a channel.
 *
 * Hue is the fast cue and never the only one — `SIGNAL_CHANNEL_INITIAL` rides on top of every
 * chip and `SIGNAL_CHANNEL_LABEL` is what a screen reader is handed, so the nine stay apart
 * in greyscale, with colours turned off, and read aloud.
 */
export const SIGNAL_CHANNEL_TREATMENT: Record<SignalChannel, SignalChannelTreatment> = {
  blog: treatment('#8a5711', '#faead0'),
  bsky: treatment('#1a6a86', '#dbeef5'),
  fb: treatment('#5b479f', '#e9e4f8'),
  ig: treatment('#a3306b', '#fbe3ef'),
  li: treatment('#2f4b93', '#e2e8f8'),
  th: treatment('#4a3560', '#f0eaf8'),
  tt: treatment('#0f6f6c', '#d9eeed'),
  x: treatment('#3b3f52', '#e6e8ef'),
  yt: treatment('#b03a35', '#fbe0dd'),
};

/**
 * What an unrecognised value is painted in: the one neutral in the set, held to the same
 * contrast bar as the nine. A stored channel is validated against `SIGNAL_CHANNELS` before it
 * reaches a view, so this is the treatment nothing should need — which is exactly why it has to
 * be legible rather than absent, since a chip with no colours at all is an invisible chip.
 */
export const SIGNAL_CHANNEL_NEUTRAL: SignalChannelTreatment = treatment('#5f6764', '#eff1ef');

export const isSignalChannel = (value: string): value is SignalChannel =>
  (SIGNAL_CHANNELS as readonly string[]).includes(value);

/**
 * A reusable starting point for channel selection. The stored values deliberately remain strings:
 * a preset can outlive a channel vocabulary change, and resolving it must be able to name a stale
 * identifier instead of silently replacing it with a current channel.
 */
export interface SignalChannelPreset {
  id: string;
  label: string;
  channelIds: readonly string[];
}

/** Local app presets only. They are not provider account groups and never leave the app. */
export const SIGNAL_CHANNEL_PRESETS = [
  { id: 'all', label: 'All channels', channelIds: SIGNAL_CHANNELS },
  { id: 'visual', label: 'Visual social', channelIds: ['ig', 'fb'] },
  { id: 'professional', label: 'Professional', channelIds: ['blog', 'li'] },
  { id: 'short-video', label: 'Short-form video', channelIds: ['ig', 'tt', 'yt'] },
] as const satisfies readonly SignalChannelPreset[];

export interface ResolvedSignalChannelPreset {
  channels: SignalChannel[];
  excludedChannelIds: string[];
}

/** Resolve stored IDs without guessing: missing IDs are returned to the UI for a visible warning. */
export function resolveSignalChannelPreset(
  preset: Pick<SignalChannelPreset, 'channelIds'>,
): ResolvedSignalChannelPreset {
  const channels: SignalChannel[] = [];
  const excludedChannelIds: string[] = [];
  for (const channelId of new Set(preset.channelIds)) {
    if (isSignalChannel(channelId)) channels.push(channelId);
    else excludedChannelIds.push(channelId);
  }
  return { channels, excludedChannelIds };
}

/** Everything a chip needs to draw itself: the words that identify it and the colours on top. */
export interface SignalChannelPresentation extends SignalChannelTreatment {
  /** The channel's full name, for the accessible label. */
  label: string;
  /** The short form the chip shows. */
  initial: string;
}

/**
 * How a channel is presented, for any value at all.
 *
 * An unrecognised one keeps its own text as the label and initial rather than being drawn as a
 * blank or a question mark: a chip reading `MASTODON` beside a neutral swatch says what it is,
 * where a bare grey chip would only say that something is wrong.
 */
export function signalChannelPresentation(value: string): SignalChannelPresentation {
  if (isSignalChannel(value))
    return {
      label: SIGNAL_CHANNEL_LABEL[value],
      initial: SIGNAL_CHANNEL_INITIAL[value],
      ...SIGNAL_CHANNEL_TREATMENT[value],
    };
  const trimmed = value.trim();
  const label = trimmed || 'Unknown channel';
  return { label, initial: label.slice(0, 2).toUpperCase(), ...SIGNAL_CHANNEL_NEUTRAL };
}

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
 * publishes.
 *
 * That meaning is settled rather than provisional. `docs/publishing-integration.md` (C19b) decides
 * that the publisher keeps its delivery state in its own record and never writes this field, so
 * these three values stay three and keep belonging to the user.
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

/**
 * A Signal campaign: the name a run of content belongs to.
 *
 * Buffer calls this concept tags; this repository reserves tags for tasks, so the same idea is
 * modelled here under Signal's own word. It is a label in exactly the sense `Tag` and `Category`
 * are — a shared workspace list, attached through a join, matched case-insensitively — which is why
 * it borrows their spelling rule below rather than inventing a second one.
 *
 * A post can carry several. That is the difference from the single free-text column campaigns
 * replaced: a piece of content belongs to a campaign *and* to the week inside it, and one column
 * could only ever hold whichever of the two happened to be typed.
 */
export interface SignalCampaign {
  id: string;
  name: string;
  color?: string;
}

/**
 * Campaign names follow the one shared rule in `shared/types.ts`, aliased so call sites read in
 * their own terms — the same construction `normalizeCategoryName` uses.
 *
 * Trims the ends, collapses runs of inner whitespace, preserves case for display, and ignores case
 * when comparing. `Clarity Campaign` typed on one post and `clarity campaign` typed on another are
 * one campaign, which is what the `COLLATE NOCASE` uniqueness on `signal_campaigns.name` enforces.
 */
export const normalizeSignalCampaignName = normalizeTagName;
export const sameSignalCampaignName = sameTagName;

/** The longest campaign name the API stores. The same bound tags and categories use. */
export const SIGNAL_CAMPAIGN_NAME_MAX = 60;

/** How many campaigns one post may carry. A plan belongs to a few things, not to a taxonomy. */
export const SIGNAL_POST_CAMPAIGN_MAX = 12;

/** A campaign beside how many posts carry it, which is what the management list shows. */
export interface SignalCampaignSummary extends SignalCampaign {
  postCount: number;
}

/**
 * Campaign order, wherever one is listed: case- and accent-insensitive by name, tie-broken by id
 * so two spellings that compare equal cannot swap places between renders.
 */
export const compareSignalCampaigns = (a: SignalCampaign, b: SignalCampaign) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

/** One planned piece of content. */
export interface SignalPost {
  id: string;
  /** What is being posted. The copy itself, not a title. */
  text: string;
  channels: SignalChannel[];
  /**
   * The ordered media references, each one either a public `https:` URL or a version-bound Drive
   * file (`shared/signal-media.ts`). Signal stores no media files, serves no media bytes, and holds
   * none at rest; a Drive reference is metadata and a version fingerprint, and C75 is the card that
   * streams its bytes straight to the provider during a confirmed submit, persisting nothing.
   */
  media: SignalPostMedia[];
  /**
   * The same references as display addresses, in the same order — **derived from `media`**, never
   * stored beside it.
   *
   * It is still here because it is the vocabulary the per-platform media selection speaks
   * (`signal_post_variants.media_urls` names the post's media by URL) and what every list and
   * preview renders. Read `media` when the answer depends on what a reference *is*: a Drive row's
   * URL is Drive's viewer page, so classifying or fetching from this array would be wrong.
   */
  mediaUrls: string[];
  /** `YYYY-MM-DD` in local time, or null when the post is in the unscheduled queue. */
  date: string | null;
  /** `HH:MM`, a label rather than an instant. Carried even by unscheduled posts. */
  time: string;
  format: SignalFormat;
  status: SignalStatus;
  /**
   * The campaigns this post belongs to, name-ordered. Zero or more, from the shared workspace
   * list, so the same campaign on two posts is the same row and renaming it renames it on both.
   * Always present, and empty for a post that belongs to none — which is **No campaign** wherever
   * campaigns are grouped, rather than a missing value for a reader to guess at.
   */
  campaigns: SignalCampaign[];
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

/**
 * Signal's query-addressable Add Post creation state, per `docs/view-state-convention.md`.
 *
 * `new=1` opens an unscheduled draft; `new=YYYY-MM-DD` opens one dated to that local calendar day.
 * Anything else is ignored so a typo cannot fail the planner.
 */
export function parseSignalCreateParam(
  value: string | null,
): { creating: false } | { creating: true; date: string | null } {
  if (value === null) return { creating: false };
  if (value === '1') return { creating: true, date: null };
  if (isSignalDate(value)) return { creating: true, date: value };
  return { creating: false };
}

/** The first and last day of the month a `YYYY-MM-DD` falls in, as the same kind of string. */
export function signalMonthBounds(date: string): { from: string; to: string } {
  const [year, month] = date.split('-').map(Number) as [number, number];
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = (day: number) => `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
  return { from: stamp(1), to: stamp(signalDaysInMonth(year, month)) };
}

/**
 * A calendar cell and a posting-time label. Not an instant, and not a second schedule: it is
 * one existing `signal_posts` date/time pair, or a candidate for one.
 */
export interface SignalSlot {
  date: string;
  time: string;
}

/** How far "next open slot" will walk before giving up. Two years, leap day included. */
export const SIGNAL_SLOT_SEARCH_DAYS = 731;

const padDatePart = (value: number) => String(value).padStart(2, '0');

const stampDate = (year: number, month: number, day: number): string =>
  `${String(year).padStart(4, '0')}-${padDatePart(month)}-${padDatePart(day)}`;

/**
 * The next calendar day after a `YYYY-MM-DD` label.
 *
 * Arithmetic rather than `Date`: the same year-below-100 trap `signalDaysInMonth` already
 * refuses, and the same discipline the cell rule keeps — a day is a number, not an instant.
 */
export function signalNextDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  if (day < signalDaysInMonth(year, month)) return stampDate(year, month, day + 1);
  if (month === 12) return stampDate(year + 1, 1, 1);
  return stampDate(year, month + 1, 1);
}

/** Whether two posts would share a planner cell and a time label. */
export const signalSlotOccupied = (occupied: readonly SignalSlot[], slot: SignalSlot): boolean =>
  occupied.some((item) => item.date === slot.date && item.time === slot.time);

/**
 * The next date, at `time`, that no dated Signal post already occupies.
 *
 * `skip` is the post asking for a suggestion, so a scheduled post is never offered its own
 * current cell. Unscheduled posts occupy nothing and start from `fromDate`. Nothing here
 * writes, and nothing here talks to a provider.
 */
export function suggestNextOpenSignalSlot(input: {
  occupied: readonly SignalSlot[];
  time: string;
  fromDate: string;
  skip?: SignalSlot | null;
}): SignalSlot | null {
  let date = input.fromDate;
  for (let step = 0; step < SIGNAL_SLOT_SEARCH_DAYS; step += 1) {
    const slot = { date, time: input.time };
    const isCurrent =
      input.skip != null && input.skip.date === slot.date && input.skip.time === slot.time;
    if (!isCurrent && !signalSlotOccupied(input.occupied, slot)) return slot;
    date = signalNextDate(date);
  }
  return null;
}

const slotDayIndex = (date: string): number => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day) / 86_400_000;
};

const slotMinuteOfDay = (time: string): number => {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  return hour * 60 + minute;
};

/**
 * How many minutes separate two calendar slots, counted as a reader would count them.
 *
 * Label arithmetic, not instant arithmetic. Neither side is turned into a moment: the day part is
 * a Gregorian day number and the time part is a minute of the day, so the answer is the distance
 * between two cells on a wall calendar and it is the same answer in every zone. That is the cell
 * rule above, extended to a difference — the one thing a rule about *approaching* a slot needs and
 * the one thing string comparison cannot give.
 *
 * `Date.UTC` is used purely as a Gregorian surface, the same way `shared/calendar.ts` uses it, and
 * it maps a year below 100 into the 1900s. Both sides go through it, so a difference between two
 * four-digit years is exact; a two-digit year is not a date this app stores.
 *
 * Positive when `to` is later than `from`. A slot already past is negative, which is what lets a
 * caller tell *soon* from *missed* without a second function.
 */
export const signalSlotMinutesBetween = (from: SignalSlot, to: SignalSlot): number =>
  (slotDayIndex(to.date) - slotDayIndex(from.date)) * 1440 +
  slotMinuteOfDay(to.time) -
  slotMinuteOfDay(from.time);

/**
 * Enough of a post to name it in a list, from its first line.
 *
 * Alerts, log summaries, and anything else that has to say *which post* read this rather than
 * slicing the text themselves, so one post is named the same way wherever it is mentioned.
 */
export function signalPostName(text: string, limit = 60): string {
  const line = (text.split('\n')[0] as string).trim();
  if (!line) return 'Untitled post';
  return line.length > limit ? `${line.slice(0, limit).trimEnd()}…` : line;
}
