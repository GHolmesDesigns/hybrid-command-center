import { describe, expect, it } from 'vitest';
import { MCP_TOOL_REGISTRY } from './registry.ts';
import { createMcpPromptRegistry, getMcpPrompt, mcpPromptsListPayload } from './prompts.ts';

const PROMPT_NAMES = [
  'start_claimed_work',
  'review_project_status',
  'prepare_handoff',
  'verify_before_complete',
  'triage_signal_queue',
];

describe('MCP workflow prompts', () => {
  it('lists the five workflow prompts from one definition', () => {
    expect(mcpPromptsListPayload().map((prompt) => prompt.name)).toEqual(PROMPT_NAMES);
  });

  it('omits a prompt when a referenced registry tool does not exist', () => {
    const withoutClaim = MCP_TOOL_REGISTRY.filter(
      (tool) => tool.name !== 'coordination_claim_handoff',
    );
    expect(createMcpPromptRegistry(withoutClaim).map((prompt) => prompt.name)).not.toContain(
      'start_claimed_work',
    );
    expect(getMcpPrompt('start_claimed_work', { handoffId: 'h-1' }, withoutClaim)).toBeNull();
  });

  it.each(PROMPT_NAMES)('%s states the provider and Drive boundaries', (name) => {
    const args = name.includes('claimed') || name.includes('complete') ? { handoffId: 'h-1' } : {};
    const prompt = getMcpPrompt(name, args)!;
    const text = prompt.messages[0]!.content.text;
    expect(text).toMatch(/never publishes to a provider/i);
    expect(text).toMatch(/never writes to Drive/i);
  });

  it('starts with claim, then handoff and subject context reads', () => {
    const text = getMcpPrompt('start_claimed_work', { handoffId: 'handoff-7' })!.messages[0]!
      .content.text;
    expect(text).toContain('handoff-7');
    expect(text.indexOf('coordination_claim_handoff')).toBeLessThan(
      text.indexOf('coordination_get_handoff'),
    );
    expect(text.indexOf('coordination_get_handoff')).toBeLessThan(
      text.indexOf('workspace_get_subject_context'),
    );
    expect(text).toMatch(/agent_label/);
  });

  it('names every C125 evidence field and outcome classification from the tool schema', () => {
    const text = getMcpPrompt('verify_before_complete', { handoffId: 'h-1' })!.messages[0]!.content
      .text;
    for (const field of [
      'resultSummary',
      'outcome',
      'changedPaths',
      'references',
      'validations',
      'remainingRisks',
    ]) {
      expect(text).toContain(field);
    }
    for (const outcome of ['SUCCEEDED', 'PARTIALLY_SUCCEEDED', 'BLOCKED', 'SUPERSEDED']) {
      expect(text).toContain(outcome);
    }
  });

  it('requires declared required arguments and rejects unknown prompts', () => {
    expect(() => getMcpPrompt('start_claimed_work', {})).toThrow(/handoffId/);
    expect(getMcpPrompt('not_a_prompt', {})).toBeNull();
  });

  it('renders optional review, handoff, and queue arguments when supplied', () => {
    expect(
      getMcpPrompt('review_project_status', { projectId: 'project-1' })!.messages[0]!.content.text,
    ).toContain('projectId project-1');
    const handoff = getMcpPrompt('prepare_handoff', {
      subjectType: 'task',
      subjectId: 'task-1',
    })!.messages[0]!.content.text;
    expect(handoff).toContain('task / task-1');
    expect(
      getMcpPrompt('triage_signal_queue', { from: '2026-08-01', to: '2026-08-31' })!.messages[0]!
        .content.text,
    ).toContain('2026-08-01 through 2026-08-31');
  });

  it('ignores non-object and non-string arguments', () => {
    expect(getMcpPrompt('review_project_status', null)!.messages[0]!.content.text).toMatch(
      /only when task detail is needed/,
    );
    expect(
      getMcpPrompt('prepare_handoff', { subjectType: 7, subjectId: false })!.messages[0]!.content
        .text,
    ).toContain('<subjectType> / <subjectId>');
  });

  it('falls back safely when a future completion schema omits enum metadata', () => {
    const registry = MCP_TOOL_REGISTRY.map((tool) =>
      tool.name === 'coordination_complete_handoff'
        ? {
            ...tool,
            inputSchema: {
              ...tool.inputSchema,
              properties: {
                ...((tool.inputSchema.properties ?? {}) as Record<string, unknown>),
                outcome: { type: 'string' },
              },
              required: 'invalid-future-shape',
            },
          }
        : tool,
    );
    const text = getMcpPrompt('verify_before_complete', { handoffId: 'h-1' }, registry)!
      .messages[0]!.content.text;
    expect(text).toContain('outcome values exposed by the tool schema');
    expect(text).toContain('resultSummary (optional)');
  });
});
