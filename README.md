# Velux Roof Windows (home_io_control) -- Homey app

Controls VELUX roof windows directly over the local network, through a self-hosted ESPHome
gateway running the [home_io_control](https://github.com/laberning/home_io_control) firmware
(a fork/local checkout of it, in this project's case -- see your own gateway config). No cloud,
no vendor hub, no Homey "ESPHome Controller" community app in between -- this app talks to the
gateway's own REST/SSE `web_server:` API directly.

MIT-licensed -- anyone may use, fork and extend this. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Status

First version. Covers (roof windows) only -- lights, locks, switches and climate devices that
`home_io_control` also supports are out of scope for now. Built and validated against:

- **Firmware**: `home_io_control`, ESPHome **2026.9.1**, with `web_server: version: 3` on
  **port 80** of the gateway (see that project's `config/my-velux-hub.yaml`).
- **Homey SDK**: v3, `compatibility: ">=12.11.0"` (the floor required by the stock
  `alarm_rain` capability -- confirmed via `homey app validate`, not assumed).
- **Homey CLI**: 4.3.1.

If you reflash the gateway with `web_server:` on a different port, or remove/rename the
`rain_sensor_poll_interval:`/`Ventilation Position` entities this app depends on, update the
gateway config or this app's expectations accordingly -- there is no version negotiation.

## Installation (local testing)

```bash
cd homey-app
npm install
homey login                      # once, if not already
homey app build                     # regenerates app.json from .homeycompose/*
homey app validate --level publish  # should pass; --level debug is more lenient while iterating
homey app run --remote              # pushes to your real Homey Pro and streams its console
```

`app.json` is build output (`homey app build` regenerates it from `.homeycompose/*` every time)
but, unusually for a compose-based app, this CLI version (4.3.1) requires it to already exist
on disk to run `build` at all -- confirmed empirically (`ENOENT` otherwise). It's committed to
the repo for that reason; don't hand-edit it; edit the `.homeycompose/` sources instead and
rebuild. If it's ever deleted, `cp .homeycompose/app.json app.json` once reseeds it, then
`homey app build` will fully regenerate it correctly from there.

`homey app run` defaults to a local Docker simulator; this machine has no Docker installed, so
use `--remote` to push to and run directly on your actual Homey Pro instead.

`homey app run` asks which Homey to target on first run. Pairing, capability reads and the
flow cards can all be exercised this way without publishing anything.

## Pairing

1. **Connect**: enter the gateway's IP address or hostname (reachable on port 80).
   The app briefly connects to `/events` and collects the initial SSE burst to confirm it's a
   reachable `home_io_control` gateway and list its windows (`GET /cover`, the domain-only
   listing endpoint, returns an empty body on this firmware version -- confirmed against a
   running gateway -- so the SSE burst is the only generic discovery mechanism available; see
   `Gateway.discoverCovers()` in `lib/Gateway.js`).
2. **Select**: every discovered `cover` entity not already added (on this or any other
   gateway) is offered, multi-select, via Homey's standard `list_devices` pairing template.
3. Each selected window becomes its own Homey device.

### Device identity (read this before renaming anything in the firmware)

A device's stable identity (`data.id`) is the **ESPHome entity's exact `name:`** (e.g.
`"Dakraam 1 Overloop"`) -- this REST/SSE API does not expose a hardware-rooted id (no
`io_device_id`, no MAC, no ESPHome `unique_id`; that last one likely exists on the Native API,
which this app does not use). Consequences:

- **Renaming the cover in the firmware YAML orphans the Homey device.** Re-pair it under the
  new name; there's no automatic migration.
- **Only one gateway is supported safely in this version.** Two different physical gateways
  with identically-named windows would collide on this id scheme. Documented limitation, not
  silently handled -- a multi-gateway v2 would need a per-gateway namespace prefix.
- The gateway's **address is not part of the id** and lives in device settings instead,
  specifically so **a DHCP-assigned IP change never requires re-pairing** -- use the device's
  **Repair** flow (or edit the "Gateway address" setting directly) to point it at a new
  address. Recommend a DHCP reservation or static IP on the gateway to avoid needing this.

## Capabilities

| Capability | Kind | Source |
|---|---|---|
| `windowcoverings_state` | stock (`up`/`idle`/`down`, ternary UI) | open/stop/close control + its own built-in flow trigger/condition/action |
| `windowcoverings_set` | stock (0.0-1.0, slider, shown as 0-100%) | position control + its own built-in flow trigger/action |
| `button.ventilation` | stock `button`, per-device instance | presses the firmware's own `<window> Ventilation Position` button -- **never a synthesized percentage** |
| `alarm_rain` | stock | this window's own rain sensor, **not** a shared gateway-wide signal -- see below |
| `alarm_rain_stale` | **custom**, defined in this app | true until the first real rain reply ever arrives, or whenever the gateway connection is lost; see below |
| `alarm_connectivity` | stock (`true` = disconnected) | driven from the shared Gateway's SSE connection health |

Most required flow cards (position changed, rain detected/cleared, rain-is-detected
condition, reachability changed, is-reachable condition, set position, set state) come for
free from these **stock** capabilities' own `$flow` definitions (confirmed directly from
`homey-lib`'s capability JSON, not assumed) -- no custom flow-card code needed for them. This
app only hand-defines: the `open`/`close`/`stop` action cards (explicit single-purpose cards,
requested alongside the standard ternary dropdown action) and the `position_above`/
`position_below` condition cards (no stock equivalent exists).

### Position mapping

ESPHome's cover `position` field is already `0.0` (closed) - `1.0` (open) -- identically
`windowcoverings_set`'s own range and direction (confirmed in `homey-lib`'s capability
definition: *"0% is closed, 100% is open"*). No scaling or inversion happens anywhere in this
app; `device.js` passes the SSE-reported `position` straight into `setCapabilityValue`, and
the capability's own action sends the raw 0.0-1.0 value straight to
`/cover/<name>/set?position=`.

### Desired vs. confirmed position

`windowcoverings_set` is only ever written from **real SSE feedback** (`_handleCoverState` in
`device.js`), never optimistically from a command this device just sent. Homey's own UI shows
the dragged-to slider position immediately and reverts it if the capability listener's promise
rejects -- that already represents "desired" to the user. What's stored (and what you see on
reopening the device, or in Insights) is always the last position the window itself confirmed.

### Rain feedback: per-window, not gateway-wide

Each window has **its own** `"<window name> Rain sensor"` binary_sensor entity. This is
genuinely per-device at the protocol level, not a shared broadcast -- confirmed by reading the
firmware source (`rain_sensor_poll_interval:` is a per-`cover:` YAML key in
`components/home_io_control/cover.py`, bound to that cover's own `io_device_id`; the hub asks
each window individually "what's your current opening limit", and each window answers from
its own wired sensor) and empirically: a live test during development showed the two windows
reporting *different* rain states at the same moment (one dry, one wet). If your installation
only has one window with a wired rain sensor and others without, only that one window will
ever get a confirmed (non-stale) `alarm_rain` value -- the others simply never receive a
binary_sensor reply and stay on `alarm_rain_stale = true` forever, which is correct, not a bug.

### Rain staleness, reconnects, and Insights

- `alarm_rain_stale` starts `true` on every device (re)init and only ever becomes `false` once
  a *real* `binary_sensor` SSE event for that window's rain sensor arrives -- it is never
  defaulted to "fresh", and `alarm_rain` itself is never written a default/guessed value at
  startup (Homey persists its last known value across app/device restarts on its own, which is
  exactly the desired "keep the last confirmed value" behaviour).
- On a lost gateway connection, `alarm_rain_stale` is set `true` again (the reading can no
  longer be trusted as current), but `alarm_rain`'s own value is left untouched -- no
  fabricated "no rain" default, no fabricated history.
- On **reconnect**, nothing is back-filled or guessed: the capability only updates again once
  a genuine new SSE event arrives. No synthesized historical rain transitions are ever
  produced, by construction (there is no code path that writes `alarm_rain` from anything
  other than a live SSE `binary_sensor` event).
- `alarm_rain` ships with Homey's own `"insights": true` (confirmed in `homey-lib`, not
  assumed) -- every real transition is logged to Insights automatically via the normal
  `setCapabilityValue` call, including rain the module reports on its own steam with no Flow
  involved at all, since `device.js` subscribes to the gateway's SSE stream unconditionally
  from `onInit()`, independent of whether any Flow ever runs.

