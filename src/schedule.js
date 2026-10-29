// DeepSeek billing-window math.
//
// Ported from DavidHLP/deepseek-offpeak (MIT), lib/Schedule.js. The arithmetic
// is deliberately unchanged: peak hours are weekdays 01:00-04:00 and
// 06:00-10:00 UTC (09:00-12:00 and 14:00-18:00 Beijing), every other instant is
// off-peak, weekends are off-peak all day, and so is a Chinese public holiday.
//
// Windows are half-open ([01:00, 04:00)), so a boundary instant belongs to the
// window that starts there: 04:00 is off-peak, 06:00 is peak, 10:00 is off-peak.
//
// This module never consults the DeepSeek API. Server load and API availability
// are not billing state; the discount windows are a published timetable.
//
// Pure and I/O-free: every function takes the instant it should reason about,
// so nothing here reads the clock implicitly and nothing reaches for a network.

"use strict"

const MINUTE_MS = 60000
const HOUR_MS = 3600000
const DAY_MS = 86400000

// Beijing is UTC+8 all year. It is used only to name the calendar date a
// holiday table is keyed by, never to move a window.
const BEIJING_OFFSET_MS = 8 * HOUR_MS

// How far runsAround will walk looking for the boundaries of the run holding an
// instant. The longest published run is the Spring Festival break, ten days and
// more; this sits far above it.
const HORIZON_CAP_DAYS = 32

// Peak windows for a weekday, as [startMinute, endMinute) since 00:00 UTC.
const PEAK_WINDOWS = [[60, 240], [360, 600]]

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function utcDayStartMs(ms) {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

// "2026-10-01" - a UTC calendar date, the key a holiday table is written in.
function dateKeyUtc(ms) {
  const d = new Date(ms)
  return String(d.getUTCFullYear()) + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate())
}

// The Beijing calendar date containing `ms`. A Chinese holiday is a date in
// Beijing, so this is the date that decides billing.
function beijingDateKey(ms) {
  const d = new Date(Number(ms) + BEIJING_OFFSET_MS)
  return String(d.getUTCFullYear()) + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate())
}

function beijingYear(ms) {
  return Number(beijingDateKey(ms).slice(0, 4))
}

// Does the day beginning at `dayStartMs` (a UTC midnight) contain peak windows?
// It does when it is Monday to Friday and is not a Chinese public holiday.
function hasPeakWindows(dayStartMs, holidays) {
  const dayOfWeek = new Date(dayStartMs).getUTCDay()
  if (dayOfWeek === 0 || dayOfWeek === 6) return false
  if (holidays && holidays[dateKeyUtc(dayStartMs)]) return false
  return true
}

// The Chinese public holiday covering `ms`, by name, or "". Answered for the
// Beijing date containing `ms`.
function holidayName(ms, holidays) {
  if (!holidays) return ""
  const name = holidays[beijingDateKey(ms)]
  return typeof name === "string" ? name : ""
}

// The day at `dayStartMs` split into contiguous intervals of constant state.
function intervalsForDay(dayStartMs, holidays) {
  if (!hasPeakWindows(dayStartMs, holidays))
    return [{ startMs: dayStartMs, endMs: dayStartMs + DAY_MS, peak: false }]

  const out = []
  let cursor = 0
  for (let i = 0; i < PEAK_WINDOWS.length; i++) {
    const window = PEAK_WINDOWS[i]
    out.push({ startMs: dayStartMs + cursor * MINUTE_MS, endMs: dayStartMs + window[0] * MINUTE_MS, peak: false })
    out.push({ startMs: dayStartMs + window[0] * MINUTE_MS, endMs: dayStartMs + window[1] * MINUTE_MS, peak: true })
    cursor = window[1]
  }
  out.push({ startMs: dayStartMs + cursor * MINUTE_MS, endMs: dayStartMs + DAY_MS, peak: false })
  return out
}

// Contiguous, merged runs of constant state, generated outward from the day
// containing `ms` until a day with peak windows has been included on each side.
// Adjacent intervals of the same state are folded together, so a weekend comes
// out as one run rather than a spurious switch at each midnight.
function runsAround(ms, holidays) {
  const dayStart = utcDayStartMs(ms)

  let back = 1
  while (back < HORIZON_CAP_DAYS && !hasPeakWindows(dayStart - back * DAY_MS, holidays)) back++
  let forward = 1
  while (forward < HORIZON_CAP_DAYS && !hasPeakWindows(dayStart + forward * DAY_MS, holidays)) forward++

  let intervals = []
  for (let dayOffset = -back; dayOffset <= forward; dayOffset++)
    intervals = intervals.concat(intervalsForDay(dayStart + dayOffset * DAY_MS, holidays))

  const runs = []
  for (let i = 0; i < intervals.length; i++) {
    const interval = intervals[i]
    const last = runs.length > 0 ? runs[runs.length - 1] : null
    if (last && last.peak === interval.peak && last.endMs === interval.startMs) last.endMs = interval.endMs
    else runs.push({ startMs: interval.startMs, endMs: interval.endMs, peak: interval.peak })
  }
  return runs
}

