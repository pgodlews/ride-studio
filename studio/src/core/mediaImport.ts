/** Match a DJI sidecar within one dropped/selected group, regardless of case. */
export function pairedSidecar(files: File[], video: File): File | undefined {
  const stem = video.name.replace(/\.[^.]+$/, '').toLowerCase();
  const matches = files.filter((f) => /\.srt$/i.test(f.name) && f.name.replace(/\.[^.]+$/, '').toLowerCase() === stem);
  if (matches.length > 1) throw new Error(`${video.name}: select only one matching SRT sidecar`);
  return matches[0];
}

export async function uploadSidecar(file: File | undefined): Promise<string> {
  if (!file) return '';
  const r = await fetch(`/api/camera-sidecars?name=${encodeURIComponent(file.name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error ?? `${file.name}: sidecar import failed`);
  return `&sidecar=${encodeURIComponent(result.id)}`;
}
