'use client';

// Per-episode YouTube Analytics panel. Mounts under RenderUploadBar and
// only renders when the episode has been uploaded (upload_meta.last_video_id
// is set). All data comes from the local tunnel — the tunnel serves
// history via GET /analytics/{channel}/{video_id} and triggers fresh
// pulls via POST /analytics/pull (which shells to yt-analytics-pull.py).
//
// Visual shape:
//   - Headline stat row (views / watch min / avg view % / subs gained /
//     likes / comments)
//   - Retention curve: inline SVG sparkline, 101 buckets across playback %
//     with reference lines at 50% and 80%
//   - Views over time: bar sparkline per-day since upload
//   - Freshness stamp + "pull now" button to trigger a fresh snapshot
//
// No chart library — all sparklines are plain SVG kept short to avoid
// npm bloat. Reads are fast because the JSONL is local to the tunnel;
// pulls block for ~10s (two API calls) and replace the UI with the new
// snapshot on return.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, RefreshCw, ExternalLink, AlertTriangle } from 'lucide-react';
import type { ProjectMeta } from '../lib/blob';

type Snapshot = {
  pulled_at: string;
  video_id: string;
  channel: string;
  lifetime: Record<string, number>;
  daily: Array<Record<string, string | number>>;
  retention: Array<{ t: number; ratio: number; relative?: number | null }>;
};

type AnalyticsDoc = {
  channel: string;
  video_id: string;
  snapshot_count: number;
  latest: Snapshot | null;
  history: Snapshot[];
};

type Props = {
  projectMeta: ProjectMeta | null;
  tunnelUrl: string | null;
  tunnelOk: boolean;
};

