// Public status document self-check. Run: node --test test/status.test.js

"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const Status = require("../src/status")
const Schedule = require("../src/schedule")
const Holidays = require("../src/holidays")

const at = (y, m, d, h, min) => Date.UTC(y, m - 1, d, h || 0, min || 0)
const holidays = Holidays.fallback()

function build(ms, extras) {
  return Status.buildStatus(Object.assign({
    nowMs: ms,
    holidays: holidays,
    holidaySnapshot: {
      enabled: true,
      currentYear: 2026,
      currentYearSource: "cache",
      tableYears: [2026],
      stale: false,
      warnings: [],
      lastAttemptAtMs: ms,
      lastSuccessAtMs: ms,
      lastError: "",
      refreshing: false,
      years: { 2026: { source: "cache", fetchedAtMs: ms, error: "" } }
    },
    balanceSnapshot: {
      enabled: true,
      status: "ok",
      error: "",
      errorMessage: "",
      isAvailable: true,
      balances: [{ currency: "CNY", totalBalance: "110.00", grantedBalance: "10.00", toppedUpBalance: "100.00" }],
      updatedAtMs: ms,
      lastAttemptAtMs: ms,
      lastGoodAtMs: ms,
      nextRefreshAtMs: ms + 300000,
      refreshing: false,
      stale: false
    },
    pollAfterMs: 30000,
    version: "1.0.0"
  }, extras || {}))
}

test("the public document carries a normalized clock style", () => {
  assert.equal(build(at(2026, 9, 9, 2, 30)).timeFormat, "24h")
  assert.equal(build(at(2026, 9, 9, 2, 30), { timeFormat: "12h" }).timeFormat, "12h")
  assert.equal(build(at(2026, 9, 9, 2, 30), { timeFormat: "bogus" }).timeFormat, "24h")
})

test("peak state carries the countdown and the next switch", () => {
  const status = build(at(2026, 9, 9, 2, 30))
  assert.equal(status.peak, true)
  assert.equal(status.state, "peak")
  assert.equal(status.phaseLabel, "Peak")
  assert.equal(status.nextSwitchLabel, "Off-peak starts")
  assert.equal(status.secondsToSwitch, 90 * 60)
  assert.equal(status.nextSwitchMs, at(2026, 9, 9, 4, 0))
  assert.equal(status.nextSwitchUtc, "2026-09-09T04:00:00.000Z")
  assert.equal(status.nowUtc, "2026-09-09T02:30:00.000Z")
  assert.equal(status.nowUtcClock, "02:30")
  assert.equal(status.nowBeijingClock, "10:30")
  assert.equal(status.nowBeijingDate, "2026-09-09")
  assert.match(status.schedule.summary, /Chinese public holidays all day \(2026\)/)
})

test("off-peak state names the upcoming peak start", () => {
  const status = build(at(2026, 9, 9, 4, 30))
  assert.equal(status.peak, false)
  assert.equal(status.state, "off-peak")
  assert.equal(status.nextSwitchLabel, "Peak starts")
  assert.equal(status.nextSwitchMs, at(2026, 9, 9, 6, 0))
})

test("every *Utc field is an ISO instant, not a clock string", () => {
  const status = build(at(2026, 9, 9, 2, 30))
  for (const key of ["nowUtc", "nextSwitchUtc", "currentPeriodStartUtc",
    "nextOffPeakStartUtc", "offPeakEndUtc"]) {
    const value = status[key]
    assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `${key}: ${value}`)
    assert.ok(!Number.isNaN(Date.parse(value)), `${key} does not parse: ${value}`)
  }
})

test("the status carries enough runs to build a local-day timeline", () => {
  const status = build(at(2026, 9, 9, 2, 30))
  assert.ok(Array.isArray(status.runs))
  assert.ok(status.runs.length > 0)
  const run = status.runs.find((entry) => entry.startMs <= status.nowMs && status.nowMs < entry.endMs)
  assert.ok(run, "a run contains now")
  assert.equal(run.peak, true)
  for (const entry of status.runs) {
    assert.ok(Number.isFinite(entry.startMs) && Number.isFinite(entry.endMs))
    assert.ok(entry.endMs > entry.startMs)
    assert.equal(typeof entry.peak, "boolean")
  }
})

