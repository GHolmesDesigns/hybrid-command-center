# Google Ads Module — Development Plan

**Status** Ready for review. Access and credentials are in place (§8); four scope questions remain
open (§9). No code is written and no card is filed.
**Written** 30 September 2026, against `main` `796b477`, `package.json` 7.0.0
**Convention** `AGENTS.md` — one card per branch, `<type>/<issue>-<slug>`, no pre-assigned
version numbers, one `changes/<issue>.md` fragment per card, `e2e/` spec at least once per
milestone.
**Shape to follow** `docs/post-bridge-integrations-plan.md` (probe first, then thin vertical
cards) and `docs/reports-v1-plan.md` (read-only surfaces, no invented metrics).

Nothing in the repository mentions Google Ads today, so this is a greenfield module. Access and
authentication facts in §8 were checked against Google's documentation and the live consoles on
30 September 2026. The only live account has no delivered campaign data. A1 must distinguish what
Google documents, what a headerless live request actually proves, and what a mock alone exercises;
an empty live response cannot verify populated metrics or settle their storage representation.

---

## 1. Goal and non-goals

**Goal.** Let an operator see, inside Hybrid Command Center, how the Google Ads accounts tied to
their clients are performing, next to the projects, tasks, and Signal schedule those accounts
belong to.

**Non-goals for the first milestone.**

- No writes to Google Ads: no creating or editing campaigns, budgets, bids, keywords, or ads, and
  no pausing or enabling anything. There is no method on the provider that could do it.
- No agent (MCP) access to Ads data. Agents get it later, read-only, under its own card, the way
  coordination shipped before workspace and Signal tools.
- No computed metrics. CTR, CPC, CPA, ROAS and other ratios are not stored or derived here; see §4.
- No conversion-import, audience, or billing features.
- No timer. Data refreshes when a person presses a button.

A write capability, if ever wanted, is a separate decision record and a new module beside the read
half, following the `browse.ts` / `service.ts` split — not a method added to the read provider.

## 2. Why a separate module, not part of Drive or Signal

- **Different OAuth grant.** Drive uses `GOOGLE_CLIENT_ID` / `GOOGLE_TOKEN_ENCRYPTION_KEY`
  (`server/config.ts`). Google Ads needs its own scope. Widening the Drive consent to cover Ads
  would make every Drive reconnect ask for ad-account access. So there are two OAuth clients, two
  connections, and two token rows (§8). Since the developer-token sunset, API access comes from the
  **Google Cloud project that owns the OAuth client**, so the project choice is an access decision
  too.
- **Different vocabulary.** Signal is planned content; Ads is spend and delivery. Per the
  calendar/Signal rule, two kinds stay two kinds — Ads data does not go into `signal_posts`, and
  nothing sorts the two together.
- **Different failure modes.** API quota, the Cloud project's Ads API access level, and account
  permissions are Ads problems and must not be able to degrade Drive or the schedule.

## 3. Proposed architecture

Mirrors how Drive and the publish/analytics code are already split.

```
shared/ads.ts                     types, vocabulary, Zod schemas (no database)
shared/ads-figures.ts             the addition-only rules for totals (see §4)
server/ads/provider.ts            AdsProvider interface — read-only, no write method
server/ads/google.ts              the real provider (Google Ads API, GAQL over SearchStream)
server/ads/mock-provider.ts       deterministic fixture provider; the only one tests use
server/ads/oauth.ts               consent flow and callback (/api/ads/oauth/callback)
server/ads/tokens.ts              encrypted token storage under GOOGLE_ADS_TOKEN_ENCRYPTION_KEY
server/ads/sync.ts                refresh: read everything, then one transaction
server/ads/read.ts                SELECT-only gathering for the UI, no provider, no network
server/ads/mapping.ts             client <-> ad account linkage
client/src/components/AdsView.tsx the page; route /ads declared in client/src/components/App.tsx
```

