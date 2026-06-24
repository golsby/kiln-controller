"""Minimal .env loader (no external dependency).

Reads KEY=value lines from a .env file next to this module and copies them
into os.environ *without* overwriting variables already present in the real
environment. This lets a developer keep local-only settings (for example
KILN_DEBUG=true) in a gitignored .env file that simply does not exist in
production, so the same committed config.py behaves differently in each place.
"""
import os


def load(path=None):
    if path is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            # don't clobber a value explicitly set in the real environment
            os.environ.setdefault(key, value)


# load on import so simply importing this module applies the .env
load()
