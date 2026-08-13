import { getDb } from '../db.ts';
import { importCampaignArchive } from '../signal/archive.ts';

/**
 * Brings the campaign content Signal already held into this workspace.
 *
 * Safe to run more than once: posts are matched by a stable id, so a second run reports
 * everything as already present and changes nothing. Nothing is ever overwritten — an edit made
 * here after an import survives the next one.
 */
const { imported, skipped } = importCampaignArchive(getDb());

if (imported === 0) {
  console.log(`Signal archive already imported — all ${skipped} posts were already present.`);
} else {
  console.log(
    `Imported ${imported} Signal post${imported === 1 ? '' : 's'}` +
      (skipped > 0 ? `, and left ${skipped} already present untouched.` : '.'),
  );
}
