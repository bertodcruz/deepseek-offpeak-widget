// Browser core derivation self-check. Run: node --test test/widget-core.test.js
//
// The browser does no billing math. These tests pin the parts it does own:
// local formatting, clipping the server's runs to the viewer's day, and
// deriving labels from absolute instants.

"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")

const core = require("../public/widget-core")
const Schedule = require("../src/schedule")
const Holidays = require("../src/holidays")

const holidays = Holidays.fallback()
const at = (y, m, d, h, min) => Date.UTC(y, m - 1, d, h || 0, min || 0)

function statusAt(ms) {
  const state = Schedule.stateAt(ms, holidays)
  return {
    nowMs: ms,
    peak: state.peak,
    holidayName: Schedule.holidayName(ms, holidays),
    nextSwitchMs: state.nextSwitchMs,
    nextSwitchLabel: state.peak ? "Off-peak starts" : "Peak starts",
    currentPeriodStartMs: state.currentStartMs,
    offPeakEndMs: state.offPeakEndMs,
    runs: Schedule.runsAround(ms, holidays)
  }
}

test("formatClock and formatAge are stable and compact", () => {
  assert.equal(core.formatClock(0), "0:00:00")
  assert.equal(core.formatClock(3661), "1:01:01")
  assert.equal(core.formatClock(11 * 3600 + 5), "11:00:05")
  assert.equal(core.formatClock(-5), "0:00:00")
  assert.equal(core.formatAge(0, 1000), "just now")
  assert.equal(core.formatAge(0, 12000), "12s ago")
  assert.equal(core.formatAge(0, 65000), "1m ago")
  assert.equal(core.formatAge(0, 3700000), "1h ago")
  assert.equal(core.formatAge(0, 90000000), "1d ago")
})

