import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Check, Megaphone, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, send } from '../api';
import {
  normalizeSignalCampaignName,
  sameSignalCampaignName,
  SIGNAL_CAMPAIGN_NAME_MAX,
  type SignalCampaignSummary,
} from '../../../shared/signal';
import { TagChip } from './FormControls';
import { Empty } from './Primitives';

/**
 * The workspace's Signal campaigns: the one place a campaign is renamed or removed, beside how many
 * posts carry it.
 *
 * Renaming here reaches every post at once because the name lives on the campaign row and not on the
 * posts — and deleting one detaches it without touching a single post, which the server enforces by
 * having no statement that could. The card is deliberately the same shape as **Project categories**
 * beside it: the same list, the same inline rename, the same confirmation naming what is attached.
 *
 * It loads its own list rather than taking one from `SettingsView`. Campaigns belong to Signal, and
 * threading them through the whole application state so one card can read them would make every page
 * fetch them.
 */
export function SignalCampaignsCard({
  flash,
}: {
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const [campaigns, setCampaigns] = useState<SignalCampaignSummary[]>([]);
  const [draft, setDraft] = useState(''),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<string | null>(null),
    [rename, setRename] = useState('');
  const load = useCallback(
    () =>
      api<SignalCampaignSummary[]>('/signal/campaigns')
        .then(setCampaigns)
        .catch((error: Error) => flash(error.message, 'error')),
    [flash],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const postsWord = (count: number) => `${count} post${count === 1 ? '' : 's'}`;
  const usage = (campaign: SignalCampaignSummary) => campaign.postCount;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const name = normalizeSignalCampaignName(draft);
    if (!name) return;
    // The server reuses an existing name rather than refusing it, so say which happened.
    const existing = campaigns.find((campaign) => sameSignalCampaignName(campaign.name, name));
    setBusy(true);
    try {
      await send('/signal/campaigns', 'POST', { name });
      setDraft('');
      await load();
      flash(
        existing
          ? `“${existing.name}” is already in the list.`
          : `Campaign “${name}” added to the list.`,
      );
    } catch (error) {
      flash((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const startRename = (campaign: SignalCampaignSummary) => {
    setEditing(campaign.id);
    setRename(campaign.name);
  };
  const cancelRename = () => {
    setEditing(null);
    setRename('');
  };
  const saveRename = async (campaign: SignalCampaignSummary, event: FormEvent) => {
    event.preventDefault();
    const name = normalizeSignalCampaignName(rename);
    if (!name || name === campaign.name) return cancelRename();
    try {
      await send(`/signal/campaigns/${campaign.id}`, 'PATCH', { name });
      cancelRename();
      await load();
      flash(`Campaign renamed to “${name}” on ${postsWord(usage(campaign))}.`);
    } catch (error) {
      // The name is still in the field, so the correction is one edit away.
      flash((error as Error).message, 'error');
    }
  };
  const remove = async (campaign: SignalCampaignSummary) => {
    try {
      await send(`/signal/campaigns/${campaign.id}`, 'DELETE');
      await load();
      flash(`Campaign “${campaign.name}” deleted.`);
    } catch (error: any) {
      if (error.status !== 409 || error.data?.code !== 'SIGNAL_CAMPAIGN_IN_USE')
        return flash(error.message, 'error');
      const count: number = error.data.attachedPostCount;
      if (
        !confirm(
          `“${campaign.name}” is attached to ${postsWord(count)}.\n\nDelete the campaign and remove it from ${count === 1 ? 'that post' : 'those posts'}? The ${count === 1 ? 'post itself is' : 'posts themselves are'} not deleted.`,
        )
      )
        return;
      try {
        await send(`/signal/campaigns/${campaign.id}?confirm=true`, 'DELETE');
        await load();
        flash(`Campaign “${campaign.name}” deleted from ${postsWord(count)}.`);
      } catch (confirmed) {
        flash((confirmed as Error).message, 'error');
      }
    }
  };
  const escapeCancels = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    cancelRename();
  };
  return (
    <section className="panel settings-card">
      <div className="settings-icon neutral">
        <Megaphone />
      </div>
      <div className="section-title">
        <div>
          <span className="eyebrow">Signal Campaign</span>
          <h2>Signal campaigns</h2>
        </div>
        <span className="version-pill">{campaigns.length}</span>
      </div>
      <p>
        Campaigns group Signal posts the way categories group projects, and a post can carry as many
        as it needs — the campaign and the week inside it. Add one here or straight from a post;
        renaming one renames it on every post, and deleting one only removes the label — never a
        post. Figures are grouped by campaign on the planner.
      </p>
      <form className="chip-input-row" onSubmit={create}>
        <label className="sr-only" htmlFor="new-signal-campaign">
          New campaign name
        </label>
        <input
          id="new-signal-campaign"
          value={draft}
          maxLength={SIGNAL_CAMPAIGN_NAME_MAX}
          placeholder="Add a campaign, e.g. Clarity Campaign"
          onChange={(event) => setDraft(event.target.value)}
        />
        {/* Named rather than just "Add": there are three of these label cards on this page now, and
            a control called "Add" three times over is three controls nobody can tell apart. */}
        <button type="submit" disabled={busy || !normalizeSignalCampaignName(draft)}>
          <Plus /> Add campaign
        </button>
      </form>
      {campaigns.length ? (
        <ul className="tag-manager">
          {campaigns.map((campaign) => (
            <li key={campaign.id}>
              {editing === campaign.id ? (
                <form
                  className="inline-rename"
                  onSubmit={(event) => saveRename(campaign, event)}
                  onKeyDown={escapeCancels}
                >
                  <label>
                    <span className="sr-only">{`New name for ${campaign.name}`}</span>
                    <input
                      value={rename}
                      maxLength={SIGNAL_CAMPAIGN_NAME_MAX}
                      autoFocus
                      onChange={(event) => setRename(event.target.value)}
                    />
                  </label>
                  <button type="submit">
                    <Check /> Save
                  </button>
                  <button type="button" className="secondary" onClick={cancelRename}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <TagChip tag={campaign} />
                  <span>{postsWord(usage(campaign))}</span>
                  <button
                    className="icon-btn"
                    onClick={() => startRename(campaign)}
                    aria-label={`Rename campaign ${campaign.name}`}
                  >
                    <Pencil />
                  </button>
                  <button
                    className="icon-btn danger"
                    onClick={() => remove(campaign)}
                    aria-label={`Delete campaign ${campaign.name}`}
                  >
                    <Trash2 />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty
          compact
          title="No campaigns yet"
          body="Add a campaign to a Signal post to start building the shared list."
        />
      )}
    </section>
  );
}
