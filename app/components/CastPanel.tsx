'use client';

// Multi-voice Cast panel.
//
// Shows the narrator's voice (mirrors the main VoicePicker) plus one row
// per named character the writer has referenced in the script via
// `@CHARACTER:` tags. Each row has a voice picker bound to the same
// library the main VoicePicker uses. Unmet casts are flagged — the
// Generate flow is still allowed to fire, but the tunnel will render
// their lines in the narrator voice and report `missing_characters`
// back so the user knows what landed in the wrong voice.
//
// Cast state lives in Supabase at `projects/{episode_id}/cast.json`.
// This component writes on every edit (debounced) so the tunnel reads
// the fresh cast on any subsequent Generate.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CastDoc, CastEntry } from '../lib/blob';
import { Button, Card, Select, colors, radius, space, text } from './ui';
import { UserRound, Mic2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useIsMobile } from '../lib/useMediaQuery';

type Voice = { voice_id: string; name: string; preview_url?: string };

export default function CastPanel({
  projectId,
  voices,
  narratorVoiceId,
  narratorVoiceName,
  speakersInScript,
  initialCast,
  flash,
}: {
  projectId: string;
  /** Account's available voices — same list the narrator picker uses. */
  voices: Voice[];
  /** Current narrator voice (from meta.voice_id). Falls back if the
   *  cast.json narrator slot is null. */
  narratorVoiceId: string;
  narratorVoiceName: string;
  /** Unique uppercased speaker names parsed from the live script
   *  textarea (via `speakersUsed(script)` in parseSpeakerTags.ts). */
  speakersInScript: string[];
  /** Cast doc supplied inline by the project bundle. Preferred over a
   *  separate fetch so a transient /api/projects/{id}/cast failure doesn't
   *  blank the whole panel (the root cause of "voices disappeared on
   *  refresh"). */
  initialCast?: CastDoc | null;
  flash: (msg: string) => void;
}) {
  const [cast, setCast] = useState<CastDoc | null>(initialCast ?? null);
  const [loading, setLoading] = useState(!initialCast);
  const [loadError, setLoadError] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const isMobile = useIsMobile();

  // If the bundle supplied cast, adopt it whenever the project switches.
  useEffect(() => {
    if (initialCast !== undefined) {
      setCast(initialCast ?? { narrator: null, characters: {}, updated_at: '' });
      setLoading(false);
      setLoadError(null);
    }
  }, [projectId, initialCast]);

  // Load cast on mount / project switch — ONLY as a fallback when the bundle
  // didn't include it (e.g. older API version, cached page). Retries up to
  // 3x on failure and surfaces a visible error instead of silently zeroing.
  useEffect(() => {
    if (!projectId) return;
    if (initialCast !== undefined) return; // bundle already provided it
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      let lastErr: string | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/cast`, {
            cache: 'no-store',
            credentials: 'same-origin',
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const doc = (await r.json()) as CastDoc;
          if (!cancelled) {
            setCast(doc);
            setLoadError(null);
          }
          setLoading(false);
          return;
        } catch (e: any) {
          lastErr = String(e?.message || e);
          console.warn(`[cast] load attempt ${attempt} failed: ${lastErr}`);
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 500 * attempt));
          }
        }
      }
      if (!cancelled) {
        // Preserve any previous cast so voices don't disappear on a transient
        // failure. Surface the error so the user knows something's off.
        setLoadError(`Could not load cast (${lastErr}). Retry or check the network.`);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, initialCast]);

  // Ensure every speaker the script references has a slot (even if empty).
  // Writers reference a character, the slot appears, they pick a voice.
  useEffect(() => {
    if (!cast) return;
    const currentKeys = new Set(Object.keys(cast.characters));
    let dirty = false;
    const next = { ...cast.characters };
    for (const s of speakersInScript) {
      if (!currentKeys.has(s)) {
        next[s] = null;
        dirty = true;
      }
    }
    if (dirty) {
      setCast({ ...cast, characters: next });
      // do NOT persist auto-created empty slots — wait for the user to
      // pick a voice; otherwise abandoned @tags pollute cast.json.
    }
  }, [speakersInScript, cast]);

  const persist = useCallback(
    (next: CastDoc) => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(async () => {
        try {
          await fetch(`/api/projects/${encodeURIComponent(projectId)}/cast`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(next),
          });
        } catch (e: any) {
          flash(`Cast save failed: ${String(e?.message || e).slice(0, 120)}`);
        }
      }, 400);
    },
    [projectId, flash],
  );

  const setCharacterVoice = (name: string, voice_id: string) => {
    if (!cast) return;
    const entry: CastEntry | null = voice_id
      ? {
          voice_id,
          voice_name: voices.find((v) => v.voice_id === voice_id)?.name || voice_id,
        }
      : null;
    const next: CastDoc = {
      ...cast,
      characters: { ...cast.characters, [name]: entry },
    };
    setCast(next);
    persist(next);
  };

  // Derived counts for the header chip
  const characterSlots = useMemo(() => {
    if (!cast) return [];
    // Merge "slots that exist in cast.json" + "speakers referenced in the
    // live script" so the panel shows everything the user needs to cast.
    const names = new Set<string>([
      ...Object.keys(cast.characters),
      ...speakersInScript,
    ]);
    return Array.from(names).sort();
  }, [cast, speakersInScript]);

  const missing = characterSlots.filter(
    (n) => !cast?.characters[n]?.voice_id,
  );
  const cast_count = characterSlots.length - missing.length;

  if (loading) {
    return (
      <Card padded={false} style={{ marginTop: space[4] }}>
        <div style={{ padding: space[5], color: colors.text.tertiary, ...text.caption }}>
          Loading cast…
        </div>
      </Card>
    );
  }

  return (
    <Card padded={false} style={{ marginTop: space[4] }}>
      {loadError && (
        <div
          style={{
            padding: `${space[3]}px ${space[5]}px`,
            background: colors.warn.soft,
            color: colors.warn.text,
            borderBottom: `1px solid ${colors.border.subtle}`,
            ...text.caption,
            display: 'flex',
            alignItems: 'center',
            gap: space[2],
          }}
        >
          <AlertTriangle size={12} /> {loadError}
        </div>
      )}
      <div
        style={{
          padding: `${space[4]}px ${space[5]}px`,
          borderBottom: `1px solid ${colors.border.subtle}`,
          display: 'flex',
          alignItems: 'center',
          gap: space[4],
          background: colors.bg.elevated,
          flexWrap: 'wrap',
        }}
      >
        <UserRound size={14} color={colors.text.secondary} />
        <span style={{ ...text.eyebrow, color: colors.text.secondary }}>Cast</span>
        <div style={{ flex: 1 }} />
        {characterSlots.length === 0 ? (
          <span style={{ ...text.caption, color: colors.text.tertiary }}>
            No speaker tags in script (everything uses narrator)
          </span>
        ) : missing.length === 0 ? (
          <span
            style={{
              ...text.caption,
              color: colors.success.text,
              display: 'inline-flex',
              alignItems: 'center',
              gap: space[2],
            }}
          >
            <CheckCircle2 size={12} /> {cast_count} cast · ready
          </span>
        ) : (
          <span
            style={{
              ...text.caption,
              color: colors.warn.text,
              display: 'inline-flex',
              alignItems: 'center',
              gap: space[2],
            }}
            title={missing.join(', ')}
          >
            <AlertTriangle size={12} /> {cast_count} cast · {missing.length} missing
          </span>
        )}
      </div>

      <div style={{ padding: space[5], display: 'flex', flexDirection: 'column', gap: space[3] }}>
        {/* Narrator row — shows the current narrator voice as a read-only
            reminder that untagged lines use this voice. Editing happens
            through the main voice picker above. */}
        <div style={{ ...castRowStyle, ...(isMobile ? castRowMobileStyle : null) }}>
          <div style={{ ...castLabelStyle, ...(isMobile ? castLabelMobileStyle : null) }}>
            <Mic2 size={12} color={colors.text.tertiary} />
            <span style={{ ...text.bodyStrong, color: colors.text.primary }}>NARRATOR</span>
          </div>
          <div style={{ flex: 1, color: colors.text.secondary, fontSize: 12, minWidth: 0 }}>
            {narratorVoiceId
              ? `${narratorVoiceName || narratorVoiceId}`
              : '(no narrator voice picked — use the NARRATOR VOICE picker above)'}
          </div>
          <span
            style={{
              ...text.caption,
              color: narratorVoiceId ? colors.success.text : colors.text.tertiary,
            }}
          >
            {narratorVoiceId ? 'linked to meta.voice_id' : 'unset'}
          </span>
        </div>

        {characterSlots.length === 0 ? null : (
          characterSlots.map((name) => {
            const entry = cast?.characters[name] ?? null;
            const inScript = speakersInScript.includes(name);
            return (
              <div key={name} style={{ ...castRowStyle, ...(isMobile ? castRowMobileStyle : null) }}>
                <div style={{ ...castLabelStyle, ...(isMobile ? castLabelMobileStyle : null) }}>
                  <UserRound size={12} color={colors.text.tertiary} />
                  <span style={{ ...text.bodyStrong, color: colors.text.primary }}>
                    @{name}
                  </span>
                  {!inScript && (
                    <span
                      style={{
                        ...text.caption,
                        color: colors.text.tertiary,
                        fontStyle: 'italic',
                      }}
                    >
                      not in current script
                    </span>
                  )}
                </div>
                <Select
                  value={entry?.voice_id || ''}
                  onChange={(e) => setCharacterVoice(name, e.target.value)}
                  style={isMobile
                    ? { width: '100%', fontSize: 16, minHeight: 44 }
                    : { minWidth: 220 }}
                >
                  <option value="">pick a voice…</option>
                  {voices.map((v) => (
                    <option key={v.voice_id} value={v.voice_id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
                {entry?.voice_id ? (
                  <span style={{ ...text.caption, color: colors.success.text }}>✓</span>
                ) : (
                  <span
                    style={{
                      ...text.caption,
                      color: colors.warn.text,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: space[1],
                    }}
                  >
                    <AlertTriangle size={10} /> missing
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}

const castRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: space[4],
  padding: `${space[3]}px ${space[4]}px`,
  background: colors.bg.sunken,
  border: `1px solid ${colors.border.subtle}`,
  borderRadius: radius.md,
};

const castRowMobileStyle: React.CSSProperties = {
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: space[3],
};

const castLabelStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: space[3],
  minWidth: 160,
};

const castLabelMobileStyle: React.CSSProperties = {
  minWidth: 0,
  flexWrap: 'wrap',
};