**Token encryption.** `server/drive/tokens.ts` holds the AES-256-GCM helpers, but its
`encryptJson` hard-codes the message "GOOGLE_TOKEN_ENCRYPTION_KEY is required before connecting
Drive." A3 either makes that message a parameter so both modules share the helpers, or adds a thin
Ads wrapper that checks its own key first. Either way, Ads tokens are encrypted under
`GOOGLE_ADS_TOKEN_ENCRYPTION_KEY` and never under Drive's key.

**Boundaries carried over from existing rules**

- `client/` never imports a Google SDK or reads a secret; tokens never leave the server.
- Automated tests use the mock provider and never call Google.
- `server/ads/read.ts` holds no provider and no write statement, so opening a page can never spend
  API quota or change data (same guarantee as `server/publish/campaign-analytics.ts`).
- Refresh completes every approved account and query **before** the first data write and replaces
  the defined snapshot whole or not at all (same guarantee as `server/publish/inventory.ts`). A
  failed refresh leaves the last good generation in place and says so in the UI. Bound the rows and
  response size as well as the request count; a stream that ends early is a failed refresh.
- The server runs under `--experimental-strip-types`: no constructor parameter properties.
- External input validated with Zod; provider responses are parsed, never stored raw, and only a
  bounded excerpt of any free text (campaign name) is kept.
- Requests send `Authorization` and, only when configured, `login-customer-id`. They never send
  `developer-token` (§8).

**Data model (additive, per `server/db.ts` convention).** Provisional until A1 combines Google's
field definitions, accepted live queries, and documented fixture shapes without treating an empty
result as proof of populated values.

| Table | Holds |
| --- | --- |
| `ads_connection` | one row: status, granted scope, encrypted refresh token, login customer id (nullable), last sync result |
| `ads_accounts` | customer id, descriptive name, currency code, time zone, manager flag, status, explicit approval for performance reads, nullable `client_id` |
| `ads_campaigns` | account id and campaign id as a compound identity, name, status, channel type, `snapshot_at` |
| `ads_campaign_days` | account id, campaign id, account-local `YYYY-MM-DD` as a compound identity; impressions, clicks, cost (micros), conversions |

Only what the provider reports is stored. Cost is kept as the provider's integer micros and only
formatted at the edge, because currency differs by account and summing across currencies is not
meaningful. A1 must establish the representations of the other metric fields from Google's field
reference and populated fixture responses; conversions must not be assumed to be an integer count.
Dates are `YYYY-MM-DD` in the **account's** time zone, as Google reports them; `snapshot_at` is a
UTC ISO string.

**Milestone B snapshot contract.** Query campaign metadata separately from daily metrics so a
campaign with no activity still appears. The first performance window is the latest 90
account-local calendar dates, including today. Every refresh uses a finite date range calculated
for each account, reads all approved accounts, and atomically replaces campaign metadata and the
daily rows for that window. Remove daily rows outside the window; the UI offers no earlier date
range in milestone B. A date filter applies to each account's local calendar dates, with that zone
shown beside the account. A date omitted by the segmented metrics response means **no reported
row**, not a measured zero, and does not create a synthetic day. Preserve each account's local
approval and client mapping while replacing provider-owned fields. A1 records whether the 90-day
window and the row/response bounds are workable; if not, revise this contract before A2 fixes the
tables.

`client_id` is a nullable foreign key. An account with no client is **Unassigned** wherever
accounts are grouped, never hidden — the same rule as "No campaign" for Signal posts. Archiving a
client does not delete its account link or its figures. Merging clients retargets any linked Ads
account from the source to the survivor in the merge transaction; a refresh never changes that
local choice. Decided in B1: disconnecting, or a later account listing that no longer reaches an approved
account, keeps the last snapshot **visibly stale** and stops every provider read for it; approval and
client mapping stay. Removing retained local Ads data would be a separately confirmed action and is
not an implicit side effect of disconnecting.

**Activity log.** Add source `google-ads` and operations such as `ads.connect`, `ads.disconnect`,
`ads.sync` to `shared/integration-log.ts`. Each records one `integration_events` row in the same
transaction as the data it wrote. Outcome is `SUCCESS` or `FAILURE` — a refresh is
read-then-one-write, so `PARTIAL` does not arise. No credential or raw response goes in the row;
failures pass through `redactSecrets`.

