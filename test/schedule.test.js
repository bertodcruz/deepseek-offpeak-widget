// Billing-window math self-check. Run: node --test test/schedule.test.js
//
// The four boundary times (01:00, 04:00, 06:00, 10:00) are the cases a naive
// implementation gets wrong; the weekend and holiday cases are where a run can
// outlast any fixed horizon.

"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const S = require("../src/schedule")
const H = require("../src/holidays")

const holidays = H.fallback()
const at = (y, m, d, h, min) => Date.UTC(y, m - 1, d, h || 0, min || 0)
const iso = (ms) => new Date(ms).toISOString()

test("peak windows on a weekday", () => {
  assert.equal(S.isPeakAt(at(2026, 9, 9, 0, 59)), false, "00:59")
  assert.equal(S.isPeakAt(at(2026, 9, 9, 1, 0)), true, "01:00 is the start")
  assert.equal(S.isPeakAt(at(2026, 9, 9, 3, 59)), true, "03:59")
  assert.equal(S.isPeakAt(at(2026, 9, 9, 4, 0)), false, "04:00 is the end, half-open")
  assert.equal(S.isPeakAt(at(2026, 9, 9, 5, 59)), false, "05:59")
  assert.equal(S.isPeakAt(at(2026, 9, 9, 6, 0)), true, "06:00 is the start")
  assert.equal(S.isPeakAt(at(2026, 9, 9, 9, 59)), true, "09:59")
  assert.equal(S.isPeakAt(at(2026, 9, 9, 10, 0)), false, "10:00 is the end, half-open")
  assert.equal(S.isPeakAt(at(2026, 9, 9, 23, 59)), false, "23:59")
})

test("weekends are off-peak all day", () => {
  for (const day of [12, 13]) {
    for (let hour = 0; hour < 24; hour++) {
      assert.equal(S.isPeakAt(at(2026, 9, day, hour, 0)), false, `2026-09-${day} ${hour}:00 UTC`)
    }
  }
  assert.equal(S.isPeakAt(at(2026, 9, 12, 2, 0)), false, "Saturday inside the 01:00 window")
  assert.equal(S.isPeakAt(at(2026, 9, 13, 8, 0)), false, "Sunday inside the 06:00 window")
})

test("Monday 01:00 is peak again", () => {
  assert.equal(S.isPeakAt(at(2026, 9, 14, 0, 59)), false, "Monday 00:59")
  assert.equal(S.isPeakAt(at(2026, 9, 14, 1, 0)), true, "Monday 01:00")
})

test("boundaries report the right next switch", () => {
  const before = S.stateAt(at(2026, 9, 9, 0, 30))
  assert.equal(iso(before.nextSwitchMs), iso(at(2026, 9, 9, 1, 0)), "01:00 next")
  assert.equal(before.secondsToSwitch, 1800, "30 minutes")

  const peak = S.stateAt(at(2026, 9, 9, 3, 0))
  assert.equal(iso(peak.nextSwitchMs), iso(at(2026, 9, 9, 4, 0)), "04:00 next")
  assert.equal(iso(peak.offPeakEndMs), iso(at(2026, 9, 9, 6, 0)), "off-peak runs to 06:00")

  const second = S.stateAt(at(2026, 9, 9, 9, 0))
  assert.equal(iso(second.nextSwitchMs), iso(at(2026, 9, 9, 10, 0)), "10:00 next")
  assert.equal(iso(second.offPeakEndMs), iso(at(2026, 9, 10, 1, 0)), "off-peak runs to tomorrow 01:00")
})