function runAt(runs, ms) {
  for (let i = 0; i < runs.length; i++)
    if (runs[i].startMs <= ms && ms < runs[i].endMs) return i
  return -1
}

// Everything a consumer needs for one instant:
//   peak                  current pricing state
//   currentStartMs        when the current (possibly merged) run began
//   nextSwitchMs          when the state next changes
//   nextOffPeakStartMs    start of the off-peak stretch that contains `now`,
//                         or the upcoming off-peak start when `now` is peak
//   offPeakEndMs          when that off-peak stretch ends
//   peakEndMs             when the current peak ends, or null when off-peak
//   secondsToSwitch       whole seconds until nextSwitchMs, never negative
//   secondsToOffPeakEnd   whole seconds until offPeakEndMs, never negative
function stateAt(ms, holidays) {
  const now = Number(ms)
  const runs = runsAround(now, holidays)
  const index = runAt(runs, now)
  if (index < 0) {
    // Unreachable for any finite input, but a NaN or absurd date must not
    // produce a negative countdown.
    return {
      peak: false,
      currentStartMs: now,
      nextSwitchMs: now,
      nextOffPeakStartMs: now,
      offPeakEndMs: now,
      peakEndMs: null,
      secondsToSwitch: 0,
      secondsToOffPeakEnd: 0
    }
  }

  const run = runs[index]
  let first = index
  while (first > 0 && runs[first - 1].peak === run.peak) first--
  let last = index
  while (last < runs.length - 1 && runs[last + 1].peak === run.peak) last++

  let offPeakEndMs = now
  for (let i = index; i < runs.length; i++) {
    if (!runs[i].peak) { offPeakEndMs = runs[i].endMs; break }
  }

  const nextSwitchMs = runs[last].endMs
  return {
    peak: run.peak,
    currentStartMs: runs[first].startMs,
    nextSwitchMs: nextSwitchMs,
    nextOffPeakStartMs: run.peak ? nextSwitchMs : runs[first].startMs,
    offPeakEndMs: offPeakEndMs,
    peakEndMs: run.peak ? nextSwitchMs : null,
    // Ceiling, not rounding. A countdown must not report zero before its target
    // instant, and rounding reaches zero up to 499ms early - while `peak` still
    // describes the interval being left.
    secondsToSwitch: Math.max(0, Math.ceil((nextSwitchMs - now) / 1000)),
    secondsToOffPeakEnd: Math.max(0, Math.ceil((offPeakEndMs - now) / 1000))
  }
}

function isPeakAt(ms, holidays) {
  return stateAt(ms, holidays).peak
}

// The local calendar day containing `ms`: local midnight to the next local
// midnight, so a DST day is 23 or 25 hours rather than an hour that is silently
// the wrong length.
function localDayBounds(ms) {
  const at = new Date(ms)
  return {
    startMs: new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime(),
    endMs: new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1).getTime()
  }
}

// The local day split into contiguous peak/off-peak segments, clipped to the
// day. Built from real run boundaries rather than fixed hour cells.
function daySegments(ms, holidays) {
  const day = localDayBounds(ms)
  const runs = runsAround(day.startMs + (day.endMs - day.startMs) / 2, holidays)

  const segments = []
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]
    const start = Math.max(run.startMs, day.startMs)
    const end = Math.min(run.endMs, day.endMs)
    if (end <= start) continue
    segments.push({ startMs: start, endMs: end, peak: run.peak })
  }
  return segments
}

// Peak ranges inside [startMs, endMs), clipped and merged.
function peakRanges(startMs, endMs, holidays) {
  const runs = runsAround(startMs + (endMs - startMs) / 2, holidays)
  const ranges = []
  for (let i = 0; i < runs.length; i++) {
    if (!runs[i].peak) continue
    const start = Math.max(runs[i].startMs, startMs)
    const end = Math.min(runs[i].endMs, endMs)
    if (end <= start) continue
    ranges.push({ startMs: start, endMs: end })
  }
  return ranges
}

function pad2(value) {
  return value < 10 ? "0" + value : String(value)
}

function hhmmUtc(ms) {
  const d = new Date(ms)
  return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes())
}

function hhmmLocal(ms) {
  const d = new Date(ms)
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes())
}

function weekdayUtc(ms) {
  return WEEKDAY_NAMES[new Date(ms).getUTCDay()]
}

