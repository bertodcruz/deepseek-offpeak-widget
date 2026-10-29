// HTTP surface self-check. Run: node --test test/server.test.js
//
// A fake holiday service and a fake balance service keep this test off the
// network. It checks the routes, headers, token gate, and that no key material
// can reach a response.

"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")

const { createApp } = require("../src/server")
const Holidays = require("../src/holidays")

const NOW = Date.UTC(2026, 8, 9, 2, 30)
const TOKEN = "test-token-1234567890"

function fakeHolidayService() {
  return {
    table: Holidays.fallback(),
    meta: {
      enabled: true,
      currentYear: 2026,
      currentYearSource: "cache",
      tableYears: [2026],
      stale: false,
      warnings: [],
      lastAttemptAtMs: NOW,
      lastSuccessAtMs: NOW,
      lastError: "",
      refreshing: false,
      years: { 2026: { source: "cache", fetchedAtMs: NOW, error: "" } }
    },
    getTable() { return this.table },
    snapshot() { return this.meta }
  }
}

function fakeBalanceService() {
  return {
    refreshed: 0,
    snapshotValue: {
      enabled: true,
      status: "ok",
      error: "",
      errorMessage: "",
      isAvailable: true,
      balances: [{ currency: "CNY", totalBalance: "110.00", grantedBalance: "10.00", toppedUpBalance: "100.00" }],
      updatedAtMs: NOW,
      lastAttemptAtMs: NOW,
      lastGoodAtMs: NOW,
      nextRefreshAtMs: NOW + 300000,
      refreshing: false,
      stale: false
    },
    snapshot() { return this.snapshotValue },
    async refresh() { this.refreshed++; return this.snapshotValue }
  }
}

function makeConfig(overrides) {
  return Object.assign({
    port: 0,
    host: "127.0.0.1",
    dataDir: "/tmp/deepseek-test",
    cacheDir: "/tmp/deepseek-test/cache",
    logLevel: "silent",
    widgetToken: "",
    pollAfterMs: 30000,
    holidaysDisabled: true,
    holidayRefreshMs: 604800000,
    holidayFetchTimeoutMs: 1000,
    holidayRetryMs: 60000,
    apiKey: "",
    apiKeyFileCandidates: [],
    balanceDisabled: true,
    balanceRefreshMs: 300000,
    balanceRetryMs: 60000,
    balanceTimeoutMs: 1000,
    balanceManualCooldownMs: 30000,
    version: "1.0.0-test"
  }, overrides || {})
}

const silent = { debug() {}, info() {}, warn() {}, error() {} }

async function start(overrides, services) {
  const holidayService = (services && services.holidayService) || fakeHolidayService()
  const balanceService = (services && services.balanceService) || fakeBalanceService()
  const app = createApp({
    config: makeConfig(overrides),
    holidayService,
    balanceService,
    logger: silent,
    now: () => NOW
  })
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve))
  const address = app.server.address()
  const base = "http://127.0.0.1:" + address.port
  return {
    app,
    base,
    holidayService,
    balanceService,
    async close() {
      await new Promise((resolve) => app.server.close(resolve))
    }
  }
}

test("healthz is public and minimal", async () => {
  const s = await start({ widgetToken: TOKEN })
  try {
    const response = await fetch(s.base + "/healthz")
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type"), /application\/json/)
    const body = await response.json()
    assert.equal(body.status, "ok")
    assert.equal(body.version, "1.0.0-test")
    assert.ok(Number.isFinite(body.nowMs))
  } finally {
    await s.close()
  }
})

test("api/status returns the schedule, runs, holidays, and balance", async () => {
  const s = await start({}, { balanceService: fakeBalanceService() })
  try {
    const response = await fetch(s.base + "/api/status")
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.ok(response.headers.get("x-server-now-ms"))
    const body = await response.json()
    assert.equal(body.id, "deepseek-offpeak")
    assert.equal(body.peak, true)
    assert.equal(body.nextSwitchMs, Date.UTC(2026, 8, 9, 4, 0))
    assert.ok(Array.isArray(body.runs) && body.runs.length > 0)
    assert.equal(body.holidays.currentYearSource, "cache")
    assert.equal(body.balance.balances[0].currency, "CNY")
    assert.equal(body.balance.balances[0].totalBalance, "110.00")
    assert.ok(!JSON.stringify(body).includes("sk-"), "no key material")
  } finally {
    await s.close()
  }
})

