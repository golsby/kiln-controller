"""Operator notifications via PagerDuty Events API v2 (works on the free plan).

Set PAGERDUTY_ROUTING_KEY (the Integration Key from a PagerDuty service's
"Events API V2" integration) in your .env. If it's unset, every call is a
no-op, so the controller runs fine without PagerDuty configured.

Sends are fire-and-forget on a daemon thread so a slow/unreachable network
never blocks the control or watcher loops.
"""
import json
import logging
import threading
import urllib.request

import config

log = logging.getLogger(__name__)

PD_ENQUEUE_URL = "https://events.pagerduty.com/v2/enqueue"


def _routing_key():
    return getattr(config, "pagerduty_routing_key", "") or ""


def pagerduty_event(action, dedup_key, summary,
                    severity="critical", source="kiln-controller"):
    """Send a PagerDuty Events API v2 event.

    action    - "trigger" to raise an incident, "resolve" to close one
    dedup_key - stable key tying a resolve to its trigger (and de-duping
                repeat triggers into one open incident)
    """
    key = _routing_key()
    if not key:
        return  # PagerDuty not configured

    body = {
        "routing_key": key,
        "event_action": action,
        "dedup_key": dedup_key,
        "payload": {
            "summary": summary[:1024],
            "severity": severity,
            "source": source,
        },
    }

    def _send():
        try:
            data = json.dumps(body).encode("utf-8")
            req = urllib.request.Request(
                PD_ENQUEUE_URL, data=data,
                headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=10)
            log.info("PagerDuty %s sent (%s)" % (action, dedup_key))
        except Exception as e:
            log.error("PagerDuty %s failed: %s" % (action, e))

    threading.Thread(target=_send, daemon=True).start()
