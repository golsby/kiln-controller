# Firing Tracking & History — Design

Status: **in progress** (branch `firing-tracking`)
Author: Brian Gillespie
Last updated: 2026-06-27

## Goal

Give the kiln controller a durable concept of a **firing**: capture every run as a
self-contained record (the planned schedule, the actual temperature log, a timeline of
what happened, and human-authored notes/results), and surface past firings in the
dashboard for review and annotation.

Today the system has **no concept of a completed firing**. Profiles persist as JSON;
everything else is ephemeral — the live time-series lives only in `ovenWatcher.last_log`
in memory and is wiped on Stop or client reconnect. There is a standing `FIXME` at
`lib/ovenWatcher.py:104` — *"need to save runs of schedules in near-real-time."* This
feature answers it.

## Scope & non-goals

In scope:
- A persistent, self-contained **firing record** per run, captured in near-real-time.
- A **controller identity** (GUID + human name) established from day one.
- A **History** view in the dashboard (list + detail with planned-vs-actual graph,
  event annotations, and editable metadata).
- A one-time **importer** that backfills past firings from `process.log` + existing CSVs.

Explicitly out of scope (deferred to the future **cloud/remote-access** project):
- Remote access from outside the LAN, auth, multi-tenant accounts.
- Syncing multiple controllers under one account.
- Cloud storage / offload of records or photos.

This design is **cloud-forward**, not cloud-coupled: records are self-contained bundles
and all access goes through a clean local `/api/firings` REST surface, so the future AWS
layer is a proxy in front of this — not a rewrite.

## Controller identity

Established now because it is cheap to add and expensive to retrofit once firing records
reference it.

- Stored in a **gitignored `controller.json`** at the repo root, alongside `resume.json`
  and `state.json` — per-device, survives `git pull`, never committed (so every tenant's
  device is globally unique).
- Auto-created on first startup if absent:
  ```json
  { "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479", "name": "Studio Kiln" }
  ```
  - `id` — a UUIDv4. Globally unique across all tenants/devices. Immutable.
  - `name` — human-friendly label shown on the dashboard. Editable. Defaults to the
    machine hostname on first creation.
- Exposed read-only via the existing `/config` websocket (`controller_id`,
  `controller_name`). Renamed via a new `/api` action `set_controller_name`.
- Every firing record embeds `controller_id` so records remain attributable after they
  are someday synced/merged across controllers.

## The firing record — a self-contained bundle

One directory per firing under `storage/firings/`, parallel to `storage/profiles/`:

```
storage/firings/<id>/
  record.json      # summary + embedded profile snapshot + user metadata
  samples.ndjson   # actual firing log: one get_state() dict per line, appended live
  events.ndjson    # discrete event timeline, appended live
  photos/          # user-attached before/after images
```

`<id>` is the UTC start timestamp in a filesystem-safe form, e.g.
`2026-06-22T21-23-13Z`. A directory (not a single file) because a firing accrues
heterogeneous content over its life: the curve while it runs, then notes and photos added
days later.

### `record.json`

```jsonc
{
  "id": "2026-06-22T21-23-13Z",
  "controller_id": "f47ac10b-...",          // attribution for future multi-controller
  "schema_version": 1,

  // ---- summary (auto-computed; refreshed on segment change + finalize) ----
  "status": "completed",                     // running | completed | aborted | error
  "started_at": "2026-06-22T21:23:13Z",
  "ended_at":   "2026-06-23T05:01:40Z",
  "duration_s": 27507,
  "max_temp": 1465.0,
  "peak_target": 1466.0,
  "total_cost": 3.49,
  "currency_type": "$",
  "temp_scale": "f",
  "segment_count": 6,

  // ---- the PLAN: profile snapshot as run (embedded, never a reference) ----
  "profile": { "name": "...", "type": "profile", "data": [[0,100],...], "rth": [...] },

  // ---- user metadata (editable forever after) ----
  "metadata": {
    "title": "",
    "tags": [],                 // free-form: "full-fuse", "test", "oceanside-thin"
    "fields": {},               // arbitrary user key→value; domain-agnostic
    "outcome": {
      "rating": null,           // 1–5
      "summary": "",
      "defects": [],            // free-form chips: "devit", "bubbles", "cracked"
      "went_well": "",
      "went_wrong": ""
    },
    "photos": []                // refs into photos/, with optional before/after label
  }
}
```

Design choices:
- **Embed the profile, don't reference it.** Profiles get edited and deleted; a record
  that stores only `"profile": "cone06-fast"` is worthless once that profile changes. The
  bundle carries the schedule *as actually run*.
- **Metadata is generic.** A fixed core where it helps the UI render controls (rating,
  defects), and open-ended `tags`/`fields` so it fits any craft without domain lock-in.

### `samples.ndjson` — the actual firing log

