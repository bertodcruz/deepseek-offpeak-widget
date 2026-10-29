// Balance response validation self-check. Run: node --test test/balance.test.js
//
// The failure cases matter more than the happy one: the widget has to say
// something true about a missing key, an unreachable host, a rejected request,
// and a 200 that is not the documented shape.

"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const B = require("../src/balance")

const good = JSON.stringify({
  is_available: true,
  balance_infos: [
    { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
    { currency: "USD", total_balance: "3.50", granted_balance: "0.00", topped_up_balance: "3.50" }
  ]
})

test("key shape is the documented one and nothing else", () => {
  assert.equal(B.isUsableKey(""), false)
  assert.equal(B.isUsableKey(undefined), false)
  assert.equal(B.isUsableKey("   "), false, "whitespace only")
  assert.equal(B.isUsableKey("sk-a\nb"), false, "a newline must not reach a header")
  assert.equal(B.isUsableKey("sk-" + "a".repeat(32)), true)
  for (const bad of ['sk-a"b', "sk-a\\b", "sk-a b", "sk-a\tb", "sk-\u00e9",
    "sk-short", "AKIA" + "A".repeat(20), "sk-" + "a".repeat(B.KEY_MAX_LENGTH - 2)]) {
    assert.equal(B.isUsableKey(bad), false, JSON.stringify(bad))
  }
  assert.equal(B.isUsableKey("sk-" + "a".repeat(B.KEY_MAX_LENGTH - 3)), true, "at the ceiling")
  assert.deepEqual(B.missingApiKey(), { ok: false, error: "missing_api_key" })
})

test("a 200 with the documented shape parses", () => {
  const result = B.fromHttp(200, good)
  assert.equal(result.ok, true)
  assert.equal(result.isAvailable, true)
  assert.equal(result.balances.length, 2)
  assert.deepEqual(result.balances[0], {
    currency: "CNY", totalBalance: "110.00", grantedBalance: "10.00", toppedUpBalance: "100.00"
  })
  assert.equal(B.describe(result), "")
  assert.equal(B.describe({ ok: true, isAvailable: false, balances: [] }),
    "Account not available for API calls")
})

test("the curl-shaped adapter still maps failures like upstream", () => {
  assert.deepEqual(B.fromResponse(7, ""), { ok: false, error: "network_error" })
  assert.deepEqual(B.fromResponse(28, ""), { ok: false, error: "network_error" }, "timeout")
  assert.deepEqual(B.fromResponse(63, ""), { ok: false, error: "invalid_response" })
  assert.equal(B.describe({ ok: false, error: "network_error" }), "Could not reach api.deepseek.com")
})

test("non-200 is http_<status>", () => {
  assert.deepEqual(B.fromHttp(401, "Unauthorized"), { ok: false, error: "http_401" })
  assert.deepEqual(B.fromHttp(503, "go away"), { ok: false, error: "http_503" })
  assert.deepEqual(B.fromHttp(500, good), { ok: false, error: "http_500" })
  assert.equal(B.describe({ ok: false, error: "http_429" }), "Balance API returned 429")
})

test("invalid JSON and wrong shapes are invalid_response", () => {
  assert.deepEqual(B.fromHttp(200, "not json at all"), { ok: false, error: "invalid_response" })
  assert.deepEqual(B.fromHttp(200, ""), { ok: false, error: "invalid_response" })
  assert.deepEqual(B.fromHttp(200, "<html>hi</html>"), { ok: false, error: "invalid_response" })

  const cases = [
    JSON.stringify({ balance_infos: [] }),
    JSON.stringify({ is_available: "yes", balance_infos: [] }),
    JSON.stringify({ is_available: true }),
    JSON.stringify({ is_available: true, balance_infos: {} }),
    JSON.stringify({ is_available: true, balance_infos: [null] }),
    JSON.stringify({ is_available: true, balance_infos: [{}] }),
    JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY" }] }),
    JSON.stringify({ is_available: true, balance_infos: [
      { currency: "CNY", total_balance: "1", granted_balance: "1" }] }),
    JSON.stringify([{ is_available: true }]),
    JSON.stringify("a string")
  ]
  for (const body of cases) {
    assert.deepEqual(B.fromHttp(200, body), { ok: false, error: "invalid_response" }, `body: ${body}`)
  }

  const numeric = B.fromHttp(200, JSON.stringify({
    is_available: true,
    balance_infos: [{ currency: "USD", total_balance: 3.5, granted_balance: 0, topped_up_balance: 3.5 }]
  }))
  assert.equal(numeric.ok, true)
  assert.equal(numeric.balances[0].totalBalance, "3.5")
})

test("an empty balance list is a good response", () => {
  const result = B.fromHttp(200, JSON.stringify({ is_available: true, balance_infos: [] }))
  assert.equal(result.ok, true)
  assert.equal(result.balances.length, 0)
  assert.equal(B.describe(result), "No balance reported")
})

test("the status line is split off the curl body, however it ends", () => {
  assert.deepEqual(B.splitResponse("body\n200"), { body: "body", status: "200" })
  assert.deepEqual(B.splitResponse("{\n\"a\": 1\n}\n200"), { body: "{\n\"a\": 1\n}", status: "200" })
  assert.deepEqual(B.fromResponse(0, "just a body"), { ok: false, error: "http_unknown" })
})

test("the response bound counts UTF-8 bytes", () => {
  assert.equal(B.utf8ByteLength("abc"), 3)
  assert.equal(B.utf8ByteLength("中"), 3)
  assert.equal(B.utf8ByteLength("😀"), 4)
  assert.equal(B.utf8ByteLength("a中😀"), 8)

  const unicodeBody = JSON.stringify({ is_available: true, balance_infos: [], note: "中".repeat(6000) })
  assert.ok(unicodeBody.length < B.MAX_RESPONSE_BYTES, "decoded text is under the limit")
  assert.ok(B.utf8ByteLength(unicodeBody) > B.MAX_RESPONSE_BYTES, "encoded output is over the byte limit")
  assert.deepEqual(B.fromHttp(200, unicodeBody), { ok: false, error: "invalid_response" })
})

test("amounts must be finite, non-empty, and non-negative", () => {
  const wrap = (total) => JSON.stringify({
    is_available: true,
    balance_infos: [{ currency: "CNY", total_balance: total, granted_balance: "0", topped_up_balance: "0" }]
  })

  for (const [value, rendered] of [["110.00", "110.00"], ["0", "0"], [0, "0"],
    [3.5, "3.5"], ["0.01", "0.01"]]) {
    const result = B.fromHttp(200, wrap(value))
    assert.equal(result.ok, true, `${JSON.stringify(value)} should be accepted`)
    assert.equal(result.balances[0].totalBalance, rendered)
  }

  for (const value of [null, undefined, "", "   ", "abc", "1e5", "1,000", "-5", -5,
    "-0.01", NaN, Infinity, -Infinity, {}, [], true]) {
    assert.deepEqual(B.fromHttp(200, wrap(value)), { ok: false, error: "invalid_response" },
      `${JSON.stringify(value)} should be rejected`)
  }
})

test("a key file is one key line, or it is nothing", () => {
  const key = "sk-" + "abc123def456".repeat(3)
  for (const text of [key, key + "\n", "  " + key + "  \n", key + "\r\n"]) {
    assert.equal(B.parseKeyFile(text), key, JSON.stringify(text))
  }
  for (const text of ["", "\n", "\n\n", key + "\n" + key, key + "\n# rotated Friday",
    "DEEPSEEK_API_KEY=" + key, 'DEEPSEEK_API_KEY="' + key + '"', "export " + key,
    key + " extra", "sk-short", "$" + key, "sk-a b", key + "\r\n" + key,
    "x".repeat(B.KEY_FILE_MAX_BYTES + 1), null, undefined, 12345]) {
    assert.equal(B.parseKeyFile(text), "", JSON.stringify(text))
  }
})

test("a bounded read of the key file decides like this, and only like this", () => {
  const key = "sk-" + "abc123def456".repeat(3)
  assert.deepEqual(B.keyFileResult(key + "\n", true), { key: key, error: "" })
  assert.deepEqual(B.keyFileResult(key + "\n", false), { key: "", error: "missing_api_key" })
  for (const text of ["", "\n", key + key, "DEEPSEEK_API_KEY=" + key, "junk\n"]) {
    assert.deepEqual(B.keyFileResult(text, true), { key: "", error: "invalid_api_key_file" },
      JSON.stringify(text))
  }
  const truncated = key + "x".repeat(B.KEY_FILE_READ_BYTES - key.length)
  assert.equal(truncated.length, B.KEY_FILE_READ_BYTES)
  assert.deepEqual(B.keyFileResult(truncated, true), { key: "", error: "invalid_api_key_file" })
  assert.deepEqual(B.keyFileResult("", false), { key: "", error: "missing_api_key" })
})

test("the shared acquisition policy has one key and one source", () => {
  const key = "sk-" + "abc123def456".repeat(3)
  assert.deepEqual(B.resolveKey(key), { status: "resolved", key: key, source: "environment", error: "" })
  assert.deepEqual(B.resolveKey("not-a-key"), { status: "pending", key: "", source: "", error: "" })
  assert.deepEqual(B.resolveKey("not-a-key", key + "\n", true),
    { status: "resolved", key: key, source: "file", error: "" })
  assert.deepEqual(B.resolveKey("not-a-key", "junk\n", true),
    { status: "error", key: "", source: "", error: "invalid_api_key_file" })
  assert.deepEqual(B.resolveKey("not-a-key", "", false),
    { status: "error", key: "", source: "", error: "missing_api_key" })
})

test("the shared balance state preserves the lifecycle meaning", () => {
  const success = B.successState(B.fromHttp(200, good), 1000)
  assert.deepEqual(success, {
    status: "ok", error: "", isAvailable: true, balances: success.balances, updatedAtMs: 1000
  })
  const loading = B.loadingState(success)
  assert.equal(loading.status, "loading")
  assert.equal(loading.updatedAtMs, 1000)
  assert.equal(loading.balances, success.balances)
  assert.deepEqual(B.errorState("missing_api_key"),
    { status: "error", error: "missing_api_key", isAvailable: false, balances: [], updatedAtMs: 0 })
  assert.equal(B.describeState(B.idleState()), "No balance data yet")
  assert.equal(B.describeState(loading), "No balance data yet")
  assert.equal(B.describeState(success), "")
})

test("the key file path follows the XDG variables", () => {
  assert.equal(B.keyFilePath("/home/d/.config", "/home/d"),
    "/home/d/.config/deepseek-offpeak/key")
  assert.equal(B.keyFilePath("/home/d/.config/", "/home/d"),
    "/home/d/.config/deepseek-offpeak/key", "a trailing slash is not a second slash")
  assert.equal(B.keyFilePath(undefined, "/home/d"), "/home/d/.config/deepseek-offpeak/key")
  assert.equal(B.keyFilePath("", "/home/d"), "/home/d/.config/deepseek-offpeak/key")
  assert.equal(B.keyFilePath("", ""), "")
})

test("the document has limits on its shape, not just on its size", () => {
  const wrap = (payload) => JSON.stringify(payload)
  const entry = (currency, total) => ({
    currency: currency, total_balance: total, granted_balance: "0", topped_up_balance: "0"
  })

  const many = { is_available: true, balance_infos: [] }
  for (let i = 0; i <= B.MAX_BALANCES; i++) many.balance_infos.push(entry("CNY", "1"))
  assert.deepEqual(B.fromHttp(200, wrap(many)), { ok: false, error: "invalid_response" },
    "one currency over the ceiling")
  assert.equal(B.fromHttp(200, wrap({ is_available: true,
    balance_infos: many.balance_infos.slice(0, B.MAX_BALANCES) })).ok, true, "exactly at the ceiling")

  assert.deepEqual(B.fromHttp(200, wrap({ is_available: true,
    balance_infos: [entry("X".repeat(B.MAX_CURRENCY_LENGTH + 1), "1")] })),
  { ok: false, error: "invalid_response" }, "currency over the ceiling")
  assert.deepEqual(B.fromHttp(200, wrap({ is_available: true,
    balance_infos: [entry("CNY", "1".repeat(B.MAX_AMOUNT_LENGTH + 1))] })),
  { ok: false, error: "invalid_response" }, "amount over the ceiling")
  assert.equal(B.fromHttp(200, wrap({ is_available: true,
    balance_infos: [entry("CNY", "1".repeat(B.MAX_AMOUNT_LENGTH))] })).ok, true,
  "an amount at the ceiling is still a balance")
})

test("currency values cannot carry terminal controls", () => {
  const balanceResponse = (currency) => JSON.stringify({
    is_available: true,
    balance_infos: [{ currency: currency, total_balance: "1", granted_balance: "0", topped_up_balance: "1" }]
  })
  for (const currency of ["\u001b[2J", "USD\n", "USD\r", "\u007fUSD", "\u009b2J"]) {
    assert.deepEqual(B.fromHttp(200, balanceResponse(currency)),
      { ok: false, error: "invalid_response" }, `${JSON.stringify(currency)} must be rejected`)
  }
  for (const currency of ["CNY", "USD", "USDT"]) {
    assert.equal(B.fromHttp(200, balanceResponse(currency)).ok, true, `${currency} remains valid`)
  }
})
