import { useEffect, useRef, useState } from 'react';
import { photoRideTime, photoUrl, type PhotoFile } from '../core/project';
import type { Ride } from '../core/ride';

export function usePhotos(rideId: string) {
  const [photos, setPhotos] = useState<PhotoFile[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setPhotos([]);
    setError('');
    fetch(`/api/photos?rideId=${encodeURIComponent(rideId)}`).then(async (r) => {
      const result = await r.json();
      if (!r.ok) throw new Error(result.error ?? 'Could not load photos');
      if (active) setPhotos(result.photos);
    }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [rideId]);
  return { photos, error, imported: (photo: PhotoFile) => setPhotos((current) => [...current, photo]) };
}

export function PhotosPanel({ ride, photos, error, onImported, onAdd, onPreview }: {
  ride: Ride; photos: PhotoFile[]; error: string;
  onImported: (photo: PhotoFile) => void;
  onAdd: (photo: PhotoFile) => void;
  onPreview: (photo: PhotoFile) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const upload = async (file: File) => {
    setBusy(true);
    setFailure('');
    try {
      const response = await fetch(`/api/photos?rideId=${encodeURIComponent(ride.id)}&name=${encodeURIComponent(file.name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Photo import failed');
      onImported(result);
    } catch (e) { setFailure((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="photos-panel">
    <h3>Photos <button className="small" disabled={busy} onClick={() => picker.current?.click()}>{busy ? 'Importing…' : 'Import photo…'}</button></h3>
    <input ref={picker} type="file" accept=".jpg,.jpeg,.png,.webp,.tif,.tiff,.heic,.heif" hidden onChange={(e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (file) void upload(file);
    }} />
    {(error || failure) && <p role="alert" className="warn">{failure || error}</p>}
    {!photos.length && <p className="hint">Import a still with optional EXIF GPS. Add it to the timeline, then set its display duration.</p>}
    {photos.map((photo) => {
      const time = photoRideTime(photo, ride.startMs, ride.duration);
      return <div className="photo-card" key={photo.id}>
        <button className="photo-preview" onClick={() => onPreview(photo)} title="Preview photo"><img src={photoUrl(photo)} alt={photo.label} /></button>
        <div>
          <strong>{photo.label}</strong>
          <span>{photo.gps ? `GPS ${photo.gps.lat.toFixed(6)}, ${photo.gps.lon.toFixed(6)}${photo.gps.altitude === null ? '' : ` · ${photo.gps.altitude.toFixed(1)} m`}` : 'No EXIF GPS'}</span>
          <span>{time === null ? 'Choose ride time in the clip inspector' : `Capture: ride ${time.toFixed(1)} s (approximate)`}</span>
          <button className="small" onClick={() => onAdd(photo)}>+ Add to timeline</button>
        </div>
      </div>;
    })}
  </section>;
}
