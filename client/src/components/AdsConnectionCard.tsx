import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, ExternalLink } from 'lucide-react';
import { api, send } from '../api';
import {
  ADS_CONNECT_FAILURE_MESSAGE,
  isAdsConnectFailure,
  type AdsConnectFailure,
  type AdsConnectionState,
} from '../../../shared/ads';
import { formatDateTime } from './formatting';

type Notice = { kind: 'connected' } | { kind: 'failed'; reason: AdsConnectFailure } | null;

/**
 * Google Ads connection (C256). A separate grant from Drive: its own card, its own endpoints,
 * and nothing here reads a Drive value. The server owns every credential; this card receives a
 * status and a redirect URL and nothing else. Connecting approves no ad account.
 */
export function AdsConnectionCard({
  flash,
}: {
  flash: (message: string, tone?: 'success' | 'error') => void;
}) {
  const [state, setState] = useState<AdsConnectionState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [params, setParams] = useSearchParams();

  const load = useCallback(async () => {
    try {
      setState(await api<AdsConnectionState>('/ads/status'));
      setLoadError('');
    } catch (error) {
      setLoadError((error as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // The callback sends the browser back to /settings?ads=connected or ?ads=error&reason=<code>.
  // Read it once, show it, and take it out of the address so a reload does not replay the notice.
  const adsParam = params.get('ads');
  const reasonParam = params.get('reason');
  useEffect(() => {
    if (!adsParam) return;
    if (adsParam === 'connected') setNotice({ kind: 'connected' });
    else if (adsParam === 'error' && isAdsConnectFailure(reasonParam))
      setNotice({ kind: 'failed', reason: reasonParam });
    const next = new URLSearchParams(params);
    next.delete('ads');
    next.delete('reason');
    setParams(next, { replace: true });
    void load();
  }, [adsParam, reasonParam, params, setParams, load]);

  const connect = async () => {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>('/ads/oauth/start');
      window.location.href = url;
    } catch (error) {
      flash((error as Error).message, 'error');
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (
      !confirm(
        'Disconnect Google Ads? This removes the credential stored here only. Any account approvals and client mappings stay.\n\nRevoke the app separately in Google Account → Third-party access.',
      )
    )
      return;
    setBusy(true);
    try {
      await send<{ ok: true }>('/ads/disconnect', 'POST');
      setNotice(null);
      await load();
      flash('Google Ads disconnected locally. Revoke the grant in your Google Account.');
    } catch (error) {
      flash((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const connected = state?.status === 'CONNECTED';
  const broken = state?.status === 'ERROR';
  const badge = connected ? 'connected' : broken ? 'failed' : 'disconnected';
  const badgeText = connected ? 'Ads connected' : broken ? 'Ads issue' : 'Ads offline';

  return (
    <section className="panel settings-card" aria-labelledby="ads-card-title">
      <div className="settings-icon">
        <ExternalLink />
      </div>
      <div className="section-title">
        <div>
          <span className="eyebrow">Integration</span>
          <h2 id="ads-card-title">Google Ads</h2>
        </div>
        <span className={`drive-badge ${badge}`}>
          <span />
          {badgeText}
        </span>
      </div>
      <p>
        Google Ads is a separate grant from Drive, with its own OAuth client and encryption key. It
        is read-only: this app never changes an ad account. Connecting only proves the grant works —
        it approves no account for performance reads. Tokens stay encrypted on the server and never
        reach the browser.
      </p>
      {notice?.kind === 'connected' && (
        <div className="inline-warning" role="status">
          <CheckCircle2 />
          <div>
            <strong>Google Ads connected</strong>
            <span>Google listed the accounts this grant can reach directly.</span>
          </div>
        </div>
      )}
      {notice?.kind === 'failed' && (
        <div className="inline-warning" role="alert">
          <AlertCircle />
          <div>
            <strong>Google Ads was not connected</strong>
            <span>{ADS_CONNECT_FAILURE_MESSAGE[notice.reason]}</span>
          </div>
        </div>
      )}
      {loadError && (
        <div className="inline-warning" role="alert">
          <AlertCircle />
          <div>
            <strong>Google Ads status unavailable</strong>
            <span>{loadError}</span>
            <button type="button" className="text-btn" onClick={() => void load()}>
              Retry
            </button>
          </div>
        </div>
      )}
      {!loadError && state && !state.configured && (
        <div className="inline-warning">
          <AlertCircle />
          <div>
            <strong>Credentials required</strong>
            <span>
              Add{' '}
              {state.missing.map((name) => (
                <code key={name}>{name} </code>
              ))}
              to <code>.env</code>, then restart the app.
            </span>
          </div>
        </div>
      )}
      {broken && state?.problem && (
        <div className="inline-warning" role="alert">
          <AlertCircle />
          <div>
            <strong>Saved connection is unusable</strong>
            <span>{state.problem}</span>
          </div>
        </div>
      )}
      {state && (
        <>
          <button type="button" onClick={connect} disabled={busy || !state.configured}>
            {notice?.kind === 'failed'
              ? 'Try again'
              : connected || broken
                ? 'Reconnect Google Ads'
                : 'Connect Google Ads'}
          </button>
          {(connected || broken) && (
            <button
              type="button"
              className="text-btn danger-text"
              onClick={disconnect}
              disabled={busy}
            >
              Disconnect Google Ads
            </button>
          )}
        </>
      )}
      {connected && (
        <p className="muted" data-testid="ads-connected-detail">
          Connected {state?.connectedAt ? formatDateTime(state.connectedAt) : ''}
          {state?.viaManager ? ' through a manager account.' : '.'} Disconnecting removes the
          credential stored here only; revoke the app in{' '}
          <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
            Google Account permissions
          </a>
          .
        </p>
      )}
    </section>
  );
}