## Shared gateway connection

`lib/Gateway.js` is a small reference-counted wrapper around one gateway's REST + SSE
connection. `drivers/velux_window/driver.js` keeps one `Gateway` per address; each `Device`
`acquire()`s it in `onInit()` and `release()`s it in `onUninit()`. The underlying SSE
connection only actually closes once the last device referencing that address is gone --
**deleting one window's Homey device never disconnects another window on the same gateway.**

## Known limitations / follow-ups

- Single-gateway identity scheme (see above) -- documented, not yet handled for multiple
  gateways.
- `support` URL not yet set in `.homeycompose/app.json` -- required only for the "verified"
  App Store tier (`homey app validate --level verified`), not for local testing or a first
  publish.
- No automated test suite yet; validated via `homey app validate` + live manual testing
  against a real `home_io_control` gateway and a real Homey Pro (see below).
- Only `cover:` entities are supported. Lights, locks, switches, climate -- all present in
  `home_io_control` -- are not implemented here.

## Manual test log

- `homey app run --remote`: app installs and boots cleanly on the real Homey Pro
  ("Homey Pro 12b"), both `App#onInit()` and `Driver#onInit()` log success with no errors.
  Left running so pairing can start immediately.
- Code review caught and fixed one real bug before this: the gateway address was written to
  both device `store` and `settings` at pairing time, but `onInit()` read `store` first --
  an address edited via the Settings UI (not Repair) would have been silently reverted to the
  stale `store` value on the next app restart. Fixed by making `settings` the single source of
  truth throughout (`device.js`, `driver.js`).
