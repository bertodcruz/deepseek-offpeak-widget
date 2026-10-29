// Holiday cache and refresh service self-check. Run: node --test test/holiday-service.test.js

"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")

const { HolidayService, readCapped, BodyTooLarge, cacheFileName } = require("../src/holiday-service")
const Holidays = require("../src/holidays")

const NOW = Date.UTC(2026, 8, 9, 2, 0)

function doc(year, days) {
  return JSON.stringify({ year, days })
}

function service(cacheDir, options) {
  return new HolidayService(Object.assign({
    cacheDir,
    disabled: false,
    refreshMs: 7 * 24 * 3600 * 1000,
    fetchTimeoutMs: 1000,
    retryMs: 60 * 1000,
    now: () => NOW,
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  }, options || {}))
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "deepseek-offpeak-test-"))
}

test("a valid cache document is merged over the baked table", async () => {
  const dir = await tempDir()
  const svc = service(dir, { disabled: true })
  const text = doc(2026, [
    { name: "Test holiday", date: "2026-09-09", isOffDay: true },
    { name: "Test workday", date: "2026-09-12", isOffDay: false }
  ])
  await fs.writeFile(path.join(dir, cacheFileName(2026)), text)

  const snap = await svc.start()
  assert.equal(snap.currentYearSource, "cache")
  assert.equal(snap.years["2026"].source, "cache")
  assert.equal(svc.getTable()["2026-09-09"], "Test holiday")
  assert.equal(svc.getTable()["2026-09-12"], undefined, "make-up workdays are not stored")
  assert.equal(svc.getTable()["2026-10-01"], "国庆节", "baked dates remain")
  assert.ok(snap.warnings.includes("holiday_refresh_disabled"))
  svc.stop()
  await fs.rm(dir, { recursive: true, force: true })
})

test("a valid fetch is cached atomically and adopted", async () => {
  const dir = await tempDir()
  let calls = 0
  const svc = service(dir, {
    fetchImpl: async (url) => {
      calls++
      assert.ok(url.endsWith("/2026.json"))
      return {
        status: 200,
        text: async () => doc(2026, [{ name: "Fetched", date: "2026-09-09", isOffDay: true }])
      }
    }
  })
  await svc.start()
  const snap = await svc.refresh({ force: true })
  assert.equal(calls, 1)
  assert.equal(snap.currentYearSource, "fetched")
  assert.equal(snap.years["2026"].source, "fetched")
  assert.equal(svc.getTable()["2026-09-09"], "Fetched")
  const cached = await fs.readFile(path.join(dir, cacheFileName(2026)), "utf8")
  assert.equal(cached, doc(2026, [{ name: "Fetched", date: "2026-09-09", isOffDay: true }]))
  const stat = await fs.stat(path.join(dir, cacheFileName(2026)))
  if (process.platform !== "win32") {
    assert.equal(stat.mode & 0o777, 0o600, "cache file is private on POSIX")
  }
  svc.stop()
  await fs.rm(dir, { recursive: true, force: true })
})

test("an invalid response is rejected whole and does not write a cache", async () => {
  const dir = await tempDir()
  const svc = service(dir, {
    fetchImpl: async () => ({
      status: 200,
      text: async () => '{"year":2026,"days":[{"isOffDay":true,"date":"bad"}]}'
    })
  })
  await svc.start()
  const snap = await svc.refresh({ force: true })
  assert.equal(snap.lastError, "invalid_holiday_data")
  assert.ok(snap.warnings.includes("holiday_fetch_failed"))
  assert.equal(snap.currentYearSource, "fallback")
  await assert.rejects(fs.readFile(path.join(dir, cacheFileName(2026))))
  svc.stop()
  await fs.rm(dir, { recursive: true, force: true })
})

test("a failed fetch keeps the last good cache", async () => {
  const dir = await tempDir()
  const text = doc(2026, [{ name: "Cached", date: "2026-09-09", isOffDay: true }])
  await fs.writeFile(path.join(dir, cacheFileName(2026)), text)
  const svc = service(dir, {
    fetchImpl: async () => { throw new Error("boom") }
  })
  await svc.start()
  const snap = await svc.refresh({ force: true })
  assert.equal(snap.lastError, "network_error")
  assert.equal(snap.currentYearSource, "cache", "the cached document is still what the schedule uses")
  assert.equal(snap.years["2026"].source, "cache")
  assert.equal(snap.years["2026"].error, "network_error")
  assert.ok(snap.warnings.includes("holiday_fetch_failed"))
  assert.equal(svc.getTable()["2026-09-09"], "Cached")
  assert.equal(await fs.readFile(path.join(dir, cacheFileName(2026)), "utf8"), text)
  svc.stop()
  await fs.rm(dir, { recursive: true, force: true })
})

