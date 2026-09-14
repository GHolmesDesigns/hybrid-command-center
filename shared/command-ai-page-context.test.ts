import { describe, expect, it } from 'vitest';
import {
  commandAiPageContextEligible,
  commandAiPageContextSubject,
  formatCommandAiPageContextLabel,
} from './command-ai-page-context.ts';

describe('commandAiPageContextEligible', () => {
  it('allows workspace pages and rejects agent or settings surfaces', () => {
    expect(commandAiPageContextEligible('/projects')).toBe(true);
    expect(commandAiPageContextEligible('/projects/p1')).toBe(true);
    expect(commandAiPageContextEligible('/agents/conversations')).toBe(false);
    expect(commandAiPageContextEligible('/agents/conversations?open=thread-a')).toBe(false);
    expect(commandAiPageContextEligible('/settings')).toBe(false);
  });
});

describe('commandAiPageContextSubject', () => {
  it('derives subject type and id from detail routes', () => {
    expect(commandAiPageContextSubject('/clients/c1')).toEqual({
      subjectType: 'client',
      subjectId: 'c1',
    });
    expect(commandAiPageContextSubject('/projects/p1')).toEqual({
      subjectType: 'project',
      subjectId: 'p1',
    });
    expect(commandAiPageContextSubject('/tasks/t1')).toEqual({
      subjectType: 'task',
      subjectId: 't1',
    });
    expect(commandAiPageContextSubject('/status')).toEqual({
      subjectType: null,
      subjectId: null,
    });
  });
});

describe('formatCommandAiPageContextLabel', () => {
  it('joins page segments after the Command Center root', () => {
    expect(
      formatCommandAiPageContextLabel([
        { label: 'Command Center' },
        { label: 'Projects' },
        { label: 'Website Refresh' },
      ]),
    ).toBe('Projects · Website Refresh');
  });
});