One slim line per sample, appended as `ovenWatcher` produces it. NDJSON because it is
append-only and crash-safe: if the Pi loses power mid-firing, the record up to that instant
survives. Only the fields needed to graph the firing and to reconstruct an idealized curve
from it are persisted:

```json
{"runtime": 350.0, "temperature": 146.86, "target": 147.6, "heat": 1.0, "totaltime": 7800.0}
```

Everything constant or derived — profile name, `cost`, `kwh_rate`, `currency_type`, the
upcoming-`segments` array, `pidstats`, `resume_*` — lives once in `record.json` rather than
being duplicated on every line. `state` is omitted too: samples are only captured while the
oven is `RUNNING`, so run-state changes are recorded as discrete events in `events.ndjson`. Values are lightly rounded (temps to 0.01°, below
thermocouple resolution) to drop precision-noise. This keeps a long firing's log small.

Note this is a deliberate split from the live feed: the `/status` websocket still carries
the **full** `get_state()` (the live dashboard needs `segments`, `pidstats` for the tuning
view, etc.); only the persisted file is slimmed. The UI downsamples stored samples for
display via a `?resolution=` query param.

### `events.ndjson` — what actually happened

A low-volume stream of discrete events, each `{ts, type, runtime, detail}`, appended live.
These turn a temperature curve into a *narrative*. Example line:

```json
{"ts": "2026-06-27T21:02:04Z", "type": "segment_target_edit", "runtime": 638.0, "detail": {"segment": 2, "old": 1826.0, "new": 900.0}}
```

The event types (vocabulary lives in `firingStore.EV_*`) and where each is emitted:

| Event type | Emitted by | When |
|---|---|---|
| `started` | watcher | a fresh bundle opens on the first RUNNING sample |
| `completed` / `aborted` / `error` | watcher | the run leaves RUNNING (terminal status inferred from oven state) |
| `hold` / `hold_release` | `oven.set_manual_hold` | manual hold engaged / released (detail: `setpoint`) |
| `advance` | `oven.advance_segment` | user skipped to the next segment (detail: `from_segment`, `to_segment`) |
| `segment_target_edit` / `segment_hold_edit` | `oven.set_segment_target` / `set_segment_hold` | runtime edit (detail: `segment`, `old`, `new`) |
| `segment_transition` | watcher | segment/phase changed between samples (RAMP↔HOLD, seg N→N+1) |
| `power_interruption` + `resumed` | watcher | capture continued an interrupted run |

Two emission sites: **user-action** events fire at the oven method chokepoints (so any
caller — `/control` or `/api` — is covered), while **lifecycle/derived** events fire from the
watcher loop. Because events are written from both the watcher thread and the gevent control
greenlet, `events.ndjson` writes are guarded by a lock + closed-flag in `FiringRecorder`.

A manual `advance` is followed by a `segment_transition` for the boundary it caused — both
are kept (the advance records *why*, the transition records the actual phase context).

The `power_interruption`/`resumed` pair is the high-value case. A power loss/crash leaves the
bundle `running` (never finalized); a deliberate Stop leaves it `aborted`. On resume the
watcher continues the **same** bundle and emits `resumed` (with `from_status`), preceded by
`power_interruption` only when the bundle was `running` (a genuine interruption, not a
deliberate stop). The graph then shows the gap exactly where reality diverged from the plan.

## Capture mechanism

Hook `ovenWatcher`'s existing loop, which already assembles every state sample:
- On firing start (`record()`): create the bundle dir, write initial `record.json`
  (status `running`, embedded profile), open `samples.ndjson`/`events.ndjson`, emit a
  `started` event.
- Each loop iteration while running: append the sample line; refresh `record.json` summary
  on segment changes.
- On control actions / scheduler transitions: append the corresponding event.
- On terminal state (DONE / abort / error): finalize `record.json` (status, `ended_at`,
  summary stats), emit the terminal event.
- On resume of an interrupted run: re-open the existing bundle (matched via `resume.json`),
  emit `power_interruption` + `resumed`, continue appending.

Near-real-time (not finalize-at-end) because firings are long and the failure that matters
is the one that kills the controller mid-run.

## API surface — REST under `/api/firings`

REST (not the `/storage` websocket) because a firing's time-series is thousands of points.
This surface is exactly what the future AWS proxy fronts unchanged.

| Method & path | Purpose |
|---|---|
| `GET /api/firings` | list summaries only (cheap; no samples) |
| `GET /api/firings/:id` | full record + samples (`?resolution=` to downsample) + events |
| `PATCH /api/firings/:id` | edit the user-metadata block |
| `POST /api/firings/:id/photos` | attach a photo |
| `DELETE /api/firings/:id` | delete a firing (and its photos) |

## Dashboard

- New **History** view: a grid of firing cards (date, profile name, max temp, status
  badge, optional thumbnail).
