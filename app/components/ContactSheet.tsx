'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  PromptEntry,
  PromptsMap,
  Segment,
  ProjectMeta,
  SeriesMeta,
  RefList,
  VoiceoverGeneration,
  CastDoc,
} from '../lib/blob';
import ProjectBar from './ProjectBar';
import Checklist, { type ChecklistTarget, computeSteps, deriveTier } from './Checklist';
import { Zap, ScanSearch, Square, Wrench, Trash2, Bandage } from 'lucide-react';
import { Button } from './ui';
import ScriptBar from './ScriptBar';
import PromptImport from './PromptImport';
import Row from './Row';
import ReferenceZone from './ReferenceZone';
import LocationsZone from './LocationsZone';
import CreditsBadge from './CreditsBadge';
import Lightbox from './Lightbox';
import SubtitleBar from './SubtitleBar';
import MusicBar from './MusicBar';
import { DEFAULT_MUSIC, musicStorageKey, type BackgroundMusic } from '../lib/music';
import PreferencesBar from './PreferencesBar';
import PreviewPlayer from './PreviewPlayer';
import RenderUploadBar from './RenderUploadBar';
import AnalyticsPanel from './AnalyticsPanel';
import AspectPicker from './AspectPicker';
import PromptHistoryInput, { type PromptHistoryInputHandle } from './PromptHistoryInput';
import OrchestratorModal from './OrchestratorModal';
import SetupModal from './SetupModal';
import type { AspectId } from '../lib/aspectRatios';
import { DEFAULT_SUBTITLE_SETTINGS, type SubtitleSettings } from './SubtitleOverlay';
import { generateAll, editAll } from '../lib/generateFrame';
import { cropAndUpscaleToFullBleed } from '../lib/borderMask';
import { shouldIncludeProduct } from '../lib/productPolicy';
import { useIsMobile, useMediaQuery } from '../lib/useMediaQuery';
import { extractCharacterMentions, speakersUsed } from '../lib/parseSpeakerTags';

type ProjectBundle = {
  meta: ProjectMeta;
  script: string | null;
  timeline: Segment[] | null;
  prompts: PromptsMap;
  approvals: { approved: string[] };
  protagonist: { url: string } | null;
  characters: RefList;
  products: RefList;
  voiceover_url: string | null;
  voiceover_generations: VoiceoverGeneration[];
  cast?: CastDoc | null;
};

// Legacy single-project key — migrated to {SERIES_KEY, EPISODE_KEY} on
// mount and cleared afterwards. Keep the constant around so the migration
// code has a stable reference when looking for the old value.
const PROJECT_KEY = 'wm_active_project';
const SERIES_KEY = 'wm_active_series';
const EPISODE_KEY = 'wm_active_episode';
const TUNNEL_KEY = 'wm_server_url';
const PANEL_STATE_KEY = 'wm_panel_state';

type PanelKey = 'script' | 'references' | 'prompts';

function isHostedApiLocked(r: Response) {
  return r.status === 401 || r.status === 403;
}

