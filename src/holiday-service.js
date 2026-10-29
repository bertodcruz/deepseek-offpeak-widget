// Holiday cache and refresh service.
//
// The schedule is always available: the baked 2026 table is the floor, cached
// documents are merged over it, and a failed fetch changes nothing. A network
// fetch is attempted weekly, or hourly after a failure, and never overlaps
// itself.

"use strict"

const fs = require("node:fs/promises")
const fssync = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")

const Holidays = require("./holidays")
const Schedule = require("./schedule")

const FETCH_HEADERS = {
  accept: "application/json",
  "user-agent": "glance-deepseek-offpeak/1 (+https://github.com/NateScarlet/holiday-cn)"
}

class BodyTooLarge extends Error {}

async function readCapped(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text()
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new BodyTooLarge()
    return text
  }

  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        try { await reader.cancel() } catch (_) { /* already gone */ }
        throw new BodyTooLarge()
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    try { reader.releaseLock() } catch (_) { /* already released */ }
  }
  return Buffer.concat(chunks).toString("utf8")
}

function cacheFileName(year) {
  return Holidays.CACHE_FILE_PREFIX + Number(year) + ".json"
}

class HolidayService {
  constructor(options) {
    this.cacheDir = options.cacheDir
    this.disabled = options.disabled === true
    this.refreshMs = options.refreshMs
    this.fetchTimeoutMs = options.fetchTimeoutMs
    this.retryMs = options.retryMs
    this.now = options.now || (() => Date.now())
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.logger = options.logger || { info() {}, warn() {}, error() {}, debug() {} }

    this.cacheTexts = new Map() // year -> validated document text
    this.yearMeta = new Map()   // year -> {source, fetchedAtMs, error}
    this.table = Holidays.fallback()
    this.tableYears = Holidays.yearsOf(this.table)
    this.lastAttemptAtMs = 0
    this.lastSuccessAtMs = 0
    this.lastError = ""
    this.refreshing = false
    this.started = false
    this.stopped = false
    this._pending = null
    this._timer = null
  }

  async start() {
    if (this.started) return this.snapshot()
    this.started = true
    await this.loadCache()
    this.rebuildTable()

    if (!this.disabled) {
      // Do not make listening wait for the network. The cached/fallback table
      // is already usable; the first refresh runs on the next turn.
      this._timer = setTimeout(() => {
        this.refresh().catch((error) => this.logger.warn("holiday refresh failed: " + safeMessage(error)))
      }, 0)
      if (typeof this._timer.unref === "function") this._timer.unref()
    }
    return this.snapshot()
  }

  stop() {
    this.stopped = true
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }

  async ensureCacheDirectory() {
    // This runs on every refresh rather than caching a failure, so a volume
    // that mounts late or a permissions problem that is fixed can recover
    // without restarting the widget.
    await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(this.cacheDir)
    if (!stat.isDirectory()) throw new Error("cache path is not a directory")
    // Do not read or write through a symlinked cache directory. The default
    // layout does not need one, and refusing is safer than following it.
    const real = await fs.realpath(this.cacheDir)
    const expected = path.resolve(this.cacheDir)
    const same = process.platform === "win32"
      ? real.toLowerCase() === expected.toLowerCase()
      : real === expected
    if (!same) {
      throw new Error("cache directory resolves through a symlink")
    }
    try { await fs.chmod(this.cacheDir, 0o700) } catch (_) { /* Windows / read-only fs */ }
  }

  cachePath(year) {
    return path.join(this.cacheDir, cacheFileName(year))
  }

