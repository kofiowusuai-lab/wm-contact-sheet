'use client';

import { useCallback, useRef, useState } from 'react';
import type { Ref, RefKind } from '../lib/blob';
import { pasteEventImages, uploadFileToFal } from '../lib/uploadImage';
import { useIsMobile } from '../lib/useMediaQuery';
import { generateAspectVariant } from '../lib/reframeImage';
import type { AspectId } from '../lib/aspectRatios';

export default function ReferenceZone({
  projectId,
  kind,
  refs,
  onChanged,
  flash,
  characterSuggestions = [],
  projectAspect,
}: {
  projectId: string;
  kind: RefKind;
  refs: Ref[];
  // If the server returned the canonical list, pass it so the parent can
  // patch state immediately. Callers fall back to a full refetch otherwise.
  onChanged: (nextRefs?: Ref[]) => void;
  flash: (msg: string) => void;
  /** Uppercased character slugs the user has already set up (Cast panel +
   *  speakers parsed from the live script). Used to pre-populate the
   *  per-ref character picker dropdown. Only meaningful for
   *  kind="characters". */
  characterSuggestions?: string[];
  /** Active project's aspect. When non-default ('16:9'), enables the
   *  per-tile aspect-variant buttons + the panel-level bulk button.
   *  Variants for this aspect get generated via app/lib/reframeImage.ts
   *  and attached to each ref's `variants[aspect]` slot. */
  projectAspect?: string;
}) {
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();
  // Per-ref busy set — each URL currently generating a variant. Used to
  // render the spinner on a single tile without blocking the others.
  const [variantBusy, setVariantBusy] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);

  // Only meaningful on non-default aspects. 16:9 is the default — no
  // variants needed.
  const variantAspect =
    projectAspect && projectAspect !== '16:9'
      ? (projectAspect as AspectId)
      : null;
  const missingVariantCount = variantAspect
    ? refs.filter((r) => !r.variants?.[variantAspect]).length
    : 0;

  const generateVariantFor = useCallback(
    async (r: Ref) => {
      if (!variantAspect) return;
      setVariantBusy((prev) => new Set(prev).add(r.url));
      try {
        const clampedDataUrl = await generateAspectVariant(
          r.url,
          variantAspect,
          projectId,
        );
        const resp = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/refs/${kind}/variant`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: r.url,
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
        if (Array.isArray(j?.refs)) onChanged(j.refs as Ref[]);
      } catch (e: any) {
        flash(`Variant generation error: ${String(e?.message || e).slice(0, 120)}`);
      } finally {
        setVariantBusy((prev) => {
          const next = new Set(prev);
          next.delete(r.url);
          return next;
        });
      }
    },
    [projectId, kind, variantAspect, onChanged, flash],
  );

  const generateAllMissing = useCallback(async () => {
    if (!variantAspect) return;
    const missing = refs.filter((r) => !r.variants?.[variantAspect]);
    if (missing.length === 0) return;
    for (let i = 0; i < missing.length; i++) {
      setBulkBusy(`Generating ${i + 1}/${missing.length}…`);
      await generateVariantFor(missing[i]);
      // 500ms backoff to stay well under FAL rate limits.
      if (i < missing.length - 1) {
        await new Promise((res) => setTimeout(res, 500));
      }
    }
    setBulkBusy(null);
    flash(`Generated ${missing.length} ${variantAspect} variant${missing.length === 1 ? '' : 's'}`);
  }, [refs, variantAspect, generateVariantFor, flash]);

  const addFile = useCallback(
    async (file: File) => {
      setBusy(true);
      try {
        const url = await uploadFileToFal(file, projectId);
        if (!url) {
          flash('Upload to FAL failed');
          return;
        }
        const r = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/refs/${kind}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
          },
        );
        if (!r.ok) {
          flash(`Save failed: ${(await r.text()).slice(0, 80)}`);
          return;
        }
        const j = await r.json().catch(() => ({}));
        flash(`Added to ${kind}`);
        onChanged(Array.isArray(j?.refs) ? (j.refs as Ref[]) : undefined);
      } finally {
        setBusy(false);
      }
    },
    [projectId, kind, onChanged, flash],
  );

  const onPaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const files = pasteEventImages(e);
      if (files.length === 0) return;
      e.preventDefault();
      for (const f of files) await addFile(f);
    },
    [addFile],
  );

  const onFileInput = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      for (const f of files) await addFile(f);
      e.target.value = ''; // allow re-selecting the same file later
    },
    [addFile],
  );

  const saveNotes = useCallback(
    async (url: string, notes: string) => {
      const r = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/refs/${kind}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, notes }),
        },
      );
      if (!r.ok) {
        flash('Notes save failed');
        return;
      }
      const j = await r.json().catch(() => ({}));
      if (Array.isArray(j?.refs)) onChanged(j.refs as Ref[]);
    },
    [projectId, kind, onChanged, flash],
  );

  // Optimistic character-tag save. Server normalises to uppercase; we mirror
  // that locally so the picker shows the new value instantly.
  const saveCharacter = useCallback(
    async (url: string, character: string | null) => {
      const normalised = character ? character.trim().toUpperCase() : null;
      const prev = refs;
      const optimistic = refs.map((r) =>
        r.url === url ? { ...r, character: normalised || undefined } : r,
      );
      onChanged(optimistic);
      try {
        const r = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/refs/${kind}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, character: normalised }),
          },
        );
        if (!r.ok) {
          flash('Character tag save failed');
          onChanged(prev);
          return;
        }
        const j = await r.json().catch(() => ({}));
        if (Array.isArray(j?.refs)) onChanged(j.refs as Ref[]);
      } catch (e: any) {
        flash(`Character tag save error: ${String(e?.message || e).slice(0, 80)}`);
        onChanged(prev);
      }
    },
    [projectId, kind, refs, onChanged, flash],
  );

  const removeRef = useCallback(
    async (url: string) => {
      if (!confirm('Remove this reference?')) return;
      const r = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/refs/${kind}?url=${encodeURIComponent(url)}`,
        { method: 'DELETE' },
      );
      if (!r.ok) {
        flash('Remove failed');
        return;
      }
      const j = await r.json().catch(() => ({}));
      flash('Removed');
      onChanged(Array.isArray(j?.refs) ? (j.refs as Ref[]) : undefined);
    },
    [projectId, kind, onChanged, flash],
  );

  const label = kind === 'characters' ? 'CHARACTER REFERENCES' : 'PRODUCT PLACEMENTS';

  return (
    <div style={styles.wrap}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <div style={{ ...styles.header, marginBottom: 0 }}>
          {label}
          {refs.length > 0 && <span style={styles.count}> · {refs.length}</span>}
        </div>
        {variantAspect && refs.length > 0 && (
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
                ? `All refs already have a ${variantAspect} variant.`
                : `Generate a ${variantAspect} variant for each ref that's missing one.`
            }
          >
            {bulkBusy
              ? bulkBusy
              : missingVariantCount === 0
                ? `✓ ${variantAspect} variants ready`
                : `📐 Generate ${variantAspect} for all (${missingVariantCount} missing)`}
          </button>
        )}
      </div>
      <div
        style={styles.grid}
        onPaste={onPaste}
        tabIndex={0}
      >
        {refs.map((r) => (
          <RefCard
            key={r.url}
            refItem={r}
            showNotes={kind === 'products'}
            showCharacter={kind === 'characters'}
            characterSuggestions={characterSuggestions}
            isMobile={isMobile}
            variantAspect={variantAspect}
            variantBusy={variantBusy.has(r.url)}
            onRemove={() => removeRef(r.url)}
            onNotesBlur={(notes) => saveNotes(r.url, notes)}
            onCharacterChange={(character) => saveCharacter(r.url, character)}
            onGenerateVariant={() => generateVariantFor(r)}
          />
        ))}
        <button
          onClick={() => fileRef.current?.click()}
          style={{
            ...styles.addTile,
            ...(isMobile ? styles.addTileMobile : null),
            opacity: busy ? 0.6 : 1,
            cursor: busy ? 'wait' : 'pointer',
          }}
          type="button"
          title="Upload or focus here + Cmd+V to paste"
        >
          {busy ? '…' : '+ add'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          onChange={onFileInput}
          style={{ display: 'none' }}
        />
      </div>
      <div style={styles.hint}>
        Click + to upload, or click inside the box and Cmd+V to paste. Multiple allowed.
        {kind === 'products' && ' Notes under each product guide how it appears in frames.'}
      </div>
    </div>
  );
}

