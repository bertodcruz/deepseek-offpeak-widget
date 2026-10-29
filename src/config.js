"use strict"

const path = require("node:path")
const os = require("node:os")

function firstEnv(env, ...names) {
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && value !== "") return value
  }
  return ""
}

function intEnv(env, name, fallback, min, max) {
  const raw = env[name]
  if (raw === undefined || raw === "") return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || Math.floor(value) !== value) {
    throw new Error(name + " must be an integer")
  }
  if (value < min || value > max) {
    throw new Error(name + " must be between " + min + " and " + max)
  }
  return value
}

function boolEnv(env, name, fallback) {
  const raw = env[name]
  if (raw === undefined || raw === "") return fallback
  const value = raw.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(value)) return true
  if (["0", "false", "no", "off"].includes(value)) return false
  throw new Error(name + " must be one of 1/0, true/false, yes/no, on/off")
}

function timeFormatEnv(raw) {
  if (raw === undefined || raw === "") return "24h"
  const value = String(raw).trim().toLowerCase()
  if (["12", "12h", "12-hour", "ampm", "am-pm"].includes(value)) return "12h"
  if (["24", "24h"].includes(value)) return "24h"
  throw new Error("TIME_FORMAT must be 12h or 24h")
}

function defaultKeyFileCandidates(env) {
  const candidates = []
  const explicit = env.DEEPSEEK_API_KEY_FILE
  if (explicit) {
    candidates.push(path.resolve(explicit))
    return candidates
  }

  const configHome = firstEnv(env, "XDG_CONFIG_HOME")
  const home = firstEnv(env, "HOME") || os.homedir()
  if (configHome) candidates.push(path.join(configHome, "deepseek-offpeak", "key"))
  else if (home) candidates.push(path.join(home, ".config", "deepseek-offpeak", "key"))

  // Conventional Docker/Kubernetes secret mount. Only consulted when no
  // explicit path was supplied.
  candidates.push("/run/secrets/deepseek_api_key")
  return [...new Set(candidates)]
}

function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(process.cwd(), "data"))
  const cacheDir = path.resolve(env.CACHE_DIR || path.join(dataDir, "cache"))
  const widgetToken = String(env.WIDGET_TOKEN || "").trim()

  if (widgetToken !== "" && widgetToken.length < 16) {
    throw new Error("WIDGET_TOKEN must be at least 16 characters, or leave it empty to disable authentication")
  }

  return {
    port: intEnv(env, "PORT", 8787, 0, 65535),
    host: env.HOST || "0.0.0.0",
    dataDir,
    cacheDir,
    logLevel: (env.LOG_LEVEL || "info").toLowerCase(),
    widgetToken,
    timeFormat: timeFormatEnv(env.TIME_FORMAT),
    pollAfterMs: intEnv(env, "POLL_AFTER_SECONDS", 30, 10, 300) * 1000,

    holidaysDisabled: boolEnv(env, "HOLIDAYS_DISABLED", false),
    holidayRefreshMs: intEnv(env, "HOLIDAY_REFRESH_HOURS", 168, 1, 720) * 3600 * 1000,
    holidayFetchTimeoutMs: intEnv(env, "HOLIDAY_FETCH_TIMEOUT_MS", 10000, 1000, 30000),
    holidayRetryMs: intEnv(env, "HOLIDAY_RETRY_MINUTES", 60, 5, 1440) * 60 * 1000,

    apiKey: String(env.DEEPSEEK_API_KEY || "").trim(),
    apiKeyFileCandidates: defaultKeyFileCandidates(env),
    balanceDisabled: boolEnv(env, "BALANCE_DISABLED", false),
    balanceRefreshMs: intEnv(env, "BALANCE_REFRESH_SECONDS", 300, 60, 86400) * 1000,
    balanceRetryMs: intEnv(env, "BALANCE_RETRY_SECONDS", 60, 15, 3600) * 1000,
    balanceTimeoutMs: intEnv(env, "BALANCE_TIMEOUT_MS", 10000, 1000, 30000),
    balanceManualCooldownMs: intEnv(env, "BALANCE_MANUAL_COOLDOWN_SECONDS", 30, 5, 3600) * 1000,

    // Embedded in the page so the client can tell users what it is talking to.
    version: require("../package.json").version
  }
}

// Everything safe to write to a startup log. A key or token must never appear.
function redactConfig(config) {
  return {
    port: config.port,
    host: config.host,
    dataDir: config.dataDir,
    cacheDir: config.cacheDir,
    auth: config.widgetToken !== "",
    timeFormat: config.timeFormat,
    holidaysDisabled: config.holidaysDisabled,
    balanceDisabled: config.balanceDisabled,
    hasEnvironmentKey: config.apiKey !== "",
    keyFileCandidates: config.apiKeyFileCandidates,
    pollAfterMs: config.pollAfterMs,
    version: config.version
  }
}

module.exports = { loadConfig, redactConfig }
