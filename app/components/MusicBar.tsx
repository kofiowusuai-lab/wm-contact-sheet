'use client';

// Project-level background-music control strip. Single switch, volume
// slider, current-track chip, Browse library button. Per-segment
// tick/untick lives on the row itself (same pattern CC uses).

import { useState } from 'react';
import { Library, Music2, X as XIcon } from 'lucide-react';
import type { BackgroundMusic } from '../lib/music';
import MusicLibraryModal, { type JamendoTrack } from './MusicLibraryModal';
import { useIsMobile } from '../lib/useMediaQuery';
import { Button, colors, radius, space, text } from './ui';

export default function MusicBar({
  value,
  onChange,
}: {
  value: BackgroundMusic;
  onChange: (next: BackgroundMusic) => void;
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const hasTrack = !!value.track_id;

  const setTrack = (t: JamendoTrack) => {
    onChange({
      ...value,
      enabled: true,
      track_id: t.track_id,
      title: t.title,
      artist: t.artist,
      audio_url: t.audio_url,
      duration: t.duration,
      license_note: `${t.title} by ${t.artist} — Jamendo`,
    });
    setOpen(false);
  };

  const clearTrack = () => {
    onChange({
      ...value,
      enabled: false,
      track_id: '',
      title: '',
      artist: '',
      audio_url: '',
      duration: 0,
      license_note: undefined,
      disabledIds: [],
    });
  };

  return (
    <div
      style={{
        background: colors.bg.raised,
        border: `1px solid ${colors.border.subtle}`,
        borderRadius: radius.lg,
        padding: space[5],
        marginTop: space[5],
        display: 'flex',
        flexDirection: 'column',
        gap: space[5],
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: space[5],
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: space[3],
            color: colors.text.secondary,
          }}
        >
          <Music2 size={14} strokeWidth={2} />
          <span style={{ ...text.eyebrow }}>Background music</span>
        </div>

        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: space[3],
            cursor: hasTrack ? 'pointer' : 'not-allowed',
            fontSize: 12,
            color: hasTrack ? colors.text.primary : colors.text.tertiary,
          }}
        >
          <input
            type="checkbox"
            checked={value.enabled && hasTrack}
            disabled={!hasTrack}
            onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
            style={{ accentColor: colors.accent.default }}
          />
          <span>
            {hasTrack ? (value.enabled ? 'Playing under voiceover' : 'Muted') : 'Pick a track first'}
          </span>
        </label>

        {hasTrack && (
          <>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                minWidth: 0,
                maxWidth: 280,
                flex: isMobile ? '1 1 100%' : '0 1 auto',
              }}
            >
              <div
                style={{
                  ...text.bodyStrong,
                  color: colors.text.primary,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {value.title || '(untitled)'}
              </div>
              <div
                style={{
                  ...text.caption,
                  color: colors.text.tertiary,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                by {value.artist || 'unknown'}
              </div>
            </div>

            <div style={{ display: 'inline-flex', alignItems: 'center', gap: space[3] }}>
              <span style={{ ...text.eyebrow, color: colors.text.tertiary }}>Vol</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={value.volume}
                onChange={(e) => onChange({ ...value, volume: Number(e.target.value) })}
                style={{ width: 120, accentColor: colors.accent.default }}
                title="Music sits under the voiceover — 20–30% is a good starting point."
              />
              <span
                style={{
                  ...text.caption,
                  color: colors.text.secondary,
                  fontVariantNumeric: 'tabular-nums',
                  minWidth: 38,
                  textAlign: 'right',
                }}
              >
                {Math.round(value.volume * 100)}%
              </span>
            </div>
          </>
        )}

        <div style={{ flex: 1 }} />
        <Button
          variant={hasTrack ? 'secondary' : 'primary'}
          leadingIcon={<Library size={14} strokeWidth={2} />}
          onClick={() => setOpen(true)}
        >
          {hasTrack ? 'Change track' : 'Browse library'}
        </Button>
        {hasTrack && (
          <Button
            variant="ghost"
            leadingIcon={<XIcon size={14} strokeWidth={2.5} />}
            onClick={clearTrack}
            title="Remove music from this episode"
          >
            Clear
          </Button>
        )}
      </div>

      {hasTrack && value.audio_url && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: space[2] }}>
          <audio
            key={value.audio_url}
            controls
            src={value.audio_url}
            style={{ width: '100%' }}
          />
          <div style={{ ...text.caption, color: colors.text.tertiary, fontStyle: 'italic' }}>
            Jamendo preview · tick or untick each row's 🎵 button to silence music on specific beats.
          </div>
        </div>
      )}

      <MusicLibraryModal
        open={open}
        onClose={() => setOpen(false)}
        onPick={setTrack}
        currentTrackId={value.track_id}
      />
    </div>
  );
}