test("weekend off-peak runs to Monday 01:00, not midnight", () => {
  const friday = S.stateAt(at(2026, 9, 11, 10, 0))
  assert.equal(friday.peak, false)
  assert.equal(iso(friday.nextSwitchMs), iso(at(2026, 9, 14, 1, 0)),
    "Friday 10:00 is off-peak until Monday 01:00")

  const sunday = S.stateAt(at(2026, 9, 13, 23, 0))
  assert.equal(iso(sunday.nextSwitchMs), iso(at(2026, 9, 14, 1, 0)), "Sunday 23:00")
  assert.equal(sunday.secondsToSwitch, 2 * 3600, "two hours left")

  const monday = S.stateAt(at(2026, 9, 14, 0, 30))
  assert.equal(monday.peak, false)
  assert.equal(iso(monday.offPeakEndMs), iso(at(2026, 9, 14, 1, 0)), "half an hour of off-peak left")
})

test("currentPeriodStart spans the merged off-peak run", () => {
  const sunday = S.stateAt(at(2026, 9, 13, 12, 0))
  assert.equal(iso(sunday.currentStartMs), iso(at(2026, 9, 11, 10, 0)),
    "the stretch began Friday 10:00")
})

test("countdowns are never negative, at either edge of a window", () => {
  const edges = [
    at(2026, 9, 9, 1, 0), at(2026, 9, 9, 4, 0), at(2026, 9, 9, 6, 0), at(2026, 9, 9, 10, 0),
    at(2026, 9, 12, 0, 0), at(2026, 9, 14, 1, 0)
  ]
  for (const edge of edges) {
    const state = S.stateAt(edge)
    assert.ok(state.secondsToSwitch >= 0, `secondsToSwitch at ${iso(edge)}`)
    assert.ok(state.secondsToOffPeakEnd >= 0, `secondsToOffPeakEnd at ${iso(edge)}`)
    assert.ok(state.nextSwitchMs >= edge, `nextSwitchMs at ${iso(edge)}`)
  }
  for (const edge of edges) {
    const justBefore = S.stateAt(edge - 1)
    assert.ok(justBefore.nextSwitchMs >= edge - 1, `nextSwitchMs at ${iso(edge - 1)}`)
    assert.ok(justBefore.secondsToSwitch >= 0, `seconds at ${iso(edge - 1)}`)
  }
})

test("a countdown reads zero only after its boundary, never just before", () => {
  for (let ms = at(2026, 9, 10, 0, 59, 0); ms < at(2026, 9, 10, 1, 1, 0); ms += 37) {
    const state = S.stateAt(ms)
    if (state.secondsToSwitch === 0) {
      assert.ok(ms >= state.nextSwitchMs,
        `read 0s at ${iso(ms)} with the switch still ahead at ${iso(state.nextSwitchMs)}`)
    }
    if (state.secondsToOffPeakEnd === 0) {
      assert.ok(ms >= state.offPeakEndMs,
        `read 0s of off-peak at ${iso(ms)} with it ending at ${iso(state.offPeakEndMs)}`)
    }
  }

  const before = S.stateAt(at(2026, 9, 10, 1, 0, 0) - 1)
  assert.equal(before.secondsToSwitch, 1, "1ms before the switch must read 1s")
  assert.equal(before.peak, false, "and must not have flipped yet")

  const boundary = S.stateAt(at(2026, 9, 10, 1, 0, 0))
  assert.equal(boundary.peak, true, "01:00 UTC is peak")
  assert.equal(boundary.secondsToSwitch, 3 * 3600, "with three hours left in it")
})

test("a whole week of ticks never goes backwards or negative", () => {
  let previous
  for (let ms = at(2026, 9, 7, 0, 0); ms < at(2026, 9, 14, 0, 0); ms += 60 * 1000) {
    const state = S.stateAt(ms)
    assert.ok(state.secondsToSwitch >= 0, `negative at ${iso(ms)}`)
    if (previous) {
      assert.ok(state.nextSwitchMs >= previous.nextSwitchMs, `switch time moved back at ${iso(ms)}`)
    }
    previous = state
  }
})

