// DeepSeek /user/balance response handling.
//
// Ported from DavidHLP/deepseek-offpeak (MIT), lib/Balance.js. The validation
// and error vocabulary are unchanged; the curl process adapter is replaced by
// the Node service's fetch adapter.
//
// Errors, exactly one per outcome:
//   missing_api_key       no usable key in the environment or the key file
//   invalid_api_key_file  a key file exists but is not one key line
//   network_error         fetch failed (DNS, connect, TLS, the total timeout)
//   http_<code>           the request completed with a non-200 status
//   invalid_response      a 200 that is not the documented JSON shape
//
// Money stays a string. The API sends decimals like "110.00"; parsing them into
// floats to re-print them only invents rounding.

"use strict"

const ERROR_MISSING_API_KEY = "missing_api_key"
const ERROR_INVALID_KEY_FILE = "invalid_api_key_file"
const ERROR_NETWORK = "network_error"
const ERROR_INVALID_RESPONSE = "invalid_response"

const KEY_ENVIRONMENT_VARIABLE = "DEEPSEEK_API_KEY"
const KEY_FILE_RELATIVE_PATH = "deepseek-offpeak/key"

// Most a key file may hold. A key is ~35 characters.
const KEY_FILE_MAX_BYTES = 256
const KEY_FILE_READ_BYTES = KEY_FILE_MAX_BYTES + 1

// The most a balance response may deliver.
const MAX_RESPONSE_BYTES = 16384

// Longest possible request. Sits above the service's fetch timeout.
const REQUEST_TIMEOUT_MS = 15000

// Longest key this module will hold. A real one is about 35 characters.
const KEY_MAX_LENGTH = 64

// Bounds on the document's shape. A cap on bytes is not a cap on shape.
const MAX_BALANCES = 16
const MAX_CURRENCY_LENGTH = 8
const MAX_AMOUNT_LENGTH = 32

// Currency values are display text. Reject terminal/control characters.
const CURRENCY_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/

const BALANCE_URL = "https://api.deepseek.com/user/balance"

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// A DeepSeek API key and nothing else. The shape is enforced strictly because
// the key is expanded into an Authorization header by the service: whitespace,
// a quote, or a backslash must never reach it.
function isUsableKey(key) {
  if (typeof key !== "string") return false
  if (key.length > KEY_MAX_LENGTH) return false
  return /^sk-[A-Za-z0-9_-]{16,}$/.test(key)
}

function keyFilePath(configHome, home) {
  let base = String(configHome === null || configHome === undefined ? "" : configHome)
  if (base === "") base = String(home === null || home === undefined ? "" : home) + "/.config"
  if (base === "/.config") return ""
  return base.replace(/\/+$/, "") + "/" + KEY_FILE_RELATIVE_PATH
}

// A key file is one line, optional surrounding whitespace, and the documented
// key shape - nothing else is ever adopted.
function parseKeyFile(text) {
  if (typeof text !== "string") return ""
  if (text.length > KEY_FILE_MAX_BYTES) return ""
  const lines = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n")
  if (lines.length !== 1) return ""
  const value = lines[0].replace(/^\s+|\s+$/g, "")
  return isUsableKey(value) ? value : ""
}

// A failed or timed-out read is missing, even if it produced partial text; a
// successful read at the ceiling is a file too large to be a key file.
function keyFileResult(text, readSucceeded) {
  if (!readSucceeded) return { key: "", error: ERROR_MISSING_API_KEY }
  const value = String(text === null || text === undefined ? "" : text)
  if (value.length > KEY_FILE_MAX_BYTES) return { key: "", error: ERROR_INVALID_KEY_FILE }
  const parsed = parseKeyFile(value)
  if (parsed !== "") return { key: parsed, error: "" }
  return { key: "", error: ERROR_INVALID_KEY_FILE }
}