export default function ContactSheet() {
  // `projects` is the flat list of every episode across every series. We
  // still keep it because plenty of downstream code (title lookups,
  // dropdown-less views) looks at `projects` by id. It's refreshed
  // alongside `series` whenever the SeriesBar needs updating.
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [series, setSeries] = useState<SeriesMeta[]>([]);
  const [episodesInActiveSeries, setEpisodesInActiveSeries] = useState<ProjectMeta[]>([]);
  const [activeSeriesId, setActiveSeriesId] = useState<string>('');
  // `activeId` stays named "activeId" because it flows down as `projectId`
  // to every child component + API call — renaming it would touch every
  // file without buying anything. Conceptually it's the active episode id.
  const [activeId, setActiveId] = useState<string>('');
  const [bundle, setBundle] = useState<ProjectBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [hostedApiLocked, setHostedApiLocked] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState('');
  const [tunnelOk, setTunnelOk] = useState(false);
  const [flashMsg, setFlashMsg] = useState<string | null>(null);
  const [panels, setPanels] = useState<Record<PanelKey, boolean>>({
    script: false,
    references: false,
    prompts: false,
  });
  const [bulkStatus, setBulkStatus] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  // Orchestrator lifecycle — once mounted, the modal persists in the tree
  // so its async provisioning loop keeps running even when the user closes
  // the dialog. `orchMounted` stays true until they explicitly confirm a
  // "start over" via the warning dialog (which bumps `orchResetToken`).
  const [orchMounted, setOrchMounted] = useState(false);
  const [orchVisible, setOrchVisible] = useState(false);
  const [orchPhase, setOrchPhase] = useState<import('./OrchestratorModal').OrchestratorPhase>('intake');
  const [orchResetToken, setOrchResetToken] = useState(0);
  const [orchConfirmOpen, setOrchConfirmOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clearBusy, setClearBusy] = useState(false);
  // Whether archived episodes appear in the Episode dropdown. Default
  // false so shipped work doesn't clutter the active workflow. Toggled
  // via the checkbox under the Episode picker in ProjectBar.
  const [showArchived, setShowArchived] = useState<boolean>(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [subtitles, setSubtitles] = useState<SubtitleSettings>(DEFAULT_SUBTITLE_SETTINGS);
  const [music, setMusic] = useState<BackgroundMusic>(DEFAULT_MUSIC);
  // Per-segment frame history: past = stack of previous URLs (oldest first),
  // future = stack of URLs popped by undo (reachable with redo).
  const [frameHistory, setFrameHistory] = useState<
    Record<string, { past: string[]; future: string[] }>
  >({});
  const [appendText, setAppendText] = useState('');
  const [appendBusy, setAppendBusy] = useState(false);
  const [appendStatus, setAppendStatus] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [titleBusy, setTitleBusy] = useState(false);
  const [massEditText, setMassEditText] = useState(
    'Zoom out slightly for a wider angle, showing more of the environment. Keep the character, wardrobe, composition, lighting, and background identical — only the framing changes.',
  );
  const [massEditBusy, setMassEditBusy] = useState(false);
  const [massEditStatus, setMassEditStatus] = useState<string | null>(null);
  const massEditAbortRef = useRef<AbortController | null>(null);
  const massEditHistoryRef = useRef<PromptHistoryInputHandle | null>(null);
  // Product attached to the next mass-edit run. When set, the instruction
  // becomes placement guidance and the product image is attached as a
  // second reference to every frame in the batch.
  const [massEditProduct, setMassEditProduct] = useState<{
    url: string;
    label: string;
  } | null>(null);
  const [massEditProductPickerOpen, setMassEditProductPickerOpen] = useState(false);
  const [qaBusy, setQaBusy] = useState(false);
  const [qaStatus, setQaStatus] = useState<string | null>(null);
  const qaAbortRef = useRef<AbortController | null>(null);
  const [borderFixBusy, setBorderFixBusy] = useState(false);
  const [borderFixStatus, setBorderFixStatus] = useState<string | null>(null);
  const borderFixAbortRef = useRef<AbortController | null>(null);
  const isMobile = useIsMobile();
  // Desktop shows the four setup panels as a 2×2 grid; narrow viewports stack.
  const stackedPanels = useMediaQuery('(max-width: 960px)', false);
  const bulkAbortRef = useRef<AbortController | null>(null);

  const toggleSelect = useCallback((segId: string, next: boolean) => {
    setSelected((prev) => {
      const s = new Set(prev);
      if (next) s.add(segId);
      else s.delete(segId);
      return s;
    });
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PANEL_STATE_KEY);
      if (raw) setPanels((p) => ({ ...p, ...JSON.parse(raw) }));
    } catch {}
  }, []);

  // Stage-aware Collapsible defaults. When the user has NO saved panel
  // preferences yet, derive the initial open-state from the project's
  // current tier so a fresh-project view starts with just the relevant
  // Script + Voice panel open (see Checklist.tsx `deriveTier`). Runs once
  // per project (after bundle loads) and leaves user-set preferences
  // untouched.
  const appliedStageDefaultsFor = useRef<string | null>(null);
  useEffect(() => {
    if (!bundle || !activeId) return;
    if (appliedStageDefaultsFor.current === activeId) return;
    // Never override an explicit user preference.
    try {
      if (localStorage.getItem(PANEL_STATE_KEY)) {
        appliedStageDefaultsFor.current = activeId;
        return;
      }
    } catch {}
    const steps = computeSteps(activeSeriesId || '', activeId, bundle);
    const tier = deriveTier(steps);
    setPanels({
      // Open Script + Voice only during the prep stage. Earlier (no
      // episode) or later (voiceover ready) leave every Collapsible
      // closed — the relevant work is in the inline render area below.
      script: tier === 1,
      prompts: false,
      references: false,
    });
    appliedStageDefaultsFor.current = activeId;
  }, [bundle, activeId, activeSeriesId]);

  const togglePanel = useCallback((k: PanelKey) => {
    setPanels((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      try {
        localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const flash = useCallback((msg: string, ms = 2500) => {
    setFlashMsg(msg);
    window.setTimeout(() => setFlashMsg((x) => (x === msg ? null : x)), ms);
  }, []);

  // Local harness first-run status. Hosted production keeps this route
  // private, so failures here are expected outside local development.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/local/status', { cache: 'no-store' });
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled) return;
        if (data?.localStorage && !data?.configured) setSetupOpen(true);
        if (typeof data?.tunnelUrl === 'string' && data.tunnelUrl.trim()) {
          setTunnelUrl(data.tunnelUrl.trim());
          try {
            localStorage.setItem(TUNNEL_KEY, data.tunnelUrl.trim());
          } catch {}
        }
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Restore tunnel URL from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(TUNNEL_KEY) || '';
      setTunnelUrl(stored);
    } catch {}
  }, []);

  // Ping the tunnel every 8s
  useEffect(() => {
    if (!tunnelUrl) {
      setTunnelOk(false);
      return;
    }
    let cancelled = false;
    const ping = async () => {
      try {
        const r = await fetch(tunnelUrl.replace(/\/+$/, '') + '/health', {
          method: 'GET',
          cache: 'no-store',
        });
        if (!cancelled) setTunnelOk(r.ok);
      } catch {
        if (!cancelled) setTunnelOk(false);
      }
    };
    ping();
    const t = window.setInterval(ping, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [tunnelUrl]);

  const refreshProjects = useCallback(async () => {
    const r = await fetch('/api/projects', { cache: 'no-store' });
    if (isHostedApiLocked(r)) {
      setHostedApiLocked(true);
      setProjects([]);
      return [];
    }
    if (!r.ok) return;
    const data = (await r.json()) as { projects: ProjectMeta[] };
    setProjects(data.projects || []);
    return data.projects || [];
  }, []);

  // Pulls the list of series + runs the one-time backend migration that
  // folds every legacy project into its own single-episode series. Cheap
  // after first run (migration is idempotent).
  const refreshSeries = useCallback(async (): Promise<SeriesMeta[]> => {
    const r = await fetch('/api/series', { cache: 'no-store' });
    if (isHostedApiLocked(r)) {
      setHostedApiLocked(true);
      setSeries([]);
      return [];
    }
    if (!r.ok) return [];
    const data = (await r.json()) as { series: SeriesMeta[] };
    const list = data.series || [];
    setSeries(list);
    return list;
  }, []);

  // Load a single series' hydrated episode list. Used both when switching
  // series and after create/delete operations so the Episode dropdown
  // re-syncs without requiring a full project list reload.
  const loadEpisodesForSeries = useCallback(async (seriesId: string): Promise<ProjectMeta[]> => {
    if (!seriesId) {
      setEpisodesInActiveSeries([]);
      return [];
    }
    const r = await fetch(`/api/series/${encodeURIComponent(seriesId)}`, {
      cache: 'no-store',
    });
    if (isHostedApiLocked(r)) {
      setHostedApiLocked(true);
      setEpisodesInActiveSeries([]);
      return [];
    }
    if (!r.ok) {
      setEpisodesInActiveSeries([]);
      return [];
    }
    const data = (await r.json()) as { series: SeriesMeta; episodes: ProjectMeta[] };
    const eps = data.episodes || [];
    setEpisodesInActiveSeries(eps);
    return eps;
  }, []);

  const loadProject = useCallback(
    async (id: string) => {
      if (!id) return;
      setLoading(true);
      // Retry + abort-on-hang: the bundle GET joins ~10 Supabase reads
      // into one lambda, and on a Vercel cold start a single slow read
      // can leave the request pending past the platform's 30s ceiling
      // (user sees an indefinite "Loading project…"). Cap the wait at
      // 18s, abort, then retry once — the warm container comes back in
      // well under 5s.
      const MAX_ATTEMPTS = 3;
      let lastErr: string = '';
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 18_000);
        try {
          const r = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
            cache: 'no-store',
            signal: controller.signal,
          });
          clearTimeout(t);
          if (isHostedApiLocked(r)) {
            setHostedApiLocked(true);
            setBundle(null);
            setLoading(false);
            return;
          }
          if (!r.ok) {
            lastErr = `episode load ${r.status}`;
            // Non-retryable errors — stop immediately.
            if (r.status === 404 || r.status === 401 || r.status === 403) break;
            continue;
          }
          const data = (await r.json()) as ProjectBundle;
          setBundle(data);
          try { localStorage.setItem(EPISODE_KEY, id); } catch {}
          setLoading(false);
          return;
        } catch (e: any) {
          clearTimeout(t);
          lastErr = e?.name === 'AbortError'
            ? `timeout after 18s (attempt ${attempt}/${MAX_ATTEMPTS})`
            : String(e?.message || e);
          // Brief backoff before the next attempt.
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((res) => setTimeout(res, 1500 * attempt));
          }
        }
      }
      setLoading(false);
      flash(`Couldn't load project: ${lastErr.slice(0, 160)}`);
    },
    // flash is referenced via useCallback's closure; it's stable (from
    // a useCallback upstream), so we leave the deps empty to avoid
    // re-creating loadProject on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // On mount: fetch series (which migrates orphans), resolve the active
  // series + episode from localStorage (with fallback to the legacy
  // wm_active_project key), then load the episode bundle.
  useEffect(() => {
    (async () => {
      const [seriesList, projectsList] = await Promise.all([
        refreshSeries(),
        refreshProjects(),
      ]);

      let chosenSeries = '';
      let chosenEpisode = '';
      try {
        chosenSeries = localStorage.getItem(SERIES_KEY) || '';
        chosenEpisode = localStorage.getItem(EPISODE_KEY) || '';
      } catch {}

      // Legacy migration: if the user's last session predates the series
      // rename, transplant wm_active_project into the new keys by looking
      // up that project's series_id.
      if (!chosenEpisode) {
        let legacy = '';
        try {
          legacy = localStorage.getItem(PROJECT_KEY) || '';
        } catch {}
        if (legacy) {
          const legacyMeta = (projectsList || []).find((p) => p.id === legacy);
          if (legacyMeta) {
            chosenEpisode = legacy;
            chosenSeries = legacyMeta.series_id || chosenSeries;
          }
          try {
            localStorage.removeItem(PROJECT_KEY);
          } catch {}
        }
      }

      if (!chosenSeries || !seriesList.some((s) => s.id === chosenSeries)) {
        chosenSeries = seriesList[0]?.id ?? '';
      }
      if (chosenSeries) {
        setActiveSeriesId(chosenSeries);
        try {
          localStorage.setItem(SERIES_KEY, chosenSeries);
        } catch {}
        const eps = await loadEpisodesForSeries(chosenSeries);
        if (!chosenEpisode || !eps.some((e) => e.id === chosenEpisode)) {
          chosenEpisode = eps[0]?.id ?? '';
        }
      } else {
        chosenEpisode = '';
      }

      if (chosenEpisode) {
        setActiveId(chosenEpisode);
        await loadProject(chosenEpisode);
      } else {
        setLoading(false);
      }
    })();
  }, [refreshSeries, refreshProjects, loadEpisodesForSeries, loadProject]);

  const onSwitchSeries = async (seriesId: string) => {
    setActiveSeriesId(seriesId);
    try {
      localStorage.setItem(SERIES_KEY, seriesId);
    } catch {}
    const eps = await loadEpisodesForSeries(seriesId);
    const firstEp = eps[0]?.id ?? '';
    if (firstEp) {
      setActiveId(firstEp);
      await loadProject(firstEp);
    } else {
      setActiveId('');
      setBundle(null);
      setLoading(false);
    }
  };

  const onSwitchProject = async (id: string) => {
    setActiveId(id);
    await loadProject(id);
  };

  const onCreateSeries = async (title: string) => {
    const r = await fetch('/api/series', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!r.ok) {
      flash('Create series failed: ' + (await r.text()).slice(0, 120));
      return;
    }
    const data = (await r.json()) as { series: SeriesMeta };
    await refreshSeries();
    setActiveSeriesId(data.series.id);
    try {
      localStorage.setItem(SERIES_KEY, data.series.id);
    } catch {}
    setEpisodesInActiveSeries([]);
    setActiveId('');
    setBundle(null);
    flash(`Created series ${data.series.id} — add an episode to start`);
  };

  const onCreateEpisode = async (title: string) => {
    if (!activeSeriesId) {
      flash('Pick a series first');
      return;
    }
    const r = await fetch(
      `/api/series/${encodeURIComponent(activeSeriesId)}/episodes`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      },
    );
    if (!r.ok) {
      flash('Create episode failed: ' + (await r.text()).slice(0, 120));
      return;
    }
    const data = (await r.json()) as { episode: ProjectMeta };
    await Promise.all([refreshProjects(), refreshSeries()]);
    await loadEpisodesForSeries(activeSeriesId);
    setActiveId(data.episode.id);
    await loadProject(data.episode.id);
    flash(`Created episode ${data.episode.title}`);
  };

  const onSaveTunnelUrl = (url: string) => {
    setTunnelUrl(url);
    try {
      localStorage.setItem(TUNNEL_KEY, url);
    } catch {}
  };

  const onRowsUpdated = useCallback(async () => {
    if (activeId) await loadProject(activeId);
  }, [activeId, loadProject]);

  const appendVoice = useCallback(async () => {
    const text = appendText.trim();
    if (!text) {
      flash('Type something to append first');
      return;
    }
    setAppendBusy(true);
    setAppendStatus('Generating voice + appending…');
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(activeId)}/voiceovers/append`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice_name: 'Mark' }),
      });
      if (!r.ok) {
        const err = (await r.text()).slice(0, 160);
        setAppendStatus(`Failed: ${err}`);
        flash(`Append failed: ${err}`);
        return;
      }
      const data = await r.json();
      setAppendStatus(`✓ Added ${data.segment?.id ?? ''}`);
      setAppendText('');
      flash(`Appended ${data.segment?.id ?? ''}`);
      await loadProject(activeId);
    } catch (e: any) {
      setAppendStatus(`Error: ${String(e?.message || e).slice(0, 140)}`);
    } finally {
      setAppendBusy(false);
    }
  }, [appendText, activeId, flash, loadProject]);

  // Load subtitle settings from localStorage whenever the active project
  // changes. Settings are per-project, so each script can have its own
  // subtitle style (e.g. bottom-center for a TikTok edit, middle-left for a
  // cinematic pull-quote).
  useEffect(() => {
    if (!activeId) {
      setSubtitles(DEFAULT_SUBTITLE_SETTINGS);
      return;
    }
    try {
      const raw = localStorage.getItem(`wm_subtitles_${activeId}`);
      if (raw) {
        setSubtitles({ ...DEFAULT_SUBTITLE_SETTINGS, ...JSON.parse(raw) });
      } else {
        setSubtitles(DEFAULT_SUBTITLE_SETTINGS);
      }
    } catch {
      setSubtitles(DEFAULT_SUBTITLE_SETTINGS);
    }
  }, [activeId]);

  const updateSubtitles = useCallback(
    (next: SubtitleSettings) => {
      setSubtitles(next);
      if (activeId) {
        try {
          localStorage.setItem(`wm_subtitles_${activeId}`, JSON.stringify(next));
        } catch {}
      }
    },
    [activeId],
  );

  const toggleSubtitleForSegment = useCallback(
    (segId: string) => {
      setSubtitles((prev) => {
        const isDisabled = prev.disabledIds.includes(segId);
        const nextIds = isDisabled
          ? prev.disabledIds.filter((x) => x !== segId)
          : [...prev.disabledIds, segId];
        const next = { ...prev, disabledIds: nextIds };
        if (activeId) {
          try {
            localStorage.setItem(`wm_subtitles_${activeId}`, JSON.stringify(next));
          } catch {}
        }
        return next;
      });
    },
    [activeId],
  );

  // Background music — loaded from localStorage per project, same pattern
  // as subtitles. Per-segment toggle mirrors CC: tap 🎵 to silence the
  // track during a specific beat (e.g. a dramatic pause).
  useEffect(() => {
    if (!activeId) {
      setMusic(DEFAULT_MUSIC);
      return;
    }
    try {
      const raw = localStorage.getItem(musicStorageKey(activeId));
      setMusic(raw ? { ...DEFAULT_MUSIC, ...JSON.parse(raw) } : DEFAULT_MUSIC);
    } catch {
      setMusic(DEFAULT_MUSIC);
    }
  }, [activeId]);

  const updateMusic = useCallback(
    (next: BackgroundMusic) => {
      setMusic(next);
      if (activeId) {
        try {
          localStorage.setItem(musicStorageKey(activeId), JSON.stringify(next));
        } catch {}
      }
    },
    [activeId],
  );

  const toggleMusicForSegment = useCallback(
    (segId: string) => {
      setMusic((prev) => {
        const isDisabled = prev.disabledIds.includes(segId);
        const nextIds = isDisabled
          ? prev.disabledIds.filter((x) => x !== segId)
          : [...prev.disabledIds, segId];
        const next = { ...prev, disabledIds: nextIds };
        if (activeId) {
          try {
            localStorage.setItem(musicStorageKey(activeId), JSON.stringify(next));
          } catch {}
        }
        return next;
      });
    },
    [activeId],
  );

  // Frame history persists per-project so undo/redo survives refreshes and
  // session switches. Cap each per-segment stack at 20 entries to keep
  // localStorage small.
  const HISTORY_KEY_PREFIX = 'wm_frame_history_';
  const HISTORY_MAX_DEPTH = 20;
  useEffect(() => {
    if (!activeId) {
      setFrameHistory({});
      return;
    }
    try {
      const raw = localStorage.getItem(`${HISTORY_KEY_PREFIX}${activeId}`);
      setFrameHistory(raw ? JSON.parse(raw) : {});
    } catch {
      setFrameHistory({});
    }
  }, [activeId]);
  useEffect(() => {
    if (!activeId) return;
    try {
      localStorage.setItem(
        `${HISTORY_KEY_PREFIX}${activeId}`,
        JSON.stringify(frameHistory),
      );
    } catch {
      // Quota exceeded — drop silently; in-memory history still works.
    }
  }, [activeId, frameHistory]);

  // Narrow, in-place patch for the happy path after a single-row generate or
  // edit. Avoids the full loadProject() reload which flips `loading=true`,
  // unmounts every Row, kills in-flight parallel edits on other rows, and
  // causes a visible flicker. Rows have already set their own imgUrl to the
  // versioned URL; this just keeps bundle state in sync.
  // Narrow patch for the Ken Burns picker — updates segment.ken_burns in the
  // local bundle without a full loadProject() reload so the picker commits
  // feel instant.
  // Swap in a whole new timeline after split/merge — avoids the Supabase
  // read-after-write race where a follow-up GET /api/projects/{id} can
  // return the stale pre-op copy for a few hundred ms on the CDN edge.
  const onTimelineReplace = useCallback((next: Segment[]) => {
    setBundle((prev) => (prev ? { ...prev, timeline: next } : prev));
  }, []);

  const commitTitle = useCallback(async () => {
    const next = titleDraft.trim();
    const current = bundle?.meta?.title ?? '';
    if (!next || next === current) {
      setEditingTitle(false);
      return;
    }
    if (next.length > 120) {
      flash('Title must be 120 characters or fewer');
      return;
    }
    setTitleBusy(true);
    const prevTitle = current;
    // Optimistic local patch so both the header AND the ProjectBar dropdown
    // update instantly. Relying on refreshProjects() alone loses a race with
    // Supabase Storage's read-after-write propagation — the list endpoint
    // can return the stale title for several hundred ms.
    setBundle((prev) =>
      prev ? { ...prev, meta: { ...prev.meta, title: next } } : prev,
    );
    setProjects((prev) =>
      prev.map((p) => (p.id === activeId ? { ...p, title: next } : p)),
    );
    setEpisodesInActiveSeries((prev) =>
      prev.map((p) => (p.id === activeId ? { ...p, title: next } : p)),
    );
    try {
      const r = await fetch(
        `/api/projects/${encodeURIComponent(activeId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: next }),
        },
      );
      if (!r.ok) {
        // Rollback on server error.
        setBundle((prev) =>
          prev ? { ...prev, meta: { ...prev.meta, title: prevTitle } } : prev,
        );
        setProjects((prev) =>
          prev.map((p) => (p.id === activeId ? { ...p, title: prevTitle } : p)),
        );
        setEpisodesInActiveSeries((prev) =>
          prev.map((p) => (p.id === activeId ? { ...p, title: prevTitle } : p)),
        );
        flash(`Rename failed: ${(await r.text()).slice(0, 120)}`);
        return;
      }
      flash(`Renamed to "${next}"`);
      // Fire-and-forget full refresh so other sessions/tabs catch up.
      void refreshProjects();
    } catch (e: any) {
      setBundle((prev) =>
        prev ? { ...prev, meta: { ...prev.meta, title: prevTitle } } : prev,
      );
      setProjects((prev) =>
        prev.map((p) => (p.id === activeId ? { ...p, title: prevTitle } : p)),
      );
      setEpisodesInActiveSeries((prev) =>
        prev.map((p) => (p.id === activeId ? { ...p, title: prevTitle } : p)),
      );
      flash(`Rename error: ${String(e?.message || e).slice(0, 120)}`);
    } finally {
      setTitleBusy(false);
      setEditingTitle(false);
    }
  }, [titleDraft, bundle?.meta?.title, activeId, flash, refreshProjects]);

  const toggleArchive = useCallback(async () => {
    if (!activeId || !bundle?.meta) return;
    const currentlyArchived = Boolean(bundle.meta.archived_at);
    const next = !currentlyArchived;
    if (next) {
      const ok = window.confirm(
        `Archive "${bundle.meta.title}"?\n\n` +
          `The episode's files stay in Supabase — no data is deleted. ` +
          `You can restore it any time via the "Show archived" toggle ` +
          `under the Episode dropdown.`,
      );
      if (!ok) return;
    }
    setArchiveBusy(true);
    const optimisticAt = next ? new Date().toISOString() : undefined;
    // Optimistic patch so the UI reacts instantly.
    setBundle((prev) =>
      prev
        ? { ...prev, meta: { ...prev.meta, archived_at: optimisticAt } }
        : prev,
    );
    setEpisodesInActiveSeries((prev) =>
      prev.map((p) =>
        p.id === activeId ? { ...p, archived_at: optimisticAt } : p,
      ),
    );
    setProjects((prev) =>
      prev.map((p) =>
        p.id === activeId ? { ...p, archived_at: optimisticAt } : p,
      ),
    );
    try {
      const r = await fetch(
        `/api/projects/${encodeURIComponent(activeId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived: next }),
        },
      );
      if (!r.ok) {
        // Rollback.
        const prev = currentlyArchived
          ? (bundle.meta.archived_at as string | undefined)
          : undefined;
        setBundle((b) =>
          b ? { ...b, meta: { ...b.meta, archived_at: prev } } : b,
        );
        setEpisodesInActiveSeries((eps) =>
          eps.map((p) =>
            p.id === activeId ? { ...p, archived_at: prev } : p,
          ),
        );
        setProjects((ps) =>
          ps.map((p) =>
            p.id === activeId ? { ...p, archived_at: prev } : p,
          ),
        );
        flash(`Archive change failed: ${(await r.text()).slice(0, 120)}`);
        return;
      }
      if (next) {
        // Auto-switch to the next visible un-archived episode in the
        // same series if the user just archived the active one and
        // they're not showing archived. Falls through to empty state
        // if no active siblings remain.
        if (!showArchived) {
          const remaining = episodesInActiveSeries.filter(
            (p) => p.id !== activeId && !p.archived_at,
          );
          const nextEp = remaining.sort(
            (a, b) => (a.episode_number ?? 0) - (b.episode_number ?? 0),
          )[0];
          if (nextEp) {
            setActiveId(nextEp.id);
            try {
              localStorage.setItem('wm_active_episode', nextEp.id);
            } catch {}
            await loadProject(nextEp.id);
            flash(`Archived — switched to "${nextEp.title}"`);
          } else {
            setActiveId('');
            try {
              localStorage.removeItem('wm_active_episode');
            } catch {}
            setBundle(null);
            flash('Archived — no other episodes in this series yet');
          }
        } else {
          flash('Archived');
        }
      } else {
        flash('Un-archived');
      }
    } catch (e: any) {
      flash(`Archive error: ${String(e?.message || e).slice(0, 120)}`);
    } finally {
      setArchiveBusy(false);
    }
  }, [
    activeId,
    bundle?.meta,
    episodesInActiveSeries,
    showArchived,
    flash,
    loadProject,
  ]);

  const onLocationChange = useCallback((segId: string, next: string) => {
    setBundle((prev) => {
      if (!prev?.timeline) return prev;
      return {
        ...prev,
        timeline: prev.timeline.map((s) =>
          s.id === segId ? { ...s, location: next || undefined } : s,
        ),
      };
    });
  }, []);

  const onKenBurnsChange = useCallback((segId: string, next: string) => {
    setBundle((prev) => {
      if (!prev?.timeline) return prev;
      return {
        ...prev,
        timeline: prev.timeline.map((s) =>
          s.id === segId ? { ...s, ken_burns: next } : s,
        ),
      };
    });
  }, []);

  // Optimistic local patch for the per-segment Video toggle. Avoids a
  // full bundle refetch (which reloads every frame URL + re-renders every
  // Row) — the server PATCH happens inside Row, this just flips the flag
  // in the already-loaded timeline.
  const onIsVideoChange = useCallback((segId: string, next: boolean) => {
    setBundle((prev) => {
      if (!prev?.timeline) return prev;
      return {
        ...prev,
        timeline: prev.timeline.map((s) =>
          s.id === segId ? { ...s, is_video: next } : s,
        ),
      };
    });
  }, []);

  const onFramePersisted = useCallback((segId: string, frameUrl: string) => {
    setBundle((prev) => {
      if (!prev?.timeline) return prev;
      // Capture the outgoing frame_url so it can be undone. Fresh generate →
      // edit → edit → undo returns to the previous edit, not to "no frame".
      const prior = prev.timeline.find((s) => s.id === segId)?.frame_url;
      if (prior && prior !== frameUrl) {
        setFrameHistory((h) => {
          const entry = h[segId] ?? { past: [], future: [] };
          return {
            ...h,
            [segId]: {
              past: [...entry.past, prior].slice(-HISTORY_MAX_DEPTH),
              future: [], // new action invalidates redo stack
            },
          };
        });
      }
      return {
        ...prev,
        timeline: prev.timeline.map((s) =>
          s.id === segId ? { ...s, frame_url: frameUrl } : s,
        ),
      };
    });
  }, []);

  const patchTimelineFrame = useCallback(
    async (segId: string, nextUrl: string) => {
      // Cheap server-side update — just rewrites timeline.json[seg].frame_url
      // to a URL that's already hosted on Supabase from a previous version.
      try {
        await fetch(
          `/api/projects/${encodeURIComponent(activeId)}/frames/${encodeURIComponent(segId)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ frame_url: nextUrl }),
          },
        );
      } catch {
        // If the patch fails the local state still shows the correct image;
        // the next loadProject will re-sync.
      }
    },
    [activeId],
  );

  const onUndoFrame = useCallback(
    (segId: string) => {
      const entry = frameHistory[segId];
      if (!entry || entry.past.length === 0) return;
      const prevUrl = entry.past[entry.past.length - 1];
      const currentUrl =
        bundle?.timeline?.find((s) => s.id === segId)?.frame_url ?? null;
      setFrameHistory((h) => ({
        ...h,
        [segId]: {
          past: entry.past.slice(0, -1),
          future: currentUrl
            ? [...entry.future, currentUrl].slice(-HISTORY_MAX_DEPTH)
            : entry.future,
        },
      }));
      setBundle((prev) =>
        prev?.timeline
          ? {
              ...prev,
              timeline: prev.timeline.map((s) =>
                s.id === segId ? { ...s, frame_url: prevUrl } : s,
              ),
            }
          : prev,
      );
      void patchTimelineFrame(segId, prevUrl);
    },
    [frameHistory, bundle, patchTimelineFrame],
  );

  const onRedoFrame = useCallback(
    (segId: string) => {
      const entry = frameHistory[segId];
      if (!entry || entry.future.length === 0) return;
      const nextUrl = entry.future[entry.future.length - 1];
      const currentUrl =
        bundle?.timeline?.find((s) => s.id === segId)?.frame_url ?? null;
      setFrameHistory((h) => ({
        ...h,
        [segId]: {
          past: currentUrl
            ? [...entry.past, currentUrl].slice(-HISTORY_MAX_DEPTH)
            : entry.past,
          future: entry.future.slice(0, -1),
        },
      }));
      setBundle((prev) =>
        prev?.timeline
          ? {
              ...prev,
              timeline: prev.timeline.map((s) =>
                s.id === segId ? { ...s, frame_url: nextUrl } : s,
              ),
            }
          : prev,
      );
      void patchTimelineFrame(segId, nextUrl);
    },
    [frameHistory, bundle, patchTimelineFrame],
  );

  return (
    <div style={{ ...styles.page, padding: isMobile ? 12 : 20 }}>
      <SetupModal
        open={setupOpen}
        onConfigured={(url) => {
          setSetupOpen(false);
          if (url) onSaveTunnelUrl(url);
          flash('Local harness configured');
        }}
      />
      {flashMsg && <div style={styles.flash}>{flashMsg}</div>}

      <div style={styles.header}>
        <div style={styles.titleRow}>
          <h1 style={{ ...styles.title, fontSize: isMobile ? 16 : 18 }}>
            {editingTitle ? (
              <input
                autoFocus
                type="text"
                value={titleDraft}
                maxLength={120}
                disabled={titleBusy}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitTitle();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setEditingTitle(false);
                  }
                }}
                style={{
                  ...styles.titleInput,
                  ...(isMobile ? { minWidth: 0, width: '100%', fontSize: 16, padding: '6px 10px' } : null),
                }}
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  if (!activeId) return;
                  setTitleDraft(bundle?.meta?.title || '');
                  setEditingTitle(true);
                }}
                style={styles.titleBtn}
                title="Click to rename"
              >
                {bundle?.meta?.title || 'video contact sheet'}
                <span style={styles.titlePencil}>✎</span>
              </button>
            )}
            {bundle?.timeline && <span style={styles.count}> — {bundle.timeline.length} segments</span>}
            {activeId && bundle?.meta && !editingTitle && (
              <button
                type="button"
                onClick={toggleArchive}
                disabled={archiveBusy}
                style={{
                  ...styles.archiveBtn,
                  ...(bundle.meta.archived_at ? styles.archiveBtnActive : null),
                  ...(archiveBusy ? { opacity: 0.5, cursor: 'wait' } : null),
                }}
                title={
                  bundle.meta.archived_at
                    ? 'Un-archive this episode — brings it back into the Episode dropdown.'
                    : 'Archive this episode — hides it from the Episode dropdown without deleting any data.'
                }
              >
                {bundle.meta.archived_at ? '↩ Un-archive' : '📦 Archive'}
              </button>
            )}
            {bundle?.meta?.archived_at && (
              <span
                style={styles.archivedBadge}
                title={`Archived on ${new Date(bundle.meta.archived_at).toLocaleString()}`}
              >
                ARCHIVED
              </span>
            )}
            {(() => {
              // Amber nag-chip: counts character refs without a variant
              // at the project's non-default aspect. Clicks open the
              // References panel so the user can hit the bulk button.
              const aspect = bundle?.meta?.aspect;
              if (!aspect || aspect === '16:9') return null;
              const refs = bundle?.characters?.refs ?? [];
              const missing = refs.filter((r) => !r.variants?.[aspect]).length;
              if (missing === 0) return null;
              return (
                <button
                  type="button"
                  onClick={() => {
                    setPanels((p) => ({ ...p, references: true }));
                    window.setTimeout(() => {
                      document
                        .querySelector('[data-panel="references"]')
                        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }, 50);
                  }}
                  style={styles.variantsChip}
                  title={`${missing} character reference${missing === 1 ? '' : 's'} still at 16:9. Click to open References and generate ${aspect} variants.`}
                >
                  ⚠ {missing} ref{missing === 1 ? '' : 's'} need {aspect} variants
                </button>
              );
            })()}
          </h1>
          <div style={{ ...styles.tunnel, ...(isMobile ? { width: '100%', flexWrap: 'wrap' } : null) }}>
            {!hostedApiLocked && <CreditsBadge />}
            <span style={{ ...styles.dot, background: tunnelOk ? '#34d399' : '#ef4444' }} />
            <span style={styles.tunnelLabel}>{tunnelOk ? 'server online' : 'server offline'}</span>
            <input
              type="text"
              placeholder="https://xxx.trycloudflare.com"
              defaultValue={tunnelUrl}
              onBlur={(e) => onSaveTunnelUrl(e.target.value.trim())}
              style={{
                ...styles.tunnelInput,
                ...(isMobile
                  ? { flexBasis: '100%', width: '100%', padding: '10px 12px', fontSize: 16, minHeight: 44 }
                  : { width: 260 }),
              }}
            />
          </div>
        </div>

        {hostedApiLocked && (
          <div style={styles.publicHarnessNotice}>
            <strong>Public agent harness.</strong> This hosted copy does not expose Casper's projects, generations, Supabase data, or provider keys. Attach your agent to a local copy with your own `.env.local`, or enter your agent's tunnel URL above.
          </div>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 8,
            marginBottom: 8,
          }}
        >
          {(() => {
            // Button behaviour depends on whether work is already in flight.
            //  - Idle: open a fresh intake form
            //  - Running (drafting | provisioning): re-open the modal so the
            //    user can watch progress, never start a second run
            //  - Has a draft / error / done (review | done | error): warn
            //    before wiping the existing state
            const running = orchMounted && (orchPhase === 'drafting' || orchPhase === 'provisioning');
            const hasDraft = orchMounted && (orchPhase === 'review' || orchPhase === 'done' || orchPhase === 'error');
            const label = running
              ? (orchPhase === 'provisioning' ? 'Generating…' : 'Drafting…')
              : hasDraft
                ? (orchPhase === 'review' ? 'Resume draft' : 'Generate with AI')
                : '✨ Generate with AI';
            const handleClick = () => {
              if (running) {
                // Never cancel — just re-open to show progress.
                setOrchVisible(true);
                return;
              }
              if (hasDraft) {
                // Ask first — wiping the in-memory draft is destructive.
                setOrchConfirmOpen(true);
                return;
              }
              // Fresh start.
              setOrchMounted(true);
              setOrchVisible(true);
              setOrchResetToken((t) => t + 1);
            };
            return (
              <button
                type="button"
                onClick={handleClick}
                style={running ? styles.aiButtonRunning : styles.aiButton}
                title={
                  running
                    ? 'AI generation is running in the background — click to view progress'
                    : hasDraft
                      ? 'A previous AI run is still in memory — starting a new one will clear it'
                      : 'Let Gemini draft a full episode — script, voices, characters, frames — from a short intake questionnaire'
                }
              >
                {running && <span style={styles.aiSpinner} aria-hidden="true" />}
                {label}
              </button>
            );
          })()}
        </div>

        <ProjectBar
          series={series}
          episodes={episodesInActiveSeries}
          activeSeriesId={activeSeriesId}
          activeEpisodeId={activeId}
          onSwitchSeries={onSwitchSeries}
          onSwitchEpisode={onSwitchProject}
          onCreateSeries={onCreateSeries}
          onCreateEpisode={onCreateEpisode}
          onDeleteSeries={async (seriesId) => {
            // Cascade delete — the API removes every episode blob AND the
            // series doc. Clear any cached pointers so the mount-time
            // resolver doesn't try to reload the deleted series on refresh.
            try {
              const r = await fetch(
                `/api/series/${encodeURIComponent(seriesId)}?cascade=1`,
                { method: 'DELETE' },
              );
              if (!r.ok) {
                flash(`Delete series failed: ${(await r.text()).slice(0, 200)}`);
                return;
              }
              const j = await r.json().catch(() => ({}));
              flash(`Deleted "${seriesId}" + ${j?.removed_episodes ?? 0} episode(s)`);
              try {
                localStorage.removeItem(SERIES_KEY);
                localStorage.removeItem(EPISODE_KEY);
              } catch {}
              setActiveSeriesId('');
              setActiveId('');
              setBundle(null);
              setEpisodesInActiveSeries([]);
              // Refresh lists. The mount-time selection fallback then
              // picks the first remaining series automatically.
              const [nextSeries] = await Promise.all([
                refreshSeries(),
                refreshProjects(),
              ]);
              const fallback = nextSeries[0];
              if (fallback) {
                setActiveSeriesId(fallback.id);
                try { localStorage.setItem(SERIES_KEY, fallback.id); } catch {}
                const eps = await loadEpisodesForSeries(fallback.id);
                const firstEp = eps[0];
                if (firstEp) {
                  setActiveId(firstEp.id);
                  try { localStorage.setItem(EPISODE_KEY, firstEp.id); } catch {}
                  await loadProject(firstEp.id);
                }
              }
            } catch (e: any) {
              flash(`Delete series failed: ${String(e?.message || e).slice(0, 200)}`);
            }
          }}
          showArchived={showArchived}
          onToggleShowArchived={setShowArchived}
        />

        {orchMounted && (
          <OrchestratorModal
            visible={orchVisible}
            resetToken={orchResetToken}
            onPhaseChange={setOrchPhase}
            onClose={() => setOrchVisible(false)}
            onDone={async (newProjectId) => {
              // User clicked "Open episode" — hide the modal AND reset so the
              // next Generate-with-AI click starts fresh without prompting a
              // confirm dialog.
              setOrchVisible(false);
              setOrchResetToken((t) => t + 1);
              try {
                const [_series, projects] = await Promise.all([
                  refreshSeries(),
                  refreshProjects(),
                ]);
                // Resolve the new episode's series FIRST, then load its
                // episode list + set it as active. Without this the mount-
                // time localStorage reader lands on the PREVIOUS series on
                // refresh, and its fallback-to-first-episode picks some
                // unrelated (often empty) project — which is why the page
                // looked "empty" after a refresh.
                const newMeta = (projects || []).find((p) => p.id === newProjectId);
                const newSeriesId = newMeta?.series_id || '';
                if (newSeriesId) {
                  setActiveSeriesId(newSeriesId);
                  try { localStorage.setItem(SERIES_KEY, newSeriesId); } catch {}
                  await loadEpisodesForSeries(newSeriesId);
                }
                setActiveId(newProjectId);
                await loadProject(newProjectId);
              } catch {}
            }}
            flash={flash}
            tunnelUrl={tunnelOk ? tunnelUrl : null}
          />
        )}

        {orchConfirmOpen && (
          <ConfirmRestart
            onCancel={() => { setOrchConfirmOpen(false); setOrchVisible(true); }}
            onConfirm={() => {
              setOrchConfirmOpen(false);
              setOrchResetToken((t) => t + 1);
              setOrchVisible(true);
            }}
          />
        )}

        <Checklist
          activeSeriesId={activeSeriesId}
          activeEpisodeId={activeId}
          bundle={bundle}
          onScrollTo={(target: ChecklistTarget) => {
            // The first four steps (series/script/voice/aspect/voiceover)
            // all live in or above the Script + Voice panel. Map every
            // non-frames step to the `script` anchor and open that panel
            // so the user lands directly on the right tool.
            const anchorKey = target === 'frames' ? 'frames' : 'script';
            if (anchorKey === 'script') {
              setPanels((p) => {
                const next = { ...p, script: true };
                try {
                  localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(next));
                } catch {}
                return next;
              });
            }
            // Let React render the newly-opened panel before scrolling.
            requestAnimationFrame(() => {
              const anchor = document.querySelector<HTMLElement>(
                `[data-checklist="${anchorKey}"]`,
              );
              if (anchor) anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
              else window.scrollTo({ top: 0, behavior: 'smooth' });
            });
          }}
        />

        {activeId && (
          <div
            style={{
              display: 'flex',
              flexDirection: stackedPanels ? 'column' : 'row',
              gap: 10,
              alignItems: 'flex-start',
              marginTop: 10,
            }}
          >
            <div
              style={{ flex: 1, minWidth: 0 }}
              /* All four "prep" steps (script/voice/aspect/voiceover) live
                 inside the Script + Voice panel — one anchor handles them all. */
              data-checklist="script"
            >
            <Collapsible
              title="Script + voice"
              open={panels.script}
              onToggle={() => togglePanel('script')}
              info={(() => {
                const spk = speakersUsed(bundle?.script ?? '');
                if (spk.length === 0) {
                  return 'Narration-only script. Every line is read by the project narrator voice. Add an @NAME: tag at the start of a line to make it a dialogue line in that character\'s voice — e.g. @NIA: "Goodnight, Riley."';
                }
                return `Multi-voice script with ${spk.length} character${spk.length === 1 ? '' : 's'} (${spk.map((s) => '@' + s).join(', ')}). Plain-prose lines use the narrator voice; @NAME: lines use each character's cast voice. Cast them in the Voice panel below.`;
              })()}
              summary={
                bundle?.script
                  ? `${bundle.script.length.toLocaleString()} chars · ${bundle.voiceover_url ? 'voiceover ready' : 'no voiceover'}`
                  : 'empty'
              }
            >
              <ScriptBar
                projectId={activeId}
                initialScript={bundle?.script ?? ''}
                voiceoverUrl={bundle?.voiceover_url ?? null}
                currentVoiceId={bundle?.meta?.voice_id}
                activeVoiceId={bundle?.meta?.active_voice_id}
                voiceoverGenerations={bundle?.voiceover_generations ?? []}
                initialCast={bundle?.cast ?? null}
                onPipelineDone={() => loadProject(activeId)}
                flash={flash}
                tunnelUrl={tunnelOk ? tunnelUrl : null}
              />
            </Collapsible>
            </div>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Collapsible
              title="Mass import prompts"
              open={panels.prompts}
              onToggle={() => togglePanel('prompts')}
              info={'Paste a block of VO_### prompts to fill every frame at once. Accepted formats:  VO_001: wide shot of Riley in the kitchen... | [VO_001] wide shot of Riley... | one prompt per line, in order. Each line maps to the timeline row with the matching VO_ id (or to the Nth row if unlabelled). Saves straight to the project — no per-row typing.'}
              summary={`${Object.keys(bundle?.prompts ?? {}).length} prompts on file`}
            >
              <PromptImport
                projectId={activeId}
                onParsed={() => loadProject(activeId)}
                flash={flash}
              />
            </Collapsible>
            <div data-panel="references">
            <Collapsible
              title="References"
              open={panels.references}
              onToggle={() => togglePanel('references')}
              info={'Images the model sees before painting each frame. Character refs lock identity (face, hair, wardrobe) — tag each ref with @NAME so it only attaches on frames that mention that character. Untagged refs attach to every frame. Product refs add a physical object the prompt can place into the scene. Paste or drop images; PNG/JPG/WebP.'}
              summary={`${bundle?.characters?.refs?.length ?? 0} character · ${bundle?.products?.refs?.length ?? 0} product`}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', flexDirection: stackedPanels ? 'column' : 'row', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                <ReferenceZone
                  projectId={activeId}
                  kind="characters"
                  refs={bundle?.characters?.refs ?? []}
                  characterSuggestions={speakersUsed(bundle?.script ?? '')}
                  projectAspect={bundle?.meta?.aspect}
                  onChanged={(next) => {
                    if (next) {
                      setBundle((prev) =>
                        prev ? { ...prev, characters: { refs: next } } : prev,
                      );
                    } else {
                      loadProject(activeId);
                    }
                  }}
                  flash={flash}
                />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                <ReferenceZone
                  projectId={activeId}
                  kind="products"
                  refs={bundle?.products?.refs ?? []}
                  projectAspect={bundle?.meta?.aspect}
                  onChanged={(next) => {
                    if (next) {
                      setBundle((prev) =>
                        prev ? { ...prev, products: { refs: next } } : prev,
                      );
                    } else {
                      loadProject(activeId);
                    }
                  }}
                  flash={flash}
                />
                </div>
                </div>
                <LocationsZone
                  projectId={activeId}
                  libraryId={bundle?.meta?.location_library_id}
                  projectAspect={bundle?.meta?.aspect}
                  onLibraryChange={(next) =>
                    setBundle((prev) =>
                      prev
                        ? {
                            ...prev,
                            meta: { ...prev.meta, location_library_id: next || undefined },
                          }
                        : prev,
                    )
                  }
                  flash={flash}
                />
              </div>
            </Collapsible>
            </div>
            </div>
          </div>
        )}
      </div>

      {loading && <div style={styles.loading}>Loading project…</div>}

      {bundle && !bundle.meta?.aspect && (
        <div style={styles.aspectGateBanner}>
          <strong style={{ marginRight: 8 }}>⚠ Aspect ratio required</strong>
          Pick an aspect before generating frames — it stamps onto every image and
          can't be undone cheaply. Use the Aspect bar above to choose.
        </div>
      )}

      {!loading && bundle?.timeline && bundle.timeline.length > 0 && (() => {
        const aspectLocked = Boolean(bundle.meta?.aspect);
        const gateTitle = !aspectLocked ? 'Pick an aspect ratio above first' : undefined;
        // A row is "missing" if it doesn't have a frame yet. If no explicit
        // prompt is saved, we fall back to the row's narration at submit time
        // so the bulk runner never silently skips a row.
        const missing = bundle.timeline.filter((s) => !s.frame_url);
        const withoutPrompt = missing.filter(
          (s) => !(bundle.prompts[s.id]?.prompt || '').trim(),
        ).length;
        const runBulk = async () => {
          if (missing.length === 0 || bulkBusy) return;
          const abort = new AbortController();
          bulkAbortRef.current = abort;
          setBulkBusy(true);
          setBulkStatus(`Starting bulk generate (${missing.length})…`);
          try {
            // Per-segment character ref filter — mirrors the Row path so
            // bulk regenerate uses the same cast-aware ref selection as
            // the single-frame generate button. Prefers aspect-matching
            // variant URLs when the project is on a non-default aspect.
            const charRefs = bundle.characters?.refs ?? [];
            const projectAspect = bundle.meta?.aspect;
            const pickUrl = (r: typeof charRefs[number]): string =>
              (projectAspect && r.variants?.[projectAspect]) || r.url;
            const taggedRefs = charRefs.filter((r) => !!r.character);
            const untaggedUrls = charRefs
              .filter((r) => !r.character)
              .map(pickUrl);
            const knownSlugs = Array.from(
              new Set<string>([
                ...speakersUsed(bundle.script ?? ''),
                ...charRefs
                  .map((r) => r.character?.toUpperCase() || '')
                  .filter((s) => s.length > 0),
              ]),
            );
            const charUrlsForSeg = (seg: Segment): string[] => {
              if (taggedRefs.length === 0) return untaggedUrls;
              const promptText = bundle.prompts[seg.id]?.prompt ?? '';
              const haystack = `${seg.narration ?? ''}\n${promptText}`;
              const present = extractCharacterMentions(haystack, knownSlugs);
              if (present.size === 0) return charRefs.map(pickUrl);
              const matched = taggedRefs
                .filter((r) => r.character && present.has(r.character))
                .map(pickUrl);
              return [...untaggedUrls, ...matched];
            };
            const items = missing.map((s) => ({
              segId: s.id,
              prompt:
                (bundle.prompts[s.id]?.prompt || '').trim() ||
                (s.narration || '').trim(),
              includeProduct: shouldIncludeProduct(s, bundle.timeline!),
              characterImageUrls: charUrlsForSeg(s),
            })).filter((x) => x.prompt);
            const result = await generateAll(items, {
              projectId: activeId,
              characterImageUrls: (bundle.characters?.refs ?? []).map((r) => r.url),
              productImageUrls: (bundle.products?.refs ?? []).map((r) => r.url),
              productNotes: (bundle.products?.refs ?? [])
                .map((r) => (r.notes || '').trim())
                .filter((n) => n.length > 0),
              signal: abort.signal,
              tunnelUrl: tunnelOk ? tunnelUrl : null,
              // Cap concurrency at 4. The browser only opens ~6 connections
              // per origin anyway, and higher numbers push some submits into
              // a queue that starves the polls — frames "finish" at FAL but
              // the status endpoint never gets polled before the 100s timeout,
              // so they report as failed even though Supabase has the bytes.
              aspect: bundle.meta?.aspect,
              concurrency: Math.min(items.length, 4),
              onProgress: (done, total, last) => {
                setBulkStatus(
                  `Generating ${done}/${total}… ` +
                    (last.ok ? `✓ ${last.segId}` : `✗ ${last.segId}: ${last.error}`),
                );
                // Patch the live bundle so Row re-renders with the new frame
                // immediately instead of waiting for the whole bulk to finish.
                if (last.ok && last.frame_url) {
                  setBundle((prev) => {
                    if (!prev?.timeline) return prev;
                    return {
                      ...prev,
                      timeline: prev.timeline.map((s) =>
                        s.id === last.segId ? { ...s, frame_url: last.frame_url! } : s,
                      ),
                    };
                  });
                }
              },
            });
            const msg = result.halted
              ? `Halted: ${result.halted}. ${result.succeeded} generated before stopping.`
              : `Bulk done — ${result.succeeded} generated, ${result.failed} failed`;
            setBulkStatus(msg);
            flash(msg);
            // Surface the first distinct error so the user can see what
            // actually went wrong instead of just "N failed". Log every
            // failure to the console for deeper debugging.
            const failedEntries = Object.entries(result.errors || {});
            if (failedEntries.length > 0) {
              const firstErr = failedEntries[0];
              flash(`${firstErr[0]}: ${String(firstErr[1]).slice(0, 200)}`);
              // eslint-disable-next-line no-console
              console.warn('[bulk-generate] per-frame errors:', result.errors);
            }
            // Don't refetch — onProgress already patched every frame_url into
            // local state. A loadProject here would race Supabase's CDN
            // replication and often pull back a timeline.json that's still
            // pre-generate, making the freshly-populated frames wink out.
          } finally {
            setBulkBusy(false);
            bulkAbortRef.current = null;
          }
        };
        return (
          <>
            <SubtitleBar value={subtitles} onChange={updateSubtitles} />
            <MusicBar value={music} onChange={updateMusic} />
            <AspectPicker
              projectId={activeId}
              value={bundle.meta?.aspect}
              hasStampedFrames={(bundle.timeline ?? []).some((s) => s.frame_url && s.aspect)}
              onChange={(next: AspectId) => {
                setBundle((prev) =>
                  prev ? { ...prev, meta: { ...prev.meta, aspect: next } } : prev,
                );
              }}
              flash={flash}
            />
            <PreferencesBar projectId={activeId} flash={flash} />
            <div style={styles.appendBar}>
              <div style={styles.appendLabel}>Append voiceover line</div>
              <div style={styles.appendRow}>
                <input
                  type="text"
                  value={appendText}
                  onChange={(e) => setAppendText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !appendBusy) {
                      e.preventDefault();
                      appendVoice();
                    }
                  }}
                  placeholder='e.g. "Follow for more — link in bio."'
                  disabled={appendBusy}
                  style={{ ...styles.appendInput, ...(isMobile ? styles.appendInputMobile : null) }}
                />
                <button
                  onClick={appendVoice}
                  disabled={appendBusy || !appendText.trim() || !aspectLocked}
                  style={{
                    ...styles.appendBtn,
                    ...(isMobile ? styles.appendBtnMobile : null),
                    opacity: appendBusy || !appendText.trim() || !aspectLocked ? 0.5 : 1,
                    cursor: appendBusy || !appendText.trim() || !aspectLocked ? 'not-allowed' : 'pointer',
                  }}
                  title={gateTitle || "Generate voice for this text and splice onto the end of the voiceover. Adds a new VO_NNN row."}
                >
                  {appendBusy ? '…generating' : '🎙 Generate & append'}
                </button>
              </div>
              {appendStatus && <div style={styles.appendStatus}>{appendStatus}</div>}
            </div>
            <div style={styles.appendBar}>
              <div style={styles.appendLabel}>
                {massEditProduct
                  ? `Mass edit — placing 📦 ${massEditProduct.label} in every frame`
                  : 'Mass edit every frame (uses each frame as its own reference)'}
              </div>
              {massEditProduct && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                  <span
                    style={{
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
                    }}
                  >
                    📦 {massEditProduct.label}
                    <button
                      type="button"
                      onClick={() => setMassEditProduct(null)}
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: '50%',
                        background: 'rgba(0,0,0,0.4)',
                        color: '#fde68a',
                        border: 'none',
                        fontSize: 14,
                        lineHeight: 1,
                        cursor: 'pointer',
                      }}
                      title="Remove attached product"
                    >
                      ×
                    </button>
                  </span>
                  <span style={{ fontSize: 11, color: '#737373', fontStyle: 'italic' }}>
                    your instruction becomes placement guidance
                  </span>
                </div>
              )}
              <div style={styles.appendRow}>
                <PromptHistoryInput
                  value={massEditText}
                  onChange={setMassEditText}
                  placeholder={massEditProduct
                    ? `Placement for ${massEditProduct.label} (e.g. "on the desk in the foreground, cover facing camera")`
                    : 'e.g. "Zoom out slightly for a wider angle, keep everything else identical."'}
                  disabled={massEditBusy}
                  handleRef={massEditHistoryRef}
                  inputStyle={styles.appendInput}
                  inputStyleMobile={styles.appendInputMobile}
                  multiline
                  minRows={3}
                  maxRows={14}
                />
                {(bundle?.products?.refs?.length ?? 0) > 0 && (
                  <div style={{ position: 'relative' }}>
                    <button
                      type="button"
                      onClick={() => setMassEditProductPickerOpen((v) => !v)}
                      disabled={massEditBusy}
                      style={{
                        ...styles.appendBtn,
                        ...(isMobile ? styles.appendBtnMobile : null),
                        background: massEditProduct ? '#3d2e0f' : '#171717',
                        borderColor: massEditProduct ? '#b45309' : '#404040',
                        color: massEditProduct ? '#fbbf24' : '#a3a3a3',
                      }}
                      title={massEditProduct
                        ? 'Change or clear the attached product'
                        : 'Attach a product to place into every frame'}
                    >
                      📦 {massEditProduct ? 'change' : 'Attach product'}
                    </button>
                    {massEditProductPickerOpen && (
                      <MassEditProductPopover
                        products={bundle?.products?.refs ?? []}
                        currentUrl={massEditProduct?.url ?? null}
                        onClose={() => setMassEditProductPickerOpen(false)}
                        onPick={(url, label) => {
                          setMassEditProduct({ url, label });
                          setMassEditProductPickerOpen(false);
                        }}
                      />
                    )}
                  </div>
                )}
                <button
                  onClick={async () => {
                    const instruction = massEditText.trim();
                    if (!instruction) {
                      flash('Type an edit instruction first');
                      return;
                    }
                    const allFramed = (bundle?.timeline ?? []).filter((s) => s.frame_url);
                    // If the user has rows ticked (e.g. via the White Border
                    // Check QA), only edit those. Empty selection → edit all.
                    const framed = selected.size > 0
                      ? allFramed.filter((s) => selected.has(s.id))
                      : allFramed;
                    if (framed.length === 0) {
                      flash(selected.size > 0 ? 'No selected rows have frames to edit' : 'No frames to edit');
                      return;
                    }
                    const scopeLabel = selected.size > 0
                      ? `the ${framed.length} selected frames`
                      : `all ${framed.length} frames`;
                    if (!confirm(`Apply this edit to ${scopeLabel}? The previous version of each frame will be preserved in its undo stack.`)) {
                      return;
                    }
                    // Record this prompt in the global history as soon as
                    // the user commits — runs fire-and-forget in parallel
                    // with the edit so it never blocks the real work.
                    void massEditHistoryRef.current?.recordUsage();
                    const abort = new AbortController();
                    massEditAbortRef.current = abort;
                    setMassEditBusy(true);
                    setMassEditStatus(`Editing 0/${framed.length}…`);
                    try {
                      const items = framed.map((s) => ({ segId: s.id, currentFrameUrl: s.frame_url! }));
                      const result = await editAll(items, {
                        projectId: activeId,
                        instruction,
                        attachedProduct: massEditProduct,
                        tunnelUrl: tunnelOk ? tunnelUrl : null,
                        concurrency: Math.min(items.length, 8),
                        signal: abort.signal,
                        onProgress: (done, total, last) => {
                          setMassEditStatus(
                            `Editing ${done}/${total}… ` +
                              (last.ok ? `✓ ${last.segId}` : `✗ ${last.segId}: ${last.error}`),
                          );
                          if (last.ok && last.frame_url) {
                            // Route through onFramePersisted so the prior
                            // frame lands in the segment's undo stack.
                            onFramePersisted(last.segId, last.frame_url);
                          }
                        },
                      });
                      const msg = result.halted
                        ? `Halted: ${result.halted}. ${result.succeeded} edited before stopping.`
                        : `Mass edit done — ${result.succeeded} edited, ${result.failed} failed`;
                      setMassEditStatus(msg);
                      flash(msg);
                      // State already patched through onFramePersisted per frame.
                      // Skip the refetch — see note on the bulk-generate finalizer.
                    } finally {
                      setMassEditBusy(false);
                      massEditAbortRef.current = null;
                      setMassEditProduct(null);
                    }
                  }}
                  disabled={massEditBusy || !massEditText.trim() || !aspectLocked}
                  style={{
                    ...styles.appendBtn,
                    ...(isMobile ? styles.appendBtnMobile : null),
                    background: '#334155',
                    borderColor: '#64748b',
                    color: '#e2e8f0',
                    opacity: massEditBusy || !massEditText.trim() || !aspectLocked ? 0.5 : 1,
                    cursor: massEditBusy || !massEditText.trim() || !aspectLocked ? 'not-allowed' : 'pointer',
                  }}
                  title={gateTitle || "Apply this edit instruction to every frame in parallel, using each frame's current image as its only reference"}
                >
                  {massEditBusy
                    ? '…editing'
                    : massEditProduct
                      ? selected.size > 0
                        ? `📦 Place in selected (${selected.size})`
                        : '📦 Place in all frames'
                      : selected.size > 0
                        ? `✏️ Mass edit selected (${selected.size})`
                        : '✏️ Mass edit all frames'}
                </button>
                {massEditBusy && (
                  <button
                    onClick={() => {
                      massEditAbortRef.current?.abort();
                      setMassEditStatus('Stopping after current edits…');
                    }}
                    style={styles.stopBtn}
                  >
                    ■ Stop
                  </button>
                )}
              </div>
              {massEditStatus && <div style={styles.appendStatus}>{massEditStatus}</div>}
            </div>
            <div style={styles.framesHeaderRow} data-checklist="frames">
              <div style={styles.framesHeader}>
                Frames <span style={styles.framesCount}>({bundle.timeline.length})</span>
              </div>
              <Button
                variant="primary"
                leadingIcon={<Zap size={14} strokeWidth={2} />}
                onClick={runBulk}
                disabled={missing.length === 0 || bulkBusy || !aspectLocked}
                loading={bulkBusy}
                title={!aspectLocked
                  ? 'Pick an aspect ratio above first'
                  : missing.length === 0
                    ? 'Every row already has a frame'
                    : withoutPrompt > 0
                      ? `${missing.length} missing — fires all in parallel (${withoutPrompt} will use narration as prompt)`
                      : `Fire all ${missing.length} missing frames at once`}
              >
                {bulkBusy ? 'Running' : `Generate all missing (${missing.length})`}
              </Button>
              {(bundle.timeline?.length ?? 0) > 0 && bundle.voiceover_url && (
                <DenserFramesButton
                  projectId={activeId}
                  currentSegments={bundle.timeline?.length ?? 0}
                  flash={flash}
                  onDone={() => {
                    void loadProject(activeId);
                  }}
                />
              )}
              {(() => {
                const framedCount = (bundle.timeline ?? []).filter((s) => s.frame_url).length;
                const runQa = async () => {
                  if (qaBusy) return;
                  const targets = (bundle.timeline ?? []).filter((s) => s.frame_url);
                  if (targets.length === 0) {
                    flash('No frames to QA yet');
                    return;
                  }
                  const abort = new AbortController();
                  qaAbortRef.current = abort;
                  setQaBusy(true);
                  setQaStatus(`Scanning 0/${targets.length}…`);
                  const flagged: string[] = [];
                  let done = 0;
                  let failed = 0;
                  const CONCURRENCY = 8;
                  let cursor = 0;
                  const worker = async () => {
                    for (;;) {
                      if (abort.signal.aborted) return;
                      const idx = cursor++;
                      if (idx >= targets.length) return;
                      const seg = targets[idx];
                      try {
                        const r = await fetch('/api/qa/white-border', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ image_url: seg.frame_url }),
                          signal: abort.signal,
                        });
                        if (r.ok) {
                          const j = await r.json();
                          if (j?.has_border) flagged.push(seg.id);
                        } else {
                          failed++;
                        }
                      } catch {
                        failed++;
                      }
                      done++;
                      setQaStatus(
                        `Scanning ${done}/${targets.length} · flagged ${flagged.length}${failed ? ` · ${failed} err` : ''}`,
                      );
                    }
                  };
                  try {
                    await Promise.all(
                      Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()),
                    );
                    if (!abort.signal.aborted) {
                      setSelected(new Set(flagged));
                      setQaStatus(
                        flagged.length === 0
                          ? `✓ All ${targets.length} frames look full-bleed — nothing to flag`
                          : `✓ Flagged ${flagged.length}/${targets.length}. They're now selected — run mass edit to fix.`,
                      );
                      flash(`White-border QA: ${flagged.length} flagged`);
                    } else {
                      setQaStatus(`Cancelled after ${done}/${targets.length}`);
                    }
                  } finally {
                    setQaBusy(false);
                    qaAbortRef.current = null;
                  }
                };
                return (
                  <>
                    <Button
                      variant="secondary"
                      leadingIcon={<ScanSearch size={14} strokeWidth={2} />}
                      onClick={runQa}
                      disabled={qaBusy || framedCount === 0}
                      loading={qaBusy}
                      title={
                        framedCount === 0
                          ? 'No frames to check yet'
                          : `Ask Gemini to flag any of the ${framedCount} generated frames that rendered with a page-matte / white border. Flagged rows get ticked so mass edit only touches them.`
                      }
                    >
                      {qaBusy ? 'Checking' : 'White Border Check'}
                    </Button>
                    {qaBusy && (
                      <Button
                        variant="danger"
                        leadingIcon={<Square size={12} strokeWidth={2.5} />}
                        onClick={() => {
                          qaAbortRef.current?.abort();
                          setQaStatus('Cancelling…');
                        }}
                      >
                        Stop
                      </Button>
                    )}
                    {qaStatus && <span style={styles.bulkStatus}>{qaStatus}</span>}
                  </>
                );
              })()}
              {bulkBusy && (
                <Button
                  variant="danger"
                  leadingIcon={<Square size={12} strokeWidth={2.5} />}
                  onClick={() => {
                    bulkAbortRef.current?.abort();
                    setBulkStatus('Stopping after current frame…');
                  }}
                >
                  Stop
                </Button>
              )}
              {withoutPrompt > 0 && !bulkBusy && (
                <span style={styles.bulkHint}>
                  {withoutPrompt} of {missing.length} use narration as prompt
                </span>
              )}
              {bulkStatus && <span style={styles.bulkStatus}>{bulkStatus}</span>}
              {!isMobile && <div style={{ flex: 1 }} />}
              {selected.size > 0 && (
                <button
                  onClick={async () => {
                    const ids = Array.from(selected);
                    if (!confirm(`Clear ${ids.length} selected frame${ids.length === 1 ? '' : 's'}? Prompts stay.`)) return;
                    setClearBusy(true);
                    setBulkStatus(`Clearing ${ids.length} selected…`);
                    try {
                      const r = await fetch(
                        `/api/projects/${encodeURIComponent(activeId)}/frames`,
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ action: 'clear', seg_ids: ids }),
                        },
                      );
                      if (!r.ok) {
                        setBulkStatus(`Failed: ${(await r.text()).slice(0, 120)}`);
                      } else {
                        const j = await r.json();
                        setBulkStatus(`Cleared ${j.cleared} frames`);
                        flash(`Cleared ${j.cleared} frames`);
                        // Patch state directly to dodge Supabase read-after-write
                        // lag that would otherwise bring the deleted frame_urls
                        // right back on a reload.
                        if (Array.isArray(j.timeline)) {
                          setBundle((prev) =>
                            prev ? { ...prev, timeline: j.timeline as Segment[] } : prev,
                          );
                        } else {
                          await loadProject(activeId);
                        }
                      }
                      setSelected(new Set());
                    } finally {
                      setClearBusy(false);
                    }
                  }}
                  disabled={clearBusy}
                  className="wm-btn"
                  data-variant="danger"
                  style={{
                    ...styles.clearSelBtn,
                    ...(isMobile ? styles.smallActionMobile : null),
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <Trash2 size={12} strokeWidth={2} />
                  {clearBusy ? 'Clearing' : `Clear selected (${selected.size})`}
                </button>
              )}
              {selected.size > 0 && (
                <>
                  <button
                    onClick={async () => {
                      const ids = new Set(selected);
                      const targets = (bundle?.timeline ?? []).filter(
                        (s) => ids.has(s.id) && s.frame_url,
                      );
                      if (targets.length === 0) {
                        flash('No selected rows have frames to fix');
                        return;
                      }
                      if (
                        !confirm(
                          `Crop the white/cream matte off ${targets.length} frame${targets.length === 1 ? '' : 's'} and upscale the art to full-bleed? The previous version stays in each row's undo stack.`,
                        )
                      ) {
                        return;
                      }
                      const abort = new AbortController();
                      borderFixAbortRef.current = abort;
                      setBorderFixBusy(true);
                      setBorderFixStatus(`Fixing 0/${targets.length}…`);
                      const updates: { seg_id: string; frame_url: string; aspect?: string }[] = [];
                      let done = 0;
                      let failed = 0;
                      let cursor = 0;
                      const CONCURRENCY = 4;
                      const worker = async () => {
                        for (;;) {
                          if (abort.signal.aborted) return;
                          const idx = cursor++;
                          if (idx >= targets.length) return;
                          const seg = targets[idx];
                          try {
                            // Crop off the detected matte and upscale the art
                            // back to the frame's original dimensions, all
                            // client-side. No generative model — the result
                            // is the original art, just minus the border.
                            const { data_url } = await cropAndUpscaleToFullBleed(seg.frame_url!);
                            const r = await fetch(
                              `/api/projects/${encodeURIComponent(activeId)}/frames/${encodeURIComponent(seg.id)}`,
                              {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  data_url,
                                  // Let us flush the timeline atomically in
                                  // one batch-patch at the end, otherwise
                                  // parallel writers race on timeline.json.
                                  skip_timeline_patch: true,
                                  ...(seg.aspect ? { aspect: seg.aspect } : {}),
                                }),
                                signal: abort.signal,
                              },
                            );
                            if (!r.ok) {
                              failed++;
                              const errText = await r.text().catch(() => '');
                              console.warn(`[border-fix] ${seg.id} HTTP ${r.status}: ${errText.slice(0, 300)}`);
                            } else {
                              const j = await r.json();
                              if (j?.frame_url) {
                                onFramePersisted(seg.id, j.frame_url);
                                updates.push({
                                  seg_id: seg.id,
                                  frame_url: j.frame_url,
                                  ...(seg.aspect ? { aspect: seg.aspect } : {}),
                                });
                              } else {
                                failed++;
                                console.warn(`[border-fix] ${seg.id} no frame_url in response`, j);
                              }
                            }
                          } catch (e) {
                            failed++;
                            console.warn(`[border-fix] ${seg.id} threw`, e);
                          }
                          done++;
                          setBorderFixStatus(
                            `Fixing ${done}/${targets.length}${failed ? ` · ${failed} err` : ''}…`,
                          );
                        }
                      };
                      try {
                        await Promise.all(
                          Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()),
                        );
                        // Atomic timeline flush so parallel workers don't race
                        // each other the way bulk-generate used to — one read,
                        // N patches, one write.
                        if (updates.length > 0) {
                          try {
                            await fetch(
                              `/api/projects/${encodeURIComponent(activeId)}/frames/batch-patch`,
                              {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ updates }),
                              },
                            );
                          } catch {
                            /* state already patched via onFramePersisted;
                               next refresh will re-sync from Supabase */
                          }
                        }
                        const msg = abort.signal.aborted
                          ? `Cancelled after ${done}/${targets.length}`
                          : `✓ Fixed ${updates.length}/${targets.length}${failed ? ` · ${failed} failed` : ''}`;
                        setBorderFixStatus(msg);
                        flash(msg);
                        setSelected(new Set());
                      } finally {
                        setBorderFixBusy(false);
                        borderFixAbortRef.current = null;
                      }
                    }}
                    disabled={borderFixBusy}
                    className="wm-btn"
                    data-variant="secondary"
                    style={{
                      ...styles.borderFixBtn,
                      ...(isMobile ? styles.smallActionMobile : null),
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                    title="Detect the white/cream page matte on each selected frame, crop it off, and upscale the art to full-bleed. The original art is preserved — only the matte is removed."
                  >
                    <Bandage size={12} strokeWidth={2} />
                    {borderFixBusy
                      ? 'Fixing'
                      : `Fix borders (${selected.size})`}
                  </button>
                  {borderFixBusy && (
                    <Button
                      variant="danger"
                      leadingIcon={<Square size={12} strokeWidth={2.5} />}
                      onClick={() => {
                        borderFixAbortRef.current?.abort();
                        setBorderFixStatus('Stopping after current frames…');
                      }}
                    >
                      Stop
                    </Button>
                  )}
                  {borderFixStatus && (
                    <span style={styles.bulkStatus}>{borderFixStatus}</span>
                  )}
                </>
              )}
              <button
                onClick={async () => {
                  const withFrames = bundle.timeline!.filter((s) => s.frame_url);
                  if (withFrames.length === 0) {
                    flash('No frames to clear');
                    return;
                  }
                  if (!confirm(`Clear all ${withFrames.length} frames? Prompts stay.`)) return;
                  setClearBusy(true);
                  setBulkStatus(`Clearing all ${withFrames.length}…`);
                  try {
                    const r = await fetch(
                      `/api/projects/${encodeURIComponent(activeId)}/frames`,
                      {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'clear_all' }),
                      },
                    );
                    if (!r.ok) {
                      setBulkStatus(`Failed: ${(await r.text()).slice(0, 120)}`);
                    } else {
                      const j = await r.json();
                      setBulkStatus(`Cleared ${j.cleared} frames`);
                      flash(`Cleared ${j.cleared} frames`);
                      if (Array.isArray(j.timeline)) {
                        setBundle((prev) =>
                          prev ? { ...prev, timeline: j.timeline as Segment[] } : prev,
                        );
                      } else {
                        await loadProject(activeId);
                      }
                    }
                    setSelected(new Set());
                  } finally {
                    setClearBusy(false);
                  }
                }}
                disabled={clearBusy}
                style={{ ...styles.clearAllBtn, ...(isMobile ? styles.smallActionMobile : null) }}
              >
                Clear all
              </button>
            </div>
            <div style={styles.rows}>
              {(() => {
                const charRefs = bundle.characters?.refs ?? [];
                const prodUrls = (bundle.products?.refs ?? []).map((r) => r.url);
                const prodNotes = (bundle.products?.refs ?? [])
                  .map((r) => (r.notes || '').trim())
                  .filter((n) => n.length > 0);
                // Known character slugs the user has set up — sourced from
                // tagged refs + speakers in the live script. Drives the
                // plain-text mention matcher ("Sarah" → @SARAH).
                const knownSlugs = Array.from(
                  new Set<string>([
                    ...speakersUsed(bundle.script ?? ''),
                    ...charRefs
                      .map((r) => r.character?.toUpperCase() || '')
                      .filter((s) => s.length > 0),
                  ]),
                );
                // Pick the URL to attach for a given ref — prefers an
                // aspect-matching variant when the project is on 9:16 /
                // 4:5 / etc. Silent fallback to the original when no
                // variant exists. See app/lib/reframeImage.ts for how
                // variants get created.
                const projectAspect = bundle.meta?.aspect;
                const pickUrl = (r: typeof charRefs[number]): string =>
                  (projectAspect && r.variants?.[projectAspect]) || r.url;
                // Pre-split refs so the per-row loop is cheap.
                const untaggedUrls = charRefs
                  .filter((r) => !r.character)
                  .map(pickUrl);
                const taggedRefs = charRefs.filter((r) => !!r.character);
                const charUrlsForSeg = (seg: Segment): string[] => {
                  if (taggedRefs.length === 0) {
                    // No one has tagged any refs yet — legacy behaviour,
                    // every ref attaches to every frame.
                    return untaggedUrls;
                  }
                  const promptText = bundle.prompts[seg.id]?.prompt ?? '';
                  const haystack = `${seg.narration ?? ''}\n${promptText}`;
                  const present = extractCharacterMentions(haystack, knownSlugs);
                  // Narrator-only / no mention → fall back to attaching
                  // every character ref (establishing shots, B-roll beats).
                  if (present.size === 0) {
                    return charRefs.map(pickUrl);
                  }
                  const matched = taggedRefs
                    .filter((r) => r.character && present.has(r.character))
                    .map(pickUrl);
                  return [...untaggedUrls, ...matched];
                };
                // Lookup map for ref_seg_id resolution. Stable across renders
                // as long as bundle.timeline reference is stable.
                const segmentById = new Map<string, Segment>();
                for (const s of bundle.timeline) segmentById.set(s.id, s);
                const getSegmentById = (id: string) => segmentById.get(id) ?? null;
                // Patch ref_seg_id / prompt_archived for one segment via the
                // batch-meta route. Optimistically updates local state too.
                const onSegmentMetaPatched = async (
                  segId: string,
                  patch: { ref_seg_id?: string | null; prompt_archived?: string | null },
                ) => {
                  try {
                    const r = await fetch(
                      `/api/projects/${encodeURIComponent(activeId)}/segments/batch-meta`,
                      {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ updates: [{ seg_id: segId, ...patch }] }),
                      },
                    );
                    if (!r.ok) {
                      flash(`Lock patch failed: ${(await r.text()).slice(0, 120)}`);
                      return;
                    }
                    setBundle((prev) => {
                      if (!prev?.timeline) return prev;
                      const nextTimeline = prev.timeline.map((s) => {
                        if (s.id !== segId) return s;
                        const next: Segment = { ...s };
                        if (patch.ref_seg_id !== undefined) {
                          if (patch.ref_seg_id === null || patch.ref_seg_id === '') {
                            delete next.ref_seg_id;
                          } else {
                            next.ref_seg_id = patch.ref_seg_id;
                          }
                        }
                        return next;
                      });
                      const nextPrompts = { ...(prev.prompts ?? {}) };
                      if (patch.prompt_archived !== undefined) {
                        const cur = nextPrompts[segId] ?? { prompt: '' };
                        if (patch.prompt_archived === null) {
                          const { prompt_archived: _drop, ...rest } = cur;
                          nextPrompts[segId] = rest as PromptEntry;
                        } else {
                          nextPrompts[segId] = { ...cur, prompt_archived: patch.prompt_archived };
                        }
                      }
                      return { ...prev, timeline: nextTimeline, prompts: nextPrompts };
                    });
                  } catch (e: any) {
                    flash(`Lock patch error: ${String(e?.message || e).slice(0, 120)}`);
                  }
                };
                return bundle.timeline.map((seg, idx) => {
                  const isProductFrame = shouldIncludeProduct(seg, bundle.timeline!);
                  const charUrls = charUrlsForSeg(seg);
                  const previousSegment = idx > 0 ? bundle.timeline![idx - 1] : null;
                  return (
                    <Row
                      key={seg.id}
                      projectId={activeId}
                      segment={seg}
                      previousSegment={previousSegment}
                      getSegmentById={getSegmentById}
                      onSegmentMetaPatched={onSegmentMetaPatched}
                      promptEntry={bundle.prompts[seg.id]}
                      imageUrls={isProductFrame ? [...charUrls, ...prodUrls] : charUrls}
                      products={bundle.products?.refs ?? []}
                      productNotes={isProductFrame ? prodNotes : []}
                      isProductFrame={isProductFrame}
                      tunnelUrl={tunnelOk ? tunnelUrl : null}
                      selected={selected.has(seg.id)}
                      onToggleSelect={toggleSelect}
                      onUpdated={onRowsUpdated}
                      onIsVideoChange={onIsVideoChange}
                      onFramePersisted={onFramePersisted}
                      onFrameClick={() => setLightboxIndex(idx)}
                      onKenBurnsChange={onKenBurnsChange}
                      onLocationChange={onLocationChange}
                      subtitles={subtitles}
                      onToggleSubtitle={() => toggleSubtitleForSegment(seg.id)}
                      music={music}
                      onToggleMusic={() => toggleMusicForSegment(seg.id)}
                      canUndo={(frameHistory[seg.id]?.past?.length ?? 0) > 0}
                      canRedo={(frameHistory[seg.id]?.future?.length ?? 0) > 0}
                      onUndo={() => onUndoFrame(seg.id)}
                      onRedo={() => onRedoFrame(seg.id)}
                      hasNextSegment={idx < (bundle.timeline?.length ?? 0) - 1}
                      onTimelineReplace={onTimelineReplace}
                      projectAspect={bundle.meta?.aspect}
                      aspectLocked={Boolean(bundle.meta?.aspect)}
                      flash={flash}
                    />
                  );
                });
              })()}
            </div>
            <PreviewPlayer
              projectId={activeId}
              segments={bundle.timeline}
              voiceoverUrl={bundle.voiceover_url ?? null}
              subtitles={subtitles}
              aspect={bundle.meta?.aspect}
            />
            <RenderUploadBar
              projectId={activeId}
              projectMeta={bundle.meta}
              series={series.find((s) => s.id === activeSeriesId) ?? null}
              segments={bundle.timeline}
              tunnelUrl={tunnelUrl}
              tunnelOk={tunnelOk}
              aspect={bundle.meta?.aspect}
              subtitles={subtitles}
              onMetaPatched={(next) =>
                setBundle((prev) => (prev ? { ...prev, meta: next } : prev))
              }
              onSeriesPatched={(next) => {
                setSeries((prev) =>
                  prev.map((s) => (s.id === next.id ? next : s)),
                );
              }}
              flash={flash}
            />
            <AnalyticsPanel
              projectMeta={bundle.meta}
              tunnelUrl={tunnelUrl}
              tunnelOk={tunnelOk}
            />
          </>
        );
      })()}

      {!loading && (!bundle?.timeline || bundle.timeline.length === 0) && activeId && (
        <div style={styles.empty}>
          <p>No timeline yet. Paste a script above, pick a voice, and click{' '}
            <strong>Generate voiceover + timeline</strong>.</p>
        </div>
      )}

      {!activeId && !loading && (
        <div style={styles.empty}>
          <p>
            {hostedApiLocked
              ? 'No hosted backend is connected for public visitors. Run this harness locally with your own API keys, or connect your agent tunnel above.'
              : 'No projects yet. Create one above.'}
          </p>
        </div>
      )}

      {lightboxIndex !== null && bundle?.timeline && (
        <Lightbox
          projectId={activeId}
          segments={bundle.timeline}
          index={lightboxIndex}
          subtitles={subtitles}
          voiceoverUrl={bundle?.voiceover_url ?? null}
          onSubtitlesChange={updateSubtitles}
          onKenBurnsChange={(segId, next) => {
            // Optimistic local update first (Row UI + lightbox preview
            // re-render instantly), then PATCH the timeline so the change
            // survives refresh and gets picked up by the renderer.
            onKenBurnsChange(segId, next);
            void fetch(
              `/api/projects/${encodeURIComponent(activeId)}/timeline`,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ seg_id: segId, ken_burns: next }),
              },
            );
          }}
          onClose={() => setLightboxIndex(null)}
          onPrev={() =>
            setLightboxIndex((i) => (i !== null && i > 0 ? i - 1 : i))
          }
          onNext={() =>
            setLightboxIndex((i) => {
              if (i === null) return i;
              const max = (bundle.timeline?.length ?? 0) - 1;
              return i < max ? i + 1 : i;
            })
          }
        />
      )}
    </div>
  );
}

