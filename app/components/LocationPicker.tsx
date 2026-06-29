'use client';

// Per-row location picker. Lists all locations in the project's merged
// catalog (own + subscribed library) as a scrollable grid of thumbnails.
// Click one to bind this segment to that location. Click "clear" to unbind.
// PATCHes the timeline via /api/projects/{id}/timeline.

import { useCallback, useEffect, useRef, useState } from 'react';

type Location = {
  id: string;
  name: string;
  image_url: string;
  description: string;
  from_library?: string;
};

export default function LocationPicker({
  projectId,
  segId,
  current,
  onChange,
  compact = false,
}: {
  projectId: string;
  segId: string;
  current: string | undefined;
  // Optimistic local patch — parent updates bundle.timeline so the row
  // re-renders with the new binding before the server round-trip.
  onChange: (next: string) => void;
  /** Narrow-desktop mode: tighter padding + truncated label. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<Location[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const load = useCallback(async () => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    setError(null);
    try {
      const r = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/locations`,
        { cache: 'no-store' },
      );
      if (!r.ok) {
        setError(`Failed to load catalog: ${r.status}`);
        setCatalog([]);
        return;
      }
      const data = (await r.json()) as { locations: Location[] };
      setCatalog(data.locations || []);
    } catch (e: any) {
      setError(String(e?.message || e).slice(0, 120));
      setCatalog([]);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const commit = async (next: string) => {
    const prior = current ?? '';
    if (next === prior) {
      setOpen(false);
      return;
    }
    setBusy(true);
    onChange(next); // optimistic
    try {
      const r = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/timeline`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seg_id: segId, location: next }),
        },
      );
      if (!r.ok) {
        onChange(prior);
        setError(`Save failed: ${(await r.text()).slice(0, 120)}`);
        return;
      }
    } catch (e: any) {
      onChange(prior);
      setError(String(e?.message || e).slice(0, 120));
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const selected = (catalog || []).find((l) => l.id === current);
  const label = current
    ? (selected?.name ? selected.name : current)
    : 'none';

  return (
    <div style={styles.wrap}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ ...styles.trigger, ...(compact ? styles.triggerCompact : null) }}
        title={`Location — ${current ?? 'not set'}`}
      >
        🏠 {label}
        <span style={styles.chev}>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <>
          <div style={styles.backdrop} onClick={() => setOpen(false)} />
          <div style={styles.popover}>
            <div style={styles.popHeader}>
              Bind this segment to a location
            </div>
            {error && <div style={styles.error}>{error}</div>}
            {!catalog && !error && <div style={styles.loading}>Loading catalog…</div>}
            {catalog && catalog.length === 0 && (
              <div style={styles.empty}>
                No locations defined yet. Add some in the References panel above.
              </div>
            )}
            {catalog && catalog.length > 0 && (
              <div style={styles.grid}>
                <button
                  type="button"
                  onClick={() => commit('')}
                  disabled={busy}
                  style={{
                    ...styles.card,
                    ...(current ? null : styles.cardSelected),
                  }}
                  title="No location binding"
                >
                  <div style={styles.noneTile}>∅ none</div>
                  <div style={styles.cardLabel}>No binding</div>
                </button>
                {catalog.map((loc) => {
                  const isSelected = loc.id === current;
                  return (
                    <button
                      key={loc.id}
                      type="button"
                      onClick={() => commit(loc.id)}
                      disabled={busy}
                      style={{
                        ...styles.card,
                        ...(isSelected ? styles.cardSelected : null),
                      }}
                      title={loc.description}
                    >
                      <div
                        style={{
                          ...styles.thumb,
                          backgroundImage: `url(${loc.image_url})`,
                        }}
                      />
                      <div style={styles.cardLabel}>
                        {loc.name}
                        {loc.from_library && <span style={styles.libraryBadge}>🔗</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { position: 'relative', display: 'inline-flex' },
  trigger: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: '#171717',
    color: '#e5e5e5',
    border: '1px solid #404040',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    maxWidth: 180,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  triggerCompact: {
    padding: '4px 8px',
    fontSize: 11,
    maxWidth: 110,
  },
  chev: { fontSize: 9, color: '#737373', marginLeft: 2 },
  backdrop: { position: 'fixed', inset: 0, zIndex: 40 },
  popover: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    right: 0,
    zIndex: 50,
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 10,
    padding: 10,
    width: 420,
    maxWidth: 'calc(100vw - 24px)',
    maxHeight: '60vh',
    overflowY: 'auto',
    boxShadow: '0 18px 36px rgba(0,0,0,0.55)',
  },
  popHeader: {
    fontSize: 11,
    color: '#a3a3a3',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontWeight: 600,
    marginBottom: 8,
  },
  loading: { fontSize: 12, color: '#a3a3a3', padding: 12, textAlign: 'center' },
  empty: { fontSize: 12, color: '#737373', padding: 12, textAlign: 'center', fontStyle: 'italic' },
  error: {
    fontSize: 11,
    color: '#fca5a5',
    background: '#1f0d0d',
    border: '1px solid #7f1d1d',
    borderRadius: 6,
    padding: 8,
    marginBottom: 8,
    lineHeight: 1.4,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
    gap: 6,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    background: '#171717',
    border: '1px solid #262626',
    borderRadius: 6,
    padding: 6,
    cursor: 'pointer',
    color: '#f5f5f5',
    fontFamily: 'inherit',
    textAlign: 'left' as const,
  },
  cardSelected: {
    borderColor: '#7c3aed',
    background: '#1e1b4b',
  },
  thumb: {
    width: '100%',
    aspectRatio: '16 / 9',
    borderRadius: 4,
    backgroundColor: '#0a0a0a',
    backgroundSize: 'cover',
    backgroundPosition: 'center',
  },
  noneTile: {
    width: '100%',
    aspectRatio: '16 / 9',
    borderRadius: 4,
    background: '#0a0a0a',
    border: '1px dashed #404040',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#525252',
    fontSize: 12,
  },
  cardLabel: {
    fontSize: 11,
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  libraryBadge: {
    fontSize: 9,
    color: '#60a5fa',
  },
};