function resolveKey(environmentValue, fileText, readSucceeded) {
  if (isUsableKey(environmentValue))
    return { status: "resolved", key: environmentValue, source: "environment", error: "" }

  if (fileText === undefined && readSucceeded === undefined)
    return { status: "pending", key: "", source: "", error: "" }

  const file = keyFileResult(fileText, readSucceeded === true)
  if (file.key !== "")
    return { status: "resolved", key: file.key, source: "file", error: "" }
  return { status: "error", key: "", source: "", error: file.error || ERROR_MISSING_API_KEY }
}

function missingApiKey() {
  return { ok: false, error: ERROR_MISSING_API_KEY }
}

function failure(error) {
  return { ok: false, error: error }
}

// Amounts arrive as decimal strings ("110.00") and occasionally as numbers.
// Both are accepted; anything else is not a balance. Rejected: null/undefined,
// "", whitespace, non-numeric text, NaN, Infinity, and negative values.
function decimalOrNull(value) {
  let text
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null
    text = String(value)
  } else if (typeof value === "string") {
    text = value.replace(/^\s+|\s+$/g, "")
  } else {
    return null
  }
  if (text.length === 0) return null
  if (text.length > MAX_AMOUNT_LENGTH) return null
  if (!/^\d+(\.\d+)?$/.test(text)) return null
  return text
}

function parseBalanceEntry(raw) {
  if (!isPlainObject(raw)) return null
  if (typeof raw.currency !== "string" || raw.currency.length === 0) return null
  if (raw.currency.length > MAX_CURRENCY_LENGTH) return null
  if (CURRENCY_CONTROL_RE.test(raw.currency)) return null
  const total = decimalOrNull(raw.total_balance)
  const granted = decimalOrNull(raw.granted_balance)
  const toppedUp = decimalOrNull(raw.topped_up_balance)
  if (total === null || granted === null || toppedUp === null) return null
  return {
    currency: raw.currency,
    totalBalance: total,
    grantedBalance: granted,
    toppedUpBalance: toppedUp
  }
}

function parsePayload(payload) {
  if (!isPlainObject(payload)) return null
  if (typeof payload.is_available !== "boolean") return null
  if (!Array.isArray(payload.balance_infos)) return null
  if (payload.balance_infos.length > MAX_BALANCES) return null

  const balances = []
  for (let i = 0; i < payload.balance_infos.length; i++) {
    const entry = parseBalanceEntry(payload.balance_infos[i])
    if (!entry) return null
    balances.push(entry)
  }
  return { isAvailable: payload.is_available, balances: balances }
}

function utf8ByteLength(text) {
  let encoded
  try {
    encoded = encodeURIComponent(String(text === null || text === undefined ? "" : text))
  } catch (e) {
    return Number.MAX_VALUE
  }

  let bytes = 0
  for (let i = 0; i < encoded.length; i++) {
    if (encoded.charAt(i) === "%") i += 2
    bytes++
  }
  return bytes
}

// The upstream adapter's curl-shaped entry point, kept so the ported tests and
// any script sharing this module behave identically. `stdout` ends with the
// HTTP status code on its own line.
function splitResponse(stdout) {
  const text = String(stdout === null || stdout === undefined ? "" : stdout)
  const split = text.lastIndexOf("\n")
  if (split < 0) return { body: text, status: "" }
  return { body: text.slice(0, split), status: text.slice(split + 1).replace(/^\s+|\s+$/g, "") }
}

function fromResponse(exitCode, stdout) {
  if (Number(exitCode) === 63) return failure(ERROR_INVALID_RESPONSE)
  if (Number(exitCode) !== 0) return failure(ERROR_NETWORK)
  if (utf8ByteLength(stdout) > MAX_RESPONSE_BYTES) return failure(ERROR_INVALID_RESPONSE)
  const response = splitResponse(stdout)
  if (response.status !== "200") return failure("http_" + (response.status || "unknown"))
  return fromBody(response.body, 200)
}

// The service's own entry point: an HTTP status and a decoded body.
function fromHttp(status, body) {
  const code = Number(status)
  if (!Number.isFinite(code)) return failure(ERROR_NETWORK)
  if (code !== 200) return failure("http_" + String(code))
  return fromBody(body, code)
}

