'use client';

// Series + Episode navigator. File name kept as ProjectBar to avoid
// churning every import; visually it's a two-dropdown selector wrapped
// in a single Card, with a uniform button tier.
//
// Left dropdown picks a Series; right dropdown picks an Episode within
// that series. Inline form for creating either slides in next to the
// dropdowns — still one row on desktop, stacks cleanly on mobile.

import { useState } from 'react';
import { Plus, X as XIcon, Trash2 } from 'lucide-react';
import type { ProjectMeta, SeriesMeta } from '../lib/blob';
import { useIsMobile } from '../lib/useMediaQuery';
import { Button, Input, Select, Card, colors, space, text, radius } from './ui';

export default function ProjectBar({
  series,
  episodes,
  activeSeriesId,
  activeEpisodeId,
  onSwitchSeries,
  onSwitchEpisode,
  onCreateSeries,
  onCreateEpisode,
  onDeleteSeries,
  showArchived = false,
  onToggleShowArchived,
}: {
  series: SeriesMeta[];
  episodes: ProjectMeta[];
  activeSeriesId: string;
  activeEpisodeId: string;
  onSwitchSeries: (id: string) => void;
  onSwitchEpisode: (id: string) => void;
  onCreateSeries: (title: string) => void | Promise<void>;
  onCreateEpisode: (title: string) => void | Promise<void>;
  /** Delete the currently-active series AND every episode under it. The
   *  parent is responsible for confirming the destructive action beyond
   *  the inline warning; we only surface it after a two-click guard
   *  (typing the series title) to avoid accidents. */
  onDeleteSeries?: (id: string) => void | Promise<void>;
  /** When false (default), archived episodes are filtered out of the
   *  dropdown and the "N archived" toggle shows the count. Flipping to
   *  true renders every episode, appending a 📦 tag to archived ones. */
  showArchived?: boolean;
  onToggleShowArchived?: (next: boolean) => void;
}) {
  const [mode, setMode] = useState<null | 'series' | 'episode'>(null);
  const [title, setTitle] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const isMobile = useIsMobile();

  const hasSeries = series.length > 0;
  const hasActiveSeries = !!activeSeriesId;
  // Always compute the archived count from the full list so the toggle
  // label reflects reality even when filtered. Visible list depends on
  // showArchived.
  const archivedCount = episodes.filter((e) => e.archived_at).length;
  const visibleEpisodes = showArchived
    ? episodes
    : episodes.filter((e) => !e.archived_at);
  const emptySeries = hasActiveSeries && visibleEpisodes.length === 0;

  const handleCreate = async () => {
    const t = title.trim();
    if (!t) return;
    if (mode === 'series') await onCreateSeries(t);
    else if (mode === 'episode') await onCreateEpisode(t);
    setTitle('');
    setMode(null);
  };

  return (
    <Card
      padded={false}
      style={{ marginTop: space[5] }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: isMobile ? 'stretch' : 'flex-end',
          flexDirection: isMobile ? 'column' : 'row',
          gap: space[6],
          padding: space[6],
        }}
      >
        <FieldGroup label="Series">
          <div style={{ display: 'flex', gap: space[2], alignItems: 'center' }}>
            <Select
              value={activeSeriesId}
              onChange={(e) => onSwitchSeries(e.target.value)}
              disabled={!hasSeries}
              style={{ minWidth: isMobile ? '100%' : 220, flex: 1 }}
            >
              {!hasSeries && <option value="">(none yet)</option>}
              {series.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </Select>
            {onDeleteSeries && hasActiveSeries && (
              <button
                type="button"
                onClick={() => {
                  setConfirmingDelete(true);
                  setDeleteConfirmText('');
                }}
                aria-label="Delete series"
                title="Delete this series and every episode under it"
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: radius.md,
                  background: 'transparent',
                  border: `1px solid ${colors.border.default}`,
                  color: colors.danger.text,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <Trash2 size={15} strokeWidth={2} />
              </button>
            )}
          </div>
        </FieldGroup>

        <FieldGroup label="Episode">
          <Select
            value={activeEpisodeId}
            onChange={(e) => onSwitchEpisode(e.target.value)}
            disabled={!hasActiveSeries || visibleEpisodes.length === 0}
            style={{ minWidth: isMobile ? '100%' : 260 }}
          >
            {!hasActiveSeries && <option value="">(pick a series first)</option>}
            {emptySeries && <option value="">(no episodes yet)</option>}
            {visibleEpisodes.map((e, i) => (
              <option key={e.id} value={e.id}>
                {(e.episode_number ?? i + 1).toString().padStart(2, '0')} · {e.title}
                {e.archived_at ? ' · 📦' : ''}
              </option>
            ))}
          </Select>
          {onToggleShowArchived && archivedCount > 0 && (
            <label
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                marginTop: 4,
                fontSize: 11,
                color: showArchived ? '#fde68a' : '#737373',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => onToggleShowArchived(e.target.checked)}
                style={{ margin: 0, cursor: 'pointer' }}
              />
              <span>
                📦 Show archived ({archivedCount})
              </span>
            </label>
          )}
        </FieldGroup>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: space[4],
            flexWrap: 'wrap',
            marginLeft: isMobile ? 0 : 'auto',
          }}
        >
          {mode === null ? (
            <>
              <Button
                variant="secondary"
                size="md"
                leadingIcon={<Plus size={14} strokeWidth={2.5} />}
                onClick={() => setMode('series')}
              >
                New series
              </Button>
              <Button
                variant={emptySeries ? 'primary' : 'secondary'}
                size="md"
                leadingIcon={<Plus size={14} strokeWidth={2.5} />}
                onClick={() => setMode('episode')}
                disabled={!hasActiveSeries}
                title={
                  hasActiveSeries
                    ? 'Add an episode to the selected series'
                    : 'Pick a series first'
                }
              >
                New episode
              </Button>
            </>
          ) : (
            <>
              <Input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                  if (e.key === 'Escape') {
                    setMode(null);
                    setTitle('');
                  }
                }}
                placeholder={
                  mode === 'series'
                    ? 'Series title (e.g. Survival Stories)'
                    : 'Episode title (e.g. Pilot)'
                }
                style={isMobile
                  ? { width: '100%', minWidth: 0, fontSize: 16 }
                  : { minWidth: 260 }}
              />
              <Button variant="primary" onClick={handleCreate}>
                Create {mode}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setMode(null);
                  setTitle('');
                }}
                leadingIcon={<XIcon size={14} strokeWidth={2.5} />}
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>

      {confirmingDelete && hasActiveSeries && onDeleteSeries && (() => {
        const active = series.find((s) => s.id === activeSeriesId);
        const epCount = episodes.length;
        const expectedTitle = (active?.title || '').trim();
        const canConfirm =
          deleteConfirmText.trim().toLowerCase() === expectedTitle.toLowerCase()
          && !deleting;
        const close = () => {
          setConfirmingDelete(false);
          setDeleteConfirmText('');
        };
        return (
          <div
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) close();
            }}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0, 0, 0, 0.72)',
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
                background: colors.bg.raised,
                border: `1px solid ${colors.border.default}`,
                borderRadius: 12,
                padding: `${space[6]}px ${space[7]}px`,
                boxShadow: '0 24px 60px rgba(0,0,0,0.65)',
              }}
            >
              <div style={{ ...text.h3, color: colors.text.primary, marginBottom: space[3] }}>
                Delete &ldquo;{expectedTitle}&rdquo;?
              </div>
              <div style={{ ...text.body, color: colors.text.secondary, marginBottom: space[5], lineHeight: 1.5 }}>
                This removes the series <strong>and every episode under it</strong>
                {epCount > 0 ? ` (${epCount} episode${epCount === 1 ? '' : 's'})` : ''}.
                Every frame, voiceover, timeline, and prompt for those episodes is
                deleted from storage. This can&apos;t be undone.
              </div>
              <div style={{ ...text.caption, color: colors.text.tertiary, marginBottom: space[3] }}>
                Type <strong>{expectedTitle}</strong> to confirm:
              </div>
              <Input
                autoFocus
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') close();
                }}
                placeholder={expectedTitle}
                style={{ width: '100%', marginBottom: space[5] }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: space[3] }}>
                <Button variant="ghost" onClick={close} disabled={deleting}>
                  Cancel
                </Button>
                <button
                  type="button"
                  onClick={async () => {
                    if (!canConfirm) return;
                    setDeleting(true);
                    try {
                      await onDeleteSeries(activeSeriesId);
                      close();
                    } finally {
                      setDeleting(false);
                    }
                  }}
                  disabled={!canConfirm}
                  style={{
                    background: canConfirm ? colors.danger.default : colors.bg.elevated,
                    color: canConfirm ? '#ffffff' : colors.text.disabled,
                    border: 'none',
                    borderRadius: radius.md,
                    padding: '10px 18px',
                    fontSize: text.body.fontSize,
                    fontWeight: 600,
                    fontFamily: 'inherit',
                    cursor: canConfirm ? 'pointer' : 'not-allowed',
                  }}
                >
                  {deleting
                    ? 'Deleting…'
                    : epCount > 0
                      ? `Yes, delete ${epCount} episode${epCount === 1 ? '' : 's'} + series`
                      : 'Yes, delete series'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </Card>
  );
}

function FieldGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space[2], minWidth: 0 }}>
      <span
        style={{
          ...text.eyebrow,
          color: colors.text.tertiary,
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}