## 4. Figures: read, never computed

Follow the existing analytics rule (`AGENTS.md`, "Figures are read, never computed"):

- Store and show the four provider numbers — impressions, clicks, cost, conversions — as reported.
- Permitted arithmetic: adding the provider's own per-day rows over a named set of campaigns or a
  date range. Nothing else in milestone 1.
- Every group shows `measuredCampaigns` beside `campaigns`; a group with no data carries **no**
  totals rather than zeros.
- A currency mismatch inside a group is shown as separate totals per currency, never a sum.
- CTR/CPC/ROAS and similar are a later card that decides what they mean and how to label them.

## 5. Delivery plan

Card numbers and versions are deliberately not assigned (`AGENTS.md`). Branch slugs are
suggestions. **One implementing pull request open at a time**, in this order.

### Milestone A — Prove the API, then connect

| # | Card | Type | Output |
| --- | --- | --- | --- |
| A1 | **API surface note and probe** `docs/google-ads-api-surface.md`, `scripts/probe-google-ads.ts` | docs/chore | Probe plans by default and contacts nothing; `--live` is owner-run only, never CI, read-only, with a hard request budget well inside the Explorer limit (§8). Signs in as the connecting user in §8, lists directly accessible customer IDs, reads metadata for the one approved account, and runs separate campaign and dated metrics queries without a developer-token header. The dated findings note labels each claim **documented**, **live on the empty account**, or **mock-only**, and records request costs and §8.2 decisions. It does not claim to verify populated figures or Smart campaign behavior from empty results. Transcript never committed. |
| A2 | **Config, schema, log vocabulary** | feat | After A1 resolves field definitions from Google's reference and fixture shapes, add env keys `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REDIRECT_URI`, `GOOGLE_ADS_TOKEN_ENCRYPTION_KEY` (same minimum length as Drive's), optional `GOOGLE_ADS_LOGIN_CUSTOMER_ID`; blank entries in `.env.example`; validation in `server/config.ts`. No developer-token key. Add the §3 tables and `integration-log` source and operations. No UI. |
| A3 | **OAuth connect/disconnect** | feat | `server/ads/oauth.ts`, `tokens.ts` (including the helper change in §3); a Settings card showing connection state. Never mark connected until the account list call succeeds (mirrors the Drive rule). A mocked browser spec covers connect, status, and disconnect; it fulfills Milestone A's `e2e/` requirement without a live Google call. |

### Milestone B — Read accounts and performance

| # | Card | Type | Output |
| --- | --- | --- | --- |
| B1 | **Account selection and client mapping** | feat | Discovery lists directly accessible customer IDs. An operator explicitly approves a serving account before the app reads its metadata or performance; the initial approved scope is only `<ads-account-id>` (§8). Cancelled and manager accounts are not performance targets. Map an approved account to a client by hash-checked preview and confirmation, with an Unassigned group. Preserve approval and mapping on sync, retarget mappings on client merge, and decide the visible local retention behavior on disconnect or lost access. Manager-hierarchy discovery is a later card, not a configuration-only switch. |
| B2 | **Campaign and daily-figure sync** | feat | `sync.ts` implements the 90-account-local-day contract in §3 with separate metadata and metrics queries, read-all-then-one-write, bounded stream/rows, and a mock provider. A partial stream or one account failure keeps the prior generation. Test missing zero-metric days, window rollover, mapping preservation, and the per-refresh request budget A1 measured. |
| B3 | **Ads page `/ads`** | feat | `AdsView.tsx`, read-only, durable URL state (`docs/view-state-convention.md`): date range within the stored 90-day window, client, account. Loading/empty/error/stale states; no reported row distinguished from a measured zero; status colours paired with text. **Milestone B's e2e spec lives here.** |
| B4 | **Client detail panel** | feat | A compact read-only Ads section on the client page, linking to `/ads?client=`. |

The decisions an earlier draft gave to a separate decision-record card are already settled in §8.2,
so A1's findings note records them and no separate card is needed.

### Milestone C — Reach and reporting (optional, after B ships and is used)

- C1 Campaign-level grouping against Signal campaigns — only if §9.1 Q2 says the two should ever be
  linked.
