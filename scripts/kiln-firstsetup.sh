#!/usr/bin/env bash
# kiln-firstsetup.sh — one-shot post-boot setup for a fresh Raspberry Pi.
#
# Tested on Raspberry Pi OS Bookworm (Debian 12) Lite, armhf, Pi 3.
# See docs/rebuild-sd-card.md for the full flash-and-boot procedure and gotchas.
#
# Usage (after first boot, logged in as the target user):
#     bash scripts/kiln-firstsetup.sh
#     BRANCH=firing-tracking bash scripts/kiln-firstsetup.sh   # override branch
#
# Idempotent-ish: safe to re-run; skips the clone if the repo is already present.
set -euo pipefail

REPO_URL="https://github.com/golsby/kiln-controller"
BRANCH="${BRANCH:-main}"
HOME_DIR="$HOME"
APP_DIR="$HOME_DIR/kiln-controller"

# Bookworm mounts the FAT boot partition at /boot/firmware; older images use /boot.
BOOTDIR=/boot/firmware
[ -d "$BOOTDIR" ] || BOOTDIR=/boot

echo "==> [0/6] hostname, ssh key, I2C/SPI"
sudo raspi-config nonint do_hostname kiln || true
# The controller (arduinoWatcher) opens /dev/i2c-1 at startup and the MAX31855
# thermocouple uses SPI — both are OFF on a fresh image and need a REBOOT to
# take effect, or the service crash-loops on FileNotFoundError: /dev/i2c-1.
sudo raspi-config nonint do_i2c 0
sudo raspi-config nonint do_spi 0
if [ -f "$BOOTDIR/kiln_authorized_keys" ]; then
  mkdir -p "$HOME_DIR/.ssh"
  cat "$BOOTDIR/kiln_authorized_keys" >> "$HOME_DIR/.ssh/authorized_keys"
  sort -u "$HOME_DIR/.ssh/authorized_keys" -o "$HOME_DIR/.ssh/authorized_keys"
  chmod 700 "$HOME_DIR/.ssh"; chmod 600 "$HOME_DIR/.ssh/authorized_keys"
  echo "    installed authorized_keys from $BOOTDIR"
fi

echo "==> [1/6] apt update + base packages"
sudo apt-get update
sudo apt-get -y dist-upgrade
# curl is NOT preinstalled on Raspberry Pi OS Lite; needed for the cloudflared step.
sudo apt-get -y install git curl python3-dev python3-virtualenv virtualenv libevent-dev

echo "==> [2/6] clone repo ($BRANCH)"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
git fetch origin
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "==> [3/6] python venv + deps"
if [ ! -d venv ]; then
  virtualenv -p python3 venv
fi
export CFLAGS=-fcommon
venv/bin/pip install --upgrade pip setuptools
venv/bin/pip install -r requirements.txt

echo "==> [4/6] install systemd unit (from the repo, single source of truth)"
sudo cp "$APP_DIR/lib/init/kiln-controller.service" /etc/systemd/system/kiln-controller.service
sudo systemctl daemon-reload
sudo systemctl enable kiln-controller
echo "    enabled (will start cleanly after the reboot below)"

echo "==> [5/6] install cloudflared (armhf .deb)"
if ! command -v cloudflared >/dev/null 2>&1; then
  curl -fsSL -o /tmp/cloudflared.deb \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-armhf.deb
  sudo dpkg -i /tmp/cloudflared.deb
fi
cloudflared --version

cat <<'NEXT'

==> [6/6] Automated part DONE. Now:

  1) REBOOT to apply I2C/SPI + hostname:   sudo reboot
     After reboot the kiln app should be live on http://kiln.local (port 80).
     Verify: curl -sS -o /dev/null -w '%{http_code}\n' http://localhost/   (expect 200)
     Thermocouple sanity: with the sensor wired, temperature should read ~room
     temp. A flat phantom ~1500F means nothing is connected.

  2) PagerDuty (optional): echo 'PAGERDUTY_ROUTING_KEY=...' >> ~/kiln-controller/.env
     then  chmod 600 ~/kiln-controller/.env  and restart the service.

  3) Cloudflare tunnel (interactive, browser auth): see docs/remote-access-cloudflare.md
     cloudflared tunnel login ; tunnel create kiln ; config + service ; route dns.
NEXT
