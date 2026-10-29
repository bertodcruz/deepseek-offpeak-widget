// Chinese public holiday dates for the billing-window math in schedule.js.
//
// Ported from DavidHLP/deepseek-offpeak (MIT), lib/Holidays.js. The source,
// parse rules, cache semantics, and baked 2026 fallback are unchanged.
//
// DeepSeek bills a Chinese public holiday that falls on a Monday to Friday as
// off-peak all day. Weekends need no table: schedule.js already makes them
// off-peak, including the Saturdays and Sundays the State Council designates as
// make-up workdays (调休上班的周末).
//
// Dates come from holiday-cn (github.com/NateScarlet/holiday-cn), a
// machine-readable transcription of 国务院办公厅's annual notice. Only
// isOffDay:true days are kept.
//
// The parse is the trust boundary: fetched text ends up on screen and silently
// changes which days bill as peak, so every entry has to be right or the whole
// document is rejected.

"use strict"

const ERROR_INVALID = "invalid_holiday_data"

// Most a cache or response body may hold. A year of holidays is under 5 KiB.
const MAX_CACHE_BYTES = 65536

// How long a cache file is trusted before a refresh is attempted. The
// arrangement for a year is published once, in the November before it.
const STALE_AFTER_MS = 7 * 24 * 3600 * 1000

// How near a year's end the next year's document starts being asked for. It is
// published in early November; before this window a fetch is a guaranteed 404.
const NEXT_YEAR_FETCH_LEAD_MS = 60 * 24 * 3600 * 1000

// Bounds on the document's shape.
const MAX_DAYS = 400
const MAX_NAME_LENGTH = 48

// Names are display text. Reject terminal/control characters at the document
// boundary instead of letting display data become terminal instructions.
const NAME_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/

const CACHE_FILE_PREFIX = "holidays-"
const SOURCE_BASE_URL = "https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/"

