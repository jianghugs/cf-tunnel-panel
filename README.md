# ☁️ cf-tunnel-panel · publish your private services to the internet, safely

> 🌐 **Language / 语言**：**English (current)** · [简体中文](README.zh-CN.md)

> One sentence: a web panel that wires **cloudflared tunnels** + **Caddy reverse proxy** together,
> so a private service at home becomes `https://your-domain/some-path` — **no public IP, no router
> changes, no open ports**. Multiple tunnels can run at the same time (quick + named, or several
> accounts and domains).

- Version: **v0.24.0**
- Works with: NAS, self-hosted sites, Home Assistant, Jellyfin, Gitea, Immich, qBittorrent… any HTTP service
- Stack: `node:http` backend (zero dependencies), hand-written frontend (no build step), `Caddy` for routing,
  `cloudflared` for the tunnel — one `docker compose up` and you are done
- License: [MIT](LICENSE)

---

### Self-hosted monitoring stack (optional)

`tools/monitoring/` ships a two-container Prometheus + Grafana stack, pre-wired for this panel:

```bash
cd tools/monitoring && docker compose up -d     # Grafana on :3000, Prometheus on 127.0.0.1:9090
```

Prometheus already scrapes both blue/green slots, and Grafana auto-imports the dashboard from
`docs/grafana-dashboard.json` with anonymous viewer access and `allow_embedding` on — so the
overview page's embed fields can be filled in immediately (details in `tools/monitoring/README.md`).

### v0.29.18 highlights

- **The check history now answers "which old problem"**: under the self-check card on the monitor page there is a table of items that failed in the last 24 hours — how many times, when last, and what was said. Most frequent first. Before there was only a strip of the last 40 runs, which could not show "Grafana keeps timing out".
- **A false failure it exposed, fixed**: the `Grafana` check used the public hostname (through Cloudflare) with a 3 s timeout, so it flapped. It now probes the LAN address when one is configured, allows 6 s, and reports a timeout as "attention" rather than "failed" (noting it may just be slow).
- **Old config snapshots are gzipped**: the newest 10 stay plain (easy to read and diff), older ones become `.json.gz`; reading, listing and rolling back are unchanged. This instance went from 441 KB to 146 KB.
- **Snapshot name collisions fixed**: two snapshots written in the same millisecond used to overwrite each other (real in scripts); a sequence number is added now.

### v0.29.17 highlights

- **Tests no longer "sleep and hope"**: a dozen fixed `setTimeout` waits in the DOM regression suite became "poll until the condition holds" (`waitFor`) and "wait until a real 5 s poll happened" (`pollTick`, counting `/api/state` calls). Fixed waits assert before render finishes when the box is busy or the panel just restarted — that is exactly where the occasional 177/179 came from — and the suite is tens of seconds faster.
- **A real UI bug fell out of it**: arriving from "traffic by rule" highlighted the rule for a moment, but the 5 s poll re-rendered the list and the `data-focused` marker vanished — the highlight "flashed once and was gone". The focused rule is now remembered and re-applied on every re-render, cleared when the rule is deleted or the scope changes.

### v0.29.16 highlights

- **Exit network reconnects are finally visible**: when cloudflared's QUIC connection to Cloudflare's edge drops it reconnects by itself — the process never exits, so the old "重连 ×N" counter never moved, yet visitors felt "the site blipped". The panel now parses cloudflared's reconnect signals (one count per burst, 5 s dedupe), shows a "network reconnects ×N" badge on the exit card (amber at ≥3 in 10 minutes, with total and last time on hover), and the self-check grew an "exit link stability" item that suggests switching the protocol from `auto` to `http2` (TCP, friendlier to NAT) when the link flaps.
- Housekeeping: two leftover `.backup-audit-*.jsonl` files (2.2 MB) from the earlier audit cleanup moved from `data/audit/` to `data/backups/audit-cleanup/` — that filename pattern is not matched by the retention sweep, so they would have sat there forever.

### v0.29.15 highlights

- **Health checks no longer flood the log**: the slot config used to emit `health_checks` unconditionally, and the other colour is normally stopped — its failed probe every 2 s piled up to **100k+ lines/day in Caddy's log (99.85%)**, filling the file and forcing rotation sooner, which shrank the window the trend charts could cover. Health checks are now only emitted while the peer is actually listening, and an offline peer is dropped from the upstream list (otherwise every request pays a connect-refused round trip).
- Slot up/down is detected by a watchdog that **re-pushes the config once**, so rolling upgrades still run with two upstreams plus health checks — the switch window is unchanged.
- The self-check gained a 13th item, "access log": bytes of noise in the last 10 minutes and how far back access lines reach — previously invisible.

### v0.29.14 highlights

- **Trend charts no longer break at log rotation**: the aggregations only read the tail of the live `access.log`, so once Caddy rotated (every 10 MB) the older part of the window disappeared. Recent rotated files (`.gz`) are now read too (window-bounded, at most 3, 4 MB each), so hour buckets spanning a rotation are correct.
- **Only access lines are parsed**: 99% of the log is failed health-check retries against the stopped slot (100k+ lines/day). Instead of splitting the whole text, lines are located by `"logger":"http.log.access`, and results are memoized for 30 s (hourly charts do not need better) — ~190 ms cold, 0 ms warm.

### v0.29.13 highlights

- **Fixed the traffic chart showing 0**: the hourly buckets were built forward from “now minus N hours”, so the newest bucket landed in the *previous* hour and everything since the top of the current hour was dropped — the overview could read “0 requests” while rules clearly had traffic.
- The scrape-targets stat now says “1/2 up (1 standby slot)” instead of looking like a fault when the idle blue/green colour is down.

### v0.29.12 highlights

- **Fixed a self-inflicted outage**: the self-check history file had grown to **360 MB** (a runaway escaping loop), and every 5-minute run rewrote it synchronously — the panel froze for 20+ seconds and `/api/selfcheck*` looked hung. History is now append-only with a size cap, records are truncated, and reads only happen from the tail of the file.
- Self-check history strip on the monitor page: one bar per run (green = all pass, amber = warnings, red = failures), with a hover tooltip naming the failed checks.
- The idle blue/green slot is now labelled “standby slot” instead of a red DOWN in the scrape targets table.
- Chart accessibility: every SVG chart has a numeric `aria-label` plus `<title>`/`<desc>` instead of the generic “chart”.

### v0.29.11 highlights

- **Scheduled self-check**: the panel now runs all 12 health checks itself every 5 minutes (leader only) and notifies through your notification channels when the result flips from OK to failing — and when it recovers.
- **Results are kept**: `data/selfcheck/last.json` + `history.jsonl` (last 200 runs). The sidebar shows `· check 12/12` with the last run time and, if something failed, which item.
- **Monitor page shows the last run** without clicking anything: "last checked 3 minutes ago, 12/12 passed".
- **Fewer false alarms**: probes that go out through Cloudflare get a 6-second budget, and a timeout is reported as "slow" instead of "broken".

### v0.29.10 highlights

