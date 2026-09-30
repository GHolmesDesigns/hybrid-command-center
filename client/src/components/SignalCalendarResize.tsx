import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { CalendarViewMode } from '../../../shared/calendar';

const MIN_HEIGHT = 184;
const STEP = 24;
const storageKey = (view: CalendarViewMode) => `hcc-signal-row-height-${view}`;

function maximumHeight(view: CalendarViewMode): number {
  return Math.max(
    MIN_HEIGHT,
    Math.min(view === 'month' ? 320 : 640, Math.floor(innerHeight * 0.7)),
  );
}

function savedHeight(view: CalendarViewMode): number {
  try {
    const value = Number(localStorage.getItem(storageKey(view)));
    return Number.isFinite(value) && value >= MIN_HEIGHT ? value : MIN_HEIGHT;
  } catch {
    return MIN_HEIGHT;
  }
}

export function SignalCalendarResize({
  view,
  children,
}: {
  view: CalendarViewMode;
  children: ReactNode;
}) {
  const [preferredHeight, setPreferredHeight] = useState(() => savedHeight(view));
  const [maxHeight, setMaxHeight] = useState(() => maximumHeight(view));
  const stopDrag = useRef<() => void>(() => undefined);
  const height = Math.min(preferredHeight, maxHeight);

  useEffect(() => {
    const update = () => setMaxHeight(maximumHeight(view));
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [view]);

  useEffect(() => () => stopDrag.current(), []);

  const updateHeight = (value: number) => {
    const next = Math.max(MIN_HEIGHT, Math.min(maximumHeight(view), Math.round(value)));
    try {
      localStorage.setItem(storageKey(view), String(next));
      setPreferredHeight(next);
    } catch {
      setPreferredHeight(MIN_HEIGHT);
    }
  };

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopDrag.current();
    const pointerId = event.pointerId;
    const startY = event.clientY;
    const startHeight = height;
    const move = (next: PointerEvent) => {
      if (next.pointerId === pointerId) updateHeight(startHeight + next.clientY - startY);
    };
    const finish = (next: PointerEvent) => {
      if (next.pointerId === pointerId) stopDrag.current();
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      stopDrag.current = () => undefined;
    };
    stopDrag.current = cleanup;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') updateHeight(height + STEP);
    else if (event.key === 'ArrowUp') updateHeight(height - STEP);
    else if (event.key === 'Home') updateHeight(MIN_HEIGHT);
    else return;
    event.preventDefault();
  };

  return (
    <div
      className="signal-resizable-grid"
      style={{ '--signal-row-height': `${height}px` } as CSSProperties}
    >
      {children}
      <div
        className="signal-resize-grip"
        role="separator"
        aria-label="Resize calendar rows"
        aria-orientation="horizontal"
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={maxHeight}
        aria-valuenow={height}
        aria-valuetext={`${height} pixels per row`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={startDrag}
      >
        <span aria-hidden="true" />
      </div>
    </div>
  );
}