// Thumbnail popover for the mass-edit product picker. Mirrors the one in
// Row.tsx but renders left-anchored (opens below the Attach product button
// on the mass-edit bar).
function MassEditProductPopover({
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
    <div
      ref={wrapRef}
      style={{
        position: 'absolute',
        right: 0,
        top: 'calc(100% + 6px)',
        zIndex: 50,
        width: 300,
        maxWidth: 'calc(100vw - 24px)',
        background: '#0a0a0a',
        border: '1px solid #262626',
        borderRadius: 8,
        boxShadow: '0 14px 28px rgba(0,0,0,0.55)',
        padding: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: '#a3a3a3',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontWeight: 600,
        }}
      >
        Pick a product
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))',
          gap: 6,
          maxHeight: 260,
          overflowY: 'auto',
        }}
      >
        {products.map((p) => {
          const label = labelFor(p);
          const isCurrent = p.url === currentUrl;
          return (
            <button
              key={p.url}
              type="button"
              onClick={() => onPick(p.url, label)}
              style={{
                position: 'relative',
                background: isCurrent ? '#3d2e0f' : '#171717',
                border: `1px solid ${isCurrent ? '#f59e0b' : '#262626'}`,
                borderRadius: 6,
                padding: 4,
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                fontFamily: 'inherit',
              }}
              title={label}
            >
              <img
                src={p.url}
                alt=""
                style={{
                  width: '100%',
                  aspectRatio: '1 / 1',
                  objectFit: 'cover',
                  borderRadius: 4,
                  display: 'block',
                }}
              />
              <span
                style={{
                  fontSize: 10,
                  color: '#e5e5e5',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  textAlign: 'center',
                }}
              >
                {label}
              </span>
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: '#737373', lineHeight: 1.35 }}>
        After picking, write placement guidance below (e.g. "held in left hand, at chest height, cover facing camera") and click Apply.
      </div>
    </div>
  );
}

