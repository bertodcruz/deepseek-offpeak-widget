// Balance service self-check. Run: node --test test/balance-service.test.js
//
// These tests use a fake fetch. They verify the key resolution, the failure
// vocabulary, the no-stale-amounts rule, and single-flight behavior without
// touching api.deepseek.com.

"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")

const { BalanceService, readKeyFile } = require("../src/balance-service")
const Balance = require("../src/balance")

const KEY = "sk-" + "abc123def456".repeat(3)
const GOOD = JSON.stringify({
  is_available: true,
  balance_infos: [
    { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }
  ]
})

function successBody(text) {
  return { status: 200, text: async () => text === undefined ? GOOD : text }
}

function service(cache, options) {
  return new BalanceService(Object.assign({
    apiKey: "",
    apiKeyFileCandidates: [],
    disabled: false,
    refreshMs: 300000,
    retryMs: 60000,
    timeoutMs: 1000,
    manualCooldownMs: 30000,
    now: () => 1000,
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  }, options || {}))
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "deepseek-balance-test-"))
}

test("no key disables the balance section without a network call", async () => {
  let calls = 0
  const svc = service(null, {
    apiKeyFileCandidates: [],
    fetchImpl: async () => { calls++; return successBody() }
  })
  const snap = await svc.start()
  assert.equal(snap.enabled, false)
  assert.equal(snap.status, "disabled")
  assert.equal(snap.error, "")
  assert.equal(calls, 0)
  svc.stop()
})

test("an environment key is used and never appears in the snapshot", async () => {
  let seenAuth = ""
  const svc = service(null, {
    apiKey: KEY,
    fetchImpl: async (url, options) => {
      assert.equal(url, Balance.BALANCE_URL)
      seenAuth = options.headers.authorization
      return successBody()
    }
  })
  const start = await svc.start()
  assert.equal(start.enabled, true)
  assert.equal(start.keySource, "environment")
  const snap = await svc.refresh({ manual: true })
  assert.equal(snap.status, "ok")
  assert.equal(snap.isAvailable, true)
  assert.deepEqual(snap.balances, [
    { currency: "CNY", totalBalance: "110.00", grantedBalance: "10.00", toppedUpBalance: "100.00" }
  ])
  assert.equal(seenAuth, "Bearer " + KEY)
  const serialized = JSON.stringify(snap)
  assert.ok(!serialized.includes(KEY), "the key must not be exposed")
  assert.equal(serialized.includes("sk-"), false, "no key-shaped material")
  svc.stop()
})

test("a key file is the fallback and is parsed strictly", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "key")
  await fs.writeFile(file, KEY + "\n")
  let calls = 0
  const svc = service(null, {
    apiKey: "not-a-key",
    apiKeyFileCandidates: [file],
    fetchImpl: async () => { calls++; return successBody() }
  })
  const start = await svc.start()
  assert.equal(start.enabled, true)
  assert.equal(start.keySource, "file")
  const snap = await svc.refresh()
  assert.equal(snap.status, "ok")
  assert.equal(calls, 1)
  svc.stop()
  await fs.rm(dir, { recursive: true, force: true })
})

test("an invalid key file is a fixable, visible error", async () => {
  const dir = await tempDir()
  const file = path.join(dir, "key")
  await fs.writeFile(file, "DEEPSEEK_API_KEY=" + KEY + "\n")
  let calls = 0
  const svc = service(null, {
    apiKeyFileCandidates: [file],
    fetchImpl: async () => { calls++; return successBody() }
  })
  const snap = await svc.start()
  assert.equal(snap.enabled, true)
  assert.equal(snap.status, "error")
  assert.equal(snap.error, "invalid_api_key_file")
  assert.equal(calls, 0)
  svc.stop()
  await fs.rm(dir, { recursive: true, force: true })
})