// The table as a machine that has never been online sees it: 2026, transcribed
// from 国务院办公厅关于2026年部分节假日安排的通知 (国办发明电〔2025〕7号).
// It is a floor, not a second source of truth: fetched data is merged over it,
// so a year present in both is decided by the fetch.
const FALLBACK = {
  "2026-01-01": "元旦", "2026-01-02": "元旦", "2026-01-03": "元旦",
  "2026-02-15": "春节", "2026-02-16": "春节", "2026-02-17": "春节", "2026-02-18": "春节",
  "2026-02-19": "春节", "2026-02-20": "春节", "2026-02-21": "春节", "2026-02-22": "春节",
  "2026-02-23": "春节",
  "2026-04-04": "清明节", "2026-04-05": "清明节", "2026-04-06": "清明节",
  "2026-05-01": "劳动节", "2026-05-02": "劳动节", "2026-05-03": "劳动节",
  "2026-05-04": "劳动节", "2026-05-05": "劳动节",
  "2026-06-19": "端午节", "2026-06-20": "端午节", "2026-06-21": "端午节",
  "2026-09-25": "中秋节", "2026-09-26": "中秋节", "2026-09-27": "中秋节",
  "2026-10-01": "国庆节", "2026-10-02": "国庆节", "2026-10-03": "国庆节",
  "2026-10-04": "国庆节", "2026-10-05": "国庆节", "2026-10-06": "国庆节",
  "2026-10-07": "国庆节"
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isValidYear(year) {
  const value = Number(year)
  return Number.isFinite(value) && Math.floor(value) === value && value >= 2000 && value <= 2100
}

function sourceUrl(year) {
  return SOURCE_BASE_URL + Number(year) + ".json"
}

function pad2(value) {
  return value < 10 ? "0" + value : String(value)
}

// "YYYY-MM-DD" as a real calendar date.
function isDateKey(value) {
  if (typeof value !== "string") return false
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

// Parse one holiday-cn document. Returns {ok, days, error}; every failure shape
// returns an empty days object so a caller cannot merge half a document.
function parse(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_CACHE_BYTES)
    return { ok: false, days: {}, error: ERROR_INVALID }

  let payload
  try {
    payload = JSON.parse(text)
  } catch (e) {
    return { ok: false, days: {}, error: ERROR_INVALID }
  }

  if (!isPlainObject(payload)) return { ok: false, days: {}, error: ERROR_INVALID }
  if (!Array.isArray(payload.days) || payload.days.length > MAX_DAYS)
    return { ok: false, days: {}, error: ERROR_INVALID }

  // The document names its own year. When it does, every date in it has to
  // belong to that year: a stale or wrong file served for the year we asked for
  // is exactly the failure this catches.
  const declaredYear = isValidYear(payload.year) ? Number(payload.year) : null
  const yearPrefix = declaredYear === null ? "" : String(declaredYear) + "-"

  const days = {}
  for (let i = 0; i < payload.days.length; i++) {
    const entry = payload.days[i]
    if (!isPlainObject(entry)) return { ok: false, days: {}, error: ERROR_INVALID }
    if (entry.isOffDay !== true) continue
    if (!isDateKey(entry.date)) return { ok: false, days: {}, error: ERROR_INVALID }
    if (yearPrefix !== "" && entry.date.indexOf(yearPrefix) !== 0)
      return { ok: false, days: {}, error: ERROR_INVALID }
    if (typeof entry.name !== "string" || entry.name.length === 0)
      return { ok: false, days: {}, error: ERROR_INVALID }
    if (entry.name.length > MAX_NAME_LENGTH) return { ok: false, days: {}, error: ERROR_INVALID }
    if (NAME_CONTROL_RE.test(entry.name)) return { ok: false, days: {}, error: ERROR_INVALID }
    days[entry.date] = entry.name
  }
  return { ok: true, days: days, error: "" }
}

// The baked table, as a fresh object.
function fallback() {
  return merge({}, FALLBACK)
}

function merge(base, extra) {
  const out = {}
  const tables = [base, extra]
  for (let t = 0; t < tables.length; t++) {
    const table = tables[t]
    if (!isPlainObject(table)) continue
    for (const key in table) {
      if (Object.prototype.hasOwnProperty.call(table, key)) out[key] = table[key]
    }
  }
  return out
}

// The baked floor with every readable document merged over it, in order.
// Unreadable documents are skipped rather than fatal - one year that failed to
// fetch must not cost the other.
function tableFromTexts(texts) {
  let table = fallback()
  const list = Array.isArray(texts) ? texts : []
  for (let i = 0; i < list.length; i++) {
    const parsed = parse(list[i])
    if (parsed.ok) table = merge(table, parsed.days)
  }
  return table
}

// The years a table covers, ascending.
function yearsOf(table) {
  const seen = {}
  const years = []
  if (isPlainObject(table)) {
    for (const key in table) {
      if (!Object.prototype.hasOwnProperty.call(table, key)) continue
      const year = Number(String(key).slice(0, 4))
      if (!Number.isFinite(year) || seen[year]) continue
      seen[year] = true
      years.push(year)
    }
  }
  return years.sort(function (a, b) { return a - b })
}

// "2026-10-01" for a Date/ms in a given zone. Only used by the service.
function dateKeyInZone(ms, offsetMs) {
  const d = new Date(Number(ms) + Number(offsetMs || 0))
  return String(d.getUTCFullYear()) + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate())
}

module.exports = {
  ERROR_INVALID,
  MAX_CACHE_BYTES,
  MAX_DAYS,
  MAX_NAME_LENGTH,
  STALE_AFTER_MS,
  NEXT_YEAR_FETCH_LEAD_MS,
  CACHE_FILE_PREFIX,
  SOURCE_BASE_URL,
  FALLBACK,
  isValidYear,
  sourceUrl,
  isDateKey,
  parse,
  fallback,
  merge,
  tableFromTexts,
  yearsOf,
  dateKeyInZone
}