test("a holiday is named and is off-peak all day", () => {
  const status = build(at(2026, 10, 5, 2, 0))
  assert.equal(status.peak, false)
  assert.equal(status.holidayName, "国庆节")
  const run = status.runs.find((entry) => entry.startMs <= status.nowMs && status.nowMs < entry.endMs)
  assert.equal(run.peak, false)
})

test("holiday metadata is public and contains no cache path", () => {
  const status = build(at(2026, 9, 9, 2, 30))
  assert.equal(status.holidays.currentYearSource, "cache")
  assert.deepEqual(status.holidays.tableYears, [2026])
  assert.equal(status.holidays.cacheDir, undefined)
  assert.equal(status.holidays.years["2026"].source, "cache")
})

test("missing holiday metadata degrades instead of throwing", () => {
  const status = build(at(2026, 9, 9, 2, 30), { holidaySnapshot: null, holidays: {} })
  assert.equal(status.holidays.enabled, false)
  assert.equal(status.holidays.currentYearSource, "missing")
  assert.deepEqual(status.holidays.warnings, ["holiday_data_unavailable"])
  assert.equal(status.holidayName, "")
  assert.equal(status.peak, true, "the weekday rule still works with no table")
})

test("missing balance metadata is disabled, not an invented amount", () => {
  const status = build(at(2026, 9, 9, 2, 30), { balanceSnapshot: null })
  assert.equal(status.balance.enabled, false)
  assert.equal(status.balance.status, "disabled")
  assert.deepEqual(status.balance.balances, [])
  assert.equal(status.balance.errorMessage, "")
})

test("balance amounts stay strings and errors are explicit", () => {
  const status = build(at(2026, 9, 9, 2, 30), {
    balanceSnapshot: {
      enabled: true,
      status: "error",
      error: "http_503",
      errorMessage: "Balance API returned 503",
      isAvailable: false,
      balances: [],
      updatedAtMs: at(2026, 9, 9, 2, 0),
      lastAttemptAtMs: at(2026, 9, 9, 2, 30),
      lastGoodAtMs: at(2026, 9, 9, 2, 0),
      nextRefreshAtMs: at(2026, 9, 9, 2, 31),
      refreshing: false,
      stale: false
    }
  })
  assert.equal(status.balance.status, "error")
  assert.equal(status.balance.error, "http_503")
  assert.deepEqual(status.balance.balances, [])
  assert.equal(status.balance.updatedAtMs, at(2026, 9, 9, 2, 0))
  assert.equal(status.balance.lastGoodAtMs, at(2026, 9, 9, 2, 0))
})

test("the document serializes without undefined or NaN", () => {
  const status = build(at(2026, 9, 9, 2, 30))
  const text = JSON.stringify(status)
  assert.ok(!text.includes("undefined"), text)
  assert.ok(!text.includes("NaN"), text)
  assert.equal(JSON.parse(text).id, "deepseek-offpeak")
  assert.equal(JSON.parse(text).apiVersion, Status.API_VERSION)
})

test("an invalid now falls back to the current clock rather than NaN", () => {
  const status = Status.buildStatus({ nowMs: NaN, holidays: {}, pollAfterMs: 1 })
  assert.ok(Number.isFinite(status.nowMs))
  assert.ok(status.nowMs > 0)
  assert.equal(status.pollAfterMs, 10000, "poll interval is clamped")
})

test("the schedule runs agree with the schedule module at the same instant", () => {
  const ms = at(2026, 9, 9, 2, 30)
  const state = Schedule.stateAt(ms, holidays)
  const status = build(ms)
  assert.equal(status.peak, state.peak)
  assert.equal(status.nextSwitchMs, state.nextSwitchMs)
  assert.equal(status.currentPeriodStartMs, state.currentStartMs)
  assert.equal(status.secondsToSwitch, state.secondsToSwitch)
})
