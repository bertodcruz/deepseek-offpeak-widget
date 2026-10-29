"use strict"

const http = require("node:http")
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")

const { loadConfig, redactConfig } = require("./config")
const { HolidayService } = require("./holiday-service")
const { BalanceService } = require("./balance-service")
const Status = require("./status")

const PUBLIC_DIR = path.join(__dirname, "..", "public")

const ASSETS = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/widget.css", { file: "widget.css", type: "text/css; charset=utf-8" }],
  ["/widget-core.js", { file: "widget-core.js", type: "text/javascript; charset=utf-8" }],
  ["/widget.js", { file: "widget.js", type: "text/javascript; charset=utf-8" }],
  ["/deepseek.svg", { file: "deepseek.svg", type: "image/svg+xml" }],
  ["/favicon.svg", { file: "favicon.svg", type: "image/svg+xml" }],
  ["/fonts/JetBrainsMono-Regular.woff2", { file: "fonts/JetBrainsMono-Regular.woff2", type: "font/woff2" }],
  ["/fonts/OFL.txt", { file: "fonts/OFL.txt", type: "text/plain; charset=utf-8" }]
])

function loadAssets(publicDir) {
  const loaded = new Map()
  for (const [route, asset] of ASSETS) {
    const body = fs.readFileSync(path.join(publicDir, asset.file))
    loaded.set(route, {
      body,
      type: asset.type,
      etag: "\"" + crypto.createHash("sha256").update(body).digest("hex").slice(0, 24) + "\""
    })
  }
  return loaded
}

function createLogger(level) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }
  const threshold = levels[level] === undefined ? 20 : levels[level]
  const write = (name, stream, message, extra) => {
    if (levels[name] < threshold) return
    const suffix = extra === undefined ? "" : " " + JSON.stringify(extra)
    stream.write(new Date().toISOString() + " " + name.toUpperCase() + " " + message + suffix + "\n")
  }
  return {
    debug: (message, extra) => write("debug", process.stdout, message, extra),
    info: (message, extra) => write("info", process.stdout, message, extra),
    warn: (message, extra) => write("warn", process.stderr, message, extra),
    error: (message, extra) => write("error", process.stderr, message, extra)
  }
}

function createApp(options) {
  const config = options.config
  const logger = options.logger || createLogger(config.logLevel)
  const publicDir = options.publicDir || PUBLIC_DIR
  const now = options.now || (() => Date.now())
  const assets = loadAssets(publicDir)

  const holidayService = options.holidayService || new HolidayService({
    cacheDir: config.cacheDir,
    disabled: config.holidaysDisabled,
    refreshMs: config.holidayRefreshMs,
    fetchTimeoutMs: config.holidayFetchTimeoutMs,
    retryMs: config.holidayRetryMs,
    now,
    logger
  })

  const balanceService = options.balanceService || new BalanceService({
    apiKey: config.apiKey,
    apiKeyFileCandidates: config.apiKeyFileCandidates,
    disabled: config.balanceDisabled,
    refreshMs: config.balanceRefreshMs,
    retryMs: config.balanceRetryMs,
    timeoutMs: config.balanceTimeoutMs,
    manualCooldownMs: config.balanceManualCooldownMs,
    now,
    logger
  })

  const token = config.widgetToken || ""

  const server = http.createServer((request, response) => {
    const started = process.hrtime.bigint()
    const url = new URL(request.url || "/", "http://localhost")
    const pathname = normalizePath(url.pathname)

    response.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6
      logger.debug(request.method + " " + pathname + " " + response.statusCode + " " + ms.toFixed(1) + "ms")
    })

    handleRequest({
      request,
      response,
      url,
      pathname,
      config,
      assets,
      holidayService,
      balanceService,
      logger,
      now,
      token
    }).catch((error) => {
      logger.error("request failed: " + safeMessage(error))
      if (!response.headersSent) {
        sendJson(response, 500, { error: "internal_error" }, { "cache-control": "no-store" })
      } else {
        try { response.destroy() } catch (_) { /* already gone */ }
      }
    })
  })

  server.requestTimeout = 20000
  server.headersTimeout = 10000
  server.keepAliveTimeout = 5000
  server.maxHeadersCount = 100

  return { server, holidayService, balanceService, logger }
}