- C2 Reports integration: add Ads cards to `/reports` under the Reports v1 read-only contract.
- C3 Read-only MCP tools and `hcc://ads/...` resource, with change-feed cursors per C132.
- C4 Derived metrics, if wanted, as its own decision record.

## 6. Testing approach (per `docs/testing.md`)

Name the outcome and the regression each test catches; no quota of tests.

- **Sync atomicity.** Mock provider's stream fails on chunk 3 of 4 → stored campaigns and days are
  byte-identical to before, and the log row says `FAILURE`. Catches a write-as-you-read regression.
- **Snapshot scope.** A campaign with no metric row remains in metadata; a missing account-local
  date is not stored as zero; window rollover removes only out-of-window days; another account's
  failed read leaves the entire prior generation intact. Catches false zeros and mixed snapshots.
- **Read-only guarantee.** Static/structural test that `provider.ts` exposes no method beyond
  list/read, and that `read.ts` issues no `INSERT/UPDATE/DELETE` — the test the Signal provider
  already models.
- **Totals.** Two currencies in one group yield two totals, not one; a group with no measured
  campaigns has no `totals` key.
- **Mapping.** Reassigning an account changes only `client_id`; figures and other accounts are
  unchanged. A refresh preserves approval and mapping. A client merge retargets the mapping in the
  same transaction and leaves figures unchanged.
- **Secrets.** OAuth tokens never appear in any API response or log row.
- **Key separation.** A token encrypted under the Ads key does not decrypt under Drive's key, and
  connecting Ads without `GOOGLE_ADS_TOKEN_ENCRYPTION_KEY` fails with an Ads-specific message.
- **Headers.** The Google provider's outgoing requests carry `Authorization`, carry
  `login-customer-id` only when configured, and never carry `developer-token`.
- **Client UI.** Stale-data banner after a failed refresh; Unassigned group is visible.
- **Milestone A browser flow.** Mock OAuth connect/status/disconnect through Settings, with no
  Google request. Milestone B's browser flow opens `/ads` on a stored snapshot and filters it.
- Live Google calls occur only in the owner-run probe and any owner-run smoke script, never in CI,
  and their transcripts are never committed.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Explorer access caps production reads at 2,880 operations a day and "some API functionality may be restricted". | A1 measures the empty-account request cost and estimates the full query-set budget; B2 enforces it. Basic access needs Brand Verification and is only pursued if the cap bites. |
| The only live account has no campaign data. | A1 proves access and query acceptance, but labels populated metric values unverified; B uses documented field definitions and mock fixtures. Real-value verification requires owner-approved live activity, not a paid campaign launch as a prerequisite to A1. |
| Smart campaigns may report fewer fields than Search or Performance Max. | A1 checks field compatibility in Google's reference and whether the empty account accepts the query. It does not claim populated Smart reporting is verified until live rows exist. |
| Discovery does not traverse a manager hierarchy. | B1 limits the initial scope to one explicitly approved, directly accessible serving account; manager-linked clients need a separate hierarchy-discovery card. |
| Dated reporting omits zero-metric rows and has a finite lookback. | Separate metadata from metrics and implement the bounded 90-account-local-day snapshot in §3. No synthetic zero days or older date selections. |
| Ads API versions are sunset on a schedule. | Pin the version in one constant in `google.ts`; A1 records the current version and its sunset date; upgrading is its own chore card. |
| The developer-token header may be rejected outright in a future API version. | The provider never sends it, and a test enforces that (§6). |
| Losing `GOOGLE_ADS_TOKEN_ENCRYPTION_KEY` makes stored Ads tokens unreadable. | Owner keeps a copy outside the repo; recovery is reconnecting Ads, not data recovery. |
| Spend data is sensitive. | Read-only, behind existing app auth, never returned to agents until C3 and then only under its own grant. |
| Scope creep into campaign management. | Stated non-goal; write capability requires a new decision record and a separate module. |

## 8. Current state and decisions (30 September 2026)

### 8.1 Google Ads API access model (from Google's documentation)