test("status exposes the configured clock style", async () => {
  const s = await start({ timeFormat: "12h" })
  try {
    const body = await (await fetch(s.base + "/api/status")).json()
    assert.equal(body.timeFormat, "12h")
  } finally {
    await s.close()
  }
})

test("api/holidays exposes the table and public metadata", async () => {
  const s = await start()
  try {
    const response = await fetch(s.base + "/api/holidays")
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.apiVersion, 1)
    assert.equal(body.table["2026-10-01"], "国庆节")
    assert.equal(body.meta.currentYearSource, "cache")
    assert.equal(body.meta.cacheDir, undefined)
  } finally {
    await s.close()
  }
})

test("api/balance refreshes only when asked", async () => {
  const balanceService = fakeBalanceService()
  const s = await start({}, { balanceService })
  try {
    const response = await fetch(s.base + "/api/balance")
    assert.equal(response.status, 200)
    assert.equal((await response.json()).balance.status, "ok")
    assert.equal(balanceService.refreshed, 0)

    const refreshed = await fetch(s.base + "/api/balance?refresh=1")
    assert.equal(refreshed.status, 200)
    assert.equal(balanceService.refreshed, 1)
    assert.equal((await refreshed.json()).balance.balances[0].totalBalance, "110.00")
  } finally {
    await s.close()
  }
})

test("the widget token gates HTML and APIs, with query or header", async () => {
  const s = await start({ widgetToken: TOKEN })
  try {
    assert.equal((await fetch(s.base + "/")).status, 401)
    assert.equal((await fetch(s.base + "/api/status")).status, 401)
    assert.equal((await fetch(s.base + "/widget.css")).status, 200, "static CSS has no secrets")

    const query = await fetch(s.base + "/?token=" + TOKEN)
    assert.equal(query.status, 200)
    assert.match(await query.text(), /DeepSeek off-peak/)

    const header = await fetch(s.base + "/api/status", { headers: { "x-widget-token": TOKEN } })
    assert.equal(header.status, 200)
    const bearer = await fetch(s.base + "/api/status", { headers: { authorization: "Bearer " + TOKEN } })
    assert.equal(bearer.status, 200)
    const wrong = await fetch(s.base + "/api/status?token=wrong-token-123456")
    assert.equal(wrong.status, 401)
    const body = await wrong.json()
    assert.equal(body.error, "unauthorized")
  } finally {
    await s.close()
  }
})

test("security headers allow framing and block inline script", async () => {
  const s = await start()
  try {
    const response = await fetch(s.base + "/")
    assert.equal(response.headers.get("x-content-type-options"), "nosniff")
    assert.equal(response.headers.get("referrer-policy"), "no-referrer")
    const csp = response.headers.get("content-security-policy")
    assert.match(csp, /frame-ancestors \*/)
    assert.match(csp, /script-src 'self'/)
    assert.ok(!/unsafe-inline/.test(csp))
  } finally {
    await s.close()
  }
})

test("assets support ETag revalidation and HEAD", async () => {
  const s = await start()
  try {
    const first = await fetch(s.base + "/widget.css")
    assert.equal(first.status, 200)
    const etag = first.headers.get("etag")
    assert.ok(etag)
    const second = await fetch(s.base + "/widget.css", { headers: { "if-none-match": etag } })
    assert.equal(second.status, 304)
    const head = await fetch(s.base + "/widget.js", { method: "HEAD" })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), "")
  } finally {
    await s.close()
  }
})

test("unknown routes are 404 and unsupported methods are 405", async () => {
  const s = await start()
  try {
    const missing = await fetch(s.base + "/api/nope")
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).error, "not_found")
    const post = await fetch(s.base + "/api/status", { method: "POST" })
    assert.equal(post.status, 405)
    assert.equal(post.headers.get("allow"), "GET, HEAD")
  } finally {
    await s.close()
  }
})

test("robots and favicon do not require the token", async () => {
  const s = await start({ widgetToken: TOKEN })
  try {
    const robots = await fetch(s.base + "/robots.txt")
    assert.equal(robots.status, 200)
    assert.match(await robots.text(), /Disallow: \//)
    const favicon = await fetch(s.base + "/favicon.ico")
    assert.equal(favicon.status, 204)
  } finally {
    await s.close()
  }
})
