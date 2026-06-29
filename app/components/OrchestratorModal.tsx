// End-to-end AI orchestrator. Takes a short intake questionnaire, asks
// Gemini to draft an entire episode (script + character roster + voice
// hints), then provisions the full pipeline: create series+episode, upload
// script, generate or accept user-supplied character refs, cast voices from
// the ElevenLabs library, run the voiceover chain, autofill prompts, and
// generate every frame.
//
// All substep state is ephemeral-client. The project itself persists after
// each atomic write, so if the user closes the tab mid-run they can reopen
// the project and finish the remaining steps from the normal UI.

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { colors, space, radius, shadow, text, zIndex } from './ui/tokens';
import { autoFixBorders } from '../lib/autoFixBorders';
import { extractAudioFromFile } from '../lib/extractAudio';
import VoiceLibraryModal from './VoiceLibraryModal';

// Decodes a base64 data URL into a Blob. Used to hand the bytes straight
// to a Supabase signed upload URL without round-tripping through a Vercel
// function body (hard-capped at ~4.5MB).
function dataUrlToBlob(dataUrl: string): { blob: Blob; mime: string } {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('invalid data url');
  const mime = m[1];
  const bin = atob(m[2]);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return { blob: new Blob([buf], { type: mime }), mime };
}

export type OrchestratorPhase =
  | 'intake'
  | 'drafting'
  | 'review'
  | 'provisioning'
  | 'done'
  | 'error';

type Props = {
  /** When false the modal unmounts visually but the component stays in the
   *  React tree so any async provisioning continues running in the background.
   *  Parent re-opens by flipping this back to true. */
  visible: boolean;
  onClose: () => void;
  onDone: (projectId: string) => void;
  flash: (msg: string) => void;
  tunnelUrl: string | null;
  /** Bump to wipe every piece of internal state back to a fresh intake form.
   *  Used after a "start over" confirm. */
  resetToken?: number;
  /** Lets the parent read the current phase so the Generate-with-AI button
   *  can show a spinner + block re-clicks while work is in flight. */
  onPhaseChange?: (phase: OrchestratorPhase) => void;
};

type Runtime = 'short' | 'long';
type Aspect = '16:9' | '9:16';
type RefSource = 'ai' | 'user' | 'skip';

type SeriesSummary = { id: string; title: string };

type CharacterDraft = {
  tag: string;
  description: string;
  voice_hints: string;
  source: RefSource;
  userImageDataUrl?: string;   // when source = 'user', pre-upload preview
  uploadedUrl?: string;        // set after upload completes
  generatedUrl?: string;       // set after FAL generate completes
  voice?: { voice_id: string; voice_name: string };
};

type Phase = OrchestratorPhase;

type StepStatus = 'pending' | 'running' | 'done' | 'failed';

type Step = {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
};

const INITIAL_STEPS: Step[] = [
  { id: 'series',   label: 'Create / reuse series',     status: 'pending' },
  { id: 'episode',  label: 'Create episode',             status: 'pending' },
  { id: 'script',   label: 'Upload script + aspect',     status: 'pending' },
  { id: 'refs',     label: 'Character references',       status: 'pending' },
  { id: 'cast',     label: 'Cast voices',                status: 'pending' },
  { id: 'tts',      label: 'Generate voiceover',         status: 'pending' },
  { id: 'autofill', label: 'Fill per-frame prompts',     status: 'pending' },
  { id: 'frames',   label: 'Render frames',              status: 'pending' },
];

// Steps shown when the user uploads their own audio — no cast, no TTS;
// Whisper extracts narration + word-timing from the upload, autofill fills
// visual prompts, and frames render from those.
const UPLOAD_INITIAL_STEPS: Step[] = [
  { id: 'series',     label: 'Create / reuse series',        status: 'pending' },
  { id: 'episode',    label: 'Create episode',                status: 'pending' },
  { id: 'aspect',     label: 'Lock aspect',                   status: 'pending' },
  { id: 'upload',     label: 'Upload voiceover',              status: 'pending' },
  { id: 'transcribe', label: 'Transcribe with Whisper',       status: 'pending' },
  { id: 'autofill',   label: 'Fill per-frame prompts',        status: 'pending' },
  { id: 'frames',     label: 'Render frames',                 status: 'pending' },
];

// Same rail as UPLOAD_INITIAL_STEPS but with a Rewrite + re-TTS + re-
// transcribe block between Upload and Autofill. Picked in runUploadProvision
// when rewrite_narration is on.
const UPLOAD_INITIAL_STEPS_REWRITE: Step[] = [
  { id: 'series',       label: 'Create / reuse series',       status: 'pending' },
  { id: 'episode',      label: 'Create episode',               status: 'pending' },
  { id: 'aspect',       label: 'Lock aspect',                  status: 'pending' },
  { id: 'upload',       label: 'Upload source audio',          status: 'pending' },
  { id: 'transcribe',   label: 'Transcribe with Whisper',      status: 'pending' },
  { id: 'rewrite',      label: 'Rewrite in your voice',        status: 'pending' },
  { id: 'tts',          label: 'Generate new voiceover',       status: 'pending' },
  { id: 'retranscribe', label: 'Re-align to new audio',        status: 'pending' },
  { id: 'autofill',     label: 'Fill per-frame prompts',       status: 'pending' },
  { id: 'frames',       label: 'Render frames',                status: 'pending' },
];