function RefCard({
  refItem,
  showNotes,
  showCharacter,
  characterSuggestions,
  isMobile,
  variantAspect,
  variantBusy,
  onRemove,
  onNotesBlur,
  onCharacterChange,
  onGenerateVariant,
}: {
  refItem: Ref;
  showNotes: boolean;
  showCharacter: boolean;
  characterSuggestions: string[];
  isMobile: boolean;
  /** When set, the tile renders an aspect-variant badge that fires
   *  `onGenerateVariant` on click. Absent = 16:9 default / legacy. */
  variantAspect: AspectId | null;
  variantBusy: boolean;
  onRemove: () => void;
  onNotesBlur: (notes: string) => void;
  onCharacterChange: (character: string | null) => void;
  onGenerateVariant: () => void;
}) {
  const [notes, setNotes] = useState(refItem.notes ?? '');
  const [notesOpen, setNotesOpen] = useState(false);
  // Merge suggestions + whatever this ref is already tagged with, so a
  // ref tagged with a speaker later removed from the script still shows
  // its tag in the dropdown instead of silently disappearing.
  const options = Array.from(
    new Set([...(characterSuggestions || []), ...(refItem.character ? [refItem.character] : [])]),
  ).sort();
  const selectedValue = refItem.character ?? '';
  const tileStyle = { ...styles.tile, ...(isMobile ? styles.tileMobile : null) };
  const hasNotes = Boolean((refItem.notes || '').trim());
  const hasVariant = Boolean(
    variantAspect && refItem.variants?.[variantAspect],
  );
  return (
    <div style={{ ...tileStyle, cursor: showNotes ? 'pointer' : 'default' }}>
      <img src={refItem.url} alt="" style={styles.thumb} />
      {variantAspect && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (variantBusy) return;
            onGenerateVariant();
          }}
          disabled={variantBusy}
          style={{
            ...styles.variantBadge,
            ...(isMobile ? styles.variantBadgeMobile : null),
            ...(hasVariant ? styles.variantBadgeReady : null),
            ...(variantBusy ? styles.variantBadgeBusy : null),
          }}
          title={
            variantBusy
              ? `Generating ${variantAspect} variant…`
              : hasVariant
                ? `${variantAspect} variant ready — click to regenerate`
                : `Generate a ${variantAspect} variant for this ref (extends vertically via Grok + preserves the source identity)`
          }
          aria-label={hasVariant ? `${variantAspect} variant ready` : `Generate ${variantAspect} variant`}
        >
          {variantBusy ? '…' : hasVariant ? `✓ ${variantAspect}` : `📐 ${variantAspect}`}
        </button>
      )}
      {showCharacter && (
        <select
          value={selectedValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '__new__') {
              const name = window.prompt(
                'Character slug (matches @TAG in script, e.g. SARAH):',
                '',
              );
              if (name && name.trim()) onCharacterChange(name.trim());
              return;
            }
            onCharacterChange(v || null);
          }}
          onClick={(e) => e.stopPropagation()}
          style={{
            ...styles.charTag,
            ...(isMobile ? styles.charTagMobile : null),
            ...(refItem.character ? styles.charTagFilled : null),
          }}
          title={
            refItem.character
              ? `Only attached when frame features @${refItem.character}`
              : 'Untagged — attached to every frame. Click to tie this ref to a character.'
          }
        >
          <option value="">— any —</option>
          {options.map((slug) => (
            <option key={slug} value={slug}>
              @{slug}
            </option>
          ))}
          <option value="__new__">+ new…</option>
        </select>
      )}
      <button
        onClick={onRemove}
        style={styles.removeBtn}
        title="Remove"
        type="button"
      >
        ×
      </button>
      {showNotes && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setNotesOpen((v) => !v);
          }}
          style={{
            ...styles.notesToggle,
            ...(isMobile ? styles.notesToggleMobile : null),
            ...(hasNotes ? styles.notesToggleFilled : null),
          }}
          title={hasNotes ? refItem.notes : 'Add placement notes'}
          aria-label="Edit placement notes"
        >
          📝
        </button>
      )}
      {showNotes && notesOpen && (
        <>
          <div style={styles.notesBackdrop} onClick={() => {
            setNotesOpen(false);
            if (notes !== (refItem.notes ?? '')) onNotesBlur(notes);
          }} />
          <div style={styles.notesPopover} onClick={(e) => e.stopPropagation()}>
            <div style={styles.notesHeader}>Placement notes</div>
            <textarea
              autoFocus
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={'e.g. "Rolex Submariner watch, visible on the left wrist in close-ups. Appears whenever the protagonist is in a suit."'}
              style={{ ...styles.notesArea, ...(isMobile ? styles.notesAreaMobile : null) }}
            />
            <div style={styles.notesActions}>
              <button
                type="button"
                style={styles.notesCancelBtn}
                onClick={() => {
                  setNotes(refItem.notes ?? '');
                  setNotesOpen(false);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                style={styles.notesSaveBtn}
                onClick={() => {
                  if (notes !== (refItem.notes ?? '')) onNotesBlur(notes);
                  setNotesOpen(false);
                }}
              >
                Save
              </button>
            </div>
          </div>
        </>
      )}
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
  header: {
    fontSize: 11,
    color: '#a3a3a3',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: 6,
    fontWeight: 600,
  },
  count: { color: '#e5e5e5', fontWeight: 600 },
  grid: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    padding: 6,
    border: '2px dashed #404040',
    borderRadius: 8,
    minHeight: 72,
    outline: 'none',
    alignItems: 'flex-start',
  },
  tile: {
    width: 84,
    height: 84,
    position: 'relative',
    borderRadius: 6,
    overflow: 'visible',
    background: '#0a0a0a',
    flexShrink: 0,
  },
  tileMobile: {
    // 2-column grid pattern: (50% width - gap) — two tiles per row with a bit
    // of breathing room. Avoids the 84px fixed width, which packs 3 wide and
    // leaves a sliver of whitespace at 375px.
    width: 'calc(50% - 4px)',
    maxWidth: 120,
    height: 110,
    flexShrink: 0,
    flexGrow: 0,
  },
  thumb: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
    borderRadius: 6,
  },
  notesToggle: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    width: 24,
    height: 24,
    borderRadius: 4,
    background: 'rgba(10,10,10,0.78)',
    color: '#a3a3a3',
    border: '1px solid #404040',
    fontSize: 12,
    lineHeight: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    padding: 0,
  },
  notesToggleMobile: {
    width: 36,
    height: 36,
    fontSize: 16,
    bottom: 6,
    left: 6,
  },
  notesToggleFilled: {
    color: '#fbbf24',
    borderColor: '#fbbf24',
    background: 'rgba(10,10,10,0.88)',
  },
  notesBackdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 40,
  },
  notesPopover: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    left: 0,
    zIndex: 50,
    width: 280,
    maxWidth: 'calc(100vw - 24px)',
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 8,
    boxShadow: '0 14px 28px rgba(0,0,0,0.55)',
    padding: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  notesHeader: {
    fontSize: 11,
    color: '#a3a3a3',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontWeight: 600,
  },
  notesArea: {
    width: '100%',
    minHeight: 90,
    resize: 'vertical',
    background: '#171717',
    color: '#e5e5e5',
    border: '1px solid #404040',
    borderRadius: 5,
    padding: 8,
    fontFamily: 'ui-monospace, monospace',
    fontSize: 12,
    lineHeight: 1.4,
    boxSizing: 'border-box',
    outline: 'none',
  },
  // 16px minimum prevents iOS Safari from auto-zooming on focus.
  notesAreaMobile: {
    fontSize: 16,
    minHeight: 120,
  },
  notesActions: {
    display: 'flex',
    gap: 6,
    justifyContent: 'flex-end',
  },
  notesCancelBtn: {
    background: 'transparent',
    color: '#a3a3a3',
    border: '1px solid #404040',
    borderRadius: 5,
    padding: '5px 10px',
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  notesSaveBtn: {
    background: '#7c3aed',
    color: '#fff',
    border: '1px solid #6d28d9',
    borderRadius: 5,
    padding: '5px 10px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  charTag: {
    position: 'absolute',
    top: 4,
    left: 4,
    maxWidth: 'calc(100% - 38px)',
    background: 'rgba(10,10,10,0.82)',
    color: '#a3a3a3',
    border: '1px solid #404040',
    borderRadius: 4,
    padding: '2px 4px',
    fontSize: 10,
    fontFamily: 'ui-monospace, monospace',
    fontWeight: 600,
    cursor: 'pointer',
    outline: 'none',
  },
  charTagMobile: {
    fontSize: 12,
    padding: '4px 6px',
    top: 6,
    left: 6,
    minHeight: 28,
  },
  charTagFilled: {
    color: '#fde68a',
    borderColor: '#f59e0b',
    background: 'rgba(10,10,10,0.92)',
  },
  removeBtn: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 28,
    height: 28,
    borderRadius: '50%',
    background: 'rgba(0,0,0,0.78)',
    color: '#fca5a5',
    border: '1px solid #7f1d1d',
    fontSize: 15,
    fontWeight: 700,
    lineHeight: 1,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    touchAction: 'manipulation',
  },
  addTile: {
    width: 84,
    height: 84,
    border: '2px dashed #525252',
    borderRadius: 6,
    background: '#0a0a0a',
    color: '#737373',
    fontSize: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Aspect-variant badge anchored to the top-right of each ref tile.
  // Hidden on 16:9 projects, visible on 9:16 / 4:5 / 1:1. States drive
  // the colour: dim outline = missing, amber = ready, dim pulse = busy.
  variantBadge: {
    position: 'absolute',
    top: 4,
    right: 38,
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
  variantBadgeMobile: {
    top: 6,
    right: 42,
    height: 26,
    fontSize: 11,
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
  addTileMobile: {
    width: '100%',
    height: 54,
    fontSize: 15,
  },
  hint: {
    marginTop: 6,
    fontSize: 11,
    color: '#737373',
  },
};
