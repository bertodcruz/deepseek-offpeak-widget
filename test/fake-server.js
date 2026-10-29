// Local preview server with fake holiday and balance state.
// Usage: node test/fake-server.js [port]
// This is a development aid, not part of the production image.

"use strict"

const { createApp } = require("../src/server")
const Holidays = require("../src/holidays")
const packageJson = require("../package.json")

const port = Number(process.argv[2] || 8790)
const fixedNow = process.env.FAKE_NOW ? Date.parse(process.env.FAKE_NOW) : null
const now = fixedNow || Date.now()

const holidayService = {
  table: Holidays.fallback(),
  meta: {
    enabled: true,
    currentYear: 2026,
    currentYearSource: "fetched",
    tableYears: [2026],
    stale: false,
    warnings: [],
    lastAttemptAtMs: now,
    lastSuccessAtMs: now,
    lastError: "",
    refreshing: false,
    years: { 2026: { source: "fetched", fetchedAtMs: now, error: "" } }
  },
  getTable() { return this.table },
  snapshot() { return this.meta }
}

const balances = [
  { currency: "CNY", totalBalance: "110.00", grantedBalance: "10.00", toppedUpBalance: "100.00" },
  { currency: "USD", totalBalance: "3.50", grantedBalance: "0.00", toppedUpBalance: "3.50" }
]

const showBalance = process.env.FAKE_BALANCE !== "0"

const balanceService = {
  value: {
    enabled: showBalance,
    status: showBalance ? "ok" : "disabled",
    error: "",
    errorMessage: "",
    isAvailable: showBalance,
    balances: showBalance ? balances : [],
    updatedAtMs: showBalance ? now - 120000 : 0,
    lastAttemptAtMs: showBalance ? now - 120000 : 0,
    lastGoodAtMs: showBalance ? now - 120000 : 0,
    nextRefreshAtMs: showBalance ? now + 180000 : 0,
    refreshing: false,
    stale: false
  },
  snapshot() { return this.value },
  async refresh() { return this.value }
}

const app = createApp({
  config: {
    port,
    host: "127.0.0.1",
    dataDir: "/tmp/unused",
    cacheDir: "/tmp/unused",
    logLevel: "warn",
    widgetToken: "",
    pollAfterMs: 30000,
    holidaysDisabled: true,
    holidayRefreshMs: 604800000,
    holidayFetchTimeoutMs: 1000,
    holidayRetryMs: 60000,
    apiKey: "",
    apiKeyFileCandidates: [],
    balanceDisabled: false,
    balanceRefreshMs: 300000,
    balanceRetryMs: 60000,
    balanceTimeoutMs: 1000,
    balanceManualCooldownMs: 30000,
    version: packageJson.version
  },
  holidayService,
  balanceService,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  now: () => fixedNow || Date.now()
})

app.server.listen(port, "127.0.0.1", () => {
  process.stdout.write("fake preview listening on http://127.0.0.1:" + port + "/\n")
})
