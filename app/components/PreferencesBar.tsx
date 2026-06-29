'use client';

// Learned preferences widget. Shows the last Gemini-mined preference profile
// (summary + rule list with confidence bars) and a refresh button that
// re-reads the changelog and re-asks Gemini. Cheap: one Gemini 2.5 Flash call
// per press, ~3s typical, pennies per refresh.

import { useCallback, useEffect, useState } from 'react';
import { useIsMobile } from '../lib/useMediaQuery';

type Rule = {
  topic?: string;
  rule?: string;
  confidence?: number;
  evidence_count?: number;
  examples?: string[];
};

type Preferences = {
  summary?: string;
  rules?: Rule[];
  updated_at?: string;
  events_analyzed?: number;
  model?: string;
} | null;

function humanAgo(iso?: string): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms) || ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function PreferencesBar({
  projectId,
  flash,
}: {
  projectId: string;
  flash: (msg: string) => void;
}) {
  const [prefs, setPrefs] = useState<Preferences>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const isMobile = useIsMobile();

  const load = useCallback(async () => {
    try {
      const r = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/preferences`,
        { cache: 'no-store' },
      );
      if (r.ok) {
        const j = await r.json();
        setPrefs(j.preferences ?? null);
      }
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    setLoaded(false);
    setPrefs(null);
    setStatus(null);
    load();
  }, [projectId, load]);

  const refresh = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStatus('Asking Gemini to mine the changelog…');
    try {
      const r = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/preferences/refresh`,
        { method: 'POST' },
      );
      if (!r.ok) {
        const errTxt = (await r.text()).slice(0, 160);
        setStatus(`Refresh failed: ${errTxt}`);
        flash(`Preferences refresh failed: ${errTxt}`);
        return;
      }
      const fresh = (await r.json()) as Preferences;
      setPrefs(fresh);
      setExpanded(true);
      const ruleCount = fresh?.rules?.length ?? 0;
      const eventCount = fresh?.events_analyzed ?? 0;
      setStatus(`✓ ${ruleCount} rules from ${eventCount} events`);
      flash(`Preferences updated — ${ruleCount} rules`);
    } catch (e: any) {
      setStatus(`Error: ${String(e?.message || e).slice(0, 140)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, projectId, flash]);

  const rules = prefs?.rules ?? [];
  const ruleCount = rules.length;

  return (
    <div style={styles.bar}>
      <div style={{ ...styles.headerRow, ...(isMobile ? styles.headerRowMobile : null) }}>
        <div style={styles.titleBlock}>
          <div style={styles.title}>🧠 Learned preferences</div>
          <div style={styles.meta}>
            {!loaded
              ? 'loading…'
              : prefs
                ? `${ruleCount} rule${ruleCount === 1 ? '' : 's'} · ${prefs.events_analyzed ?? 0} events · ${humanAgo(prefs.updated_at)}`
                : 'nothing learned yet — hit Refresh'}
          </div>
        </div>
        <div style={{ ...styles.actions, ...(isMobile ? styles.actionsMobile : null) }}>
          {ruleCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              style={{ ...styles.btnGhost, ...(isMobile ? styles.btnGhostMobile : null) }}
            >
              {expanded ? 'Hide rules' : `Show rules (${ruleCount})`}
            </button>
          )}
          <button
            type="button"
            onClick={refresh}
            disabled={busy}
            style={{
              ...styles.btnRefresh,
              ...(isMobile ? styles.btnRefreshMobile : null),
              opacity: busy ? 0.55 : 1,
              cursor: busy ? 'wait' : 'pointer',
            }}
            title="Ask Gemini to re-read the changelog and re-infer preferences"
          >
            {busy ? '…thinking' : '🔄 Refresh from history'}
          </button>
        </div>
      </div>
      {prefs?.summary && (
        <div style={styles.summary}>{prefs.summary}</div>
      )}
      {status && <div style={styles.status}>{status}</div>}
      {expanded && ruleCount > 0 && (
        <div style={styles.rules}>
          {rules.map((r, i) => {
            const conf = Math.max(0, Math.min(1, r.confidence ?? 0));
            const pct = Math.round(conf * 100);
            const tint = conf >= 0.85 ? '#22c55e' : conf >= 0.65 ? '#3b82f6' : '#fbbf24';
            return (
              <div key={i} style={styles.ruleCard}>
                <div style={styles.ruleHead}>
                  <span style={{ ...styles.topic, background: `${tint}22`, color: tint, borderColor: `${tint}66` }}>
                    {r.topic || 'rule'}
                  </span>
                  <div style={styles.confTrack}>
                    <div style={{ ...styles.confFill, width: `${pct}%`, background: tint }} />
                  </div>
                  <span style={styles.confPct}>{pct}%</span>
                  <span style={styles.evidence}>{r.evidence_count ?? 0} ex.</span>
                </div>
                <div style={styles.ruleText}>{r.rule || '(no rule text)'}</div>
                {r.examples && r.examples.length > 0 && (
                  <ul style={styles.exampleList}>
                    {r.examples.slice(0, 3).map((ex, j) => (
                      <li key={j} style={styles.exampleItem}>{ex}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    marginTop: 10,
    padding: '12px 14px',
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  headerRowMobile: {
    alignItems: 'stretch',
  },
  titleBlock: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
  title: {
    fontSize: 12,
    fontWeight: 600,
    color: '#e5e5e5',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  meta: { fontSize: 11, color: '#a3a3a3' },
  actions: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  actionsMobile: { width: '100%', marginTop: 4 },
  btnGhost: {
    background: 'transparent',
    color: '#a3a3a3',
    border: '1px solid #404040',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer',
  },
  btnGhostMobile: {
    flex: '1 1 auto',
    padding: '10px 12px',
    fontSize: 13,
    minHeight: 42,
  },
  btnRefresh: {
    background: '#1e1b4b',
    color: '#e0e7ff',
    border: '1px solid #6d28d9',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  btnRefreshMobile: {
    flex: '1 1 100%',
    padding: '10px 14px',
    fontSize: 13,
    minHeight: 44,
  },
  summary: {
    fontSize: 13,
    color: '#e5e5e5',
    lineHeight: 1.5,
    padding: '8px 10px',
    background: '#171717',
    border: '1px solid #262626',
    borderRadius: 6,
  },
  status: { fontSize: 11, color: '#a3a3a3' },
  rules: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 2,
  },
  ruleCard: {
    padding: '8px 10px',
    background: '#171717',
    border: '1px solid #262626',
    borderRadius: 6,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  ruleHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  topic: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    padding: '2px 8px',
    border: '1px solid',
    borderRadius: 4,
  },
  confTrack: {
    flex: 1,
    minWidth: 60,
    height: 4,
    background: '#262626',
    borderRadius: 2,
    overflow: 'hidden',
  },
  confFill: { height: '100%', borderRadius: 2 },
  confPct: {
    fontSize: 10,
    color: '#a3a3a3',
    fontFamily: 'var(--font-plex-mono), ui-monospace, monospace',
    minWidth: 32,
    textAlign: 'right',
  },
  evidence: {
    fontSize: 10,
    color: '#737373',
    fontFamily: 'var(--font-plex-mono), ui-monospace, monospace',
  },
  ruleText: {
    fontSize: 12,
    color: '#e5e5e5',
    lineHeight: 1.45,
  },
  exampleList: {
    margin: 0,
    paddingLeft: 16,
    fontSize: 11,
    color: '#a3a3a3',
    lineHeight: 1.4,
  },
  exampleItem: { marginBottom: 2 },
};