function fmtNum(n: number | undefined | null): string {
  if (n == null || !isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Math.round(n).toLocaleString();
}

function fmtMin(minutes: number | undefined | null): string {
  if (minutes == null || !isFinite(minutes)) return '—';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return `${h}h ${m}m`;
}

function fmtAgo(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function AnalyticsPanel({ projectMeta, tunnelUrl, tunnelOk }: Props) {
  const uploadMeta = projectMeta?.upload_meta;
  const videoId = uploadMeta?.last_video_id;
  const channel = uploadMeta?.last_channel;
  const privacy = uploadMeta?.thumbnail_url; // harmless — unused, just to quiet TS if we reference fields
  // Note: we intentionally don't store privacy in upload_meta today. If
  // we add it later, the "private/unlisted — public to see analytics"
  // empty state below becomes more useful.

  const [doc, setDoc] = useState<AnalyticsDoc | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [pulling, setPulling] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState<boolean>(false);

  const canTalk = Boolean(tunnelUrl && tunnelOk && videoId && channel);

  const fetchHistory = useCallback(async () => {
    if (!canTalk) return;
    setLoading(true);
    setError(null);
    setNotFound(false);
    const t = tunnelUrl!.replace(/\/+$/, '');
    try {
      const r = await fetch(
        `${t}/analytics/${encodeURIComponent(channel!)}/${encodeURIComponent(videoId!)}`,
      );
      if (r.status === 404) {
        setNotFound(true);
        setDoc(null);
        return;
      }
      if (!r.ok) {
        setError(`${r.status}: ${(await r.text()).slice(0, 160)}`);
        return;
      }
      setDoc(await r.json());
    } catch (e: any) {
      setError(String(e?.message || e).slice(0, 160));
    } finally {
      setLoading(false);
    }
  }, [canTalk, tunnelUrl, channel, videoId]);

  const pullNow = useCallback(async () => {
    if (!canTalk) return;
    setPulling(true);
    setError(null);
    const t = tunnelUrl!.replace(/\/+$/, '');
    try {
      const r = await fetch(`${t}/analytics/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, video_id: videoId }),
      });
      if (!r.ok) {
        const msg = (await r.text()).slice(0, 200);
        setError(`pull failed (${r.status}): ${msg}`);
        return;
      }
      // Reload history so the new snapshot shows up in context.
      await fetchHistory();
    } catch (e: any) {
      setError(String(e?.message || e).slice(0, 160));
    } finally {
      setPulling(false);
    }
  }, [canTalk, tunnelUrl, channel, videoId, fetchHistory]);

  // Auto-load on mount + whenever the active video changes.
  useEffect(() => {
    if (canTalk) fetchHistory();
    else setDoc(null);
  }, [canTalk, fetchHistory]);

  const latest = doc?.latest;
  const lifetime = latest?.lifetime;

  // Delta between latest and prior snapshot for the view count.
  const prior = doc && doc.history.length >= 2
    ? doc.history[doc.history.length - 2]
    : null;
  const viewsDelta =
    latest && prior
      ? (latest.lifetime.views || 0) - (prior.lifetime.views || 0)
      : null;

  const retentionPoints = useMemo(() => {
    if (!latest?.retention?.length) return [];
    return latest.retention.filter(
      (p) => typeof p.t === 'number' && typeof p.ratio === 'number',
    );
  }, [latest]);

  const dailyPoints = useMemo(() => {
    if (!latest?.daily?.length) return [];
    return latest.daily.map((d) => ({
      day: String(d.day || ''),
      views: Number(d.views || 0),
    }));
  }, [latest]);

  // Don't render anything if the episode hasn't been uploaded.
  if (!videoId || !channel) return null;

  const videoUrl = uploadMeta?.last_video_url;

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <BarChart3 size={14} color="#93c5fd" />
        <span style={styles.title}>Analytics</span>
        {latest && (
          <span style={styles.freshness}>
            updated {fmtAgo(latest.pulled_at)} · {doc?.snapshot_count} snapshot
            {(doc?.snapshot_count ?? 0) === 1 ? '' : 's'}
          </span>
        )}
        <div style={{ flex: 1 }} />
        {videoUrl && (
          <a
            href={videoUrl}
            target="_blank"
            rel="noreferrer"
            style={styles.videoLink}
            title="Open on YouTube"
          >
            {videoUrl.replace(/^https?:\/\//, '')} <ExternalLink size={11} />
          </a>
        )}
        <button
          type="button"
          onClick={pullNow}
          disabled={!canTalk || pulling}
          style={{
            ...styles.pullBtn,
            ...(pulling ? { opacity: 0.6, cursor: 'wait' } : null),
          }}
          title={
            !tunnelOk
              ? 'Tunnel offline — analytics pulls run on the local tunnel'
              : pulling
                ? 'Pulling…'
                : 'Run yt-analytics-pull.py for this video right now'
          }
        >
          <RefreshCw
            size={12}
            style={pulling ? { animation: 'wm-spin 1s linear infinite' } : undefined}
          />
          {pulling ? 'pulling…' : 'pull now'}
        </button>
      </div>

      {!tunnelOk && (
        <div style={styles.warn}>
          <AlertTriangle size={12} /> Tunnel offline — can't fetch analytics.
          Start wm_server.py.
        </div>
      )}

      {error && (
        <div style={styles.errorBox}>
          <AlertTriangle size={12} /> {error}
          {error.includes('insufficient_scope') && (
            <div style={{ marginTop: 4, fontSize: 10 }}>
              Re-run <code>yt-auth.py {channel}</code> to add the analytics
              scope to this channel's token.
            </div>
          )}
        </div>
      )}

      {loading && !doc && (
        <div style={styles.dim}>loading…</div>
      )}

      {notFound && !loading && (
        <div style={styles.empty}>
          No snapshots yet for this video. Click{' '}
          <strong>pull now</strong> to fetch the first one, or wait for the
          next cron run.
        </div>
      )}

      {latest && lifetime && (
        <>
          <div style={styles.stats}>
            <Stat
              label="Views"
              value={fmtNum(lifetime.views)}
              delta={viewsDelta != null && viewsDelta !== 0 ? `+${fmtNum(viewsDelta)}` : null}
            />
            <Stat
              label="Watch time"
              value={fmtMin(lifetime.estimatedMinutesWatched)}
            />
            <Stat
              label="Subs gained"
              value={fmtNum(lifetime.subscribersGained)}
            />
            <Stat label="Likes" value={fmtNum(lifetime.likes)} />
            <Stat label="Comments" value={fmtNum(lifetime.comments)} />
            <Stat label="Shares" value={fmtNum(lifetime.shares)} />
          </div>

          <div style={styles.chartWrap}>
            <div style={styles.chartLabel}>
              Retention · {retentionPoints.length} buckets
            </div>
            <RetentionSpark points={retentionPoints} />
          </div>

          <div style={styles.chartWrap}>
            <div style={styles.chartLabel}>
              Views over time · {dailyPoints.length} day{dailyPoints.length === 1 ? '' : 's'}
            </div>
            <DailySpark points={dailyPoints} />
          </div>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  delta?: string | null;
}) {
  return (
    <div style={styles.stat}>
      <div style={styles.statLabel}>{label}</div>
      <div style={styles.statValue}>{value}</div>
      {delta && <div style={styles.statDelta}>{delta}</div>}
    </div>
  );
}

function RetentionSpark({ points }: { points: Array<{ t: number; ratio: number }> }) {
  if (!points.length) return <div style={styles.dim}>no retention data yet</div>;
  const W = 520;
  const H = 80;
  const PAD = 4;
  const max = Math.max(1, ...points.map((p) => p.ratio));
  const toX = (t: number) => PAD + t * (W - 2 * PAD);
  const toY = (r: number) => H - PAD - (r / max) * (H - 2 * PAD);
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(p.t).toFixed(2)} ${toY(p.ratio).toFixed(2)}`)
    .join(' ');
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: 80, display: 'block' }}
    >
      {/* 80% and 50% reference lines — rule of thumb for Shorts */}
      <line
        x1={PAD}
        x2={W - PAD}
        y1={toY(0.8 * max)}
        y2={toY(0.8 * max)}
        stroke="#10b981"
        strokeDasharray="3 3"
        strokeWidth={1}
        opacity={0.35}
      />
      <line
        x1={PAD}
        x2={W - PAD}
        y1={toY(0.5 * max)}
        y2={toY(0.5 * max)}
        stroke="#f59e0b"
        strokeDasharray="3 3"
        strokeWidth={1}
        opacity={0.35}
      />
      <path d={d} stroke="#93c5fd" strokeWidth={1.6} fill="none" />
      {/* X-axis ticks */}
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <text
          key={t}
          x={toX(t)}
          y={H - 0.5}
          fontSize="8"
          fill="#525252"
          textAnchor="middle"
        >
          {Math.round(t * 100)}%
        </text>
      ))}
    </svg>
  );
}