function weekdayLocal(ms) {
  return WEEKDAY_NAMES[new Date(ms).getDay()]
}

function isoUtc(ms) {
  return new Date(ms).toISOString()
}

// "2:14:37" - h:mm:ss, hours as long as they need to be.
function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  return hours + ":" + pad2(minutes) + ":" + pad2(total % 60)
}

// "2h 14m" / "14m 37s" / "37s".
function formatShort(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return hours + "h " + pad2(minutes) + "m"
  if (minutes > 0) return minutes + "m " + pad2(total % 60) + "s"
  return total + "s"
}

// "UTC+02:00" - an offset, not a zone abbreviation.
function offsetLabel(ms) {
  const offset = -new Date(ms).getTimezoneOffset()
  const sign = offset < 0 ? "-" : "+"
  const abs = Math.abs(offset)
  return "UTC" + sign + pad2(Math.floor(abs / 60)) + ":" + pad2(abs % 60)
}

// "Fri 09-11" - the local calendar date, with the local weekday.
function localDayLabel(ms) {
  const d = new Date(ms)
  return weekdayLocal(ms) + " " + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
}

// Same, in UTC.
function utcDayLabel(ms) {
  const d = new Date(ms)
  return weekdayUtc(ms) + " " + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate())
}

// Everything a panel might draw about the local day, derived once from the real
// run boundaries: bounds, proportional segments, where "now" falls, and the
// peak windows written in both zones.
function timeline(ms, holidays) {
  const bounds = localDayBounds(ms)
  const segments = daySegments(ms, holidays)
  const span = Math.max(1, bounds.endMs - bounds.startMs)

  const layout = []
  let cursor = 0
  for (let i = 0; i < segments.length; i++) {
    const width = (segments[i].endMs - segments[i].startMs) / span
    layout.push({ startFrac: cursor, endFrac: cursor + width, peak: segments[i].peak })
    cursor += width
  }

  const peaks = []
  const ranges = peakRanges(bounds.startMs, bounds.endMs, holidays)
  for (let j = 0; j < ranges.length; j++) {
    peaks.push({
      localLabel: hhmmLocal(ranges[j].startMs) + " - " + hhmmLocal(ranges[j].endMs),
      utcLabel: hhmmUtc(ranges[j].startMs) + " - " + hhmmUtc(ranges[j].endMs)
    })
  }

  return {
    bounds: bounds,
    layout: layout,
    peaks: peaks,
    nowFrac: Math.max(0, Math.min(1, (ms - bounds.startMs) / span)),
    dayLabel: weekdayLocal(bounds.startMs) + " " + hhmmLocal(bounds.startMs) + " \u2192 "
      + weekdayLocal(bounds.endMs) + " " + hhmmLocal(bounds.endMs) + " local"
  }
}

// Shortest honest unit for a sliver of bar space: "10h", "52m", "30s".
function formatCompact(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  if (total >= 3600) return Math.floor(total / 3600) + "h"
  if (total >= 60) return Math.floor(total / 60) + "m"
  return total + "s"
}

// The rule in one sentence. The windows are given in both zones because they
// are published in Beijing and the timetable here is UTC.
function scheduleSummary(holidayYears) {
  const years = holidayYears === undefined || holidayYears === null ? "" : String(holidayYears)
  return "Peak: weekdays 01:00-04:00 and 06:00-10:00 UTC, 09:00-12:00 and 14:00-18:00 Beijing."
    + " Off-peak: every other hour, all weekend, and Chinese public holidays all day"
    + (years === "" ? "." : " (" + years + ").")
}

// Which off-peak notification, if any, a tick should send. Kept for parity with
// upstream even though a web widget does not deliver notifications.
function notificationForTick(wasPeak, peak, enabled) {
  if (!enabled) return ""
  return (wasPeak && !peak) ? "transition" : ""
}

module.exports = {
  MINUTE_MS,
  HOUR_MS,
  DAY_MS,
  BEIJING_OFFSET_MS,
  HORIZON_CAP_DAYS,
  PEAK_WINDOWS,
  utcDayStartMs,
  dateKeyUtc,
  beijingDateKey,
  beijingYear,
  hasPeakWindows,
  holidayName,
  intervalsForDay,
  runsAround,
  runAt,
  stateAt,
  isPeakAt,
  localDayBounds,
  daySegments,
  peakRanges,
  hhmmUtc,
  hhmmLocal,
  weekdayUtc,
  weekdayLocal,
  isoUtc,
  formatClock,
  formatShort,
  formatCompact,
  offsetLabel,
  localDayLabel,
  utcDayLabel,
  timeline,
  notificationForTick,
  scheduleSummary
}
