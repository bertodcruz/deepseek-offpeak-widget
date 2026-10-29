// Optional DeepSeek account balance service.
//
// The key never leaves this process: it is read from DEEPSEEK_API_KEY or a
// single-line key file, used in an Authorization header, and never included in
// an API response or a log line. The balance is strictly additive - every
// failure leaves the schedule untouched, and a failed refresh clears the amounts
// so a stale balance is never presented as current.

"use strict"

const fs = require("node:fs/promises")
const fssync = require("node:fs")

const Balance = require("./balance")
const { BodyTooLarge, readCapped } = require("./holiday-service")

class BalanceService {
  constructor(options) {
    this.apiKey = options.apiKey || ""
    this.apiKeyFileCandidates = options.apiKeyFileCandidates || []
    this.disabled = options.disabled === true
    this.refreshMs = options.refreshMs
    this.retryMs = options.retryMs
    this.timeoutMs = options.timeoutMs
    this.manualCooldownMs = options.manualCooldownMs
    this.now = options.now || (() => Date.now())
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.logger = options.logger || { info() {}, warn() {}, error() {}, debug() {} }

    this.key = ""
    this.keySource = ""
    this.keyError = ""
    this.enabled = false
    this.state = Balance.idleState()
    this.lastAttemptAtMs = 0
    this.lastGoodAtMs = 0
    this.nextRefreshAtMs = 0
    this.lastManualAtMs = 0
    this.refreshing = false
    this.started = false
    this.stopped = false
    this._pending = null
    this._timer = null
  }

  async start() {
    if (this.started) return this.snapshot()
    this.started = true

    if (this.disabled) {
      this.enabled = false
      this.keyError = ""
      this.state = { status: "disabled", error: "", isAvailable: false, balances: [], updatedAtMs: 0 }
      return this.snapshot()
    }

    await this.resolveKey()
    if (!this.enabled) {
      this.state = { status: "disabled", error: "", isAvailable: false, balances: [], updatedAtMs: 0 }
      return this.snapshot()
    }

    if (this.key === "") {
      this.state = Balance.errorState(this.keyError || Balance.ERROR_MISSING_API_KEY, 0)
      return this.snapshot()
    }

    // First read shortly after startup, then every refresh interval. The timer
    // is unref'd so it never keeps a shutting-down process alive.
    this._timer = setTimeout(() => {
      this.refresh().catch((error) => this.logger.warn("balance refresh failed: " + safeMessage(error)))
    }, 1500)
    if (typeof this._timer.unref === "function") this._timer.unref()
    return this.snapshot()
  }

  stop() {
    this.stopped = true
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }

  async resolveKey() {
    const envValue = this.apiKey

    // The environment is free and wins. If it is present but malformed, fall
    // through to the file exactly as upstream does; only the file's verdict can
    // turn a malformed value into a usable key.
    if (Balance.isUsableKey(envValue)) {
      this.key = envValue
      this.keySource = "environment"
      this.keyError = ""
      this.enabled = true
      return
    }

    if (envValue !== "") {
      this.logger.warn("DEEPSEEK_API_KEY is set but is not a valid DeepSeek key; checking the key file")
    }

    let found = false
    let invalid = false
    let lastError = ""
    for (const candidate of this.apiKeyFileCandidates) {
      const result = await readKeyFile(candidate)
      if (result.found) found = true
      if (result.key !== "") {
        this.key = result.key
        this.keySource = "file"
        this.keyError = ""
        this.enabled = true
        return
      }
      if (result.invalid) invalid = true
      if (result.error) lastError = result.error
    }

    if (invalid) {
      this.keyError = Balance.ERROR_INVALID_KEY_FILE
      this.enabled = true
      return
    }
    if (found && lastError) {
      this.keyError = Balance.ERROR_INVALID_KEY_FILE
      this.enabled = true
      return
    }

    // No key at all is not an error to display in the widget; the balance
    // section is simply disabled.
    this.keyError = Balance.ERROR_MISSING_API_KEY
    this.enabled = envValue !== ""
  }

  refresh(options) {
    const manual = Boolean(options && options.manual)
    if (this.disabled || !this.enabled || this.key === "") return Promise.resolve(this.snapshot())

    if (manual) {
      const now = this.now()
      if (this.lastManualAtMs > 0 && now - this.lastManualAtMs < this.manualCooldownMs) {
        return Promise.resolve(this.snapshot())
      }
      this.lastManualAtMs = now
    }

    if (this._pending) return this._pending
    this._pending = this._refresh().finally(() => {
      this._pending = null
    })
    return this._pending
  }

  async _refresh() {
    this.refreshing = true
    this.lastAttemptAtMs = this.now()
    this.state = Balance.loadingState(this.state)

    let result
    try {
      result = await this.fetchBalance()
    } catch (error) {
      result = { ok: false, error: errorCode(error) }
    }

    const now = this.now()
    if (result.ok) {
      this.state = Balance.successState(result, now)
      this.lastGoodAtMs = now
      this.nextRefreshAtMs = now + this.refreshMs
    } else {
      // Keep the time of the last successful read for context, but not the
      // amounts: a balance that could not be refreshed must not read as current.
      this.state = Balance.errorState(result.error, this.lastGoodAtMs)
      this.nextRefreshAtMs = now + this.retryMs
    }

    this.refreshing = false
    this.scheduleNext()
    return this.snapshot()
  }