- `homey app validate --level publish`: passes.
- `Gateway.discoverCovers()` against a live gateway: correctly found both configured windows.
- `Gateway` SSE lifecycle (`acquire`/`release`, connection-change events, state events):
  verified against the live gateway outside the Homey runtime (`node -e ...`), including a
  live observation of the two windows reporting *different* rain states at the same time
  (confirming the per-window, not gateway-wide, rain claim above).
- Read-only REST call (`GET /cover/<name>`) verified against the live gateway.
- **Pairing fixed and confirmed live on a real Homey Pro**: the original pairing view used an
  `onHomeyReady(Homey)` wrapper callback, which the current Homey SDK3 pairing-view runtime
  never calls (that's an older-SDK convention) -- `Homey` is already a global by the time the
  `<script>` tag runs; no wrapper needed. Confirmed against the current official docs
  (`apps.developer.homey.app/advanced/custom-views/custom-pairing-views`) after the symptom
  (button visibly did nothing, zero backend log activity) made the stale assumption obvious.
  Both windows paired successfully afterwards, each as its own device with a stable Homey ID,
  and the shared-Gateway design was confirmed working as intended: pairing two windows on the
  same address produced exactly one `"Gateway[...] connecting"` log line, not two.
- **Physically exercised by the device owner**: open/close/stop/position/ventilation all
  confirmed working against the real windows. Installed persistently via `homey app install`
  (not just a `homey app run` dev session, which uninstalls itself when the CLI disconnects).
- **Still to verify**: a live Insights timeline check for `alarm_rain` (needs a human in the
  Homey mobile app after a real rain transition).

## License

[MIT](LICENSE). Contributions welcome -- see [CONTRIBUTING.md](CONTRIBUTING.md).
