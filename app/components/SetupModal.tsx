'use client';

import { useState } from 'react';
import type { CSSProperties } from 'react';

type Props = {
  open: boolean;
  onConfigured: (tunnelUrl?: string) => void;
};

export default function SetupModal({ open, onConfigured }: Props) {
  const [falKey, setFalKey] = useState('');
  const [elevenKey, setElevenKey] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const [tunnelUrl, setTunnelUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const canSave = falKey.trim() && elevenKey.trim() && geminiKey.trim() && !saving;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/local/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          FAL_KEY: falKey.trim(),
          ELEVENLABS_API_KEY: elevenKey.trim(),
          GEMINI_API_KEY: geminiKey.trim(),
          WM_TUNNEL_URL: tunnelUrl.trim(),
        }),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(text.slice(0, 240));
      }
      onConfigured(tunnelUrl.trim() || undefined);
    } catch (e: any) {
      setError(String(e?.message || e).slice(0, 240));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={styles.backdrop}>
      <div style={styles.modal} role="dialog" aria-modal="true" aria-labelledby="setup-title">
        <div style={styles.kicker}>Local agent harness</div>
        <h2 id="setup-title" style={styles.title}>Connect your generation keys</h2>
        <p style={styles.copy}>
          These keys are written to your local `.env.local` file and stay on this machine.
          They are not sent to Casper's hosted backend.
        </p>

        <label style={styles.label}>
          FAL key
          <input
            type="password"
            value={falKey}
            onChange={(e) => setFalKey(e.target.value)}
            placeholder="fal..."
            style={styles.input}
            autoComplete="off"
          />
        </label>

        <label style={styles.label}>
          ElevenLabs API key
          <input
            type="password"
            value={elevenKey}
            onChange={(e) => setElevenKey(e.target.value)}
            placeholder="sk_..."
            style={styles.input}
            autoComplete="off"
          />
        </label>

        <label style={styles.label}>
          Gemini API key
          <input
            type="password"
            value={geminiKey}
            onChange={(e) => setGeminiKey(e.target.value)}
            placeholder="AIza..."
            style={styles.input}
            autoComplete="off"
          />
        </label>

        <label style={styles.label}>
          Agent tunnel URL
          <input
            type="url"
            value={tunnelUrl}
            onChange={(e) => setTunnelUrl(e.target.value)}
            placeholder="http://127.0.0.1:8765 or https://xxx.trycloudflare.com"
            style={styles.input}
            autoComplete="off"
          />
        </label>

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.actions}>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            style={{ ...styles.primary, ...(!canSave ? styles.disabled : null) }}
          >
            {saving ? 'Saving...' : 'Save local harness'}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0, 0, 0, 0.72)',
    padding: 16,
  },
  modal: {
    width: 'min(520px, 100%)',
    background: '#101010',
    border: '1px solid #2d2d2d',
    borderRadius: 8,
    padding: 22,
    color: '#f5f5f5',
    boxShadow: '0 24px 80px rgba(0,0,0,0.45)',
  },
  kicker: {
    color: '#22d3ee',
    fontSize: 12,
    fontWeight: 700,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  title: { margin: 0, fontSize: 22, lineHeight: 1.2 },
  copy: { color: '#b5b5b5', fontSize: 13, lineHeight: 1.5, margin: '10px 0 18px' },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    fontSize: 12,
    fontWeight: 700,
    color: '#d4d4d4',
    marginBottom: 12,
  },
  input: {
    background: '#171717',
    border: '1px solid #3f3f46',
    borderRadius: 6,
    color: '#f5f5f5',
    fontSize: 14,
    padding: '11px 12px',
    fontFamily: 'inherit',
  },
  error: {
    background: '#3b1111',
    border: '1px solid #7f1d1d',
    borderRadius: 6,
    color: '#fecaca',
    padding: 10,
    fontSize: 12,
    marginTop: 6,
  },
  actions: { display: 'flex', justifyContent: 'flex-end', marginTop: 18 },
  primary: {
    background: '#22d3ee',
    color: '#071013',
    border: 'none',
    borderRadius: 6,
    padding: '10px 14px',
    fontSize: 13,
    fontWeight: 800,
    cursor: 'pointer',
  },
  disabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
  },
};
