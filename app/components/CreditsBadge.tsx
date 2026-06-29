'use client';

import { useCallback, useEffect, useState } from 'react';
import { useIsMobile } from '../lib/useMediaQuery';

type Credits = {
  eleven?: { tier?: string; used?: number; limit?: number; resets_at?: string; status?: string; error?: string };
  fal?: {
    email?: string;
    is_locked?: boolean;
    lock_reason?: string | null;
    account_type?: string;
    error?: string;
    hint?: string;
  };
  fetched_at?: string;
};

function fmtNum(n?: number): string {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function CreditsBadge() {
  const [data, setData] = useState<Credits | null>(null);
  const [loading, setLoading] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const isMobile = useIsMobile();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/credits', { cache: 'no-store' });
      if (r.ok) setData(await r.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const el = data?.eleven;
  const elRemaining = el && !el.error && el.used != null && el.limit != null
    ? el.limit - el.used
    : null;
  const elPct = el && !el.error && el.used != null && el.limit != null && el.limit > 0
    ? Math.round((el.used / el.limit) * 100)
    : null;

  const fal = data?.fal;
  const falText = !fal
    ? '—'
    : fal.error
      ? 'admin key needed'
      : fal.is_locked === true
        ? 'LOCKED'
        : fal.is_locked === false
          ? 'ready'
          : '—';
  const falColor = fal?.is_locked === true
    ? '#fca5a5'
    : fal?.is_locked === false
      ? '#86efac'
      : '#e5e5e5';

  return (
    <div style={styles.wrap}>
      <button onClick={() => setShowDetail((v) => !v)} style={styles.badge} title="Click for details">
        <span style={styles.pair}>
          <span style={styles.label}>11L</span>
          <span style={{ ...styles.value, color: elRemaining != null && elRemaining < 5000 ? '#fbbf24' : '#e5e5e5' }}>
            {el?.error ? 'err' : elRemaining != null ? `${fmtNum(elRemaining)} chars` : '—'}
          </span>
        </span>
        <span style={styles.sep}>·</span>
        <span style={styles.pair}>
          <span style={styles.label}>FAL</span>
          <span style={{ ...styles.value, color: falColor }}>{falText}</span>
        </span>
        {loading && <span style={styles.spin}>…</span>}
      </button>
      {showDetail && isMobile && (
        <div
          onClick={() => setShowDetail(false)}
          style={styles.mobileBackdrop}
          aria-hidden
        />
      )}
      {showDetail && (
        <div
          style={{
            ...styles.detail,
            ...(isMobile ? styles.detailMobile : null),
          }}
        >
          {isMobile && (
            <button
              onClick={() => setShowDetail(false)}
              style={styles.closeBtn}
              aria-label="Close"
            >
              ✕
            </button>
          )}
          <div style={styles.detailRow}>
            <strong>ElevenLabs</strong>
            {el?.error ? (
              <span style={{ color: '#fca5a5' }}>{el.error}</span>
            ) : (
              <>
                <span>tier: {el?.tier ?? '—'}</span>
                <span>used: {fmtNum(el?.used)} / {fmtNum(el?.limit)} ({elPct ?? '—'}%)</span>
                <span>resets: {el?.resets_at ? new Date(el.resets_at).toLocaleString() : '—'}</span>
                <span>status: {el?.status ?? '—'}</span>
              </>
            )}
          </div>
          <div style={styles.detailRow}>
            <strong>FAL</strong>
            {fal?.error ? (
              <>
                <span style={{ color: '#fca5a5' }}>{fal.error}</span>
                {fal.hint && <span style={{ color: '#a3a3a3' }}>{fal.hint}</span>}
              </>
            ) : (
              <>
                <span>email: {fal?.email ?? '—'}</span>
                <span>
                  status: <span style={{ color: falColor }}>
                    {fal?.is_locked === true ? 'LOCKED' : fal?.is_locked === false ? 'ready to generate' : '—'}
                  </span>
                </span>
                {fal?.lock_reason && <span style={{ color: '#fca5a5' }}>reason: {fal.lock_reason}</span>}
                <span>plan: {fal?.account_type ?? '—'}</span>
                <span style={{ color: '#737373', fontSize: 10 }}>
                  Dollar balance isn't exposed by FAL's API — check fal.ai/dashboard/billing
                </span>
              </>
            )}
          </div>
          <button onClick={refresh} style={styles.refreshBtn}>refresh now</button>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { position: 'relative', display: 'inline-block' },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: '#171717',
    color: '#e5e5e5',
    border: '1px solid #262626',
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 11,
    fontFamily: 'ui-monospace, monospace',
    cursor: 'pointer',
  },
  pair: { display: 'inline-flex', alignItems: 'baseline', gap: 4 },
  label: { color: '#737373', fontWeight: 600 },
  value: { fontSize: 11 },
  sep: { color: '#525252' },
  spin: { color: '#737373' },
  detail: {
    position: 'absolute',
    top: '110%',
    right: 0,
    zIndex: 60,
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 6,
    padding: 10,
    fontSize: 12,
    color: '#e5e5e5',
    minWidth: 280,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    boxShadow: '0 8px 20px rgba(0,0,0,0.5)',
  },
  // On phone, anchor to the viewport instead of the badge so the panel can't
  // clip off-screen. Sits just below the top bar with margin on both sides
  // and scrolls if the FAL block overflows.
  detailMobile: {
    position: 'fixed',
    top: 72,
    left: 12,
    right: 12,
    bottom: 'auto',
    maxHeight: '70vh',
    overflowY: 'auto',
    minWidth: 0,
    padding: 14,
    paddingTop: 30,
    zIndex: 80,
    boxShadow: '0 12px 30px rgba(0,0,0,0.7)',
  },
  mobileBackdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.4)',
    zIndex: 70,
  },
  closeBtn: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 28,
    height: 28,
    borderRadius: '50%',
    background: '#171717',
    border: '1px solid #262626',
    color: '#e5e5e5',
    fontSize: 13,
    lineHeight: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    padding: 0,
  },
  detailRow: { display: 'flex', flexDirection: 'column', gap: 3 },
  refreshBtn: {
    alignSelf: 'flex-start',
    background: '#262626',
    color: '#e5e5e5',
    border: '1px solid #404040',
    borderRadius: 4,
    padding: '3px 10px',
    fontSize: 11,
    cursor: 'pointer',
  },
};