test("off-peak start reported while off-peak is already running", () => {
  const peak = S.stateAt(at(2026, 9, 9, 3, 0))
  assert.equal(iso(peak.nextOffPeakStartMs), iso(at(2026, 9, 9, 4, 0)),
    "from peak, the next off-peak start is the upcoming switch")

  const flat = S.stateAt(at(2026, 9, 9, 5, 0))
  assert.equal(iso(flat.nextOffPeakStartMs), iso(flat.currentStartMs),
    "already off-peak: it started when this stretch did")
})

test("day segments tile the local day exactly", () => {
  const day = S.localDayBounds(at(2026, 9, 9, 12, 0))
  const segments = S.daySegments(at(2026, 9, 9, 12, 0))
  assert.ok(segments.length > 0, "segments exist")
  assert.equal(segments[0].startMs, day.startMs, "starts at local midnight")
  assert.equal(segments[segments.length - 1].endMs, day.endMs, "ends at next local midnight")
  for (let i = 1; i < segments.length; i++) {
    assert.equal(segments[i].startMs, segments[i - 1].endMs, "no gap between segments")
    assert.notEqual(segments[i].peak, segments[i - 1].peak, "adjacent segments differ")
  }
  const peakSeconds = segments.filter((s) => s.peak)
    .reduce((sum, s) => sum + (s.endMs - s.startMs), 0) / 1000
  assert.equal(peakSeconds, 7 * 3600, "7 peak hours on a weekday")
})

test("peak ranges are the windows themselves on a weekday", () => {
  const day = S.localDayBounds(at(2026, 9, 9, 12, 0))
  const ranges = S.peakRanges(day.startMs, day.endMs)
  assert.equal(ranges.length, 2, "two peak ranges")
  for (const range of ranges) assert.ok(range.endMs > range.startMs, "range is not empty")
})

test("weekend has no peak ranges", () => {
  const day = S.localDayBounds(at(2026, 9, 12, 12, 0))
  assert.deepEqual(S.peakRanges(day.startMs, day.endMs), [], "Saturday")
})

test("formatters", () => {
  assert.equal(S.formatClock(0), "0:00:00")
  assert.equal(S.formatClock(-5), "0:00:00", "negative clamps")
  assert.equal(S.formatClock(3661), "1:01:01")
  assert.equal(S.formatClock(11 * 3600 + 32 * 60 + 44), "11:32:44")
  assert.equal(S.formatShort(59), "59s")
  assert.equal(S.formatShort(60), "1m 00s")
  assert.equal(S.formatShort(3600), "1h 00m")
  assert.equal(S.formatShort(-1), "0s", "negative clamps")
  assert.equal(S.hhmmUtc(at(2026, 9, 9, 1, 0)), "01:00")
})

test("the day timeline tiles the local day and marks it in both zones", () => {
  const day = S.timeline(at(2026, 9, 9, 12, 0))
  assert.equal(day.layout[0].startFrac, 0, "bar starts at the left edge")
  assert.ok(Math.abs(day.layout[day.layout.length - 1].endFrac - 1) < 1e-9, "bar reaches the right edge")
  for (let i = 1; i < day.layout.length; i++) {
    assert.ok(Math.abs(day.layout[i].startFrac - day.layout[i - 1].endFrac) < 1e-9,
      "no seam between segments")
    assert.notEqual(day.layout[i].peak, day.layout[i - 1].peak, "adjacent segments differ")
  }
  assert.ok(day.nowFrac >= 0 && day.nowFrac <= 1, `nowFrac ${day.nowFrac}`)
  assert.equal(day.peaks.length, 2, "two peak windows")
  for (const peak of day.peaks) {
    assert.ok(/^\d{2}:\d{2} - \d{2}:\d{2}$/.test(peak.localLabel), peak.localLabel)
    assert.ok(/^\d{2}:\d{2} - \d{2}:\d{2}$/.test(peak.utcLabel), peak.utcLabel)
  }
})

