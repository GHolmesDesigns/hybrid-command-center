import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { useServerSeeded } from './useServerSeeded';

/**
 * The hook exists to stop a late server response overwriting an edit a person already made
 * (#251, #266). These tests are that sentence in both directions: it mirrors until touched, and it
 * stops mirroring once touched — until a save hands authority back.
 */
function Panel({ initial }: { initial: string }) {
  const [fromServer, setFromServer] = useState(initial);
  const [value, setValue, markSaved] = useServerSeeded(fromServer);
  return (
    <>
      <output data-testid="value">{value}</output>
      <button onClick={() => setValue('edited')}>Edit</button>
      <button onClick={() => setFromServer('from the server')}>Respond</button>
      <button onClick={markSaved}>Mark saved</button>
    </>
  );
}

const value = () => screen.getByTestId('value').textContent;
const press = (name: string) => act(() => screen.getByRole('button', { name }).click());

describe('useServerSeeded', () => {
  it('mirrors the server value until someone edits', () => {
    render(<Panel initial="seeded" />);
    expect(value()).toBe('seeded');

    press('Respond');
    expect(value()).toBe('from the server');
  });

  it('keeps an unsaved edit when a later response lands', () => {
    render(<Panel initial="seeded" />);

    press('Edit');
    expect(value()).toBe('edited');

    // The defect this hook was written for: without it, this response replaces the edit.
    press('Respond');
    expect(value()).toBe('edited');
  });

  it('takes the server value again once the edit has been saved', () => {
    render(<Panel initial="seeded" />);
    press('Edit');
    press('Respond');
    expect(value()).toBe('edited');

    // Saving is what hands authority back. Without this the panel would ignore the server forever
    // after one keystroke, which is the opposite failure.
    press('Mark saved');
    expect(value()).toBe('from the server');
  });

  it('goes back to ignoring responses after a fresh edit', () => {
    render(<Panel initial="seeded" />);
    press('Edit');
    press('Mark saved');

    press('Edit');
    press('Respond');
    expect(value()).toBe('edited');
  });
});
