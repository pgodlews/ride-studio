"""Optional FIT sensors for phone clips, joined on approximate recording UTC."""
from __future__ import annotations

from prepare_dji import separation, utc
from prepare_ride import build_ride
from fit_activity import clean, read_fit  # retain the existing phone import API

SYNC_NOTICE = ('Approximate phone/FIT sync uses recording UTC + playback time. '
               'Clock offsets and sensor delays can affect alignment; independent clock rates '
               'may cause increasing drift on longer clips. Visual verification is optional.')


def synchronized_ride(messages, start, duration, ride_id, info, fit_evidence):
    ride = build_ride(messages, ride_id, fit_evidence['source'])
    return synchronize_projection(ride, start, duration, info, fit_evidence, 'fit')


def synchronize_projection(ride, start, duration, info, evidence, kind):
    """Join a prepared FIT/GPX projection without changing its recorded UTC axis."""
    label = kind.upper()
    clip_start = (start - utc(ride['startUtc'])).total_seconds()
    clip_end = clip_start + duration
    if clip_end < ride['t'][0] or clip_start > ride['t'][-1]:
        raise ValueError(f'Phone recording time does not overlap this {label}; choose the matching activity or supply --start-utc/--clock-correction-sec')
    notice = SYNC_NOTICE.replace('FIT', label)
    info[kind] = evidence
    info.update(synchronization={
        'mode': 'approximate-recording-time', 'clipStartRideSec': clip_start,
        'clipEndRideSec': clip_end, 'visualVerificationRequired': False,
        'notice': notice,
    })
    # All channels come from the selected activity. A static phone geotag never overwrites
    # the workout route, fills missing sensors, or generates speed/distance.
    ride['meta']['telemetry'] = info
    ride['meta']['channelSources'] = {c: source + '; approximate phone recording-time alignment'
                                      for c, source in ride['meta']['channelSources'].items()}
    ride['meta']['warnings'].append(notice)
    if clip_start < ride['t'][0] or clip_end > ride['t'][-1]:
        ride['meta']['warnings'].append(f'{label} only overlaps part of the phone clip; readings outside {label} coverage are missing')
    loc = info.get('clipLocation')
    if loc and 'lat' in ride['channels'] and 'lon' in ride['channels']:
        # Advisory comparison near the inferred start. Do not relocate the clip
        # to the nearest GPS match (repeat laps and geotag age are ambiguous).
        candidates = [i for i, t in enumerate(ride['t']) if abs(t - clip_start) <= 5
                      and ride['channels']['lat'][i] is not None and ride['channels']['lon'][i] is not None]
        if candidates:
            i = min(candidates, key=lambda i: abs(ride['t'][i] - clip_start))
            delta = separation(loc, {'lat': ride['channels']['lat'][i], 'lon': ride['channels']['lon'][i]})
            info['synchronization']['geotagSeparationM'] = round(delta, 1)
            if delta > max(100, (loc.get('horizontalAccuracyM') or 0) * 2):
                ride['meta']['warnings'].append(f'Clip geotag differs from {label} near the inferred start; location may be stale/inaccurate or the activity/clock may differ')
    return ride
