'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import VoicePicker from './VoicePicker';
import VoiceLibraryModal from './VoiceLibraryModal';
import CastPanel from './CastPanel';
import type { VoiceoverGeneration, CastDoc } from '../lib/blob';
import { speakersUsed } from '../lib/parseSpeakerTags';
import { useIsMobile } from '../lib/useMediaQuery';
import { Save, RefreshCw, RotateCcw, Wand2, Square, Crosshair } from 'lucide-react';
import { Button } from './ui';

type Voice = { voice_id: string; name: string; preview_url?: string; category?: string; public_owner_id?: string };

export default function ScriptBar({
  projectId,
  initialScript,
  voiceoverUrl,
  currentVoiceId,
  activeVoiceId,
  voiceoverGenerations = [],
  initialCast,
  onPipelineDone,
  flash,
  tunnelUrl,
}: {
  projectId: string;
  initialScript: string;
  voiceoverUrl: string | null;
  /** Voice the user has picked in the dropdown — persists across refreshes. */
  currentVoiceId?: string;
  /** Voice whose bytes are actually in voiceover.mp3. Equals currentVoiceId
   *  only after a TTS run or a /voiceovers/select swap; lags when the user
   *  just picked a new voice but hasn't regenerated. */
  activeVoiceId?: string;
  voiceoverGenerations?: VoiceoverGeneration[];
  /** Cast doc supplied by the main project bundle, forwarded to CastPanel
   *  so transient /cast fetches don't blank the UI on refresh. */
  initialCast?: CastDoc | null;
  onPipelineDone: () => void;
  flash: (msg: string) => void;
  tunnelUrl: string | null;
}) {
  const [script, setScript] = useState(initialScript);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState(currentVoiceId || '');
  const [searchName, setSearchName] = useState('');
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const cancelRef = useRef(false);
  const isMobile = useIsMobile();

  useEffect(() => {
    setScript(initialScript);
  }, [initialScript]);

  useEffect(() => {
    setVoiceId(currentVoiceId || '');
  }, [currentVoiceId]);

  const refreshVoices = useCallback(async (q = '') => {
    const r = await fetch(`/api/voices${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    if (!r.ok) return;
    const data = (await r.json()) as { voices: Voice[] };
    setVoices(data.voices || []);
    // Deliberately do NOT auto-pick voices[0] when voiceId is empty. The user
    // may have just landed on a project that has never had a voice set — we
    // want the picker to stay empty so their first explicit pick is what gets
    // persisted, instead of silently defaulting then quietly overwriting
    // meta on the next TTS run.
  }, []);

  useEffect(() => {
    refreshVoices();
  }, [refreshVoices]);

  // Live list of uppercased character names the script tags with
  // `@CHARACTER:`. Flows down to CastPanel so newly-added speakers
  // get cast slots the moment the writer types them.
  const speakersInScriptList = useMemo(() => speakersUsed(script), [script]);

  // Helper used before firing pipeline calls: pull the fresh cast doc
  // so the tunnel can route `@NAME:` lines to the right voice. Returns
  // { cast, missing } — missing is an array of character names that
  // have NO voice cast. When any are missing we still proceed (those
  // lines fall back to narrator) but surface a flash warning.
  const buildCastForPipeline = useCallback(async (): Promise<{
    cast: Record<string, { voice_id: string; voice_name: string }>;
    missing: string[];
  }> => {
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/cast`, {
        cache: 'no-store',
      });
      if (!r.ok) return { cast: {}, missing: speakersInScriptList };
      const doc = (await r.json()) as CastDoc;
      const cast: Record<string, { voice_id: string; voice_name: string }> = {};
      const missing: string[] = [];
      for (const name of speakersInScriptList) {
        const entry = doc.characters[name];
        if (entry && entry.voice_id) {
          cast[name] = { voice_id: entry.voice_id, voice_name: entry.voice_name };
        } else {
          missing.push(name);
        }
      }
      return { cast, missing };
    } catch {
      return { cast: {}, missing: speakersInScriptList };
    }
  }, [projectId, speakersInScriptList]);

  const runPipeline = useCallback(async () => {
    if (!script.trim()) {
      flash('Paste a script first');
      return;
    }
    if (!voiceId) {
      flash('Pick a voice first');
      return;
    }
    setRunning(true);
    try {
      // Always persist the script first (short call, works on Hobby)
      setStatus('Saving script…');
      let r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/script`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: script,
      });
      if (!r.ok) throw new Error(`script save ${r.status}`);

      if (tunnelUrl) {
        // Tunnel path — no duration cap. Submit + poll.
        setStatus('Starting pipeline on local tunnel…');
        const { cast, missing } = await buildCastForPipeline();
        if (missing.length > 0) {
          flash(
            `Heads-up: no voice cast for ${missing.join(', ')} — those lines will use the narrator voice.`,
          );
        }
        const sub = await fetch(`${tunnelUrl.replace(/\/+$/, '')}/pipeline`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            voice_id: voiceId,
            voice_name: voices.find((v) => v.voice_id === voiceId)?.name,
            cast: Object.keys(cast).length > 0 ? cast : null,
          }),
        });
        if (!sub.ok) throw new Error(`pipeline submit ${sub.status}: ${(await sub.text()).slice(0, 200)}`);
        const { job_id } = await sub.json();
        setCurrentJobId(job_id);
        cancelRef.current = false;
        const start = Date.now();
        for (;;) {
          await new Promise((r) => setTimeout(r, 2500));
          const st = await fetch(`${tunnelUrl.replace(/\/+$/, '')}/pipeline/status?id=${encodeURIComponent(job_id)}`);
          const data = st.ok ? await st.json() : null;
          const elapsed = Math.floor((Date.now() - start) / 1000);
          setStatus(`Running on tunnel… ${elapsed}s (${data?.state || 'polling'})`);
          if (data?.state === 'done') {
            setStatus(`Done — ${data.result?.vo_count ?? '?'} segments`);
            flash(`Pipeline done: ${data.result?.vo_count ?? '?'} segments`);
            onPipelineDone();
            return;
          }
          if (data?.state === 'cancelled') {
            setStatus('Cancelled');
            flash('Pipeline cancelled');
            return;
          }
          if (data?.state === 'failed') {
            throw new Error(data.error || 'pipeline failed on tunnel');
          }
        }
      }

      // Vercel path — short scripts only (Hobby 60s cap)
      setStatus('Generating voiceover on Vercel (≤60s cap — use tunnel for longer scripts)…');
      r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voice_id: voiceId,
          voice_name: voices.find((v) => v.voice_id === voiceId)?.name,
        }),
      });
      if (!r.ok) throw new Error(`tts ${r.status}: ${(await r.text()).slice(0, 200)}`);

      setStatus('Transcribing with Whisper…');
      r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/transcribe`, { method: 'POST' });
      if (!r.ok) throw new Error(`transcribe ${r.status}: ${(await r.text()).slice(0, 200)}`);

      setStatus('Aligning segments…');
      r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/align`, { method: 'POST' });
      if (!r.ok) throw new Error(`align ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const a = await r.json();
      setStatus(`Done — ${a.count} segments`);
      flash(`Pipeline done: ${a.count} segments`);
      onPipelineDone();
    } catch (e: any) {
      setStatus(`Failed: ${String(e?.message || e).slice(0, 150)}`);
      flash(`Pipeline failed: ${String(e?.message || e).slice(0, 150)}`);
    } finally {
      setRunning(false);
      setCurrentJobId(null);
    }
  }, [script, voiceId, projectId, flash, onPipelineDone, tunnelUrl]);

  const stopPipeline = useCallback(async () => {
    if (!tunnelUrl || !currentJobId) return;
    try {
      await fetch(`${tunnelUrl.replace(/\/+$/, '')}/pipeline/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: currentJobId }),
      });
      setStatus('Cancelling after current step…');
      flash('Cancel requested');
    } catch {
      flash('Cancel request failed');
    }
  }, [tunnelUrl, currentJobId, flash]);

  const activateGeneratedVoice = useCallback(
    async (voice_id: string) => {
      // Zero-cost swap: the mp3 already exists under voiceovers/{voice_id}.mp3.
      // We just tell the server to copy it to voiceover.mp3 and update meta.
      setRunning(true);
      try {
        setStatus('Swapping to previously generated voice…');
        const r = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/voiceovers/select`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voice_id }),
          },
        );
        if (!r.ok) {
          throw new Error(`${r.status}: ${(await r.text()).slice(0, 150)}`);
        }
        setStatus('✓ Voice swapped — no re-generation needed');
        flash('Voice swapped');
        onPipelineDone();
      } catch (e: any) {
        setStatus(`Swap failed: ${String(e?.message || e).slice(0, 150)}`);
        flash(`Swap failed: ${String(e?.message || e).slice(0, 150)}`);
      } finally {
        setRunning(false);
      }
    },
    [projectId, flash, onPipelineDone],
  );

  const onVoicePickerChange = useCallback(
    (next_voice_id: string) => {
      if (next_voice_id === voiceId) return;
      setVoiceId(next_voice_id);
      // If we already have an mp3 for this voice, swap it in immediately so
      // the user can render without re-running TTS. `activateGeneratedVoice`
      // also writes voice_id to meta as part of /voiceovers/select.
      const has = voiceoverGenerations.some((g) => g.voice_id === next_voice_id);
      if (has) {
        void activateGeneratedVoice(next_voice_id);
        return;
      }
      // No generation yet — persist the picker choice so a refresh doesn't
      // snap back to the last generated voice. We now AWAIT the response and
      // surface errors: earlier this was fire-and-forget and a silent PUT
      // failure meant the picker showed the new voice locally but meta.json
      // still had the old one, so refreshing reverted the selection.
      const voice_name = voices.find((v) => v.voice_id === next_voice_id)?.name ?? '';
      (async () => {
        try {
          const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/voice`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voice_id: next_voice_id, voice_name }),
          });
          if (!r.ok) {
            const t = await r.text().catch(() => '');
            flash(`Voice save failed (${r.status}): ${t.slice(0, 120)}`);
          }
        } catch (e: any) {
          flash(`Voice save failed: ${String(e?.message || e).slice(0, 120)}`);
        }
      })();
    },
    [voiceId, voiceoverGenerations, activateGeneratedVoice, voices, projectId, flash],
  );

  const changeVoiceOnly = useCallback(async () => {
    if (!voiceId) {
      flash('Pick a voice first');
      return;
    }
    setRunning(true);
    try {
      // Save any script edits first so the new voiceover matches what's in
      // the editor, but do NOT run transcribe/align — those would rebuild
      // the timeline and wipe existing frame mappings.
      setStatus('Saving script…');
      let r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/script`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: script,
      });
      if (!r.ok) throw new Error(`script save ${r.status}`);

      if (tunnelUrl) {
        setStatus('Regenerating voiceover on tunnel (no timeline rewrite)…');
        const { cast } = await buildCastForPipeline();
        const sub = await fetch(`${tunnelUrl.replace(/\/+$/, '')}/pipeline/tts-only`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            voice_id: voiceId,
            voice_name: voices.find((v) => v.voice_id === voiceId)?.name,
            cast: Object.keys(cast).length > 0 ? cast : null,
          }),
        });
        if (!sub.ok) throw new Error(`tts-only submit ${sub.status}: ${(await sub.text()).slice(0, 200)}`);
        const { job_id } = await sub.json();
        setCurrentJobId(job_id);
        cancelRef.current = false;
        const start = Date.now();
        for (;;) {
          await new Promise((r) => setTimeout(r, 2000));
          const st = await fetch(`${tunnelUrl.replace(/\/+$/, '')}/pipeline/status?id=${encodeURIComponent(job_id)}`);
          const data = st.ok ? await st.json() : null;
          const elapsed = Math.floor((Date.now() - start) / 1000);
          setStatus(`Regenerating voice on tunnel… ${elapsed}s (${data?.state || 'polling'})`);
          if (data?.state === 'done') {
            setStatus('✓ New voice ready — timeline + frames untouched');
            flash('Voice changed — frames preserved');
            onPipelineDone();
            return;
          }
          if (data?.state === 'cancelled') {
            setStatus('Cancelled');
            return;
          }
          if (data?.state === 'failed') {
            throw new Error(data.error || 'tts-only failed on tunnel');
          }
        }
      }

      // Vercel path — TTS only (60s cap). No transcribe, no align.
      setStatus('Regenerating voiceover on Vercel (timeline + frames preserved)…');
      r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voice_id: voiceId,
          voice_name: voices.find((v) => v.voice_id === voiceId)?.name,
        }),
      });
      if (!r.ok) throw new Error(`tts ${r.status}: ${(await r.text()).slice(0, 200)}`);
      setStatus('✓ New voice ready — timeline + frames untouched');
      flash('Voice changed — frames preserved');
      onPipelineDone();
    } catch (e: any) {
      setStatus(`Failed: ${String(e?.message || e).slice(0, 150)}`);
      flash(`Voice change failed: ${String(e?.message || e).slice(0, 150)}`);
    } finally {
      setRunning(false);
      setCurrentJobId(null);
    }
  }, [script, voiceId, projectId, flash, onPipelineDone, tunnelUrl]);

  // Regenerate voiceover + re-transcribe + realign, but PRESERVE each
  // existing segment's frame_url / prompt / ken_burns / aspect / location.
  // Use this when the script changed only for pacing (break tags, small
  // punctuation tweaks) and you don't want to lose per-segment work.
  const refitTimings = useCallback(async () => {
    if (!voiceId) {
      flash('Pick a voice first');
      return;
    }
    setRunning(true);
    try {
      setStatus('Saving script…');
      let r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/script`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: script,
      });
      if (!r.ok) throw new Error(`script save ${r.status}`);

      if (tunnelUrl) {
        // Tunnel path runs the full TTS + transcribe loop on the local box
        // via the existing /pipeline endpoint but with a new step-type flag
        // so we stop before /align. The pipeline job already produces
        // words.json as part of transcribe; we just need to skip re-align.
        setStatus('Regenerating voiceover on tunnel…');
        const { cast } = await buildCastForPipeline();
        const sub = await fetch(`${tunnelUrl.replace(/\/+$/, '')}/pipeline/tts-only`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            voice_id: voiceId,
            voice_name: voices.find((v) => v.voice_id === voiceId)?.name,
            cast: Object.keys(cast).length > 0 ? cast : null,
          }),
        });
        if (!sub.ok) throw new Error(`tts submit ${sub.status}: ${(await sub.text()).slice(0, 200)}`);
        const { job_id } = await sub.json();
        setCurrentJobId(job_id);
        const start = Date.now();
        for (;;) {
          await new Promise((r) => setTimeout(r, 2000));
          const st = await fetch(`${tunnelUrl.replace(/\/+$/, '')}/pipeline/status?id=${encodeURIComponent(job_id)}`);
          const data = st.ok ? await st.json() : null;
          const elapsed = Math.floor((Date.now() - start) / 1000);
          setStatus(`Regenerating voice on tunnel… ${elapsed}s (${data?.state || 'polling'})`);
          if (data?.state === 'done') break;
          if (data?.state === 'failed') {
            throw new Error(data.error || 'tts failed on tunnel');
          }
          if (data?.state === 'cancelled') {
            setStatus('Cancelled');
            return;
          }
        }
      } else {
        setStatus('Regenerating voiceover on Vercel…');
        r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            voice_id: voiceId,
            voice_name: voices.find((v) => v.voice_id === voiceId)?.name,
          }),
        });
        if (!r.ok) throw new Error(`tts ${r.status}: ${(await r.text()).slice(0, 200)}`);
      }

      setStatus('Re-transcribing with Whisper…');
      r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/transcribe`, {
        method: 'POST',
      });
      if (!r.ok) throw new Error(`transcribe ${r.status}: ${(await r.text()).slice(0, 200)}`);

      setStatus('Refitting segment timings to new audio…');
      r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/realign-preserve`, {
        method: 'POST',
      });
      if (!r.ok) throw new Error(`realign ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const data = (await r.json()) as {
        count: number;
        matched: number;
        unmatched: string[];
      };

      const warn = data.unmatched.length
        ? ` (${data.unmatched.length} unmatched: ${data.unmatched.slice(0, 4).join(', ')}${data.unmatched.length > 4 ? '…' : ''})`
        : '';
      setStatus(`✓ Refit done — ${data.matched}/${data.count} segments re-timed${warn}`);
      flash(`Refit: ${data.matched}/${data.count} segments re-timed, frames preserved`);
      onPipelineDone();
    } catch (e: any) {
      setStatus(`Failed: ${String(e?.message || e).slice(0, 150)}`);
      flash(`Refit failed: ${String(e?.message || e).slice(0, 150)}`);
    } finally {
      setRunning(false);
      setCurrentJobId(null);
    }
  }, [script, voiceId, projectId, flash, onPipelineDone, tunnelUrl, voices]);

  // Sync to TTS — re-fit existing timeline segments to the CURRENT
  // voiceover.mp3 without regenerating audio. Whisper-transcribes the
  // existing audio and updates each segment's start/end to match the
  // actual word positions. Use this after editing narrations or whenever
  // captions/frames drift from the audio.
  const syncToTts = useCallback(async () => {
    setRunning(true);
    try {
      if (tunnelUrl) {
        setStatus('Whisper realign on tunnel…');
        const sub = await fetch(`${tunnelUrl.replace(/\/+$/, '')}/pipeline/realign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: projectId }),
        });
        if (!sub.ok) throw new Error(`realign submit ${sub.status}: ${(await sub.text()).slice(0, 200)}`);
        const { job_id } = await sub.json();
        setCurrentJobId(job_id);
        cancelRef.current = false;
        const start = Date.now();
        for (;;) {
          await new Promise((r) => setTimeout(r, 2000));
          const st = await fetch(`${tunnelUrl.replace(/\/+$/, '')}/pipeline/status?id=${encodeURIComponent(job_id)}`);
          const data = st.ok ? await st.json() : null;
          const elapsed = Math.floor((Date.now() - start) / 1000);
          setStatus(`Realigning… ${elapsed}s (${data?.state || 'polling'})`);
          if (data?.state === 'done') {
            const r = (data.result || {}) as {
              matched?: number;
              skipped?: number;
              avg_drift_sec?: number;
              max_drift_sec?: number;
            };
            const drift = r.max_drift_sec != null ? `, max drift ${r.max_drift_sec}s` : '';
            setStatus(`✓ Synced — ${r.matched ?? '?'} matched, ${r.skipped ?? 0} skipped${drift}`);
            flash(`Synced ${r.matched ?? '?'} segments to current voiceover`);
            onPipelineDone();
            return;
          }
          if (data?.state === 'failed') throw new Error(data.error || 'realign failed on tunnel');
          if (data?.state === 'cancelled') {
            setStatus('Cancelled');
            return;
          }
        }
      }

      // Vercel fallback — chain transcribe + realign-preserve. Each call
      // must complete inside Vercel's 60s function budget, so this only
      // works on shorter episodes.
      setStatus('Re-transcribing with Whisper on Vercel…');
      let r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/transcribe`, { method: 'POST' });
      if (!r.ok) throw new Error(`transcribe ${r.status}: ${(await r.text()).slice(0, 200)}`);
      setStatus('Realigning timeline…');
      r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/realign-preserve`, { method: 'POST' });
      if (!r.ok) throw new Error(`realign ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const data = (await r.json()) as { count: number; matched: number; unmatched: string[] };
      const warn = data.unmatched?.length
        ? ` (${data.unmatched.length} unmatched)`
        : '';
      setStatus(`✓ Synced — ${data.matched}/${data.count} segments${warn}`);
      flash(`Synced ${data.matched}/${data.count} segments to current voiceover`);
      onPipelineDone();
    } catch (e: any) {
      setStatus(`Failed: ${String(e?.message || e).slice(0, 150)}`);
      flash(`Sync failed: ${String(e?.message || e).slice(0, 150)}`);
    } finally {
      setRunning(false);
      setCurrentJobId(null);
    }
  }, [projectId, flash, onPipelineDone, tunnelUrl]);

  const saveScriptOnly = useCallback(async () => {
    setStatus('Saving script…');
    const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/script`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: script,
    });
    if (r.ok) {
      setStatus('Script saved.');
      flash('Script saved');
    } else setStatus('Save failed');
  }, [script, projectId, flash]);

  return (
    <div style={styles.bar}>
      <div style={styles.header}>Script + voice</div>
      <textarea
        value={script}
        onChange={(e) => setScript(e.target.value)}
        placeholder="Paste the narration script here. Two newlines between paragraphs."
        style={{ ...styles.textarea, ...(isMobile ? styles.textareaMobile : null) }}
      />
      <div style={styles.voicePickerWrap}>
        <div style={{ ...styles.voicePickerHeader, ...(isMobile ? styles.voicePickerHeaderMobile : null) }}>
          <div style={styles.voicePickerLabel}>Voice</div>
          <div style={styles.voicePickerCount}>
            {voices.length} {voices.length === 1 ? 'option' : 'options'}
            {voiceId && voices.find((v) => v.voice_id === voiceId) && (
              <>
                {' · selected: '}
                <span style={{ color: '#c4b5fd' }}>
                  {voices.find((v) => v.voice_id === voiceId)?.name}
                </span>
              </>
            )}
          </div>
          {!isMobile && <div style={{ flex: 1 }} />}
          <div style={{ ...styles.voiceSearchGroup, ...(isMobile ? styles.voiceSearchGroupMobile : null) }}>
            <input
              type="text"
              placeholder="search public voices…"
              value={searchName}
              onChange={(e) => setSearchName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && refreshVoices(searchName.trim())}
              style={{ ...styles.input, ...(isMobile ? styles.inputMobile : null) }}
            />
            <button
              onClick={() => refreshVoices(searchName.trim())}
              style={{ ...styles.btn, ...(isMobile ? styles.btnMobile : null) }}
            >
              Search
            </button>
            <button
              onClick={() => setLibraryOpen(true)}
              style={{ ...styles.btnLibrary, ...(isMobile ? styles.btnMobile : null) }}
              title="Browse the full 11,000+ voice ElevenLabs library with natural-language search. Pick any voice — we import it into your account and select it for this episode."
            >
              📚 Browse library
            </button>
          </div>
        </div>
        <VoicePicker
          voices={voices}
          value={voiceId}
          onChange={onVoicePickerChange}
          generatedIds={new Set(voiceoverGenerations.map((g) => g.voice_id))}
        />
        <CastPanel
          projectId={projectId}
          voices={voices}
          narratorVoiceId={voiceId}
          narratorVoiceName={voices.find((v) => v.voice_id === voiceId)?.name || ''}
          speakersInScript={speakersInScriptList}
          initialCast={initialCast}
          flash={flash}
        />
        <VoiceLibraryModal
          open={libraryOpen}
          onClose={() => setLibraryOpen(false)}
          existingVoiceIds={new Set(voices.map((v) => v.voice_id))}
          onImported={async (newVoiceId, newVoiceName) => {
            // Pull the freshly-imported voice into the personal list, then
            // treat it as the project's active voice — saves the user the
            // extra click of finding it in the picker afterwards.
            await refreshVoices();
            setVoiceId(newVoiceId);
            try {
              await fetch(`/api/projects/${encodeURIComponent(projectId)}/voice`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ voice_id: newVoiceId, voice_name: newVoiceName }),
              });
            } catch {
              /* non-fatal — the picker still shows the right selection */
            }
            flash(`Imported "${newVoiceName}" — selected for this episode`);
            setLibraryOpen(false);
          }}
        />
      </div>
      <div style={styles.row}>
        <Button
          variant="ghost"
          leadingIcon={<Save size={14} strokeWidth={2} />}
          onClick={saveScriptOnly}
          disabled={running}
        >
          Save script
        </Button>
        <Button
          variant="secondary"
          leadingIcon={<RefreshCw size={14} strokeWidth={2} />}
          onClick={changeVoiceOnly}
          disabled={running}
          title="Regenerate just the voiceover audio with the selected voice. Timeline + frame mappings are preserved. WARNING: if the script changed in length (e.g. added break tags) subtitle + Ken Burns timing will drift — use Refit timings for that case instead."
        >
          Change voice only
        </Button>
        <Button
          variant="secondary"
          leadingIcon={<RotateCcw size={14} strokeWidth={2} />}
          onClick={refitTimings}
          disabled={running}
          title="Regenerate voiceover + re-transcribe + refit segment timings to the new audio WITHOUT rebuilding the timeline. Preserves every segment's frame, prompt, Ken Burns, aspect, and location."
        >
          Refit timings
        </Button>
        <Button
          variant="secondary"
          leadingIcon={<Crosshair size={14} strokeWidth={2} />}
          onClick={syncToTts}
          disabled={running}
          title="Re-fit existing timeline segments to the CURRENT voiceover.mp3 without regenerating audio. Whisper transcribes the existing mp3 and updates each segment's start/end to match the actual word positions. Captions and frames stay locked to the spoken words. Use this after editing narrations or whenever captions/frames drift from the audio."
        >
          Sync to TTS
        </Button>
        <Button
          variant="primary"
          leadingIcon={<Wand2 size={14} strokeWidth={2} />}
          onClick={runPipeline}
          disabled={running}
          loading={running}
        >
          {running ? 'Running' : 'Generate voiceover + timeline'}
        </Button>
        {running && currentJobId && tunnelUrl && (
          <Button
            variant="danger"
            leadingIcon={<Square size={12} strokeWidth={2.5} />}
            onClick={stopPipeline}
          >
            Stop
          </Button>
        )}
        {status && <span style={styles.status}>{status}</span>}
      </div>
      {(() => {
        // Preview invariant: the <audio> element must play the SAME voice
        // the picker shows as selected. We never want the user picking
        // Voice A and hearing Voice B's leftover bytes from the previous
        // render. Two cases:
        //
        //   1) voiceover.mp3 already contains the picked voice
        //      (activeVoiceId === voiceId, confirmed by the server) —
        //      play the project's rendered voiceover, cache-busted off
        //      that voice's generation timestamp.
        //
        //   2) Anything else — play the picked voice's ElevenLabs sample
        //      clip (preview_url on the voice object). It's a short ~20s
        //      clip the model shipped with, not the project script, but
        //      it matches the voice the user is hearing in their head
        //      when they picked it. Label accordingly so the user knows
        //      this isn't their script yet.
        const pickerVoice = voices.find((v) => v.voice_id === voiceId);
        const projectMatchesPicker =
          !!voiceoverUrl && !!activeVoiceId && activeVoiceId === voiceId;

        if (projectMatchesPicker) {
          const activeGen = voiceoverGenerations.find((g) => g.voice_id === voiceId);
          const bustKey = activeGen?.generated_at ?? voiceId ?? '';
          const src = bustKey
            ? `${voiceoverUrl}${voiceoverUrl!.includes('?') ? '&' : '?'}v=${encodeURIComponent(bustKey)}`
            : (voiceoverUrl as string);
          return (
            <div style={{ marginTop: 8 }}>
              <audio key={src} controls src={src} style={{ width: '100%' }} />
              <div style={styles.audioCaption}>
                ▸ project voiceover · {pickerVoice?.name ?? voiceId}
              </div>
            </div>
          );
        }

        if (pickerVoice?.preview_url) {
          return (
            <div style={{ marginTop: 8 }}>
              <audio
                key={pickerVoice.voice_id + '::preview'}
                controls
                src={pickerVoice.preview_url}
                style={{ width: '100%' }}
              />
              <div style={styles.audioCaption}>
                ▸ ElevenLabs sample for {pickerVoice.name} — the project
                voiceover will update once you hit Change voice only / Refit /
                Generate.
              </div>
            </div>
          );
        }
        return null;
      })()}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    background: '#171717',
    border: '1px solid #262626',
    borderRadius: 8,
    padding: 12,
    marginTop: 10,
  },
  header: { fontSize: 12, color: '#a3a3a3', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 },
  textarea: {
    width: '100%',
    minHeight: 140,
    resize: 'vertical',
    background: '#0a0a0a',
    color: '#f5f5f5',
    border: '1px solid #404040',
    borderRadius: 6,
    padding: 10,
    fontFamily: 'ui-monospace, "SF Mono", monospace',
    fontSize: 12,
    lineHeight: 1.5,
    boxSizing: 'border-box',
  },
  // 16px minimum prevents iOS Safari from auto-zooming on focus.
  textareaMobile: {
    fontSize: 16,
    minHeight: 180,
  },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 },
  voicePickerWrap: {
    marginTop: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  voicePickerHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 2,
  },
  voicePickerHeaderMobile: {
    alignItems: 'stretch',
    gap: 6,
  },
  voiceSearchGroup: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  voiceSearchGroupMobile: {
    flex: '1 1 100%',
    flexWrap: 'wrap',
    gap: 6,
  },
  voicePickerLabel: {
    fontSize: 11,
    color: '#a3a3a3',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontWeight: 600,
  },
  voicePickerCount: {
    fontSize: 11,
    color: '#737373',
  },
  select: {
    background: '#0a0a0a',
    color: '#f5f5f5',
    border: '1px solid #404040',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 13,
    minWidth: 240,
  },
  input: {
    background: '#0a0a0a',
    color: '#f5f5f5',
    border: '1px solid #404040',
    borderRadius: 6,
    padding: '6px 10px',
    fontSize: 13,
    minWidth: 160,
    flex: '1 1 200px',
  },
  inputMobile: {
    flex: '1 1 100%',
    width: '100%',
    minWidth: 0,
    padding: '10px',
    fontSize: 14,
    minHeight: 42,
  },
  btn: {
    background: '#262626',
    color: '#f5f5f5',
    border: '1px solid #404040',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 13,
    cursor: 'pointer',
  },
  btnMobile: {
    flex: '1 1 auto',
    padding: '10px 14px',
    fontSize: 14,
    minHeight: 42,
  },
  btnPrimary: {
    background: '#7c3aed',
    color: '#fff',
    border: '1px solid #6d28d9',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 13,
    cursor: 'pointer',
    fontWeight: 600,
  },
  btnPrimaryMobile: {
    flex: '1 1 100%',
    padding: '12px 14px',
    fontSize: 14,
    minHeight: 46,
  },
  btnSecondary: {
    background: '#0f2a4f',
    color: '#dbeafe',
    border: '1px solid #1e40af',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 13,
    cursor: 'pointer',
    fontWeight: 600,
  },
  btnLibrary: {
    background: '#4c1d95',
    color: '#ede9fe',
    border: '1px solid #7c3aed',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  btnRefit: {
    background: '#14532d',
    color: '#d1fae5',
    border: '1px solid #166534',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 13,
    cursor: 'pointer',
    fontWeight: 600,
  },
  status: { fontSize: 12, color: '#a3a3a3', marginLeft: 8 },
  audioCaption: {
    fontSize: 10,
    color: '#737373',
    marginTop: 4,
    fontStyle: 'italic',
  },
  btnStop: {
    background: '#b91c1c',
    color: '#fff',
    border: '1px solid #ef4444',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
};
