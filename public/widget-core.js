// Browser-side derivation and formatting for the DeepSeek widget.
//
// The server owns the schedule and the holiday table. This file only turns the
// absolute instants it returns into local wall-clock labels, and builds the
// local-day timeline by clipping the merged runs the server sent. It has no
// billing math of its own, so it cannot disagree with the server about peak.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory()
  else root.DeepSeekWidgetCore = factory()
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict"

  var DAY_MS = 86400000
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

  function pad2(value) {
    return value < 10 ? "0" + value : String(value)
  }

  function finite(value) {
    return typeof value === "number" && Number.isFinite(value)
  }

  // "12h" is the compact regular-time style used by the widget: 7pm, 10am,
  // 7:30pm. Anything else means the original 24-hour clock.
  function normalizeTimeFormat(value) {
    var text = String(value === null || value === undefined ? "" : value).trim().toLowerCase()
    if (text === "12" || text === "12h" || text === "12-hour" || text === "ampm" || text === "am-pm")
      return "12h"
    return "24h"
  }

  function formatTime(ms, utc, timeFormat) {
    var d = new Date(ms)
    var hours = utc ? d.getUTCHours() : d.getHours()
    var minutes = utc ? d.getUTCMinutes() : d.getMinutes()
    if (normalizeTimeFormat(timeFormat) !== "12h")
      return pad2(hours) + ":" + pad2(minutes)

    var suffix = hours < 12 ? "am" : "pm"
    var hour12 = hours % 12
    if (hour12 === 0) hour12 = 12
    // Whole hours are intentionally compact ("7pm"), matching the rest of the
    // card. Minutes appear only when they carry information ("7:30pm").
    return hour12 + (minutes === 0 ? "" : ":" + pad2(minutes)) + suffix
  }

  function hhmmLocal(ms, timeFormat) {
    return formatTime(ms, false, timeFormat)
  }

  function hhmmUtc(ms, timeFormat) {
    return formatTime(ms, true, timeFormat)
  }

  function monthDayLocal(ms) {
    var d = new Date(ms)
    return pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
  }

  function monthDayUtc(ms) {
    var d = new Date(ms)
    return pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate())
  }

  function weekdayLocal(ms) {
    return WEEKDAYS[new Date(ms).getDay()]
  }

  function weekdayUtc(ms) {
    return WEEKDAYS[new Date(ms).getUTCDay()]
  }

  function offsetLabel(ms) {
    var offset = -new Date(ms).getTimezoneOffset()
    var sign = offset < 0 ? "-" : "+"
    var abs = Math.abs(offset)
    return "UTC" + sign + pad2(Math.floor(abs / 60)) + ":" + pad2(abs % 60)
  }

  function formatClock(seconds) {
    var total = Math.max(0, Math.round(Number(seconds) || 0))
    var hours = Math.floor(total / 3600)
    var minutes = Math.floor((total % 3600) / 60)
    return hours + ":" + pad2(minutes) + ":" + pad2(total % 60)
  }

  function formatAge(ms, nowMs) {
    var delta = Math.max(0, (Number(nowMs) || Date.now()) - Number(ms || 0))
    var seconds = Math.floor(delta / 1000)
    if (seconds < 5) return "just now"
    if (seconds < 60) return seconds + "s ago"
    var minutes = Math.floor(seconds / 60)
    if (minutes < 60) return minutes + "m ago"
    var hours = Math.floor(minutes / 60)
    if (hours < 24) return hours + "h ago"
    return Math.floor(hours / 24) + "d ago"
  }

  function localDayBounds(ms) {
    var at = new Date(ms)
    return {
      startMs: new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime(),
      endMs: new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1).getTime()
    }
  }

  function normalizeRuns(runs) {
    if (!Array.isArray(runs)) return []
    var cleaned = []
    for (var i = 0; i < runs.length; i++) {
      var run = runs[i]
      if (!run || !finite(run.startMs) || !finite(run.endMs) || run.endMs <= run.startMs) continue
      cleaned.push({ startMs: run.startMs, endMs: run.endMs, peak: run.peak === true })
    }
    cleaned.sort(function (a, b) { return a.startMs - b.startMs || a.endMs - b.endMs })
    return cleaned
  }

  // Clip the server's merged runs to the viewer's local day. Adjacent segments
  // of the same state are folded, and a run that starts before the day or ends
  // after it is extended to the edge, so the bar has no seam.
  function localDayView(runs, nowMs, holidayName, timeFormat) {
    var format = normalizeTimeFormat(timeFormat)
    var bounds = localDayBounds(nowMs)
    var dayStart = bounds.startMs
    var dayEnd = bounds.endMs
    var span = Math.max(1, dayEnd - dayStart)
    var normalized = normalizeRuns(runs)
    if (normalized.length === 0) {
      return {
        available: false,
        bounds: bounds,
        segments: [],
        peaks: [],
        nowFrac: 0,
        dayLabel: "",
        holidayName: holidayName || "",
        axis: []
      }
    }

    var segments = []
    for (var i = 0; i < normalized.length; i++) {
      var run = normalized[i]
      var start = Math.max(run.startMs, dayStart)
      var end = Math.min(run.endMs, dayEnd)
      if (end <= start) continue
      var last = segments.length > 0 ? segments[segments.length - 1] : null
      if (last && last.peak === run.peak && last.endMs === start) last.endMs = end
      else segments.push({ startMs: start, endMs: end, peak: run.peak })
    }

    if (segments.length === 0) {
      return {
        available: false,
        bounds: bounds,
        segments: [],
        peaks: [],
        nowFrac: 0,
        dayLabel: "",
        holidayName: holidayName || "",
        axis: []
      }
    }

    // The server sends runs outside the day on both sides, so these are only
    // guards against a truncated response.
    if (segments[0].startMs > dayStart) segments[0].startMs = dayStart
    if (segments[segments.length - 1].endMs < dayEnd) segments[segments.length - 1].endMs = dayEnd

    var layout = []
    var cursor = 0
    var peaks = []
    for (var j = 0; j < segments.length; j++) {
      var width = (segments[j].endMs - segments[j].startMs) / span
      layout.push({
        startFrac: cursor,
        endFrac: cursor + width,
        peak: segments[j].peak,
        startMs: segments[j].startMs,
        endMs: segments[j].endMs
      })
      cursor += width
      if (segments[j].peak) {
        peaks.push({
          startMs: segments[j].startMs,
          endMs: segments[j].endMs,
          localLabel: hhmmLocal(segments[j].startMs, format) + " - " + hhmmLocal(segments[j].endMs, format),
          utcLabel: hhmmUtc(segments[j].startMs, format) + " - " + hhmmUtc(segments[j].endMs, format)
        })
      }
    }

    return {
      available: true,
      bounds: bounds,
      segments: layout,
      peaks: peaks,
      nowFrac: Math.max(0, Math.min(1, (nowMs - dayStart) / span)),
      dayLabel: weekdayLocal(dayStart) + " " + monthDayLocal(dayStart) + " "
        + hhmmLocal(dayStart, format) + " \u2192 " + weekdayLocal(dayEnd) + " " + monthDayLocal(dayEnd)
        + " " + hhmmLocal(dayEnd, format) + " local",
      holidayName: holidayName || "",
      axis: axisLabels(bounds, format)
    }
  }

  function hourLabel(hour, timeFormat) {
    var value = Number(hour) % 24
    if (normalizeTimeFormat(timeFormat) !== "12h") return pad2(value)
    var suffix = value < 12 ? "a" : "p"
    var hour12 = value % 12
    if (hour12 === 0) hour12 = 12
    return hour12 + suffix
  }

  function axisLabels(bounds, timeFormat) {
    var at = new Date(bounds.startMs)
    var labels = []
    var hours = [0, 6, 12, 18, 24]
    var span = Math.max(1, bounds.endMs - bounds.startMs)
    for (var i = 0; i < hours.length; i++) {
      var ms = new Date(at.getFullYear(), at.getMonth(), at.getDate() + Math.floor(hours[i] / 24),
        hours[i] % 24).getTime()
      if (ms < bounds.startMs || ms > bounds.endMs) continue
      labels.push({
        frac: Math.max(0, Math.min(1, (ms - bounds.startMs) / span)),
        label: hourLabel(hours[i], timeFormat)
      })
    }
    return labels
  }

  function deriveView(data, nowMs, timeFormat) {
    var format = normalizeTimeFormat(timeFormat)
    var now = finite(nowMs) ? nowMs : Date.now()
    var nextSwitchMs = finite(data.nextSwitchMs) ? data.nextSwitchMs : now
    var remaining = Math.max(0, Math.ceil((nextSwitchMs - now) / 1000))
    var peak = data.peak === true
    var holidayName = typeof data.holidayName === "string" ? data.holidayName : ""

    return {
      peak: peak,
      state: peak ? "peak" : "off-peak",
      phaseLabel: peak ? "Peak" : "Off-peak",
      holidayName: holidayName,
      nowMs: now,
      nowLocalClock: hhmmLocal(now, format),
      nowLocalDay: weekdayLocal(now) + " " + monthDayLocal(now),
      nowUtcClock: hhmmUtc(now, format),
      nowOffset: offsetLabel(now),
      nowBeijingClock: hhmmUtc(now + 8 * 3600000, format),
      remaining: remaining,
      remainingClock: formatClock(remaining),
      nextSwitchMs: nextSwitchMs,
      nextSwitchLabel: peak ? "Off-peak starts" : "Peak starts",
      nextSwitchLocalClock: hhmmLocal(nextSwitchMs, format),
      nextSwitchLocalDay: weekdayLocal(nextSwitchMs) + " " + monthDayLocal(nextSwitchMs),
      nextSwitchUtcClock: hhmmUtc(nextSwitchMs, format),
      nextSwitchUtcDay: weekdayUtc(nextSwitchMs) + " " + monthDayUtc(nextSwitchMs),
      offPeakEndMs: finite(data.offPeakEndMs) ? data.offPeakEndMs : now,
      offPeakEndLocalClock: hhmmLocal(finite(data.offPeakEndMs) ? data.offPeakEndMs : now, format),
      offPeakEndUtcClock: hhmmUtc(finite(data.offPeakEndMs) ? data.offPeakEndMs : now, format),
      currentPeriodStartMs: finite(data.currentPeriodStartMs) ? data.currentPeriodStartMs : now,
      day: localDayView(data.runs, now, holidayName, format)
    }
  }

  return {
    DAY_MS: DAY_MS,
    pad2: pad2,
    normalizeTimeFormat: normalizeTimeFormat,
    formatTime: formatTime,
    hhmmLocal: hhmmLocal,
    hhmmUtc: hhmmUtc,
    weekdayLocal: weekdayLocal,
    weekdayUtc: weekdayUtc,
    offsetLabel: offsetLabel,
    formatClock: formatClock,
    formatAge: formatAge,
    localDayBounds: localDayBounds,
    localDayView: localDayView,
    axisLabels: axisLabels,
    deriveView: deriveView
  }
})
