// Live widget controller.
//
// The server computes the billing state and sends absolute instants. This file
// only formats them in the viewer's timezone, ticks the countdown from a
// monotonic anchor, and refetches at the next known boundary or on failure.
// A state is never shown past its next transition if the refetch fails.

(function () {
  "use strict"

  var core = window.DeepSeekWidgetCore
  if (!core) return

  var params = new URLSearchParams(window.location.search)
  var token = params.get("token") || ""
  var accentOverride = safeColor(params.get("accent"))
  var queryTimeFormat = params.get("time") || params.get("clock") || ""
  var timeFormat = core.normalizeTimeFormat(queryTimeFormat)
  var timeFormatLocked = queryTimeFormat !== ""
  var basePath = "/"

  var widgetScript = document.querySelector('script[src$="widget.js"]')
  if (widgetScript && widgetScript.src) {
    try {
      basePath = new URL(".", widgetScript.src).pathname
    } catch (error) {
      basePath = "/"
    }
  }

  var els = {
    app: document.getElementById("app"),
    phaseBadge: document.getElementById("phaseBadge"),
    phaseLabel: document.getElementById("phaseLabel"),
    countdown: document.getElementById("countdown"),
    nextLabel: document.getElementById("nextLabel"),
    switchTitle: document.getElementById("switchTitle"),
    switchLocal: document.getElementById("switchLocal"),
    switchSub: document.getElementById("switchSub"),
    switchUtc: document.getElementById("switchUtc"),
    nowMain: document.getElementById("nowMain"),
    nowUtc: document.getElementById("nowUtc"),
    nowOffset: document.getElementById("nowOffset"),
    timeline: document.getElementById("timeline"),
    timelineBar: document.getElementById("timelineBar"),
    timelineAxis: document.getElementById("timelineAxis"),
    holidayTag: document.getElementById("holidayTag"),
    peakLocal: document.getElementById("peakLocal"),
    peakUtc: document.getElementById("peakUtc"),
    offPeakEnd: document.getElementById("offPeakEnd"),
    beijingNow: document.getElementById("beijingNow"),
    dayLabel: document.getElementById("dayLabel"),
    balanceSection: document.getElementById("balanceSection"),
    balanceAge: document.getElementById("balanceAge"),
    balanceRefresh: document.getElementById("balanceRefresh"),
    balanceRows: document.getElementById("balanceRows"),
    balanceMessage: document.getElementById("balanceMessage"),
    statusNote: document.getElementById("statusNote"),
    warning: document.getElementById("warning"),
    footBrand: document.querySelector(".foot-brand")
  }

  var snapshot = null
  var anchorServerMs = 0
  var anchorPerfMs = 0
  var lastSuccessServerMs = 0
  var failures = 0
  var lastError = ""
  var statusInFlight = false
  var pollTimer = null
  var transitioning = false
  var unknown = false
  var balanceBusy = false
  var manualBalanceError = ""
  var balanceMeta = null
  var lastDayKey = ""

  function serverNow() {
    return anchorServerMs + (performance.now() - anchorPerfMs)
  }

  function apiUrl(path) {
    var relative = String(path).replace(/^\/+/, "")
    var url = new URL(relative, window.location.origin + basePath)
    if (token) url.searchParams.set("token", token)
    return url.toString()
  }

  async function fetchJson(path, timeoutMs) {
    var controller = new AbortController()
    var timer = setTimeout(function () { controller.abort() }, timeoutMs)
    try {
      var response = await fetch(apiUrl(path), {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: controller.signal
      })
      if (response.status === 401) throw new Error("auth")
      if (!response.ok) throw new Error("http_" + response.status)
      return await response.json()
    } finally {
      clearTimeout(timer)
    }
  }

  // ---------------------------------------------------------------- theme

  function safeColor(value) {
    if (typeof value !== "string") return ""
    var text = value.trim()
    return /^#[0-9a-fA-F]{3,8}$/.test(text) ? text : ""
  }

  function setVar(name, value) {
    if (!value) return
    document.documentElement.style.setProperty(name, value)
  }

  function applyAccentOverride() {
    if (accentOverride) setVar("--accent", accentOverride)
  }

  function setTheme(theme) {
    if (theme !== "light" && theme !== "dark") return
    document.documentElement.dataset.theme = theme
    applyAccentOverride()
  }

  function colorLuminance(value) {
    if (!value) return null
    var probe = document.createElement("span")
    probe.style.color = value
    probe.style.display = "none"
    document.body.appendChild(probe)
    var computed = getComputedStyle(probe).color
    document.body.removeChild(probe)
    var match = /rgba?\(([^)]+)\)/.exec(computed)
    if (!match) return null
    var parts = match[1].split(",").map(function (part) { return Number(part.trim()) })
    if (parts.length < 3 || parts.some(function (n) { return !Number.isFinite(n) })) return null
    return (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255
  }

  function syncParentTheme() {
    if (window.parent === window) return false
    try {
      var parentDoc = window.parent.document
      var parentRoot = parentDoc.documentElement
      var style = getComputedStyle(parentRoot)
      var bodyStyle = parentDoc.body ? getComputedStyle(parentDoc.body) : style
      var background = style.getPropertyValue("--color-background").trim()
        || style.backgroundColor
      if (!background || background === "rgba(0, 0, 0, 0)" || background === "transparent") {
        background = bodyStyle.backgroundColor
      }
      var fg = style.getPropertyValue("--color-text-highlight").trim()
      var muted = style.getPropertyValue("--color-text-paragraph").trim()
      var dim = style.getPropertyValue("--color-text-subdue").trim()
      var line = style.getPropertyValue("--color-separator").trim()
      var accent = style.getPropertyValue("--color-primary").trim()
      var widgetBackground = style.getPropertyValue("--color-widget-background").trim()
      var widgetBorder = style.getPropertyValue("--color-widget-content-border").trim()
      var radius = style.getPropertyValue("--border-radius").trim()

      if (fg) setVar("--fg", fg)
      if (muted) setVar("--muted", muted)
      if (dim) setVar("--dim", dim)
      if (line) setVar("--line", line)
      if (accent) setVar("--accent", accent)
      if (widgetBackground) setVar("--card-bg", widgetBackground)
      if (widgetBorder) setVar("--card-border", widgetBorder)
      if (radius) setVar("--radius", radius)
      if (background) setVar("--bg-solid", background)

      var luminance = colorLuminance(background)
      if (luminance !== null) setTheme(luminance < 0.5 ? "dark" : "light")
      applyAccentOverride()
      return true
    } catch (error) {
      // Cross-origin parent: fall back to the media query.
      return false
    }
  }

  function initTheme() {
    var requested = params.get("theme") || "auto"
    if (window.top === window.self || params.get("standalone") === "1") {
      document.documentElement.classList.add("standalone")
    }

    if (requested === "dark" || requested === "light") {
      setTheme(requested)
      return
    }

    if (!syncParentTheme()) {
      var media = window.matchMedia("(prefers-color-scheme: dark)")
      var applyMedia = function () { setTheme(media.matches ? "dark" : "light") }
      applyMedia()
      if (media.addEventListener) media.addEventListener("change", applyMedia)
      else if (media.addListener) media.addListener(applyMedia)
    }

    // A same-origin Glance theme can change at runtime. Re-syncing a few times
    // is cheap and keeps the iframe consistent without a Glance patch.
    setInterval(function () {
      if (requested === "auto") syncParentTheme()
    }, 10000)
  }

  // ---------------------------------------------------------------- render

  function renderInitial() {
    els.app.dataset.state = "loading"
    els.app.dataset.connection = "connecting"
    els.countdown.textContent = "--:--:--"
    els.nextLabel.textContent = "connecting"
    els.switchTitle.textContent = "NEXT CHANGE"
    els.switchLocal.textContent = "--:--"
    els.switchSub.textContent = "local"
    els.switchUtc.textContent = "--:-- UTC"
    els.nowMain.textContent = "--:-- local"
    els.nowUtc.textContent = "--:-- UTC"
    els.nowOffset.textContent = "UTC"
    els.peakLocal.textContent = "--"
    els.peakUtc.textContent = ""
    els.offPeakEnd.textContent = "--:--"
    els.beijingNow.textContent = "--:--"
    els.dayLabel.textContent = "--"
    els.statusNote.textContent = "Connecting…"
    els.balanceSection.hidden = true
    els.timelineBar.innerHTML = '<div class="bar-empty"></div>'
    els.timelineAxis.textContent = ""
  }

  function renderAll() {
    var now = serverNow()
    var view = core.deriveView(snapshot, now, timeFormat)
    transitioning = false
    unknown = false
    els.app.dataset.connection = "live"
    els.app.dataset.state = view.state
    els.phaseLabel.textContent = view.phaseLabel
    els.phaseBadge.setAttribute("aria-label", view.phaseLabel + " billing state")
    els.countdown.style.color = ""
    renderDynamic(view, now)
    renderTimeline(view)
    renderBalance(snapshot.balance, now)
    document.title = "DeepSeek · " + view.phaseLabel
    els.app.setAttribute("aria-label",
      "DeepSeek " + view.phaseLabel + ", " + view.remainingClock + " until " + view.nextSwitchLabel.toLowerCase())
  }

  function renderDynamic(view, now) {
    if (unknown || transitioning) return
    var current = view || core.deriveView(snapshot, now || serverNow(), timeFormat)
    els.countdown.textContent = current.remainingClock
    els.nextLabel.textContent = current.peak ? "until off-peak" : "until peak"
    els.switchTitle.textContent = current.nextSwitchLabel.toUpperCase()
    els.switchLocal.textContent = current.nextSwitchLocalClock
    els.switchSub.textContent = current.nextSwitchLocalDay + " local"
    els.switchUtc.textContent = current.nextSwitchUtcClock + " UTC"
    els.nowMain.textContent = current.nowLocalClock + " local"
    els.nowUtc.textContent = current.nowUtcClock + " UTC"
    els.nowOffset.textContent = current.nowOffset
    els.beijingNow.textContent = current.nowBeijingClock
    els.dayLabel.textContent = current.nowLocalDay
    els.offPeakEnd.textContent = current.offPeakEndLocalClock + " local"
    els.offPeakEnd.title = current.offPeakEndUtcClock + " UTC"
    updateFoot(now)
    updateBalanceAge(now)
  }

  function renderTimeline(view) {
    var day = view.day
    els.timelineBar.textContent = ""
    els.timelineAxis.textContent = ""
    els.holidayTag.textContent = ""

    if (!day.available) {
      var empty = document.createElement("div")
      empty.className = "bar-empty"
      els.timelineBar.appendChild(empty)
      els.timelineBar.setAttribute("aria-label", "Timeline unavailable")
      els.peakLocal.textContent = "Unavailable"
      els.peakUtc.textContent = ""
      return
    }

    for (var i = 0; i < day.segments.length; i++) {
      var segment = day.segments[i]
      var block = document.createElement("div")
      block.className = "bar-segment" + (segment.peak ? " is-peak" : "")
      block.style.left = (segment.startFrac * 100).toFixed(4) + "%"
      block.style.width = Math.max(0, (segment.endFrac - segment.startFrac) * 100).toFixed(4) + "%"
      els.timelineBar.appendChild(block)
    }

    var marker = document.createElement("div")
    marker.className = "bar-now"
    marker.style.left = (Math.min(0.9995, Math.max(0, day.nowFrac)) * 100).toFixed(4) + "%"
    els.timelineBar.appendChild(marker)

    for (var j = 0; j < day.axis.length; j++) {
      var tick = document.createElement("span")
      tick.style.left = (day.axis[j].frac * 100).toFixed(4) + "%"
      tick.textContent = day.axis[j].label
      els.timelineAxis.appendChild(tick)
    }

    if (day.peaks.length > 0) {
      els.peakLocal.textContent = day.peaks.map(function (peak) { return peak.localLabel }).join(" \u00b7 ")
      els.peakUtc.textContent = day.peaks.map(function (peak) { return peak.utcLabel }).join(" \u00b7 ") + " UTC"
    } else {
      els.peakLocal.textContent = day.holidayName
        ? "None \u2014 " + day.holidayName + ", off-peak all day"
        : "None \u2014 off-peak all day"
      els.peakUtc.textContent = ""
    }
    if (day.holidayName) els.holidayTag.textContent = day.holidayName + " \u00b7 holiday"

    els.timelineBar.setAttribute("aria-label",
      "Today: " + (day.peaks.length > 0
        ? "peak " + day.peaks.map(function (peak) { return peak.localLabel }).join(", ") + " local"
        : "off-peak all day"))
    els.timeline.setAttribute("aria-label", els.timelineBar.getAttribute("aria-label"))
  }

  function renderBalance(balance, now) {
    balanceMeta = balance
    if (!balance || !balance.enabled) {
      els.balanceSection.hidden = true
      return
    }
    els.balanceSection.hidden = false
    els.balanceRows.textContent = ""
    els.balanceMessage.hidden = true
    els.balanceMessage.classList.remove("is-error")
    els.balanceRefresh.disabled = balanceBusy || balance.refreshing || balance.status === "loading"
    els.balanceRefresh.classList.toggle("is-busy", balanceBusy || balance.refreshing)

    var message = ""
    var isError = false

    if (balance.status === "error") {
      isError = true
      message = balance.errorMessage || describeBalanceError(balance.error)
      if (balance.lastGoodAtMs > 0) message += " \u00b7 last good " + core.formatAge(balance.lastGoodAtMs, now || serverNow())
    } else if (balance.status === "ok") {
      if (balance.balances.length === 0) {
        message = balance.isAvailable ? "No balance reported" : "Account not available for API calls"
      } else if (!balance.isAvailable) {
        message = "Account not available for API calls"
      }
      for (var i = 0; i < balance.balances.length; i++) {
        els.balanceRows.appendChild(balanceRow(balance.balances[i]))
      }
    } else if (balance.status === "loading") {
      if (balance.balances && balance.balances.length > 0) {
        for (var j = 0; j < balance.balances.length; j++) {
          els.balanceRows.appendChild(balanceRow(balance.balances[j]))
        }
      }
    } else {
      els.balanceSection.hidden = true
      return
    }

    if (manualBalanceError && balance.status !== "error") {
      message = manualBalanceError
      isError = true
    }

    if (message) {
      els.balanceMessage.hidden = false
      els.balanceMessage.textContent = message
      if (isError) els.balanceMessage.classList.add("is-error")
    }

    updateBalanceAge(now || serverNow())
  }

  function balanceRow(entry) {
    var row = document.createElement("div")
    row.className = "balance-row"

    var currency = document.createElement("span")
    currency.className = "balance-currency"
    currency.textContent = entry.currency || "?"

    var total = document.createElement("span")
    total.className = "balance-total"
    total.textContent = entry.totalBalance || "0"

    var detail = document.createElement("span")
    detail.className = "balance-detail"
    detail.textContent = "granted " + (entry.grantedBalance || "0")
      + " \u00b7 topped up " + (entry.toppedUpBalance || "0")

    row.appendChild(currency)
    row.appendChild(total)
    row.appendChild(detail)
    return row
  }

  function updateBalanceAge(now) {
    if (!balanceMeta || !balanceMeta.enabled) {
      els.balanceAge.textContent = ""
      return
    }
    if (balanceBusy || balanceMeta.refreshing || balanceMeta.status === "loading") {
      els.balanceAge.textContent = "updating"
      return
    }
    if (balanceMeta.status === "ok" && balanceMeta.updatedAtMs > 0) {
      els.balanceAge.textContent = core.formatAge(balanceMeta.updatedAtMs, now)
      return
    }
    if (balanceMeta.status === "error" && balanceMeta.lastGoodAtMs > 0) {
      els.balanceAge.textContent = "last good " + core.formatAge(balanceMeta.lastGoodAtMs, now)
      return
    }
    els.balanceAge.textContent = ""
  }

  function describeBalanceError(error) {
    if (error === "missing_api_key") return "Balance key not configured"
    if (error === "invalid_api_key_file") return "Key file must contain one sk-\u2026 line"
    if (error === "network_error") return "Could not reach api.deepseek.com"
    if (error === "invalid_response") return "Unexpected balance API response"
    if (error === "http_401") return "Balance API rejected the key"
    if (error === "http_429") return "Balance API rate limited"
    if (typeof error === "string" && error.indexOf("http_") === 0)
      return "Balance API returned " + error.slice(5)
    return "Balance unavailable"
  }

  function updateFoot(now) {
    if (!snapshot) {
      els.statusNote.textContent = "Connecting\u2026"
      return
    }

    var age = core.formatAge(lastSuccessServerMs, now)
    if (unknown) {
      els.statusNote.textContent = "Offline \u00b7 last update " + age
    } else if (transitioning) {
      els.statusNote.textContent = "Updating\u2026"
    } else if (failures > 0) {
      els.statusNote.textContent = "Reconnecting \u00b7 updated " + age
    } else {
      els.statusNote.textContent = "Live \u00b7 updated " + age
    }

    var warnings = []
    var isError = false
    if (unknown) {
      warnings.push("Live schedule unavailable \u2014 retrying")
      isError = true
    } else if (failures > 0) {
      if (snapshot && Number.isFinite(snapshot.nextSwitchMs)) {
        warnings.push("Reconnecting \u2014 state valid until " + core.hhmmLocal(snapshot.nextSwitchMs, timeFormat))
      } else {
        warnings.push("Reconnecting")
      }
    }

    var holidays = snapshot.holidays || {}
    if (holidays.currentYearSource === "missing" && holidays.currentYear) {
      warnings.push("Holiday data unavailable for " + holidays.currentYear + " \u2014 weekday rule only")
      isError = true
    } else if (holidays.stale && holidays.currentYearSource === "fallback") {
      warnings.push("Using baked 2026 holiday fallback")
    } else if (holidays.lastError) {
      warnings.push("Holiday refresh failed (" + holidays.lastError + ")")
    }

    if (warnings.length === 0 && !unknown && failures === 0
      && now - lastSuccessServerMs > (snapshot.pollAfterMs || 30000) * 3) {
      warnings.push("Schedule update delayed")
      isError = true
    }

    if (warnings.length > 0) {
      els.warning.hidden = false
      els.warning.textContent = warnings[0]
      els.warning.title = warnings.join("\n")
      els.warning.classList.toggle("is-error", isError)
    } else {
      els.warning.hidden = true
      els.warning.textContent = ""
      els.warning.title = ""
      els.warning.classList.remove("is-error")
    }

    var years = Array.isArray(holidays.tableYears) ? holidays.tableYears : []
    els.footBrand.textContent = "Holidays: " + (years.length > 0 ? years.join(", ") : "none")
    els.footBrand.title = "Holiday dates: holiday-cn (github.com/NateScarlet/holiday-cn)"
  }

  function renderTransitioning() {
    var now = serverNow()
    els.app.dataset.state = "loading"
    els.app.dataset.connection = "live"
    els.phaseLabel.textContent = "Updating"
    els.countdown.textContent = "\u2014"
    els.nextLabel.textContent = "waiting for next state"
    els.switchTitle.textContent = "NEXT CHANGE"
    els.switchLocal.textContent = "\u2014"
    els.switchSub.textContent = "checking"
    els.switchUtc.textContent = ""
    els.offPeakEnd.textContent = "\u2014"
    els.offPeakEnd.title = ""
    els.nowMain.textContent = core.hhmmLocal(now, timeFormat) + " local"
    els.nowUtc.textContent = core.hhmmUtc(now, timeFormat) + " UTC"
    els.nowOffset.textContent = core.offsetLabel(now)
    els.beijingNow.textContent = core.hhmmUtc(now + 8 * 3600000, timeFormat)
    updateFoot(now)
  }

  function renderUnknown() {
    els.app.dataset.state = "unknown"
    els.app.dataset.connection = "offline"
    els.phaseLabel.textContent = "Unknown"
    els.countdown.textContent = "\u2014"
    els.nextLabel.textContent = "schedule unavailable"
    els.switchTitle.textContent = "NO LIVE DATA"
    els.switchLocal.textContent = "\u2014"
    els.switchSub.textContent = "retrying"
    els.switchUtc.textContent = ""
    els.offPeakEnd.textContent = "\u2014"
    els.offPeakEnd.title = ""
    els.timelineBar.textContent = ""
    var empty = document.createElement("div")
    empty.className = "bar-empty"
    els.timelineBar.appendChild(empty)
    els.timelineBar.setAttribute("aria-label", "Timeline unavailable")
    els.timelineAxis.textContent = ""
    els.holidayTag.textContent = ""
    els.peakLocal.textContent = "Unavailable"
    els.peakUtc.textContent = ""
    var now = serverNow()
    els.dayLabel.textContent = core.weekdayLocal(now) + " " + core.pad2(new Date(now).getMonth() + 1)
      + "-" + core.pad2(new Date(now).getDate())
    els.nowMain.textContent = core.hhmmLocal(now, timeFormat) + " local"
    els.nowUtc.textContent = core.hhmmUtc(now, timeFormat) + " UTC"
    els.nowOffset.textContent = core.offsetLabel(now)
    els.beijingNow.textContent = core.hhmmUtc(now + 8 * 3600000, timeFormat)
    document.title = "DeepSeek \u00b7 Unavailable"
    updateFoot(now)
  }

  // ---------------------------------------------------------------- data

  async function fetchStatus() {
    if (statusInFlight) return
    statusInFlight = true
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
    var startedPerf = performance.now()

    try {
      var data = await fetchJson("/api/status", 8000)
      validateStatus(data)
      if (!timeFormatLocked) timeFormat = core.normalizeTimeFormat(data.timeFormat)
      var receivedPerf = performance.now()
      var rtt = receivedPerf - startedPerf
      anchorServerMs = data.nowMs + rtt / 2
      anchorPerfMs = receivedPerf

      snapshot = data
      lastSuccessServerMs = data.nowMs
      failures = 0
      lastError = ""
      transitioning = false
      unknown = false
      manualBalanceError = ""
      lastDayKey = localDayKey(serverNow())
      renderAll()
      scheduleNext()
    } catch (error) {
      failures++
      lastError = friendlyError(error)
      var now = serverNow()
      if (!snapshot || (Number.isFinite(snapshot.nextSwitchMs) && now >= snapshot.nextSwitchMs)) {
        transitioning = false
        unknown = true
        renderUnknown()
        scheduleRetry()
      } else {
        els.app.dataset.connection = "degraded"
        renderDynamic(null, now)
        updateFoot(now)
        scheduleRetry()
      }
    } finally {
      statusInFlight = false
    }
  }

  function validateStatus(data) {
    if (!data || data.id !== "deepseek-offpeak") throw new Error("invalid_status")
    if (typeof data.peak !== "boolean") throw new Error("invalid_status")
    if (!Number.isFinite(data.nowMs) || !Number.isFinite(data.nextSwitchMs)) throw new Error("invalid_status")
    if (!Array.isArray(data.runs)) throw new Error("invalid_status")
  }

  function friendlyError(error) {
    var message = error && error.message ? error.message : "error"
    if (message === "auth") return "Unauthorized \u2014 check the widget token"
    if (message === "invalid_status") return "Invalid status response"
    if (message.indexOf("http_") === 0) return "Server error (" + message.slice(5) + ")"
    if (message === "AbortError") return "Request timed out"
    return "Network error"
  }

  function scheduleNext() {
    clearPoll()
    if (!snapshot) return
    var now = serverNow()
    var delay = snapshot.pollAfterMs || 30000
    var untilSwitch = snapshot.nextSwitchMs - now
    if (untilSwitch <= 0) delay = 250
    else if (untilSwitch < delay) delay = untilSwitch + 500
    pollTimer = setTimeout(fetchStatus, Math.max(1000, delay))
  }

  function scheduleRetry() {
    clearPoll()
    var delay = Math.min(30000, 2000 * Math.pow(2, Math.min(failures - 1, 4)))
    if (snapshot && Number.isFinite(snapshot.nextSwitchMs)) {
      var untilSwitch = snapshot.nextSwitchMs - serverNow()
      if (untilSwitch > 0 && untilSwitch + 500 < delay) delay = untilSwitch + 500
    }
    pollTimer = setTimeout(fetchStatus, Math.max(1200, delay))
  }

  function clearPoll() {
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  function tick() {
    var now = serverNow()
    if (snapshot && !unknown && !transitioning && now >= snapshot.nextSwitchMs) {
      transitioning = true
      renderTransitioning()
      fetchStatus()
      return
    }
    if (snapshot && !unknown) {
      if (!transitioning) renderDynamic(null, now)
      updateFoot(now)
    }
  }

  async function refreshBalance() {
    if (balanceBusy) return
    balanceBusy = true
    manualBalanceError = ""
    if (balanceMeta) renderBalance(balanceMeta, serverNow())
    try {
      var data = await fetchJson("/api/balance?refresh=1", 12000)
      if (snapshot && data && data.balance) {
        snapshot.balance = data.balance
        renderBalance(data.balance, serverNow())
      }
    } catch (error) {
      manualBalanceError = "Balance refresh failed \u2014 " + friendlyError(error)
      if (balanceMeta) renderBalance(balanceMeta, serverNow())
    } finally {
      balanceBusy = false
      if (snapshot) renderBalance(snapshot.balance, serverNow())
    }
  }

  function localDayKey(ms) {
    var d = new Date(ms)
    return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate()
  }

  // ---------------------------------------------------------------- events

  function onVisibility() {
    if (document.visibilityState === "visible") {
      fetchStatus()
      tick()
    }
  }

  function onPageShow(event) {
    if (event && event.persisted) fetchStatus()
  }

  function init() {
    initTheme()
    renderInitial()
    els.balanceRefresh.addEventListener("click", refreshBalance)
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("online", fetchStatus)
    window.addEventListener("pageshow", onPageShow)
    setInterval(tick, 1000)
    fetchStatus()
  }

  // A local midnight changes the day timeline even when the billing state does
  // not. Recompute it when the viewer's date rolls over.
  setInterval(function () {
    if (!snapshot || unknown) return
    var key = localDayKey(serverNow())
    if (key !== lastDayKey) {
      lastDayKey = key
      var view = core.deriveView(snapshot, serverNow(), timeFormat)
      renderTimeline(view)
    }
  }, 5000)

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init)
  else init()
})();