async function handleRequest(context) {
  const { request, response, url, pathname, config, assets, holidayService, balanceService, now, token } = context

  setSecurityHeaders(response)

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD")
    sendJson(response, 405, { error: "method_not_allowed" }, { "cache-control": "no-store" })
    return
  }

  if (pathname === "/healthz") {
    sendJson(response, 200, {
      status: "ok",
      version: config.version,
      nowMs: Math.round(now()),
      uptimeSeconds: Math.round(process.uptime())
    }, { "cache-control": "no-store" })
    return
  }

  if (pathname === "/robots.txt") {
    sendText(response, 200, "User-agent: *\nDisallow: /\n", "text/plain; charset=utf-8")
    return
  }

  if (pathname === "/favicon.ico") {
    response.writeHead(204, { "cache-control": "public, max-age=86400" })
    response.end()
    return
  }

  // Static assets contain no secrets. The HTML and APIs below are gated when a
  // token is configured; the JS picks the token up from the page URL.
  const asset = assets.get(pathname)
  if (asset) {
    if (pathname === "/") {
      if (!isAuthorized(request, url, token)) {
        sendAuthRequired(response)
        return
      }
    }
    sendAsset(request, response, asset, pathname)
    return
  }

  if (!isAuthorized(request, url, token)) {
    sendAuthRequired(response)
    return
  }

  if (pathname === "/api/status") {
    const table = holidayService.getTable()
    const body = Status.buildStatus({
      nowMs: now(),
      holidays: table,
      holidaySnapshot: holidayService.snapshot(),
      balanceSnapshot: balanceService.snapshot(),
      pollAfterMs: config.pollAfterMs,
      timeFormat: config.timeFormat,
      version: config.version
    })
    response.setHeader("x-server-now-ms", String(body.nowMs))
    sendJson(response, 200, body, { "cache-control": "no-store" })
    return
  }

  if (pathname === "/api/holidays") {
    const snapshot = holidayService.snapshot()
    const body = {
      apiVersion: Status.API_VERSION,
      generatedAtMs: Math.round(now()),
      table: holidayService.getTable(),
      meta: Status.publicHolidayMeta(snapshot)
    }
    sendJson(response, 200, body, { "cache-control": "no-store" })
    return
  }

  if (pathname === "/api/balance") {
    let snapshot
    if (url.searchParams.get("refresh") === "1") {
      snapshot = await balanceService.refresh({ manual: true })
    } else {
      snapshot = balanceService.snapshot()
    }
    sendJson(response, 200, {
      apiVersion: Status.API_VERSION,
      generatedAtMs: Math.round(now()),
      balance: Status.publicBalance(snapshot)
    }, { "cache-control": "no-store" })
    return
  }

  sendJson(response, 404, { error: "not_found" }, { "cache-control": "no-store" })
}

function normalizePath(pathname) {
  if (!pathname) return "/"
  // The asset map is exact, so this is only for nicer matching of "/widget/".
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1)
  return pathname
}

function setSecurityHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff")
  response.setHeader("referrer-policy", "no-referrer")
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()")
  response.setHeader("content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    + "font-src 'self'; connect-src 'self'; frame-ancestors * http: https:; base-uri 'none'; form-action 'none'")
}

function sendAsset(request, response, asset, pathname) {
  const cacheControl = pathname.startsWith("/fonts/")
    ? "public, max-age=86400"
    : "no-cache"
  response.setHeader("cache-control", cacheControl)
  response.setHeader("etag", asset.etag)
  if (request.headers["if-none-match"] === asset.etag) {
    response.writeHead(304)
    response.end()
    return
  }
  response.setHeader("content-type", asset.type)
  response.setHeader("content-length", String(asset.body.length))
  response.writeHead(200)
  if (request.method === "HEAD") response.end()
  else response.end(asset.body)
}

function sendText(response, status, text, type) {
  const body = Buffer.from(text, "utf8")
  response.setHeader("content-type", type)
  response.setHeader("cache-control", "no-store")
  response.setHeader("content-length", String(body.length))
  response.writeHead(status)
  response.end(body)
}

function sendJson(response, status, value, extraHeaders) {
  const body = Buffer.from(JSON.stringify(value), "utf8")
  response.setHeader("content-type", "application/json; charset=utf-8")
  response.setHeader("content-length", String(body.length))
  response.setHeader("x-content-type-options", "nosniff")
  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) response.setHeader(name, value)
  }
  response.writeHead(status)
  response.end(body)
}

function sendAuthRequired(response) {
  sendJson(response, 401, { error: "unauthorized" }, {
    "cache-control": "no-store",
    "www-authenticate": "Bearer"
  })
}

function isAuthorized(request, url, token) {
  if (!token) return true
  const candidates = [
    url.searchParams.get("token") || "",
    headerValue(request.headers["x-widget-token"]),
    bearerToken(request.headers.authorization)
  ]
  return candidates.some((candidate) => safeEqual(candidate, token))
}

function headerValue(value) {
  return Array.isArray(value) ? value[0] || "" : String(value || "")
}

function bearerToken(value) {
  const text = headerValue(value)
  const match = /^Bearer\s+(.+)$/i.exec(text)
  return match ? match[1] : ""
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false
  const a = Buffer.from(left, "utf8")
  const b = Buffer.from(right, "utf8")
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(a, b)
  } catch (_) {
    return false
  }
}

function safeMessage(error) {
  return error && typeof error.message === "string" ? error.message.slice(0, 200) : "error"
}

async function startFromEnv() {
  let config
  try {
    config = loadConfig()
  } catch (error) {
    process.stderr.write("configuration error: " + safeMessage(error) + "\n")
    process.exitCode = 1
    return
  }

  const logger = createLogger(config.logLevel)
  const app = createApp({ config, logger })

  await app.holidayService.start()
  await app.balanceService.start()

  await new Promise((resolve, reject) => {
    app.server.once("error", reject)
    app.server.listen(config.port, config.host, resolve)
  })

  const address = app.server.address()
  const port = address && typeof address === "object" ? address.port : config.port
  logger.info("DeepSeek off-peak widget listening", {
    url: "http://" + (config.host === "0.0.0.0" ? "127.0.0.1" : config.host) + ":" + port + "/",
    auth: config.widgetToken !== "",
    version: config.version
  })
  logger.debug("configuration", redactConfig(config))

  let closing = false
  const shutdown = async (signal) => {
    if (closing) return
    closing = true
    logger.info("shutting down", { signal })
    app.holidayService.stop()
    app.balanceService.stop()
    app.server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on("SIGINT", () => { shutdown("SIGINT") })
  process.on("SIGTERM", () => { shutdown("SIGTERM") })

  return app
}

module.exports = { createApp, createLogger, loadAssets, startFromEnv, safeEqual }

if (require.main === module) {
  startFromEnv().catch((error) => {
    process.stderr.write("startup failed: " + safeMessage(error) + "\n")
    process.exitCode = 1
  })
}