  async loadCache() {
    try {
      await this.ensureCacheDirectory()
    } catch (error) {
      this.logger.warn(safeMessage(error))
      return
    }

    const years = this.targetYears()
    // Read the next year's cache regardless of the fetch window: if the
    // arrangement was published early, using it costs nothing.
    for (const year of new Set([...years.read, ...years.fetch])) {
      const file = this.cachePath(year)
      try {
        const stat = await fs.lstat(file)
        if (!stat.isFile()) {
          this.yearMeta.set(year, { source: "fallback", fetchedAtMs: 0, error: "not_regular_file" })
          continue
        }
        if (stat.size > Holidays.MAX_CACHE_BYTES) {
          this.yearMeta.set(year, { source: "fallback", fetchedAtMs: 0, error: "too_large" })
          continue
        }
        const text = await fs.readFile(file, "utf8")
        const parsed = Holidays.parse(text)
        if (!parsed.ok) {
          this.yearMeta.set(year, { source: "fallback", fetchedAtMs: 0, error: parsed.error })
          this.logger.warn("ignoring invalid holiday cache for " + year)
          continue
        }
        this.cacheTexts.set(year, text)
        this.yearMeta.set(year, {
          source: "cache",
          fetchedAtMs: Math.round(stat.mtimeMs),
          error: ""
        })
      } catch (error) {
        if (error && error.code !== "ENOENT") {
          this.yearMeta.set(year, { source: "fallback", fetchedAtMs: 0, error: "read_failed" })
          this.logger.warn("could not read holiday cache for " + year + ": " + safeMessage(error))
        }
      }
    }
  }

  // The Beijing year is the one a holiday table is keyed by. The next year's
  // document is only requested inside the lead window; before that it is a
  // guaranteed 404.
  targetYears(nowMs) {
    const now = nowMs === undefined ? this.now() : nowMs
    const year = Schedule.beijingYear(now)
    const nextYear = Schedule.beijingYear(now + Holidays.NEXT_YEAR_FETCH_LEAD_MS)
    const fetchYears = [year]
    if (nextYear > year) fetchYears.push(year + 1)
    return { year, read: [year, year + 1], fetch: fetchYears }
  }