- **Developer tokens were sunset on 9 September 2026.** The API accepts a `developer-token` header
  but ignores it. Access levels (Test, Explorer, Basic, Standard) belong to the **Google Cloud
  project that issued the OAuth credentials**, and are requested in Cloud Console on the project's
  Google Ads API Overview page. A manager account is no longer required.
- Requests need `Authorization: Bearer <access token>`, plus `login-customer-id` only when access
  goes through a manager account.
- Google's developer-token sunset guide says a future major API version will reject that header.
  Some older Google auth pages still call it required. A1 tests the planned headerless request;
  the provider sends no developer token.
- `ListAccessibleCustomers` returns the accounts the connecting user can access **directly**, not
  every client beneath a manager. A manager hierarchy requires separate discovery and access rules.

### 8.2 Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Whose accounts (was Q1) | The agency's own account only, for now | No client accounts are reachable. Revisit when a client grants access. |
| Cloud project (was Q2) | The project that already owns the Drive client, with a **separate** OAuth client for Ads | One project to manage; separate clients keep the two grants and redirect URIs apart. |
| Access level | **Explorer** (granted) | Reads production accounts. Basic needs Brand Verification and more volume than this needs. |
| Consent screen | Stays **Internal**; the connecting user is a Workspace user given access in Google Ads | Making it External would change Drive's screen and require Google's OAuth verification for the `adwords` scope. |
| Account topology | **Direct** access to the ad account; no `login-customer-id` | The manager account exists but has nothing linked. Manager-linked clients later need hierarchy discovery as well as a login customer id. |
| Initial read scope | Only `<ads-account-id>` after explicit operator approval | Discovery can return other direct accounts, including the cancelled one; listing an ID does not authorize a metadata or performance sync for it. |
| Token encryption | **Separate** `GOOGLE_ADS_TOKEN_ENCRYPTION_KEY` | Can be rotated without touching Drive. |
| Read-only milestone 1 (was Q3) | Yes | Stated in §1; no objection raised. |
| Developer token | Not used | §8.1. |

### 8.3 Connection data sheet

No secret values are recorded here; secrets live only in the local `.env`, which is gitignored.
Because this repository is public, account-identifying values are placeholders in angle brackets
(`<ads-account-id>`, `<workspace-user>`, `<cloud-project-id>` and so on). The owner's local `.env`
maps each placeholder to its real value in a commented block.