test("the timeline label names both ends, so it never reads as zero-length", () => {
  const day = S.timeline(at(2026, 9, 9, 12, 0))
  const [startLabel, endLabel] = day.dayLabel.replace(" local", "").split(" \u2192 ")
  assert.ok(startLabel && endLabel, day.dayLabel)
  const startClock = startLabel.split(" ")[1]
  const endClock = endLabel.split(" ")[1]
  assert.equal(startClock, endClock, "the span runs midnight to midnight")
  assert.notEqual(startLabel.split(" ")[0], endLabel.split(" ")[0],
    `the closing end must name the next day: ${day.dayLabel}`)
})

test("a weekend day's timeline has no peak segments at all", () => {
  const day = S.timeline(at(2026, 9, 12, 12, 0))
  assert.deepEqual(day.peaks, [], "Saturday has no peak windows")
  assert.equal(day.layout.length, 1, "one continuous off-peak bar")
  assert.equal(day.layout[0].peak, false)
})

test("day labels carry the weekday of the zone they are written in", () => {
  const fridayLate = at(2026, 9, 11, 23, 0)
  const utc = S.utcDayLabel(fridayLate)
  const local = S.localDayLabel(fridayLate)
  assert.ok(utc.startsWith("Fri "), utc)
  assert.ok(/^(Fri|Sat) /.test(local), local)
  assert.equal(utc, "Fri 09-11")
  assert.ok(utc.includes("09-11"), utc)
})

test("compact durations stay inside a bar slot", () => {
  assert.equal(S.formatCompact(0), "0s")
  assert.equal(S.formatCompact(-5), "0s", "negative clamps")
  assert.equal(S.formatCompact(45), "45s")
  assert.equal(S.formatCompact(60), "1m")
  assert.equal(S.formatCompact(3599), "59m")
  assert.equal(S.formatCompact(3600), "1h")
  assert.equal(S.formatCompact(11 * 3600 + 52 * 60), "11h")
  for (const seconds of [0, 9, 59, 60, 599, 3599, 3600, 35999, 86399, 999999]) {
    assert.ok(S.formatCompact(seconds).length <= 4, `${seconds} -> ${S.formatCompact(seconds)}`)
  }
})

test("a public holiday has no peak windows, and the same weekday without one does", () => {
  for (let hour = 0; hour < 24; hour++) {
    assert.equal(S.isPeakAt(at(2026, 10, 5, hour, 0), holidays), false,
      `2026-10-05 ${hour}:00 UTC is in a holiday`)
  }
  assert.equal(S.isPeakAt(at(2026, 10, 12, 1, 0), holidays), true, "01:00")
  assert.equal(S.isPeakAt(at(2026, 10, 12, 6, 0), holidays), true, "06:00")
  assert.equal(S.isPeakAt(at(2026, 10, 12, 10, 0), holidays), false, "10:00")
  assert.equal(S.isPeakAt(at(2026, 10, 5, 1, 0)), true, "no table, no holidays")
})

test("a holiday week is one off-peak run, to the minute it ends", () => {
  const before = S.stateAt(at(2026, 9, 30, 10, 0), holidays)
  assert.equal(before.peak, false)
  assert.equal(iso(before.nextSwitchMs), iso(at(2026, 10, 8, 1, 0)),
    "off-peak from Wednesday 10:00 until the following Thursday 01:00")

  const inside = S.stateAt(at(2026, 10, 5, 3, 0), holidays)
  assert.equal(inside.peak, false)
  assert.equal(iso(inside.currentStartMs), iso(at(2026, 9, 30, 10, 0)),
    "the stretch began the day the holiday did")
  assert.equal(inside.secondsToSwitch, (at(2026, 10, 8, 1, 0) - at(2026, 10, 5, 3, 0)) / 1000)

  assert.equal(S.isPeakAt(at(2026, 10, 8, 1, 0), holidays), true)
  assert.equal(S.isPeakAt(at(2026, 10, 8, 0, 59), holidays), false)

  const day = S.timeline(at(2026, 10, 5, 12, 0), holidays)
  assert.deepEqual(day.peaks, [], "a holiday has no peak windows to list")
  assert.equal(day.layout.length, 1, "one continuous off-peak bar")
  assert.equal(day.layout[0].peak, false)
})