  rebuildTable() {
    const texts = [...this.cacheTexts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1])
    this.table = Holidays.tableFromTexts(texts)
    this.tableYears = Holidays.yearsOf(this.table)
  }

  currentYearSource() {
    const year = this.targetYears().year
    const meta = this.yearMeta.get(year)
    if (meta && meta.source === "fetched" && meta.error === "") return "fetched"
    if (this.cacheTexts.has(year)) return "cache"
    if (Object.prototype.hasOwnProperty.call(Holidays.FALLBACK, year + "-01-01")
      || this.tableYears.includes(year)) return "fallback"
    return "missing"
  }

  snapshot() {
    const years = this.targetYears()
    const now = this.now()
    const currentMeta = this.yearMeta.get(years.year)
    const currentSource = this.currentYearSource()
    const currentStale = currentSource === "fallback"
      || currentSource === "missing"
      || !currentMeta
      || currentMeta.error !== ""
      || (currentMeta.fetchedAtMs > 0 && now - currentMeta.fetchedAtMs > Holidays.STALE_AFTER_MS)

    const warnings = []
    if (this.disabled) warnings.push("holiday_refresh_disabled")
    if (currentSource === "missing") warnings.push("holiday_data_missing_" + years.year)
    else if (currentStale) warnings.push("holiday_data_stale")
    if (this.lastError) warnings.push("holiday_fetch_failed")

    return {
      enabled: !this.disabled,
      currentYear: years.year,
      currentYearSource: currentSource,
      tableYears: this.tableYears.slice(),
      stale: currentStale,
      warnings,
      lastAttemptAtMs: this.lastAttemptAtMs,
      lastSuccessAtMs: this.lastSuccessAtMs,
      lastError: this.lastError,
      refreshing: this.refreshing,
      cacheDir: this.cacheDir,
      years: Object.fromEntries([...this.yearMeta.entries()].sort((a, b) => a[0] - b[0]).map(
        ([year, meta]) => [String(year), {
          source: meta.source,
          fetchedAtMs: meta.fetchedAtMs,
          error: meta.error
        }]
      ))
    }
  }

  getTable() {
    return this.table
  }

  // Single-flight. A caller that asks while a refresh is running joins it
  // rather than starting a second request.
  refresh(options) {
    const force = Boolean(options && options.force)
    if (this.disabled) {
      return Promise.resolve(this.snapshot())
    }
    if (this._pending) return this._pending
    this._pending = this._refresh(force).finally(() => {
      this._pending = null
    })
    return this._pending
  }

  async _refresh(force) {
    this.refreshing = true
    this.lastAttemptAtMs = this.now()
    let failed = false
    let lastError = ""

    try {
      await this.ensureCacheDirectory()
    } catch (error) {
      this.refreshing = false
      this.lastError = "cache_unavailable"
      // A missing or unusable cache is transient (a volume may be mounting, or
      // a permissions problem may be fixed); retry on the failure schedule
      // rather than waiting a full week for the next healthy refresh.
      this.scheduleNext(true)
      return this.snapshot()
    }

    const targets = this.targetYears()
    for (const year of targets.fetch) {
      const meta = this.yearMeta.get(year)
      const cached = this.cacheTexts.has(year)
      const age = meta && meta.fetchedAtMs > 0 ? this.now() - meta.fetchedAtMs : Infinity
      if (!force && cached && age <= Holidays.STALE_AFTER_MS) continue

      try {
        const text = await this.fetchYear(year)
        const parsed = Holidays.parse(text)
        if (!parsed.ok) throw new Error("invalid_holiday_data")
        await this.writeCache(year, text)
        this.cacheTexts.set(year, text)
        this.yearMeta.set(year, { source: "fetched", fetchedAtMs: this.now(), error: "" })
        this.lastSuccessAtMs = this.now()
        this.logger.info("holiday table updated for " + year)
      } catch (error) {
        failed = true
        lastError = errorCode(error)
        this.yearMeta.set(year, {
          source: cached ? "cache" : "fallback",
          fetchedAtMs: meta ? meta.fetchedAtMs : 0,
          error: lastError
        })
        this.logger.warn("holiday fetch failed for " + year + ": " + lastError)
      }
    }

    this.lastError = failed ? lastError : ""
    this.rebuildTable()
    this.refreshing = false
    this.scheduleNext(failed)
    return this.snapshot()
  }

  async fetchYear(year) {
    const url = Holidays.sourceUrl(year)
    const timeout = AbortSignal.timeout(this.fetchTimeoutMs)
    let response
    try {
      response = await this.fetchImpl(url, {
        headers: FETCH_HEADERS,
        signal: timeout,
        redirect: "follow"
      })
    } catch (error) {
      if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error("timeout")
      }
      throw new Error("network_error")
    }

    if (!response || response.status !== 200) {
      if (response && response.body && typeof response.body.cancel === "function") {
        try { await response.body.cancel() } catch (_) { /* already consumed */ }
      }
      throw new Error("http_" + (response ? response.status : "unknown"))
    }

    try {
      return await readCapped(response, Holidays.MAX_CACHE_BYTES)
    } catch (error) {
      if (error instanceof BodyTooLarge) throw new Error("invalid_holiday_data")
      throw new Error("network_error")
    }
  }

  async writeCache(year, text) {
    const file = this.cachePath(year)
    const temp = path.join(this.cacheDir, "." + cacheFileName(year) + "." + process.pid + "."
      + crypto.randomBytes(6).toString("hex") + ".tmp")
    let handle
    try {
      handle = await fs.open(temp, fssync.constants.O_WRONLY | fssync.constants.O_CREAT
        | fssync.constants.O_EXCL, 0o600)
      await handle.writeFile(text, "utf8")
      await handle.sync()
      await handle.close()
      handle = null
      await fs.rename(temp, file)
      try { await fs.chmod(file, 0o600) } catch (_) { /* Windows / read-only fs */ }
    } finally {
      if (handle) {
        try { await handle.close() } catch (_) { /* already closed */ }
      }
      try { await fs.unlink(temp) } catch (_) { /* renamed or never created */ }
    }
  }

  scheduleNext(failed) {
    if (this.stopped || this.disabled) return
    if (this._timer) clearTimeout(this._timer)
    const delay = failed ? this.retryMs : this.refreshMs
    this._timer = setTimeout(() => {
      this.refresh().catch((error) => this.logger.warn("holiday refresh failed: " + safeMessage(error)))
    }, delay)
    if (typeof this._timer.unref === "function") this._timer.unref()
  }
}

function safeMessage(error) {
  return error && typeof error.message === "string" ? error.message.slice(0, 200) : "error"
}

function errorCode(error) {
  const message = safeMessage(error)
  if (/^(network_error|timeout|invalid_holiday_data|http_\d+|cache_unavailable)$/.test(message)) return message
  return "network_error"
}

module.exports = { HolidayService, readCapped, BodyTooLarge, cacheFileName }