test("an unusable cache directory is retried on the failure schedule", async () => {
  const dir = await tempDir()
  const notADirectory = path.join(dir, "cache-is-a-file")
  await fs.writeFile(notADirectory, "x")
  const svc = service(notADirectory, {
    fetchImpl: async () => ({
      status: 200,
      text: async () => doc(2026, [{ name: "Recovered", date: "2026-09-09", isOffDay: true }])
    })
  })
  let scheduledWith
  svc.scheduleNext = (failed) => { scheduledWith = failed }

  const snap = await svc.refresh({ force: true })
  assert.equal(snap.lastError, "cache_unavailable")
  assert.equal(scheduledWith, true, "cache failures must not wait a full refresh interval")

  // The retry re-checks the directory instead of remembering the failure.
  await fs.rm(notADirectory)
  const recovered = await svc.refresh({ force: true })
  assert.equal(recovered.currentYearSource, "fetched")
  assert.equal(svc.getTable()["2026-09-09"], "Recovered")

  svc.stop()
  await fs.rm(dir, { recursive: true, force: true })
})

test("a corrupt cache is ignored, not merged", async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, cacheFileName(2026)), "not json")
  const svc = service(dir, { disabled: true })
  const snap = await svc.start()
  assert.equal(snap.currentYearSource, "fallback")
  assert.equal(snap.years["2026"].error, "invalid_holiday_data")
  assert.equal(svc.getTable()["2026-10-01"], "国庆节")
  svc.stop()
  await fs.rm(dir, { recursive: true, force: true })
})

test("a stale cache is refreshed", async () => {
  const dir = await tempDir()
  const file = path.join(dir, cacheFileName(2026))
  await fs.writeFile(file, doc(2026, [{ name: "Old", date: "2026-09-09", isOffDay: true }]))
  const old = new Date(NOW - Holidays.STALE_AFTER_MS - 1000)
  await fs.utimes(file, old, old)

  const svc = service(dir, {
    fetchImpl: async () => ({
      status: 200,
      text: async () => doc(2026, [{ name: "New", date: "2026-09-09", isOffDay: true }])
    })
  })
  await svc.start()
  const snap = await svc.refresh()
  assert.equal(snap.years["2026"].source, "fetched")
  assert.equal(svc.getTable()["2026-09-09"], "New")
  svc.stop()
  await fs.rm(dir, { recursive: true, force: true })
})

test("refresh is single-flight", async () => {
  const dir = await tempDir()
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const svc = service(dir, {
    fetchImpl: async () => {
      calls++
      await gate
      return { status: 200, text: async () => doc(2026, []) }
    }
  })
  await svc.start()
  const first = svc.refresh({ force: true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  const second = svc.refresh({ force: true })
  assert.equal(first, second, "the same promise is returned")
  assert.equal(calls, 1, "only one request started")
  release()
  await first
  assert.equal(calls, 1)
  svc.stop()
  await fs.rm(dir, { recursive: true, force: true })
})

test("the next year is fetched only inside the lead window", async () => {
  const dir = await tempDir()
  const january = service(dir, { now: () => Date.UTC(2026, 0, 15, 2, 0) })
  assert.deepEqual(january.targetYears().fetch, [2026])
  assert.deepEqual(january.targetYears().read, [2026, 2027])
  january.stop()

  const december = service(dir, { now: () => Date.UTC(2026, 11, 20, 2, 0) })
  assert.deepEqual(december.targetYears().fetch, [2026, 2027])
  december.stop()
  await fs.rm(dir, { recursive: true, force: true })
})

test("a year with no data at all is reported as missing", async () => {
  const dir = await tempDir()
  const svc = service(dir, { disabled: true, now: () => Date.UTC(2027, 2, 1, 2, 0) })
  const snap = await svc.start()
  assert.equal(snap.currentYear, 2027)
  assert.equal(snap.currentYearSource, "missing")
  assert.ok(snap.warnings.includes("holiday_data_missing_2027"))
  svc.stop()
  await fs.rm(dir, { recursive: true, force: true })
})

test("the cached read is capped at the byte limit", async () => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("x".repeat(32)))
      controller.enqueue(encoder.encode("y".repeat(32)))
      controller.close()
    }
  })
  await assert.rejects(readCapped({ body: stream }, 16), BodyTooLarge)
})

test("the cache file name is year-specific", () => {
  assert.equal(cacheFileName(2026), "holidays-2026.json")
  assert.equal(cacheFileName("2027"), "holidays-2027.json")
})