- **Detail** page reuses the existing graph component in `picoreflow.js` (it already plots
  a planned curve + a live log) fed from `samples.ndjson` instead of the websocket, with
  **event annotations** (vertical markers: ⏸ hold, ⏭ advance, ⚡ power loss) and a textual
  timeline beside it, plus an editable metadata/notes/results panel.
- Controller **name** shown in the dashboard header; inline rename.

## Migration / backfill

`scripts/import_firings.py` reconstructs past firings from a pre-tracking `process.log`. The
old log's per-sample lines are rich (`temp/target/heat_on/heat_off/run_time/total_time`), so
backfilled firings carry real curves — not sparse points. The importer:

- splits the log into run-segments, dropping noise (0-sample false starts, thermocouple
  `Refusing to start`, service-restart fragments with no data);
- **stitches** consecutive same-profile segments within a time gap (`--gap-min`, default 60)
  into one firing — a single physical firing is often fragmented across many crash/restart
  segments;
- re-bases each sample's `runtime` to **elapsed wall-seconds from the firing start** (each
  fragment restarts `run_time` at 0, which would otherwise fold the curve back on itself),
  and turns the restart seams into `power_interruption`/`resumed` events;
- keeps firings with `>= --min-samples` (default 10), embeds the planned curve from the
  profiles dir when the name matches, infers status (`schedule ended` → completed, else the
  last fragment's end reason), and marks the record `imported: true`.

`--dry-run` prints the plan without writing. Bundles are written via
`firingStore.import_firing` (same schema as live capture). Metadata is left empty for the
user to fill in.

Run against the production log it produced 6 firings from ~49k log lines (e.g. a 10 h 1"
full fuse, an 18.7 h completed fuse, and one 29 h cast+anneal stitched from 10 fragments).
**These bundles live wherever the importer writes** (`--out`); to populate the production
device's history, run the importer there (or copy the bundles over) once the backend is
deployed, re-stamping `controller_id` to that device's identity.

## Storage footprint

All local on the Pi. `samples.ndjson` is a few MB per firing — years of firings fit easily.
Photos are the only growth risk; deletion is made easy and cloud offload is deferred to the
AWS phase.

## Implementation plan (phased)

1. **Controller identity** — *done.* `controller.json` load-or-create, exposed via
   `/config`, rename via `/api`, name shown in the dashboard header.
2. **Capture core** — *done.* Bundle writer (`lib/firingStore.py`); `ovenWatcher` streams
   `samples.ndjson` and writes/finalizes `record.json` on the RUNNING edges. Resume (crash
   or explicit Stop) continues the same bundle; a fresh start finalizes orphaned `running`
   bundles as `interrupted`. `duration_s` is firing-clock time (excludes stopped gaps).
   record.json summary is refreshed on segment change + finalize; between those, a crash
   leaves a truthful `running` status and the full `samples.ndjson` (summary recomputable).
3. **Event timeline** — *done.* `events.ndjson` with the event vocabulary above. User
   actions emit at the oven chokepoints; lifecycle/transition/`power_interruption`/`resumed`
   emit from the watcher. Thread-safe writes. Verified for every event type in the simulator,
   including crash-resume (→ `power_interruption`+`resumed`) vs Stop-resume (→ `resumed` only).
4. **Read API** — *done.* `GET /api/firings` (summaries, newest first) and
   `GET /api/firings/:id` (full record + events + samples, `?resolution=N` downsamples and
   always keeps the last point). Path-traversal-safe `:id`; unknown id → 404. Read helpers
   live in `firingStore` (`list_firings`/`get_firing`).
5. **History UI** — *done.* A History view in the dashboard (toggled from the header;
   `#history` deep-link): a list sorted by firing date, and a detail view with a
   planned-vs-actual Canvas graph (area-filled actual line, faint grid, hover crosshair),
   event pins + red interruption bands, a typed event timeline **bidirectionally linked** to
   the graph (select a row → mark it on the curve; click a pin → scroll to the row), and a
   read-only notes panel. Reuses the app's design tokens; all styles scoped under
   `#history_view`. Verified in-browser against the backfilled firings.
6. **Metadata editing** — *done.* Editable notes panel: title (acts as the firing's
   display name when set), rating, tags, "what happened", defects, saved via
   `PATCH /api/firings/:id`. Photo upload (`POST …/photos`, served by `GET …/photos/:name`,
   removed by `DELETE`), shown as a thumbnail grid. Delete a firing
   (`DELETE /api/firings/:id`, confirm-gated). Path-traversal-safe ids; uploads capped by a
   raised `MEMFILE_MAX`. `scripts/merge_firings.py` (see Migration) handles firings that were
   split across two profiles.
7. **Backfill importer** — *done* (pulled forward). `scripts/import_firings.py`; see
   Migration / backfill above. Used to seed real history for building the UI.

Each phase is independently shippable and verifiable in the simulator.
```
