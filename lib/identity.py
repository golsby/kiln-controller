'''Controller identity.

Every controller carries a globally-unique id (UUIDv4) plus a human-friendly
name. The id is immutable and makes a device unique across all tenants; the name
is shown on the dashboard and can be edited. Stored in a gitignored JSON file at
the repo root (alongside resume.json/state.json) so it is per-device, survives a
git pull, and is never committed. Auto-created on first use.
'''

import os
import json
import uuid
import socket
import logging

log = logging.getLogger("identity")


def _default_name():
    try:
        host = socket.gethostname()
    except Exception:
        host = ""
    return host or "Kiln Controller"


def load_or_create(path):
    '''Return {"id", "name"}, creating the file on first use. Repairs a missing
    or malformed id/name rather than failing.'''
    data = {}
    if os.path.exists(path):
        try:
            with open(path, 'r') as f:
                data = json.load(f)
        except Exception as e:
            log.error("could not read controller identity %s: %s" % (path, e))
            data = {}

    changed = False
    if not data.get("id"):
        data["id"] = str(uuid.uuid4())
        changed = True
    if not data.get("name"):
        data["name"] = _default_name()
        changed = True

    if changed:
        save(path, data)
        log.info("controller identity: id=%s name=%r" % (data["id"], data["name"]))
    return {"id": data["id"], "name": data["name"]}


def save(path, data):
    with open(path, 'w') as f:
        json.dump({"id": data["id"], "name": data["name"]}, f)


def set_name(path, name):
    '''Rename the controller, preserving its id. Returns the updated identity.'''
    name = (name or "").strip()
    if not name:
        raise ValueError("controller name cannot be empty")
    data = load_or_create(path)
    data["name"] = name
    save(path, data)
    log.info("controller renamed to %r" % name)
    return data
