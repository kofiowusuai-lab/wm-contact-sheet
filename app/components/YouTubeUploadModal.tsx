'use client';

// Upload dialog. Submits to the local tunnel's /upload-youtube endpoint,
// which shells to ~/.openclaw/scripts/youtube/yt-upload.py. After the
// tunnel returns done, we persist the title/description/tags + the
// final YouTube video URL into projects/{id}/meta.json via
// /api/projects/{id}/upload-meta so the dialog's defaults pre-fill on
// the next upload.
//
// Channel picking: the preferred channel comes from series.youtube_channel
// (pinned once per series). The dialog exposes a "channel: X ▾" chip the
// user can click to change, which populates from the tunnel's
// /youtube/channels list (reads ~/.openclaw/scripts/youtube/channels.json).
//
// Shorts vs Long-form: a two-option toggle. Auto-picks 'shorts' for any
// project whose aspect is 9:16, 'longform' otherwise. The tunnel appends
// '#Shorts' to the description when kind==='shorts' (YouTube auto-detects
// by aspect+duration but the hashtag is the belt-and-braces signal).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ExternalLink,
  ImagePlus,
  Loader2,
  Upload,
  X,
} from 'lucide-react';
import type { ProjectMeta, Segment, SeriesMeta } from '../lib/blob';
import { uploadFileToFal } from '../lib/uploadImage';

type ChannelsDoc = {
  channels: Record<
    string,
    { name: string; handle?: string; google_account?: string }
  >;
};

type Props = {
  projectId: string;
  projectMeta: ProjectMeta | null;
  series: SeriesMeta | null;
  segments: Segment[];
  tunnelUrl: string;
  aspect: string | undefined;
  videoPath: string;
  onClose: () => void;
  onMetaPatched: (next: ProjectMeta) => void;
  onSeriesPatched: (next: SeriesMeta) => void;
  flash: (msg: string) => void;
};

type UploadKind = 'shorts' | 'longform';
type Privacy = 'private' | 'unlisted' | 'public';

