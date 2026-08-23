import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Local editing state seeded from a server value, which a later server response must not overwrite.
 *
 * ## The defect this exists to prevent
 *
 * Two panels independently arrived at the same shape:
 *
 * ```tsx
 * const [form, setForm] = useState(fromServer);
 * useEffect(() => {
 *   setForm(fromServer);
 * }, [fromServer]);
 * ```
 *
 * It reads as "keep the form in step with the server", and it is really "throw away whatever the
 * person did, whenever a response lands". A request in flight when they act is enough: the effect
 * fires on arrival and the edit is gone, with no error and nothing on screen to say why.
 *
 * It failed in two places for two different people (#251, #266). In Settings it undid **Reset to
 * defaults** and — on the far side of a save — repainted the sidebar back to the old palette after
 * the app had already said *Sidebar branding saved.* In the publishing preview it discarded an
 * account tick when the preview response settled a moment later. Both are silent, both are
 * timing-dependent, and both look like a page that ignored you.
 *
 * ## The rule
 *
 * **An unsaved edit outranks a later payload.** Until the person has touched the value, this mirrors
 * the server and behaves exactly as the effect above did. From their first edit until
 * {@link markSaved} is called, the server may say what it likes and the local value stands.
 *
 * That is what every well-behaved form does, and it is the reason the third return value is not
 * optional: a hook that only ever stops listening would leave a panel permanently detached after one
 * keystroke. `markSaved` is the seam that hands authority back — call it once a write has landed, and
 * the next server value seeds normally.
 *
 * ## What it deliberately does not do
 *
 * It does not compare values, deep-equal them, or try to merge. A person who typed the same thing the
 * server already had still typed it, and a merge would have to guess which side of a conflict wins —
 * which is the guess that produced the bug. Identity of the incoming value is not consulted either:
 * whether a re-fetch returns a new object for identical data is a fact about the caller's fetching,
 * not about whether an edit should survive.
 *
 * @param fromServer the authoritative value; may change identity on every fetch
 * @returns `[value, setValue, markSaved]` — `setValue` marks the value edited, `markSaved` clears
 *   that and lets the next `fromServer` seed again
 */
export function useServerSeeded<T>(fromServer: T): [T, Dispatch<SetStateAction<T>>, () => void] {
  const [value, setValue] = useState<T>(fromServer);
  const [edited, setEdited] = useState(false);

  // `edited` is a dependency rather than a ref read: clearing it has to re-seed on the same pass,
  // which is what makes `markSaved` adopt the value that was just written instead of waiting for
  // some later unrelated fetch to arrive.
  useEffect(() => {
    if (edited) return;
    setValue(fromServer);
  }, [fromServer, edited]);

  const edit = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setEdited(true);
    setValue(next);
  }, []);

  const markSaved = useCallback(() => setEdited(false), []);

  return [value, edit, markSaved];
}