function DailySpark({ points }: { points: Array<{ day: string; views: number }> }) {
  if (!points.length) return <div style={styles.dim}>no daily data yet</div>;
  const W = 520;
  const H = 80;
  const PAD = 4;
  const max = Math.max(1, ...points.map((p) => p.views));
  const bw = (W - 2 * PAD) / Math.max(1, points.length);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: 80, display: 'block' }}
    >
      {points.map((p, i) => {
        const h = (p.views / max) * (H - 2 * PAD);
        const x = PAD + i * bw;
        const y = H - PAD - h;
        return (
          <rect
            key={p.day}
            x={x + 1}
            y={y}
            width={Math.max(1, bw - 2)}
            height={h}
            fill="#93c5fd"
            opacity={0.75}
          />
        );
      })}
      {/* First and last day labels */}
      {points.length > 0 && (
        <>
          <text x={PAD} y={H - 0.5} fontSize="8" fill="#525252">
            {points[0].day.slice(5)}
          </text>
          <text
            x={W - PAD}
            y={H - 0.5}
            fontSize="8"
            fill="#525252"
            textAnchor="end"
          >
            {points[points.length - 1].day.slice(5)}
          </text>
        </>
      )}
    </svg>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    marginTop: 10,
    padding: '10px 12px',
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  title: {
    fontSize: 12,
    fontWeight: 600,
    color: '#e5e5e5',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  freshness: {
    fontSize: 10,
    color: '#737373',
    fontFamily: 'ui-monospace, monospace',
  },
  videoLink: {
    color: '#86efac',
    fontSize: 11,
    fontFamily: 'ui-monospace, monospace',
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
  },
  pullBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    background: '#171717',
    color: '#93c5fd',
    border: '1px solid #334155',
    borderRadius: 5,
    padding: '5px 10px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  warn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    color: '#fca5a5',
  },
  errorBox: {
    padding: '6px 10px',
    background: '#450a0a',
    color: '#fca5a5',
    border: '1px solid #7f1d1d',
    borderRadius: 6,
    fontSize: 11,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  empty: {
    padding: '10px 12px',
    background: '#171717',
    border: '1px dashed #404040',
    borderRadius: 6,
    fontSize: 12,
    color: '#a3a3a3',
  },
  dim: {
    fontSize: 11,
    color: '#737373',
  },
  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
    gap: 8,
  },
  stat: {
    padding: '8px 10px',
    background: '#171717',
    border: '1px solid #262626',
    borderRadius: 6,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  statLabel: {
    fontSize: 10,
    color: '#737373',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    fontWeight: 600,
  },
  statValue: {
    fontSize: 18,
    fontWeight: 700,
    color: '#f5f5f5',
    fontFamily: 'ui-monospace, monospace',
  },
  statDelta: {
    fontSize: 10,
    color: '#86efac',
    fontFamily: 'ui-monospace, monospace',
  },
  chartWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  chartLabel: {
    fontSize: 10,
    color: '#a3a3a3',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    fontWeight: 600,
  },
};