| Item | Value / status | Where it lives |
| --- | --- | --- |
| Cloud project | `<cloud-project-id>` (number `<project-number>`), <workspace-domain> Workspace organisation | Cloud Console |
| Google Ads API | Enabled; **Explorer** access: 2,880 operations/day on production accounts, 15,000 on test accounts | Cloud Console → Google Ads API Overview |
| Consent screen | Internal | Cloud Console → Google Auth Platform → Audience |
| OAuth client | "HCC Google Ads", web application, client ID `<project-number>-…`, no JavaScript origins. Drive's own client is separate and unchanged | Cloud Console; ID and secret in `.env` as `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET` |
| Redirect URIs | `http://localhost:8787/api/ads/oauth/callback`, `https://<public-host>/api/ads/oauth/callback` (mirroring Drive's `/api/drive/oauth/callback` pair) | OAuth client; local value in `.env` as `GOOGLE_ADS_REDIRECT_URI` |
| OAuth scope | `https://www.googleapis.com/auth/adwords` | Code constant (A1 confirms no narrower read-only scope exists) |
| Token encryption key | 32 random bytes, base64 (44 characters), distinct from Drive's key | `.env` as `GOOGLE_ADS_TOKEN_ENCRYPTION_KEY` |
| Connecting user | `<workspace-user>` (Workspace), Admin on the ad account | Google Ads → Admin → Access and security |
| Ad account | `<ads-account-id>`: Expert mode, United States, America/New_York, USD. Billing set up. One unlaunched Smart campaign draft; **no campaign data** | Google Ads |
| Manager account | `<manager-account-id>`, nothing linked. Not used by this plan | Google Ads |
| Other account | `<cancelled-account-id>`, cancelled. Ignored | Google Ads |

## 9. Open questions

### 9.1 For the owner

1. **Real figures.** Is mock-fixture validation plus an empty live account acceptable for B, with
   populated live figures explicitly unverified until the owner independently chooses to run a
   campaign? Launching a campaign spends money and is not a prerequisite for A1.
2. **Link to Signal?** Should an ad campaign ever be associated with a Signal campaign label, or
   stay permanently separate? Default: separate; decide only before optional C1.
3. **Agent access.** Is MCP exposure (C3) wanted at all, and if so read-only only? Decide only before C3.
4. **Placement.** A top-level `/ads` route and nav entry, or a tab under Reports? Default: `/ads`;
   decide before B3.

Scale (accounts, campaigns, history depth) is currently one account with no history. It becomes a
question again when client accounts are added.

### 9.2 For card A1 to answer

- Which Smart campaign fields and segments Google's reference permits, which queries the empty
  account accepts, and which populated values remain unverified.
- The current API version and its sunset date.
- The measured operation cost of the empty-account probe and an estimated per-refresh budget for
  the defined 90-day query set; an empty account does not establish future row volume.
- Whether any narrower read-only OAuth scope exists.
- Whether any request is refused without a developer-token header.
- Whether the proposed 90-day window, metric representations, and stream/row limits can be fixed
  for A2 from documentation and fixtures despite the lack of populated live results.

## 10. Next steps

1. File A1 without waiting for paid campaign activity. Google warned the new redirect URIs can take
   from 5 minutes to a few hours to take effect after 30 September 2026. A1's live run can go once
   they're active.
2. Record the owner's answer to §9.1 Q1 before claiming B is validated on real figures; use the
   stated defaults for the later optional questions until their cards arise.
3. After A1's evidence-labelled findings note lands, settle §3's metric representation and
   snapshot bounds from Google's field reference and fixtures, then file A2. Keep populated live
   values marked unverified until they can be observed.

---

## Appendix: setup log (30 September 2026)

Kept as the record of how §8 came about. §8 is authoritative.

1. **Console check.** <owner-gmail> could reach two Ads accounts: `<cancelled-account-id>`
   (cancelled) and `<ads-account-id>` (setup in progress, stuck in the Smart campaign wizard). No manager
   account.
2. **Manager account.** The owner created a manager account (`<manager-account-id>`) and a
   developer token at Test access. ~~The token goes in `.env` as `GOOGLE_ADS_DEVELOPER_TOKEN`.~~
   The API Center's banner said tokens were no longer required, and Google's documentation confirmed
   the 9 September sunset (§8.1). The owner removed the token from `.env`.
3. **Cloud project.** The Drive client's ID showed it belongs to `<cloud-project-id>`. The
   Ads API was not yet enabled, and the consent screen was Internal, which the Gmail account that
   owned the Ads account could not pass.
4. **Account setup.** `<ads-account-id>` was switched to Expert mode and created without a campaign
   (United States, Eastern Time, USD). The owner submitted billing.
5. **Workspace access.** An invite was prepared for `<workspace-user>` at Admin access,
   sent, and accepted.
6. **API and access.** On the owner's instruction, the Google Ads API was enabled (accepting its
   terms) and Explorer access requested. It was granted within minutes.
7. **OAuth client.** "HCC Google Ads" was created with the two redirect URIs. The owner copied the ID
   and secret into `.env`; the secret was never read into any log or chat.
8. **Encryption key.** A separate `GOOGLE_ADS_TOKEN_ENCRYPTION_KEY` was generated straight into `.env`
   and never displayed.

Sources checked on 30 September 2026:
[developer-token sunset guide](https://developers.google.com/google-ads/api/docs/api-policy/developer-token),
[access levels](https://developers.google.com/google-ads/api/docs/api-policy/access-levels),
[account discovery](https://developers.google.com/google-ads/api/docs/account-management/listing-accounts),
[daily segmentation](https://developers.google.com/google-ads/api/docs/reporting/segmentation),
[zero-metric rows](https://developers.google.com/google-ads/api/docs/reporting/zero-metrics),
[call structure](https://developers.google.com/google-ads/api/docs/concepts/call-structure).
