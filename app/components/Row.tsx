'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Segment, PromptEntry } from '../lib/blob';
import SubtitleOverlay, { isSubtitleEnabledFor, type SubtitleSettings } from './SubtitleOverlay';
import { resolveCaptionStyle } from '../lib/captionStyle';
import { paginate } from '../lib/subtitlePagination';
import { isMusicEnabledFor, type BackgroundMusic } from '../lib/music';

// Animations that emit one Dialogue per word; pagination is bypassed for
// these on the renderer side, so the browser preview must match.
const ROW_PER_WORD_ANIMATIONS = new Set<string>([
  'typewriter', 'typewriter_cursor', 'word_by_word',
  'karaoke', 'karaoke_fill', 'word_bounce', 'word_spring', 'word_flip',
  'word_rotate', 'pop', 'word_wave', 'word_glitch', 'bubble',
  'wave_color', 'tiktok_highlight', 'hopper',
]);
import KenBurnsPicker from './KenBurnsPicker';
import LocationPicker from './LocationPicker';
import SplitPicker from './SplitPicker';
import RowActionsMenu, { type RowActionItem } from './RowActionsMenu';
import { Play, Sparkles, Trash2 } from 'lucide-react';
import { Button } from './ui';
import { resolveAspect, segmentAspect } from '../lib/aspectRatios';
import { useIsMobile, useIsNarrowDesktop } from '../lib/useMediaQuery';
import { autoFixBorders } from '../lib/autoFixBorders';

function fmtTs(s: number) {
  const m = Math.floor(s / 60);
  const sec = (s - m * 60).toFixed(2).padStart(5, '0');
  return `${String(m).padStart(2, '0')}:${sec}`;
}

