import type { CSSProperties } from 'react';
import { Archive, Blocks, CircleCheck, CircleDashed, CirclePause, CirclePlay } from 'lucide-react';
import type { Project } from '../../../shared/types';
import { mixHex } from '../../../shared/contrast';

export type ProjectStatus = Project['status'];

/** Planning through archived, in the order work moves through them. */
export const PROJECT_STATUSES = [
  'PLANNING',
  'BUILDING',
  'ACTIVE',
  'ON_HOLD',
  'COMPLETE',
  'ARCHIVED',
] as const satisfies readonly ProjectStatus[];

export interface ProjectStatusPresentation {
  /** The status word the chip always shows. Colour is never the only carrier. */
  label: string;
  /** A shape of its own per status, so a greyscale grid still separates the six. */
  Icon: typeof CircleDashed;
  /** Chip text, chip outline, and the tile's top edge. */
  ink: string;
  /** Chip fill. */
  surface: string;
  /** The tile's own tint, derived from the chip fill rather than chosen twice over. */
  wash: string;
}

/**
 * How far a chip fill is faded toward paper to become the tile behind it. The tile carries
 * every colour the page's body text uses, so the tint has to stay light enough that
 * `--muted` — the weakest of them — still clears AA on it; `Projects.status.test.tsx`
 * measures that rather than trusting the number.
 */
const TILE_WASH = 0.78;

const entry = (
  label: string,
  Icon: ProjectStatusPresentation['Icon'],
  ink: string,
  surface: string,
): ProjectStatusPresentation => ({
  label,
  Icon,
  ink,
  surface,
  wash: mixHex(surface, '#ffffff', TILE_WASH),
});

/**
 * One palette entry per project status. Hue separates them at a glance; the word and the icon
 * separate them without it. Archived is the recessive one — the only neutral in the set, and
 * the only dashed edge — while staying as legible as the rest, because recessive is a matter
 * of emphasis and never of contrast.
 */
export const PROJECT_STATUS_PRESENTATION: Record<ProjectStatus, ProjectStatusPresentation> = {
  PLANNING: entry('Planning', CircleDashed, '#275d8c', '#dcecf7'),
  BUILDING: entry('Building', Blocks, '#6f5a10', '#f7eec9'),
  ACTIVE: entry('Active', CirclePlay, '#2f6f52', '#dcece4'),
  ON_HOLD: entry('On hold', CirclePause, '#7d4038', '#f3ded8'),
  COMPLETE: entry('Complete', CircleCheck, '#6a4a9c', '#ece4f7'),
  ARCHIVED: entry('Archived', Archive, '#5f6764', '#eff1ef'),
};

/**
 * The custom properties a status-aware surface paints from, the way `brandStyle` hands the
 * sidebar its palette: the stylesheet holds the shapes, this module holds the colours, and
 * what renders is what the contrast test measured.
 */
export const projectStatusStyle = (status: ProjectStatus): CSSProperties => {
  const { ink, surface, wash } = PROJECT_STATUS_PRESENTATION[status];
  return {
    '--status-ink': ink,
    '--status-surface': surface,
    '--status-wash': wash,
  } as CSSProperties;
};