  async fetchBalance() {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    if (typeof timer.unref === "function") timer.unref()

    try {
      let response
      try {
        response = await this.fetchImpl(Balance.BALANCE_URL, {
          method: "GET",
          headers: {
            authorization: "Bearer " + this.key,
            accept: "application/json",
            "user-agent": "glance-deepseek-offpeak/1"
          },
          signal: controller.signal,
          redirect: "error"
        })
      } catch (error) {
        throw new Error("network_error")
      }

      if (!response || response.status !== 200) {
        if (response && response.body && typeof response.body.cancel === "function") {
          try { await response.body.cancel() } catch (_) { /* already consumed */ }
        }
        return { ok: false, error: "http_" + (response ? response.status : "unknown") }
      }

      let body
      try {
        body = await readCapped(response, Balance.MAX_RESPONSE_BYTES)
      } catch (error) {
        if (error instanceof BodyTooLarge) return { ok: false, error: Balance.ERROR_INVALID_RESPONSE }
        return { ok: false, error: Balance.ERROR_NETWORK }
      }

      return Balance.fromHttp(response.status, body)
    } finally {
      clearTimeout(timer)
    }
  }

  scheduleNext() {
    if (this.stopped || this.disabled || !this.enabled || this.key === "") return
    if (this._timer) clearTimeout(this._timer)
    const delay = this.state.status === "ok" ? this.refreshMs : this.retryMs
    this._timer = setTimeout(() => {
      this.refresh().catch((error) => this.logger.warn("balance refresh failed: " + safeMessage(error)))
    }, delay)
    if (typeof this._timer.unref === "function") this._timer.unref()
  }

  snapshot() {
    const now = this.now()
    const status = this.enabled ? this.state.status : "disabled"
    const stale = status === "ok"
      && this.state.updatedAtMs > 0
      && now - this.state.updatedAtMs > this.refreshMs * 2

    return {
      enabled: this.enabled,
      status,
      error: this.enabled ? this.state.error : "",
      errorMessage: this.enabled ? Balance.describeState(this.state) : "",
      isAvailable: this.enabled ? this.state.isAvailable === true : false,
      balances: this.enabled ? this.state.balances : [],
      updatedAtMs: this.enabled ? this.state.updatedAtMs : 0,
      lastAttemptAtMs: this.lastAttemptAtMs,
      lastGoodAtMs: this.lastGoodAtMs,
      nextRefreshAtMs: this.nextRefreshAtMs,
      refreshing: this.refreshing,
      stale,
      keySource: this.keySource
    }
  }
}

// Read at most KEY_FILE_MAX_BYTES + 1 bytes from a regular file, never through
// a symlink. Returns one of:
//   {found:false}                       no such file
//   {found:true, key:"sk-...", ...}     one usable key
//   {found:true, invalid:true}          present but not one key line
async function readKeyFile(file) {
  if (!file) return { found: false, key: "", invalid: false, error: "" }
  let stat
  try {
    stat = await fs.lstat(file)
  } catch (error) {
    if (error && error.code === "ENOENT") return { found: false, key: "", invalid: false, error: "" }
    return { found: true, key: "", invalid: false, error: "read_failed" }
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { found: true, key: "", invalid: true, error: Balance.ERROR_INVALID_KEY_FILE }
  }
  if (stat.size > Balance.KEY_FILE_MAX_BYTES) {
    return { found: true, key: "", invalid: true, error: Balance.ERROR_INVALID_KEY_FILE }
  }

  let handle
  try {
    const flags = fssync.constants.O_RDONLY | (fssync.constants.O_NOFOLLOW || 0)
    handle = await fs.open(file, flags)
    const buffer = Buffer.alloc(Balance.KEY_FILE_READ_BYTES)
    let offset = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
      if (offset >= buffer.length) break
    }
    const text = buffer.subarray(0, offset).toString("utf8")
    const parsed = Balance.keyFileResult(text, true)
    if (parsed.key !== "") return { found: true, key: parsed.key, invalid: false, error: "" }
    return { found: true, key: "", invalid: true, error: parsed.error || Balance.ERROR_INVALID_KEY_FILE }
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ELOOP")) {
      return { found: true, key: "", invalid: true, error: Balance.ERROR_INVALID_KEY_FILE }
    }
    return { found: true, key: "", invalid: false, error: "read_failed" }
  } finally {
    if (handle) {
      try { await handle.close() } catch (_) { /* already closed */ }
    }
  }
}

function safeMessage(error) {
  return error && typeof error.message === "string" ? error.message.slice(0, 200) : "error"
}

function errorCode(error) {
  const message = safeMessage(error)
  if (message === "timeout") return Balance.ERROR_NETWORK
  if (message === "network_error") return Balance.ERROR_NETWORK
  if (message === Balance.ERROR_INVALID_RESPONSE) return Balance.ERROR_INVALID_RESPONSE
  return Balance.ERROR_NETWORK
}

module.exports = { BalanceService, readKeyFile }
