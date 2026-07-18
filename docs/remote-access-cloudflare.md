# Remote access — Cloudflare Tunnel + Access

"See (and stop) the kiln from anywhere," without opening any inbound port on the
home network. This is the **read + control** remote-access path; it is not the future
multi-tenant platform (that would be a device-telemetry broker — see the end).

## What it is

```
Browser ──HTTPS──> Cloudflare edge ──(Access: Google SSO)──> Cloudflare Tunnel
                                                                   │  (outbound-only
                                                                   │   connection from
                                                                   ▼   the Pi — no port
                                                            cloudflared on Pi   forwarding)
                                                                   │
                                                                   ▼
                                                    kiln-controller @ localhost:80
```

- Public hostname: **https://kilns.bgillespie.art**
- The Pi runs **`cloudflared`** as a systemd service. It dials *out* to Cloudflare's
  edge and holds the connection open — there is **no inbound firewall/router config**,
  no static IP, no dynamic DNS.
- **Cloudflare Access** enforces **Google SSO** in front of the hostname. Only
  allowlisted Google accounts get through. This gate covers everything, including the
  live-status websocket and the remote **Stop** control (websockets carry the Access
  cookie automatically).
- WebSockets (`/status`, `/control`, `/config`, `/storage`) pass through the tunnel
  transparently — no app changes were needed.

## Current facts (as deployed)

| Thing | Value |
|-------|-------|
| Public hostname | `kilns.bgillespie.art` |
| Tunnel name | `kiln` |
| Tunnel UUID | `dac29cb5-4621-48c1-bfdc-bbc0a4ccee1e` |
| Pi service | `cloudflared.service` (systemd), independent of `kiln-controller.service` |
| Local origin | `http://localhost:80` |
| DNS | `bgillespie.art` DNS is hosted on **Cloudflare** (registrar is **Namecheap**; nameservers point at Cloudflare). CloudFront site + Google Workspace email records were migrated over and are **DNS-only / grey-cloud**; only `kilns.*` is proxied/orange. |
| Identity | Cloudflare Access application (self-hosted) for `kilns.bgillespie.art`, IdP = Google, Allow policy = an email allowlist |
| Access team domain | `bgillespie.cloudflareaccess.com` |

## Secrets — what is deliberately NOT in this repo

None of these are committed; they live on the Pi / in Cloudflare / in Google:

- `/home/brian/.cloudflared/cert.pem` — account/zone origin cert (used only for
  management commands: create/delete tunnel, route DNS).
- `/etc/cloudflared/<UUID>.json` — the tunnel credentials (used at runtime by the service).
- The **Google OAuth Client Secret** — entered only into the Cloudflare Access Google
  IdP config. Never paste it into chat, code, or docs.

## Operational notes

- **The tunnel is a separate service from the kiln.** Installing, restarting, or
  removing `cloudflared` does **not** touch `kiln-controller`, drop the contactor, or
  affect a firing. Conversely, restarting `kiln-controller` doesn't disturb the tunnel.
  All of this is **safe to do mid-firing**.
- **Static-asset deploys** (`public/**`) are unaffected — still just a `git pull`,
  reachable immediately through the tunnel on browser reload.
- Health checks (on the Pi):
  ```bash
  systemctl status cloudflared
  cloudflared tunnel info kiln          # shows edge connections
  journalctl -u cloudflared -n 50       # tunnel logs
  ```
- Verify the Access gate from anywhere (should be a 302 to `*.cloudflareaccess.com`,
  NOT the dashboard HTML):
  ```bash
  curl -sS -o /dev/null -D - https://kilns.bgillespie.art/ | grep -iE '^HTTP|^location'
  ```

## Reproduce on a fresh Pi

Assumes `bgillespie.art` DNS is already on Cloudflare (see "DNS" below if not).

