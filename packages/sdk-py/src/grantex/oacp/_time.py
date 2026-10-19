"""Strict RFC 3339 timestamps and millisecond clocks for OACP verification."""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any, Optional

__all__ = ["epoch_millis", "parse_oacp_timestamp"]

_RFC3339 = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})"
    r"(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})",
    re.ASCII,
)
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _is_leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def _days_in_month(year: int, month: int) -> int:
    if month == 2:
        return 29 if _is_leap(year) else 28
    return 30 if month in (4, 6, 9, 11) else 31


def _days_from_civil(year: int, month: int, day: int) -> int:
    """Days since 1970-01-01 in the proleptic Gregorian calendar (year 0 included)."""
    year -= 1 if month <= 2 else 0
    era = (year if year >= 0 else year - 399) // 400
    yoe = year - era * 400
    doy = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + day - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def parse_oacp_timestamp(value: Any) -> Optional[int]:
    """Milliseconds since the epoch for an RFC 3339 date-time, or ``None``.

    The grammar is exactly the TypeScript SDK's ``parseOacpTimestamp``: a
    ``T`` separator, two-digit fields, at most nine fractional digits
    (truncated to milliseconds), and ``Z`` or a numeric offset. No leap
    seconds, no lower-case ``t``/``z``, no missing offset.
    """
    if not isinstance(value, str):
        return None
    match = _RFC3339.fullmatch(value)
    if match is None:
        return None
    y, mo, d, h, mi, s, frac, zone = match.groups()
    year, month, day = int(y), int(mo), int(d)
    hour, minute, second = int(h), int(mi), int(s)
    if month < 1 or month > 12 or day < 1 or day > 31 or hour > 23 or minute > 59 or second > 59:
        return None
    # Date.UTC reads a year from 0 to 99 as 1900 to 1999; the TypeScript and
    # Go SDKs keep that, so this one does too.
    if year <= 99:
        year += 1900
    if day > _days_in_month(year, month):
        return None
    millis = (_days_from_civil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second) * 1000
    if frac:
        # The same IEEE-754 arithmetic as the TypeScript SDK, so both truncate alike.
        millis += math.floor(float("0" + frac) * 1000)
    if zone != "Z":
        sign = -1 if zone.startswith("-") else 1
        zh, zm = int(zone[1:3]), int(zone[4:6])
        if zh > 23 or zm > 59:
            return None
        millis -= sign * (zh * 60 + zm) * 60_000
    return millis


def epoch_millis(moment: datetime) -> int:
    """Whole milliseconds since the epoch, floored; a naive ``moment`` is read as UTC."""
    if moment.tzinfo is None or moment.tzinfo.utcoffset(moment) is None:
        moment = moment.replace(tzinfo=timezone.utc)
    delta = moment - _EPOCH
    return (delta.days * 86400 + delta.seconds) * 1000 + delta.microseconds // 1000