export default function Row({
  projectId,
  segment,
  previousSegment,
  getSegmentById,
  onSegmentMetaPatched,
  promptEntry,
  imageUrls,
  productNotes,
  isProductFrame = false,
  products = [],
  tunnelUrl,
  selected,
  onToggleSelect,
  onUpdated,
  onIsVideoChange,
  onFramePersisted,
  onFrameClick,
  onKenBurnsChange,
  onLocationChange,
  subtitles,
  onToggleSubtitle,
  music,
  onToggleMusic,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  hasNextSegment = false,
  onTimelineReplace,
  projectAspect,
  aspectLocked = true,
  flash,
}: {
  projectId: string;
  segment: Segment;
  /** Immediate predecessor in timeline order. Used by the "Same location?
   *  → lock?" auto-suggest hint and as the default anchor when the user
   *  toggles the chain-link button. Null at the head of the timeline. */
  previousSegment?: Segment | null;
  /** Resolves any segment by its id. Used to walk segment.ref_seg_id chains
   *  to the anchor whose frame_url drives edit-mode generation. */
  getSegmentById?: (id: string) => Segment | null | undefined;
  /** Persists ref_seg_id + prompt_archived patches to /segments/batch-meta
   *  and updates parent state. ContactSheet supplies this. */
  onSegmentMetaPatched?: (segId: string, patch: {
    ref_seg_id?: string | null;
    prompt_archived?: string | null;
  }) => Promise<void> | void;
  promptEntry?: PromptEntry;
  imageUrls: string[];
  productNotes: string[];
  isProductFrame?: boolean;
  /** Full products pool. Used by the "Place product" picker on the
   *  per-frame edit input; not the same as `imageUrls` which is already
   *  resolved to the attached refs for this beat. */
  products?: Array<{ url: string; label?: string; notes?: string }>;
  tunnelUrl: string | null;
  selected: boolean;
  onToggleSelect: (segId: string, next: boolean) => void;
  onUpdated: () => void;
  /** Optimistic per-segment is_video toggle. When present, the Video
   *  checkbox calls this instead of onUpdated so the full bundle doesn't
   *  refetch for a single-field flip. */
  onIsVideoChange?: (segId: string, next: boolean) => void;
  onFramePersisted?: (segId: string, frameUrl: string) => void;
  onFrameClick?: () => void;
  onKenBurnsChange?: (segId: string, next: string) => void;
  onLocationChange?: (segId: string, next: string) => void;
  subtitles?: SubtitleSettings;
  onToggleSubtitle?: () => void;
  music?: BackgroundMusic | null;
  onToggleMusic?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  hasNextSegment?: boolean;
  onTimelineReplace?: (next: Segment[]) => void;
  // Current project-level aspect picker value; stamped onto new generates.
  projectAspect?: string;
  // False until the user has explicitly chosen an aspect for this project.
  // Gates Generate + Paste + Edit so a new project can't silently default to 16:9.
  aspectLocked?: boolean;
  flash: (msg: string) => void;
}) {
  const [promptText, setPromptText] = useState(promptEntry?.prompt ?? '');
  const [genBusy, setGenBusy] = useState(false);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [renderStatus, setRenderStatus] = useState('');
  const [showPrompt, setShowPrompt] = useState(false);
  const [editText, setEditText] = useState('');
  const [editBusy, setEditBusy] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [copyFlash, setCopyFlash] = useState<string | null>(null);
  // Attached product for the next edit. Persists until the user clears it
  // or the edit runs. Chip renders between the input and Apply edit.
  const [attachedProduct, setAttachedProduct] = useState<{
    url: string;
    label: string;
  } | null>(null);
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);
  const pasteRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const isNarrow = useIsNarrowDesktop();
  // Apply compact sizing in either narrow-desktop or mobile. btnSmCompact is
  // tighter than btnSm; pickers drop their long labels; the flex:1 spacer
  // disappears so the left and right button clusters sit next to each other.
  const compact = isNarrow || isMobile;
  // Pre-computed size override for the small action buttons (Render / Generate
  // / Clear / Split / Merge). Mobile wins over narrow (bigger tap targets).
  const btnSizeOverride = isMobile
    ? styles.btnSmMobile
    : isNarrow
      ? styles.btnSmNarrow
      : null;
  const frameRef = useRef<HTMLDivElement>(null);
  const [frameHeightPx, setFrameHeightPx] = useState(158);
  const [frameWidthPx, setFrameWidthPx] = useState(280);

  // Frame-continuity: walk segment.ref_seg_id transitively (depth-capped
  // at 8) to find the anchor whose frame_url drives edit-mode generation.
  // Returns { anchor, broken } — broken=true when the chain references a
  // segment that no longer exists in the timeline.
  const resolveChain = useCallback(
    (startId: string | undefined | null): { anchor: Segment | null; broken: boolean } => {
      if (!startId) return { anchor: null, broken: false };
      if (!getSegmentById) return { anchor: null, broken: true };
      const seen = new Set<string>([segment.id]);
      let cur: Segment | null = getSegmentById(startId) ?? null;
      let depth = 0;
      while (cur && cur.ref_seg_id && depth < 8) {
        if (seen.has(cur.id)) return { anchor: null, broken: true };
        seen.add(cur.id);
        cur = getSegmentById(cur.ref_seg_id) ?? null;
        depth++;
      }
      return { anchor: cur, broken: !cur };
    },
    [getSegmentById, segment.id],
  );

  // Auto-detection: parse the prompt text for continuity cues. The
  // CEOANIMATED prompt framework documents "Direct continuation. ..." as
  // the canonical opener for a same-shot/different-beat frame. We also
  // honour explicit segment references like "continue from VO_063" or
  // "same as VO_064". Returns the resolved anchor id when detected.
  const autoDetectedAnchorId = useMemo(() => {
    const text = (promptText || '').trim();
    if (!text) return null;
    const head = text.slice(0, 240);
    // Explicit segment reference: "continue from VO_063", "same as VO_064",
    // "based on VO_065" etc. Case-insensitive trigger; preserve the matched
    // segment id's original case for getSegmentById (segment ids are
    // case-sensitive — "VO_063" not "vo_063").
    const explicit = head.match(
      /(?:continue from|same as|based on|inherit from|edit of)\s+(VO_\d+|EC_\d+|[A-Z][A-Za-z0-9_-]*)/i,
    );
    if (explicit && explicit[1]) {
      // Snap common case to canonical: "vo_063" → "VO_063". Other
      // identifiers are returned as written and will fail the
      // getSegmentById lookup if they don't match exactly.
      const raw = explicit[1];
      if (/^vo_\d+$/i.test(raw)) return raw.toUpperCase();
      if (/^ec_\d+$/i.test(raw)) return raw.toUpperCase();
      return raw;
    }
    // Canonical framework cue.
    if (/\bdirect continuation\b/i.test(head)) {
      return previousSegment?.id ?? null;
    }
    return null;
  }, [promptText, previousSegment?.id]);

  // Manual lock takes priority over auto-detection. When neither, the
  // segment generates fresh.
  const explicitLock = Boolean(segment.ref_seg_id);
  const explicitLockResolution = useMemo(
    () => (explicitLock ? resolveChain(segment.ref_seg_id) : { anchor: null as Segment | null, broken: false }),
    [explicitLock, segment.ref_seg_id, resolveChain],
  );
  const autoLockResolution = useMemo(
    () => (!explicitLock && autoDetectedAnchorId ? resolveChain(autoDetectedAnchorId) : { anchor: null as Segment | null, broken: false }),
    [explicitLock, autoDetectedAnchorId, resolveChain],
  );

  const isAutoLocked = !explicitLock && !!autoDetectedAnchorId && !!autoLockResolution.anchor && !autoLockResolution.broken;
  const isLocked = explicitLock || isAutoLocked;
  const activeLockSource: 'explicit' | 'auto' | 'none' = explicitLock ? 'explicit' : isAutoLocked ? 'auto' : 'none';
  const lockedAnchor = explicitLock ? explicitLockResolution.anchor : autoLockResolution.anchor;
  const lockedAnchorId = explicitLock ? segment.ref_seg_id : autoDetectedAnchorId;
  const lockBroken = explicitLock ? explicitLockResolution.broken : false; // auto-mode bails silently when broken
  const lockAnchorReady = isLocked && !!lockedAnchor?.frame_url;
  const lockAspectMismatch =
    isLocked &&
    !!lockedAnchor &&
    !!segment.aspect &&
    !!lockedAnchor.aspect &&
    segment.aspect !== lockedAnchor.aspect;

  // Aspect-aware frame dimensions. Use the segment's stamped aspect when
  // a frame has already been generated (so landscape frames keep their
  // landscape thumb even if the project aspect was later flipped); fall
  // back to the project aspect for "no frame yet" placeholders so the
  // user sees the shape they're about to generate, not a default 16:9.
  const thumbAspectId = segment.aspect || projectAspect || '16:9';
  const aspectPreset = resolveAspect(thumbAspectId);
  // Desktop: fix height so rows stay uniform, vary width from the aspect.
  // 16:9 → 281×158, 9:16 → 89×158, 1:1 → 158×158, 4:5 → 126×158.
  const DESKTOP_H = 158;
  const desktopFrameW = Math.round(
    (DESKTOP_H * aspectPreset.width) / aspectPreset.height,
  );
  // Mobile: full-width for landscape, cap portrait so a 9:16 thumb doesn't
  // eat half the viewport. 320px max-height is a comfortable phone ceiling.
  const MOBILE_MAX_H = 320;
  const isPortraitAspect = aspectPreset.width < aspectPreset.height;
  const mobileFrameMaxWidth = isPortraitAspect
    ? Math.round((MOBILE_MAX_H * aspectPreset.width) / aspectPreset.height)
    : undefined;
  const dynamicFrameStyle: React.CSSProperties = isMobile
    ? {
        width: '100%',
        maxWidth: mobileFrameMaxWidth,
        aspectRatio: aspectPreset.cssRatio,
      }
    : {
        width: desktopFrameW,
        minWidth: desktopFrameW,
        height: DESKTOP_H,
      };
  // Re-measure the rendered frame height + width whenever the aspect
  // (or mobile state) changes. Both dimensions are needed so the
  // SubtitleOverlay scales off min(w,h) — height-only scaling sizes
  // subtitles way too large for narrow 9:16 frames.
  useEffect(() => {
    const update = () => {
      if (frameRef.current) {
        setFrameHeightPx(frameRef.current.clientHeight);
        setFrameWidthPx(frameRef.current.clientWidth);
      }
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [isMobile, thumbAspectId]);

  useEffect(() => {
    setPromptText(promptEntry?.prompt ?? '');
  }, [promptEntry?.prompt]);

  // Blob frame_url is the source of truth for display. The tunnel is only used
  // for writes (drag-to-swap, render). Optimistic updates after paste/generate
  // are handled by setImgUrl directly in those handlers.
  //
  // Depend on the whole segment object (not just frame_url): bundle reloads
  // produce a new segment reference even when frame_url is unchanged, which is
  // exactly what we want after Clear All — if a previous optimistic URL was
  // never persisted to the timeline, this resets it to match server truth.
  useEffect(() => {
    setImgUrl(segment.frame_url ?? null);
  }, [segment]);

  const copyToClipboard = useCallback(async (text: string, label: string) => {
    if (!text) return;
    try {
      // navigator.clipboard requires HTTPS or localhost. Fall back to the
      // legacy selectable-textarea + execCommand hack for older WebViews.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopyFlash(`✓ ${label} copied`);
      window.setTimeout(() => setCopyFlash(null), 1500);
    } catch {
      setCopyFlash('Copy failed — long-press text to select');
      window.setTimeout(() => setCopyFlash(null), 2500);
    }
  }, []);

  const savePrompt = useCallback(async (newText: string) => {
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/prompts`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seg_id: segment.id, prompt: newText }),
    });
  }, [projectId, segment.id]);

  const clearFrame = useCallback(async () => {
    if (!confirm(`Clear the frame for ${segment.id}? The prompt stays, only the image is removed.`)) return;
    try {
      const r = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(segment.id)}`,
        { method: 'DELETE' },
      );
      if (!r.ok) {
        flash(`Clear failed: ${(await r.text()).slice(0, 80)}`);
        return;
      }
      setImgUrl(null);
      flash('Frame cleared');
      onUpdated();
    } catch (e: any) {
      flash(`Clear error: ${String(e?.message || e).slice(0, 80)}`);
    }
  }, [projectId, segment.id, flash, onUpdated]);

  const generate = useCallback(async () => {
    const text = promptText.trim();
    if (!text) {
      flash('Type a prompt first');
      return;
    }
    if (!aspectLocked) {
      flash('Pick an aspect ratio before generating — see the Aspect bar above');
      return;
    }
    const isVideo = segment.is_video === true;
    // Frame-continuity branch: when this segment is locked to an anchor,
    // route through edit-mode using the anchor's frame_url as the sole
    // reference. The `prompt` is treated as a short edit instruction.
    // Locking is image-only — video segments fall through to fresh gen
    // because seedance has no img2vid edit endpoint.
    const lockUsable = isLocked && !isVideo && lockAnchorReady && !lockAspectMismatch && !lockBroken;
    // Only an EXPLICIT lock errors out when unusable. Auto-detected locks
    // fall through silently to fresh generation — the user's prompt
    // wanted a continuation but the conditions don't support one.
    if (explicitLock && !isVideo && !lockUsable) {
      if (lockBroken) {
        flash(`Anchor ${segment.ref_seg_id ?? ''} not found — fix the prompt or remove the explicit lock`);
        return;
      }
      if (!lockAnchorReady) {
        flash(`Anchor ${lockedAnchor?.id ?? ''} has no frame yet — render it first`);
        return;
      }
      if (lockAspectMismatch) {
        flash(`Aspect mismatch with anchor (${lockedAnchor?.aspect} vs ${segment.aspect})`);
        return;
      }
    }
    const lockedImageGen = lockUsable;
    setGenBusy(true);
    try {
      await savePrompt(text);

      const sub = await fetch(isVideo ? '/api/generate-video' : '/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isVideo
            ? {
                prompt: text,
                aspect: projectAspect || '16:9',
                duration: 5,
              }
            : lockedImageGen
              ? {
                  prompt: text,
                  // Anchor's frame is the sole reference. Don't mix in the
                  // project's character/product refs — the anchor already
                  // baked them in, and adding more refs to grok-imagine-edit
                  // dilutes the "preserve everything" instruction.
                  image_urls: [lockedAnchor!.frame_url as string],
                  product_notes: [],
                  mode: 'edit',
                  ...(projectAspect ? { aspect: projectAspect } : {}),
                }
              : {
                  prompt: text,
                  image_urls: imageUrls,
                  product_notes: productNotes,
                  ...(projectAspect ? { aspect: projectAspect } : {}),
                  ...(segment.location
                    ? { location: segment.location, project_id: projectId }
                    : {}),
                },
        ),
      });
      if (!sub.ok) {
        flash(`Generate submit failed: ${(await sub.text()).slice(0, 100)}`);
        return;
      }
      const { status_url, response_url } = await sub.json();
      // Video jobs run longer — seedance 5s clips take ~60-90s. Extend the
      // polling window for video submissions so the UI doesn't bail early.
      const maxPolls = isVideo ? 120 : 40;
      for (let i = 0; i < maxPolls; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        const pr = await fetch('/api/generate-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status_url, response_url }),
        });
        if (!pr.ok) continue;
        const st = await pr.json();
        if (!st.done) continue;

        if (st.video_url) {
          // Video path — no auto-crop, no matte cleanup; just persist.
          setImgUrl(st.video_url);
          const persistBody: Record<string, unknown> = { video_url: st.video_url };
          if (projectAspect) persistBody.aspect = projectAspect;
          let persistedUrl: string | null = null;
          try {
            const putR = await fetch(
              `/api/projects/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(segment.id)}`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(persistBody),
              },
            );
            if (!putR.ok) {
              flash(`Save to Blob failed: ${(await putR.text()).slice(0, 120)}`);
            } else {
              const j = await putR.json().catch(() => ({}));
              if (j?.frame_url) {
                persistedUrl = j.frame_url as string;
                setImgUrl(persistedUrl);
              }
            }
          } catch (e: any) {
            flash(`Blob PUT error: ${String(e?.message || e).slice(0, 100)}`);
          }
          if (tunnelUrl && persistedUrl) {
            try {
              await fetch(`${tunnelUrl.replace(/\/+$/, '')}/swap/${segment.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_url: persistedUrl }),
              });
            } catch {}
          }
          flash(persistedUrl ? 'Video generated' : 'Generated (not saved — check console)');
          if (persistedUrl) onFramePersisted?.(segment.id, persistedUrl);
          return;
        }

        if (st.image_url) {
          setImgUrl(st.image_url); // optimistic FAL URL, replaced below

          // Auto-crop any white matte BEFORE persisting so a bordered frame
          // never lands in the timeline. If the FAL output is already full-
          // bleed, this is a no-op pass-through.
          const fix = await autoFixBorders(st.image_url);
          const persistBody: Record<string, unknown> = fix.fixed
            ? { data_url: fix.image }
            : { image_url: st.image_url };
          if (projectAspect) persistBody.aspect = projectAspect;
          if (fix.fixed) {
            persistBody.meta = { op: 'autofix.borders', cropped_frac: fix.cropped_frac };
          }

          let persistedUrl: string | null = null;
          try {
            const putR = await fetch(
              `/api/projects/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(segment.id)}`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(persistBody),
              },
            );
            if (!putR.ok) {
              flash(`Save to Blob failed: ${(await putR.text()).slice(0, 120)}`);
            } else {
              const j = await putR.json().catch(() => ({}));
              if (j?.frame_url) {
                persistedUrl = j.frame_url as string;
                setImgUrl(persistedUrl);
              }
            }
          } catch (e: any) {
            flash(`Blob PUT error: ${String(e?.message || e).slice(0, 100)}`);
          }

          if (tunnelUrl && persistedUrl) {
            try {
              await fetch(`${tunnelUrl.replace(/\/+$/, '')}/swap/${segment.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_url: persistedUrl }),
              });
            } catch {}
          }
          flash(persistedUrl
            ? fix.fixed
              ? `Generated (auto-cropped ${Math.round(fix.cropped_frac * 100)}% matte)`
              : 'Generated'
            : 'Generated (not saved — check console)');
          if (persistedUrl) onFramePersisted?.(segment.id, persistedUrl);
          return;
        }
      }
      flash('Generate timed out');
    } finally {
      setGenBusy(false);
    }
  }, [promptText, imageUrls, productNotes, projectId, savePrompt, flash, tunnelUrl, segment.id, onFramePersisted, isLocked, lockBroken, lockAnchorReady, lockAspectMismatch, lockedAnchor, explicitLock]);

  // Edit the current frame using IT as the only reference (not the global
  // character/product refs). Useful for small targeted tweaks like "remove
  // the smile" or "make the suit navy" without re-rolling the whole concept.
  //
  // When a product is attached (via the 📦 picker / "Place product" menu),
  // its image is included as a second ref and the prompt is prefixed so
  // the model treats the user's text as placement guidance for THAT
  // product rather than a generic edit.
  const editFrame = useCallback(async () => {
    const text = editText.trim();
    if (!text) {
      flash(attachedProduct
        ? `Say where @${attachedProduct.label} should appear (e.g. "on the desk in the foreground")`
        : 'Type an edit instruction first');
      return;
    }
    // Video segments don't "edit" — they regenerate from the prompt via
    // seedance. No reference video, no targeted rewrite; the edit input
    // becomes the full description for a fresh clip.
    const isVideo = segment.is_video === true;
    if (!imgUrl && !isVideo) {
      flash('No frame to edit yet — generate one first');
      return;
    }
    setEditBusy(true);
    try {
      const refUrls = attachedProduct && imgUrl
        ? [imgUrl, attachedProduct.url]
        : imgUrl ? [imgUrl] : [];
      const prompt = attachedProduct
        ? `Place the ${attachedProduct.label} shown in the second reference image naturally into this scene. Placement: ${text}. Keep every other aspect of the scene identical — character, pose, wardrobe, lighting, composition, framing, background.`
        : text;
      const sub = await fetch(isVideo ? '/api/generate-video' : '/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isVideo
            ? {
                prompt,
                aspect: projectAspect || '16:9',
                duration: 5,
              }
            : {
                prompt,
                image_urls: refUrls,
                product_notes: [],
                mode: 'edit',
              },
        ),
      });
      if (!sub.ok) {
        flash(`Edit submit failed: ${(await sub.text()).slice(0, 100)}`);
        return;
      }
      const { status_url, response_url } = await sub.json();
      const maxPolls = isVideo ? 120 : 40;
      for (let i = 0; i < maxPolls; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        const pr = await fetch('/api/generate-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status_url, response_url }),
        });
        if (!pr.ok) continue;
        const st = await pr.json();
        if (!st.done) continue;

        if (st.video_url) {
          setImgUrl(st.video_url);
          const persistBody: Record<string, unknown> = { video_url: st.video_url };
          if (projectAspect) persistBody.aspect = projectAspect;
          let persistedUrl: string | null = null;
          try {
            const putR = await fetch(
              `/api/projects/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(segment.id)}`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(persistBody),
              },
            );
            if (!putR.ok) {
              flash(`Save to Blob failed: ${(await putR.text()).slice(0, 120)}`);
            } else {
              const j = await putR.json().catch(() => ({}));
              if (j?.frame_url) {
                persistedUrl = j.frame_url as string;
                setImgUrl(persistedUrl);
              }
            }
          } catch (e: any) {
            flash(`Blob PUT error: ${String(e?.message || e).slice(0, 100)}`);
          }
          flash(persistedUrl ? 'Video generated' : 'Generated (not saved — check console)');
          setEditText('');
          if (persistedUrl) onFramePersisted?.(segment.id, persistedUrl);
          return;
        }

        if (st.image_url) {
          setImgUrl(st.image_url);
          // Auto-crop any white matte before persisting.
          const fix = await autoFixBorders(st.image_url);
          const persistBody: Record<string, unknown> = fix.fixed
            ? { data_url: fix.image }
            : { image_url: st.image_url };
          let persistedUrl: string | null = null;
          try {
            const putR = await fetch(
              `/api/projects/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(segment.id)}`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(persistBody),
              },
            );
            if (!putR.ok) {
              flash(`Save to Blob failed: ${(await putR.text()).slice(0, 120)}`);
            } else {
              const j = await putR.json().catch(() => ({}));
              if (j?.frame_url) {
                persistedUrl = j.frame_url as string;
                setImgUrl(persistedUrl);
              }
            }
          } catch (e: any) {
            flash(`Blob PUT error: ${String(e?.message || e).slice(0, 100)}`);
          }
          if (tunnelUrl && persistedUrl) {
            try {
              await fetch(`${tunnelUrl.replace(/\/+$/, '')}/swap/${segment.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_url: persistedUrl }),
              });
            } catch {}
          }
          flash(persistedUrl
            ? fix.fixed
              ? `Edit applied (auto-cropped ${Math.round(fix.cropped_frac * 100)}% matte)`
              : 'Edit applied'
            : 'Edited (not saved — check console)');
          setEditText('');
          setAttachedProduct(null);
          if (persistedUrl) onFramePersisted?.(segment.id, persistedUrl);
          return;
        }
      }
      flash('Edit timed out');
    } finally {
      setEditBusy(false);
    }
  }, [editText, imgUrl, projectId, flash, tunnelUrl, segment.id, segment.is_video, projectAspect, onFramePersisted, attachedProduct, onUpdated]);

  const onPaste = useCallback(async (e: React.ClipboardEvent) => {
    for (const item of Array.from(e.clipboardData.items)) {
      if (!item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      if (!aspectLocked) {
        flash('Pick an aspect ratio first — see the Aspect bar above');
        return;
      }
      // Resize + JPEG-compress client-side so the PUT body fits under
      // Vercel's 4.5MB serverless payload cap. Anime stills look identical
      // at 1920x1080 / quality 0.88; payload lands around 300-600 KB.
      const dataUrl = await (async () => {
        try {
          const bitmap = await createImageBitmap(file);
          const maxW = 1920;
          const maxH = 1080;
          const scale = Math.min(1, maxW / bitmap.width, maxH / bitmap.height);
          const w = Math.max(1, Math.round(bitmap.width * scale));
          const h = Math.max(1, Math.round(bitmap.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('no canvas ctx');
          ctx.drawImage(bitmap, 0, 0, w, h);
          bitmap.close?.();
          return canvas.toDataURL('image/jpeg', 0.88);
        } catch {
          // Fallback: raw file (might still hit payload limit, but better
          // than nothing if canvas isn't available).
          return await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.readAsDataURL(file);
          });
        }
      })();
      setImgUrl(dataUrl); // optimistic

      // 1. Persist to Blob so every viewer sees it. Use the versioned URL
      // returned by the PUT as the undo-stack entry so a later redo can
      // land back on this paste.
      let persistedUrl: string | null = null;
      try {
        const r = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(segment.id)}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              data_url: dataUrl,
              ...(projectAspect ? { aspect: projectAspect } : {}),
            }),
          },
        );
        if (!r.ok) {
          flash('Blob upload failed: ' + (await r.text()).slice(0, 80));
        } else {
          const j = await r.json().catch(() => ({}));
          if (j?.frame_url) {
            persistedUrl = j.frame_url as string;
            setImgUrl(persistedUrl);
          }
        }
      } catch {
        flash('Blob upload error');
      }

      // 2. If tunnel is up, also write to local disk (so ffmpeg render uses it)
      if (tunnelUrl) {
        try {
          await fetch(`${tunnelUrl.replace(/\/+$/, '')}/swap/${segment.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_data_url: dataUrl }),
          });
        } catch {
          // non-fatal — local render will just use the previous local frame
        }
      }
      flash('Frame pasted — prior version available via ↺');
      // Route through the narrow patch path so the undo stack captures the
      // outgoing URL. Fall back to the heavy reload only if we didn't get
      // a persisted URL (shouldn't happen in practice).
      if (persistedUrl) onFramePersisted?.(segment.id, persistedUrl);
      else onUpdated();
      return;
    }
  }, [tunnelUrl, projectId, segment.id, flash, onFramePersisted, onUpdated]);

  // ---- Video / large-image upload via Supabase signed URL --------------
  // The data-URL paste path tops out at Vercel's 4.5MB body cap. Anything
  // bigger (a 5-second h.264 .mp4 at 1080p is ~3-8MB) needs a direct PUT
  // to Supabase. The signed-url sibling endpoint hands us a one-shot
  // upload URL; we PUT the bytes there, then call the regular PUT route
  // with { uploaded: true } to stamp the timeline.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const uploadFile = useCallback(async (file: File) => {
    if (!aspectLocked) {
      flash('Pick an aspect ratio first — see the Aspect bar above');
      return;
    }
    const isVideo = /^video\//i.test(file.type) || /\.(mp4|webm|mov)$/i.test(file.name);
    // Image route stays on the existing canvas-resize → data_url path so
    // anime stills land at ~400KB and ride the cheap PUT. The signed-url
    // path is for video bytes that can't be canvas-shrunk.
    if (!isVideo) {
      // Reuse the paste pipeline by constructing a synthetic ClipboardEvent
      // shape — simpler: inline the resize+PUT here.
      try {
        const bitmap = await createImageBitmap(file);
        const maxW = 1920, maxH = 1080;
        const scale = Math.min(1, maxW / bitmap.width, maxH / bitmap.height);
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no canvas ctx');
        ctx.drawImage(bitmap, 0, 0, w, h);
        bitmap.close?.();
        const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
        setImgUrl(dataUrl);
        const r = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(segment.id)}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              data_url: dataUrl,
              ...(projectAspect ? { aspect: projectAspect } : {}),
            }),
          },
        );
        if (!r.ok) {
          flash('Image upload failed: ' + (await r.text()).slice(0, 80));
          return;
        }
        const j = await r.json().catch(() => ({}));
        if (j?.frame_url) {
          setImgUrl(j.frame_url);
          onFramePersisted?.(segment.id, j.frame_url);
        } else {
          onUpdated();
        }
        flash('Image uploaded');
      } catch (e: any) {
        flash('Image upload error: ' + String(e?.message || e).slice(0, 80));
      }
      return;
    }

    // Video path: signed URL → direct Supabase PUT → finalize stamp.
    const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
    const niceExt = ['mp4', 'webm', 'mov'].includes(ext) ? ext : 'mp4';
    setUploadStatus('Requesting upload URL…');
    try {
      const sigRes = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(segment.id)}/signed-url`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ext: niceExt }),
        },
      );
      if (!sigRes.ok) {
        const t = await sigRes.text();
        flash('Signed URL failed: ' + t.slice(0, 80));
        setUploadStatus(null);
        return;
      }
      const sig = await sigRes.json() as {
        signedUrl: string; path: string; token: string; public_url: string;
      };

      setUploadStatus(`Uploading ${(file.size / 1024 / 1024).toFixed(1)}MB…`);
      const putRes = await fetch(sig.signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'video/mp4' },
        body: file,
      });
      if (!putRes.ok) {
        flash('Upload failed: ' + (await putRes.text()).slice(0, 80));
        setUploadStatus(null);
        return;
      }

      setUploadStatus('Finalising…');
      const finRes = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(segment.id)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uploaded: true,
            mime: file.type || 'video/mp4',
            ext: niceExt,
            bytes: file.size,
            ...(projectAspect ? { aspect: projectAspect } : {}),
          }),
        },
      );
      if (!finRes.ok) {
        flash('Finalise failed: ' + (await finRes.text()).slice(0, 80));
        setUploadStatus(null);
        return;
      }
      const fin = await finRes.json().catch(() => ({}));
      if (fin?.frame_url) {
        setImgUrl(fin.frame_url);
      }
      // Always full-reload after a video upload — onFramePersisted only
      // patches frame_url, but the timeline now also has is_video=true that
      // Row needs to switch from <img> backgroundImage to a <video> element.
      // Without this the frame slot stays blank because the .mp4 URL gets
      // assigned to background-image, which silently fails.
      onUpdated();
      flash('Video uploaded');
      setUploadStatus(null);
    } catch (e: any) {
      flash('Upload error: ' + String(e?.message || e).slice(0, 80));
      setUploadStatus(null);
    }
  }, [aspectLocked, flash, projectId, segment.id, projectAspect, onFramePersisted, onUpdated]);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    await uploadFile(file);
  }, [uploadFile]);

  const onPickFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFileSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await uploadFile(file);
    // Reset so picking the same file again still triggers the change event.
    if (e.target) e.target.value = '';
  }, [uploadFile]);

  const renderHere = useCallback(async () => {
    if (!tunnelUrl) {
      flash('Tunnel offline — render needs local server');
      return;
    }
    setRenderStatus('Queueing…');
    const start = Date.now();
    try {
      const base = tunnelUrl.replace(/\/+$/, '');
      const body = JSON.stringify({
        project_id: projectId,
        end_seg_id: segment.id,
        subtitles: subtitles ?? null,
      });
      // Submit with one automatic retry on network-level TypeError. Cloudflare
      // quick tunnels occasionally blip during reconnect and surface as
      // "Failed to fetch" — a single retry after 1s rides through that.
      let sub: Response | null = null;
      let lastErr: any = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          sub = await fetch(`${base}/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          });
          break;
        } catch (e: any) {
          lastErr = e;
          if (attempt === 0) {
            setRenderStatus('Network blip — retrying…');
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }
      if (!sub) {
        setRenderStatus(`Network error: ${String(lastErr?.message || lastErr).slice(0, 60)}`);
        return;
      }
      if (!sub.ok) {
        const errText = await sub.text().catch(() => '');
        setRenderStatus(`Submit ${sub.status}: ${errText.slice(0, 80) || 'failed'}`);
        return;
      }
      const { job_id } = await sub.json();
      // Poll /render/status. The server returns {state, error, elapsed, ...}
      // where state progresses 'queued' → 'running' → 'done' | 'failed'.
      // A 404 means the server purged the job after completion — treat it
      // as done so the counter stops. Hard timeout at 20 min just in case.
      const HARD_TIMEOUT_MS = 20 * 60 * 1000;
      let sawRunning = false;
      for (;;) {
        if (Date.now() - start > HARD_TIMEOUT_MS) {
          setRenderStatus('⚠ Timed out after 20 min — check tunnel logs');
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
        const elapsed = Math.floor((Date.now() - start) / 1000);
        setRenderStatus(`Rendering ${segmentAspect(segment)} · ${elapsed}s…`);
        let st: Response;
        try {
          st = await fetch(`${tunnelUrl.replace(/\/+$/, '')}/render/status?id=${encodeURIComponent(job_id)}`);
        } catch {
          continue; // tunnel blip — retry next tick
        }
        if (st.status === 404 && sawRunning) {
          // Job was cleaned up after finishing — treat as success.
          setRenderStatus('✓ Done');
          return;
        }
        if (!st.ok) continue;
        const data = await st.json().catch(() => ({}));
        if (data?.state && data.state !== 'queued') sawRunning = true;
        if (data?.state === 'done') {
          setRenderStatus('✓ Done');
          return;
        }
        if (data?.state === 'failed' || data?.error) {
          setRenderStatus(`Error: ${String(data.error || 'render failed').slice(0, 60)}`);
          return;
        }
      }
    } catch (e: any) {
      setRenderStatus(`Error: ${String(e?.message || e).slice(0, 60)}`);
    }
  }, [tunnelUrl, projectId, segment.id, flash]);

  return (
    <div
      style={{
        ...styles.row,
        ...(isMobile ? styles.rowMobile : null),
        borderLeftColor: '#262626',
        background: '#0f0f0f',
      }}
    >
      <div style={{ ...styles.frameWrap, ...(isMobile ? styles.frameWrapMobile : null) }}>
        <label
          style={{
            ...styles.checkbox,
            background: selected ? '#1d4ed8' : 'rgba(10,10,10,0.75)',
            borderColor: selected ? '#60a5fa' : '#525252',
          }}
          title="Select for bulk actions"
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onToggleSelect(segment.id, e.target.checked)}
            style={{ margin: 0, cursor: 'pointer' }}
          />
        </label>
        <div
          ref={frameRef}
          className="wm-frame"
          style={{
            ...styles.frame,
            ...dynamicFrameStyle,
            // For image segments the background-image is the preview. For
            // video segments we layer a <video> element on top, so skip
            // the background-image to avoid drawing a static thumbnail
            // behind a moving video.
            backgroundImage: imgUrl && !segment.is_video ? `url(${imgUrl})` : 'none',
            backgroundColor: segment.is_video ? '#000' : undefined,
            cursor: 'pointer',
            position: 'relative',
            overflow: 'hidden',
          }}
          onPaste={onPaste}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
          onDrop={onDrop}
          // Single click focuses this frame (arms it for paste — ⌘V / Ctrl+V
          // replaces the image). Double-click expands into the lightbox.
          // Rationale: click was previously claimed by the lightbox, which
          // made "click then paste" impossible.
          onClick={(e) => e.currentTarget.focus()}
          onDoubleClick={() => {
            if (imgUrl && onFrameClick) onFrameClick();
          }}
          tabIndex={0}
          title={
            imgUrl
              ? 'Click to select — ⌘V/Ctrl+V to paste · drag-drop or Upload for video · double-click to expand'
              : 'Click to select — ⌘V/Ctrl+V to paste · drag-drop or Upload for video'
          }
        >
          {!imgUrl && (
            <>
              <span style={styles.framePlaceholder}>no frame yet</span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onPickFile(); }}
                style={{
                  position: 'absolute',
                  bottom: 8,
                  right: 8,
                  padding: '4px 8px',
                  fontSize: 11,
                  borderRadius: 4,
                  border: '1px solid #4f46e5',
                  background: 'rgba(79, 70, 229, 0.18)',
                  color: '#e0e7ff',
                  cursor: 'pointer',
                }}
                title="Upload an image or video file (.mp4 / .webm / .mov / .jpg / .png)"
              >
                ⬆ Upload
              </button>
            </>
          )}
          {imgUrl && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onPickFile(); }}
              style={{
                position: 'absolute',
                bottom: 4,
                right: 4,
                padding: '2px 6px',
                fontSize: 10,
                borderRadius: 3,
                border: '1px solid rgba(79, 70, 229, 0.5)',
                background: 'rgba(0, 0, 0, 0.55)',
                color: '#e0e7ff',
                cursor: 'pointer',
                opacity: 0.7,
              }}
              title="Replace with an uploaded image or video file"
            >
              ⬆
            </button>
          )}
          {uploadStatus && (
            <span
              style={{
                position: 'absolute',
                top: 4,
                left: 4,
                padding: '2px 6px',
                fontSize: 10,
                borderRadius: 3,
                background: 'rgba(79, 70, 229, 0.8)',
                color: '#fff',
              }}
            >
              {uploadStatus}
            </span>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/mp4,video/webm,video/quicktime"
            style={{ display: 'none' }}
            onChange={onFileSelected}
          />
          {imgUrl && segment.is_video && (
            <video
              key={imgUrl}
              src={imgUrl}
              autoPlay
              muted
              loop
              playsInline
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
              }}
            />
          )}
          {imgUrl && subtitles && isSubtitleEnabledFor(segment.id, subtitles) && (() => {
            // Static thumbnail — no playhead. When pagination is on, show
            // page 0 (the first chunk) so the preview reflects what the
            // viewer sees at t=segStart in the burned-in render.
            const resolved = resolveCaptionStyle(subtitles, segment.id);
            const animPerWord = ROW_PER_WORD_ANIMATIONS.has(resolved.animation);
            let txt = segment.narration ?? '';
            if (resolved.paginationEnabled && !animPerWord) {
              const segStart = Number(segment.start) || 0;
              const segEnd = Math.max(Number(segment.end) || 0, segStart + 0.4);
              const maxLines = subtitles.singleLine ? 1 : resolved.maxLines;
              const pages = paginate(
                segment.narration ?? '', null, segStart, segEnd,
                { maxLines, maxCharsPerLine: resolved.maxCharsPerLine },
              );
              if (pages.length > 0) txt = pages[0].lines.join('\n');
            }
            return (
              <SubtitleOverlay
                text={txt}
                settings={subtitles}
                frameHeight={frameHeightPx || 158}
                frameWidth={frameWidthPx || 280}
                segId={segment.id}
              />
            );
          })()}
        </div>
      </div>
      <div style={styles.right}>
        <div style={styles.meta}>
          <span style={styles.segId}>{segment.id}</span>
          <span style={styles.ts}>[{fmtTs(segment.start)} → {fmtTs(segment.end)}]</span>
          {segment.frame_url && (() => {
            const stamped = segmentAspect(segment, projectAspect);
            const mismatch = projectAspect && segment.aspect && stamped !== projectAspect;
            return (
              <span
                style={{
                  ...styles.aspectBadge,
                  ...(mismatch ? styles.aspectBadgeMismatch : null),
                }}
                title={mismatch
                  ? `Stamped ${stamped} — differs from current project picker (${projectAspect}). Rendering only affects frames at the same aspect.`
                  : `Frame generated at ${stamped}`}
              >
                {stamped}
              </span>
            );
          })()}
          {segment.kind === 'end_card' && <span style={styles.endBadge}>END CARD</span>}
          {segment.kind === 'title_card' && <span style={styles.titleBadge}>TITLE CARD</span>}
          {isProductFrame && (
            <span
              style={styles.productBadge}
              title="Products will be included in this frame. All other frames are product-free."
            >
              🏷 product frame
            </span>
          )}
          {!isNarrow && <div style={{ flex: 1 }} />}
          {subtitles?.enabled && onToggleSubtitle && (() => {
            const on = isSubtitleEnabledFor(segment.id, subtitles);
            return (
              <button
                onClick={onToggleSubtitle}
                style={{
                  ...styles.ccBtn,
                  ...(isMobile ? styles.ccBtnMobile : null),
                  background: on ? '#1e3a5f' : '#171717',
                  borderColor: on ? '#3b82f6' : '#404040',
                  color: on ? '#dbeafe' : '#737373',
                }}
                title={on ? 'Subtitle on for this frame — click to hide' : 'Subtitle hidden for this frame — click to show'}
              >
                {on ? 'CC' : 'CC̸'}
              </button>
            );
          })()}
          {music?.enabled && music.track_id && onToggleMusic && (() => {
            const on = isMusicEnabledFor(segment.id, music);
            return (
              <button
                onClick={onToggleMusic}
                style={{
                  ...styles.ccBtn,
                  ...(isMobile ? styles.ccBtnMobile : null),
                  background: on ? '#3b1b66' : '#171717',
                  borderColor: on ? '#7c3aed' : '#404040',
                  color: on ? '#ede9fe' : '#737373',
                }}
                title={on ? `Background music plays during this beat — click to silence (${music.title} by ${music.artist})` : 'Background music silenced for this beat — click to include'}
              >
                {on ? '🎵' : '🎵̸'}
              </button>
            );
          })()}
          {/* Primary actions kept inline: Render, Generate, Clear.
              Secondary actions (Ken Burns, Location, Undo/Redo, Split,
              Merge) moved into the ⋮ menu to keep the row scannable. */}
          <Button
            size="sm"
            variant="secondary"
            onClick={renderHere}
            leadingIcon={<Play size={12} strokeWidth={2.5} />}
          >
            Render to here
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={generate}
            disabled={genBusy || !aspectLocked}
            loading={genBusy}
            leadingIcon={genBusy ? undefined : <Sparkles size={12} strokeWidth={2} />}
            title={!aspectLocked ? 'Pick an aspect ratio first' : undefined}
          >
            {genBusy ? 'Generating' : 'Generate'}
          </Button>
          {imgUrl && (
            <Button
              size="sm"
              variant="ghost"
              onClick={clearFrame}
              leadingIcon={<Trash2 size={12} strokeWidth={2} />}
              title="Remove the current frame (prompt stays)"
            >
              Clear
            </Button>
          )}
          <RowActionsMenu
            items={[
              ...(imgUrl && products.length > 0
                ? [
                    {
                      kind: 'button' as const,
                      label: '📦 Place product',
                      title:
                        'Open the product picker on the edit bar below. Pick a product, type where it should appear, and Apply.',
                      onClick: () => {
                        setProductPickerOpen(true);
                        // Scroll the edit input into view on mobile so the
                        // popover it anchors to is actually visible.
                        window.setTimeout(() => {
                          editInputRef.current?.scrollIntoView({
                            behavior: 'smooth',
                            block: 'center',
                          });
                        }, 50);
                      },
                    } as RowActionItem,
                    { kind: 'divider' as const },
                  ]
                : []),
              {
                kind: 'custom',
                label: 'Ken Burns motion',
                node: (
                  <KenBurnsPicker
                    projectId={projectId}
                    segId={segment.id}
                    frameUrl={imgUrl}
                    current={segment.ken_burns}
                    onChange={(next) => onKenBurnsChange?.(segment.id, next)}
                    compact={compact}
                  />
                ),
              },
              {
                kind: 'custom',
                label: 'Location',
                node: (
                  <LocationPicker
                    projectId={projectId}
                    segId={segment.id}
                    current={segment.location}
                    onChange={(next) => onLocationChange?.(segment.id, next)}
                    compact={compact}
                  />
                ),
              },
              { kind: 'divider' },
              ...((onUndo || onRedo)
                ? [
                    {
                      kind: 'button' as const,
                      label: '↺ Undo',
                      disabled: !canUndo,
                      onClick: () => onUndo?.(),
                      title: 'Undo last change to this frame',
                    },
                    {
                      kind: 'button' as const,
                      label: '↻ Redo',
                      disabled: !canRedo,
                      onClick: () => onRedo?.(),
                      title: 'Redo the change you just undid',
                    },
                    { kind: 'divider' as const },
                  ]
                : []),
              {
                kind: 'custom',
                label: 'Split segment',
                node: (
                  <SplitPicker
                    projectId={projectId}
                    segId={segment.id}
                    segStart={segment.start}
                    segEnd={segment.end}
                    narration={segment.narration}
                    onSplit={onUpdated}
                    onTimelineReplace={onTimelineReplace}
                    flash={flash}
                  />
                ),
                hint: 'Split narration at a word boundary.',
              },
              ...(hasNextSegment
                ? [
                    {
                      kind: 'button' as const,
                      label: mergeBusy ? '…merging' : '⇢ Merge with next segment',
                      disabled: mergeBusy,
                      title:
                        "Merge this segment with the next — reverses a split. The next segment's frame is discarded.",
                      onClick: async () => {
                        if (mergeBusy) return;
                        if (
                          !confirm(
                            `Merge ${segment.id} with the next segment? Any frame on the next segment will be dropped.`,
                          )
                        )
                          return;
                        setMergeBusy(true);
                        try {
                          const r = await fetch(
                            `/api/projects/${encodeURIComponent(projectId)}/timeline/merge`,
                            {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ seg_id: segment.id }),
                            },
                          );
                          const raw = await r.text();
                          if (!r.ok) {
                            console.error('[merge] server error', r.status, raw);
                            flash(`Merge ${r.status}: ${raw.slice(0, 140)}`);
                            return;
                          }
                          let data: any = {};
                          try {
                            data = JSON.parse(raw);
                          } catch {}
                          if (Array.isArray(data.timeline) && onTimelineReplace) {
                            onTimelineReplace(data.timeline);
                          } else {
                            await Promise.resolve(onUpdated());
                          }
                          flash(`Merged ${segment.id} + ${data.dropped ?? '?'}`);
                        } catch (e: any) {
                          console.error('[merge] exception', e);
                          flash(`Merge error: ${String(e?.message || e).slice(0, 140)}`);
                        } finally {
                          setMergeBusy(false);
                        }
                      },
                    } as RowActionItem,
                  ]
                : []),
            ]}
          />
        </div>
        <div style={styles.narrationRow}>
          <div style={styles.narration}>{segment.narration}</div>
          {segment.narration && (
            <button
              onClick={() => copyToClipboard(segment.narration, 'Narration')}
              style={styles.copyInline}
              title="Copy narration text"
              aria-label="Copy narration"
              type="button"
            >
              📋
            </button>
          )}
        </div>
        {renderStatus && <div style={styles.renderStatus}>{renderStatus}</div>}
        {copyFlash && <div style={styles.copyFlash}>{copyFlash}</div>}
        <div style={styles.promptRow}>
          <button
            onClick={() => setShowPrompt((v) => !v)}
            style={styles.promptToggle}
            type="button"
          >
            {showPrompt ? '▾ hide prompt' : promptText ? (isLocked ? '▸ edit instruction saved — edit' : '▸ prompt saved — edit') : (isLocked ? '▸ add edit instruction' : '▸ add prompt')}
          </button>
          {promptText && (
            <button
              onClick={() => copyToClipboard(promptText, 'Prompt')}
              style={styles.copyBtn}
              title="Copy prompt to clipboard"
              type="button"
            >
              📋 Copy prompt
            </button>
          )}
          {isLocked && (
            <span
              style={lockBroken ? styles.lockBadgeBroken : lockAspectMismatch ? styles.lockBadgeWarn : activeLockSource === 'auto' ? styles.lockBadgeAuto : styles.lockBadge}
              title={
                lockBroken
                  ? `Anchor segment "${lockedAnchorId}" not found — fix the prompt reference or remove "direct continuation"`
                  : lockAspectMismatch
                    ? `Aspect mismatch with anchor (${lockedAnchor?.aspect} vs ${segment.aspect})`
                    : activeLockSource === 'auto'
                      ? `Auto-detected from prompt — generate will edit ${lockedAnchorId}'s frame instead of creating a fresh one. Triggered by "direct continuation" or an explicit "${lockedAnchorId}" reference in the prompt text.`
                      : `Locked to ${lockedAnchorId}. Generate edits this anchor's frame instead of creating a fresh one.`
              }
            >
              {activeLockSource === 'auto' ? '✨' : '🔗'} → {lockedAnchorId}
              {lockBroken && ' (broken)'}
              {!lockBroken && lockAspectMismatch && ' (aspect mismatch)'}
              {!lockBroken && !lockAspectMismatch && !lockAnchorReady && ' (anchor needs frame)'}
            </span>
          )}
        </div>
        {showPrompt && (
          <textarea
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            onBlur={() => savePrompt(promptText)}
            placeholder={
              isLocked
                ? `Edit instruction for ${segment.ref_seg_id} (e.g. "change the laptop screen to show a cover letter draft")`
                : 'Type a prompt and click ✨ Generate'
            }
            style={{ ...styles.prompt, ...(isMobile ? styles.promptMobile : null) }}
            autoFocus
          />
        )}
        {imgUrl && (
          <div style={styles.editBlock}>
            {attachedProduct && (
              <div style={styles.productChipRow}>
                <span style={styles.productChip}>
                  📦 {attachedProduct.label}
                  <button
                    type="button"
                    onClick={() => setAttachedProduct(null)}
                    style={styles.productChipRemove}
                    title="Remove attached product"
                    aria-label="Remove attached product"
                  >
                    ×
                  </button>
                </span>
                <span style={styles.productChipHint}>
                  your edit text becomes placement guidance
                </span>
              </div>
            )}
            <label
              title="Generate a short video clip (via Seedance) instead of a still image"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 8px',
                marginBottom: 6,
                borderRadius: 6,
                background: segment.is_video ? 'rgba(79, 70, 229, 0.14)' : 'transparent',
                border: `1px solid ${segment.is_video ? '#4f46e5' : '#262626'}`,
                color: segment.is_video ? '#e0e7ff' : '#a3a3a3',
                fontSize: 12,
                cursor: 'pointer',
                userSelect: 'none',
                width: 'fit-content',
              }}
            >
              <input
                type="checkbox"
                checked={segment.is_video === true}
                onChange={(e) => {
                  const next = e.target.checked;
                  // Flip the local bundle state immediately so the pill
                  // re-renders the same tick. The PATCH flies in the
                  // background. Rollback on failure to stay truthful.
                  onIsVideoChange?.(segment.id, next);
                  void fetch(
                    `/api/projects/${encodeURIComponent(projectId)}/timeline`,
                    {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ seg_id: segment.id, is_video: next }),
                    },
                  )
                    .then((r) => {
                      if (!r.ok) {
                        onIsVideoChange?.(segment.id, !next);
                        flash(`Video toggle failed (HTTP ${r.status})`);
                      }
                    })
                    .catch((err) => {
                      onIsVideoChange?.(segment.id, !next);
                      flash(`Video toggle failed: ${String(err?.message || err).slice(0, 80)}`);
                    });
                }}
                style={{ margin: 0, cursor: 'pointer' }}
              />
              🎬 Video (Seedance)
            </label>
            <div style={{ ...styles.editRow, ...(isMobile ? styles.editRowMobile : null) }}>
              <input
                ref={editInputRef}
                type="text"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !editBusy) {
                    e.preventDefault();
                    editFrame();
                  }
                }}
                placeholder={
                  segment.is_video
                    ? 'Describe the video clip (e.g. "slow dolly in on the car in the rain")'
                    : attachedProduct
                      ? `Placement for ${attachedProduct.label} (e.g. "on the desk in the foreground")`
                      : isMobile
                        ? 'Edit this frame (e.g. "remove the smile")'
                        : "Edit this frame (uses current image as reference, e.g. 'remove the smile')"
                }
                disabled={editBusy}
                style={{ ...styles.editInput, ...(isMobile ? styles.editInputMobile : null) }}
              />
              {products.length > 0 && (
                <div style={{ position: 'relative' }}>
                  <button
                    type="button"
                    onClick={() => setProductPickerOpen((v) => !v)}
                    disabled={editBusy}
                    style={{
                      ...styles.productPickBtn,
                      ...(isMobile ? styles.productPickBtnMobile : null),
                      ...(attachedProduct ? styles.productPickBtnActive : null),
                    }}
                    title={attachedProduct
                      ? 'Change or clear the attached product'
                      : 'Attach a product from the Product Placements pool'}
                    aria-label="Attach product"
                  >
                    📦
                  </button>
                  {productPickerOpen && (
                    <ProductPickerPopover
                      products={products}
                      currentUrl={attachedProduct?.url ?? null}
                      onClose={() => setProductPickerOpen(false)}
                      onPick={(url, label) => {
                        setAttachedProduct({ url, label });
                        setProductPickerOpen(false);
                        // Focus the edit input so the user can immediately
                        // type placement guidance.
                        window.setTimeout(() => editInputRef.current?.focus(), 0);
                      }}
                    />
                  )}
                </div>
              )}
              <button
                onClick={editFrame}
                disabled={editBusy || !editText.trim()}
                style={{ ...styles.editBtn, ...(isMobile ? styles.editBtnMobile : null) }}
                title={attachedProduct
                  ? `Place ${attachedProduct.label} into this frame using the text as placement guidance`
                  : 'Apply edit using the current frame as the only reference image'}
              >
                {editBusy
                  ? '…editing'
                  : attachedProduct
                    ? '📦 Place product'
                    : '✏️ Apply edit'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Thumbnail popover shown when the user clicks the 📦 Attach product
// button on the edit row. Outside-click closes. Keyboard: Esc closes.
function ProductPickerPopover({
  products,
  currentUrl,
  onClose,
  onPick,
}: {
  products: Array<{ url: string; label?: string; notes?: string }>;
  currentUrl: string | null;
  onClose: () => void;
  onPick: (url: string, label: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const click = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', click);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', click);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const labelFor = (p: { label?: string; url: string }) =>
    (p.label || p.url.split('/').pop() || 'product').replace(/\.[a-z]+$/i, '');
  return (
    <div ref={wrapRef} style={styles.productPopover}>
      <div style={styles.productPopoverHeader}>Pick a product</div>
      <div style={styles.productPopoverGrid}>
        {products.map((p) => {
          const label = labelFor(p);
          const isCurrent = p.url === currentUrl;
          return (
            <button
              key={p.url}
              type="button"
              onClick={() => onPick(p.url, label)}
              style={{
                ...styles.productPopoverTile,
                ...(isCurrent ? styles.productPopoverTileActive : null),
              }}
              title={label}
            >
              <img src={p.url} alt="" style={styles.productPopoverThumb} />
              <span style={styles.productPopoverLabel}>{label}</span>
            </button>
          );
        })}
      </div>
      <div style={styles.productPopoverHint}>
        After picking, type placement guidance in the edit box and press Apply.
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    gap: 12,
    padding: 10,
    border: '1px solid #262626',
    borderLeft: '4px solid #262626',
    borderRadius: 8,
  },
  rowMobile: {
    flexDirection: 'column',
    padding: 8,
    gap: 10,
  },
  frameWrap: { position: 'relative' },
  frameWrapMobile: { width: '100%' },
  frame: {
    borderRadius: 6,
    backgroundColor: '#0a0a0a',
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    outline: 'none',
  },
  // frameDesktop / frameMobile removed — dimensions are now computed
  // per-row from the effective aspect (segment.aspect || projectAspect)
  // in the Row component body. See `dynamicFrameStyle` there.
  checkbox: {
    position: 'absolute',
    top: 6,
    left: 6,
    zIndex: 2,
    width: 24,
    height: 24,
    borderRadius: 4,
    border: '1px solid',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  framePlaceholder: { color: '#525252', fontSize: 12 },
  right: { flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  meta: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  segId: { fontFamily: 'ui-monospace, monospace', fontSize: 13, fontWeight: 600, color: '#60a5fa' },
  ts: { fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#a3a3a3' },
  aspectBadge: {
    fontSize: 10,
    padding: '2px 6px',
    background: '#1e293b',
    color: '#94a3b8',
    borderRadius: 4,
    fontWeight: 700,
    fontFamily: 'var(--font-plex-mono), ui-monospace, monospace',
    border: '1px solid #334155',
    letterSpacing: 0.3,
  },
  aspectBadgeMismatch: {
    background: '#3d2e0f',
    color: '#fbbf24',
    borderColor: '#b45309',
  },
  endBadge: { fontSize: 10, padding: '2px 6px', background: '#581c87', color: '#f5f5f5', borderRadius: 4, fontWeight: 600 },
  titleBadge: { fontSize: 10, padding: '2px 6px', background: '#334155', color: '#e2e8f0', borderRadius: 4, fontWeight: 600 },
  productBadge: { fontSize: 10, padding: '2px 6px', background: '#0f3d2e', color: '#a7f3d0', borderRadius: 4, fontWeight: 600, border: '1px solid #10b981' },
  ccBtn: {
    padding: '3px 8px',
    borderRadius: 4,
    border: '1px solid #404040',
    fontSize: 11,
    fontWeight: 700,
    fontFamily: 'monospace',
    cursor: 'pointer',
    letterSpacing: 0.5,
  },
  ccBtnMobile: {
    padding: '8px 12px',
    fontSize: 12,
    minHeight: 40,
  },
  undoGroup: {
    display: 'inline-flex',
    gap: 2,
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 6,
    padding: 2,
  },
  undoGroupMobile: {
    padding: 3,
  },
  undoBtn: {
    width: 28,
    height: 28,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    color: '#e5e5e5',
    fontSize: 16,
    borderRadius: 4,
    padding: 0,
    lineHeight: 1,
  },
  undoBtnMobile: {
    width: 40,
    height: 40,
    fontSize: 20,
  },
  editRow: { display: 'flex', gap: 6, marginTop: 6, alignItems: 'stretch' },
  editRowMobile: { flexDirection: 'column', gap: 8 },
  editInput: {
    flex: 1,
    padding: '6px 10px',
    background: '#0a0a0a',
    border: '1px solid #404040',
    borderRadius: 4,
    color: '#f5f5f5',
    fontSize: 12,
    outline: 'none',
  },
  editInputMobile: {
    padding: '10px 12px',
    fontSize: 16,
    minHeight: 44,
    width: '100%',
    boxSizing: 'border-box',
  },
  editBtn: {
    padding: '6px 12px',
    background: '#1e293b',
    color: '#e2e8f0',
    border: '1px solid #475569',
    borderRadius: 4,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  editBtnMobile: {
    padding: '12px 14px',
    fontSize: 14,
    minHeight: 44,
    width: '100%',
  },
  narration: { fontSize: 13, color: '#e5e5e5', lineHeight: 1.4, flex: 1, userSelect: 'text', WebkitUserSelect: 'text' },
  narrationRow: { display: 'flex', alignItems: 'flex-start', gap: 8 },
  promptRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  copyInline: {
    background: 'transparent',
    border: '1px solid #262626',
    color: '#a3a3a3',
    borderRadius: 4,
    padding: '2px 6px',
    fontSize: 12,
    cursor: 'pointer',
    lineHeight: 1,
    flexShrink: 0,
  },
  copyBtn: {
    background: '#171717',
    color: '#e5e5e5',
    border: '1px solid #404040',
    borderRadius: 5,
    padding: '4px 10px',
    fontSize: 11,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  copyFlash: { fontSize: 11, color: '#34d399', fontWeight: 600 },
  renderStatus: { fontSize: 12, color: '#fbbf24' },
  promptToggle: {
    alignSelf: 'flex-start',
    background: 'transparent',
    border: 'none',
    color: '#737373',
    fontSize: 11,
    cursor: 'pointer',
    padding: 0,
    fontFamily: 'inherit',
  },
  lockBadge: {
    fontSize: 11,
    color: '#a3e635',
    background: 'rgba(132, 204, 22, 0.12)',
    border: '1px solid rgba(132, 204, 22, 0.4)',
    borderRadius: 4,
    padding: '2px 6px',
    fontFamily: 'ui-monospace, monospace',
  },
  lockBadgeAuto: {
    fontSize: 11,
    color: '#c4b5fd',
    background: 'rgba(167, 139, 250, 0.14)',
    border: '1px solid rgba(167, 139, 250, 0.45)',
    borderRadius: 4,
    padding: '2px 6px',
    fontFamily: 'ui-monospace, monospace',
  },
  lockBadgeWarn: {
    fontSize: 11,
    color: '#fbbf24',
    background: 'rgba(251, 191, 36, 0.12)',
    border: '1px solid rgba(251, 191, 36, 0.4)',
    borderRadius: 4,
    padding: '2px 6px',
    fontFamily: 'ui-monospace, monospace',
  },
  lockBadgeBroken: {
    fontSize: 11,
    color: '#fca5a5',
    background: 'rgba(248, 113, 113, 0.12)',
    border: '1px solid rgba(248, 113, 113, 0.4)',
    borderRadius: 4,
    padding: '2px 6px',
    fontFamily: 'ui-monospace, monospace',
  },
  lockBtnOff: {
    fontSize: 11,
    color: '#737373',
    background: 'transparent',
    border: '1px solid #404040',
    borderRadius: 4,
    padding: '2px 8px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  lockBtnSuggested: {
    fontSize: 11,
    color: '#a3e635',
    background: 'rgba(132, 204, 22, 0.08)',
    border: '1px solid rgba(132, 204, 22, 0.5)',
    borderRadius: 4,
    padding: '2px 8px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontWeight: 600,
  },
  lockBtnOn: {
    fontSize: 11,
    color: '#fca5a5',
    background: 'transparent',
    border: '1px solid rgba(248, 113, 113, 0.4)',
    borderRadius: 4,
    padding: '2px 8px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  prompt: {
    width: '100%',
    minHeight: 64,
    resize: 'vertical',
    background: '#0a0a0a',
    color: '#f5f5f5',
    border: '1px solid #404040',
    borderRadius: 6,
    padding: 8,
    fontFamily: 'ui-monospace, monospace',
    fontSize: 12,
    lineHeight: 1.45,
    boxSizing: 'border-box',
  },
  // 16px minimum prevents iOS Safari from auto-zooming on focus.
  promptMobile: {
    fontSize: 16,
    minHeight: 96,
  },
  btnSm: {
    background: '#262626',
    color: '#f5f5f5',
    border: '1px solid #404040',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  btnSmMobile: {
    padding: '10px 14px',
    fontSize: 13,
    minHeight: 42,
    flex: '1 1 auto',
  },
  btnSmNarrow: {
    padding: '4px 8px',
    fontSize: 11,
  },
  btnGen: {
    background: '#7c3aed',
    color: '#fff',
    border: '1px solid #6d28d9',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    cursor: 'pointer',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  btnClear: {
    background: '#450a0a',
    color: '#fca5a5',
    border: '1px solid #7f1d1d',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  editBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  productChipRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  productChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: '#3d2e0f',
    color: '#fbbf24',
    border: '1px solid #b45309',
    borderRadius: 999,
    padding: '3px 4px 3px 10px',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: 'inherit',
  },
  productChipRemove: {
    width: 20,
    height: 20,
    borderRadius: '50%',
    background: 'rgba(0,0,0,0.4)',
    color: '#fde68a',
    border: 'none',
    fontSize: 14,
    lineHeight: 1,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  productChipHint: {
    fontSize: 11,
    color: '#737373',
    fontStyle: 'italic',
  },
  productPickBtn: {
    width: 40,
    height: 40,
    borderRadius: 6,
    background: '#171717',
    color: '#a3a3a3',
    border: '1px solid #404040',
    fontSize: 16,
    lineHeight: 1,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    flexShrink: 0,
  },
  productPickBtnMobile: {
    width: 44,
    height: 44,
    fontSize: 18,
  },
  productPickBtnActive: {
    background: '#3d2e0f',
    color: '#fbbf24',
    borderColor: '#b45309',
  },
  productPopover: {
    position: 'absolute',
    right: 0,
    top: 'calc(100% + 6px)',
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
  productPopoverHeader: {
    fontSize: 11,
    color: '#a3a3a3',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontWeight: 600,
  },
  productPopoverGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))',
    gap: 6,
    maxHeight: 260,
    overflowY: 'auto',
  },
  productPopoverTile: {
    position: 'relative',
    background: '#171717',
    border: '1px solid #262626',
    borderRadius: 6,
    padding: 4,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 4,
    fontFamily: 'inherit',
  },
  productPopoverTileActive: {
    borderColor: '#f59e0b',
    background: '#3d2e0f',
  },
  productPopoverThumb: {
    width: '100%',
    aspectRatio: '1 / 1',
    objectFit: 'cover',
    borderRadius: 4,
    display: 'block',
  },
  productPopoverLabel: {
    fontSize: 10,
    color: '#e5e5e5',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'center',
  },
  productPopoverHint: {
    fontSize: 10,
    color: '#737373',
    lineHeight: 1.35,
  },
};
