import type { BufferProbeConfig } from './config.ts';
import type { BufferProbeResult } from './probe.ts';

export function renderBufferPlan(config: BufferProbeConfig): string {
  return [
    `Mode: ${config.mode}. ${config.mode === 'plan' ? 'The provider will not be contacted.' : 'Disposable scheduled posts will be created and deleted.'}`,
    `Account: ${config.accountId}`,
    `Organization: ${config.organizationId}`,
    `Scheduled at: ${config.scheduledAt}`,
    `Probe label: ${config.probeLabel}`,
    `Connected channels: ${config.channels.map((channel) => `${channel.service}:${channel.id}`).join(', ')}`,
    `Write targets: ${config.targets.map((channel) => `${channel.service}:${channel.id}`).join(', ')}`,
    `Media fixtures: ${config.media.length ? config.media.map((fixture) => `${fixture.service}:${fixture.kind}:${fixture.url}`).join(', ') : 'none (text-only)'}`,
    'Flow: verify account and exact connected channels; prove label unused in a complete read; create one post per write target; read; edit; read; delete in finally; prove absence in a complete read.',
    'Hard budget: 50 requests, with 12 reserved for cleanup. No automatic retry and no rate-limit provocation.',
  ].join('\n');
}

export function renderBufferMatrix(result: BufferProbeResult, now: Date): string {
  const date = now.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const lines = [
    `### Buffer live result matrix — ${date}`,
    '',
    '| Claim | Result | Evidence |',
    '| --- | --- | --- |',
    ...result.claims.map(
      (claim) =>
        `| ${claim.claim.replaceAll('|', '\\|')} | **${claim.state}** | ${claim.evidence.replaceAll('|', '\\|')} |`,
    ),
    '',
    `Requests: ${result.requests.used} of ${result.requests.total}. Created: ${result.created.length}. Deleted: ${result.deleted.length}. Leftovers: ${result.leftovers.length}.`,
  ];
  if (result.stopped) lines.push(`Stopped: ${result.stopped}`);
  return `${lines.join('\n')}\n`;
}