1. **Install cloudflared.** The Pi is 32-bit (`armhf`, Raspbian Bullseye). Cloudflare's
   apt repo only ships amd64/arm64, so install the `armhf` `.deb` directly:
   ```bash
   cd /tmp
   curl -fsSL -o cloudflared.deb \
     https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-armhf.deb
   sudo dpkg -i cloudflared.deb
   cloudflared --version
   ```
   (On a 64-bit Pi OS you *can* use the apt repo / `arm64` `.deb` instead.)

2. **Authenticate** (interactive — opens a browser):
   ```bash
   cloudflared tunnel login       # authorize the bgillespie.art zone in the browser
   ```
   Writes `~/.cloudflared/cert.pem`. **Gotcha:** on a headless Pi this sometimes prints
   `error="Failed to fetch resource"` and the browser instead *downloads* `cert.pem`.
   If so, just place that file at `~/.cloudflared/cert.pem` yourself
   (e.g. `ssh pi 'cat > ~/.cloudflared/cert.pem' < ~/Downloads/cert.pem` then
   `chmod 600`).

3. **Create the tunnel:**
   ```bash
   cloudflared tunnel create kiln     # note the UUID + creds JSON path it prints
   ```

4. **Config + service.** Stage config and creds under `/etc/cloudflared/`:
   ```bash
   sudo mkdir -p /etc/cloudflared
   sudo cp ~/.cloudflared/<UUID>.json /etc/cloudflared/
   sudo tee /etc/cloudflared/config.yml >/dev/null <<'EOF'
   tunnel: <UUID>
   credentials-file: /etc/cloudflared/<UUID>.json

   ingress:
     - hostname: kilns.bgillespie.art
       service: http://localhost:80
     - service: http_status:404
   EOF
   cloudflared tunnel ingress validate
   sudo cloudflared service install
   sudo systemctl enable --now cloudflared
   cloudflared tunnel info kiln          # should show edge connections
   ```

5. **Configure Access FIRST, then route DNS.** Order matters: a routed hostname with no
   Access app is publicly open. So set up Access (next section) *before* step 6.

6. **Route DNS (go live):**
   ```bash
   cloudflared tunnel route dns kiln kilns.bgillespie.art
   ```
   Then verify the Access 302 (see Operational notes).

## Cloudflare Access + Google SSO (dashboard)

1. **Zero Trust** onboarding → pick a team name → `bgillespie.cloudflareaccess.com`
   (Free plan, up to 50 users).
2. **Google IdP:** create an OAuth "Web application" client in Google Cloud Console
   (APIs & Services → Credentials), with:
   - JavaScript origin: `https://bgillespie.cloudflareaccess.com`
   - Redirect URI: `https://bgillespie.cloudflareaccess.com/cdn-cgi/access/callback`
   Then Zero Trust → Settings → Authentication → add **Google**, paste the Client ID
   (App ID) + Client Secret, **Test** it.
3. **Access application:** Zero Trust → Access → Applications → **Add → Self-hosted**;
   hostname `kilns.bgillespie.art`; select **Google only** as the IdP; add an
   **Allow** policy with an **Emails** include list (the allowlist). Save.

## DNS notes (moving a domain to Cloudflare)

- Free-plan Cloudflare requires the hostname's **whole zone** to be on Cloudflare.
  Delegating only a subdomain (keeping the parent authoritative elsewhere) is an
  **Enterprise-only** feature — not available on Free/Pro/Business.
- When migrating `bgillespie.art` from Route 53: Cloudflare's importer set the apex to
  hardcoded CloudFront **A** records — wrong (those IPs rotate). Replace with a
  **CNAME at the apex** → `d5yhsqtcd4b6l.cloudfront.net`, **DNS-only** (Cloudflare
  flattens it and keeps it current). Copy MX / SPF / **DKIM** exactly (email breaks
  silently otherwise), and keep the `_…acm-validations.aws` CNAMEs so the CloudFront
  cert keeps auto-renewing. The importer skips those underscore records — add them by hand.

## Not this: the future platform

This gives *one* operator remote access to *this* kiln's existing dashboard. A
multi-tenant "others' kilns" platform is a different architecture (device-initiated
telemetry broker, e.g. AWS IoT Core, scale-to-zero) — intentionally out of scope here.
