// Holiday table self-check. Run: node --test test/holidays.test.js
//
// The parse is the trust boundary: fetched text ends up on screen and changes
// which days bill as peak. The baked table is data, checked against the notice
// it was transcribed from.

"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const H = require("../src/holidays")

function document(days, year) {
  return JSON.stringify({ year: year === undefined ? 2026 : year, days: days })
}

const offDay = (date, name) => ({ name: name === undefined ? "春节" : name, date: date, isOffDay: true })
const workday = (date, name) => ({ name: name === undefined ? "春节" : name, date: date, isOffDay: false })

test("a document parses into the dates the schedule keys on", () => {
  const parsed = H.parse(document([
    offDay("2026-10-01", "国庆节"), workday("2026-10-10", "国庆节"), offDay("2026-10-02", "国庆节")
  ]))
  assert.equal(parsed.ok, true, parsed.error)
  assert.deepEqual(Object.keys(parsed.days).sort(), ["2026-10-01", "2026-10-02"])
  assert.equal(parsed.days["2026-10-01"], "国庆节")
})

test("make-up workdays are dropped, not stored", () => {
  const parsed = H.parse(document([workday("2026-02-14"), workday("2026-02-28")]))
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.days, {})
})

test("a document that is not the documented shape is rejected whole", () => {
  const cases = [
    ["", "empty"],
    ["not json", "not JSON"],
    ["[]", "an array"],
    ["null", "null"],
    [JSON.stringify({}), "no days"],
    [document("nope"), "days is not an array"],
    [document([1, 2, 3]), "entries are not objects"],
    [document([offDay("2026-10-1")]), "a date without its leading zero"],
    [document([offDay("2026-02-30")]), "a date that does not exist"],
    [document([offDay("2026-13-01")]), "a month that does not exist"],
    [document([offDay("2026-10-01", "")]), "an empty name"],
    [document([offDay("2026-10-01", "x".repeat(H.MAX_NAME_LENGTH + 1))]), "an oversized name"],
    [document([offDay("2026-10-01", "国庆\u001b[31m节")]), "a control character in the name"],
    [document([offDay("2026-10-01", null)]), "a null name"],
    [document([offDay("2026-10-01", "国庆节")], 2025), "a date from another year"],
    [document(new Array(H.MAX_DAYS + 1).fill(offDay("2026-10-01"))), "too many days"],
    ["x".repeat(H.MAX_CACHE_BYTES + 1), "oversized"]
  ]
  for (const [text, label] of cases) {
    const parsed = H.parse(text)
    assert.equal(parsed.ok, false, `${label} was accepted`)
    assert.equal(parsed.error, H.ERROR_INVALID, label)
    assert.deepEqual(parsed.days, {}, label)
  }
  for (const value of [null, undefined, 42, {}]) {
    assert.equal(H.parse(value).ok, false, String(value))
  }
})

test("a document with no declared year is still usable", () => {
  const parsed = H.parse(JSON.stringify({ days: [offDay("2026-10-01")] }))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.days["2026-10-01"], "春节")
})

test("the baked table is the published 2026 arrangement", () => {
  const spans = [
    ["元旦", "2026-01-01", "2026-01-03"],
    ["春节", "2026-02-15", "2026-02-23"],
    ["清明节", "2026-04-04", "2026-04-06"],
    ["劳动节", "2026-05-01", "2026-05-05"],
    ["端午节", "2026-06-19", "2026-06-21"],
    ["中秋节", "2026-09-25", "2026-09-27"],
    ["国庆节", "2026-10-01", "2026-10-07"]
  ]

  const expected = {}
  for (const [name, from, to] of spans) {
    for (let ms = Date.parse(from + "T00:00:00Z"); ms <= Date.parse(to + "T00:00:00Z"); ms += 86400000) {
      const date = new Date(ms).toISOString().slice(0, 10)
      assert.equal(expected[date], undefined, `${date} is in two spans`)
      expected[date] = name
    }
  }

  const table = H.fallback()
  assert.deepEqual(table, expected, "the baked table is not the published arrangement")
  assert.equal(Object.keys(table).length, 33, "33 放假 days in 2026")
  assert.deepEqual(H.yearsOf(table), [2026])
})

test("every baked date is a real date", () => {
  for (const key of Object.keys(H.FALLBACK)) {
    assert.ok(H.isDateKey(key), key)
    assert.equal(typeof H.FALLBACK[key], "string")
    assert.ok(H.FALLBACK[key].length > 0 && H.FALLBACK[key].length <= H.MAX_NAME_LENGTH, key)
  }
})

test("the baked table is handed out as a copy", () => {
  const table = H.fallback()
  table["2026-10-01"] = "something else"
  table["2026-12-25"] = "yes"
  assert.equal(H.FALLBACK["2026-10-01"], "国庆节", "the module's own table was edited")
  assert.equal(H.FALLBACK["2026-12-25"], undefined)
})

test("cache documents override the baked table, and junk is skipped", () => {
  const table = H.tableFromTexts([document([offDay("2026-10-01", "National Day")])])
  assert.equal(table["2026-10-01"], "National Day")
  assert.deepEqual(H.yearsOf(table), [2026])

  const strayed = H.tableFromTexts([document([
    offDay("2026-10-01", "National Day"), offDay("2027-01-01", "New Year")
  ], 2026)])
  assert.equal(strayed["2026-10-01"], "国庆节")
  assert.equal(strayed["2027-01-01"], undefined)

  const merged = H.tableFromTexts([JSON.stringify({ days: [offDay("2027-01-01", "New Year")] })])
  assert.equal(merged["2027-01-01"], "New Year")
  assert.equal(merged["2026-10-01"], "国庆节", "the baked table is still underneath")
  assert.deepEqual(H.yearsOf(merged), [2026, 2027])

  for (const texts of [[], null, undefined, [null, "", "not json", {}], "nope"]) {
    assert.deepEqual(H.tableFromTexts(texts), H.FALLBACK, JSON.stringify(texts))
  }
})

test("years are read off the table, ascending and once each", () => {
  assert.deepEqual(H.yearsOf({}), [])
  assert.deepEqual(H.yearsOf(null), [])
  assert.deepEqual(H.yearsOf({ "2027-01-01": "a", "2026-10-01": "b", "2026-01-01": "c" }), [2026, 2027])
  assert.deepEqual(H.yearsOf({ "nonsense": "a" }), [])
})

test("holiday-cn URLs name the year document", () => {
  for (const year of [2026, 2027]) {
    assert.ok(H.sourceUrl(year).endsWith("/" + year + ".json"), H.sourceUrl(year))
    assert.ok(H.sourceUrl(year).startsWith("https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/"))
  }
})

test("the Beijing date helper is the date a holiday table uses", () => {
  assert.equal(H.dateKeyInZone(Date.UTC(2026, 11, 31, 15, 59), 8 * 3600000), "2026-12-31")
  assert.equal(H.dateKeyInZone(Date.UTC(2026, 11, 31, 16, 0), 8 * 3600000), "2027-01-01")
})
