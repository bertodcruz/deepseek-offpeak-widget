# Running this widget in the homelab

How this card is wired into the Glance dashboard on the Proxmox host — the exact compose block, the
exact Glance block, and the traps that cost time the first time round. Reuse this file when the
widget is reinstalled or moved to another machine.

Host facts it assumes:

| Thing | Value |
|---|---|
| Docker host | Proxmox host, containers managed through Arcane |
| Stacks | `/root/homelab/<stack>` (Arcane sees them as `/projects/homelab/<stack>`) |
| Per-service data | `/mnt/ssd1/services/<name>` |
| Glance stack | `monitoring` at `/root/homelab/monitoring` |
| Glance config | `/mnt/ssd1/services/glance/config/startpage.yml` |
| Dashboard page | Homelab, right-hand `small` column, after Releases |

## 1. Get the code onto the host

Preferred: straight from GitHub, so updates are `git pull` instead of a re-upload.

```bash
git clone https://github.com/bertodcruz/deepseek-offpeak-widget.git /mnt/ssd1/services/deepseek-offpeak/src
cd /mnt/ssd1/services/deepseek-offpeak/src && git checkout v1.0.0   # pin a version
mkdir -p /mnt/ssd1/services/deepseek-offpeak/data
chown 1000:1000 /mnt/ssd1/services/deepseek-offpeak/data
```

The container runs as UID 1000 (`USER node` in the Dockerfile), so the data directory must be
writable by that UID or the holiday cache silently fails to save.

## 2. Add the service to the `monitoring` stack

Append to `/root/homelab/monitoring/compose.yaml` (or deploy the same thing via Arcane):

```yaml
  deepseek-offpeak:
    image: ghcr.io/bertodcruz/deepseek-offpeak-widget:1.0.0     # published by .github/workflows/publish.yml
    container_name: deepseek-offpeak
    restart: unless-stopped
    init: true
    environment:
      - DATA_DIR=/data
      - TIME_FORMAT=24h
      - DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}
    volumes:
      - /mnt/ssd1/services/deepseek-offpeak/data:/data
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    labels:
      - "docktail.service.enable=true"
      - "docktail.service.name=deepseek"
      - "docktail.service.port=8787"
      - "docktail.service.service-port=443"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

Notes that matter:

- **No `ports:` mapping.** Docktail publishes `https://deepseek.<tailnet>.ts.net` and proxies
  straight to the container IP, so nothing is exposed on the host's LAN interfaces.
- **The Docktail labels are the whole publication step.** Remove them and the URL disappears.
- **`${DEEPSEEK_API_KEY}` lives in `/root/homelab/.env`**, never in the compose file and never in
  the repository. Empty value = balance row hidden, everything else still works.
- **If you build the image locally** instead of pulling from ghcr, Arcane's `update-services`
  refuses it (`400 … failed to pull image …:local`) because it always pulls first. Either publish
  the image, or add `pull_policy: never` and start it outside the compose path.

## 3. Add the card to Glance

In `startpage.yml`, inside the right-hand column, after the Releases widget:

```yaml
        - type: iframe
          title: DeepSeek
          hide-header: true
          source: "https://deepseek.<tailnet>.ts.net/?theme=dark"
          height: 310
          css-class: deepseek-offpeak
```

Three details that are not obvious:

1. **`iframe`, not `extension`.** An `extension` widget is fetched server-side and rendered once per
   page load — a countdown would freeze until you reloaded the dashboard. The `iframe` is loaded by
   the browser, so the card keeps ticking.
2. **`?theme=dark` is required.** A cross-origin iframe cannot inherit Glance's CSS variables, so
   without the parameter it follows the operating system's light/dark setting instead of your theme.
3. **`height:` must be measured, not copied.** The widget's card is `min-height: 100vh` with its
   footer pushed down by `margin-top: auto`, so *every spare pixel becomes an empty band* between the
   last row and the footer. And at **≤ 305 px** the widget switches to a compact layout that hides the
   "off-peak ends / Beijing / day" row entirely.

   At the dashboard's real column width the numbers are:

   | Width | Content height | Usable `height:` | Result |
   |---|---|---|---|
   | 300 px | **272 px** | **310** | full layout, ~30 px slack (reads as padding) |
   | 300 px | 272 px | 360 | full layout, **88 px empty band** |
   | 300 px | ~240 px | 280 | compact mode, **stats row hidden** |

   Re-measure after any layout change: open the widget URL at the column width, set the card's
   `min-height` to `0` in devtools, read the height back.

## 4. Verify

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://deepseek-offpeak:8787/healthz   # from inside Glance's network
curl -s http://deepseek-offpeak:8787/api/status | head -c 300
```

Then load the dashboard: the card must tick without a reload, and
`http://glance:8080/api/pages/homelab/content/` must contain no `widget-error-header`.

If you change `startpage.yml` while another process may also be editing it, take an md5 of the live
file, re-read it immediately before writing, and abort the write if the md5 moved — Glance hot-reloads
in about a second, so a bad write is instantly visible.

## 5. Update

```bash
cd /mnt/ssd1/services/deepseek-offpeak/src
git pull && git checkout v1.0.1          # or whatever tag
```

Then either restart the service (`POST /api/environments/0/projects/<id>/update-services` with
`{"services":["deepseek-offpeak"]}` through Arcane — it recreates only that container, not the whole
stack) or pull the new ghcr image and repeat. Do **not** run a full project deploy: Glance, Uptime
Kuma, Glances, Beszel and Speedtest Tracker in this stack are managed outside Compose, and a full
`up` bounces all of them.

## 6. Remove

1. Delete the `iframe` block from `startpage.yml` (page first — never leave a card pointing at a dead
   container).
2. Remove the service block from `monitoring/compose.yaml`.
3. `DELETE /api/environments/0/containers/<id>?force=true` through Arcane.
4. `rm -rf /mnt/ssd1/services/deepseek-offpeak`.
5. Confirm Docktail logged `Service removed successfully (drained and cleared)` for `svc:deepseek`
   and that the page renders with no error cards.
