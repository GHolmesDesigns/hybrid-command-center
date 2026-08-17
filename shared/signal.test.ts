import { describe, expect, it } from 'vitest';
import { signalTextHasLink } from './signal.ts';

describe('Signal link detection', () => {
  it.each([
    ['a bare domain', 'Visit gholmesdesigns.com for the full story.'],
    ['a bare domain with a path', 'Read foo.io/path next.'],
    ['a www address', 'See www.example.com/campaign.'],
    ['an http URL', 'See http://example.test/campaign.'],
    ['an https URL', 'See https://example.test/campaign.'],
  ])('detects %s', (_case, text) => {
    expect(signalTextHasLink(text)).toBe(true);
  });

  it.each([
    ['e.g.', 'Use a familiar example, e.g. a client brief.'],
    ['i.e.', 'Keep the scope exact, i.e. warning only.'],
    ['3.5 percent', 'Engagement rose by 3.5 percent.'],
    ['a decimal number', 'The average is 12.75 today.'],
  ])('ignores %s', (_case, text) => {
    expect(signalTextHasLink(text)).toBe(false);
  });
});