- **Health check**: one button on the monitor page runs 12 checks in parallel (version/image fingerprint, instance role, Caddy admin API, route-count parity, shadowed routes, each exit's process + public reachability, Prometheus readiness *and whether it actually scrapes the panel*, Grafana health, disk space, state file). Every row gives evidence and a "what to do".
- Monitor page no longer paints "1/2 targets up" red: with blue/green slots the idle slot is always down, so only non-slot targets turning red counts.
- `tools/clean-audit.cjs` strips development traffic (loopback + RFC 5737 ranges) from the audit log — dry-run by default, `--apply` backs each file up first.

### v0.29.0 highlights

- Grafana panels load lazily with a skeleton and an explicit failure state (reason + retry + open in new tab), instead of a blank card.
- Audit "changes" now counts only mutating requests; test traffic (`x-cfp-test: 1`) is never written to the audit log.
- CSP allows Cloudflare's injected analytics beacon again.
- Human-readable durations (`2 小时 5 分`, not `2 时 5 秒`), log panel collapsed by default with level dots, exit actions moved into a `⋯` menu.
- Mobile: fixed whole-page horizontal overflow (grid `minmax(0,1fr)` bug); theme/language/palette moved to the top of the sidebar.


## What's new in v0.28.4

Fixes a regression introduced in v0.28.3: the checkbox rendered as a full-width blue bar with its label squeezed into one character per line.

- **Root cause**: `.login-card input{width:100%}` has higher specificity than `.chk`, so the custom checkbox was stretched to 100% width; with `flex:none` it ate the whole row and pushed the `<span>` to a 1-character column.
- Width is now scoped to `.login-card input:not([type=checkbox]):not([type=radio])`, plus explicit `width/height/flex:0 0 18px` on checkboxes as a second guard.
- Title "登录面板" → "管理员登录" (the left pane already says Cloudflare panel), softer focus ring (`3px rgba(59,130,246,.15)`), and the GitHub footer is now a real link.
- Verified with headless Chromium screenshots; tests: DOM **151**, API **309**.

## What's new in v0.28.3

The login page, rebuilt around a seven-point review (the important one: **the checkbox label was being clipped**).

- **Overflow fixed for real**: the text container had no `min-width:0` / wrapping constraint, so long copy got cut by `.login-wrap{overflow:hidden}`. `.remember` is now a proper flex row (`min-width:0`, `overflow-wrap:anywhere`) and the long explanation moved to `.tips` under the button — the checkbox keeps only "Remember this device for 30 days".
- **Credentials grouped** into a `.cred` card (18px field gap, 24px before the submit button, spacing tokens `--sp-field` / `--sp-group`).
- **Custom checkbox** (18×18, 5px radius, brand fill + white tick, `:focus-visible` ring), **eye button** 38px desktop / 44px on touch, **subtitle** above the form so the right column isn't empty.
- **Accessibility**: explicit `<label for>`, `aria-describedby` + `role="alert"` on field errors, submit `:focus-visible` ring, and 401 errors rendered inline under the password field with a red border.
- Tests: DOM **148**, API **309**.

## What's new in v0.28.2

Sign-in page polish, mostly removing things that shouldn't be there.

- Dropped the "sign in with your panel account, default user is admin…" line — a hint that reads like a credential leak.
- No placeholder text anywhere: the username used to show `admin`, the password `••••••••`, the OTP field `123456`. All gone, so nothing looks pre-filled.
- Fixed the "remember this device" row: the wrapping `<label>` had picked up `.chk` (a 15×15 rule meant for the `<input>`), which collapsed the row and jammed it against the password field and the button. Now `label.inline` + `<input class="chk">`, with 14/16px breathing room.
- Tests: DOM **144**.

## What's new in v0.28.1

The sign-in screen is now a proper two-column page instead of a lonely card.

- **Left**: gradient brand panel with three selling points (multiple exits / path routing / observability) plus version and repo link; hidden below 860px so the form stays centered.
- **Right**: title, one-line hint, placeholders, and three small buttons — language (中/EN), light/dark, and password reveal (👁 with `aria-pressed`).
- The TOTP step now expands automatically, locks the filled credentials, relabels the button to "Next", and selects the code on error. All strings are in the dictionary, so English mode has no mixed language.
- Tests: DOM **142**.

## What's new in v0.28.0

Alerts finally close the loop: **Prometheus detects → Alertmanager routes → the panel turns it into your DingTalk / Feishu / Bark message** — and every alert row is clickable.

- **Clickable monitor page** — alert rows with `labels.id` link to `/tunnels?focus=<id>` (the exit card scrolls into view and flashes); panel scrape targets get a "panel" tag. `/api/monitor/status` now ships `labels` per alert.
- **Per-exit error-rate rule** `ExitErrorRateHigh`: `(cf_exit_errors_5m / cf_exit_requests_5m > 0.1) and cf_exit_requests_5m >= 20`, `for: 10m`, inhibited by `TunnelDown` for the same exit.
- **Alertmanager** in `tools/monitoring` (`prom/alertmanager:v0.28.0`, `127.0.0.1:9093`); Prometheus points at it, and it forwards everything to the panel.
- **Panel webhook** `POST /api/alerts/hook`: turns Alertmanager payloads into human text and pushes them through your notification channels (both firing and resolved). Token via `?token=` or `x-cfp-token`; generated on first use and visible to admins under *Settings → Monitoring*.
- New `GET /api/alerts/hook-token` (admin) and a `127.0.0.1:8080` Caddy route so same-host services always reach whichever slot is live.
- Tests: API **309**, DOM **139**.

Gotcha worth knowing: Alertmanager 0.28 rejects `http_config.headers` (`field headers not found in type config.plain`) — put the token in the URL query instead.

## What's new in v0.27.0

- **Per-exit traffic metrics** — `/metrics` now also emits `cf_exit_requests_5m{id,name,mode}` and `cf_exit_errors_5m{...}`: a 5-minute rolling count per tunnel exit, derived from the access log (reads at most 1 MB), so Grafana can show *which exit is actually serving traffic*.
- **Grafana panel #13** — "Requests per exit (5-min rolling)" with request and error lines grouped by `name`; both `docs/grafana-dashboard.json` and the provisioned copy in `tools/monitoring/dashboards/` are updated (Grafana reloads in ~10s).
- These are rolling **gauges**, not counters — plot them directly, do not wrap in `rate()`.

## What's new in v0.26.1

- **Fixed: the manual *Send test* button could trip the `NotifyFailing` alert.** With no channel configured, `notify()` silently returned, but the test endpoint still recorded the attempt as `fail`; a few clicks accumulated past the threshold and left an alert on the Monitor page. No channel / unknown channel is now recorded as `skipped`, and `cf_notify_total` ignores `event="test"` so manual testing never disturbs operational alerts.

## What's new in v0.26.0

- **Silence alerts in the panel** — every alert on `/monitor` now has *Silence 1h* (5–1440 min) and *Un-silence*. Silences live in `settings.alerts.mutes[]`; `/api/monitor/status` marks each alert with `muted` and returns the active `mutes`, so silenced rows are dimmed and tagged. This is panel-side only: Prometheus keeps evaluating and Alertmanager keeps notifying — use an Alertmanager silence to actually stop notifications.
- **`/monitor` is covered by the real-Caddy e2e** — the suite grew from 32 to 39 assertions (page opens, has the stats container, status shape, mutes array, mute → visible → unmute).

## What's new in v0.25.0

- **New "Monitor" page (`/monitor`)** — Prometheus readiness, scrape targets (up/down + last scrape + last error), firing/pending alerts, and three embedded Grafana panels, all refreshing every 30s. Backed by `GET /api/monitor/status`; the Prometheus URL lives in Settings → *Monitoring*.
- **`PanelDown` no longer fires forever** — it used `up{job="cf-tunnel-panel"} == 0`, and blue/green always has one slot stopped. Now `sum(up{job="cf-tunnel-panel"}) == 0`.
- Alert summaries print `1` instead of `1.0132312312312313` (`printf "%.0f"`), and the YAML quoting that silently prevented Prometheus from starting is fixed (validated with `promtool check rules`).

## What's new in v0.24.0

- **Multiple notification channels.** `settings.notify.channels[]` (up to 8), each with its own `name / format / url / secret / enabled`. Every notification is delivered to all enabled channels; the settings page shows a channel table where each row can be tested, disabled or removed on its own, and `POST /api/notify/test {channelId}` targets a single one. Legacy `notify.url/format/secret` is still read as a virtual "default" channel, so old configs keep working without migration.
- **Grafana over HTTPS.** `grafana.jianghugs.shop` now goes through Caddy (`→ 127.0.0.1:3000`) and the same tunnel, with `GF_SERVER_ROOT_URL` / `GF_SERVER_DOMAIN` set on the container. The overview iframes are no longer blocked as mixed content, and `/d/…` share links point at the public hostname.
- Caveat: Grafana runs **anonymous read-only** — anyone who can reach that hostname can view the panels (they cannot see configuration or change anything).

## What's new in v0.23.0

- **Block an IP straight from the security panel.** Every row in "Suspicious access (401/403)" now has a Block / Unblock button that writes to `security.ipDeny` and pushes Caddy immediately (`POST /api/security/deny|allow`). Loopback/private ranges get an extra warning ("this may lock you out"), CIDR is accepted (`/32`, `/128`, `/24`), capped at 200 entries.
- **Traffic per exit.** The tunnels page gains a table that attributes access-log hosts to individual exits — requests, 5xx, 4xx, p95 and bytes, over a 1/6/24/72 hour window (`GET /api/tunnels/stats?hours=`). Hostnames that belong to no exit are summarised underneath.

## What's new in v0.22.0

- **The UI now knows your role.** `/api/state` returns `role` and `canWrite`; the top bar shows a "read-only" / "operator" badge and write buttons are disabled up-front instead of failing with 403 after you click.
- **Backups are downloadable.** `GET /api/backups/download?file=` — attachment, filename whitelisted, path traversal rejected.
- **Access log CSV export.** The observability page gets an "Export CSV" link that follows the current filters (`/api/access.csv`, BOM + CRLF + Excel formula-injection guard).
- **Duplicate a rule in one click.** The new button on each rule card clones it right below itself (new id, "copy" suffix), ready to edit and save.
- **Grafana mixed-content warning.** When the panel is served over https and Grafana is http, the browser blocks the iframe — the card now says so and offers the two real ways out instead of showing blank frames.
- The language button shows 中文 in English mode, and the dictionary lookup now normalises whitespace, which drops leftover Chinese on `/settings` from 8.0% to 0%.

## What's new in v0.21.0

- **Grafana panels inside the overview page.** Point the panel at your Grafana (Settings → Grafana embed),
  give it a dashboard `uid/slug` and up to three `panelId`s, and the overview page shows them via
  `/d-solo/` — one chart per slot, no Grafana chrome. The page CSP only allows the origin you configured
  (`frame-src` falls back to `'self'` when the feature is off). Grafana needs `allow_embedding = true`
  and anonymous viewer access, otherwise the iframe just shows Grafana's own login page.

## What's new in v0.20.0

- **The audit log now rotates daily.** One `data/audit/audit-YYYY-MM-DD.jsonl` per day, trimmed to the last
  5000 lines if a single day exceeds 8 MB, kept for 30 days (`PANEL_AUDIT_DAYS`). Earlier versions kept one
  `audit.log` capped at ~3000 lines, so "who changed that rule last Wednesday" was unanswerable. The audit
  card on the Observe page gained a date picker; `GET /api/audit/days` lists available days and
  `/api/audit` / `/api/audit.csv` accept `?date=YYYY-MM-DD`.
- **Alert rules template** — `docs/prometheus-alerts.yml`: 10 rules (panel down, no leader, leader flapping,
  code drift, tunnel down, Caddy push failing, proxy 5xx ratio, panel 5xx, panel being scanned, notification
  failures), each with a "what to check" note.
- **Grafana dashboard rebuilt** around the cluster-aware metrics — 12 panels over leader/role state, panel
  request rate, proxy traffic, notifications, tunnel status and build info.

---

## Releases and prebuilt images

Every tagged version publishes a [GitHub Release](https://github.com/jianghugs/cf-tunnel-panel/releases)
and a multi-arch image (`linux/amd64`, `linux/arm64`) to `ghcr.io`:

```bash
docker pull ghcr.io/jianghugs/cf-tunnel-panel:0.29.4     # exact version
docker pull ghcr.io/jianghugs/cf-tunnel-panel:0.29       # latest 0.29.x
docker pull ghcr.io/jianghugs/cf-tunnel-panel:latest     # newest
```

Release notes come straight from the matching section of `CHANGELOG.md`.

Or run the bundled script, which bumps the version, writes the `CHANGELOG` entry, commits,
tags and pushes in one go (add `--build` to also rebuild the image and roll the two slots):

```bash
tools/release.sh 0.30.0 --notes-file /tmp/notes.md --build
tools/release.sh 0.30.0 --notes-file /tmp/notes.md --dry   # 只打印计划
```

**Cutting a release** (maintainers): bump `package.json`, add a `## vX.Y.Z` section to
`CHANGELOG.md`, commit, then `git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`.
The `release` workflow does the rest — no manual image push. Tags containing `-`
(e.g. `v0.30.0-rc.1`) are published as pre-releases.

## Table of contents

1. [What it actually does](#1-what-it-actually-does)
2. [The three containers](#2-the-three-containers)
3. [Quick start (5 minutes)](#3-quick-start-5-minutes)
4. [First run: 3 steps to a working site](#4-first-run-3-steps-to-a-working-site)
5. [Tunnels: quick, named, and many](#5-tunnels-quick-named-and-many)
6. [Rules in detail](#6-rules-in-detail)
7. [Toolbox](#7-toolbox)
8. [Observability](#8-observability)
9. [Security](#9-security)
10. [API](#10-api)
11. [Troubleshooting](#11-troubleshooting)
12. [Project layout & tests](#12-project-layout--tests)
13. [Roadmap](#13-roadmap)

---

## 1. What it actually does

```
                Internet
                   │  https://panel.example.com/jellyfin
                   ▼
        ┌──────────────────────┐
        │  Cloudflare edge     │  DNS + TLS + DDoS shield
        └──────────┬───────────┘
                   │  encrypted outbound tunnel (no inbound port!)
        ┌──────────▼───────────┐
        │  cloudflared         │  there is always exactly ONE upstream per tunnel
        └──────────┬───────────┘
                   │  http://127.0.0.1:8080
        ┌──────────▼───────────┐
        │  Caddy               │  ← this is where routing happens
        └──────────┬───────────┘
        ┌──────────┴───────────┐
        ▼                      ▼
  home-assistant:8123    jellyfin:8096      …rules decide
```

The important bit: **a tunnel carries traffic, it does not know what a "service" is.** Cloudflare lets you
point a hostname at exactly one upstream. So the panel points every tunnel at the local Caddy (`:8080`) and
lets **Caddy rules** decide which path or hostname goes where, with optional auth, IP allow-lists and headers.

## 2. The three containers

| Container | Image | Role | Port |
| --- | --- | --- | --- |
| `cf-tunnel-panel` | built from `Dockerfile` (node:22 + cloudflared binary) | the panel itself, spawns/ babysits cloudflared processes | `8090` |
| `cf-tunnel-caddy` | `caddy:2-alpine` | the data plane: routing, auth, headers, access log | `8080` (+ admin `127.0.0.1:2019`) |
| `cf-tunnel-demo` | `traefik/whoami` | a throwaway upstream so you can see it work immediately | `8091` |

All three use `network_mode: host`, because cloudflared and Caddy must reach services bound to `127.0.0.1`
on the host. Mounts: `./data` (state + backups + Caddy logs), `docker.sock:ro` (container list for one-click
rules), `./caddy.bootstrap.json` (initial Caddy config, replaced at runtime).

### 2.1 Pages

| Page | What's there |
| --- | --- |
| **Overview** | online exits / route count / traffic trend chart / exit online history / live log |
| **Tunnels** | one card per exit: status, public URL, uptime, reconnect count, start/stop/restart/QR/copy/delete |
| **Rules** | routing rules — filter, template, test upstream, reorder, export/import, simulate match |
| **Tools** | Docker containers (one-click rule), share links, self-test, Cloudflare API, speed test |
| **Observe** | access log with filters + live log (pause, errors only, download) |
| **Settings** | site / maintenance / security / notifications / panel login / read-only account / backups / about |


> **Interface language:** the panel ships Chinese + English. Click the `EN` / `中` button at the bottom-left to switch; the choice is a cookie (`cfp_lang`) and also drives `<html lang>`.

## 3. Quick start (5 minutes)

### 3.1 Requirements

- Docker + Docker Compose
- A domain on Cloudflare (only for named tunnels; quick tunnels work without one)

### 3.2 Start

```bash
git clone https://github.com/jianghugs/cf-tunnel-panel.git
cd cf-tunnel-panel
mkdir -p data/caddy-logs
docker compose up -d --build
```

### 3.3 Check three things

```bash
docker compose ps                            # three containers, all Up
curl -s localhost:8090/healthz               # {"ok":true,...}
docker exec cf-tunnel-caddy caddy version    # v2.11.x
```

### 3.4 Updating (read this before you `docker compose up` again)

`docker compose up -d` recreates the container **from the image**. If you edited files in `src/` without
rebuilding, that silently reverts to whatever the image was built with (we hit exactly this: the panel
"downgraded" itself back to v0.5.0). Two safe paths:

```bash
# A) proper: rebuild the image (needs a working registry for the base images)
docker compose build panel && docker compose up -d panel

# B) quick iteration: copy the files in, then restart
docker cp src/server.js cf-tunnel-panel:/app/src/server.js
docker cp src/web/.   cf-tunnel-panel:/app/src/web/
docker cp src/ui.html cf-tunnel-panel:/app/src/ui.html
docker cp package.json cf-tunnel-panel:/app/package.json
docker restart cf-tunnel-panel
```

### 3.5 Open the panel

Browse to `http://<lan-ip>:8090`, e.g. `http://192.168.1.55:8090`.

> Deploying to the public internet? Set a panel password first (Settings → panel login), or use a read-only
> account for whoever only needs to look.

## 4. First run: 3 steps to a working site

**① Start a tunnel.** Tunnels page → a quick tunnel is the fastest: press **Start**, wait ~5 seconds, you get
`https://something-random.trycloudflare.com`. (Quick tunnels have a random hostname per start and are
rate-limited by Cloudflare — fine for a test, not for daily use.)

**② Add a rule.** Rules page → **+ Add rule** → template `Whoami` → path `/demo`, upstream
`http://127.0.0.1:8091` → **Save**.

**③ Visit it.** Open `<your-tunnel-url>/demo` — you should see the `whoami` output, with an `X-Panel-Route`
header added by Caddy.

Any path that matches no rule returns a friendly 404 (a panel-authored page), which is a deliberate default:
probers learn nothing.

## 5. Tunnels: quick, named, and many

### 5.1 Quick tunnel (trycloudflare)

- No domain, no Cloudflare account. Hostname changes on every restart.
- Cloudflare rate-limits creation; the panel detects `429` and backs off exponentially (up to 15 minutes)
  instead of hammering every 5 seconds.

### 5.2 Named tunnel (recommended long-term)

1. Cloudflare Zero Trust → **Networks → Tunnels → Create a tunnel → Cloudflared**, give it a name.
2. Copy the **token** (the long `eyJ...` string — not the whole `cloudflared service install ...` command;
   the panel can extract it if you paste the whole command, but the token alone is cleaner).
3. In the panel: Tunnels → edit the exit → mode `named`, paste the token, set the public hostname
   (e.g. `panel.example.com`), save, start.
4. In Cloudflare, on that tunnel: **Routes → Add route → Published application** → subdomain `panel`,
   domain `example.com`, service type **HTTP**, URL `127.0.0.1:8080`.
   *(The service URL must be Caddy, not the panel: `8080`, not `8090`.)*

Notes that save hours:

- The hostname you type in the panel **must equal** the public hostname you created in Cloudflare.
- Public hostnames can only be created in the Cloudflare dashboard. Creating just a DNS CNAME gives
  error `1033` (tunnel not found).
- Several public hostnames can point at the same tunnel — they all land on Caddy, which splits by `Host`.
- An invalid token no longer causes an infinite restart loop: the panel marks the exit `fatal`, shows
  "Token invalid · retries stopped" and waits for you.

### 5.3 Many exits at once

Exits are independent cloudflared processes (up to 8). Useful combinations:

| Scenario | Setup |
| --- | --- |
| Temporary share + stable service | one `quick` exit + one `named` exit |
| Two Cloudflare accounts | one named exit per token |
| Same account, several tunnels | one named exit per tunnel (each needs its own token) |

Each exit has its own log prefix, metrics port and status; the Overview page shows all of them.

### 5.4 One exit, one rule set

Rules have an optional **exit** field:

- **Global** (`""`) — applies to every exit (this is what older rules are).
- **Bound to exit X** — only valid for that exit's hostname. Implemented by pinning the Caddy matcher to the
  exit's public hostname (for quick tunnels: the assigned `*.trycloudflare.com` host).
- If the exit has no hostname yet (not started, or named without hostname), the rule is **not pushed** and
  the panel shows it under "skipped" with the reason.

Restarting a quick tunnel changes its hostname; the panel re-pushes Caddy config automatically so bound rules
follow the new hostname.

## 6. Rules in detail

### 6.1 Common fields (on the card)

| Field | Meaning | Example |
| --- | --- | --- |
| **Path** | prefix match; `*` = wildcard | `/jellyfin`, `/api/*` |
| **Host** | optional; match a Hostname (comma separated) | `panel.example.com` |
| **Upstream** | the service; `http://` optional | `127.0.0.1:8096` |
| **Strip prefix** | remove the rule path before proxying | on for most apps |
| **Note** | free text, shows on the card | `media server` |

### 6.2 Advanced (expand `Advanced`)

| Field | Meaning |
| --- | --- |
| **Exit** | scope the rule to one exit (see §5.4) |
| **Method** | restrict to `GET/POST/...` |
| **IP allow-list** | CIDR list; anything else gets the 404 page (no hint that a service exists) |
| **Basic auth** | user + password, stored as bcrypt hash (export never contains the plaintext) |
| **Timeout** | upstream response timeout (media servers need 300s) |
| **Backup upstream** | failover target when the primary refuses connections |
| **Load balancing** | round-robin / random / least_conn / ip_hash / uri_hash / header / cookie |
| **Request headers** | added to the upstream request |
| **Response headers** | added to the response (e.g. `X-Robots-Tag: noindex`) |

### 6.3 How a request is routed

1. Rules are evaluated **in order**; the first match wins.
2. A `/` catch-all rule therefore blocks everything after it — the panel warns you and offers **move to end**.
3. No match → panel 404 page.
4. Every rule's match is prefixed by its exit hostname if the rule is exit-scoped.

A rule being shadowed by an earlier one is also detected: the panel lists "rule A is blocked by rule B" with a
jump button, because that is the single most confusing failure mode.

### 6.4 Templates (30, five groups)

Generic web (whoami / static site / Node / Python / API), ops & dev (DSH, Baota, Portainer, Grafana, Uptime Kuma,
Gitea, code-server), media & home (Jellyfin, Plex, qBittorrent, Transmission, Synology DSM, Home Assistant,
Immich, Navidrome, Nextcloud), database UIs (Adminer, phpMyAdmin, pgAdmin, mongo-express, RedisInsight,
InfluxDB, MinIO), web terminals (ttyd, Wetty, Shellinabox).

Picking a "sensitive" template (database UI, terminal) auto-expands the advanced section and warns you to add
basic auth or an IP allow-list first.

### 6.5 What you cannot tunnel

A tunnel upstream is an **HTTP** server. Pointing a rule at MySQL (`3306`) or SSH (`22`) returns `502` — Caddy
speaks HTTP, MySQL answers with a binary handshake. Options:

1. **Web wrapper**: Adminer/phpMyAdmin for databases, ttyd/Wetty/code-server for shells.
2. **Cloudflare-side service type**: add `ssh://localhost:22` as a public hostname in the dashboard and use
   `cloudflared access ssh` on the client.
3. **Tailscale/WARP** for raw TCP.

## 7. Toolbox

- **Docker containers** — lists what is running (via `docker.sock`), guesses the right port, one click creates
  a rule pointing at the container.
- **Share links** — `https://panel.example.com/s/<random>` for a temporary upstream, expiring in N minutes.
  No panel login needed, and the route is injected ahead of every catch-all.
- **Self-test** — performs a real request through the local Caddy with a chosen path/Host and shows status,
  timing, headers and a body preview. This answers "is it Caddy or is it my app?".
- **Speed test** — measures TTFB and throughput through the tunnel, and reports which Cloudflare colo
  (`cf-ray` suffix) served the request.
- **Cloudflare API** (optional) — verify a token, list tunnels with live connections, fetch a tunnel token,
  list/create/delete DNS records. It cannot create public hostnames (Cloudflare doesn't expose that API),
  and the panel says so instead of pretending.
- **Generated Caddy config** — the exact JSON that gets pushed, for when a rule "doesn't work".

## 8. Observability

| Feature | Where | Notes |
| --- | --- | --- |
| Traffic trend | Overview | hourly aggregation from `access.log`, 6/12/24 h, errors overlaid |
| Exit online history | Overview | sampled every minute (240 points = 4 h) |
| Access stats | Observe | status/path/time filters, 5 rows per page |
| Live log | Observe | keyword filter, errors only, pause, download |
| Notifications history | Settings | last 50 sends, including ones skipped by cooldown/quiet hours |
| `/metrics` | Prometheus | `cf_tunnel_up{id,name}`, `cf_tunnel_running`, `cf_caddy_ok`, `cf_tunnel_requests_total{status}` |
| `/badge.svg` | README badge | live "tunnels up" count, no auth required |
| System info | Settings | version, Node, uptime, state size, backup count, log size, memory |

Notifications support `generic` (JSON POST), DingTalk, Feishu and Bark, with per-event switches, a cooldown
(default 300 s) and quiet hours (`23:00-07:00`, comma separated).

A ready-made Grafana dashboard lives in [`docs/grafana-dashboard.json`](docs/grafana-dashboard.json);
scrape config and alerts are documented in [`docs/PROMETHEUS-GRAFANA.md`](docs/PROMETHEUS-GRAFANA.md).

### 8.4 Audit log

Every state-changing request (`POST`/`PUT`/`DELETE`) and every failed `/api` call is recorded with
**who** (panel user, read-only user, or “not logged in”), **from which IP** (real client IP behind the tunnel),
**what** (human-readable action such as “修改代理规则”), the status code and duration.

- Stored in memory (last 500) **and** appended to `data/audit.log` (JSON Lines, rotated at 2 MB / 3000 lines).
- `GET /api/audit?limit=200&q=keyword` — search by person, IP, action or path.
- Plain `GET` reads are **not** recorded, so browsing the panel never floods the log.

### 8.5 Change trend (audit in the overview)
The overview page draws a second bar chart: how many **write actions** hit the panel each hour
(rule edits, exit start/stop, settings changes…), with failures stacked in red.
It reads `GET /api/audit/trend?hours=6|12|24`, which is built from the same audit log as §8.4 —
so it answers "when was the panel last touched, and did it succeed", which a backup list cannot.

## 9. Security

### 9.0 Sign-in and sessions
Two ways in, and they coexist:

| Method | Who it is for | How |
| --- | --- | --- |
| **Session cookie** | browsers | open `/login`, sign in once → `cfp_sid` cookie, 7 days, 12 h idle timeout |
| **HTTP Basic** | `curl`, scripts, Prometheus | `curl -u user:pass http://host:8090/...` |

Why sessions exist: Basic auth re-sends the password on every request, lives in the browser's
credential store forever, and **cannot be revoked** — with only Basic, the only way to lock
someone out is changing the password, which kicks you out too. With sessions you get a table
(Settings → Sessions) showing every device: account, role, source IP, user agent, signed-in
time, last activity — and a per-row **Kick** button plus *Sign out other devices*.

Details worth knowing:

- Sessions live in memory: restarting the panel signs everyone out (nothing to leak on disk).
- Cookie is `HttpOnly; SameSite=Lax`, plus `Secure` when the request came over HTTPS.
- Every state-changing request made with a session cookie is checked for same-origin
  (`Sec-Fetch-Site` / `Origin`). Cross-site writes are rejected with 403 and audited.
- Failed logins feed the same brute-force counter as Basic (8 tries / 10 min → 10 min lock).
- Read-only accounts also get sessions; their writes are refused with 403.


- **Panel login**: HTTP Basic. 8 wrong attempts from one IP → 10 minute lock (correct credentials still work).
- **Read-only account**: sees everything, writes nothing (403), for showing status to other people.
- **Security headers** on every panel page: CSP, `nosniff`, `no-referrer`, `SAMEORIGIN`.
- **Rate limit** on `/api/*`: 1200 requests/minute per client.
- **Real client IP behind the tunnel**: Caddy is configured with `trusted_proxies` (Cloudflare's 22 ranges) and
  `client_ip_headers: [CF-Connecting-IP]`. Without this, every request appears to come from a Cloudflare edge
  IP and your IP allow-lists silently stop working.
- **Secrets stay out of exports**: `/api/export` strips tunnel tokens, the Cloudflare token and webhook URLs
  unless you pass `?full=1`. Importing a stripped file keeps the current values instead of wiping them.
- **Route-level rate limiting** (`rate_limit`) needs a Caddy built with that module — see
  [`docs/RATELIMIT.md`](docs/RATELIMIT.md). Simpler alternative: Cloudflare Rate Limiting Rules.

### 9.1 Passwords are stored as bcrypt hashes

`panel.pass` and `viewer.pass` in `state.json` are bcrypt hashes (`$2b$10$…`), never plaintext — so backups,
exports and `cat data/state.json` no longer leak your password. Existing plaintext passwords are migrated
automatically on startup (`saveState('migrate-secrets')`), which is why you may see one extra backup file
right after upgrading.

Because every Basic-auth request would otherwise cost one bcrypt round (~170 ms on a small ARM box), successful
Basic credentials are cached in memory for 10 minutes; changing the password clears that cache immediately.
Browser sessions are unaffected — they use the session cookie, not Basic.

### 9.2 Is the container running the image's code?

`state.json` says v0.11.2 but the page looks old? Ask `/healthz`:

```bash
curl -s localhost:8090/healthz | jq '{version, code, imageCode, drift}'
```

- `code` — fingerprint (SHA1/16) of `src/` **as it is on disk right now**
- `imageCode` — fingerprint baked into the image at build time (`RUN node tools/codehash.js > .code-hash`)
- `drift: true` — the two differ, i.e. the container is running hot-copied code (`docker cp`) rather than the
  image's code. Perfectly normal while developing, dangerous in production: a plain `docker compose up -d`
  will silently roll you back to the image's version.

## 10. API

Everything the panel does is a plain JSON endpoint, so you can script it.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | `{ok, tunnels:{total,running}, version}` |
| GET | `/api/state` | full state + runtime (secrets redacted) |
| GET/POST | `/api/tunnels`, `/api/tunnels/<id>`, `/api/tunnels/<id>/{start,stop,restart,delete}` | exits |
| POST | `/api/tunnels/{start-all,stop-all}` | all exits |
| GET/POST | `/api/routes` | routing rules (whole list at once) |
| GET/POST | `/api/settings` | site / maintenance / security / notify / Cloudflare |
| POST | `/api/panel-auth`, `/api/viewer` | panel login, read-only account |
| POST | `/api/rules/test`, `/api/match` | probe an upstream, simulate a match |
| GET | `/api/access`, `/api/traffic`, `/api/history` | access log, hourly buckets, exit sampling |
| GET | `/api/notify/history`, `/api/system`, `/api/logs{,/stream,/download}` | diagnostics |
| GET/POST | `/api/shares`, `/api/shares/<id>/delete` | one-time share links |
| POST | `/api/curl`, `/api/ws-test`, `/api/bench/local` | self-tests through local Caddy |
| GET/POST | `/api/cf/{verify,tunnels,dns}` | Cloudflare integration |
| GET/POST | `/api/export[?full=1]`, `/api/import`, `/api/backups{,/restore,/diff}` | backup & migration |
| GET | `/api/caddy/config`, `/metrics`, `/badge.svg` | generated config, Prometheus, badge |

Configuration is stored in `data/state.json` (mode `0600`, 20 rolling backups in `data/backups/`).

Each format has a completely different URL shape. A wrong URL does not error out at send time — it is **silently dropped**, so the panel validates on save:

| Format | What the URL looks like | Secret (signing) |
| --- | --- | --- |
| Generic JSON | any `http(s)://` endpoint receiving `{title,text,event,ts,host}` | not needed |
| DingTalk bot | `https://oapi.dingtalk.com/robot/send?access_token=…` | only when "signing" is enabled (`SEC…`), appended as `timestamp`/`sign` in the query |
| Feishu bot | `https://open.feishu.cn/open-apis/bot/v2/hook/…` | only with "signature verification", sent as `timestamp`/`sign` in the body |
| Bark (iOS) | `https://api.day.app/your-key` (self-hosted: your own domain) | not needed; panel appends `/title/body` |

A DingTalk bot that only uses a keyword needs no secret — just make sure the keyword appears in the message. Panel titles contain "掉线" / "失败" / "换了 IP" (down / failed / IP changed), so pick one of those.

### 10.3 Login sessions (more controllable than Basic)

| Method | Use case | Revocable |
| --- | --- | --- |
| Browser session (cookie `cfp_sid`) | everyday use | ✅ kick one by one |
| HTTP Basic | curl / scripts / Prometheus | ❌ verified per request |

- Sessions last 7 days idle-free, die after 12h of inactivity, and live **in memory only** — restarting the container logs everyone out.
- **Settings → Login sessions** lists device, source IP, login time and last activity; you can kick individually or "sign out everywhere".
- A session that **changes source IP** (a copied cookie) is flagged `IP changed` in the table, written to the audit log and pushed as a notification (toggle it under "Notifications").
- **Changing the panel password or viewer account revokes every session** and redirects to the login page.
- Write requests authenticated by session require a same-origin `Sec-Fetch-Site` / `Origin`, otherwise 403 (CSRF guard).

### 10.4 English / Chinese UI

Toggle with 🌐 in the top bar; the choice is stored in the `cfp_lang` cookie. The server renders nav and `<html lang>`, the client replaces **229** strings by exact "Chinese → English" lookup. Unknown strings stay Chinese on purpose — no machine translation, so you never get half-translated text.

### 10.5 Audit log

Bottom of the Observe page: who changed what, when, from which IP. Only state-changing requests and failed requests are recorded; high-frequency read-only endpoints (`/metrics`, `/badge.svg`, assets, log stream) are skipped so the log stays useful. Written to `data/audit.log` (JSON Lines, trimmed to the last 3000 lines past 2MB); API: `GET /api/audit?limit=&q=`.

## 11. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Tunnel URL opens, then `502` | upstream isn't listening, or you pointed at a non-HTTP port |
| Cloudflare shows `1033` | public hostname not created; a CNAME alone is not enough |
| `530` | cloudflared is not connected (invalid token, or the tunnel is paused) |
| Everything after a path returns 404 | a `/` catch-all rule sits above it — reorder |
| New exit serves the panel's 404 | no rule matches `/`; that is the default (add a rule or a `/` catch-all) |
| IP allow-list has no effect | real client IP missing — see §9 (`trusted_proxies`) |
| Quick tunnel keeps failing | Cloudflare `429`: too many quick tunnels, wait or switch to a named tunnel |
| Rules/edit boxes reset while typing | fixed in v0.7.6+; make sure you are not on an older build |
| `compose build` fails with registry 401 | your registry mirror is broken; `docker compose up -d --no-build` then `docker cp`, or fix the mirror |

Every action that changes state writes a backup first, and Settings → backups lets you diff a backup against
the current configuration and restore it in one click.

## 12. Project layout & tests

```
cf-tunnel-panel/
├── docker-compose.yml       # three containers, host network
├── Dockerfile               # node:22 + cloudflared binary
├── caddy.bootstrap.json     # initial Caddy config
├── src/server.js            # HTTP router + wiring only (~800 lines)
├── src/core/                # backend split by responsibility (see below)
├── src/web/                 # multi-page frontend (no build step)
│   ├── assets/app.css       # design system: dark/light, responsive
│   ├── assets/*.js          # one script per page
│   └── pages/*.html         # page fragments, wrapped by the backend shell
├── test/                    # end-to-end tests (API + jsdom)
├── tools/                   # bench.sh, fix-perms.sh, git-snapshot.sh
├── data/                    # state.json + backups/ + caddy-logs/ (gitignored)
└── docs/                    # ROADMAP, Prometheus/Grafana, rate limiting
```

Backend modules (`src/core/`, split out of the 2500-line `server.js` in v0.9.0):

| Module | Responsibility |
| --- | --- |
| `paths.js` | paths, constants, Cloudflare IP ranges |
| `util.js` | log ring buffer, JSON helpers, parsers, rate limit, security headers |
| `state.js` | state shape, migration, validation, persistence + rolling backups |
| `registry.js` | tunnel runtime registry (Map + read-only accessors) |
| `auth.js` | panel auth (Basic, read-only account, brute-force lockout) |
| `caddy.js` | turns rules into a Caddy JSON config (routing, maintenance page) |
| `pusher.js` | pushes that config to Caddy (debounced, records failures) |
| `tunnels.js` | cloudflared process pool (start/stop, 429 backoff, fatal errors) |
| `insight.js` | access stats, hourly buckets, match simulation, shadow analysis, upstream health, metrics |
| `bench.js` / `probe.js` | speed test endpoints / upstream + WebSocket probing |
| `integrations.js` | Docker API, Cloudflare API |
| `notify.js` | webhook pushes, cooldown, quiet hours, history |
| `web.js` | page shell + static assets (ETag/gzip) |
| `monitor.js` | background patrol (status sampling, expired shares) |
| `audit.js` | audit log (who changed what, from where) |

Tests (143 assertions total):

```bash
export PANEL_PASS='your-panel-password'   # tests attach credentials automatically
npm i -D jsdom
npm test                                  # = npm run test:api && npm run test:dom
```

- `test/api.test.mjs` — 86 endpoint assertions: exits, rules, upstream probing, match simulation, share links,
  maintenance mode, blacklist, backoff, WebSocket test, backup restore/diff, export/import, Cloudflare API,
  brute-force lockout, read-only account, traffic/history/notify/system, audit log. It inserts a temporary `/qa` probe
  rule and removes it afterwards; it never changes your password.
- `test/dom.test.cjs` — 57 page assertions in jsdom: six pages load without script errors, theme toggle,
  polling does not clobber typing, rule search, inline import, scope memory, observe filters, log pause,
  charts, Ctrl+K palette, read-only form, system info.

## 13. Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) (Chinese) for the version-by-version plan, design decisions and known
limits — including why the panel is built this way: Caddy in front (not cloud-side ingress rules), host
networking, zero-dependency Node, hand-written SVG charts.


## 14. What's new in v0.12.0

Twelve items that turn a "config web page" into a small operations console. Every one of them is wired into the automated tests (116 API + 75 DOM assertions).

| Area | What changed | Why it matters |
| --- | --- | --- |
| **Login sessions** | Cookie sessions (`cfp_sid`, HttpOnly, SameSite=Lax) with `remember me` (30 days) and a 12-hour idle timeout. Sessions are **persisted to `data/sessions.json`** — a container restart no longer logs you out. Only SHA-256 hashes of the cookie values are stored. | Basic auth is fine for curl, terrible for a browser: no logout, no device list, no way to revoke. |
| **Kick devices** | Settings → *Login sessions* lists every session (IP, UA, last seen, whether it changed IP) with **kick** and **kick all**. Changing the panel password kicks everything and forces a re-login. | If a cookie leaks, you can kill it from your phone in five seconds. |
| **Unsaved-changes guard** | Any edit on Tunnels / Rules / Settings marks the page dirty, shows a `未保存` badge in the top bar, blocks in-page navigation with a confirm, and hooks `beforeunload`. | The 5-second polling used to eat your typing. That is fixed, and now you also cannot lose it by clicking a nav link. |
| **Single-instance lock** | `data/.state.lock` with pid + `/proc/<pid>/cmdline` verification. A second instance exits with a clear message. | Two panels writing `state.json` overwrite each other; worse, one can push its own Caddy config over the live one (this really happened in CI). |
| **Caddy admin hardening** | The admin API moved off the well-known `:2019` to **`127.0.0.1:20190`**, and the generated config now derives its listen address from `CADDY_ADMIN` instead of hard-coding it. The pusher falls back across addresses so an upgrade cannot leave you stranded. | `:2019` is the default every Caddy tutorial and tool assumes; a non-default loopback port is one less free win for anything else running on the box. |
| **Hostname manager** | Tools → *Public hostnames*: list, add, and delete a tunnel's ingress rules, with the matching CNAME created (or deleted) automatically. `addDns:false` skips DNS. | Adding a public hostname used to mean a trip to the Cloudflare dashboard. Now it is one form, and it is written through the same API the dashboard uses. |
| **Per-route stats** | Observe → *Route hit stats*: for each rule, how many requests, error rate, P50/P95/max latency, bytes — computed by attributing real access-log lines through the same matcher the engine uses. Requests that matched nothing are reported separately. | "Which rule is slow / broken" used to be a `grep`. |
| **More alerts** | Two new notify events: **5xx spike** (>10% of requests in 5 min, min 20 samples) and **repeated login failures** (≥5 in 10 min, with source IPs). Both honour the existing cooldown and quiet hours. | The panel already told you when a tunnel died. Now it tells you when it is up but failing. |
| **YAML export** | `GET /api/export.yaml` — a secret-free, single-file snapshot for git (`settings` / `tunnels` / `routes`). | JSON exports are diff-hostile. This one is meant to be committed. |
| **PWA** | Manifest + icon + service worker. Install it from the browser; the shell works offline, **only `/assets/*` is cached** (pages and `/api` never are). | On a phone the panel is now an app on the home screen instead of a bookmark. |
| **GHCR images** | `.github/workflows/release.yml` builds multi-arch images (`amd64` + `arm64`) on a `v*` tag and pushes to `ghcr.io/<owner>/cf-tunnel-panel`. | No more "build it yourself to get a fix". |
| **Legacy page removed** | The 96 KB single-file UI at `/legacy` is gone. | Two UIs drifted apart; keeping the old one cost more than it helped. |

Two things were deliberately **not** done in this release, and they are still open in the roadmap: TOTP second factor, and per-role permission sets beyond admin/read-only.


## 15. What's new in v0.13.0

Two features that were deliberately left out of 0.12, plus the test that was missing.

### 15.1 Two-factor login (TOTP)

Settings → *Two-factor (TOTP)* → **Generate QR** → scan with Google Authenticator / 1Password / Authy → type the 6 digits → **Confirm**.

- The login page becomes two steps: password, then a 6-digit code. The code field is only revealed after the password is accepted, so nobody learns whether the password was right without one.
- **10 recovery codes** are shown exactly once. Each one logs you in and is then deleted. Lose the phone *and* the codes and you are editing `data/state.json` on the host.
- Clock drift: ±1 step (±30 s) is accepted, so a slightly fast phone still works.
- The secret never leaves the server except in the QR/secret you just generated: `/api/state` exposes only `{enabled, recoveryLeft}`.
- **Basic auth still bypasses TOTP** — deliberately. It is the machine credential (curl, Prometheus, scripts). If you need TOTP everywhere, do not use Basic; issue a session by logging in through the browser.
- Turning it off requires a current code or a recovery code, so a stolen cookie cannot quietly disable your second factor.

### 15.2 Roles: admin / operator / viewer

Settings → *Operator account*. Three roles, whitlist-based:

| | admin | operator | viewer |
| --- | --- | --- | --- |
| See all pages and state | ✅ | ✅ | ✅ |
| Change tunnels / rules / shares / maintenance | ✅ | ✅ | — |
| Add or remove public hostnames | ✅ | ✅ | — |
| Notify, Cloudflare credentials, panel password | ✅ | — | — |
| Import / roll back a whole config | ✅ | — | — |
| Kick other sessions, TOTP settings | ✅ | — | — |

`operator` is a **whitelist of write endpoints** (`src/core/perm.js`): anything new is closed to it by default, and the 403 says *why* ("panel password is admin-only") instead of a bare "forbidden".

### 15.3 CI now runs a real Caddy

`test/e2e-caddy.mjs` plus an `e2e` job in CI: it starts `caddy:2.11.9-alpine` with admin on `:20190`, boots the panel against it, pushes a probe route, fetches through Caddy, and asserts the proxied response **and** that an unmatched path still returns 404. This is the only test that can catch a wrong key in the generated Caddy JSON (`load_balancing.selection` vs `selection_policy` cost us an afternoon once).

The script snapshots the route table to `/tmp` before touching it and restores from the snapshot in a `finally` path — a previous version restored from live state and therefore deleted every rule when a run died in the middle.

## 16. Rolling upgrade (two instances, zero downtime)

Restarting the panel used to mean a few seconds of 502 while Caddy had no upstream. Now you can
keep two instances alive and switch over without dropping a request.

**How it works**

- An instance holds a **lease** file in `data/` (heartbeat every 5s, TTL 15s). The holder is the
  *leader* and is the only one allowed to write `state.json`, push Caddy config or run `cloudflared`.
- Every other instance starts as a **standby**: pages and read APIs work, any mutation returns
  `409 {"code":"STANDBY"}` and tells you which instance is the leader.
- When the leader exits it deletes the lease, so a standby promotes itself within ~5s.
- The panel route is pushed to Caddy as **two upstreams** (`:8090` and the reserved slot `:8095`)
  with `selection_policy: round_robin`, `try_duration 3s` and an **active health check** on
  `/healthz` (2s interval, 1s timeout, 2 fails). When one instance dies Caddy keeps retrying the
  other within the same request, then drops the dead slot from rotation.
- A standby also keeps a **warm cloudflared connector** for every *named* tunnel, so the tunnel
  never loses its last connector during handover. (Quick tunnels are skipped on purpose: their
  hostname is assigned per process, so two connectors would fight.)
- Measured on the live deployment (probing `https://…/healthz` every 250ms across a switch):
  before the warm connector **7 × 530 ≈ 6s** of errors; after it **1 × 530 ≈ 0.25s**.

**Enable it once**

```yaml
# docker-compose.yml
environment:
  PANEL_SLOT_PEERS: "8095"   # reserve the second slot permanently
```

Rebuild/recreate the panel container once so the env takes effect. The reserved port must stay free
(it is only used while an upgrade is in flight).

**Upgrade**

```bash
tools/rolling-upgrade.sh                  # dry run: preflight + plan, touches nothing
tools/rolling-upgrade.sh --apply          # do it
tools/rolling-upgrade.sh --apply --prune  # ...and delete the old container afterwards

# brand-new host (nothing running yet) — creates the blue slot
tools/rolling-upgrade.sh --bootstrap --apply
```

Container names are a **fixed pair**, so nothing competes with compose over a name:

| slot | container | port |
| --- | --- | --- |
| blue | `cf-tunnel-panel-blue` | 8090 |
| green | `cf-tunnel-panel-green` | 8095 |

Each run figures out which colour is live and starts the *other* one — it never renames anything,
so running it any number of times leaves both names stable and `docker compose` out of the way.
(The panel service in `docker-compose.yml` sits behind `profiles: ["bootstrap"]`, so a plain
`docker compose up -d` only manages Caddy and the demo service.)

The script walks through: start the other colour → wait for `standby` → stop the live one → wait
for `leader` → verify → optional `--prune` of the stopped colour. If promotion fails it restarts
the old container and exits non-zero.

**Gotchas**

- `docker inspect` the leader: without `PANEL_SLOT_PEERS` it only knows its own port, Caddy gets a
  single upstream and the script falls back to stop-then-start (1–3s of 5xx).
- Never point a test instance at the production `CADDY_ADMIN`. A second instance with an empty
  `data/` will happily push its default (one-route) config over yours. That is why the panel now
  refuses to push when `state.json` did not exist at boot unless `PANEL_ALLOW_FRESH_PUSH=1`;
  and why `CADDY_ADMIN` no longer falls back to other ports (`PANEL_ADMIN_FALLBACK=1` restores the
  old probing behaviour if you really need it).
- The lease is timestamp based on purpose: containers share a PID namespace, so `kill(pid, 0)`
  would always succeed and pid checks are useless.

## License

[MIT](LICENSE) — use it, change it, ship it commercially; keep the copyright notice.

> It exposes your services to the internet. Read [§9 Security](#9-security) before publishing anything
> that has a login behind it.

### v0.13.1 highlights

| Change | Detail |
| --- | --- |
| Recovery-code rotation | `POST /api/totp/recovery` takes a current TOTP code **or** one old recovery code and returns 10 fresh ones; the old set is voided. Settings → 2FA has the new "重新生成恢复码" button. Only hashes are stored. |
| E2E coverage 8 → 23 | The real-Caddy suite now proves prefix stripping, prefix passthrough, basic auth (401/401/200), Host-based routing isolation, WebSocket 101 upgrade, maintenance 503 + `Retry-After`, IP blacklist 403, admin off 2019, access-log writer and `trusted_proxies` — and restores routes/settings in `finally`. |
| Audit de-duplication | A request whose handler already logged a human-readable action no longer also emits the generic `POST /api/...` row. |

### v0.15.2 highlights — reorder by dragging

Route order **is** priority in Caddy (first match wins), so ordering had to stop being invisible. Every rule card now has a grip (`⠿`) you can drag:

- drag a card onto another to move it **before** or **after** (the drop line tells you which)
- only rules in the current scope move; other scopes are untouched
- dragging from inside an input is treated as text selection, not reordering
- `↑` / `↓` buttons stay for keyboard/mobile use, and the unsaved-changes bar turns on immediately

Also in this release: the config-snapshot cron is installed and verified — `*/15` on the host runs `tools/git-snapshot.sh`, which commits `data/config/*.json` (declarative, token-free) and skips silently when nothing changed.

### v0.15.1 highlights — guardrails before saving

| Guard | What it catches | Escape hatch |
| --- | --- | --- |
| Shadowed route | A catch-all (`path: /`) or a broader prefix sitting **in front of** rules that can never then receive traffic. Mirrors what Caddy's first-match ordering does. | `force: true` |
| Panel cut-off | A route set where **no rule points at the panel's own port** — save it and you can never open the panel again. | `force: true` |
| Bad upstream | Upstreams must be `host:port` or `http://host:port`; a bare name like `not-a-url` is rejected at validation time instead of failing at runtime. | fix the value |

Both `POST /api/routes` and `POST /api/config/apply` return **409 `{code:"GUARD", issues:[…]}`**, and the UI turns that into a confirm dialog that lists exactly which rule will go dark — then retries with `force`. Dry-run applies return the same list as `warnings` so you can see it before touching anything.

Also in this release: `tools/git-snapshot.sh` now commits the **declarative snapshots** (`data/config/*.json`, no tokens, no password hashes) instead of only `state.json`, keeps the last 120 in the repo, and is idempotent (second run prints "no changes, skipping").

### v0.15.0 highlights — config as code

| Change | Detail |
| --- | --- |
| Declarative view | `GET /api/config` projects the live state into one reviewable JSON: settings (public fields), tunnels (with `hasToken`), routes (without bcrypt hashes) and active shares. Nothing secret leaks — asserted by a test. |
| Apply a declaration | `POST /api/config/apply` takes that JSON back. `routes` are replaced wholesale, `tunnels` are merged **by id** so an exported file (which never contains tokens) cannot wipe your tunnel tokens. A `before-apply` snapshot is written first. |
| Dry run + diff | `{dry:true}` validates and returns `{added, removed, changed}` per route/tunnel plus `touchesTunnels`, so you can see the blast radius before committing. |
| Drift detection | Every apply records `last-applied.json`; `GET /api/config/drift` diffs it against the running state — that is how you notice somebody edited the panel by hand. |
| Snapshots | `data/config/<ts>-<label>.json`, 80 kept. `POST /api/config/snapshot` for manual ones, `GET /api/config/snapshot?file=` to read one back (path traversal rejected). |
| UI | Settings → **Configuration as code**: load current, edit, preview diff, apply, save snapshot, view drift; snapshot table fills the editor with one click. |

### v0.14.3 highlights

| Change | Detail |
| --- | --- |
| One-click exit (cloud + local) | `POST /api/cf/tunnels/quick` does the four steps that used to be four tabs: create the tunnel, fetch its token, **write the ingress config (the public hostname — a CNAME alone gives you error 1033)**, create the CNAME, and optionally register a local exit and start `cloudflared`. It then polls the public URL for up to 15 s and reports what it saw. |
| Dry run | Tick "dry run" and the endpoint returns the exact API calls it *would* make, without touching Cloudflare — good for checking permissions before committing. |
| Step-by-step report | The Toolbox shows a table of steps with pass/fail and the raw detail per step, so a failure tells you which of the five steps and why. |
| Tests | API 200, DOM 106 (dry-run plan renders, validation of hostname/service). |

### v0.14.2 highlights

| Change | Detail |
| --- | --- |
| Full English coverage | The dictionary now holds ~500 entries harvested from the rendered pages. Residual Chinese in English mode dropped from 7–32 % to **0–3 %** per page; what is left is *your own data* (rule names, exit names), which is left verbatim on purpose. |
| Dynamic text too | `toast()`, `confirm()`, `alert()`, `prompt()` and anything rendered later (charts, tables, the SSE log) are translated: a `MutationObserver` re-runs the dictionary pass on new DOM nodes, with a 2.5 s fallback sweep. |
| Numeric phrases | ~30 regex rules handle generated strings, e.g. `07:00 · 共 175 次 · 合计 122 · 其中错误 53` → `07:00 · 175 requests · total 122 · errors 53`, plus `第 2 / 4 页` → `page 2/4`, `2/3 出口在线` → `2/3 exits online`, `采样 208 条` → `sampled 208 rows`. |
| Switch | The 🌐 button in the top bar flips the `cfp_lang` cookie; the server renders `<html lang>` and serves the dictionary from `/boot.js` (gzip, `no-store`, before auth). |

### v0.14.1 highlights

| Change | Detail |
| --- | --- |
| JSON gets ETag / 304 | Every `sendJson` response now carries a weak ETag (`W/"<len>-<sha1>"`, `-gz`/`-id` per encoding) and `Cache-Control: private, no-cache`, so the 5-second `/api/state` poll revalidates instead of re-downloading. This only works because `no-store` was removed — with `no-store` browsers never send `If-None-Match`. |
| Offline page | `sw.js` (cache v2) now answers failed navigations with `assets/offline.html`: a short "can't reach the panel" card listing the three things to check, served from cache with no network. |
| Settings search | A search box above the section chips filters the 13 setting cards by title + body text; chips of hidden cards disappear and a counter shows `2 / 13 个分区匹配`. |
| Mobile charts | Under 720 px the chart height goes 96 → 126 px and axis labels drop to 10 px, so the hour ticks stop colliding. |
| Docs | Removed the last stale `/legacy` references (the 96 KB single page was deleted in v0.12.0). |

### v0.14.0 highlights

| Change | Detail |
| --- | --- |
| Hit counts with a window | Rule cards used to count "last 2000 log lines" — you could not tell over what period. `GET /api/routes/stats?hours=` now takes 1/6/24 h and the rules page has a selector (remembered in `localStorage`). |
| Chart tooltips | Every bar (and every uptime sample) carries a `<title>`: hover shows `22:00 · 共 120 次 · 其中错误 8`. Works with no JS — native SVG tooltips. |
| Exit recovered notification | New `tunnelUp` event: when an exit flips from stopped/error to running you get a message with its URL. Toggle lives next to "exit down". |
| Audit CSV export | `GET /api/audit.csv` streams CSV with a UTF-8 BOM (so Excel opens it correctly); button on the Observe page. |
| Click an IP to filter | Source-IP cells are links; clicking fills the new IP filter (also works via `/observe?ip=1.2.3.4`). |
| Latent bug fixed | Access-log rows had no `at` field, so the monitor's "requests in the last 5 minutes" window was always empty — the 5xx-spike alert had never fired. Rows now carry `at` and `readAccess()` accepts `{since, maxBytes}`. |

### v0.13.9 highlights

| Change | Detail |
| --- | --- |
| Charts actually readable | The plot stays in SVG, but the hour labels are now HTML positioned over it — no more squashed text from `preserveAspectRatio="none"`. Bars got side padding (first/last no longer clipped), a baseline + mid gridline, and a 1.08 head-room so a peak doesn't touch the border. |
| Three charts per row | The trend / history / change cards were in a 2-column grid, so the third wrapped and left a hole; moved to `.grid3`. |
| No more blank card | *Exit uptime history* with a single sample used to draw an invisible polyline; it now explains "still sampling" (and the real curve needs ≥2 points). |

### v0.13.8 highlights

| Change | Detail |
| --- | --- |
| **Login page fixed** | The login form's script was inline, and the Content-Security-Policy (`script-src 'self'`) blocked it — so the browser fell back to a native form submit, sending `username`/`password` in the URL and never signing you in. The script now lives in `/assets/login.js`. |
| Language bootstrap as a file | `window.__CFP_LANG`/`__CFP_DICT` used to be inline too (also blocked, so the English switch silently did nothing). Now served by `/boot.js` (gzip, `no-store`). |
| Regression test | The API suite now asserts that **no page contains an inline `<script>`**, and the DOM suite checks the login page references `login.js` and `/boot.js`. |

### v0.13.7 highlights

| Change | Detail |
| --- | --- |
| Suspicious traffic view | New `/api/security/attempts?hours=` aggregates every 401/403 by **rule** and by **client IP** (top 5 IPs per rule). The Observe page gets a card with a 6h/24h/3d/7d window and links into the matching rule. |
| Scan alert | When one IP gets rejected ≥20 times in 10 minutes, a new `authScan` notification fires (own 30-minute cooldown, toggle in Settings). Built for `db`/`term` style services that get port-scanned daily. |

### v0.13.6 highlights

| Change | Detail |
| --- | --- |
| Clickable access log | Every row in *Access log* now carries the rule it matched (`/api/access` attaches `rule: {id, name}`); the path becomes a link to that rule, same `?focus=` highlight as the legend. |
| Hit counter per rule | Each rule card shows `命中 N · 错 M · p95 Xms` from `/api/routes/stats`, so you can see at a glance which rule carries the traffic and which one is failing. |

### v0.13.5 highlights

| Change | Detail |
| --- | --- |
| Clickable traffic legend | Each legend chip in *Traffic by rule* links to `/rules?focus=<rule id>`; the rules page switches to that rule's scope, scrolls to the card and flashes it. |

### v0.13.4 highlights

| Change | Detail |
| --- | --- |
| Traffic by rule | `GET /api/traffic/paths?hours=&top=` groups the access log by the rule each request *would* match, so you can see which service is consuming traffic. Requests that match nothing get their own counter instead of drowning the chart. |
| Deploy hint | Warming records the code fingerprint (`state.warm`); the overview shows a banner when the running code no longer matches the last warm-up, with a link to re-warm. |

### v0.13.3 highlights

| Change | Detail |
| --- | --- |
| Asset fingerprint (`?v=`) | Pages reference `/assets/app.css?v=<code-hash>` etc. Fingerprinted URLs answer `Cache-Control: public, max-age=31536000, immutable` — the URL changes whenever the code does, so a deploy is a cache-buster by construction. Unversioned URLs keep the old 300 s behaviour. |
| Cache warm-up | `POST /api/cf/cache/warm` (Tools → *Warm cache*) pulls `/login` + the fingerprinted assets through the public hostname and reports `cf-cache-status`, `age`, colo and latency per URL. Measured: assets `MISS 1109 ms` → `HIT age=19 260 ms`. |
| Notify templates | `settings.notify.template {title, text}` with `{event} {title} {text} {host} {time} {running} {total}`. Empty = the old default. If your custom text does not mention `{text}`, the original body is appended so detail is never lost. |

### v0.13.2 highlights

| Change | Detail |
| --- | --- |
| Edge caching for assets | Static files answer with `Cache-Control: public, max-age=300` and `Cloudflare-CDN-Cache-Control: public, max-age=86400`. Tools → *Edge cache* can create the matching Cache Rule and purge by URL or whole zone (`cf-cache-status` went `DYNAMIC` → `MISS` → `HIT`). |
| Asset auth removed | `/assets/*` is served before authentication, because the login page itself needs `app.css` — it used to 401 and render unstyled. |
| JSON gzip | Responses over 1 KB are gzipped when the client accepts it: `/api/state` 4851 B → 1559 B. |
| Notify resend | `POST /api/notify/resend {seq}` + a *resend* button per row in Settings → notification log, bypassing quiet hours and cooldowns so you can prove the webhook works. |
| Settings section nav | Sticky `.subnav` with 13 anchors. |