export default function YouTubeUploadModal({
  projectId,
  projectMeta,
  series,
  segments,
  tunnelUrl,
  aspect,
  videoPath,
  onClose,
  onMetaPatched,
  onSeriesPatched,
  flash,
}: Props) {
  const priorMeta = projectMeta?.upload_meta;
  const [title, setTitle] = useState(
    priorMeta?.title || projectMeta?.title || '',
  );
  const [description, setDescription] = useState(priorMeta?.description || '');
  const [tags, setTags] = useState(priorMeta?.tags || '');
  const [privacy, setPrivacy] = useState<Privacy>('private');
  const [publishAt, setPublishAt] = useState<string>('');
  const [kind, setKind] = useState<UploadKind>(
    priorMeta?.kind ?? (aspect === '9:16' ? 'shorts' : 'longform'),
  );
  const [channel, setChannel] = useState<string>(
    priorMeta?.last_channel || series?.youtube_channel || '',
  );
  const [pinChannelToSeries, setPinChannelToSeries] = useState<boolean>(
    !series?.youtube_channel,
  );
  const [thumbSegId, setThumbSegId] = useState<string>(
    priorMeta?.thumbnail_seg_id || '',
  );
  const [customThumbUrl, setCustomThumbUrl] = useState<string>(
    priorMeta?.thumbnail_url && !priorMeta?.thumbnail_seg_id
      ? priorMeta.thumbnail_url
      : '',
  );

  const [channelsDoc, setChannelsDoc] = useState<ChannelsDoc | null>(null);
  const [showChannelPicker, setShowChannelPicker] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [jobResult, setJobResult] = useState<{
    video_id?: string;
    url?: string;
    channel?: string;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [thumbUploading, setThumbUploading] = useState(false);

  const onThumbFile = useCallback(async (f: File) => {
    setThumbUploading(true);
    try {
      const url = await uploadFileToFal(f, projectId);
      if (!url) {
        flash('Thumbnail upload failed');
        return;
      }
      setCustomThumbUrl(url);
      setThumbSegId('');
    } catch (e: any) {
      flash(`Thumbnail upload error: ${String(e?.message || e).slice(0, 120)}`);
    } finally {
      setThumbUploading(false);
    }
  }, [projectId, flash]);

  // Frames available for thumbnail selection.
  const framedSegments = useMemo(
    () => segments.filter((s) => s.frame_url),
    [segments],
  );

  // Load available channels from the tunnel.
  useEffect(() => {
    const t = tunnelUrl.replace(/\/+$/, '');
    fetch(`${t}/youtube/channels`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setChannelsDoc(d))
      .catch(() => {});
  }, [tunnelUrl]);

  const channelOptions = useMemo(() => {
    if (!channelsDoc) return [];
    return Object.entries(channelsDoc.channels)
      .filter(([k]) => !k.startsWith('_'))
      .map(([slug, info]) => ({ slug, ...info }));
  }, [channelsDoc]);

  const selectedChannel = channelOptions.find((c) => c.slug === channel);

  // Thumbnail URL resolved at submit-time: either the selected segment's
  // frame_url or the user-pasted custom URL.
  const resolvedThumbUrl = useMemo(() => {
    if (customThumbUrl.trim()) return customThumbUrl.trim();
    if (thumbSegId) {
      const seg = framedSegments.find((s) => s.id === thumbSegId);
      return seg?.frame_url || '';
    }
    return '';
  }, [customThumbUrl, thumbSegId, framedSegments]);

  // Shorts warnings — surface softly without blocking.
  const shortsWarnings: string[] = [];
  if (kind === 'shorts') {
    if (aspect && aspect !== '9:16') {
      shortsWarnings.push(
        `aspect is ${aspect}, Shorts expects 9:16 — YouTube may classify it as long-form`,
      );
    }
    const lastEnd = segments[segments.length - 1]?.end || 0;
    if (lastEnd > 61) {
      shortsWarnings.push(
        `timeline is ${lastEnd.toFixed(0)}s — Shorts hard cap is 60s, YouTube will reclassify`,
      );
    }
  }

  const canSubmit =
    !submitting &&
    !!channel &&
    title.trim().length > 0 &&
    title.trim().length <= 100;

  const pinChannel = useCallback(async () => {
    if (!series || !channel) return;
    try {
      const r = await fetch(
        `/api/series/${encodeURIComponent(series.id)}/youtube-channel`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel }),
        },
      );
      if (r.ok) {
        const j = await r.json();
        if (j?.series) onSeriesPatched(j.series);
      }
    } catch {
      // non-fatal — series pin is a nice-to-have
    }
  }, [series, channel, onSeriesPatched]);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setJobStatus('Submitting to tunnel…');
    setJobResult(null);

    if (pinChannelToSeries && series && series.youtube_channel !== channel) {
      await pinChannel();
    }

    const t = tunnelUrl.replace(/\/+$/, '');
    try {
      const sub = await fetch(`${t}/upload-youtube`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          channel,
          video_path: videoPath,
          title: title.trim(),
          description,
          tags,
          privacy,
          publish_at: publishAt || null,
          thumbnail_url: resolvedThumbUrl || null,
          kind,
        }),
      });
      if (!sub.ok) {
        const msg = (await sub.text()).slice(0, 200);
        setJobStatus(`Submit ${sub.status}: ${msg}`);
        setSubmitting(false);
        return;
      }
      const { job_id } = await sub.json();

      const start = Date.now();
      const HARD_TIMEOUT_MS = 30 * 60 * 1000;
      for (;;) {
        if (Date.now() - start > HARD_TIMEOUT_MS) {
          setJobStatus('⚠ Upload timed out after 30 min');
          setSubmitting(false);
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
        let st: Response;
        try {
          st = await fetch(
            `${t}/upload-youtube/status?id=${encodeURIComponent(job_id)}`,
          );
        } catch {
          continue;
        }
        if (!st.ok) continue;
        const data = await st.json();
        const elapsed = Math.floor((Date.now() - start) / 1000);
        if (data.state === 'running') {
          setJobStatus(`Uploading · ${elapsed}s`);
          continue;
        }
        if (data.state === 'done') {
          setJobStatus(`✓ Uploaded in ${elapsed}s`);
          setJobResult({
            video_id: data.video_id,
            url: data.url,
            channel: data.channel,
          });
          setSubmitting(false);

          // Persist the upload back to Supabase so next time the modal
          // pre-fills with the same metadata.
          try {
            const r = await fetch(
              `/api/projects/${encodeURIComponent(projectId)}/upload-meta`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  title: title.trim(),
                  description,
                  tags,
                  thumbnail_seg_id: thumbSegId || undefined,
                  thumbnail_url: customThumbUrl.trim() || undefined,
                  kind,
                  last_uploaded_at: new Date().toISOString(),
                  last_video_id: data.video_id,
                  last_video_url: data.url,
                  last_channel: data.channel,
                }),
              },
            );
            if (r.ok) {
              const j = await r.json();
              if (j?.upload_meta && projectMeta) {
                onMetaPatched({ ...projectMeta, upload_meta: j.upload_meta });
              }
            } else {
              // Surface failure visibly. The upload itself succeeded, only
              // the Supabase-side metadata persistence failed — but silent
              // swallowing means the user thinks it saved and is confused
              // on the next upload when title/description/tags don't
              // pre-fill.
              const msg = (await r.text()).slice(0, 160);
              flash(
                `Upload succeeded but metadata persist failed (${r.status}): ${msg}`,
              );
              console.error('[YouTubeUploadModal] upload-meta PATCH failed', r.status, msg);
            }
          } catch (e: any) {
            flash(
              `Upload succeeded but metadata persist errored: ${String(e?.message || e).slice(0, 120)}`,
            );
            console.error('[YouTubeUploadModal] upload-meta PATCH error', e);
          }

          flash(`Uploaded to ${data.channel || channel} — ${data.url || 'success'}`);
          return;
        }
        if (data.state === 'failed') {
          setJobStatus(`✗ Upload failed: ${String(data.error || '').slice(0, 200)}`);
          setSubmitting(false);
          return;
        }
      }
    } catch (e: any) {
      setJobStatus(`Network: ${String(e?.message || e).slice(0, 160)}`);
      setSubmitting(false);
    }
  }, [
    canSubmit,
    tunnelUrl,
    projectId,
    channel,
    videoPath,
    title,
    description,
    tags,
    privacy,
    publishAt,
    resolvedThumbUrl,
    thumbSegId,
    customThumbUrl,
    kind,
    pinChannelToSeries,
    pinChannel,
    projectMeta,
    series,
    onMetaPatched,
    flash,
  ]);

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <div style={styles.headerTitle}>
            <Upload size={16} color="#fca5a5" />
            <span>Upload to YouTube</span>
          </div>
          <button
            onClick={onClose}
            style={styles.iconBtn}
            aria-label="Close"
            type="button"
          >
            <X size={16} />
          </button>
        </div>

        <div style={styles.body}>
          <div style={styles.filePath}>
            <span style={styles.dimLabel}>File</span>
            <code style={styles.pathCode}>{videoPath}</code>
          </div>

          {/* Channel chip + picker */}
          <div style={styles.row}>
            <label style={styles.label}>Channel</label>
            <button
              type="button"
              onClick={() => setShowChannelPicker((v) => !v)}
              style={styles.channelChip}
            >
              {selectedChannel ? (
                <>
                  <span style={styles.channelName}>{selectedChannel.name}</span>
                  {selectedChannel.handle && (
                    <span style={styles.channelHandle}>
                      {selectedChannel.handle}
                    </span>
                  )}
                </>
              ) : (
                <span style={{ color: '#a3a3a3' }}>pick a channel…</span>
              )}
              <ChevronDown size={14} />
            </button>
            {series && (
              <label style={styles.pinLabel}>
                <input
                  type="checkbox"
                  checked={pinChannelToSeries}
                  onChange={(e) => setPinChannelToSeries(e.target.checked)}
                />
                <span>pin to series "{series.title}"</span>
              </label>
            )}
          </div>
          {showChannelPicker && (
            <div style={styles.channelList}>
              {channelOptions.length === 0 && (
                <div style={styles.dimLabel}>
                  No channels registered. Make sure the tunnel is online and
                  <code> ~/.openclaw/scripts/youtube/channels.json </code>
                  exists.
                </div>
              )}
              {channelOptions.map((c) => (
                <button
                  key={c.slug}
                  type="button"
                  onClick={() => {
                    setChannel(c.slug);
                    setShowChannelPicker(false);
                  }}
                  style={{
                    ...styles.channelRow,
                    ...(c.slug === channel ? styles.channelRowActive : null),
                  }}
                >
                  <span>{c.name}</span>
                  <span style={styles.channelHandle}>
                    {c.handle} · {c.google_account}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Kind toggle */}
          <div style={styles.row}>
            <label style={styles.label}>Type</label>
            <div style={styles.segmented}>
              <button
                type="button"
                onClick={() => setKind('shorts')}
                style={{
                  ...styles.segmentedBtn,
                  ...(kind === 'shorts' ? styles.segmentedBtnActive : null),
                }}
              >
                Shorts (9:16, ≤60s)
              </button>
              <button
                type="button"
                onClick={() => setKind('longform')}
                style={{
                  ...styles.segmentedBtn,
                  ...(kind === 'longform' ? styles.segmentedBtnActive : null),
                }}
              >
                Long-form
              </button>
            </div>
          </div>
          {shortsWarnings.length > 0 && (
            <div style={styles.warn}>
              {shortsWarnings.map((w, i) => (
                <div key={i}>⚠ {w}</div>
              ))}
            </div>
          )}

          {/* Title */}
          <div style={styles.field}>
            <div style={styles.fieldHeader}>
              <label style={styles.label}>Title</label>
              <span style={styles.charCount}>{title.length}/100</span>
            </div>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, 100))}
              placeholder="e.g. Your brain has a sewer system…"
              style={styles.input}
              maxLength={100}
            />
          </div>

          {/* Description */}
          <div style={styles.field}>
            <div style={styles.fieldHeader}>
              <label style={styles.label}>Description</label>
              <span style={styles.charCount}>
                {description.length}/5000
              </span>
            </div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 5000))}
              placeholder="Episode notes, links, timestamps, sources…"
              style={styles.textarea}
              rows={6}
              maxLength={5000}
            />
          </div>

          {/* Tags */}
          <div style={styles.field}>
            <div style={styles.fieldHeader}>
              <label style={styles.label}>Tags</label>
              <span style={styles.dimLabel}>comma-separated</span>
            </div>
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="DrStickmanReid, Sleep, HealthFacts, Glymphatic"
              style={styles.input}
            />
          </div>

          {/* Thumbnail */}
          <div style={styles.field}>
            <div style={styles.fieldHeader}>
              <label style={styles.label}>Thumbnail</label>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={thumbUploading}
                style={{
                  ...styles.smallBtn,
                  ...(thumbUploading ? { opacity: 0.6, cursor: 'wait' } : null),
                }}
                title="Upload a JPG/PNG from your computer"
              >
                {thumbUploading ? (
                  <>
                    <Loader2
                      size={12}
                      style={{ animation: 'wm-spin 1s linear infinite' }}
                    />
                    uploading…
                  </>
                ) : (
                  <>
                    <ImagePlus size={12} /> upload thumbnail
                  </>
                )}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/jpg,image/webp"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onThumbFile(f);
                  e.target.value = '';
                }}
              />
              <span style={styles.dimLabel}>or paste URL ↓</span>
            </div>
            <input
              type="text"
              value={customThumbUrl}
              onChange={(e) => {
                setCustomThumbUrl(e.target.value);
                if (e.target.value) setThumbSegId('');
              }}
              placeholder="https://…/thumb.jpg (or upload above · or pick a frame below)"
              style={{ ...styles.input, marginTop: 6 }}
            />
            {customThumbUrl && (
              <div style={{ marginTop: 6 }}>
                <img
                  src={customThumbUrl}
                  alt="thumbnail preview"
                  style={{
                    maxWidth: 220,
                    maxHeight: 124,
                    objectFit: 'cover',
                    border: '1px solid #f59e0b',
                    borderRadius: 6,
                    display: 'block',
                  }}
                />
              </div>
            )}
            <div style={styles.thumbGrid}>
              {framedSegments.length === 0 && (
                <div style={styles.dimLabel}>
                  No generated frames yet — generate at least one so the picker
                  has options.
                </div>
              )}
              {framedSegments.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setThumbSegId(thumbSegId === s.id ? '' : s.id);
                    setCustomThumbUrl('');
                  }}
                  style={{
                    ...styles.thumbTile,
                    ...(thumbSegId === s.id ? styles.thumbTileActive : null),
                  }}
                  title={s.narration?.slice(0, 80)}
                >
                  <img
                    src={s.frame_url || ''}
                    alt={s.id}
                    style={styles.thumbImg}
                  />
                  <span style={styles.thumbLabel}>{s.id}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Privacy + schedule */}
          <div style={styles.row}>
            <label style={styles.label}>Privacy</label>
            <div style={styles.segmented}>
              {(['private', 'unlisted', 'public'] as Privacy[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPrivacy(p)}
                  style={{
                    ...styles.segmentedBtn,
                    ...(privacy === p ? styles.segmentedBtnActive : null),
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div style={styles.field}>
            <div style={styles.fieldHeader}>
              <label style={styles.label}>
                Schedule (optional — privacy forced to private until unlock)
              </label>
            </div>
            <input
              type="datetime-local"
              value={publishAt}
              onChange={(e) => setPublishAt(e.target.value)}
              style={styles.input}
            />
          </div>

          {/* A/B note */}
          <div style={styles.abNote}>
            <strong>A/B thumbnails:</strong> YouTube's Test & Compare feature
            isn't exposed via the Data API. After upload, open the video in
            YouTube Studio → Details → Thumbnail → Test & compare to add up
            to 3 variants. Requires channels with ≥1 000 subs or YPP
            membership.
          </div>
        </div>

        <div style={styles.footer}>
          {jobStatus && (
            <span
              style={{
                ...styles.statusText,
                color: jobStatus.startsWith('✗')
                  ? '#fca5a5'
                  : jobStatus.startsWith('✓')
                    ? '#86efac'
                    : '#a3a3a3',
              }}
            >
              {jobStatus}
            </span>
          )}
          {jobResult?.url && (
            <a
              href={jobResult.url}
              target="_blank"
              rel="noreferrer"
              style={styles.link}
            >
              {jobResult.url} <ExternalLink size={12} />
            </a>
          )}
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={styles.secondaryBtn} type="button">
            {jobResult ? 'Close' : 'Cancel'}
          </button>
          {!jobResult && (
            <button
              onClick={submit}
              disabled={!canSubmit}
              style={{
                ...styles.primaryBtn,
                ...(canSubmit ? null : styles.btnDisabled),
              }}
              type="button"
            >
              {submitting ? (
                <>
                  <Loader2
                    size={14}
                    style={{ animation: 'wm-spin 1s linear infinite' }}
                  />
                  Uploading…
                </>
              ) : (
                <>
                  <Upload size={14} /> Upload
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.72)',
    zIndex: 200,
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: 20,
    overflowY: 'auto',
  },
  dialog: {
    width: '100%',
    maxWidth: 720,
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 10,
    boxShadow: '0 24px 48px rgba(0,0,0,0.6)',
    display: 'flex',
    flexDirection: 'column',
    maxHeight: 'calc(100vh - 40px)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 16px',
    borderBottom: '1px solid #262626',
  },
  headerTitle: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    fontWeight: 600,
    fontSize: 14,
    color: '#e5e5e5',
    flex: 1,
  },
  iconBtn: {
    background: 'transparent',
    border: 'none',
    color: '#a3a3a3',
    cursor: 'pointer',
    padding: 6,
    borderRadius: 4,
  },
  body: {
    padding: 16,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
  },
  filePath: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    background: '#171717',
    border: '1px solid #262626',
    borderRadius: 6,
  },
  pathCode: {
    fontFamily: 'ui-monospace, monospace',
    fontSize: 11,
    color: '#86efac',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  label: {
    fontSize: 11,
    color: '#a3a3a3',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    fontWeight: 600,
    minWidth: 90,
  },
  dimLabel: { fontSize: 11, color: '#737373' },
  charCount: { fontSize: 10, color: '#737373', fontVariantNumeric: 'tabular-nums' },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  fieldHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  input: {
    width: '100%',
    background: '#171717',
    color: '#f5f5f5',
    border: '1px solid #404040',
    borderRadius: 6,
    padding: '8px 10px',
    fontSize: 13,
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  },
  textarea: {
    width: '100%',
    background: '#171717',
    color: '#f5f5f5',
    border: '1px solid #404040',
    borderRadius: 6,
    padding: '8px 10px',
    fontSize: 13,
    fontFamily: 'inherit',
    boxSizing: 'border-box',
    resize: 'vertical',
    lineHeight: 1.45,
  },
  channelChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    background: '#171717',
    color: '#e5e5e5',
    border: '1px solid #404040',
    borderRadius: 999,
    padding: '6px 12px',
    fontSize: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  channelName: { fontWeight: 600 },
  channelHandle: { color: '#a3a3a3', fontSize: 11 },
  pinLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    color: '#a3a3a3',
  },
  channelList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: 6,
    background: '#171717',
    border: '1px solid #262626',
    borderRadius: 6,
  },
  channelRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '8px 10px',
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 5,
    color: '#e5e5e5',
    cursor: 'pointer',
    fontSize: 12,
    fontFamily: 'inherit',
  },
  channelRowActive: {
    borderColor: '#f59e0b',
    background: 'rgba(59,36,10,0.92)',
  },
  segmented: {
    display: 'inline-flex',
    gap: 2,
    padding: 2,
    background: '#171717',
    border: '1px solid #262626',
    borderRadius: 6,
  },
  segmentedBtn: {
    padding: '5px 10px',
    fontSize: 11,
    background: 'transparent',
    color: '#a3a3a3',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontFamily: 'inherit',
    textTransform: 'capitalize',
  },
  segmentedBtnActive: {
    background: '#262626',
    color: '#f5f5f5',
  },
  warn: {
    padding: '6px 10px',
    background: '#3d2e0f',
    color: '#fde68a',
    border: '1px solid #b45309',
    borderRadius: 6,
    fontSize: 11,
    lineHeight: 1.5,
  },
  thumbGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))',
    gap: 6,
    marginTop: 6,
  },
  thumbTile: {
    position: 'relative',
    padding: 2,
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 5,
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    fontFamily: 'inherit',
  },
  thumbTileActive: {
    borderColor: '#f59e0b',
    background: 'rgba(59,36,10,0.92)',
  },
  thumbImg: {
    width: '100%',
    aspectRatio: '16 / 9',
    objectFit: 'cover',
    borderRadius: 3,
    display: 'block',
  },
  thumbLabel: {
    fontSize: 9,
    color: '#a3a3a3',
    textAlign: 'center',
    fontFamily: 'ui-monospace, monospace',
  },
  smallBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 8px',
    background: '#171717',
    color: '#e5e5e5',
    border: '1px solid #404040',
    borderRadius: 5,
    fontSize: 11,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  abNote: {
    padding: '8px 10px',
    background: '#0c1e3a',
    color: '#93c5fd',
    border: '1px solid #1e40af',
    borderRadius: 6,
    fontSize: 11,
    lineHeight: 1.55,
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '12px 16px',
    borderTop: '1px solid #262626',
    flexWrap: 'wrap',
  },
  statusText: { fontSize: 11, fontFamily: 'ui-monospace, monospace' },
  link: {
    color: '#86efac',
    fontSize: 12,
    fontFamily: 'ui-monospace, monospace',
    textDecoration: 'none',
    display: 'inline-flex',
    gap: 4,
    alignItems: 'center',
  },
  primaryBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: '#7f1d1d',
    color: '#fee2e2',
    border: '1px solid #991b1b',
    borderRadius: 6,
    padding: '8px 14px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  secondaryBtn: {
    background: 'transparent',
    color: '#a3a3a3',
    border: '1px solid #404040',
    borderRadius: 6,
    padding: '8px 14px',
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnDisabled: { opacity: 0.45, cursor: 'not-allowed' },
};
