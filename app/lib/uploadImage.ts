// Read a File or a ClipboardItem into a data URL and ship it to FAL storage
// via /api/upload-protagonist (which already handles the two-step FAL PUT).
// Returns the hosted URL, or null on failure.

export async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export async function uploadDataUrlToFal(
  dataUrl: string,
  projectId?: string | null,
): Promise<string | null> {
  const r = await fetch('/api/upload-protagonist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data_url: dataUrl, project_id: projectId || undefined }),
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j?.url ?? null;
}

export async function uploadFileToFal(file: File, projectId?: string | null): Promise<string | null> {
  try {
    const dataUrl = await fileToDataUrl(file);
    return uploadDataUrlToFal(dataUrl, projectId);
  } catch {
    return null;
  }
}

/** Extract all image items from a clipboard paste event as Files. */
export function pasteEventImages(e: React.ClipboardEvent | ClipboardEvent): File[] {
  const out: File[] = [];
  const items = (e as any).clipboardData?.items;
  if (!items) return out;
  for (const item of Array.from(items as DataTransferItem[])) {
    if (item.type && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}
