# Signal client binding decision — 2026-09-01

## Decision

A Signal post reaches a client through its project:

`signal_posts.project_id → projects.client_id → clients`

This is the only binding path. Signal does not gain a second `client_id` column, and campaigns
remain labels rather than ownership relationships.

## Reasoning

Projects already belong to exactly one client, while a post may carry several campaigns and a
campaign may span several clients. Binding through a campaign would therefore be ambiguous.
Adding an explicit client field would duplicate the existing project relationship and could become
stale when a project moves between clients. The project path preserves the workspace's existing
ownership model and keeps `signal_posts` as the only schedule store.

The existing nullable `signal_posts.project_id` column is the additive migration surface for this
feature; no destructive migration or new schedule table is needed. Existing posts with a project
are bound immediately through the read join. Existing posts without one remain unbound.

## Unbound posts

A post with no project, or whose project has no resolvable client, remains fully visible in the
queue, calendar, and editor. It receives no client name, initials, logo, or client palette. It is
never assigned a default client and is never inferred from campaign names.

## Branding cue

Bound tiles show the client name and initials alongside the palette derived from C157's validated
client branding. The initials and text are always present, so colour is supportive and never the
only cue. A client without a custom palette uses the validated global branding fallback. Logos are
not fetched by Signal.
