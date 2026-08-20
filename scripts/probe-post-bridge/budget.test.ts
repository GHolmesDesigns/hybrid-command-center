import { describe, expect, it } from 'vitest';
import {
  ProbeBudgetExhaustedError,
  PROBE_REQUEST_BUDGET,
  PROBE_TEARDOWN_RESERVE,
  RequestBudget,
} from './budget.ts';

describe('RequestBudget', () => {
  it('holds the ceiling the plan fixed', () => {
    expect(PROBE_REQUEST_BUDGET).toBe(50);
    expect(PROBE_TEARDOWN_RESERVE).toBeLessThan(PROBE_REQUEST_BUDGET);
  });

  it('refuses before the call rather than reporting after it', () => {
    const budget = new RequestBudget(3, 1);
    budget.spend('one');
    budget.spend('two');
    expect(budget.used).toBe(2);
    expect(() => budget.spend('three')).toThrow(ProbeBudgetExhaustedError);
    // The refused call did not count. A budget that charges for the request it prevented cannot be
    // reasoned about from the transcript.
    expect(budget.used).toBe(2);
  });

  it('names the request it stopped and the ceiling it stopped at', () => {
    const budget = new RequestBudget(2, 1);
    budget.spend('first');
    expect(() => budget.spend('second')).toThrow(/second/);
    expect(() => budget.spend('second')).toThrow(/1 of 1 allowed/);
  });

  it('keeps the reserve for teardown when the questions have spent everything else', () => {
    const budget = new RequestBudget(5, 2);
    budget.spend('q1');
    budget.spend('q2');
    budget.spend('q3');
    expect(budget.remainingForQuestions).toBe(0);
    expect(() => budget.spend('q4')).toThrow(ProbeBudgetExhaustedError);
    expect(() => budget.spend('cleanup-1', { teardown: true })).not.toThrow();
    expect(() => budget.spend('cleanup-2', { teardown: true })).not.toThrow();
    expect(budget.used).toBe(5);
  });

  it('stops teardown at the total as well, so the ceiling is one number', () => {
    const budget = new RequestBudget(3, 2);
    budget.spend('cleanup-1', { teardown: true });
    budget.spend('cleanup-2', { teardown: true });
    budget.spend('cleanup-3', { teardown: true });
    expect(() => budget.spend('cleanup-4', { teardown: true })).toThrow(ProbeBudgetExhaustedError);
  });

  it('reports what each half has left', () => {
    const budget = new RequestBudget(10, 4);
    expect(budget.remaining).toBe(10);
    expect(budget.remainingForQuestions).toBe(6);
    budget.spend('one');
    expect(budget.remaining).toBe(9);
    expect(budget.remainingForQuestions).toBe(5);
  });

  it('refuses a nonsensical budget rather than behaving oddly later', () => {
    expect(() => new RequestBudget(0, 0)).toThrow();
    expect(() => new RequestBudget(10, 10)).toThrow();
    expect(() => new RequestBudget(10, -1)).toThrow();
    expect(() => new RequestBudget(2.5, 1)).toThrow();
  });
});