function InfoPopover({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        aria-label="More information"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        style={collapseStyles.info}
      >
        i
      </button>
      {open && (
        <div
          role="tooltip"
          onClick={(e) => e.stopPropagation()}
          style={collapseStyles.infoPop}
        >
          {text}
        </div>
      )}
    </span>
  );
}

function DenserFramesButton({
  projectId,
  currentSegments,
  flash,
  onDone,
}: {
  projectId: string;
  currentSegments: number;
  flash: (msg: string) => void;
  onDone: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/resegment`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      if (!r.ok) {
        flash(`Resegment failed: ${(await r.text()).slice(0, 160)}`);
        return;
      }
      const j = await r.json();
      flash(
        `Timeline → ${j.count} segments (was ${currentSegments}). Run Autofill, then regenerate frames.`,
      );
      setConfirming(false);
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={busy}
        title="Re-split the timeline on every comma, em-dash, and phrase pause. Clears per-segment prompts — run Autofill + Generate all missing afterwards."
        style={{
          background: 'transparent',
          color: '#f5f5f5',
          border: '1px solid #404040',
          borderRadius: 8,
          padding: '8px 14px',
          fontSize: 13,
          fontFamily: 'inherit',
          cursor: busy ? 'not-allowed' : 'pointer',
          opacity: busy ? 0.6 : 1,
        }}
      >
        🔪 Denser frames
      </button>
      {confirming && (
        <div
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) setConfirming(false); }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.72)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 200,
            padding: 16,
          }}
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              width: 'min(460px, 100%)',
              background: '#141418',
              border: '1px solid #2a2a30',
              borderRadius: 12,
              padding: '20px 22px',
              boxShadow: '0 24px 60px rgba(0,0,0,0.65)',
              color: '#f5f5f5',
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>
              Re-chunk the timeline?
            </div>
            <div style={{ fontSize: 13, color: '#a1a1aa', lineHeight: 1.5, marginBottom: 20 }}>
              We&apos;ll re-split {currentSegments} segments at every comma,
              em-dash, colon, semicolon, and pause so every concrete phrase
              gets its own frame. Voiceover + audio stay untouched.
              <br /><br />
              <strong>Per-segment prompts get cleared.</strong> Existing frame
              images are untouched but no longer line up — run Autofill, then
              Generate all missing, to refresh.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                style={{
                  background: 'transparent',
                  color: '#a1a1aa',
                  border: '1px solid #2a2a30',
                  borderRadius: 6,
                  padding: '8px 14px',
                  fontSize: 13,
                  fontFamily: 'inherit',
                  cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={run}
                disabled={busy}
                style={{
                  background: '#4f46e5',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: 6,
                  padding: '8px 14px',
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  cursor: busy ? 'not-allowed' : 'pointer',
                }}
              >
                {busy ? 'Re-chunking…' : 'Yes, re-chunk'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ConfirmRestart({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
        padding: 16,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 'min(440px, 100%)',
          background: '#141418',
          border: '1px solid #2a2a30',
          borderRadius: 12,
          boxShadow: '0 24px 60px rgba(0,0,0,0.65)',
          padding: '20px 22px',
          color: '#f5f5f5',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>
          Start a new AI run?
        </div>
        <div style={{ fontSize: 13, color: '#a1a1aa', lineHeight: 1.5, marginBottom: 20 }}>
          A draft from the previous run is still in memory. Starting a new AI
          generation will clear the current script, character roster, and
          progress. This doesn&apos;t touch any project already saved to Supabase.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              background: 'transparent',
              color: '#a1a1aa',
              border: '1px solid #2a2a30',
              borderRadius: 6,
              padding: '8px 14px',
              fontSize: 13,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            No, keep existing
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              background: '#dc2626',
              color: '#ffffff',
              border: 'none',
              borderRadius: 6,
              padding: '8px 14px',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            Yes, start over
          </button>
        </div>
      </div>
    </div>
  );
}

function Collapsible({
  title,
  summary,
  open,
  onToggle,
  info,
  children,
}: {
  title: string;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  info?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={collapseStyles.wrap}>
      <div style={collapseStyles.head}>
        <button
          onClick={onToggle}
          style={collapseStyles.headLeft}
          type="button"
        >
          <span style={collapseStyles.chev}>{open ? '▾' : '▸'}</span>
          <span style={collapseStyles.title}>{title}</span>
        </button>
        {info && <InfoPopover text={info} />}
        {summary && (
          <button
            onClick={onToggle}
            type="button"
            style={collapseStyles.summaryBtn}
          >
            {summary}
          </button>
        )}
      </div>
      {open && <div style={collapseStyles.body}>{children}</div>}
    </div>
  );
}

const collapseStyles: Record<string, React.CSSProperties> = {
  wrap: {},
  head: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 14px',
    minHeight: 44,
    background: '#171717',
    border: '1px solid #262626',
    borderRadius: 8,
    textAlign: 'left',
    color: '#f5f5f5',
    fontFamily: 'inherit',
    flexWrap: 'wrap',
    rowGap: 4,
  },
  headLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'transparent',
    border: 'none',
    padding: 0,
    margin: 0,
    color: 'inherit',
    fontFamily: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
  },
  chev: { color: '#a3a3a3', fontSize: 12, width: 14 },
  title: { fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 },
  info: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 18,
    height: 18,
    borderRadius: '50%',
    border: '1px solid #525252',
    background: '#0a0a0a',
    color: '#a3a3a3',
    fontSize: 11,
    fontStyle: 'italic',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: 'pointer',
    textTransform: 'none',
    letterSpacing: 0,
    lineHeight: 1,
    userSelect: 'none',
    padding: 0,
  },
  infoPop: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    left: '50%',
    transform: 'translateX(-50%)',
    minWidth: 240,
    maxWidth: 360,
    padding: '10px 12px',
    background: '#0a0a0a',
    border: '1px solid #404040',
    borderRadius: 8,
    color: '#e5e5e5',
    fontSize: 12,
    lineHeight: 1.5,
    textTransform: 'none',
    letterSpacing: 0,
    whiteSpace: 'normal',
    zIndex: 50,
    boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
    cursor: 'default',
    textAlign: 'left',
  },
  summary: { marginLeft: 'auto', color: '#a3a3a3', fontSize: 12 },
  summaryBtn: {
    marginLeft: 'auto',
    color: '#a3a3a3',
    fontSize: 12,
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  body: { marginTop: 4 },
};


const styles: Record<string, React.CSSProperties> = {
  page: {
    fontFamily: 'var(--font-plex-sans), system-ui, -apple-system, sans-serif',
    background: '#0a0a0a',
    color: '#f5f5f5',
    minHeight: '100vh',
    padding: '16px',
  },
  header: {
    background: 'rgba(10,10,10,0.98)',
    paddingBottom: 12,
    borderBottom: '1px solid #262626',
    marginBottom: 16,
  },
  appendBar: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 10,
    padding: '10px 12px',
    background: '#0a0a0a',
    border: '1px solid #262626',
    borderRadius: 8,
  },
  appendLabel: {
    fontSize: 11,
    color: '#a3a3a3',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontWeight: 600,
  },
  appendRow: { display: 'flex', gap: 8, alignItems: 'stretch', flexWrap: 'wrap' },
  appendInput: {
    flex: 1,
    minWidth: 200,
    padding: '8px 12px',
    background: '#171717',
    color: '#f5f5f5',
    border: '1px solid #404040',
    borderRadius: 6,
    fontSize: 13,
    outline: 'none',
  },
  appendInputMobile: {
    flex: '1 1 100%',
    minWidth: 0,
    width: '100%',
    padding: '10px 12px',
    fontSize: 14,
    minHeight: 44,
  },
  appendBtn: {
    padding: '8px 14px',
    background: '#1e3a5f',
    color: '#dbeafe',
    border: '1px solid #3b82f6',
    borderRadius: 6,
    fontSize: 13,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  appendBtnMobile: {
    flex: '1 1 100%',
    padding: '12px 14px',
    fontSize: 14,
    minHeight: 46,
  },
  appendStatus: { fontSize: 11, color: '#a3a3a3' },
  framesHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    rowGap: 8,
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  framesHeader: {
    fontSize: 13,
    fontWeight: 600,
    color: '#e5e5e5',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  framesCount: { color: '#a3a3a3', fontWeight: 400 },
  bulkBtn: {
    background: '#7c3aed',
    color: '#fff',
    border: '1px solid #6d28d9',
    borderRadius: 6,
    padding: '8px 16px',
    fontSize: 13,
    fontWeight: 600,
  },
  qaBtn: {
    background: '#0f2a4f',
    color: '#dbeafe',
    border: '1px solid #1e40af',
    borderRadius: 6,
    padding: '8px 14px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  bulkBtnMobile: {
    flex: '1 1 100%',
    padding: '12px 14px',
    fontSize: 14,
    minHeight: 46,
  },
  smallActionMobile: {
    flex: '1 1 auto',
    padding: '10px 14px',
    fontSize: 13,
    minHeight: 42,
  },
  bulkStatus: { fontSize: 12, color: '#a3a3a3' },
  bulkHint: { fontSize: 11, color: '#fbbf24' },
  clearSelBtn: {
    background: '#7f1d1d',
    color: '#fff',
    border: '1px solid #b91c1c',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  borderFixBtn: {
    background: '#78350f',
    color: '#fef3c7',
    border: '1px solid #f59e0b',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  clearAllBtn: {
    background: '#450a0a',
    color: '#fca5a5',
    border: '1px solid #7f1d1d',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  stopBtn: {
    background: '#b91c1c',
    color: '#fff',
    border: '1px solid #ef4444',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  titleRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
    marginBottom: 8,
  },
  title: { fontSize: 18, fontWeight: 600, margin: 0, letterSpacing: -0.3 },
  titleBtn: {
    background: 'transparent',
    border: 'none',
    color: '#f5f5f5',
    font: 'inherit',
    padding: 0,
    cursor: 'pointer',
    letterSpacing: 'inherit',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  },
  titlePencil: {
    fontSize: 12,
    color: '#737373',
    opacity: 0.6,
  },
  titleInput: {
    background: '#0a0a0a',
    color: '#f5f5f5',
    border: '1px solid #7c3aed',
    borderRadius: 5,
    padding: '2px 8px',
    font: 'inherit',
    fontWeight: 600,
    outline: 'none',
    minWidth: 200,
  },
  count: { color: '#a3a3a3', fontWeight: 400, fontSize: 13 },
  variantsChip: {
    marginLeft: 10,
    background: '#3d2e0f',
    color: '#fbbf24',
    border: '1px solid #b45309',
    borderRadius: 999,
    padding: '3px 10px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    verticalAlign: 'middle',
    whiteSpace: 'nowrap',
  },
  archiveBtn: {
    marginLeft: 10,
    background: '#171717',
    color: '#a3a3a3',
    border: '1px solid #404040',
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
    verticalAlign: 'middle',
    whiteSpace: 'nowrap',
  },
  archiveBtnActive: {
    color: '#fde68a',
    borderColor: '#b45309',
    background: '#3d2e0f',
  },
  archivedBadge: {
    marginLeft: 8,
    background: '#3d2e0f',
    color: '#fbbf24',
    border: '1px solid #b45309',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.5,
    verticalAlign: 'middle',
  },
  tunnel: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 },
  tunnelLabel: { color: '#a3a3a3' },
  dot: { width: 10, height: 10, borderRadius: '50%', display: 'inline-block' },
  tunnelInput: {
    background: '#171717',
    color: '#f5f5f5',
    border: '1px solid #404040',
    borderRadius: 4,
    padding: '4px 8px',
    fontSize: 12,
    width: 260,
  },
  aiButton: {
    background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
    color: '#ffffff',
    border: 'none',
    borderRadius: 8,
    padding: '10px 18px',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
    boxShadow: '0 4px 12px rgba(79, 70, 229, 0.35)',
  },
  aiButtonRunning: {
    background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
    color: '#ffffff',
    border: 'none',
    borderRadius: 8,
    padding: '10px 18px 10px 14px',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
    boxShadow: '0 4px 12px rgba(79, 70, 229, 0.35)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    opacity: 0.95,
  },
  aiSpinner: {
    display: 'inline-block',
    width: 12,
    height: 12,
    borderRadius: '50%',
    border: '2px solid rgba(255,255,255,0.35)',
    borderTopColor: '#ffffff',
    animation: 'wm-spin 0.8s linear infinite',
  },
  bar: {
    background: '#171717',
    border: '1px solid #262626',
    borderRadius: 8,
    padding: 12,
    marginTop: 10,
  },
  barHeader: { fontSize: 12, color: '#a3a3a3', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 },
  rows: { display: 'flex', flexDirection: 'column', gap: 10 },
  empty: { padding: 40, textAlign: 'center', color: '#a3a3a3' },
  loading: { padding: 40, textAlign: 'center', color: '#a3a3a3' },
  aspectGateBanner: {
    marginTop: 12,
    padding: '12px 16px',
    background: 'linear-gradient(90deg, #3d2e0f, #1f1a0a)',
    border: '1px solid #b45309',
    borderLeft: '4px solid #f59e0b',
    borderRadius: 8,
    fontSize: 13,
    color: '#fbbf24',
    lineHeight: 1.45,
    animation: 'wm-gate-pulse 2.6s ease-in-out infinite',
  },
  flash: {
    position: 'fixed',
    top: 12,
    right: 12,
    zIndex: 100,
    background: '#166534',
    color: '#f0fdf4',
    padding: '8px 14px',
    borderRadius: 6,
    fontSize: 13,
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
  },
  protBox: {
    height: 140,
    border: '2px dashed #525252',
    borderRadius: 8,
    backgroundSize: 'contain',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center',
    backgroundColor: '#0a0a0a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    outline: 'none',
  },
  protPlaceholder: { color: '#737373', fontSize: 13 },
};
