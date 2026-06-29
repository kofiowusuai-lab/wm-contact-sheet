'use client';

// Sits under the PreviewPlayer. Two actions on one bar:
//
//   1. Render — kicks the tunnel /render job that assembles the full
//      episode MP4 (runs render_from_supabase.py). Shows a count-up
//      timer while in flight. On success, stores the output path and
//      unlocks the upload button.
//
//   2. Upload to YouTube — opens YouTubeUploadModal, passing the last
//      render's output path so the user skips the "pick a file" step.
//      Modal calls the tunnel /upload-youtube endpoint, polls status,
//      persists the final title/description/tags/video_url back to
//      Supabase via /api/projects/{id}/upload-meta.
//
// Design:
//   - Render works for any project with a non-empty timeline.
//   - Upload only enables when: tunnel is up, render is done, there's a
//     matching youtube channel (either series.youtube_channel is set or
//     the modal lets the user pick one ad-hoc).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Film, Upload, Loader2, CircleAlert } from 'lucide-react';
import type { ProjectMeta, Segment, SeriesMeta } from '../lib/blob';
import type { SubtitleSettings } from './SubtitleOverlay';
import YouTubeUploadModal from './YouTubeUploadModal';

type Props = {
  projectId: string;
  projectMeta: ProjectMeta | null;
  series: SeriesMeta | null;
  segments: Segment[];
  tunnelUrl: string | null;
  tunnelOk: boolean;
  aspect: string | undefined;
  subtitles: SubtitleSettings;
  onMetaPatched: (next: ProjectMeta) => void;
  onSeriesPatched: (next: SeriesMeta) => void;
  flash: (msg: string) => void;
};

