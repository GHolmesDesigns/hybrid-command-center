import { useCallback, useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { api, send } from '../api';
import {
  ADS_STALE_MESSAGE,
  ADS_TARGET_ISSUE_MESSAGE,
  formatAdsCustomerId,
  type AdsAccountView,
  type AdsAccountsState,
  type AdsMappingPreview,
} from '../../../shared/ads';
import type { Client } from '../../../shared/types';
import { formatDateTime } from './formatting';

const UNASSIGNED = '';

const mappingSentence = (plan: AdsMappingPreview) => {
  const account = `${plan.accountName} (${formatAdsCustomerId(plan.customerId)})`;
  if (plan.action === 'UNASSIGN')
    return `Unassign ${account} from ${plan.from?.name}. It stays approved and listed as Unassigned.`;
  if (plan.action === 'REASSIGN')
    return `Move ${account} from ${plan.from?.name} to ${plan.to?.name}.`;
  return `Assign ${account} to ${plan.to?.name}.`;
};

/**
 * Google Ads accounts (C257): which directly accessible account this app may read, and which client
 * it belongs to. Listing names accounts and authorizes nothing; approving one exact account lets the
 * server read its metadata; mapping is a previewed, confirmed change to a local link and nothing
 * else. Every decision here is a person's, made through the operator session — no agent tool
 * reaches it.
 */
export function AdsAccountsCard({
  flash,
}: {
  flash: (message: string, tone?: 'success' | 'error') => void;
}) {
  const [state, setState] = useState<AdsAccountsState | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<AdsMappingPreview | null>(null);

  const load = useCallback(async () => {
    try {
      const [accounts, clientList] = await Promise.all([
        api<AdsAccountsState>('/ads/accounts'),
        api<Client[]>('/clients'),
      ]);
      setState(accounts);
      setClients(clientList.filter((client) => client.status === 'ACTIVE'));
      setLoadError('');
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      flash((error as Error).message, 'error');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const connected = state?.connectionStatus === 'CONNECTED';
  const accounts = state?.accounts ?? [];
  // While connected the card is where accounts are listed. Disconnected, it stays only for what a
  // person decided or a read kept — an approved or read account — and a bare list of IDs is not that.
  const retained = accounts.some((account) => account.approved || account.snapshot);
  if (!loadError && (!state || (!connected && !retained))) return null;

  const discover = () =>
    run(async () => {
      setState(await send<AdsAccountsState>('/ads/accounts/discover', 'POST'));
      flash('Listed the accounts this grant reaches directly. None is approved or read.');
    });

  const approve = (account: AdsAccountView) => {
    const label = formatAdsCustomerId(account.customerId);
    if (
      !confirm(
        `Approve account ${label}?\n\nThis lets the app read this one account's metadata and, later, its campaign performance. It never changes the account in Google Ads. A manager or cancelled account is refused.`,
      )
    )
      return;
    void run(async () => {
      setState(
        await send<AdsAccountsState>(`/ads/accounts/${account.customerId}/approve`, 'POST', {
          confirmCustomerId: account.customerId,
        }),
      );
      flash(`Account ${label} approved. It is Unassigned until you map it to a client.`);
    });
  };

  const withdraw = (account: AdsAccountView) => {
    const label = formatAdsCustomerId(account.customerId);
    if (
      !confirm(
        `Withdraw approval for ${label}?\n\nThe app stops reading it. Its last snapshot and client link are kept.`,
      )
    )
      return;
    void run(async () => {
      setState(
        await send<AdsAccountsState>(`/ads/accounts/${account.customerId}/withdraw`, 'POST', {
          confirmCustomerId: account.customerId,
        }),
      );
      setPlan(null);
    });
  };

  const review = (account: AdsAccountView) =>
    run(async () => {
      const clientId = (choice[account.customerId] ?? account.client?.id ?? UNASSIGNED) || null;
      setPlan(
        await send<AdsMappingPreview>(
          `/ads/accounts/${account.customerId}/mapping/preview`,
          'POST',
          {
            clientId,
          },
        ),
      );
    });

  const confirmPlan = () => {
    if (!plan) return;
    void run(async () => {
      await send(`/ads/accounts/${plan.customerId}/mapping`, 'POST', {
        clientId: plan.to?.id ?? null,
        planHash: plan.planHash,
      });
      setPlan(null);
      setChoice({});
      await load();
      flash('Mapping saved. Only the local client link changed.');
    });
  };

  const approved = accounts.filter((account) => account.approved);
  const others = accounts.filter((account) => !account.approved);
  const groups = [
    ...clients
      .map((client) => ({
        key: client.id,
        title: client.name,
        rows: approved.filter((account) => account.client?.id === client.id),
      }))
      .filter((group) => group.rows.length > 0),
    // A client that is archived keeps its accounts, so it is still a heading here.
    ...[
      ...new Map(
        approved
          .filter((a) => a.client?.status === 'ARCHIVED')
          .map((a) => [a.client!.id, a.client!]),
      ).values(),
    ].map((client) => ({
      key: client.id,
      title: `${client.name} (archived)`,
      rows: approved.filter((account) => account.client?.id === client.id),
    })),
    {
      key: 'unassigned',
      title: 'Unassigned',
      rows: approved.filter((account) => !account.client),
    },
  ];

  const accountLine = (account: AdsAccountView) => (
    <>
      <strong>{account.snapshot?.descriptiveName ?? 'Not read yet'}</strong>{' '}
      <code>{formatAdsCustomerId(account.customerId)}</code>
      {account.snapshot && (
        <span className="muted">
          {' '}
          · {account.snapshot.currencyCode} · {account.snapshot.timeZone} · read{' '}
          {formatDateTime(account.snapshot.snapshotAt)}
        </span>
      )}
      {account.stale && (
        <span className="muted" role="status">
          {' '}
          · Stale: {ADS_STALE_MESSAGE[account.stale]}
        </span>
      )}
    </>
  );

  return (
    <section className="panel settings-card" aria-labelledby="ads-accounts-title">
      <div className="section-title">
        <div>
          <span className="eyebrow">Google Ads</span>
          <h2 id="ads-accounts-title">Ads accounts</h2>
        </div>
      </div>
      <p>
        Listing shows which accounts this grant reaches directly and authorizes nothing. Approve one
        exact serving account to let the app read it, then map it to a client. Manager and cancelled
        accounts can never be approved. Mapping changes only the link to a client.
      </p>
      {loadError && (
        <div className="inline-warning" role="alert">
          <AlertCircle />
          <div>
            <strong>Ads accounts unavailable</strong>
            <span>{loadError}</span>
            <button type="button" className="text-btn" onClick={() => void load()}>
              Retry
            </button>
          </div>
        </div>
      )}
      {state && (
        <>
          <button type="button" onClick={() => void discover()} disabled={busy || !connected}>
            List accessible accounts
          </button>
          <p className="muted">
            {state.discoveredAt
              ? `Last listed ${formatDateTime(state.discoveredAt)}.`
              : 'Accounts have not been listed yet.'}
            {!connected && ' Google Ads is not connected, so nothing is being read.'}
          </p>

          <h3>Approved accounts</h3>
          {approved.length === 0 && <p className="muted">No account is approved.</p>}
          {groups.map(
            (group) =>
              group.rows.length > 0 && (
                <div key={group.key} role="group" aria-label={`${group.title} accounts`}>
                  <h4>{group.title}</h4>
                  <ul>
                    {group.rows.map((account) => {
                      const label = formatAdsCustomerId(account.customerId);
                      return (
                        <li key={account.customerId}>
                          <div>{accountLine(account)}</div>
                          <label>
                            <span className="muted">Client </span>
                            <select
                              aria-label={`Client for account ${label}`}
                              value={choice[account.customerId] ?? account.client?.id ?? UNASSIGNED}
                              onChange={(event) => {
                                setPlan(null);
                                setChoice({ ...choice, [account.customerId]: event.target.value });
                              }}
                              disabled={busy}
                            >
                              <option value={UNASSIGNED}>Unassigned</option>
                              {clients.map((client) => (
                                <option key={client.id} value={client.id}>
                                  {client.name}
                                </option>
                              ))}
                            </select>
                          </label>{' '}
                          <button
                            type="button"
                            onClick={() => void review(account)}
                            disabled={busy}
                          >
                            Review change
                          </button>{' '}
                          <button
                            type="button"
                            className="text-btn danger-text"
                            onClick={() => withdraw(account)}
                            disabled={busy}
                          >
                            Withdraw approval
                          </button>
                          {plan?.customerId === account.customerId && (
                            <div
                              className="inline-warning"
                              role="group"
                              aria-label="Confirm mapping"
                            >
                              <div>
                                <strong>Confirm this change</strong>
                                <span>{mappingSentence(plan)}</span>
                                <button type="button" onClick={confirmPlan} disabled={busy}>
                                  Confirm mapping
                                </button>{' '}
                                <button
                                  type="button"
                                  className="text-btn"
                                  onClick={() => setPlan(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ),
          )}

          <h3>Not approved</h3>
          {others.length === 0 && <p className="muted">Every listed account is approved.</p>}
          <ul>
            {others.map((account) => (
              <li key={account.customerId}>
                <div>{accountLine(account)}</div>
                {account.targetIssue && (
                  <div className="muted" role="status">
                    Not a performance target: {ADS_TARGET_ISSUE_MESSAGE[account.targetIssue]}
                  </div>
                )}
                {account.discovered && (
                  <button
                    type="button"
                    onClick={() => approve(account)}
                    disabled={busy || !connected}
                    aria-label={`Approve account ${formatAdsCustomerId(account.customerId)}`}
                  >
                    {account.targetIssue ? 'Check again' : 'Approve'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
