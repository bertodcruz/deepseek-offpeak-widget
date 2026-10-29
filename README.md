# Glance DeepSeek Off-Peak

A live DeepSeek peak/off-peak billing card for [Glance](https://github.com/glanceapp/glance), with an
optional account balance.

The card counts down to the next billing change, shows the day's peak windows in local, UTC, and
Beijing time, names Chinese public holidays, and never derives billing state from server load or API
availability. The schedule is computed locally from DeepSeek's published timetable.

<p align="center">
  <img src="docs/preview-offpeak.png?v=2" width="300" alt="Off-peak: green accent, 1:53:48 until peak, today's peak windows and the Beijing clock">
  <img src="docs/preview-peak.png?v=2" width="300" alt="Peak: amber accent, countdown to off-peak at 04:00 UTC">
</p>

## What it does

- **Live countdown** to the next peak or off-peak switch. The browser ticks every second and
  refetches at the boundary; an open Glance page does not need to be reloaded.
- **Correct billing math**: peak is weekdays **01:00–04:00** and **06:00–10:00 UTC**
  (09:00–12:00 and 14:00–18:00 Beijing). Weekends and Chinese public holidays are off-peak all day.
  Windows are half-open, so 04:00 and 10:00 are off-peak and 01:00 and 06:00 are peak.
- **Chinese holidays** from [holiday-cn](https://github.com/NateScarlet/holiday-cn), cached weekly,
  with the published 2026 arrangement baked in as an offline floor.
- **Optional balance** from `https://api.deepseek.com/user/balance`. The API key stays on the server.
- **Theme-aware**: dark/light, follows the OS, or follows Glance's own CSS variables when the widget
  and Glance are served from the same origin.
- **Clock style**: 24-hour by default, or regular time (`7pm`, `10am`, `7:30pm`) with `?time=12h` or
  the `TIME_FORMAT=12h` environment variable.
- **No Glance core changes** and no `allow-potentially-dangerous-html`. The recommended integration
  is Glance's built-in `iframe` widget.
- **Zero runtime dependencies**: Node.js 22+ and the standard library only.

## Quick start (Docker)

```sh
cp .env.example .env
```

Edit `.env` and set the address your **browser** uses to reach this service:

```dotenv
DEEPSEEK_PUBLIC_URL=http://192.168.1.10:8787
```

Then:

```sh
docker compose up -d --build
curl http://localhost:8787/healthz
```

Open `http://192.168.1.10:8787/` to see the card on its own.

To run Glance and the widget together, use the complete example:

```sh
docker compose -f docker-compose.glance.yml up -d --build
```

Then open `http://localhost:8080`. The example mounts `glance/full-glance.yml`, which contains the
widget.

### Add it to an existing Glance

Copy the widget block from `glance/deepseek.yml` into a `small` column in your `glance.yml`:

```yaml
- type: iframe
  title: DeepSeek
  hide-header: true
  source: "${DEEPSEEK_PUBLIC_URL}/?theme=auto"
  height: 360
  css-class: deepseek-offpeak
```

Set `DEEPSEEK_PUBLIC_URL` in the environment of the **Glance** container. It must be reachable by
the browser viewing the dashboard, not just by the Glance server.

- Use `height: 360` without a balance.
- Use `height: 400` if you show balance rows or a long error message.
- `hide-header: true` is recommended because the widget draws its own header and card.
- If `WIDGET_TOKEN` is set on the widget service:

```yaml
source: "${DEEPSEEK_PUBLIC_URL}/?theme=auto&token=${WIDGET_TOKEN}"
```

### Why an iframe?

Glance renders widget HTML once when the page content is fetched. A Glance `custom-api` or extension
widget cannot run its own timer or refresh itself while the dashboard is open. An iframe is a separate
document, so it can tick every second and poll its own API without patching Glance or reloading the
dashboard.

`glance/custom-api.yml` is an optional variant for when Glance and the widget are on the same Docker
network and you want Glance to show a readable error card if the service is down. It still embeds the
same live iframe.

## Configuration

Server settings are environment variables. Display options (theme and clock style) can also be set
per iframe with query parameters.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port. |
| `HOST` | `0.0.0.0` | Listen address. |
| `DATA_DIR` | `./data` | Writable data directory. |
| `CACHE_DIR` | `$DATA_DIR/cache` | Holiday cache directory. |
| `WIDGET_TOKEN` | empty | If set (16+ chars), the HTML page and APIs require a token. |
| `TIME_FORMAT` | `24h` | Default clock style: `24h` or `12h` (`7pm`, `10am`). |
| `HOLIDAYS_DISABLED` | `false` | Use the cached/baked holiday table without network refreshes. |
| `HOLIDAY_REFRESH_HOURS` | `168` | Weekly holiday refresh. |
| `HOLIDAY_FETCH_TIMEOUT_MS` | `10000` | Holiday request timeout. |
| `HOLIDAY_RETRY_MINUTES` | `60` | Retry delay after a failed holiday refresh. |
| `DEEPSEEK_API_KEY` | empty | Optional balance key. |
| `DEEPSEEK_API_KEY_FILE` | see below | Optional path to a one-line key file. |
| `BALANCE_DISABLED` | `false` | Hide the balance entirely. |
| `BALANCE_REFRESH_SECONDS` | `300` | Balance refresh interval. |
| `BALANCE_RETRY_SECONDS` | `60` | Retry delay after a failed balance refresh. |
| `BALANCE_TIMEOUT_MS` | `10000` | Balance request timeout. |
| `BALANCE_MANUAL_COOLDOWN_SECONDS` | `30` | Minimum spacing for the refresh button. |
| `POLL_AFTER_SECONDS` | `30` | Browser status poll interval (also bounded by the next switch). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, or `silent`. |

### Theme

The page accepts:

```text
?theme=auto|dark|light
?accent=%23rrggbb
```

`auto` uses the OS color scheme when the iframe is cross-origin. When Glance and the widget share an
origin (for example through a reverse proxy), it also reads Glance's CSS variables and matches the
dashboard's theme. If Glance uses a light theme and the iframe is on another origin, set
`?theme=light` explicitly.

### Clock style

The default is the 24-hour clock (`19:00`, `10:00`). Add `?time=12h` for regular time:

```text
?time=12h
?time=24h
```

Examples: `7pm`, `10am`, `7:30pm`, `12am`, `12pm`. Whole hours omit `:00`, which keeps the compact
card readable. The option applies to local, UTC, Beijing, peak-window, and next-switch times. The
countdown remains a duration (`1:30:00`), not a clock.

For one Glance widget, change the iframe source:

```yaml
source: "${DEEPSEEK_PUBLIC_URL}/?theme=auto&time=12h"
```

With a token:

```yaml
source: "${DEEPSEEK_PUBLIC_URL}/?theme=auto&time=12h&token=${WIDGET_TOKEN}"
```

For every widget served by this instance, set `TIME_FORMAT=12h` instead. A `?time=` parameter in the
iframe URL overrides the service default.

## Account balance (optional)

The balance is strictly additive. Every balance failure leaves the schedule untouched, and a failed
refresh clears the amounts instead of showing a stale total as current.

The key is read from, in order:

1. `DEEPSEEK_API_KEY`;
2. `DEEPSEEK_API_KEY_FILE`, if set;
3. `$XDG_CONFIG_HOME/deepseek-offpeak/key` or `~/.config/deepseek-offpeak/key`;
4. `/run/secrets/deepseek_api_key`.

A key file must be exactly one `sk-...` line, at most 256 bytes. Nothing is sourced or executed.

```sh
umask 077
printf '%s\n' 'sk-your-key' > ~/.config/deepseek-offpeak/key
```

If no key is found, the balance section is hidden. If a malformed key file is found, the widget shows
a fixable error.

Money stays a string end to end. The API sends fixed-precision decimals such as `"110.00"`; the
widget does not parse them into floats and re-print them.

### Balance errors

| Error | Meaning |
| --- | --- |
| `missing_api_key` | No usable key was found. |
| `invalid_api_key_file` | A key file exists but is not one `sk-...` line. |
| `network_error` | DNS, connection, TLS, or timeout. |
| `http_<code>` | The request returned a non-200 status. |
| `invalid_response` | A 200 that is not the documented JSON shape. |

The key is only used in an `Authorization` header. It never appears in an API response, a log line, or
the browser. Requests are capped at 16 KiB and 10 seconds, redirects are refused, and refreshes are
single-flight.

> **Privacy:** `/api/balance` exposes account totals to anyone who can reach the service. Keep the
> service on a trusted network, put it behind HTTPS/VPN, and set `WIDGET_TOKEN` if other people can
> reach the dashboard. A token in the iframe URL is still visible to someone who can inspect the page;
> it is a convenience boundary, not a substitute for network access control.

## Holidays

DeepSeek's own rule excludes Chinese public holidays. A weekday holiday has no peak windows at all;
the make-up workdays the State Council designates are weekends and are already off-peak.

The service:

- reads cached `holidays-<year>.json` documents for the current and next Beijing year;
- fetches the current year when the cache is missing or older than seven days;
- fetches the next year only from 60 days before the year ends (the notice is published in early
  November);
- validates every document strictly and rejects the whole document on any bad entry;
- merges valid documents over the baked 2026 table;
- writes atomically to `CACHE_DIR` and keeps the last good document on failure.

If the current year has no cached or fetched data (for example, an offline first run in 2027), the
schedule falls back to the weekday rule and the widget displays:

```text
Holiday data unavailable for 2027 — weekday rule only
```

That is deliberate: inventing holiday dates would be worse than showing the weekday rule. The baked
2026 table is a floor, not a second source of truth.

## API

All endpoints are `GET`/`HEAD`.

### `GET /api/status`

The complete snapshot used by the widget.

```json
{
  "id": "deepseek-offpeak",
  "apiVersion": 1,
  "timeFormat": "24h",
  "peak": false,
  "state": "off-peak",
  "nowMs": 1792907499962,
  "nowUtc": "2026-10-25T05:51:39.962Z",
  "nextSwitchMs": 1792976400000,
  "nextSwitchUtc": "2026-10-26T01:00:00.000Z",
  "nextSwitchLabel": "Peak starts",
  "secondsToSwitch": 68901,
  "offPeakEndMs": 1792976400000,
  "holidayName": "",
  "runs": [
    { "startMs": 1792713600000, "endMs": 1792717200000, "peak": false }
  ],
  "holidays": {
    "currentYear": 2026,
    "currentYearSource": "fetched",
    "tableYears": [2026],
    "stale": false,
    "warnings": []
  },
  "balance": {
    "enabled": true,
    "status": "ok",
    "balances": [
      {
        "currency": "CNY",
        "totalBalance": "110.00",
        "grantedBalance": "10.00",
        "toppedUpBalance": "100.00"
      }
    ]
  }
}
```

All instants are absolute milliseconds plus their UTC ISO form. Local wall-clock labels are built by
the viewer, not by the server, so they are correct in a browser in another timezone. `runs` contains
merged constant-state runs around the current instant; the browser clips them to the local day.
`timeFormat` is the service default (`12h` or `24h`); a `?time=` query parameter overrides it in the
browser.

### `GET /api/holidays`

The merged holiday table and its public metadata. No cache path is exposed.

### `GET /api/balance`

The balance state. Add `?refresh=1` to request a manual refresh (rate-limited and single-flight).

### `GET /healthz`

Minimal health response for Docker and monitoring.

### Authentication

When `WIDGET_TOKEN` is set, the HTML page and `/api/*` require the token as:

```text
?token=...
X-Widget-Token: ...
Authorization: Bearer ...
```

Static CSS, JS, SVG, and font files are not gated because they contain no secrets. `/healthz` is also
public. Responses send `Referrer-Policy: no-referrer`, a strict CSP, and no CORS headers; the widget is
same-origin with its own API.

## Reverse proxy and subpaths

The widget supports being served under a subpath. Asset URLs are relative, and the client derives the
API base from the script URL. For nginx:

```nginx
location /deepseek/ {
    proxy_pass http://deepseek-offpeak:8787/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Then set:

```dotenv
DEEPSEEK_PUBLIC_URL=https://glance.example.com/deepseek
```

The trailing slash on both the location and `proxy_pass` matters: it strips `/deepseek/` before the
request reaches the service. Do not use a URL with a trailing slash in `DEEPSEEK_PUBLIC_URL`.

## Security

- The container runs as the unprivileged `node` user.
- The Compose example drops all capabilities, sets `no-new-privileges`, and uses a read-only root
  filesystem with a writable `/data` volume.
- The API key is read server-side and is never sent to the browser.
- Upstream responses are size-capped, timeout-bounded, shape-validated, and control-character
  checked before display.
- The page uses no inline scripts and no external assets; the CSP only allows same-origin resources.
- Holiday writes are atomic and the cache directory is private on POSIX.
- Balances are account data. Use the token and network controls described above.

## Development

Requires Node.js 22 or newer. There are no dependencies to install.

```sh
node src/server.js
# or
npm start
```

Useful local variants:

```sh
# No holiday network calls, no balance
HOLIDAYS_DISABLED=1 BALANCE_DISABLED=1 npm start

# Show the balance with a key in the environment
DEEPSEEK_API_KEY=sk-... npm start
```

PowerShell:

```powershell
$env:HOLIDAYS_DISABLED = "1"
$env:BALANCE_DISABLED = "1"
node src/server.js
```

### Tests

```sh
npm test
npm run check
```

`npm test` runs 113 checks covering:

- schedule boundaries, weekends, holiday runs, the Spring Festival horizon, and countdown edges;
- strict holiday document parsing and the baked 2026 table;
- balance response validation, key-file parsing, error mapping, timeout/oversize handling, and
  single-flight behavior;
- holiday cache adoption, stale refresh, invalid-response rejection, next-year fetch windows, and
  recovery from an unusable cache directory;
- the HTTP surface: status/holiday/balance routes, clock style, token gate, CSP, ETag revalidation,
  404/405;
- browser-side local-day derivation and 12-hour formatting in `public/widget-core.js`.

`test/fake-server.js`, `test/preview.html`, and `test/peak.html` are development aids for visual
checks with fake holiday/balance data.

### Verified in this workspace

- `npm test`: **113/113 passing** on Node v24.18.0 (Windows).
- `npm run check`: JavaScript syntax and required files.
- Live holiday refresh against jsDelivr/holiday-cn: fetched and cached `holidays-2026.json`, source
  reported as `fetched`.
- Browser layouts at 340×360 (dark, light, peak, off-peak, with and without balance) and 300×330
  using Chrome; no horizontal overflow at 340px.
- 12-hour and 24-hour layouts at 340×360 in Chrome, with `TIME_FORMAT=12h` and a `?time=24h`
  override verified against the live page.
- Subpath serving through a prefix-stripping proxy (`/deepseek/`), including relative assets and
  `/deepseek/api/status`.
- Token-protected HTML and API in a real browser: the page loaded with `?token=...` and the client
  propagated the token to `/api/status`.
- YAML files parse with PyYAML.

### Not verified here

- A live DeepSeek balance request, because no API key was available in this environment. The request
  path and validation are covered by fake-fetch tests.
- An actual Glance render, because Go and Docker are not installed in this workspace. The config is
  based on Glance's documented `iframe`/`custom-api` widgets and parses as YAML, but it has not been
  mounted in Glance here.
- A Docker image build, for the same reason. The Dockerfile and Compose files are provided and
  syntactically consistent with the Node entrypoint.

## Troubleshooting

**The iframe is blank.**
The browser cannot reach `DEEPSEEK_PUBLIC_URL`. Open that URL directly from the browser machine. Do not
use `localhost` unless the browser is on the same machine as the service.

**The card says "Live schedule unavailable".**
The browser could not refresh `/api/status` at the moment the state changed. It intentionally stops
presenting the old state as current. Check the service, the token, and the network; it retries with
backoff.

**The balance does not appear.**
No valid key was found. Check `DEEPSEEK_API_KEY_FILE`, the one-line key format, and that the key file is
readable by the container's `node` user (UID 1000 in the official Node image).

**The holiday warning says "weekday rule only".**
The current year's holiday document is missing. The service will fetch it weekly; check outbound HTTPS
to `cdn.jsdelivr.net`, or let the cache warm while online. The weekday rule is still correct except on
holidays.

**The card is taller than the widget.**
Use `height: 400` if balances or a warning are present. Without a balance, 360 is the intended compact
height.

## License and attribution

MIT. Portions of the schedule, holiday, and balance logic are ported from
[DavidHLP/deepseek-offpeak](https://github.com/DavidHLP/deepseek-offpeak) (MIT, Copyright 2026 David).

## Deployment

| File | Use it when |
|---|---|
| `docker-compose.yml` | You want to build the image locally from this repo and run it standalone. |
| `docker-compose.ghcr.yml` | You want to run the image published by this repo's CI — no build step. |
| `DEPLOY-HOMELAB.md` | You are wiring it into an existing Glance dashboard through a reverse proxy or Tailscale (contains the measured `iframe` height, the Docktail publication labels, and the update/rollback/removal procedure). |

`.github/workflows/ci.yml` runs the self-check and the unit tests on every push and pull request;
`.github/workflows/publish.yml` builds and pushes `ghcr.io/bertodcruz/deepseek-offpeak-widget` on every `v*` tag using the
built-in `GITHUB_TOKEN` — no repository secret to create.

Configuration is entirely optional and never stored in the repo: copy `.env.example` to `.env` and
fill in what you need. No keys, no credentials.

See `NOTICE` for holiday data, font, logo, and Glance attribution.

Holiday data: [holiday-cn](https://github.com/NateScarlet/holiday-cn). Font: JetBrains Mono, SIL Open
Font License 1.1 (`public/fonts/OFL.txt`). DeepSeek and the DeepSeek logo are trademarks of their
owner.