test("a failed refresh clears amounts but keeps the last-good time", async () => {
  let now = 1000
  let mode = "ok"
  const svc = service(null, {
    apiKey: KEY,
    now: () => now,
    fetchImpl: async () => {
      if (mode === "ok") return successBody()
      return { status: 503, body: { cancel: async () => {} } }
    }
  })
  await svc.start()
  await svc.refresh()
  now = 2000
  mode = "fail"
  const snap = await svc.refresh()
  assert.equal(snap.status, "error")
  assert.equal(snap.error, "http_503")
  assert.deepEqual(snap.balances, [], "a stale balance is not shown")
  assert.equal(snap.updatedAtMs, 1000, "last successful read time is kept")
  assert.equal(snap.lastGoodAtMs, 1000)
  svc.stop()
})

test("non-200 statuses are named", async () => {
  const svc = service(null, {
    apiKey: KEY,
    fetchImpl: async () => ({ status: 401, body: { cancel: async () => {} } })
  })
  await svc.start()
  const snap = await svc.refresh()
  assert.equal(snap.error, "http_401")
  svc.stop()
})

test("a network failure is network_error", async () => {
  const svc = service(null, {
    apiKey: KEY,
    fetchImpl: async () => { throw new Error("dns") }
  })
  await svc.start()
  const snap = await svc.refresh()
  assert.equal(snap.error, "network_error")
  svc.stop()
})

test("a timeout aborts the request", async () => {
  const svc = service(null, {
    apiKey: KEY,
    timeoutMs: 40,
    fetchImpl: async (url, options) => new Promise((resolve, reject) => {
      // The service unrefs its own request timer (correct for a server: it must
      // not hold a shutting-down process open). That means nothing would keep
      // the event loop alive while this fake request hangs, so on Node 22 the
      // test runner drained the loop and cancelled this test before the abort
      // could fire. A ref'd timer here holds the loop until the signal aborts.
      const keepAlive = setTimeout(() => {}, 5000)
      options.signal.addEventListener("abort", () => {
        clearTimeout(keepAlive)
        const error = new Error("aborted")
        error.name = "AbortError"
        reject(error)
      })
    })
  })
  await svc.start()
  const snap = await svc.refresh()
  assert.equal(snap.error, "network_error")
  svc.stop()
})

test("an oversized body is invalid_response", async () => {
  const svc = service(null, {
    apiKey: KEY,
    fetchImpl: async () => successBody("x".repeat(Balance.MAX_RESPONSE_BYTES + 1))
  })
  await svc.start()
  const snap = await svc.refresh()
  assert.equal(snap.error, "invalid_response")
  svc.stop()
})

test("refresh is single-flight", async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const svc = service(null, {
    apiKey: KEY,
    fetchImpl: async () => {
      calls++
      await gate
      return successBody()
    }
  })
  await svc.start()
  const first = svc.refresh()
  const second = svc.refresh()
  assert.equal(first, second)
  assert.equal(calls, 1)
  release()
  await first
  assert.equal(calls, 1)
  svc.stop()
})

test("manual refresh is rate limited but automatic refresh is not", async () => {
  let now = 1000
  let calls = 0
  const svc = service(null, {
    apiKey: KEY,
    now: () => now,
    fetchImpl: async () => { calls++; return successBody() }
  })
  await svc.start()
  await svc.refresh({ manual: true })
  await svc.refresh({ manual: true })
  assert.equal(calls, 1, "a second manual refresh inside the cooldown is ignored")
  await svc.refresh()
  assert.equal(calls, 2, "automatic refresh is not rate limited")
  now += 30001
  await svc.refresh({ manual: true })
  assert.equal(calls, 3)
  svc.stop()
})

test("the key file reader rejects a directory and an oversized file", async () => {
  const dir = await tempDir()
  const asDir = path.join(dir, "directory")
  await fs.mkdir(asDir)
  const dirResult = await readKeyFile(asDir)
  assert.equal(dirResult.found, true)
  assert.equal(dirResult.invalid, true)

  const huge = path.join(dir, "huge")
  await fs.writeFile(huge, "x".repeat(Balance.KEY_FILE_MAX_BYTES + 1))
  const hugeResult = await readKeyFile(huge)
  assert.equal(hugeResult.found, true)
  assert.equal(hugeResult.invalid, true)

  const missing = await readKeyFile(path.join(dir, "missing"))
  assert.equal(missing.found, false)
  await fs.rm(dir, { recursive: true, force: true })
})
