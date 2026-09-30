import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalCalendarResize } from './components/SignalCalendarResize';

const grip = () => screen.getByRole('separator', { name: 'Resize calendar rows' });
const height = () => Number(grip().getAttribute('aria-valuenow'));
const row = () => screen.getByText('Calendar row').parentElement as HTMLElement;
const show = (view: 'today' | 'week' | 'month') =>
  render(
    <SignalCalendarResize view={view}>
      <div>Calendar row</div>
    </SignalCalendarResize>,
  );

describe('Signal calendar row resizing', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('innerHeight', 1000);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('grows, shrinks, and resets from the keyboard with accessible bounds', () => {
    show('week');
    expect(grip()).toHaveAttribute('aria-orientation', 'horizontal');
    expect(grip()).toHaveAttribute('aria-valuemin', '184');
    expect(grip()).toHaveAttribute('aria-valuemax', '640');
    expect(grip()).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(grip(), { key: 'ArrowDown' });
    expect(height()).toBe(208);
    expect(row()).toHaveStyle({ '--signal-row-height': '208px' });
    fireEvent.keyDown(grip(), { key: 'ArrowUp' });
    expect(height()).toBe(184);
    fireEvent.keyDown(grip(), { key: 'ArrowDown' });
    fireEvent.keyDown(grip(), { key: 'Home' });
    expect(height()).toBe(184);
  });

  it.each(['pointerup', 'pointercancel'] as const)(
    'drags outside the grid and removes its listeners on %s',
    (end) => {
      const removed = vi.spyOn(window, 'removeEventListener');
      show('today');
      fireEvent.pointerDown(grip(), { pointerId: 7, button: 0, clientY: 100 });
      fireEvent.pointerMove(window, { pointerId: 7, clientY: 200 });
      expect(height()).toBe(284);
      if (end === 'pointerup') fireEvent.pointerUp(window, { pointerId: 7 });
      else fireEvent.pointerCancel(window, { pointerId: 7 });
      expect(removed).toHaveBeenCalledWith('pointermove', expect.any(Function));
      expect(removed).toHaveBeenCalledWith('pointerup', expect.any(Function));
      expect(removed).toHaveBeenCalledWith('pointercancel', expect.any(Function));
      fireEvent.pointerMove(window, { pointerId: 7, clientY: 300 });
      expect(height()).toBe(284);
    },
  );

  it('cleans up an active drag when the view unmounts', () => {
    const removed = vi.spyOn(window, 'removeEventListener');
    const rendered = show('week');
    fireEvent.pointerDown(grip(), { pointerId: 3, button: 0, clientY: 50 });
    rendered.unmount();
    expect(removed).toHaveBeenCalledWith('pointermove', expect.any(Function));
    expect(removed).toHaveBeenCalledWith('pointerup', expect.any(Function));
    expect(removed).toHaveBeenCalledWith('pointercancel', expect.any(Function));
  });

  it('clamps to each view and viewport limit and restores each view separately', () => {
    const first = show('today');
    fireEvent.pointerDown(grip(), { pointerId: 1, button: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 2000 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(height()).toBe(640);
    first.unmount();

    const month = show('month');
    expect(height()).toBe(184);
    expect(grip()).toHaveAttribute('aria-valuemax', '320');
    fireEvent.pointerDown(grip(), { pointerId: 2, button: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 2, clientY: 2000 });
    fireEvent.pointerUp(window, { pointerId: 2 });
    expect(height()).toBe(320);
    month.unmount();

    vi.stubGlobal('innerHeight', 300);
    const small = show('today');
    expect(grip()).toHaveAttribute('aria-valuemax', '210');
    expect(height()).toBe(210);
    small.unmount();
    vi.stubGlobal('innerHeight', 1000);
    show('today');
    expect(height()).toBe(640);
    expect(localStorage.getItem('hcc-signal-row-height-month')).toBe('320');
  });

  it('uses the minimum if storage reads or writes fail', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    show('week');
    expect(height()).toBe(184);
    cleanup();
    vi.restoreAllMocks();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    show('week');
    fireEvent.keyDown(grip(), { key: 'ArrowDown' });
    expect(height()).toBe(184);
  });
});