test("offsetLabel is an offset, not an abbreviation", () => {
  const label = core.offsetLabel(at(2026, 9, 9, 2, 0))
  assert.match(label, /^UTC[+-]\d{2}:\d{2}$/, label)
  const minutes = -new Date(at(2026, 9, 9, 2, 0)).getTimezoneOffset()
  const match = /^UTC([+-])(\d{2}):(\d{2})$/.exec(label)
  const actual = (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
  assert.equal(actual + 0, minutes + 0)
})

test("deriveView reports the countdown, both zones, and the next change", () => {
  const ms = at(2026, 9, 9, 2, 30)
  const view = core.deriveView(statusAt(ms), ms)
  assert.equal(view.peak, true)
  assert.equal(view.phaseLabel, "Peak")
  assert.equal(view.nextSwitchLabel, "Off-peak starts")
  assert.equal(view.remaining, 90 * 60)
  assert.equal(view.remainingClock, "1:30:00")
  assert.equal(view.nextSwitchUtcClock, "04:00")
  assert.equal(view.offPeakEndUtcClock, "06:00")
  assert.equal(view.nowUtcClock, "02:30")
  assert.equal(view.nowBeijingClock, "10:30")
  assert.match(view.nextSwitchLocalClock, /^\d{2}:\d{2}$/)
  assert.match(view.nextSwitchLocalDay, /^[A-Z][a-z]{2} \d{2}-\d{2}$/)
})

test("the 12-hour clock uses compact am/pm labels", () => {
  assert.equal(core.normalizeTimeFormat("12h"), "12h")
  assert.equal(core.normalizeTimeFormat("ampm"), "12h")
  assert.equal(core.normalizeTimeFormat("24h"), "24h")
  assert.equal(core.normalizeTimeFormat("nonsense"), "24h")
  assert.equal(core.hhmmUtc(at(2026, 9, 9, 0, 0)), "00:00")
  assert.equal(core.hhmmUtc(at(2026, 9, 9, 0, 0), "12h"), "12am")
  assert.equal(core.hhmmUtc(at(2026, 9, 9, 4, 0), "12h"), "4am")
  assert.equal(core.hhmmUtc(at(2026, 9, 9, 12, 0), "12h"), "12pm")
  assert.equal(core.hhmmUtc(at(2026, 9, 9, 19, 0), "12h"), "7pm")
  assert.equal(core.hhmmUtc(at(2026, 9, 9, 19, 30), "12h"), "7:30pm")
})

test("deriveView and the timeline can render regular time", () => {
  const ms = at(2026, 9, 9, 2, 30)
  const view = core.deriveView(statusAt(ms), ms, "12h")
  assert.equal(view.nowUtcClock, "2:30am")
  assert.equal(view.nowBeijingClock, "10:30am")
  assert.equal(view.nextSwitchUtcClock, "4am")
  assert.equal(view.offPeakEndUtcClock, "6am")
  assert.match(view.nextSwitchLocalClock, /^\d{1,2}(:\d{2})?[ap]m$/)
  assert.match(view.day.axis[0].label, /^\d{1,2}[ap]$/)
  assert.match(view.day.peaks[0].utcLabel, /^\d{1,2}(:\d{2})?[ap]m - \d{1,2}(:\d{2})?[ap]m$/)
})

test("the local-day timeline tiles the day and agrees with the server math", () => {
  const ms = at(2026, 9, 9, 12, 0)
  const view = core.deriveView(statusAt(ms), ms)
  const day = view.day
  assert.equal(day.available, true)
  assert.equal(day.segments[0].startFrac, 0)
  assert.ok(Math.abs(day.segments[day.segments.length - 1].endFrac - 1) < 1e-9)
  for (let i = 1; i < day.segments.length; i++) {
    assert.ok(Math.abs(day.segments[i].startFrac - day.segments[i - 1].endFrac) < 1e-9)
    assert.notEqual(day.segments[i].peak, day.segments[i - 1].peak)
  }
  const peakMs = day.segments.filter((s) => s.peak)
    .reduce((sum, s) => sum + (s.endMs - s.startMs), 0)
  assert.equal(peakMs, 7 * 3600 * 1000, "seven peak hours on an ordinary weekday")
  assert.equal(day.peaks.length, 2)
  assert.ok(day.nowFrac >= 0 && day.nowFrac <= 1)
  assert.ok(day.axis.length > 0)
  assert.equal(day.axis[0].frac, 0)
  assert.ok(Math.abs(day.axis[day.axis.length - 1].frac - 1) < 1e-9)
})

test("a holiday day has no peak segments and names the holiday", () => {
  const ms = at(2026, 10, 5, 12, 0)
  const view = core.deriveView(statusAt(ms), ms)
  assert.equal(view.holidayName, "国庆节")
  assert.equal(view.day.peaks.length, 0)
  assert.equal(view.day.segments.length, 1)
  assert.equal(view.day.holidayName, "国庆节")
})

test("a weekend day has one continuous off-peak segment", () => {
  const ms = at(2026, 9, 12, 12, 0)
  const view = core.deriveView(statusAt(ms), ms)
  assert.equal(view.day.segments.length, 1)
  assert.equal(view.day.segments[0].peak, false)
  assert.equal(view.day.peaks.length, 0)
})

test("an empty run list degrades to an unavailable timeline", () => {
  const view = core.deriveView({
    nowMs: at(2026, 9, 9, 2, 0),
    peak: true,
    nextSwitchMs: at(2026, 9, 9, 4, 0),
    offPeakEndMs: at(2026, 9, 9, 6, 0),
    currentPeriodStartMs: at(2026, 9, 9, 1, 0),
    runs: []
  }, at(2026, 9, 9, 2, 0))
  assert.equal(view.day.available, false)
  assert.deepEqual(view.day.segments, [])
})

test("runs are clipped and adjacent segments are merged", () => {
  const ms = at(2026, 9, 9, 12, 0)
  const bounds = core.localDayBounds(ms)
  const runs = [
    { startMs: bounds.startMs - 3600000, endMs: bounds.startMs + 3600000, peak: false },
    { startMs: bounds.startMs + 3600000, endMs: bounds.endMs + 3600000, peak: true }
  ]
  const day = core.localDayView(runs, ms, "")
  assert.equal(day.available, true)
  assert.equal(day.segments.length, 2)
  assert.equal(day.segments[0].startMs, bounds.startMs)
  assert.equal(day.segments[day.segments.length - 1].endMs, bounds.endMs)
})
