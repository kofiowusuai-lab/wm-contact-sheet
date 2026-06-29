'use client';

// Location catalog UI inside the References panel. Each location tile shows
// the master image, name, and a truncated description. Library-sourced
// entries get a 🔗 badge and a Fork button instead of Edit. Add flow:
// paste/upload image → name → Gemini auto-fills the description → Save.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useIsMobile } from '../lib/useMediaQuery';
import { generateAspectVariant } from '../lib/reframeImage';
import type { AspectId } from '../lib/aspectRatios';

type Location = {
  id: string;
  name: string;
  image_url: string;
  description: string;
  from_library?: string;
  tags?: string[];
  variants?: Record<string, string>;
};

type Library = {
  id: string;
  name: string;
  owner_project_id: string;
  updated_at: string;
};

export default function LocationsZone({
  projectId,
  libraryId,
  onLibraryChange,
  flash,
  projectAspect,
}: {
  projectId: string;
  libraryId?: string;
  onLibraryChange: (next: string | null) => void;
  flash: (msg: string) => void;
  /** Active project's aspect. Non-16:9 enables per-tile + bulk variant
   *  generation buttons — see app/lib/reframeImage.ts. */
  projectAspect?: string;
}) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addName, setAddName] = useState('');
  const [addDataUrl, setAddDataUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [snapshotName, setSnapshotName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();
  const [variantBusy, setVariantBusy] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);

  const variantAspect =
    projectAspect && projectAspect !== '16:9'
      ? (projectAspect as AspectId)
      : null;
  // Only project-owned locations count toward the missing-variant total —
  // library-sourced locations can't have variants generated without a
  // fork first.
  const missingVariantCount = variantAspect
    ? locations.filter((l) => !l.from_library && !l.variants?.[variantAspect]).length
    : 0;

  const generateVariantFor = useCallback(
    async (loc: Location) => {
      if (!variantAspect) return;
      if (loc.from_library) {
        flash('Library-sourced location — fork it first to generate a variant');
        return;
      }
      setVariantBusy((prev) => new Set(prev).add(loc.id));
      try {
        const clampedDataUrl = await generateAspectVariant(
          loc.image_url,
          variantAspect,
          projectId,
        );
        const resp = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(loc.id)}/variant`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              aspect: variantAspect,
              image_data_url: clampedDataUrl,
            }),
          },
        );
        if (!resp.ok) {
          flash(`Variant save failed: ${(await resp.text()).slice(0, 100)}`);
          return;
        }
        const j = await resp.json().catch(() => ({}));
        if (j?.location) {
          setLocations((prev) =>
            prev.map((l) => (l.id === loc.id ? (j.location as Location) : l)),
          );
        }
      } catch (e: any) {
        flash(`Variant generation error: ${String(e?.message || e).slice(0, 120)}`);
      } finally {
        setVariantBusy((prev) => {
          const next = new Set(prev);
          next.delete(loc.id);
          return next;
        });
      }
    },
    [projectId, variantAspect, flash],
  );

  const generateAllMissing = useCallback(async () => {
    if (!variantAspect) return;
    const missing = locations.filter(
      (l) => !l.from_library && !l.variants?.[variantAspect],
    );
    if (missing.length === 0) return;
    for (let i = 0; i < missing.length; i++) {
      setBulkBusy(`Generating ${i + 1}/${missing.length}…`);
      await generateVariantFor(missing[i]);
      if (i < missing.length - 1) {
        await new Promise((res) => setTimeout(res, 500));
      }
    }
    setBulkBusy(null);
    flash(
      `Generated ${missing.length} ${variantAspect} variant${missing.length === 1 ? '' : 's'}`,
    );
  }, [locations, variantAspect, generateVariantFor, flash]);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/locations`,
        { cache: 'no-store' },
      );
      if (r.ok) {
        const data = (await r.json()) as { locations: Location[] };
        setLocations(data.locations || []);
      }
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const loadLibraries = useCallback(async () => {
    try {
      const r = await fetch('/api/locations/library', { cache: 'no-store' });
      if (r.ok) {
        const data = (await r.json()) as { libraries: Library[] };
        setLibraries(data.libraries || []);
      }
    } catch {}
  }, []);

  useEffect(() => {
    loadCatalog();
    loadLibraries();
  }, [loadCatalog, loadLibraries]);

  const onPickFile = useCallback(
    (file: File) => {
      const maxW = 1920;
      const maxH = 1080;
      (async () => {
        try {
          const bitmap = await createImageBitmap(file);
          const scale = Math.min(1, maxW / bitmap.width, maxH / bitmap.height);
          const w = Math.max(1, Math.round(bitmap.width * scale));
          const h = Math.max(1, Math.round(bitmap.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          ctx.drawImage(bitmap, 0, 0, w, h);
          bitmap.close?.();
          setAddDataUrl(canvas.toDataURL('image/jpeg', 0.88));
        } catch {
          const reader = new FileReader();
          reader.onload = () => setAddDataUrl(String(reader.result));
          reader.readAsDataURL(file);
        }
      })();
    },
    [],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            onPickFile(file);
            return;
          }
        }
      }
    },
    [onPickFile],
  );

  const commitAdd = async () => {
    const name = addName.trim();
    if (!name) {
      flash('Name the location first');
      return;
    }
    if (!addDataUrl) {
      flash('Paste or upload a master image first');
      return;
    }
    setAddBusy(true);
    try {
      const r = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/locations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, data_url: addDataUrl }),
        },
      );
      if (!r.ok) {
        flash(`Add failed: ${(await r.text()).slice(0, 140)}`);
        return;
      }
      const data = await r.json();
      flash(
        data?.auto_described
          ? `Location saved. Gemini described it for you — edit if needed.`
          : `Location saved.`,
      );
      setShowAdd(false);
      setAddName('');
      setAddDataUrl(null);
      await loadCatalog();
    } finally {
      setAddBusy(false);
    }
  };

  const editDescription = async (id: string, nextDescription: string) => {
    const r = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/locations`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, description: nextDescription }),
      },
    );
    if (!r.ok) {
      flash(`Save failed: ${(await r.text()).slice(0, 120)}`);
      return;
    }
    setEditing(null);
    await loadCatalog();
  };

  const removeLocation = async (id: string) => {
    if (!confirm(`Delete location "${id}"? This can't be undone.`)) return;
    const r = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/locations?id=${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    if (!r.ok) {
      flash(`Delete failed: ${(await r.text()).slice(0, 120)}`);
      return;
    }
    await loadCatalog();
  };

  const forkLocation = async (id: string) => {
    const r = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/locations/fork`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: id }),
      },
    );
    if (!r.ok) {
      flash(`Fork failed: ${(await r.text()).slice(0, 120)}`);
      return;
    }
    flash(`Forked "${id}" into this episode`);
    await loadCatalog();
  };

  const subscribe = async (nextId: string) => {
    if (!nextId) return;
    const r = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/locations/subscribe`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ library_id: nextId }),
      },
    );
    if (!r.ok) {
      flash(`Subscribe failed: ${(await r.text()).slice(0, 120)}`);
      return;
    }
    onLibraryChange(nextId);
    await loadCatalog();
    flash(`Subscribed to library ${nextId}`);
  };

  const unsubscribe = async () => {
    const r = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/locations/subscribe`,
      { method: 'DELETE' },
    );
    if (!r.ok) {
      flash(`Unsubscribe failed: ${(await r.text()).slice(0, 120)}`);
      return;
    }
    onLibraryChange(null);
    await loadCatalog();
    flash('Unsubscribed from library');
  };

  const snapshotToLibrary = async () => {
    const name = snapshotName.trim() || `${projectId} locations`;
    const r = await fetch('/api/locations/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, name }),
    });
    if (!r.ok) {
      flash(`Snapshot failed: ${(await r.text()).slice(0, 120)}`);
      return;
    }
    const data = await r.json();
    flash(`Snapshotted to library "${name}" (${data.library_id})`);
    setSnapshotName('');
    await loadLibraries();
  };

  const ownedCount = locations.filter((l) => !l.from_library).length;
  return (
    <div style={styles.wrap}>
      <div style={styles.headerRow}>
        <span style={styles.headerTitle}>
          LOCATIONS{locations.length > 0 && <span style={styles.count}> · {locations.length}</span>}
        </span>
        {variantAspect && ownedCount > 0 && (
          <button
            type="button"
            onClick={generateAllMissing}
            disabled={missingVariantCount === 0 || !!bulkBusy}
            style={{
              ...styles.variantBulkBtn,
              ...(missingVariantCount === 0 ? styles.variantBulkBtnDone : null),
              ...(bulkBusy ? styles.variantBulkBtnBusy : null),
            }}
            title={
              missingVariantCount === 0
                ? `Every owned location already has a ${variantAspect} variant.`
                : `Generate a ${variantAspect} variant for each owned location that's missing one.`
            }
          >
            {bulkBusy
              ? bulkBusy
              : missingVariantCount === 0
                ? `✓ ${variantAspect} variants ready`
                : `📐 Generate ${variantAspect} for all (${missingVariantCount} missing)`}
          </button>
        )}
        <select
          value={libraryId || ''}
          onChange={(e) => {
            const v = e.target.value;
            if (v) subscribe(v);
            else unsubscribe();
          }}
          style={{ ...styles.select, ...(isMobile ? styles.selectMobile : null) }}
          title="Subscribe this episode to a shared location library"
        >
          <option value="">No library linked</option>
          {libraries.map((lib) => (
            <option key={lib.id} value={lib.id}>
              🔗 {lib.name}
            </option>
          ))}
        </select>
      </div>
      {ownedCount > 0 && (
        <div style={styles.snapshotRow}>
          <input
            type="text"
            placeholder={`Snapshot ${ownedCount} owned location${ownedCount === 1 ? '' : 's'} as a new library…`}
            value={snapshotName}
            onChange={(e) => setSnapshotName(e.target.value)}
            style={{ ...styles.input, ...(isMobile ? styles.inputMobile : null) }}
          />
          <button
            type="button"
            onClick={snapshotToLibrary}
            style={styles.btnSmall}
            title="Snapshot this episode's owned locations into a new shared library future episodes can subscribe to"
          >
            📸 Snapshot
          </button>
        </div>
      )}

      {loading && <div style={styles.loading}>Loading…</div>}

      {!loading && (
        <div style={styles.grid} onPaste={onPaste} tabIndex={0}>
          {locations.map((loc) => {
            const isLibraryRef = Boolean(loc.from_library);
            const isEditing = editing === loc.id;
            const isVariantBusy = variantBusy.has(loc.id);
            const hasVariant = Boolean(
              variantAspect && loc.variants?.[variantAspect],
            );
            return (
              <div
                key={loc.id}
                style={{
                  ...styles.card,
                  ...(isLibraryRef ? styles.cardLibrary : null),
                }}
              >
                <div style={{ position: 'relative' }}>
                  <div
                    style={{
                      ...styles.thumb,
                      backgroundImage: `url(${loc.image_url})`,
                    }}
                  />
                  {variantAspect && (
                    <button
                      type="button"
                      onClick={() => {
                        if (isVariantBusy || isLibraryRef) return;
                        generateVariantFor(loc);
                      }}
                      disabled={isVariantBusy || isLibraryRef}
                      style={{
                        ...styles.variantBadge,
                        ...(hasVariant ? styles.variantBadgeReady : null),
                        ...(isVariantBusy ? styles.variantBadgeBusy : null),
                        ...(isLibraryRef ? styles.variantBadgeLocked : null),
                      }}
                      title={
                        isLibraryRef
                          ? 'Fork this library location first to generate a variant'
                          : isVariantBusy
                            ? `Generating ${variantAspect} variant…`
                            : hasVariant
                              ? `${variantAspect} variant ready — click to regenerate`
                              : `Generate a ${variantAspect} variant of this plate`
                      }
                      aria-label={hasVariant ? `${variantAspect} variant ready` : `Generate ${variantAspect} variant`}
                    >
                      {isVariantBusy ? '…' : hasVariant ? `✓ ${variantAspect}` : `📐 ${variantAspect}`}
                    </button>
                  )}
                </div>
                <div style={styles.cardHead}>
                  <span style={styles.cardName}>
                    {loc.name}
                    {isLibraryRef && <span style={styles.libraryBadge}>🔗</span>}
                  </span>
                  <span style={styles.cardId}>{loc.id}</span>
                </div>
                {isEditing ? (
                  <EditDescription
                    initial={loc.description}
                    onSave={(next) => editDescription(loc.id, next)}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <div style={styles.desc} title={loc.description}>
                    {loc.description || <em style={styles.empty}>no description</em>}
                  </div>
                )}
                <div style={styles.actions}>
                  {isLibraryRef ? (
                    <button onClick={() => forkLocation(loc.id)} style={styles.btnAction}>
                      Fork
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => setEditing(isEditing ? null : loc.id)}
                        style={styles.btnAction}
                      >
                        {isEditing ? 'Done' : 'Edit'}
                      </button>
                      <button onClick={() => removeLocation(loc.id)} style={styles.btnRemove}>
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}

          {!showAdd && (
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              style={styles.addTile}
              title="Paste or upload a master image, name the location, and Gemini will describe it"
            >
              + Add location
            </button>
          )}
          {showAdd && (
            <div style={styles.addCard}>
              <div
                style={{
                  ...styles.thumb,
                  backgroundImage: addDataUrl ? `url(${addDataUrl})` : 'none',
                  backgroundColor: '#0a0a0a',
                }}
                onClick={() => fileInputRef.current?.click()}
                tabIndex={0}
                onPaste={onPaste}
              >
                {!addDataUrl && <span style={styles.addHint}>click / paste image</span>}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onPickFile(f);
                  e.target.value = '';
                }}
              />
              <input
                type="text"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder="Location name (e.g. bedroom_main)"
                style={{ ...styles.addNameInput, ...(isMobile ? styles.addNameInputMobile : null) }}
              />
              <div style={styles.actions}>
                <button
                  type="button"
                  onClick={commitAdd}
                  disabled={addBusy || !addName.trim() || !addDataUrl}
                  style={styles.btnPrimary}
                >
                  {addBusy ? '…saving' : 'Save (Gemini describes)'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAdd(false);
                    setAddName('');
                    setAddDataUrl(null);
                  }}
                  disabled={addBusy}
                  style={styles.btnAction}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EditDescription({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (next: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const isMobile = useIsMobile();
  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={{ ...styles.descEdit, ...(isMobile ? styles.descEditMobile : null) }}
      />
      <div style={styles.actions}>
        <button onClick={() => onSave(text)} style={styles.btnPrimary}>
          Save
        </button>
        <button onClick={onCancel} style={styles.btnAction}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    background: '#171717',
    border: '1px solid #262626',
    borderRadius: 8,
    padding: 10,
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 6,
    flexWrap: 'wrap',
  },
  headerTitle: {
    fontSize: 11,
    color: '#a3a3a3',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    fontWeight: 600,
  },
  count: { color: '#e5e5e5', fontWeight: 600 },
  snapshotRow: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
    marginBottom: 8,
  },
  select: {
    background: '#0a0a0a',
    color: '#e5e5e5',
    border: '1px solid #404040',
    borderRadius: 5,
    padding: '4px 8px',
    fontSize: 11,
    maxWidth: 240,
  },
  input: {
    background: '#0a0a0a',
    color: '#e5e5e5',
    border: '1px solid #404040',
    borderRadius: 5,
    padding: '4px 8px',
    fontSize: 11,
    flex: 1,
    minWidth: 120,
  },
  btnSmall: {
    background: '#262626',
    color: '#e5e5e5',
    border: '1px solid #404040',
    borderRadius: 5,
    padding: '4px 8px',
    fontSize: 11,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  loading: { padding: 20, color: '#737373', fontSize: 12, textAlign: 'center' },
  grid: {
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'nowrap',
    gap: 8,
    padding: 6,
    border: '2px dashed #404040',
    borderRadius: 8,
    outline: 'none',
    overflowX: 'auto',
    overflowY: 'hidden',
    scrollSnapType: 'x proximity',
    WebkitOverflowScrolling: 'touch',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 6,
    padding: 6,
    flex: '0 0 180px',
    width: 180,
    scrollSnapAlign: 'start',
  },
  cardLibrary: {
    borderColor: '#3b82f6',
    background: '#0c1e3a',
  },
  thumb: {
    width: '100%',
    aspectRatio: '16 / 9',
    borderRadius: 4,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundColor: '#0a0a0a',
    cursor: 'pointer',
  },
  cardHead: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    marginTop: 2,
  },
  cardName: {
    fontSize: 12,
    fontWeight: 600,
    color: '#f5f5f5',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  cardId: {
    fontSize: 10,
    color: '#737373',
    fontFamily: 'ui-monospace, monospace',
  },
  libraryBadge: { fontSize: 10, color: '#60a5fa' },
  desc: {
    fontSize: 10,
    color: '#a3a3a3',
    lineHeight: 1.35,
    display: '-webkit-box',
    WebkitLineClamp: 4,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  descEdit: {
    width: '100%',
    minHeight: 80,
    resize: 'vertical',
    background: '#171717',
    color: '#e5e5e5',
    border: '1px solid #404040',
    borderRadius: 4,
    padding: 6,
    fontFamily: 'inherit',
    fontSize: 11,
    lineHeight: 1.4,
    boxSizing: 'border-box',
  },
  empty: { color: '#525252' },
  actions: {
    display: 'flex',
    gap: 4,
    justifyContent: 'flex-end',
    marginTop: 4,
  },
  btnAction: {
    background: '#171717',
    color: '#e5e5e5',
    border: '1px solid #404040',
    borderRadius: 4,
    padding: '3px 8px',
    fontSize: 11,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnRemove: {
    background: '#450a0a',
    color: '#fca5a5',
    border: '1px solid #7f1d1d',
    borderRadius: 4,
    padding: '3px 8px',
    fontSize: 11,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnPrimary: {
    background: '#7c3aed',
    color: '#fff',
    border: '1px solid #6d28d9',
    borderRadius: 4,
    padding: '3px 8px',
    fontSize: 11,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontWeight: 600,
  },
  addTile: {
    aspectRatio: '16 / 9',
    maxWidth: 220,
    border: '2px dashed #525252',
    borderRadius: 6,
    background: '#0a0a0a',
    color: '#737373',
    fontSize: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    fontFamily: 'inherit',
    justifySelf: 'start',
  },
  addCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    background: '#0a0a0a',
    border: '1px solid #7c3aed',
    borderRadius: 6,
    padding: 6,
  },
  addHint: { color: '#525252', fontSize: 11 },
  addNameInput: {
    width: '100%',
    background: '#171717',
    color: '#e5e5e5',
    border: '1px solid #404040',
    borderRadius: 4,
    padding: '5px 8px',
    fontSize: 12,
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  },
  // Mobile overrides — bump fontSize to 16px on tap targets so iOS Safari
  // does not auto-zoom when an input gains focus. Bump minHeight to 40+
  // so the touch target is usable. The header select goes full-width so
  // it does not compete with the LOCATIONS label in a narrow wrap row.
  selectMobile: {
    fontSize: 16,
    maxWidth: '100%',
    width: '100%',
    minHeight: 40,
  },
  inputMobile: {
    fontSize: 16,
    minHeight: 40,
  },
  descEditMobile: {
    fontSize: 16,
    minHeight: 120,
  },
  addNameInputMobile: {
    fontSize: 16,
    minHeight: 40,
  },
  // Aspect-variant badge anchored to the top-right of each location
  // thumb. Amber = variant ready, dim outline = missing, grey/locked =
  // library-sourced (must fork first).
  variantBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    height: 22,
    minWidth: 46,
    padding: '0 6px',
    borderRadius: 4,
    background: 'rgba(10,10,10,0.82)',
    color: '#a3a3a3',
    border: '1px solid #404040',
    fontSize: 10,
    fontFamily: 'ui-monospace, monospace',
    fontWeight: 700,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
    letterSpacing: 0.3,
  },
  variantBadgeReady: {
    color: '#fde68a',
    borderColor: '#f59e0b',
    background: 'rgba(59,36,10,0.92)',
  },
  variantBadgeBusy: {
    color: '#d4d4d4',
    borderColor: '#737373',
    background: 'rgba(10,10,10,0.92)',
    cursor: 'wait',
  },
  variantBadgeLocked: {
    color: '#525252',
    borderColor: '#262626',
    cursor: 'not-allowed',
  },
  variantBulkBtn: {
    background: '#171717',
    color: '#fde68a',
    border: '1px solid #b45309',
    borderRadius: 6,
    padding: '5px 10px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  },
  variantBulkBtnDone: {
    color: '#86efac',
    borderColor: '#22c55e',
    background: 'rgba(22,83,44,0.35)',
    cursor: 'default',
  },
  variantBulkBtnBusy: {
    color: '#d4d4d4',
    borderColor: '#737373',
    cursor: 'wait',
  },
};
