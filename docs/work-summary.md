# Hybrid Command Center — Work Summary

Serialized Cursor collaboration record for Hybrid Command Center after the 10 August 2026 hybrid
initial commit. For the full three-agent lineage (Codex, Claude, Cursor), see
[`PROJECT_SUMMARY.md`](../PROJECT_SUMMARY.md).

Hybrid Command Center is a local-first studio command center. Clients, projects, and tasks live in
SQLite. Google Drive holds project files and is provisioned from the app. Folder names never create
or own projects.

It started from Master Project Command Center (Codex) infrastructure — SQLite, Express API, Drive
provider, Kanban, deadlines, OAuth — and took Hybrid V2 sidebar, branding, sync, and delete/rename
controls from Drive Command Center (Claude). The decision that stuck: SQLite owns operational
records; Drive owns files.

## Snapshot

As of 28 August 2026.

| | |
| --- | --- |
| Repository | `GHolmesDesigns/hybrid-command-center` |
| Branch | `main` matches `origin/main` |
| Version | **5.6.8** (`package.json` and `APP_VERSION`) |
| Production origin | `https://hcc.gholmesdesigns.com` |
| First commit | 10 August 2026 (`8804b00`, v2.0.0) |
| Commits | 509 |
| Merged pull requests | 197 |
| Open issues | 14 (Waves 26–30 MCP capability cards) |

## Work completed (selected)

- **Clients, projects, and tasks** in SQLite, with archival for clients, record-only delete for
  projects and tasks, and Drive left untouched by those actions.
- **Merge one client into another** (4.3.0): previewed, confirmed, single-transaction move with the
  source archived as an alias.
- A **deadline-led dashboard**, **Status board** at `/status`, task types, checklists, dependencies,
  tags, and project categories.
- **Campaign playbook import**, read-only **Files**, and an append-only **integration activity** log.
- **Signal Campaign** as the authoritative schedule, with Post Bridge and Buffer publish flows,
  analytics, provider inventory, queue health, and campaign-level figures.
- **Calendar** composing Signal posts and task due dates as two headed groups.
- **Operator authentication** and **production cloud hosting** (C51–C55): HTTPS origin, CSRF,
  session management, hosted backups, and cutover rehearsal.
- **Multi-agent MCP**: coordination handoff tools on stdio and authenticated HTTP (C111–C113),
  operator coordination inbox (C112), scoped agent credentials (C118), persisted network write rate
  limits (C116), structured mutation errors (C117), the workspace capability descriptor plus
  `hcc://workspace/context` resource (C120), and the dashboard summary domain module (C121) that
  `GET /api/dashboard` and the upcoming `workspace_dashboard_summary` tool share. Workspace and
  Signal read/write MCP tools (MCP-C106–C108, C122+) remain unbuilt — see
  [`mcp-capability-plan.md`](mcp-capability-plan.md).

## Current status

Production is live at **5.6.8**. Open work is concentrated in Waves 26–30 of the MCP capability
plan: hardening, read tools, evidence and policy, bounded writes, and change feeds. The decision
records in [`multi-agent-mcp-decision.md`](multi-agent-mcp-decision.md) and
[`agent-coordination-plan.md`](agent-coordination-plan.md) reflect what shipped through C121.

For installation, daily use, and operator documentation, see [README.md](../README.md),
[CHANGELOG.md](../CHANGELOG.md), and [USER_MANUAL.md](../USER_MANUAL.md).
