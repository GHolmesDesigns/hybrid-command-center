import { useEffect, useId, useRef } from 'react';

export type FilterOption = { value: string; label: string };

export function MultiSelectFilter({
  label,
  emptyLabel,
  options,
  selected,
  onChange,
}: {
  label: string;
  emptyLabel: string;
  options: FilterOption[];
  selected: string[];
  onChange: (value: string, checked: boolean) => void;
}) {
  const labelId = useId();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const selectedLabels = options
    .filter((option) => selected.includes(option.value))
    .map((option) => option.label);
  const summary =
    selectedLabels.length === 0
      ? emptyLabel
      : selectedLabels.length === 1
        ? selectedLabels[0]
        : `${selectedLabels.length} selected`;

  useEffect(() => {
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      const details = detailsRef.current;
      if (details?.open && !details.contains(event.target as Node)) details.open = false;
    };
    document.addEventListener('pointerdown', dismissOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', dismissOnOutsidePointer);
  }, []);

  const dismiss = () => {
    const details = detailsRef.current;
    if (!details) return;
    details.open = false;
    summaryRef.current?.focus();
  };

  return (
    <div className="multi-filter">
      <span id={labelId}>{label}</span>
      <details
        ref={detailsRef}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !detailsRef.current?.open) return;
          event.preventDefault();
          dismiss();
        }}
      >
        <summary ref={summaryRef} role="button" aria-label={`${label}: ${summary}`}>
          {summary}
        </summary>
        <fieldset aria-labelledby={labelId}>
          {options.map((option) => (
            <label key={option.value}>
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onChange={(event) => onChange(option.value, event.target.checked)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      </details>
    </div>
  );
}
