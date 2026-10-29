// The public status document consumed by the widget and by scripts.
//
// All instants are absolute milliseconds plus their UTC ISO form. Local wall
// clock values are deliberately absent: the server's timezone is not the
// viewer's, and a label computed in the container would be wrong in a browser
// two zones away. The client formats local time from the instants.

"use strict"

const Schedule = require("./schedule")

const API_VERSION = 1

function buildStatus(input) {
  const nowMs = Number.isFinite(Number(input && input.nowMs)) ? Number(input.nowMs) : Date.now()
  const table = input && input.holidays && typeof input.holidays === "object" ? input.holidays : {}
  const billing = Schedule.stateAt(nowMs, table)
  const holidaySnapshot = input && input.holidaySnapshot ? input.holidaySnapshot : null
  const balanceSnapshot = input && input.balanceSnapshot ? input.balanceSnapshot : null
  const pollAfterMs = clampInt(input && input.pollAfterMs, 10000, 300000, 30000)
  const version = input && typeof input.version === "string" ? input.version : "0.0.0"
  const timeFormat = input && input.timeFormat === "12h" ? "12h" : "24h"

  const holidays = publicHolidayMeta(holidaySnapshot)
  const summary = Schedule.scheduleSummary(holidays.tableYears.join(", "))

  return {
    id: "deepseek-offpeak",
    apiVersion: API_VERSION,
    version,
    generatedAtMs: nowMs,
    pollAfterMs,
    timeFormat,

    peak: billing.peak,
    state: billing.peak ? "peak" : "off-peak",
    phaseLabel: billing.peak ? "Peak" : "Off-peak",
    holidayName: Schedule.holidayName(nowMs, table),

    nowMs,
    nowUtc: Schedule.isoUtc(nowMs),
    nowUtcClock: Schedule.hhmmUtc(nowMs),
    nowBeijingClock: beijingClock(nowMs),
    nowBeijingDate: beijingDate(nowMs),

    currentPeriodStartMs: billing.currentStartMs,
    currentPeriodStartUtc: Schedule.isoUtc(billing.currentStartMs),
    nextSwitchMs: billing.nextSwitchMs,
    nextSwitchUtc: Schedule.isoUtc(billing.nextSwitchMs),
    nextSwitchUtcClock: Schedule.hhmmUtc(billing.nextSwitchMs),
    nextSwitchUtcDay: Schedule.utcDayLabel(billing.nextSwitchMs),
    nextSwitchLabel: billing.peak ? "Off-peak starts" : "Peak starts",
    secondsToSwitch: billing.secondsToSwitch,
    nextOffPeakStartMs: billing.nextOffPeakStartMs,
    nextOffPeakStartUtc: Schedule.isoUtc(billing.nextOffPeakStartMs),
    offPeakEndMs: billing.offPeakEndMs,
    offPeakEndUtc: Schedule.isoUtc(billing.offPeakEndMs),
    secondsToOffPeakEnd: billing.secondsToOffPeakEnd,
    peakEndMs: billing.peakEndMs,

    // Enough merged runs to build a local-day timeline in any timezone. The
    // longest run the timetable produces is the Spring Festival break; JSON
    // stays small because only boundaries are sent.
    runs: billingRuns(nowMs, table),

    schedule: {
      summary,
      peakWindows: [
        { startMinuteUtc: 60, endMinuteUtc: 240, utc: "01:00-04:00", beijing: "09:00-12:00" },
        { startMinuteUtc: 360, endMinuteUtc: 600, utc: "06:00-10:00", beijing: "14:00-18:00" }
      ]
    },
    holidays,
    balance: publicBalance(balanceSnapshot)
  }
}

function billingRuns(nowMs, table) {
  const runs = Schedule.runsAround(nowMs, table)
  return runs.map((run) => ({
    startMs: run.startMs,
    endMs: run.endMs,
    peak: run.peak === true
  }))
}

function publicHolidayMeta(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return {
      enabled: false,
      currentYear: null,
      currentYearSource: "missing",
      tableYears: [],
      stale: true,
      warnings: ["holiday_data_unavailable"],
      lastAttemptAtMs: 0,
      lastSuccessAtMs: 0,
      lastError: "",
      refreshing: false,
      years: {}
    }
  }

  return {
    enabled: snapshot.enabled === true,
    currentYear: finiteInt(snapshot.currentYear),
    currentYearSource: typeof snapshot.currentYearSource === "string" ? snapshot.currentYearSource : "missing",
    tableYears: Array.isArray(snapshot.tableYears) ? snapshot.tableYears.filter(Number.isInteger) : [],
    stale: snapshot.stale === true,
    warnings: Array.isArray(snapshot.warnings) ? snapshot.warnings.filter((x) => typeof x === "string") : [],
    lastAttemptAtMs: finiteInt(snapshot.lastAttemptAtMs),
    lastSuccessAtMs: finiteInt(snapshot.lastSuccessAtMs),
    lastError: typeof snapshot.lastError === "string" ? snapshot.lastError : "",
    refreshing: snapshot.refreshing === true,
    years: publicYearMeta(snapshot.years)
  }
}

function publicYearMeta(years) {
  if (!years || typeof years !== "object" || Array.isArray(years)) return {}
  const out = {}
  for (const [year, meta] of Object.entries(years)) {
    if (!/^\d{4}$/.test(year) || !meta || typeof meta !== "object") continue
    out[year] = {
      source: typeof meta.source === "string" ? meta.source : "fallback",
      fetchedAtMs: finiteInt(meta.fetchedAtMs),
      error: typeof meta.error === "string" ? meta.error : ""
    }
  }
  return out
}

function publicBalance(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return {
      enabled: false,
      status: "disabled",
      error: "",
      errorMessage: "",
      isAvailable: false,
      balances: [],
      updatedAtMs: 0,
      lastAttemptAtMs: 0,
      lastGoodAtMs: 0,
      nextRefreshAtMs: 0,
      refreshing: false,
      stale: false
    }
  }

  const balances = Array.isArray(snapshot.balances)
    ? snapshot.balances.filter((entry) => entry && typeof entry === "object").map((entry) => ({
      currency: typeof entry.currency === "string" ? entry.currency : "",
      totalBalance: typeof entry.totalBalance === "string" ? entry.totalBalance : "0",
      grantedBalance: typeof entry.grantedBalance === "string" ? entry.grantedBalance : "0",
      toppedUpBalance: typeof entry.toppedUpBalance === "string" ? entry.toppedUpBalance : "0"
    }))
    : []

  return {
    enabled: snapshot.enabled === true,
    status: typeof snapshot.status === "string" ? snapshot.status : "disabled",
    error: typeof snapshot.error === "string" ? snapshot.error : "",
    errorMessage: typeof snapshot.errorMessage === "string" ? snapshot.errorMessage : "",
    isAvailable: snapshot.isAvailable === true,
    balances,
    updatedAtMs: finiteInt(snapshot.updatedAtMs),
    lastAttemptAtMs: finiteInt(snapshot.lastAttemptAtMs),
    lastGoodAtMs: finiteInt(snapshot.lastGoodAtMs),
    nextRefreshAtMs: finiteInt(snapshot.nextRefreshAtMs),
    refreshing: snapshot.refreshing === true,
    stale: snapshot.stale === true
  }
}

function beijingClock(ms) {
  const d = new Date(Number(ms) + Schedule.BEIJING_OFFSET_MS)
  return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0")
}

function beijingDate(ms) {
  return Schedule.beijingDateKey(ms)
}

function finiteInt(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.round(number)))
}

module.exports = { buildStatus, API_VERSION, publicHolidayMeta, publicBalance }
