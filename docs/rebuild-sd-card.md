# Rebuilding the Raspberry Pi SD card (Bookworm)

How to reconstruct the production kiln controller on a fresh SD card. Written
after a from-scratch rebuild on **2026-07-18** (Pi 3 B, Raspberry Pi OS Bookworm).
The scripted part is [`scripts/kiln-firstsetup.sh`](../scripts/kiln-firstsetup.sh);
remote access is in [`remote-access-cloudflare.md`](remote-access-cloudflare.md).

## Gotchas that will bite you (read first)

- **"Raspberry Pi OS Lite (Legacy)" is now Bookworm, not Bullseye.** Debian's
  *oldstable* rolled forward. Bookworm changes two things that broke the old
  headless recipe:
  - The FAT boot partition mounts at **`/boot/firmware/`**, not `/boot/`. Staged
    files (setup script, `kiln_authorized_keys`) land there.
  - The network stack is **NetworkManager**, so a `wpa_supplicant.conf` dropped on
    the boot partition is **ignored**. Configure Wi-Fi via Raspberry Pi Imager's
    customization, or on the Pi with `nmcli` / `raspi-config nonint do_wifi_country US`.
- **Power the Pi from its own 5V/2.5A+ supply — never a Mac/PC USB port.** A Pi 3
  browns out on ~0.9–1.5A; add a monitor and it reboot-loops. That loop looked
  like a networking failure but was undervoltage. Boot **headless** (no HDMI).
- **The app needs I2C + SPI enabled or it crash-loops.** `lib/arduinoWatcher.py`
  opens `/dev/i2c-1` at construction (uncaught `FileNotFoundError` if absent), and
  the MAX31855 uses SPI. `kiln-firstsetup.sh` enables both, but they require a
  **reboot** to take effect.
- **Raspberry Pi OS Lite has no `curl`** preinstalled (needed for cloudflared).
  The setup script installs it.
- **No thermocouple wired → a flat phantom ~1500°F.** Not a fault. Verify ~room
  temp once the sensor is on GPIO CS=27/CLK=22/DO=17, before any real firing.

## Procedure

1. **Flash** Raspberry Pi OS Lite (Legacy, 32-bit) to the card. Easiest is the
   Raspberry Pi Imager with OS customization set: hostname `kiln`, user `brian`
   (+ password), your SSH public key, Wi-Fi SSID + **country US**, timezone.
   (Imager configures Wi-Fi correctly for NetworkManager; the manual
   `wpa_supplicant.conf` route does not.)
2. **Boot headless** on a proper 2.5A+ supply. Find it: `ssh brian@kiln.local`
   (or scan the LAN for a `b8:27:eb` / `dc:a6:32` MAC).
3. **Run setup:** `bash scripts/kiln-firstsetup.sh` (or clone the repo first and
   run it from there). Add `BRANCH=firing-tracking` to deploy the preview branch.
4. **Reboot** (`sudo reboot`) to apply I2C/SPI + hostname. Then verify:
   `curl -sS -o /dev/null -w '%{http_code}\n' http://localhost/` → `200`.
5. **PagerDuty** (optional): put the Events API v2 key in a gitignored `.env`:
   `echo 'PAGERDUTY_ROUTING_KEY=...' >> ~/kiln-controller/.env && chmod 600 ~/kiln-controller/.env`,
   then restart the service.
6. **Cloudflare tunnel:** follow [`remote-access-cloudflare.md`](remote-access-cloudflare.md).
   The `~/.cloudflared/cert.pem` (account/zone cert) is reusable across rebuilds;
   only the tunnel **credentials JSON** is card-specific, so delete the orphaned
   tunnel and create a fresh one, then `route dns --overwrite-dns`.

## Faster path: restore an image

A full `dd` clone of a known-good card restores an identical system in minutes
(reused host keys, Wi-Fi profile, tunnel creds — no re-setup). It also contains
**every secret**, so store it encrypted. Restore: `gzip -dc kiln-<date>.img.gz |
sudo dd of=/dev/rdiskN bs=4m` onto a same-or-larger card. This complements, but
does not replace, the config-in-git path above (images go stale).