export default function RenderUploadBar({
  projectId,
  projectMeta,
  series,
  segments,
  tunnelUrl,
  tunnelOk,
  aspect,
  subtitles,
  onMetaPatched,
  onSeriesPatched,
  flash,
}: Props) {
  const [renderBusy, setRenderBusy] = useState(false);
  const [renderStatus, setRenderStatus] = useState<string | null>(null);
  const [renderSeconds, setRenderSeconds] = useState(0);
  const [renderedPath, setRenderedPath] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const tickRef = useRef<number | null>(null);

  // Tick the count-up timer every second while render is in flight.
  useEffect(() => {
    if (!renderBusy) {
      if (tickRef.current) window.clearInterval(tickRef.current);
      return;
    }
    setRenderSeconds(0);
    const start = Date.now();
    tickRef.current = window.setInterval(() => {
      setRenderSeconds(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current);
    };
  }, [renderBusy]);

  const canRender = Boolean(
    tunnelUrl && tunnelOk && segments.length > 0 && !renderBusy,
  );
  const lastSegId = segments.length ? segments[segments.length - 1].id : null;

  const runRender = useCallback(async () => {
    if (!canRender || !tunnelUrl || !lastSegId) return;
    setRenderedPath(null);
    setRenderBusy(true);
    setRenderStatus('Submitting…');
    const t = tunnelUrl.replace(/\/+$/, '');
    try {
      const sub = await fetch(`${t}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          end_seg_id: lastSegId,
          subtitles: subtitles ?? null,
        }),
      });
      if (!sub.ok) {
        const msg = (await sub.text()).slice(0, 140);
        setRenderStatus(`Submit ${sub.status}: ${msg}`);
        setRenderBusy(false);
        return;
      }
      const { job_id } = await sub.json();
      const start = Date.now();
      const HARD_TIMEOUT_MS = 30 * 60 * 1000;
      let sawRunning = false;
      for (;;) {
        if (Date.now() - start > HARD_TIMEOUT_MS) {
          setRenderStatus('⚠ Timed out after 30 min — check tunnel logs');
          setRenderBusy(false);
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
        let st: Response;
        try {
          st = await fetch(`${t}/render/status?id=${encodeURIComponent(job_id)}`);
        } catch {
          continue;
        }
        if (st.status === 404 && sawRunning) {
          setRenderStatus('✓ Done (path unknown — tunnel purged)');
          setRenderBusy(false);
          return;
        }
        if (!st.ok) continue;
        const data = await st.json();
        if (data.state === 'running') {
          sawRunning = true;
          setRenderStatus(`Rendering…`);
          continue;
        }
        if (data.state === 'done') {
          setRenderedPath(data.output || null);
          setRenderStatus(data.output ? `✓ Rendered to ${data.output}` : '✓ Done');
          setRenderBusy(false);
          return;
        }
        if (data.state === 'failed') {
          setRenderStatus(`✗ Render failed: ${String(data.error || '').slice(0, 160)}`);
          setRenderBusy(false);
          return;
        }
      }
    } catch (e: any) {
      setRenderStatus(`Network: ${String(e?.message || e).slice(0, 120)}`);
      setRenderBusy(false);
    }
  }, [canRender, tunnelUrl, projectId, lastSegId, subtitles]);

  // Upload is available as soon as a render path exists. Tunnel must be
  // online because the upload shells to yt-upload.py on the local box.
  const canUpload = Boolean(renderedPath && tunnelUrl && tunnelOk);

  const rs = renderSeconds;
  const mm = Math.floor(rs / 60).toString().padStart(2, '0');
  const ss = (rs % 60).toString().padStart(2, '0');

  return (
    <>
      <div style={styles.wrap}>
        <button
          type="button"
          onClick={runRender}
          disabled={!canRender}
          style={{
            ...styles.renderBtn,
            ...(canRender ? null : styles.btnDisabled),
          }}
          title={
            !tunnelUrl || !tunnelOk
              ? 'Tunnel offline — start wm_server.py to render'
              : segments.length === 0
                ? 'No timeline yet — generate the voiceover first'
                : 'Render the full episode to an MP4 via the local tunnel'
          }
        >
          {renderBusy ? (
            <>
              <Loader2 size={14} style={{ animation: 'wm-spin 1s linear infinite' }} />
              <span>Rendering · {mm}:{ss}</span>
            </>
          ) : (
            <>
              <Film size={14} />
              <span>Render full episode</span>
            </>
          )}
        </button>

        <button
          type="button"
          onClick={() => setShowModal(true)}
          disabled={!canUpload}
          style={{
            ...styles.uploadBtn,
            ...(canUpload ? null : styles.btnDisabled),
          }}
          title={
            !renderedPath
              ? 'Render the episode first'
              : !tunnelOk
                ? 'Tunnel offline — upload runs on the local tunnel'
                : `Upload ${renderedPath} to YouTube`
          }
        >
          <Upload size={14} />
          <span>Upload to YouTube</span>
        </button>

        {renderStatus && (
          <span
            style={{
              ...styles.statusText,
              color: renderStatus.startsWith('✗')
                ? '#fca5a5'
                : renderStatus.startsWith('✓')
                  ? '#86efac'
                  : '#a3a3a3',
            }}
          >
            {renderStatus}
          </span>
        )}
        {!tunnelOk && (
          <span style={styles.tunnelWarn}>
            <CircleAlert size={12} /> tunnel offline
          </span>
        )}
      </div>

      {showModal && canUpload && renderedPath && (
        <YouTubeUploadModal
          projectId={projectId}
          projectMeta={projectMeta}
          series={series}
          segments={segments}
          tunnelUrl={tunnelUrl!}
          aspect={aspect}
          videoPath={renderedPath}
          onClose={() => setShowModal(false)}
          onMetaPatched={onMetaPatched}
          onSeriesPatched={onSeriesPatched}
          flash={flash}
        />
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
    marginTop: 10,
    padding: '10px 12px',
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 8,
  },
  renderBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    background: '#1e293b',
    color: '#e2e8f0',
    border: '1px solid #475569',
    borderRadius: 6,
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    minHeight: 40,
  },
  uploadBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    background: '#7f1d1d',
    color: '#fee2e2',
    border: '1px solid #991b1b',
    borderRadius: 6,
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    minHeight: 40,
  },
  btnDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
  },
  statusText: {
    fontSize: 12,
    fontFamily: 'ui-monospace, monospace',
  },
  tunnelWarn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    color: '#fca5a5',
    marginLeft: 'auto',
  },
};
