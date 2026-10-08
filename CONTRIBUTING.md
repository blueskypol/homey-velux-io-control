# Contributing

Issues and pull requests are welcome -- this app is MIT-licensed specifically so anyone can
extend it (new device types, new capabilities, fixes for a firmware/API quirk this app doesn't
handle yet).

## Scope

This app talks to the [home_io_control](https://github.com/laberning/home_io_control) ESPHome
firmware's `web_server:` REST/SSE API (not its Native API). If you're adding support for a new
`home_io_control` entity type (lights, locks, switches, climate -- all present in the firmware,
none implemented here yet), the pattern to follow is `drivers/velux_window/`:

- One `Gateway` instance per gateway address, shared across devices via `Driver#getGateway()`,
  reference-counted (`acquire()`/`release()`) so removing one device never disconnects another
  on the same gateway -- see `lib/Gateway.js`.
- Device identity is the firmware entity's own `name:` (the only thing this REST/SSE API
  exposes that's stable across reboots and IP changes) -- see the class doc at the top of
  `drivers/velux_window/device.js` for the reasoning and its limitations.
- Prefer standard Homey capabilities over custom ones wherever they fit -- check
  `homey-lib`'s `assets/capability/capabilities/*.json` (inside your local `homey` CLI
  install) for what already exists and what flow cards it gives you for free via its own
  `$flow` block, before writing a custom capability or a custom flow card.
- Never write a capability value optimistically from a command you just sent -- only from real
  SSE feedback. See "Desired vs. confirmed position" in `README.md` for why.

## Local setup

See `README.md`'s "Installation (local testing)" section.

## Before opening a PR

```bash
homey app build
homey app validate --level publish
```

Both should pass. If you're changing `.homeycompose/*`, remember `app.json` is generated --
don't hand-edit it, edit the compose sources and rebuild.
