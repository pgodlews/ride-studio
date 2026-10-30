"""Read-only FIT decoding shared by activity and phone telemetry imports."""
from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone


def clean(value):
    """Retain unknown field/message numbers and serialize invalid values as null."""
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc).isoformat().replace('+00:00', 'Z') if value.tzinfo is None else value.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, dict):
        return {str(k): clean(v) for k, v in value.items()}
    if isinstance(value, (tuple, list)):
        return [clean(v) for v in value]
    return value


def _valid_zero_header_crc(raw: bytes) -> bool:
    """Validate 14-byte FIT files where optional header CRC is omitted (0x0000)."""
    if len(raw) < 16 or raw[0] != 14 or raw[8:12] != b'.FIT':
        return False
    if raw[12] != 0 or raw[13] != 0:
        return False
    data_size = int.from_bytes(raw[4:8], 'little')
    total_size = 14 + data_size
    if total_size + 2 > len(raw):
        return False
    from garmin_fit_sdk.crc_calculator import CrcCalculator
    file_crc = CrcCalculator.calculate_crc(raw[:total_size], 0, total_size)
    crc_from_file = int.from_bytes(raw[total_size:total_size + 2], 'little')
    return file_crc == crc_from_file


def read_fit(path):
    """Return strict decoded messages and evidence; never modify the input."""
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if path.suffix.lower() == '.fit':
        try:
            from garmin_fit_sdk import Decoder, Stream
        except ImportError as error:
            raise ValueError('Raw FIT import needs garmin-fit-sdk; install requirements.txt or supply decoded JSON') from error
        stream = Stream.from_byte_array(bytearray(raw))
        if not Decoder(stream).check_integrity() and not _valid_zero_header_crc(raw):
            raise ValueError('FIT integrity check failed')
        # The check consumes its stream: create a NEW stream and decoder.
        messages, errors = Decoder(Stream.from_byte_array(bytearray(raw))).read()
        if errors:
            raise ValueError(f'FIT decode errors: {errors}')
        integrity = 'passed'
    else:
        messages = json.loads(raw)
        integrity = 'not checked (decoded JSON input)'
    messages = clean(messages)
    if not isinstance(messages, dict) or not messages.get('record_mesgs'):
        raise ValueError('Input must contain FIT record messages (raw .fit or decoded JSON)')
    return messages, {'source': path.name, 'sha256': digest, 'bytes': len(raw), 'integrity': integrity}