function fromBody(body, status) {
  const text = String(body === null || body === undefined ? "" : body)
  if (utf8ByteLength(text) > MAX_RESPONSE_BYTES) return failure(ERROR_INVALID_RESPONSE)
  let payload
  try {
    payload = JSON.parse(text)
  } catch (e) {
    return failure(ERROR_INVALID_RESPONSE)
  }
  const parsed = parsePayload(payload)
  if (!parsed) return failure(ERROR_INVALID_RESPONSE)
  return { ok: true, isAvailable: parsed.isAvailable, balances: parsed.balances }
}

function timestampOrZero(value) {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0
}

function idleState() {
  return { status: "idle", error: "", isAvailable: false, balances: [], updatedAtMs: 0 }
}

function loadingState(previous) {
  const prior = previous && typeof previous === "object" ? previous : idleState()
  return {
    status: "loading",
    error: "",
    isAvailable: prior.isAvailable === true,
    balances: Array.isArray(prior.balances) ? prior.balances : [],
    updatedAtMs: timestampOrZero(prior.updatedAtMs)
  }
}

function errorState(error, updatedAtMs) {
  return {
    status: "error",
    error: String(error || "error"),
    isAvailable: false,
    balances: [],
    updatedAtMs: timestampOrZero(updatedAtMs)
  }
}

function successState(result, updatedAtMs) {
  if (!result || result.ok !== true) return errorState(result && result.error, updatedAtMs)
  return {
    status: "ok",
    error: "",
    isAvailable: result.isAvailable === true,
    balances: Array.isArray(result.balances) ? result.balances : [],
    updatedAtMs: timestampOrZero(updatedAtMs)
  }
}

function describe(result) {
  if (!result) return "No balance data yet"
  if (result.ok) {
    if (!result.isAvailable) return "Account not available for API calls"
    if (result.balances.length === 0) return "No balance reported"
    return ""
  }
  if (result.error === ERROR_MISSING_API_KEY)
    return "Set DEEPSEEK_API_KEY, or write the key to the key file, to show the balance"
  if (result.error === ERROR_INVALID_KEY_FILE)
    return "The key file must hold one sk-... line and nothing else"
  if (result.error === ERROR_NETWORK) return "Could not reach api.deepseek.com"
  if (result.error === ERROR_INVALID_RESPONSE) return "Unexpected response from the balance API"
  if (String(result.error).indexOf("http_") === 0)
    return "Balance API returned " + String(result.error).slice(5)
  return "Balance unavailable"
}

function describeState(state) {
  if (!state || state.status === "idle" || state.status === "loading")
    return "No balance data yet"
  if (state.status === "ok")
    return describe({ ok: true, isAvailable: state.isAvailable, balances: state.balances })
  return describe({ ok: false, error: state.error })
}

module.exports = {
  ERROR_MISSING_API_KEY,
  ERROR_INVALID_KEY_FILE,
  ERROR_NETWORK,
  ERROR_INVALID_RESPONSE,
  KEY_ENVIRONMENT_VARIABLE,
  KEY_FILE_RELATIVE_PATH,
  KEY_FILE_MAX_BYTES,
  KEY_FILE_READ_BYTES,
  KEY_MAX_LENGTH,
  MAX_RESPONSE_BYTES,
  MAX_BALANCES,
  MAX_CURRENCY_LENGTH,
  MAX_AMOUNT_LENGTH,
  REQUEST_TIMEOUT_MS,
  BALANCE_URL,
  isUsableKey,
  keyFilePath,
  parseKeyFile,
  keyFileResult,
  resolveKey,
  missingApiKey,
  decimalOrNull,
  parseBalanceEntry,
  parsePayload,
  utf8ByteLength,
  splitResponse,
  fromResponse,
  fromHttp,
  timestampOrZero,
  idleState,
  loadingState,
  errorState,
  successState,
  describe,
  describeState
}