test("the Spring Festival run is longer than any fixed horizon could reach", () => {
  const start = S.stateAt(at(2026, 2, 13, 10, 0), holidays)
  assert.equal(start.peak, false)
  assert.equal(iso(start.nextSwitchMs), iso(at(2026, 2, 24, 1, 0)))

  const inside = S.stateAt(at(2026, 2, 20, 3, 0), holidays)
  assert.ok(inside.nextSwitchMs - inside.currentStartMs > 10 * 24 * 3600 * 1000,
    "the run is more than ten days long")
  assert.equal(iso(inside.currentStartMs), iso(at(2026, 2, 13, 10, 0)))
  assert.equal(iso(inside.nextSwitchMs), iso(at(2026, 2, 24, 1, 0)))
  assert.equal(inside.peak, false)
  assert.equal(S.isPeakAt(at(2026, 2, 24, 1, 0), holidays), true)
})

test("the 调休 make-up workdays change nothing: they are weekends either way", () => {
  for (const [month, day] of [[1, 4], [2, 14], [2, 28], [5, 9], [9, 20], [10, 10]]) {
    const ms = at(2026, month, day, 2, 0)
    const weekday = new Date(ms).getUTCDay()
    assert.ok(weekday === 0 || weekday === 6, `2026-${month}-${day} is not a weekend`)
    assert.equal(S.isPeakAt(ms, holidays), false, `2026-${month}-${day} must be off-peak`)
  }
})

test("a table changes only the dates it names", () => {
  const table = { "2026-09-09": "test" }
  assert.equal(S.isPeakAt(at(2026, 9, 9, 1, 0), table), false)
  assert.equal(S.isPeakAt(at(2026, 9, 9, 6, 0), table), false)
  assert.equal(S.isPeakAt(at(2026, 9, 10, 1, 0), table), true, "Thursday is untouched")
  assert.equal(S.holidayName(at(2026, 9, 9, 1, 0), table), "test")
  assert.equal(S.holidayName(at(2026, 9, 10, 1, 0), table), "", "no holiday, no name")
})

test("the holiday a name belongs to is the Beijing date's", () => {
  assert.equal(S.holidayName(at(2026, 10, 7, 15, 59), holidays), "国庆节")
  assert.equal(S.holidayName(at(2026, 10, 7, 16, 0), holidays), "", "already 10-08 in Beijing")
  assert.equal(S.holidayName(at(2026, 10, 6, 15, 0), holidays), "国庆节", "Beijing 23:00 on the 6th")

  assert.equal(S.beijingDateKey(at(2026, 12, 31, 15, 59)), "2026-12-31")
  assert.equal(S.beijingDateKey(at(2026, 12, 31, 16, 0)), "2027-01-01")
  assert.equal(S.beijingYear(at(2026, 12, 31, 16, 0)), 2027)
  assert.equal(S.beijingDateKey(at(2026, 12, 31, 16, 0)), S.dateKeyUtc(at(2027, 1, 1, 0, 0)),
    "the Beijing date is the UTC date eight hours later")
})

test("a whole holiday window never goes backwards or negative", () => {
  let previous
  for (let ms = at(2026, 9, 29, 0, 0); ms < at(2026, 10, 10, 0, 0); ms += 5 * 60 * 1000) {
    const state = S.stateAt(ms, holidays)
    assert.ok(state.secondsToSwitch >= 0, `negative at ${iso(ms)}`)
    assert.ok(state.nextSwitchMs >= ms, `a switch in the past at ${iso(ms)}`)
    if (previous) {
      assert.ok(state.nextSwitchMs >= previous.nextSwitchMs, `switch time moved back at ${iso(ms)}`)
      assert.ok(state.currentStartMs >= previous.currentStartMs, `run start moved back at ${iso(ms)}`)
    }
    previous = state
  }
})
