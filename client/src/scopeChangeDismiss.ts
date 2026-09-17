const STORAGE_KEY = 'hcc:scope-change-dismiss';

function readDismissed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

export function isScopeChangeDismissed(key: string): boolean {
  return readDismissed().has(key);
}

export function dismissScopeChangePair(key: string): void {
  const dismissed = readDismissed();
  dismissed.add(key);
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...dismissed]));
}
