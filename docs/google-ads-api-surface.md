# Google Ads API surface — 2 October 2026

This note supports issue #723 and the read-only probe at `scripts/probe-google-ads.ts`. Evidence labels below are deliberate: **documented** means Google publishes the contract; **mock-only** means a fake transport exercised our request shape and guards; **live on empty account** has no entry yet because the owner has not run the probe. No populated figures or Smart campaign rows have been observed.

## Version, access, and headers

| Finding | Evidence |
| --- | --- |
| Probe targets REST API `v25`; Google's published sunset for v25 is **August 2027**. v25.2 release notes were posted 23 September 2026; the REST major-version path remains `v25`. | **Documented** — [sunset schedule](https://developers.google.com/google-ads/api/docs/sunset-dates), [release notes](https://developers.google.com/google-ads/api/docs/release-notes) |
| OAuth scope is `https://www.googleapis.com/auth/adwords`; the account-list method requires it. No narrower Ads read-only OAuth scope is documented for this method. | **Documented** — [ListAccessibleCustomers](https://developers.google.com/google-ads/api/reference/rpc/v25/CustomerService/ListAccessibleCustomers) |
| `ListAccessibleCustomers` lists directly accessible customers, not a manager hierarchy. | **Documented** — [account listing](https://developers.google.com/google-ads/api/docs/account-management/listing-accounts) |
| Developer tokens were sunset 9 September 2026. API servers ignore `developer-token` until a future major version rejects it. The probe sends no such header. | **Documented** — [developer-token sunset](https://developers.google.com/google-ads/api/docs/api-policy/developer-token); **mock-only** outgoing-header assertion |
| Customer reads carry `Authorization: Bearer`; this direct-access probe sends no `login-customer-id`. | **Documented** — [call structure](https://developers.google.com/google-ads/api/docs/concepts/call-structure); **mock-only** header assertion |

## Exact requests and fields

The plan makes one OAuth refresh at `https://oauth2.googleapis.com/token`, one `GET /v25/customers:listAccessibleCustomers`, then these three distinct `POST /v25/customers/{approved-id}/googleAds:searchStream` calls. The approved ID is never printed or persisted. The request returns row **counts** only.

```sql
SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer LIMIT 1

SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign

SELECT campaign.id, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date BETWEEN '<start>' AND '<end>'
```

The `start` and `end` placeholders are required explicit `YYYY-MM-DD` values covering at most 90 calendar dates. **Documented**: the [v25 campaign field reference](https://developers.google.com/google-ads/api/fields/v25/campaign) lists the selected campaign and metric fields; [date segmentation](https://developers.google.com/google-ads/api/docs/reporting/segmentation) permits a dated campaign report. `customer.id` and `campaign.id` are IDs; descriptive name is text; currency code and time zone are account metadata; manager is a boolean; statuses and advertising channel type are enums. `segments.date` is an account-local calendar date. `metrics.impressions`, `metrics.clicks`, and `metrics.cost_micros` are 64-bit integer counts/micros; `metrics.conversions` is a double and can be fractional. These are field definitions, **not** observed populated REST representations. [Metrics fields](https://developers.google.com/google-ads/api/fields/v25/metrics), [customer fields](https://developers.google.com/google-ads/api/fields/v25/customer).

**Mock-only**: the fake transport accepted these URLs and request bodies, verified all three account-scoped calls use exactly the approved ID, and returned an empty campaign and metric stream. It does not prove Google accepts the GAQL. **Live on empty account**: pending owner run; record accepted/rejected query and row counts here after review without copying account IDs or responses.

## Request accounting and bounds

The planned probe uses **5 HTTP requests**: one token refresh, one discovery, and three SearchStream calls. Its hard cap is **8 HTTP requests**, including failed calls and OAuth. Explorer's published production limit is **2,880 operations per day** ([access levels](https://developers.google.com/google-ads/api/docs/api-policy/access-levels)). Google's Ads-operation accounting may differ from this raw HTTP count, so the owner run must record the measured operation count before claiming a quota cost. **Mock-only**: five calls completed, and the guards refused a missing approval, account, credentials, or overlong range.

An estimated full refresh for one approved serving account is **three Ads requests** if it repeats customer metadata, campaign metadata, and one 90-day dated metrics SearchStream query; discovery adds one when run, and OAuth refresh adds one non-Ads HTTP request. For `N` approved accounts, the estimate is `1 discovery + 3N Ads calls`, plus token refresh if needed. This is an estimate, not a measured quota claim. Production row volume, response size, stream duration, and operation cost remain unknown; the one-request 90-day query may need partitioning and a revised budget before A2/B2.

## Owner-run procedure and unresolved evidence

Run `npm run probe:google-ads` first: it prints the plan and contacts nothing. An owner-approved live run supplies `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, and `GOOGLE_ADS_REFRESH_TOKEN` in the local environment, plus `--live --yes --account-approved --account <id> --start <date> --end <date>`, and types `LIVE` at the prompt. It makes no Ads write and never appears in CI. Preserve the full transcript **outside** the repository; commit only reviewed, redacted findings in this note.

| Open question | Current evidence |
| --- | --- |
| Do all three GAQL queries succeed without a developer-token header on the approved empty account? | **Mock-only**; live check pending. |
| Are any populated Smart campaign rows returned, and which fields do they carry? | Unknown; the only live account has no delivered campaign data. |
| What are the actual REST representations for populated impressions, clicks, cost micros, and fractional conversions? | **Documented** field types; populated values unverified. |
| Is one 90-day SearchStream call and its row/response volume workable on a production account? | Unknown; empty-account evidence cannot establish production volume. |
| What is the measured Ads operation cost? | Unknown pending owner run; five is a planned HTTP count. |

The next schema card should treat metric wire representations and bounds as provisional until a populated fixture and owner evidence are reviewed. An empty stream establishes neither zero values nor Smart campaign compatibility.
