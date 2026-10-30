/**
 * Pin sync: scrub a video to a recognisable frame (or take a photo), click where it was
 * filmed on the activity's track, choose the pass when the route crosses itself, apply.
 * Sync is time-only: playback runs 1:1 with ride time from the pinned frame. Slow-motion
 * and timelapse clips do not run in real time and are not supported.
 */
import { useEffect, useRef, useState } from 'react';
import type { MediaInfo, PhotoFile } from '../core/project';
import type { Ride } from '../core/ride';
import type { UnitSystem } from '../core/units';
import { MapView } from './MapView';
import { rideClock } from './MediaPanel';

export type SyncTarget = { kind: 'video'; media: MediaInfo } | { kind: 'photo'; clipId: string; photo: PhotoFile | undefined; label: string; rideT: number };

export function SyncView({ ride, units, target, onPinVideo, onPinPhoto, onClose }: {
  ride: Ride; units: UnitSystem; target: SyncTarget;
  onPinVideo: (startUtc: string, device: boolean) => Promise<void>;
  onPinPhoto: (rideT: number) => void;
  onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [playback, setPlayback] = useState(0);
  const [candidates, setCandidates] = useState<number[]>([]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [device, setDevice] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const media = target.kind === 'video' ? target.media : null;
  useEffect(() => { setCandidates([]); setChosen(null); setFailure(''); }, [media?.id, target.kind === 'photo' ? target.clipId : '']);

  // Where the current frame sits on the track with the clip's present placement.
  const placedT = media?.startUtc ? (Date.parse(media.startUtc) - ride.startMs) / 1000 + playback
    : target.kind === 'photo' ? target.rideT : NaN;
  // The camera clock (if any) suggests which pass of a looped route is meant.
  const clockT = media?.recordedUtc ? (Date.parse(media.recordedUtc) - ride.startMs) / 1000 + playback : NaN;

  const closestToClock = Number.isFinite(clockT) && candidates.length > 1
    ? candidates.reduce((a, b) => (Math.abs(b - clockT) < Math.abs(a - clockT) ? b : a)) : null;
  const onPin = (times: number[]) => {
    setCandidates(times);
    const ref = Number.isFinite(clockT) ? clockT : placedT;
    setChosen(times.length === 1 || !Number.isFinite(ref) ? times[0] : times.reduce((a, b) => (Math.abs(b - ref) < Math.abs(a - ref) ? b : a)));
  };
  const apply = async () => {
    if (chosen === null) return;
    if (!media) return onPinPhoto(chosen);
    setBusy(true);
    setFailure('');
    try {
      await onPinVideo(new Date(ride.startMs + (chosen - playback) * 1000).toISOString(), device && !!media.device && !!media.recordedUtc);
    } catch (e) { setFailure((e as Error).message); }
    finally { setBusy(false); }
  };
  const step = (d: number) => {
    const v = video.current;
    if (v) v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + d));
  };

  return (
    <div className="sync-view">
      <div className="sync-side">
        <div className="sync-head">
          <strong>{media ? media.label : target.kind === 'photo' ? target.label : ''}</strong>
          <button className="link" onClick={onClose}>Close</button>
        </div>
        {media ? <>
          <video ref={video} src={`/media/front/${media.preview?.name ?? media.name}`} controls playsInline preload="auto"
            onTimeUpdate={(e) => setPlayback(e.currentTarget.currentTime)} onSeeked={(e) => setPlayback(e.currentTarget.currentTime)} />
          <span className="nudge">Frame <output>{playback.toFixed(2)} s</output>
            {[-1, -0.1, 0.1, 1].map((d) => <button key={d} onClick={() => step(d)}>{d > 0 ? `+${d}` : d}s</button>)}
          </span>
          <ol className="sync-steps">
            <li>Scrub to a frame you can locate: a junction, bridge, gate or summit.</li>
            <li>Click that spot on the track. Zoom in for precision.</li>
            <li>Apply, then check the HUD in the preview and nudge if needed.</li>
          </ol>
        </> : target.kind === 'photo' && target.photo ? <>
          <img className="sync-photo" src={`/photos/${target.photo.id}.png`} alt={target.label} />
          <p className="hint">Click where this photo was taken. The HUD holds the readings at that moment.</p>
        </> : <p className="warn">This photo is unavailable.</p>}
        {candidates.length > 1 && (
          <div className="passes">
            <span>The route passes here {candidates.length} times:</span>
            {candidates.map((t, n) => (
              <label key={t} className="check">
                <input type="radio" name="pass" checked={chosen === t} onChange={() => setChosen(t)} />
                {`${n + 1}. ${rideClock(ride, t)}`}{t === closestToClock ? ' · closest to camera clock' : ''}
              </label>
            ))}
          </div>
        )}
        {chosen !== null && <p className="hint">{media ? `This frame = ${rideClock(ride, chosen)} on the activity.` : `Ride time ${rideClock(ride, chosen)}.`}</p>}
        {media?.device && media.recordedUtc && (
          <label className="check"><input type="checkbox" checked={device} onChange={(e) => setDevice(e.target.checked)} /> Also place other clips from {media.device}</label>
        )}
        {failure && <p role="alert" className="warn">{failure}</p>}
        <button className="primary" disabled={chosen === null || busy} onClick={() => void apply()}>{busy ? 'Saving…' : 'Apply pin'}</button>
      </div>
      <MapView ride={ride} units={units} privacyTrim={0} moments={[]} clips={[]} playheadT={placedT}
        selection={{ a: null, b: null }} onSelection={() => {}} onMoment={() => {}}
        pin={{ candidates, chosen, onPin }} />
    </div>
  );
}
