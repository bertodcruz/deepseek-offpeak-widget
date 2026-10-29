// Configuration parsing self-check. Run: node --test test/config.test.js
//
// loadConfig accepts an env object so this test never mutates process.env.

"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")

const { loadConfig, redactConfig } = require("../src/config")

test("loadConfig reads the supplied environment object", () => {
  const config = loadConfig({
    PORT: "0",
    HOST: "127.0.0.1",
    DATA_DIR: "config-test-data",
    TIME_FORMAT: "12h",
    HOLIDAYS_DISABLED: "yes",
    BALANCE_DISABLED: "1",
    POLL_AFTER_SECONDS: "45",
    DEEPSEEK_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz",
    DEEPSEEK_API_KEY_FILE: "config-test-key"
  })

  assert.equal(config.port, 0)
  assert.equal(config.host, "127.0.0.1")
  assert.equal(config.dataDir, path.resolve("config-test-data"))
  assert.equal(config.timeFormat, "12h")
  assert.equal(config.holidaysDisabled, true)
  assert.equal(config.balanceDisabled, true)
  assert.equal(config.pollAfterMs, 45000)
  assert.deepEqual(config.apiKeyFileCandidates, [path.resolve("config-test-key")])
  assert.equal(redactConfig(config).timeFormat, "12h")
})

test("loadConfig validates the token and clock style", () => {
  assert.throws(() => loadConfig({ WIDGET_TOKEN: "too-short" }), /at least 16 characters/)
  assert.throws(() => loadConfig({ TIME_FORMAT: "military" }), /TIME_FORMAT must be 12h or 24h/)
})

test("loadConfig defaults to the 24-hour clock", () => {
  assert.equal(loadConfig({}).timeFormat, "24h")
  assert.equal(loadConfig({ TIME_FORMAT: "24h" }).timeFormat, "24h")
  assert.equal(loadConfig({ TIME_FORMAT: "12" }).timeFormat, "12h")
})