export default function OrchestratorModal({
  visible,
  onClose,
  onDone,
  flash,
  tunnelUrl,
  resetToken,
  onPhaseChange,
}: Props) {
  const [phase, setPhase] = useState<Phase>('intake');
  const [errorMsg, setErrorMsg] = useState<string>('');
  // 'generate' — Gemini drafts the whole episode from a theme (existing flow)
  // 'upload'   — user supplies their own audio/video; Whisper extracts the
  //              narration + timing, frames generate from the transcript
  const [mode, setMode] = useState<'generate' | 'upload'>('generate');

  // Intake form
  const [seriesList, setSeriesList] = useState<SeriesSummary[]>([]);
  const [seriesMode, setSeriesMode] = useState<'existing' | 'new'>('new');
  const [seriesIdSelected, setSeriesIdSelected] = useState<string>('');
  const [seriesNewTitle, setSeriesNewTitle] = useState<string>('');
  const [title, setTitle] = useState<string>('');
  const [aspect, setAspect] = useState<Aspect>('16:9');
  const [runtime, setRuntime] = useState<Runtime>('short');
  const [speakerHint, setSpeakerHint] = useState<number>(0);
  const [namesInput, setNamesInput] = useState<string>('');
  const [theme, setTheme] = useState<string>('');
  const [styleAnchorOverride, setStyleAnchorOverride] = useState<string>('');

  // Draft + review
  const [draftScript, setDraftScript] = useState<string>('');
  const [draftCharacters, setDraftCharacters] = useState<CharacterDraft[]>([]);
  const [draftNarratorHint, setDraftNarratorHint] = useState<string>('');
  const [narratorVoice, setNarratorVoice] = useState<{ voice_id: string; voice_name: string } | null>(null);

  // Provisioning
  const [steps, setSteps] = useState<Step[]>(INITIAL_STEPS);
  const [createdProjectId, setCreatedProjectId] = useState<string>('');
  const [framesProgress, setFramesProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });

  const cancelled = useRef(false);

  // --- Report phase changes up so the parent can update the button state. ---
  useEffect(() => {
    onPhaseChange?.(phase);
  }, [phase, onPhaseChange]);

  // --- Warn on tab close while frames are actively rendering. ---
  // Only attach the listener during the critical window so normal
  // navigation isn't hampered. Browsers suppress the custom message for
  // security reasons, but the stock "Leave site?" prompt is enough to
  // catch an accidental tab close.
  useEffect(() => {
    const framesStep = steps.find((s) => s.id === 'frames');
    const locked = phase === 'provisioning' && framesStep?.status === 'running';
    if (!locked) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = 'Rendering frames — closing this tab will stop the render.';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [phase, steps]);

  // --- Reset to a fresh intake form when the parent bumps resetToken. ---
  useEffect(() => {
    if (resetToken == null) return;
    setPhase('intake');
    setErrorMsg('');
    setMode('generate');
    setSeriesMode('new');
    setSeriesNewTitle('');
    setTitle('');
    setAspect('16:9');
    setRuntime('short');
    setSpeakerHint(0);
    setNamesInput('');
    setTheme('');
    setStyleAnchorOverride('');
    setDraftScript('');
    setDraftCharacters([]);
    setDraftNarratorHint('');
    setNarratorVoice(null);
    setSteps(INITIAL_STEPS);
    setCreatedProjectId('');
    setFramesProgress({ done: 0, total: 0 });
    cancelled.current = false;
  }, [resetToken]);

  // --- Pull existing series for the dropdown ---
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/series');
        if (!r.ok) return;
        const j = await r.json();
        const list = Array.isArray(j?.series)
          ? j.series.map((s: any) => ({ id: String(s.id), title: String(s.title || s.id) }))
          : [];
        setSeriesList(list);
        if (list.length > 0 && !seriesIdSelected) {
          setSeriesIdSelected(list[0].id);
        } else if (list.length === 0) {
          setSeriesMode('new');
        }
      } catch { /* non-fatal — user can type a new series name */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Helpers ---
  const setStep = (id: string, patch: Partial<Step>) => {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

  const fileToDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });

  // --- Step 1: Draft ---
  // `override` lets the chat intake pass its freshly-collected manifest in
  // directly, bypassing state-setter-closure staleness. When omitted, the
  // function reads the intake state vars populated by either the legacy
  // form or the chat's setters + a microtask delay.
  const runDraft = async (override?: {
    series_mode: 'existing' | 'new';
    series_id?: string;
    series_title?: string;
    title: string;
    aspect: Aspect;
    runtime: Runtime;
    speaker_hint: number;
    names: string[];
    theme: string;
    style_anchor?: string;
  }) => {
    setErrorMsg('');
    setPhase('drafting');
    try {
      const sMode = override?.series_mode ?? seriesMode;
      const sIdSel = override?.series_id ?? seriesIdSelected;
      const sNewT = override?.series_title ?? seriesNewTitle;
      const t = override?.title ?? title;
      const a = override?.aspect ?? aspect;
      const rt = override?.runtime ?? runtime;
      const sh = override?.speaker_hint ?? speakerHint;
      const nm = override?.names ?? namesInput
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n.length > 0);
      const th = override?.theme ?? theme;
      const sa = override?.style_anchor ?? styleAnchorOverride;

      const seriesId = sMode === 'existing' ? sIdSel : slug(sNewT);
      const seriesTitle = sMode === 'existing'
        ? seriesList.find((s) => s.id === sIdSel)?.title || sNewT
        : sNewT;

      const r = await fetch('/api/ai/draft-episode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          series_id: sMode === 'existing' ? seriesId : undefined,
          series_title: sMode === 'new' ? seriesTitle : undefined,
          title: t,
          aspect: a,
          runtime: rt,
          speaker_hint: sh,
          theme: th,
          names: nm,
          style_anchor: sa || undefined,
        }),
      });
      if (!r.ok) {
        throw new Error((await r.text()).slice(0, 400));
      }
      const j = await r.json();
      setDraftScript(String(j.script || ''));
      setDraftNarratorHint(String(j.narrator_hint || ''));
      const chars: CharacterDraft[] = Array.isArray(j.characters)
        ? j.characters.map((c: any) => ({
            tag: String(c.tag || ''),
            description: String(c.description || ''),
            voice_hints: String(c.voice_hints || ''),
            source: 'ai',
          }))
        : [];
      setDraftCharacters(chars);
      setPhase('review');
    } catch (e: any) {
      setErrorMsg(`Draft failed: ${String(e?.message || e).slice(0, 400)}`);
      setPhase('intake');
    }
  };

  // --- Step 2: Provisioning ---

  const provision = async () => {
    setErrorMsg('');
    setPhase('provisioning');
    setSteps(INITIAL_STEPS.map((s) => ({ ...s, status: 'pending', detail: undefined })));
    cancelled.current = false;

    try {
      // A. Series
      setStep('series', { status: 'running' });
      let seriesId: string;
      if (seriesMode === 'existing') {
        seriesId = seriesIdSelected;
      } else {
        const newSlug = slug(seriesNewTitle);
        // POST /api/series — idempotent: if it exists we treat that as success.
        const r = await fetch('/api/series', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: newSlug, title: seriesNewTitle }),
        });
        if (!r.ok && r.status !== 409) {
          throw new Error(`create series: ${(await r.text()).slice(0, 300)}`);
        }
        seriesId = newSlug;
      }
      setStep('series', { status: 'done', detail: seriesId });

      // B. Episode — retry on cold-start FUNCTION_INVOCATION_TIMEOUT.
      // Vercel occasionally kills the first lambda invocation during a cold
      // start; the second attempt almost always hits a warm container and
      // returns in <2s. Three attempts with backoff are plenty.
      setStep('episode', { status: 'running' });
      let ep: { episode?: { id?: string } } | null = null;
      {
        let lastErr = '';
        for (let attempt = 1; attempt <= 3; attempt++) {
          if (attempt > 1) {
            setStep('episode', { status: 'running', detail: `retrying (attempt ${attempt})…` });
          }
          try {
            const epR = await fetch(`/api/series/${encodeURIComponent(seriesId)}/episodes`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title }),
            });
            if (epR.ok) {
              ep = await epR.json();
              break;
            }
            lastErr = (await epR.text()).slice(0, 300);
          } catch (e: any) {
            lastErr = String(e?.message || e).slice(0, 300);
          }
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
        if (!ep) {
          setStep('episode', { status: 'failed', detail: lastErr });
          flash(`create episode failed: ${lastErr.slice(0, 200)}`);
          throw new Error(`create episode: ${lastErr}`);
        }
      }
      const projectId = ep?.episode?.id as string;
      if (!projectId) throw new Error('create episode: no id returned');
      setCreatedProjectId(projectId);
      setStep('episode', { status: 'done', detail: projectId });

      // C. Aspect + script
      setStep('script', { status: 'running' });
      const patchR = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aspect }),
      });
      if (!patchR.ok) throw new Error(`patch aspect: ${(await patchR.text()).slice(0, 300)}`);

      const scR = await fetch(`/api/projects/${encodeURIComponent(projectId)}/script`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: draftScript,
      });
      if (!scR.ok) throw new Error(`upload script: ${(await scR.text()).slice(0, 300)}`);
      setStep('script', { status: 'done', detail: `${draftScript.length} chars` });

      // D. Character refs — in parallel
      setStep('refs', { status: 'running', detail: `${draftCharacters.length} characters` });
      await Promise.all(
        draftCharacters.map(async (c, idx) => {
          try {
            let imageUrl: string | null = null;
            if (c.source === 'skip') {
              return;
            }
            if (c.source === 'user' && c.userImageDataUrl) {
              const up = await fetch('/api/upload-protagonist', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data_url: c.userImageDataUrl, project_id: projectId }),
              });
              if (!up.ok) throw new Error(`upload: ${(await up.text()).slice(0, 200)}`);
              imageUrl = (await up.json()).url;
              setDraftCharacters((prev) =>
                prev.map((p, i) => (i === idx ? { ...p, uploadedUrl: imageUrl || undefined } : p)),
              );
            } else if (c.source === 'ai') {
              const portraitPrompt =
                `Full-body character reference portrait of ${c.description}. ` +
                `${styleAnchorOverride ? styleAnchorOverride + ' ' : ''}` +
                `Plain white seamless studio backdrop. Neutral standing pose, facing camera, symmetrical. ` +
                `Character fills ~85% of frame height. No text, no watermark, no border.`;
              const sub = await fetch('/api/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: portraitPrompt, aspect }),
              });
              if (!sub.ok) throw new Error(`submit: ${(await sub.text()).slice(0, 200)}`);
              const { status_url, response_url } = await sub.json();
              for (let i = 0; i < 40 && !cancelled.current; i++) {
                await new Promise((r) => setTimeout(r, 2500));
                const pr = await fetch('/api/generate-status', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ status_url, response_url }),
                });
                if (!pr.ok) continue;
                const st = await pr.json();
                if (st.done && st.image_url) {
                  imageUrl = st.image_url;
                  break;
                }
              }
              if (!imageUrl) throw new Error('timed out');
              setDraftCharacters((prev) =>
                prev.map((p, i) => (i === idx ? { ...p, generatedUrl: imageUrl || undefined } : p)),
              );
            }
            if (imageUrl) {
              const addR = await fetch(
                `/api/projects/${encodeURIComponent(projectId)}/refs/characters`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ url: imageUrl, label: c.tag }),
                },
              );
              if (!addR.ok) throw new Error(`add ref: ${(await addR.text()).slice(0, 200)}`);
              await fetch(
                `/api/projects/${encodeURIComponent(projectId)}/refs/characters`,
                {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ url: imageUrl, character: c.tag }),
                },
              );
            }
          } catch (e: any) {
            // log per-character failure but continue
            flash(`${c.tag} ref failed: ${String(e?.message || e).slice(0, 120)}`);
          }
        }),
      );
      setStep('refs', { status: 'done' });

      // E. Cast voices (narrator + per-character)
      setStep('cast', { status: 'running' });
      // Tiered picker:
      //   1. hybrid search /api/voices?q=hints — owned voices first, shared
      //      only as a supplement
      //   2. if the top hit is a shared voice that hasn't been imported into
      //      the user's account, POST /api/voices to import it and swap the
      //      voice_id to the newly-imported one (TTS only works on owned)
      //   3. last resort — first owned voice from /api/voices with no query
      //      (there's always at least one premade voice on every ElevenLabs
      //      account, so this never returns nothing)
      const pickVoice = async (hints: string): Promise<{
        voice_id: string;
        voice_name: string;
      } | null> => {
        const q = (hints || '').trim();
        type LibVoice = {
          voice_id: string;
          name: string;
          category?: string;
          public_owner_id?: string;
        };
        const tryQuery = async (query: string): Promise<LibVoice[]> => {
          const url = query
            ? `/api/voices?q=${encodeURIComponent(query)}`
            : `/api/voices`;
          const r = await fetch(url);
          if (!r.ok) return [];
          const j = await r.json();
          return Array.isArray(j?.voices) ? (j.voices as LibVoice[]) : [];
        };
        const candidates: LibVoice[] = q ? await tryQuery(q) : [];
        const owned = candidates.find((v) => v.category !== 'public');
        if (owned?.voice_id) {
          return { voice_id: owned.voice_id, voice_name: owned.name };
        }
        const shared = candidates.find(
          (v) => v.category === 'public' && v.public_owner_id,
        );
        if (shared?.voice_id && shared.public_owner_id) {
          // Import into the user's account before we try TTS with it.
          try {
            const importR = await fetch(`/api/voices`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                public_owner_id: shared.public_owner_id,
                voice_id: shared.voice_id,
                new_name: `Orch — ${shared.name}`.slice(0, 80),
              }),
            });
            if (importR.ok) {
              const imported = await importR.json();
              const importedId = imported?.voice_id || shared.voice_id;
              return { voice_id: importedId, voice_name: shared.name };
            }
            // Import failed — log and fall through to the fallback.
            flash(`Voice import failed for "${shared.name}"`);
          } catch {
            /* fall through */
          }
        }
        // Fallback — any owned voice at all.
        const fallback = await tryQuery('');
        const fallbackOwned = fallback.find((v) => v.category !== 'public')
          || fallback[0];
        if (fallbackOwned?.voice_id) {
          return {
            voice_id: fallbackOwned.voice_id,
            voice_name: fallbackOwned.name,
          };
        }
        return null;
      };
      const narrator = narratorVoice || (await pickVoice(draftNarratorHint));
      if (narrator) {
        setNarratorVoice(narrator);
        await fetch(`/api/projects/${encodeURIComponent(projectId)}/voice`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(narrator),
        });
      }
      const castChars: Record<string, { voice_id: string; voice_name: string } | null> = {};
      for (const c of draftCharacters) {
        let v = c.voice || null;
        if (!v) v = await pickVoice(c.voice_hints);
        castChars[c.tag] = v;
        if (v) {
          setDraftCharacters((prev) => prev.map((p) => (p.tag === c.tag ? { ...p, voice: v! } : p)));
        }
      }
      await fetch(`/api/projects/${encodeURIComponent(projectId)}/cast`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ narrator, characters: castChars }),
      });
      setStep('cast', {
        status: 'done',
        detail: `${narrator ? 'narrator' : 'no narrator'} · ${
          Object.values(castChars).filter(Boolean).length
        } cast`,
      });
      if (!narrator) {
        // TTS can't run without a narrator — stop here and ask user to pick manually.
        setStep('tts', { status: 'failed', detail: 'narrator voice not found' });
        throw new Error('Narrator voice could not be picked automatically. Open the project, pick a voice, and resume manually.');
      }

      // F. Voiceover — prefer tunnel (handles multi-voice cast natively),
      // otherwise fall back to server TTS.
      //
      // model_id is pinned to `eleven_multilingual_v2` for the orchestrator:
      // Gemini drafts are plain prose (no [whispers]/[laughs] audio tags that
      // v3 unlocks), and v2 works with EVERY voice in the library — v3 gets
      // rejected by many community voices. Manual Script+Voice flow keeps
      // its v3 default untouched.
      const ORCH_TTS_MODEL = 'eleven_multilingual_v2';
      setStep('tts', { status: 'running' });
      if (tunnelUrl) {
        const castForTunnel = Object.fromEntries(
          Object.entries(castChars).filter(([, v]) => v != null) as [string, { voice_id: string; voice_name: string }][],
        );
        const r = await fetch(`${tunnelUrl.replace(/\/+$/, '')}/pipeline`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            voice_id: narrator.voice_id,
            voice_name: narrator.voice_name,
            model_id: ORCH_TTS_MODEL,
            cast: castForTunnel,
          }),
        });
        if (!r.ok) {
          const t = await r.text();
          setStep('tts', { status: 'failed', detail: t });
          flash(`voiceover failed: ${t.slice(0, 200)}`);
          throw new Error(`tunnel /pipeline: ${t.slice(0, 300)}`);
        }
        // Poll /state for voiceover_url to appear (tunnel runs async).
        let vo = false;
        for (let i = 0; i < 180 && !cancelled.current; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const br = await fetch(`/api/projects/${encodeURIComponent(projectId)}`);
            if (br.ok) {
              const bundle = await br.json();
              if (bundle?.voiceover_url) { vo = true; break; }
            }
          } catch {}
        }
        if (!vo) {
          const msg = 'tunnel voiceover timed out after 9 minutes';
          setStep('tts', { status: 'failed', detail: msg });
          flash(`voiceover failed: ${msg}`);
          throw new Error(msg);
        }
      } else {
        // Server TTS only produces voiceover.mp3 — we still need to run
        // transcribe + align to populate words.json + timeline.json, which
        // autofill-prompts relies on.
        //
        // Abort at 55s so the client gives up before Vercel's 60s hard cap
        // kills the lambda. For long scripts (1400+ chars of narration) this
        // is likely — we tell the user to start the tunnel instead of leaving
        // them staring at a stuck spinner.
        const ttsController = new AbortController();
        const ttsTimeout = setTimeout(() => ttsController.abort(), 55_000);
        let ttsR: Response;
        try {
          ttsR = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              voice_id: narrator.voice_id,
              voice_name: narrator.voice_name,
              model_id: ORCH_TTS_MODEL,
            }),
            signal: ttsController.signal,
          });
        } catch (e: any) {
          const aborted = e?.name === 'AbortError';
          const msg = aborted
            ? 'Script is too long for server TTS (55s client abort). Start the tunnel at 127.0.0.1:8765 and retry.'
            : `TTS request error: ${String(e?.message || e)}`;
          setStep('tts', { status: 'failed', detail: msg });
          flash(`voiceover failed: ${msg.slice(0, 200)}`);
          throw new Error(msg);
        } finally {
          clearTimeout(ttsTimeout);
        }
        if (!ttsR.ok) {
          const t = await ttsR.text();
          setStep('tts', { status: 'failed', detail: t });
          flash(`voiceover failed: ${t.slice(0, 200)}`);
          throw new Error(`server TTS: ${t.slice(0, 300)}`);
        }
        setStep('tts', { status: 'running', detail: 'transcribing…' });
        const tr = await fetch(`/api/projects/${encodeURIComponent(projectId)}/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!tr.ok) {
          const t = await tr.text();
          setStep('tts', { status: 'failed', detail: `transcribe: ${t}` });
          flash(`transcribe failed: ${t.slice(0, 200)}`);
          throw new Error(`transcribe: ${t.slice(0, 300)}`);
        }
        setStep('tts', { status: 'running', detail: 'aligning…' });
        const al = await fetch(`/api/projects/${encodeURIComponent(projectId)}/align`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!al.ok) {
          const t = await al.text();
          setStep('tts', { status: 'failed', detail: `align: ${t}` });
          flash(`align failed: ${t.slice(0, 200)}`);
          throw new Error(`align: ${t.slice(0, 300)}`);
        }
      }

      // --- Guarantee a timeline before autofill runs. ---
      // The tunnel's /pipeline does TTS → Whisper → resegment in one call,
      // but any step can fail silently and still leave voiceover.mp3 intact
      // (which is what we poll for above). Autofill fails hard without a
      // timeline, so we re-run transcribe + align here whenever the timeline
      // endpoint comes back empty. Idempotent on both endpoints — they no-op
      // if their inputs are already present. We hit /timeline directly
      // instead of the full bundle so cold-start Supabase reads don't push
      // the lambda past its 15s cap.
      {
        const ready = await fetch(`/api/projects/${encodeURIComponent(projectId)}/timeline`);
        const tl = ready.ok ? await ready.json().catch(() => null) : null;
        const hasTimeline = Array.isArray(tl?.timeline) && tl.timeline.length > 0;
        if (!hasTimeline) {
          setStep('tts', { status: 'running', detail: 'transcribing…' });
          const tr = await fetch(`/api/projects/${encodeURIComponent(projectId)}/transcribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          if (!tr.ok) {
            const t = (await tr.text()).slice(0, 300);
            setStep('tts', { status: 'failed', detail: `transcribe: ${t}` });
            throw new Error(`transcribe: ${t}`);
          }
          setStep('tts', { status: 'running', detail: 'aligning…' });
          const al = await fetch(`/api/projects/${encodeURIComponent(projectId)}/align`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          if (!al.ok) {
            const t = (await al.text()).slice(0, 300);
            setStep('tts', { status: 'failed', detail: `align: ${t}` });
            throw new Error(`align: ${t}`);
          }
        }
      }
      setStep('tts', { status: 'done' });

      // G. Autofill prompts
      setStep('autofill', { status: 'running' });
      // May timeout once on longer scripts; call it up to 3 times — it's
      // idempotent (only fills gaps) so successive runs make progress.
      let remaining = Infinity;
      for (let round = 0; round < 3 && remaining > 0 && !cancelled.current; round++) {
        const r = await fetch('/api/ai/autofill-prompts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            style_anchor: styleAnchorOverride || undefined,
          }),
        });
        if (!r.ok) {
          const t = (await r.text()).slice(0, 300);
          setStep('autofill', { status: 'failed', detail: t });
          throw new Error(`autofill: ${t}`);
        }
        const j = await r.json();
        remaining = Number(j?.remaining_gaps ?? 0);
        setStep('autofill', {
          status: remaining > 0 ? 'running' : 'done',
          detail: `${j.filled} filled, ${remaining} remaining`,
        });
      }
      if (remaining > 0) {
        // Non-fatal — frames can still generate using whatever prompts landed.
        setStep('autofill', { status: 'done', detail: `${remaining} still unfilled` });
      }

      // H. Frames
      setStep('frames', { status: 'running' });
      // Hit the per-artefact endpoints instead of the full bundle GET. The
      // bundle endpoint joins ten Supabase reads into one 15s-capped lambda,
      // which FUNCTION_INVOCATION_TIMEOUTs on cold starts. Three single-file
      // GETs in parallel are an order of magnitude faster and each carries
      // its own retry headroom.
      type TLSeg = { id: string; narration?: string; frame_url?: string; location?: string };
      const fetchJsonWithRetry = async (url: string, label: string, tries = 3): Promise<any> => {
        let lastErr: unknown = null;
        for (let i = 0; i < tries; i++) {
          try {
            const r = await fetch(url);
            if (r.ok) return await r.json();
            const t = await r.text();
            lastErr = new Error(`${label} ${r.status}: ${t.slice(0, 200)}`);
          } catch (e) {
            lastErr = e;
          }
          await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
        }
        throw lastErr instanceof Error ? lastErr : new Error(`${label} failed`);
      };
      const [tlResp, prResp, refResp] = await Promise.all([
        fetchJsonWithRetry(`/api/projects/${encodeURIComponent(projectId)}/timeline`, 'timeline'),
        fetchJsonWithRetry(`/api/projects/${encodeURIComponent(projectId)}/prompts`, 'prompts'),
        fetchJsonWithRetry(`/api/projects/${encodeURIComponent(projectId)}/refs/characters`, 'refs'),
      ]);
      const timeline: TLSeg[] = Array.isArray(tlResp?.timeline) ? tlResp.timeline : [];
      const prompts: Record<string, { prompt?: string }> = prResp?.prompts || {};
      const charRefs: Array<{ url: string; character?: string }> = refResp?.refs || [];

      const frameTargets = timeline.filter((s) => !s.frame_url && prompts[s.id]?.prompt);
      setFramesProgress({ done: 0, total: frameTargets.length });

      const runOne = async (seg: { id: string; narration?: string }) => {
        const promptText = prompts[seg.id]?.prompt || '';
        const tagsInNarration = new Set<string>();
        const m = String(seg.narration || '').match(/@([A-Z][A-Z0-9_-]{0,30})/g);
        if (m) for (const t of m) tagsInNarration.add(t.slice(1));
        const imageUrls = charRefs
          .filter((r) => !r.character || tagsInNarration.has(r.character))
          .map((r) => r.url)
          .slice(0, 3);
        const sub = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: promptText,
            image_urls: imageUrls,
            aspect,
            location: timeline.find((x) => x.id === seg.id)?.location || undefined,
            project_id: projectId,
          }),
        });
        if (!sub.ok) throw new Error(`submit: ${(await sub.text()).slice(0, 120)}`);
        const { status_url, response_url } = await sub.json();
        for (let i = 0; i < 40 && !cancelled.current; i++) {
          await new Promise((r) => setTimeout(r, 2500));
          const pr = await fetch('/api/generate-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status_url, response_url }),
          });
          if (!pr.ok) continue;
          const st = await pr.json();
          if (st.done && st.image_url) {
            // Auto-crop any white matte before persisting, so orchestrator
            // frames are always full-bleed from the start.
            const fix = await autoFixBorders(st.image_url);
            const body: Record<string, unknown> = fix.fixed
              ? { data_url: fix.image, aspect }
              : { image_url: st.image_url, aspect };
            if (fix.fixed) {
              body.meta = { op: 'autofix.borders', cropped_frac: fix.cropped_frac };
            }
            await fetch(
              `/api/projects/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(seg.id)}`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              },
            );
            return;
          }
        }
        throw new Error('timed out');
      };

      // Simple concurrency pool: 3 in flight at once.
      const queue = [...frameTargets];
      const workers: Promise<void>[] = [];
      const CONCURRENCY = 3;
      let doneCount = 0;
      const work = async () => {
        while (queue.length > 0 && !cancelled.current) {
          const s = queue.shift()!;
          try {
            await runOne(s);
          } catch (e: any) {
            flash(`${s.id}: ${String(e?.message || e).slice(0, 80)}`);
          } finally {
            doneCount++;
            setFramesProgress({ done: doneCount, total: frameTargets.length });
            setStep('frames', {
              status: doneCount < frameTargets.length ? 'running' : 'done',
              detail: `${doneCount}/${frameTargets.length}`,
            });
          }
        }
      };
      for (let i = 0; i < CONCURRENCY; i++) workers.push(work());
      await Promise.all(workers);

      setStep('frames', { status: 'done', detail: `${doneCount}/${frameTargets.length}` });

      setPhase('done');
    } catch (e: any) {
      setErrorMsg(String(e?.message || e).slice(0, 500));
      setPhase('error');
    }
  };

  // --- Upload-audio provisioning ---
  // User-supplied audio/video path. Skips Gemini script drafting, character
  // generation, voice casting, and TTS — Whisper pulls the narration + word-
  // level timestamps straight from the upload, and the rest of the frame
  // pipeline reads from those.
  const runUploadProvision = async (args: {
    manifest: {
      series_mode: 'existing' | 'new';
      series_id?: string;
      series_title?: string;
      title: string;
      aspect: Aspect;
      style_anchor?: string;
      rewrite_narration?: boolean;
      narrator_voice?: { voice_id: string; voice_name: string };
      style_hint?: string;
    };
    audioDataUrl: string;
  }) => {
    setErrorMsg('');
    setPhase('provisioning');
    const useRewrite = args.manifest.rewrite_narration === true;
    const stepTemplate = useRewrite ? UPLOAD_INITIAL_STEPS_REWRITE : UPLOAD_INITIAL_STEPS;
    setSteps(stepTemplate.map((s) => ({ ...s, status: 'pending', detail: undefined })));
    cancelled.current = false;

    try {
      const m = args.manifest;

      // A. Series
      setStep('series', { status: 'running' });
      let seriesId: string;
      if (m.series_mode === 'existing' && m.series_id) {
        seriesId = m.series_id;
      } else {
        const newSlug = slug(m.series_title || m.title);
        const r = await fetch('/api/series', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: newSlug, title: m.series_title || m.title }),
        });
        if (!r.ok && r.status !== 409) {
          throw new Error(`create series: ${(await r.text()).slice(0, 300)}`);
        }
        seriesId = newSlug;
      }
      setStep('series', { status: 'done', detail: seriesId });

      // B. Episode (with the same 3-attempt cold-start retry as the generate path)
      setStep('episode', { status: 'running' });
      let ep: { episode?: { id?: string } } | null = null;
      {
        let lastErr = '';
        for (let attempt = 1; attempt <= 3; attempt++) {
          if (attempt > 1) {
            setStep('episode', { status: 'running', detail: `retrying (attempt ${attempt})…` });
          }
          try {
            const epR = await fetch(`/api/series/${encodeURIComponent(seriesId)}/episodes`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: m.title }),
            });
            if (epR.ok) {
              ep = await epR.json();
              break;
            }
            lastErr = (await epR.text()).slice(0, 300);
          } catch (e: any) {
            lastErr = String(e?.message || e).slice(0, 300);
          }
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
        if (!ep) {
          setStep('episode', { status: 'failed', detail: lastErr });
          flash(`create episode failed: ${lastErr.slice(0, 200)}`);
          throw new Error(`create episode: ${lastErr}`);
        }
      }
      const projectId = ep?.episode?.id as string;
      if (!projectId) throw new Error('create episode: no id returned');
      setCreatedProjectId(projectId);
      setStep('episode', { status: 'done', detail: projectId });

      // C. Aspect
      setStep('aspect', { status: 'running' });
      const patchR = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aspect: m.aspect }),
      });
      if (!patchR.ok) throw new Error(`patch aspect: ${(await patchR.text()).slice(0, 300)}`);
      setStep('aspect', { status: 'done', detail: m.aspect });

      // D. Upload voiceover — two-step flow to sidestep Vercel's ~4.5MB
      // serverless body cap: ask the server for a Supabase signed upload
      // URL, PUT the bytes straight there, then POST a tiny metadata ping.
      setStep('upload', { status: 'running' });
      const { blob: audioBlob, mime: audioMime } = dataUrlToBlob(args.audioDataUrl);
      const signR = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/upload-voiceover/signed-url`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      );
      if (!signR.ok) {
        const t = (await signR.text()).slice(0, 300);
        setStep('upload', { status: 'failed', detail: t });
        flash(`upload failed: ${t}`);
        throw new Error(`upload signed-url: ${t}`);
      }
      const { signedUrl } = await signR.json();
      const putR = await fetch(signedUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': audioMime,
          'x-upsert': 'true',
          'cache-control': '0',
        },
        body: audioBlob,
      });
      if (!putR.ok) {
        const t = (await putR.text()).slice(0, 300);
        setStep('upload', { status: 'failed', detail: t });
        flash(`upload failed: ${t}`);
        throw new Error(`upload put: ${t}`);
      }
      const upR = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/upload-voiceover`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploaded: true, mime: audioMime, bytes: audioBlob.size }),
        },
      );
      if (!upR.ok) {
        const t = (await upR.text()).slice(0, 300);
        setStep('upload', { status: 'failed', detail: t });
        flash(`upload failed: ${t}`);
        throw new Error(`upload: ${t}`);
      }
      const upJ = await upR.json();
      setStep('upload', { status: 'done', detail: `${Math.round((upJ.bytes || 0) / 1024)} KB` });

      // E. Transcribe (Whisper) — pull the source transcript.
      setStep('transcribe', { status: 'running' });
      const tr = await fetch(`/api/projects/${encodeURIComponent(projectId)}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!tr.ok) {
        const t = (await tr.text()).slice(0, 300);
        setStep('transcribe', { status: 'failed', detail: t });
        flash(`transcribe failed: ${t}`);
        throw new Error(`transcribe: ${t}`);
      }
      const trJ = await tr.json();
      setStep('transcribe', { status: 'running', detail: `${trJ.total_words} words` });

      // Fetch the words.json we just wrote so we have full_text on hand.
      const wordsResp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/words`);
      let sourceTranscript = '';
      let sourceWordCount = Number(trJ.total_words) || 0;
      if (wordsResp.ok) {
        const wj = await wordsResp.json();
        sourceTranscript = String(wj?.full_text || '').trim();
        if (Number.isFinite(wj?.total_words)) sourceWordCount = Number(wj.total_words);
      }

      // --- Branch: rewrite in the user's voice ---------------------------
      if (useRewrite && args.manifest.narrator_voice) {
        if (!sourceTranscript) {
          setStep('transcribe', { status: 'failed', detail: 'empty transcript' });
          throw new Error('transcribe: empty transcript (nothing to rewrite)');
        }
        setStep('transcribe', { status: 'done', detail: `${sourceWordCount} source words` });

        // Rewrite via Gemini.
        setStep('rewrite', { status: 'running' });
        const rw = await fetch('/api/ai/rewrite-narration', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transcript: sourceTranscript,
            approx_word_count: sourceWordCount,
            style_hint: args.manifest.style_hint || undefined,
          }),
        });
        if (!rw.ok) {
          const t = await rw.text();
          setStep('rewrite', { status: 'failed', detail: t.slice(0, 300) });
          flash(`rewrite failed: ${t.slice(0, 200)}`);
          throw new Error(`rewrite: ${t.slice(0, 300)}`);
        }
        const rwJ = await rw.json();
        const rewritten = String(rwJ?.rewritten_text || '').trim();
        if (!rewritten) {
          setStep('rewrite', { status: 'failed', detail: 'empty rewrite' });
          throw new Error('rewrite: empty result');
        }
        setStep('rewrite', {
          status: 'done',
          detail: `${rwJ.words || ''} words · ${Math.round((rwJ.overlap || 0) * 100)}% overlap`,
        });

        // Save rewritten script → script.txt
        await fetch(`/api/projects/${encodeURIComponent(projectId)}/script`, {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain' },
          body: rewritten,
        });

        // TTS → voiceover.mp3 (overwrites the uploaded audio; the upload
        // stays in voiceover_generations.json as a swap-back option).
        setStep('tts', { status: 'running' });
        const ttsR = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            voice_id: args.manifest.narrator_voice.voice_id,
            voice_name: args.manifest.narrator_voice.voice_name,
            model_id: 'eleven_multilingual_v2',
          }),
        });
        if (!ttsR.ok) {
          const t = (await ttsR.text()).slice(0, 300);
          setStep('tts', { status: 'failed', detail: t });
          flash(`TTS failed: ${t}`);
          throw new Error(`tts: ${t}`);
        }
        setStep('tts', { status: 'done' });

        // Re-transcribe against the new TTS + re-align timeline.
        setStep('retranscribe', { status: 'running' });
        const tr2 = await fetch(`/api/projects/${encodeURIComponent(projectId)}/transcribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!tr2.ok) {
          const t = (await tr2.text()).slice(0, 300);
          setStep('retranscribe', { status: 'failed', detail: t });
          throw new Error(`retranscribe: ${t}`);
        }
        const al2 = await fetch(`/api/projects/${encodeURIComponent(projectId)}/align`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!al2.ok) {
          const t = (await al2.text()).slice(0, 300);
          setStep('retranscribe', { status: 'failed', detail: `align: ${t}` });
          throw new Error(`align: ${t}`);
        }
        setStep('retranscribe', { status: 'done' });
      } else {
        // --- Plain upload path ----------------------------------------
        // Save the Whisper transcript as script.txt so downstream autofill
        // has narration per segment.
        if (sourceTranscript) {
          await fetch(`/api/projects/${encodeURIComponent(projectId)}/script`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain' },
            body: sourceTranscript,
          });
        }

        setStep('transcribe', { status: 'running', detail: `${sourceWordCount} words · aligning…` });
        const al = await fetch(`/api/projects/${encodeURIComponent(projectId)}/align`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!al.ok) {
          const t = (await al.text()).slice(0, 300);
          setStep('transcribe', { status: 'failed', detail: `align: ${t}` });
          flash(`align failed: ${t}`);
          throw new Error(`align: ${t}`);
        }
        setStep('transcribe', { status: 'done' });
      }

      // F. Autofill — Gemini produces per-segment visual prompts from the
      // transcribed narration (same as the generate path).
      setStep('autofill', { status: 'running' });
      let remaining = Infinity;
      for (let round = 0; round < 3 && remaining > 0 && !cancelled.current; round++) {
        const r = await fetch('/api/ai/autofill-prompts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            style_anchor: m.style_anchor || undefined,
          }),
        });
        if (!r.ok) {
          const t = (await r.text()).slice(0, 300);
          setStep('autofill', { status: 'failed', detail: t });
          throw new Error(`autofill: ${t}`);
        }
        const j = await r.json();
        remaining = Number(j?.remaining_gaps ?? 0);
        setStep('autofill', {
          status: remaining > 0 ? 'running' : 'done',
          detail: `${j.filled} filled, ${remaining} remaining`,
        });
      }
      if (remaining > 0) {
        setStep('autofill', { status: 'done', detail: `${remaining} still unfilled` });
      }

      // G. Frames — same parallel generate loop as the generate path.
      setStep('frames', { status: 'running' });
      type TLSeg = { id: string; narration?: string; frame_url?: string; location?: string };
      const fetchJsonWithRetry = async (url: string, label: string, tries = 3): Promise<any> => {
        let lastErr: unknown = null;
        for (let i = 0; i < tries; i++) {
          try {
            const r = await fetch(url);
            if (r.ok) return await r.json();
            const t = await r.text();
            lastErr = new Error(`${label} ${r.status}: ${t.slice(0, 200)}`);
          } catch (e) {
            lastErr = e;
          }
          await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
        }
        throw lastErr instanceof Error ? lastErr : new Error(`${label} failed`);
      };
      const [tlResp, prResp] = await Promise.all([
        fetchJsonWithRetry(`/api/projects/${encodeURIComponent(projectId)}/timeline`, 'timeline'),
        fetchJsonWithRetry(`/api/projects/${encodeURIComponent(projectId)}/prompts`, 'prompts'),
      ]);
      const timeline: TLSeg[] = Array.isArray(tlResp?.timeline) ? tlResp.timeline : [];
      const prompts: Record<string, { prompt?: string }> = prResp?.prompts || {};
      const frameTargets = timeline.filter((s) => !s.frame_url && prompts[s.id]?.prompt);
      setFramesProgress({ done: 0, total: frameTargets.length });

      const runOne = async (seg: { id: string; narration?: string }) => {
        const promptText = prompts[seg.id]?.prompt || '';
        const sub = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: promptText,
            aspect: m.aspect,
            location: timeline.find((x) => x.id === seg.id)?.location || undefined,
            project_id: projectId,
          }),
        });
        if (!sub.ok) throw new Error(`submit: ${(await sub.text()).slice(0, 120)}`);
        const { status_url, response_url } = await sub.json();
        for (let i = 0; i < 40 && !cancelled.current; i++) {
          await new Promise((r) => setTimeout(r, 2500));
          const pr = await fetch('/api/generate-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status_url, response_url }),
          });
          if (!pr.ok) continue;
          const st = await pr.json();
          if (st.done && st.image_url) {
            const fix = await autoFixBorders(st.image_url);
            const body: Record<string, unknown> = fix.fixed
              ? { data_url: fix.image, aspect: m.aspect }
              : { image_url: st.image_url, aspect: m.aspect };
            await fetch(
              `/api/projects/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(seg.id)}`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              },
            );
            return;
          }
        }
        throw new Error('timed out');
      };

      const queue = [...frameTargets];
      const CONCURRENCY = 3;
      let doneCount = 0;
      const work = async () => {
        while (queue.length > 0 && !cancelled.current) {
          const s = queue.shift()!;
          try { await runOne(s); } catch (e: any) {
            flash(`${s.id}: ${String(e?.message || e).slice(0, 80)}`);
          } finally {
            doneCount++;
            setFramesProgress({ done: doneCount, total: frameTargets.length });
            setStep('frames', {
              status: doneCount < frameTargets.length ? 'running' : 'done',
              detail: `${doneCount}/${frameTargets.length}`,
            });
          }
        }
      };
      const workers: Promise<void>[] = [];
      for (let i = 0; i < CONCURRENCY; i++) workers.push(work());
      await Promise.all(workers);
      setStep('frames', { status: 'done', detail: `${doneCount}/${frameTargets.length}` });

      setPhase('done');
    } catch (e: any) {
      setErrorMsg(String(e?.message || e).slice(0, 500));
      setPhase('error');
    }
  };

  // --- Rendering ---
  const intakeValid = useMemo(() => {
    if (!title.trim()) return false;
    if (seriesMode === 'new' && !seriesNewTitle.trim()) return false;
    if (seriesMode === 'existing' && !seriesIdSelected) return false;
    return true;
  }, [title, seriesMode, seriesNewTitle, seriesIdSelected]);

  // Close the modal WITHOUT cancelling the in-flight pipeline. The component
  // stays mounted so its async loop keeps making progress; the parent just
  // hides it via the `visible` prop. Nothing in this function touches
  // `cancelled` — the only way to cancel is to explicitly reset via
  // resetToken, which is what the parent does when the user confirms a
  // "start over" in the warning dialog.
  //
  // While the Render-frames step is actively running, block close entirely
  // — clicking outside, pressing X, and keyboard escape all no-op. The frame
  // loop writes Supabase in parallel and leaving mid-run causes a race
  // against the onDone handler's loadProject.
  const framesStep = steps.find((s) => s.id === 'frames');
  const framesLocked = phase === 'provisioning' && framesStep?.status === 'running';
  const close = () => {
    if (framesLocked) return;
    onClose();
  };

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      style={styles.backdrop}
    >
      <div style={styles.panel} onMouseDown={(e) => e.stopPropagation()}>
        <div style={styles.head}>
          <div style={styles.headTitle}>Generate with AI</div>
          <button
            type="button"
            onClick={close}
            disabled={framesLocked}
            style={framesLocked ? { ...styles.closeBtn, opacity: 0.3, cursor: 'not-allowed' } : styles.closeBtn}
            aria-label={framesLocked ? 'Locked until render finishes' : 'Close'}
            title={framesLocked ? 'Locked until all frames finish rendering' : undefined}
          >
            ×
          </button>
        </div>

        {phase === 'intake' && (
          <ModeTabs mode={mode} setMode={setMode} />
        )}

        {phase === 'intake' && mode === 'upload' && (
          <UploadIntake
            seriesList={seriesList}
            errorMsg={errorMsg}
            fileToDataUrl={fileToDataUrl}
            onStart={({ manifest, audioDataUrl }) => {
              setSeriesMode(manifest.series_mode);
              if (manifest.series_id) setSeriesIdSelected(manifest.series_id);
              if (manifest.series_title) setSeriesNewTitle(manifest.series_title);
              setTitle(manifest.title);
              setAspect(manifest.aspect);
              setStyleAnchorOverride(manifest.style_anchor || '');
              void runUploadProvision({ manifest, audioDataUrl });
            }}
          />
        )}

        {phase === 'intake' && mode === 'generate' && (
          <ChatIntake
            seriesList={seriesList}
            errorMsg={errorMsg}
            onReady={(m) => {
              // Push the Gemini-collected manifest into the intake state
              // vars (so later "Regenerate draft" works + ReviewStep shows
              // the right values) AND pass the manifest inline to runDraft
              // to avoid state-setter-closure staleness.
              const mode: 'existing' | 'new' = m.series_id ? 'existing' : 'new';
              if (mode === 'existing') {
                setSeriesMode('existing');
                setSeriesIdSelected(m.series_id!);
              } else {
                setSeriesMode('new');
                setSeriesNewTitle(m.series_title || '');
              }
              setTitle(m.title);
              setAspect(m.aspect);
              setRuntime(m.runtime);
              setSpeakerHint(m.speaker_hint);
              setNamesInput((m.names || []).join(', '));
              setTheme(m.theme);
              setStyleAnchorOverride(m.style_anchor || '');
              void runDraft({
                series_mode: mode,
                series_id: m.series_id,
                series_title: m.series_title,
                title: m.title,
                aspect: m.aspect,
                runtime: m.runtime,
                speaker_hint: m.speaker_hint,
                names: m.names || [],
                theme: m.theme,
                style_anchor: m.style_anchor,
              });
            }}
          />
        )}

        {phase === 'drafting' && (
          <div style={styles.centered}>
            <Spinner />
            <div style={{ ...text.body, color: colors.text.secondary, marginTop: space[6] }}>
              Gemini is writing your episode…
            </div>
          </div>
        )}

        {phase === 'review' && (
          <ReviewStep
            script={draftScript}
            setScript={setDraftScript}
            characters={draftCharacters}
            setCharacters={setDraftCharacters}
            narratorHint={draftNarratorHint}
            setNarratorHint={setDraftNarratorHint}
            fileToDataUrl={fileToDataUrl}
            onBack={() => setPhase('intake')}
            onRegenerate={runDraft}
            onStart={provision}
          />
        )}

        {(phase === 'provisioning' || phase === 'done' || phase === 'error') && (
          <ProgressStep
            steps={steps}
            framesProgress={framesProgress}
            phase={phase}
            errorMsg={errorMsg}
            projectId={createdProjectId}
            onClose={close}
            onOpenProject={() => createdProjectId && onDone(createdProjectId)}
          />
        )}
      </div>
    </div>
  );
}

// ---------- Intake ----------

// ---------- Mode tabs ----------

function ModeTabs({
  mode,
  setMode,
}: {
  mode: 'generate' | 'upload';
  setMode: (m: 'generate' | 'upload') => void;
}) {
  const tab = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: `${space[4]}px ${space[5]}px`,
    background: active ? colors.bg.elevated : 'transparent',
    color: active ? colors.text.primary : colors.text.secondary,
    border: 'none',
    borderBottom: `2px solid ${active ? colors.accent.default : 'transparent'}`,
    fontFamily: 'inherit',
    fontSize: text.body.fontSize,
    fontWeight: active ? 600 : 500,
    cursor: 'pointer',
  });
  return (
    <div style={{
      display: 'flex',
      margin: `${space[6]}px ${space[8]}px 0`,
      borderBottom: `1px solid ${colors.border.subtle}`,
    }}>
      <button type="button" onClick={() => setMode('generate')} style={tab(mode === 'generate')}>
        Generate from a theme
      </button>
      <button type="button" onClick={() => setMode('upload')} style={tab(mode === 'upload')}>
        Upload my own audio / video
      </button>
    </div>
  );
}

// ---------- Upload Intake ----------

type UploadManifest = {
  series_mode: 'existing' | 'new';
  series_id?: string;
  series_title?: string;
  title: string;
  aspect: Aspect;
  style_anchor?: string;
  /** When true, transcribe the upload, rewrite the narration in the user's
   *  voice, TTS the rewritten script, and use that as the final voiceover
   *  instead of the user's original audio. Requires narrator_voice. */
  rewrite_narration?: boolean;
  narrator_voice?: { voice_id: string; voice_name: string };
  style_hint?: string;
};

function UploadIntake(p: {
  seriesList: SeriesSummary[];
  errorMsg: string;
  fileToDataUrl: (f: File) => Promise<string>;
  onStart: (args: { manifest: UploadManifest; audioDataUrl: string }) => void;
}) {
  const [seriesMode, setSeriesMode] = useState<'existing' | 'new'>(
    p.seriesList.length > 0 ? 'existing' : 'new',
  );
  const [seriesId, setSeriesId] = useState(p.seriesList[0]?.id || '');
  const [seriesTitle, setSeriesTitle] = useState('');
  const [title, setTitle] = useState('');
  const [aspect, setAspect] = useState<Aspect>('16:9');
  const [file, setFile] = useState<File | null>(null);
  const [staging, setStaging] = useState(false);
  const [stagingDetail, setStagingDetail] = useState('');
  const [localErr, setLocalErr] = useState('');

  // Rewrite-in-my-voice state. When off, the upload's audio IS the final
  // voiceover (current behaviour). When on, we transcribe → Gemini
  // restate → TTS with the picked narrator voice → re-align.
  const [rewriteNarration, setRewriteNarration] = useState(false);
  const [voiceHint, setVoiceHint] = useState('');
  const [narratorVoice, setNarratorVoice] = useState<{
    voice_id: string;
    voice_name: string;
  } | null>(null);
  const [pickingVoice, setPickingVoice] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);

  const searchVoice = async (hint: string) => {
    // Same tiered search as the Generate-mode flow: owned first, shared
    // as a supplement. The matching import-on-use logic lives inside
    // runUploadProvision so casting stays consistent across entry points.
    setPickingVoice(true);
    try {
      const q = hint.trim();
      const r = await fetch(q ? `/api/voices?q=${encodeURIComponent(q)}` : '/api/voices');
      if (!r.ok) return;
      const j = await r.json();
      const list: Array<{ voice_id: string; name: string; category?: string }> =
        Array.isArray(j?.voices) ? j.voices : [];
      const owned = list.find((v) => v.category !== 'public') || list[0];
      if (owned?.voice_id) {
        setNarratorVoice({ voice_id: owned.voice_id, voice_name: owned.name });
      }
    } finally {
      setPickingVoice(false);
    }
  };

  // Original file cap before audio extraction — videos compress down hard
  // once we pull the audio track, so we tolerate large inputs here.
  const MAX_INPUT_BYTES = 500 * 1024 * 1024; // 500MB source video OK
  const MAX_WHISPER_BYTES = 25 * 1024 * 1024; // what the extracted audio has to fit under
  const accept = 'audio/*,video/*,.mp3,.m4a,.wav,.webm,.mp4,.mpga,.mov,.mkv,.ogg';

  const stage = async (f: File) => {
    setLocalErr('');
    if (f.size > MAX_INPUT_BYTES) {
      setLocalErr(`File too large (${Math.round(f.size / 1024 / 1024)} MB). Max input 500MB.`);
      return;
    }
    setFile(f);
  };

  const valid =
    title.trim().length > 0 &&
    ((seriesMode === 'existing' && seriesId.length > 0) ||
      (seriesMode === 'new' && seriesTitle.trim().length > 0)) &&
    file != null &&
    // Rewrite flow requires a picked narrator voice — we skip the voice
    // check on the plain upload path because the upload IS the voiceover.
    (!rewriteNarration || narratorVoice != null);

  const start = async () => {
    if (!valid || !file) return;
    setStaging(true);
    setStagingDetail(file.type.startsWith('video/')
      ? 'Extracting audio from video…'
      : 'Reading file…');
    try {
      const extracted = await extractAudioFromFile(file);
      if (extracted.bytes > MAX_WHISPER_BYTES) {
        setStaging(false);
        setStagingDetail('');
        const mb = (extracted.bytes / 1024 / 1024).toFixed(1);
        setLocalErr(
          `Extracted audio is ${mb}MB — over Whisper's 25MB cap. Trim the source to under ~12 minutes and try again.`,
        );
        return;
      }
      p.onStart({
        manifest: {
          series_mode: seriesMode,
          series_id: seriesMode === 'existing' ? seriesId : undefined,
          series_title: seriesMode === 'new' ? seriesTitle.trim() : undefined,
          title: title.trim(),
          aspect,
          rewrite_narration: rewriteNarration,
          narrator_voice: rewriteNarration ? narratorVoice || undefined : undefined,
          style_hint: rewriteNarration ? voiceHint.trim() || undefined : undefined,
        },
        audioDataUrl: extracted.dataUrl,
      });
    } catch (e: any) {
      setLocalErr(`${String(e?.message || e).slice(0, 300)}`);
    } finally {
      setStaging(false);
      setStagingDetail('');
    }
  };

  return (
    <div style={styles.body}>
      <div style={{ ...text.body, color: colors.text.secondary, marginBottom: space[6] }}>
        Drop in an audio or video file. Video gets its audio track extracted in your
        browser; Whisper transcribes, builds the timeline, and generates matching
        frames from the narration.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: space[6] }}>
        {/* Series */}
        <div>
          <div style={{ ...text.eyebrow, color: colors.text.tertiary, marginBottom: space[3] }}>Series</div>
          <div style={{ display: 'flex', gap: space[4], marginBottom: space[3] }}>
            {p.seriesList.length > 0 && (
              <button type="button" onClick={() => setSeriesMode('existing')} style={seriesMode === 'existing' ? styles.segOn : styles.segOff}>
                Pick existing
              </button>
            )}
            <button type="button" onClick={() => setSeriesMode('new')} style={seriesMode === 'new' ? styles.segOn : styles.segOff}>
              Create new
            </button>
          </div>
          {seriesMode === 'existing' ? (
            <select value={seriesId} onChange={(e) => setSeriesId(e.target.value)} style={styles.input}>
              {p.seriesList.map((s) => (
                <option key={s.id} value={s.id}>{s.title}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              placeholder="e.g. Dr Reid Shorts"
              value={seriesTitle}
              onChange={(e) => setSeriesTitle(e.target.value)}
              style={styles.input}
            />
          )}
        </div>

        {/* Episode title */}
        <div>
          <div style={{ ...text.eyebrow, color: colors.text.tertiary, marginBottom: space[3] }}>Episode title</div>
          <input
            type="text"
            placeholder={'e.g. "Morning walk monologue"'}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            style={styles.input}
          />
        </div>

        {/* Aspect */}
        <div>
          <div style={{ ...text.eyebrow, color: colors.text.tertiary, marginBottom: space[3] }}>Aspect</div>
          <div style={{ display: 'flex', gap: space[4] }}>
            <button type="button" onClick={() => setAspect('16:9')} style={aspect === '16:9' ? styles.segOn : styles.segOff}>
              Landscape 16:9
            </button>
            <button type="button" onClick={() => setAspect('9:16')} style={aspect === '9:16' ? styles.segOn : styles.segOff}>
              Vertical 9:16
            </button>
          </div>
        </div>

        {/* File */}
        <div>
          <div style={{ ...text.eyebrow, color: colors.text.tertiary, marginBottom: space[3] }}>Audio or video</div>
          <div
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={async (e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) await stage(f);
            }}
            style={{
              border: `2px dashed ${file ? colors.accent.default : colors.border.default}`,
              borderRadius: radius.md,
              padding: space[8],
              textAlign: 'center',
              background: colors.bg.sunken,
            }}
          >
            {file ? (
              <div>
                <div style={{ ...text.bodyStrong, color: colors.text.primary }}>{file.name}</div>
                <div style={{ ...text.caption, color: colors.text.tertiary, marginTop: space[2] }}>
                  {Math.round(file.size / 1024)} KB · {file.type || 'unknown type'}
                </div>
                <button type="button" onClick={() => setFile(null)} style={{ ...styles.ghostBtn, marginTop: space[4] }}>
                  Remove
                </button>
              </div>
            ) : (
              <div>
                <div style={{ ...text.body, color: colors.text.secondary }}>
                  Drop a file here or
                </div>
                <label style={{ display: 'inline-block', marginTop: space[4] }}>
                  <span style={styles.primaryBtn as React.CSSProperties}>Choose file</span>
                  <input
                    type="file"
                    accept={accept}
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (f) await stage(f);
                    }}
                  />
                </label>
                <div style={{ ...text.caption, color: colors.text.tertiary, marginTop: space[4] }}>
                  Audio (MP3, M4A, WAV, WebM) or video (MP4, MOV, MKV, WebM). Audio is
                  extracted client-side before upload so video files can be up to 500MB
                  — the extracted audio just has to fit Whisper&apos;s 25MB cap
                  (&asymp;2 hours of speech at 16&nbsp;kHz mono).
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Rewrite-in-my-voice */}
        <div style={{ marginTop: space[6] }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: space[4],
              padding: `${space[4]}px ${space[5]}px`,
              border: `1px solid ${rewriteNarration ? colors.accent.default : colors.border.default}`,
              background: rewriteNarration ? colors.accent.soft : colors.bg.sunken,
              borderRadius: radius.md,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={rewriteNarration}
              onChange={(e) => {
                const on = e.target.checked;
                setRewriteNarration(on);
                if (!on) {
                  setNarratorVoice(null);
                  setVoiceHint('');
                }
              }}
              style={{ marginTop: 3, cursor: 'pointer' }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ ...text.bodyStrong, color: colors.text.primary, marginBottom: space[2] }}>
                ✏️ Rewrite in my voice
              </div>
              <div style={{ ...text.caption, color: colors.text.secondary }}>
                Transcribe the upload, restate the same information in fresh phrasing,
                and generate new voiceover audio with a picked narrator voice. Keeps
                the content&apos;s value; avoids shipping the source audio.
              </div>
            </div>
          </label>

          {rewriteNarration && (
            <div
              style={{
                marginTop: space[5],
                padding: `${space[5]}px ${space[6]}px`,
                border: `1px solid ${colors.border.subtle}`,
                borderRadius: radius.md,
                background: colors.bg.subtle,
                display: 'flex',
                flexDirection: 'column',
                gap: space[4],
              }}
            >
              <div>
                <div style={{ ...text.eyebrow, color: colors.text.tertiary, marginBottom: space[3] }}>
                  Narrator voice
                </div>
                <div style={{ display: 'flex', gap: space[3] }}>
                  <input
                    type="text"
                    value={voiceHint}
                    onChange={(e) => setVoiceHint(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void searchVoice(voiceHint);
                      }
                    }}
                    placeholder={'Describe the voice — e.g. "warm male american", "deadpan british female"'}
                    style={{ ...styles.input, flex: 1 }}
                  />
                  <button
                    type="button"
                    onClick={() => void searchVoice(voiceHint)}
                    disabled={pickingVoice}
                    style={pickingVoice ? styles.primaryBtnDisabled : styles.segOn}
                    title="Auto-pick the top match from your owned voices"
                  >
                    {pickingVoice ? 'Searching…' : 'Find'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setLibraryOpen(true)}
                    style={styles.segOn}
                    title="Browse the full 11,000+ voice ElevenLabs library"
                  >
                    📚 Browse library
                  </button>
                </div>
                {narratorVoice && (
                  <div
                    style={{
                      marginTop: space[3],
                      ...text.caption,
                      color: colors.text.secondary,
                    }}
                  >
                    Picked: <strong>{narratorVoice.voice_name}</strong>{' '}
                    <span style={{ opacity: 0.6 }}>({narratorVoice.voice_id.slice(0, 10)}…)</span>
                  </div>
                )}
                {!narratorVoice && (
                  <div
                    style={{
                      marginTop: space[3],
                      ...text.caption,
                      color: colors.text.tertiary,
                    }}
                  >
                    Pick a voice to continue. We reuse the same library as the chat
                    flow — shared voices get auto-imported on first use.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {(localErr || p.errorMsg) && <div style={styles.err}>{localErr || p.errorMsg}</div>}

      <div style={styles.actions}>
        <button
          type="button"
          onClick={() => void start()}
          disabled={!valid || staging}
          style={!valid || staging ? styles.primaryBtnDisabled : styles.primaryBtn}
          title={
            rewriteNarration && !narratorVoice
              ? 'Pick a narrator voice first'
              : undefined
          }
        >
          {staging ? (stagingDetail || 'Preparing…') : 'Start →'}
        </button>
      </div>
      <VoiceLibraryModal
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        existingVoiceIds={new Set(narratorVoice ? [narratorVoice.voice_id] : [])}
        onImported={(newVoiceId, newVoiceName) => {
          setNarratorVoice({ voice_id: newVoiceId, voice_name: newVoiceName });
          setLibraryOpen(false);
        }}
      />
    </div>
  );
}

// ---------- Chat Intake ----------

type IntakeManifest = {
  series_id?: string;
  series_title?: string;
  title: string;
  aspect: Aspect;
  runtime: Runtime;
  speaker_hint: number;
  names?: string[];
  theme: string;
  style_anchor?: string;
};

function ChatIntake(p: {
  seriesList: SeriesSummary[];
  errorMsg: string;
  onReady: (manifest: IntakeManifest) => void;
}) {
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [input, setInput] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string>('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const initialised = useRef(false);

  // Keep the chat scroll pinned to the bottom as new messages arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  // First turn — ask the bot for its opening question.
  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;
    void send([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async (history: Array<{ role: 'user' | 'assistant'; content: string }>) => {
    setBusy(true);
    setLocalErr('');
    try {
      const r = await fetch('/api/ai/chat-intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          history,
          known_series: p.seriesList,
        }),
      });
      if (!r.ok) {
        const t = (await r.text()).slice(0, 300);
        throw new Error(t);
      }
      const j = (await r.json()) as {
        message: string;
        ready: boolean;
        intake?: IntakeManifest;
      };
      const assistant: { role: 'assistant'; content: string } = {
        role: 'assistant',
        content: j.message,
      };
      setMessages((prev) => [...prev, assistant]);
      if (j.ready && j.intake) {
        // Give the user one beat to read the summary before transitioning.
        await new Promise((res) => setTimeout(res, 600));
        p.onReady(j.intake);
      }
    } catch (e: any) {
      setLocalErr(`Chat failed: ${String(e?.message || e).slice(0, 200)}`);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next: Array<{ role: 'user' | 'assistant'; content: string }> = [
      ...messages,
      { role: 'user', content: text },
    ];
    setMessages(next);
    setInput('');
    await send(next);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div style={styles.body}>
      <div
        ref={scrollRef}
        style={{
          maxHeight: 420,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: space[4],
          padding: space[4],
          background: colors.bg.sunken,
          border: `1px solid ${colors.border.subtle}`,
          borderRadius: radius.md,
        }}
      >
        {messages.length === 0 && !busy && (
          <div style={{ ...text.body, color: colors.text.tertiary, textAlign: 'center' }}>
            Starting the conversation…
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            <div
              style={{
                maxWidth: '80%',
                padding: `${space[4]}px ${space[5]}px`,
                borderRadius: radius.lg,
                background: m.role === 'user' ? colors.accent.default : colors.bg.raised,
                color: m.role === 'user' ? colors.accent.contrast : colors.text.primary,
                border: m.role === 'user' ? 'none' : `1px solid ${colors.border.subtle}`,
                fontSize: text.body.fontSize,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {m.content}
            </div>
          </div>
        ))}
        {busy && (
          <div style={{ display: 'flex', alignItems: 'center', gap: space[3], color: colors.text.tertiary }}>
            <Spinner small />
            <span style={{ ...text.caption }}>Thinking…</span>
          </div>
        )}
      </div>

      {(localErr || p.errorMsg) && (
        <div style={styles.err}>{localErr || p.errorMsg}</div>
      )}

      <div style={{ display: 'flex', gap: space[4], marginTop: space[4], alignItems: 'flex-end' }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          rows={2}
          placeholder={busy ? 'Waiting for the assistant…' : 'Type your answer and press Enter (Shift+Enter for a new line)'}
          disabled={busy}
          style={{ ...styles.input, resize: 'vertical', flex: 1, minHeight: 48 }}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !input.trim()}
          style={(busy || !input.trim()) ? styles.primaryBtnDisabled : styles.primaryBtn}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function IntakeForm(p: {
  seriesList: SeriesSummary[];
  seriesMode: 'existing' | 'new';
  setSeriesMode: (m: 'existing' | 'new') => void;
  seriesIdSelected: string;
  setSeriesIdSelected: (v: string) => void;
  seriesNewTitle: string;
  setSeriesNewTitle: (v: string) => void;
  title: string;
  setTitle: (v: string) => void;
  aspect: Aspect;
  setAspect: (a: Aspect) => void;
  runtime: Runtime;
  setRuntime: (r: Runtime) => void;
  speakerHint: number;
  setSpeakerHint: (n: number) => void;
  namesInput: string;
  setNamesInput: (v: string) => void;
  theme: string;
  setTheme: (v: string) => void;
  styleAnchorOverride: string;
  setStyleAnchorOverride: (v: string) => void;
  errorMsg: string;
  intakeValid: boolean;
  onNext: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  return (
    <div style={styles.body}>
      <FormRow label="Series">
        <div style={{ display: 'flex', gap: space[4] }}>
          {p.seriesList.length > 0 && (
            <button
              type="button"
              onClick={() => p.setSeriesMode('existing')}
              style={p.seriesMode === 'existing' ? styles.segOn : styles.segOff}
            >
              Pick existing
            </button>
          )}
          <button
            type="button"
            onClick={() => p.setSeriesMode('new')}
            style={p.seriesMode === 'new' ? styles.segOn : styles.segOff}
          >
            Create new
          </button>
        </div>
        {p.seriesMode === 'existing' ? (
          <select
            value={p.seriesIdSelected}
            onChange={(e) => p.setSeriesIdSelected(e.target.value)}
            style={styles.input}
          >
            {p.seriesList.map((s) => (
              <option key={s.id} value={s.id}>{s.title}</option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            placeholder="e.g. Dr Reid Shorts"
            value={p.seriesNewTitle}
            onChange={(e) => p.setSeriesNewTitle(e.target.value)}
            style={styles.input}
          />
        )}
      </FormRow>

      <FormRow label="Episode title">
        <input
          type="text"
          placeholder={'e.g. "Sleep debt basics"'}
          value={p.title}
          onChange={(e) => p.setTitle(e.target.value)}
          style={styles.input}
        />
      </FormRow>

      <FormRow label="Runtime">
        <div style={{ display: 'flex', gap: space[4] }}>
          <button type="button" onClick={() => p.setRuntime('short')} style={p.runtime === 'short' ? styles.segOn : styles.segOff}>
            Short — 45s
          </button>
          <button type="button" onClick={() => p.setRuntime('long')} style={p.runtime === 'long' ? styles.segOn : styles.segOff}>
            Long — 8:30
          </button>
        </div>
      </FormRow>

      <FormRow label="Aspect">
        <div style={{ display: 'flex', gap: space[4] }}>
          <button type="button" onClick={() => p.setAspect('16:9')} style={p.aspect === '16:9' ? styles.segOn : styles.segOff}>
            Landscape 16:9
          </button>
          <button type="button" onClick={() => p.setAspect('9:16')} style={p.aspect === '9:16' ? styles.segOn : styles.segOff}>
            Vertical 9:16
          </button>
        </div>
      </FormRow>

      <FormRow label="Speakers (beyond narrator)">
        <div style={{ display: 'flex', gap: space[4], alignItems: 'center' }}>
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => p.setSpeakerHint(n)}
              style={p.speakerHint === n ? styles.segOn : styles.segOff}
            >
              {n === 0 ? 'Narration only' : String(n)}
            </button>
          ))}
        </div>
        {p.speakerHint > 0 && (
          <input
            type="text"
            placeholder="Optional character names, comma-separated"
            value={p.namesInput}
            onChange={(e) => p.setNamesInput(e.target.value)}
            style={{ ...styles.input, marginTop: space[4] }}
          />
        )}
      </FormRow>

      <FormRow label="Theme / premise">
        <textarea
          placeholder="One or two lines — what the episode is about"
          value={p.theme}
          onChange={(e) => p.setTheme(e.target.value)}
          rows={3}
          style={{ ...styles.input, resize: 'vertical' }}
        />
      </FormRow>

      <div style={{ marginTop: space[4] }}>
        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          style={styles.advancedToggle}
        >
          {advanced ? '▾' : '▸'} Advanced
        </button>
        {advanced && (
          <FormRow label="Style anchor override (optional)">
            <textarea
              placeholder="Rendering + palette directive. Leave blank to use the series default."
              value={p.styleAnchorOverride}
              onChange={(e) => p.setStyleAnchorOverride(e.target.value)}
              rows={3}
              style={{ ...styles.input, resize: 'vertical' }}
            />
          </FormRow>
        )}
      </div>

      {p.errorMsg && <div style={styles.err}>{p.errorMsg}</div>}

      <div style={styles.actions}>
        <button
          type="button"
          onClick={p.onNext}
          disabled={!p.intakeValid}
          style={p.intakeValid ? styles.primaryBtn : styles.primaryBtnDisabled}
        >
          Draft with Gemini →
        </button>
      </div>
    </div>
  );
}

// ---------- Review ----------

function ReviewStep(p: {
  script: string;
  setScript: (s: string) => void;
  characters: CharacterDraft[];
  setCharacters: (cs: CharacterDraft[] | ((prev: CharacterDraft[]) => CharacterDraft[])) => void;
  narratorHint: string;
  setNarratorHint: (s: string) => void;
  fileToDataUrl: (f: File) => Promise<string>;
  onBack: () => void;
  onRegenerate: () => void;
  onStart: () => void;
}) {
  const updateChar = (idx: number, patch: Partial<CharacterDraft>) => {
    p.setCharacters((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };
  const handlePaste = async (idx: number, e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const it of Array.from(items)) {
      if (it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          const url = await p.fileToDataUrl(f);
          updateChar(idx, { userImageDataUrl: url, source: 'user' });
          return;
        }
      }
    }
  };
  const handleDrop = async (idx: number, e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f && f.type.startsWith('image/')) {
      const url = await p.fileToDataUrl(f);
      updateChar(idx, { userImageDataUrl: url, source: 'user' });
    }
  };
  return (
    <div style={styles.body}>
      <FormRow label="Script (editable)">
        <textarea
          value={p.script}
          onChange={(e) => p.setScript(e.target.value)}
          rows={12}
          style={{ ...styles.input, fontFamily: text.mono.fontFamily, resize: 'vertical' }}
        />
      </FormRow>

      <FormRow label="Narrator voice hint">
        <input
          type="text"
          value={p.narratorHint}
          onChange={(e) => p.setNarratorHint(e.target.value)}
          style={styles.input}
        />
      </FormRow>

      <div style={{ marginTop: space[6] }}>
        <div style={{ ...text.eyebrow, color: colors.text.tertiary, marginBottom: space[4] }}>
          Character roster ({p.characters.length})
        </div>
        {p.characters.length === 0 && (
          <div style={{ ...text.body, color: colors.text.tertiary }}>
            Narration only — no characters to cast.
          </div>
        )}
        {p.characters.map((c, idx) => (
          <div key={idx} style={styles.charCard}>
            <div style={{ display: 'flex', gap: space[4], alignItems: 'flex-start' }}>
              <div style={styles.charThumb}>
                {c.userImageDataUrl ? (
                  <img src={c.userImageDataUrl} alt={c.tag} style={styles.charThumbImg} />
                ) : c.source === 'ai' ? (
                  <span style={{ ...text.caption, color: colors.text.tertiary }}>auto</span>
                ) : c.source === 'skip' ? (
                  <span style={{ ...text.caption, color: colors.text.tertiary }}>—</span>
                ) : null}
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: space[3] }}>
                <input
                  value={c.tag}
                  onChange={(e) => updateChar(idx, { tag: e.target.value.toUpperCase().replace(/[^A-Z0-9_]+/g, '_') })}
                  style={{ ...styles.input, fontWeight: 600 }}
                />
                <textarea
                  rows={2}
                  value={c.description}
                  onChange={(e) => updateChar(idx, { description: e.target.value })}
                  style={{ ...styles.input, resize: 'vertical' }}
                />
                <input
                  value={c.voice_hints}
                  onChange={(e) => updateChar(idx, { voice_hints: e.target.value })}
                  placeholder="voice hints (e.g. 'warm male american')"
                  style={styles.input}
                />
                <div style={{ display: 'flex', gap: space[3], flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => updateChar(idx, { source: 'ai' })} style={c.source === 'ai' ? styles.segOn : styles.segOff}>
                    Generate with AI
                  </button>
                  <button type="button" onClick={() => updateChar(idx, { source: 'user' })} style={c.source === 'user' ? styles.segOn : styles.segOff}>
                    Upload / paste your own
                  </button>
                  <button type="button" onClick={() => updateChar(idx, { source: 'skip' })} style={c.source === 'skip' ? styles.segOn : styles.segOff}>
                    Skip ref
                  </button>
                  <button type="button" onClick={() => p.setCharacters((prev) => prev.filter((_, i) => i !== idx))} style={styles.dangerBtn}>
                    Remove
                  </button>
                </div>
                {c.source === 'user' && (
                  <div
                    onPaste={(e) => handlePaste(idx, e)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => handleDrop(idx, e)}
                    style={styles.dropzone}
                  >
                    {c.userImageDataUrl
                      ? 'Image attached — paste or drop again to replace'
                      : 'Paste or drop an image here. Click below to pick a file:'}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (f) {
                          const url = await p.fileToDataUrl(f);
                          updateChar(idx, { userImageDataUrl: url });
                        }
                      }}
                      style={{ display: 'block', marginTop: space[3] }}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ ...styles.actions, justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: space[4] }}>
          <button type="button" onClick={p.onBack} style={styles.ghostBtn}>← Back</button>
          <button type="button" onClick={p.onRegenerate} style={styles.ghostBtn}>↻ Regenerate draft</button>
        </div>
        <button type="button" onClick={p.onStart} style={styles.primaryBtn}>
          Generate episode →
        </button>
      </div>
    </div>
  );
}

// ---------- Progress ----------

function ProgressStep(p: {
  steps: Step[];
  framesProgress: { done: number; total: number };
  phase: 'provisioning' | 'done' | 'error';
  errorMsg: string;
  projectId: string;
  onClose: () => void;
  onOpenProject: () => void;
}) {
  // While the Render-frames step is actively running, block BOTH buttons so
  // the user can't navigate away or reopen the project mid-render. Earlier
  // steps still allow close-in-background (the async loop keeps going, no
  // frames are being written yet) — but the frame loop mutates Supabase in
  // parallel, so leaving during it is disorienting and can race loadProject.
  const framesStep = p.steps.find((s) => s.id === 'frames');
  const framesRunning =
    p.phase === 'provisioning' && framesStep?.status === 'running';
  const progressPct = p.framesProgress.total > 0
    ? Math.round(100 * p.framesProgress.done / p.framesProgress.total)
    : 0;
  return (
    <div style={styles.body}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: space[3] }}>
        {p.steps.map((s) => (
          <div key={s.id} style={styles.stepRow}>
            <StepIcon status={s.status} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ ...text.bodyStrong, color: colors.text.primary }}>{s.label}</div>
              {s.detail && (
                <div style={{ ...text.caption, color: colors.text.tertiary }}>{s.detail}</div>
              )}
              {s.id === 'frames' && s.status === 'running' && p.framesProgress.total > 0 && (
                <div style={styles.progressBar}>
                  <div
                    style={{
                      ...styles.progressFill,
                      width: `${progressPct}%`,
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {p.phase === 'error' && (
        <div style={styles.err}>{p.errorMsg || 'Pipeline failed'}</div>
      )}
      {framesRunning && (
        <div style={styles.renderLock}>
          Rendering frames — please keep this dialog open until all {p.framesProgress.total}
          {' '}frames finish. ({p.framesProgress.done}/{p.framesProgress.total} · {progressPct}%)
        </div>
      )}
      <div style={{ ...styles.actions, justifyContent: 'space-between' }}>
        <button
          type="button"
          onClick={p.onClose}
          disabled={framesRunning}
          style={framesRunning ? styles.ghostBtnDisabled : styles.ghostBtn}
          title={framesRunning ? 'Locked until the render finishes' : undefined}
        >
          {p.phase === 'done' ? 'Close' : framesRunning ? 'Locked — render in progress' : 'Close (continues where it is)'}
        </button>
        {p.projectId && (
          <button
            type="button"
            onClick={p.onOpenProject}
            disabled={framesRunning}
            style={framesRunning ? styles.primaryBtnDisabled : styles.primaryBtn}
            title={framesRunning ? 'Wait for all frames to finish before opening the episode' : undefined}
          >
            {p.phase === 'done' ? 'Open episode →' : framesRunning ? `Rendering ${p.framesProgress.done}/${p.framesProgress.total}…` : 'Open project →'}
          </button>
        )}
      </div>
    </div>
  );
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'done') {
    return <span style={{ ...styles.stepIcon, color: colors.success.text }}>✓</span>;
  }
  if (status === 'failed') {
    return <span style={{ ...styles.stepIcon, color: colors.danger.text }}>✕</span>;
  }
  if (status === 'running') {
    return <Spinner small />;
  }
  return <span style={{ ...styles.stepIcon, color: colors.text.tertiary }}>○</span>;
}

function Spinner({ small = false }: { small?: boolean }) {
  const size = small ? 14 : 28;
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        border: `2px solid ${colors.border.default}`,
        borderTopColor: colors.accent.default,
        animation: 'wm-spin 0.8s linear infinite',
      }}
    />
  );
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[3], marginBottom: space[6] }}>
      <div style={{ ...text.eyebrow, color: colors.text.tertiary }}>{label}</div>
      {children}
    </div>
  );
}

// ---------- styles ----------

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.72)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: zIndex.modal,
    padding: space[6],
  },
  panel: {
    width: 'min(720px, 100%)',
    maxHeight: '90vh',
    overflowY: 'auto',
    background: colors.bg.raised,
    border: `1px solid ${colors.border.default}`,
    borderRadius: radius.xl,
    boxShadow: shadow.xl,
    display: 'flex',
    flexDirection: 'column',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: `${space[6]}px ${space[8]}px`,
    borderBottom: `1px solid ${colors.border.subtle}`,
  },
  headTitle: { ...text.h1, color: colors.text.primary },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: colors.text.secondary,
    fontSize: 24,
    lineHeight: 1,
    cursor: 'pointer',
    padding: space[3],
  },
  body: { padding: `${space[6]}px ${space[8]}px ${space[8]}px` },
  centered: { padding: space[20], display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' },
  input: {
    background: colors.bg.sunken,
    color: colors.text.primary,
    border: `1px solid ${colors.border.default}`,
    borderRadius: radius.md,
    padding: `${space[4]}px ${space[5]}px`,
    fontSize: text.body.fontSize,
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  },
  segOn: {
    background: colors.accent.soft,
    color: colors.accent.contrast,
    border: `1px solid ${colors.accent.default}`,
    borderRadius: radius.md,
    padding: `${space[3]}px ${space[5]}px`,
    fontSize: text.caption.fontSize,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
    minHeight: 36,
  },
  segOff: {
    background: colors.bg.sunken,
    color: colors.text.secondary,
    border: `1px solid ${colors.border.default}`,
    borderRadius: radius.md,
    padding: `${space[3]}px ${space[5]}px`,
    fontSize: text.caption.fontSize,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
    minHeight: 36,
  },
  primaryBtn: {
    background: colors.accent.default,
    color: colors.accent.contrast,
    border: 'none',
    borderRadius: radius.md,
    padding: `${space[4]}px ${space[8]}px`,
    fontSize: text.bodyStrong.fontSize,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
    minHeight: 40,
  },
  primaryBtnDisabled: {
    background: colors.bg.elevated,
    color: colors.text.disabled,
    border: 'none',
    borderRadius: radius.md,
    padding: `${space[4]}px ${space[8]}px`,
    fontSize: text.bodyStrong.fontSize,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'not-allowed',
    minHeight: 40,
  },
  ghostBtn: {
    background: 'transparent',
    color: colors.text.secondary,
    border: `1px solid ${colors.border.default}`,
    borderRadius: radius.md,
    padding: `${space[4]}px ${space[6]}px`,
    fontSize: text.body.fontSize,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  ghostBtnDisabled: {
    background: 'transparent',
    color: colors.text.disabled,
    border: `1px solid ${colors.border.subtle}`,
    borderRadius: radius.md,
    padding: `${space[4]}px ${space[6]}px`,
    fontSize: text.body.fontSize,
    fontFamily: 'inherit',
    cursor: 'not-allowed',
  },
  renderLock: {
    marginTop: space[6],
    padding: `${space[4]}px ${space[5]}px`,
    borderRadius: radius.md,
    background: colors.accent.soft,
    border: `1px solid ${colors.accent.default}`,
    color: colors.text.primary,
    fontSize: text.caption.fontSize,
    lineHeight: 1.5,
  },
  dangerBtn: {
    background: 'transparent',
    color: colors.danger.text,
    border: `1px solid ${colors.danger.default}`,
    borderRadius: radius.md,
    padding: `${space[3]}px ${space[5]}px`,
    fontSize: text.caption.fontSize,
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
  advancedToggle: {
    background: 'transparent',
    border: 'none',
    color: colors.text.secondary,
    fontSize: text.caption.fontSize,
    fontFamily: 'inherit',
    cursor: 'pointer',
    padding: 0,
  },
  err: {
    marginTop: space[6],
    padding: space[5],
    background: colors.danger.soft,
    color: colors.danger.text,
    border: `1px solid ${colors.danger.default}`,
    borderRadius: radius.md,
    fontSize: text.caption.fontSize,
  },
  actions: {
    display: 'flex',
    gap: space[4],
    marginTop: space[8],
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  charCard: {
    background: colors.bg.subtle,
    border: `1px solid ${colors.border.subtle}`,
    borderRadius: radius.lg,
    padding: space[5],
    marginBottom: space[4],
  },
  charThumb: {
    width: 80,
    height: 80,
    background: colors.bg.sunken,
    border: `1px solid ${colors.border.default}`,
    borderRadius: radius.md,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    overflow: 'hidden',
  },
  charThumbImg: { width: '100%', height: '100%', objectFit: 'cover' },
  dropzone: {
    border: `2px dashed ${colors.border.default}`,
    borderRadius: radius.md,
    padding: space[5],
    color: colors.text.tertiary,
    fontSize: text.caption.fontSize,
    background: colors.bg.sunken,
    outline: 'none',
  },
  stepRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[5],
    padding: space[4],
    border: `1px solid ${colors.border.subtle}`,
    borderRadius: radius.md,
    background: colors.bg.subtle,
  },
  stepIcon: { width: 20, textAlign: 'center', fontSize: 16, lineHeight: 1 },
  progressBar: {
    marginTop: space[3],
    height: 6,
    borderRadius: radius.full,
    background: colors.bg.sunken,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', background: colors.accent.default },
};
