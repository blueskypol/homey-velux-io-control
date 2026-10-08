'use strict';

const Homey = require('homey');

// Homey's slider UI can call the position listener repeatedly during a single drag gesture, not
// just once on release. Sending a REST command per intermediate tick would both jitter the
// physical motor and flood the gateway's constrained ESP32 web server with requests alongside
// its one open SSE connection -- so only the value the drag settles on actually gets sent.
const POSITION_DEBOUNCE_MS = 300;

/**
 * One VELUX roof window, bound to a single "cover" entity on a shared Gateway (lib/Gateway.js).
 *
 * Identity: this device's `data.id` is the ESPHome entity's exact `name:` (e.g.
 * "Dakraam 1 Overloop") -- the only thing the REST/SSE API exposes that survives across
 * reboots and gateway IP changes. It is NOT hardware-rooted (no io_device_id/MAC is exposed
 * by this API), so renaming the cover in the firmware YAML orphans this device; re-pairing is
 * the documented recovery path. The gateway's address lives in device *settings* (the single
 * source of truth -- not `store`, which would drift out of sync with a settings-UI edit)
 * precisely so an IP change does NOT require re-pairing: edit the setting, or use Repair.
 *
 * Position mapping: ESPHome's cover `position` field is already 0.0 (closed) - 1.0 (open),
 * exactly Homey's own `windowcoverings_set` range/direction (0=closed, 1=open, confirmed in
 * homey-lib's capability definition) -- no scaling or inversion needed in either direction.
 *
 * Desired vs. confirmed position: `windowcoverings_set` is only ever written here from real
 * SSE feedback (handleState_), never optimistically from a command this device just sent.
 * Homey's own UI shows the dragged-to slider value immediately and reverts it if the
 * capability listener's promise rejects -- that's what represents "desired" to the user; the
 * stored capability value is always the last *confirmed* position.
 *
 * Rain feedback: per-window, not gateway-wide -- each window has its own
 * "<name> Rain sensor" binary_sensor entity (confirmed both by the firmware's
 * `rain_sensor_poll_interval:` being a per-cover YAML key bound to that cover's own
 * io_device_id in components/home_io_control/cover.py, and by each window getting its own
 * distinctly-named entity over the wire). Two windows reporting the same rain state at the
 * same time (as observed during testing) reflects that it was genuinely raining on both, not
 * that they share one sensor. `alarm_rain` is only ever written from a real SSE event, so an
 * unknown/stale reading simply keeps showing the last confirmed value rather than ever reading
 * as a fabricated "no rain" -- Homey's own tile already exposes "last updated" on tap, which is
 * why this app doesn't duplicate that with a separate staleness capability.
 *
 * `window_state` (custom) is a best-effort resting-state label (closed/open/venting) for the
 * device tile -- see its own capability description for why "venting" is derived from command
 * history rather than a hardware-confirmed mode.
 */
class VeluxWindowDevice extends Homey.Device {

  async onInit() {
    await this._migrateCapabilities();

    this._entityName = this.getData().id;
    this._rainSensorName = `${this._entityName} Rain sensor`;
    this._ventilationButtonName = `${this._entityName} Ventilation Position`;
    this._gatewayAcquired = false;
    this._lastCommand = null; // 'venting' right after a ventilation command; cleared by any other command
    this._positionDebounceTimer = null;

    this.registerCapabilityListener('windowcoverings_state', (value) => this._onSetState(value));
    this.registerCapabilityListener('windowcoverings_set', (value) => this._onSetPosition(value));
    this.registerCapabilityListener('button.ventilation', () => this._onPressVentilation());

    await this._connectGateway(this.getSetting('address'));

    this.log(`VeluxWindowDevice "${this._entityName}" initialized (gateway: ${this._address})`);
  }

  /**
   * One-time migration for devices paired before `window_state` was added / `alarm_rain_stale`
   * was removed. Homey does NOT retroactively apply a driver's updated `capabilities` list to
   * already-paired devices on an app update -- without this, a device paired under the old
   * capability set keeps `alarm_rain_stale` listed with no capability definition left to back
   * it (removed from this app entirely), which crashes the Homey app's generated device
   * controls (`Cannot read property 'setable' of undefined`). Idempotent and safe to leave in
   * place for devices that already have the correct set (pre-existing or newly paired).
   */
  async _migrateCapabilities() {
    if (this.hasCapability('alarm_rain_stale')) {
      await this.removeCapability('alarm_rain_stale').catch((err) => this.error('removeCapability(alarm_rain_stale) failed:', err));
    }
    if (!this.hasCapability('window_state')) {
      await this.addCapability('window_state').catch((err) => this.error('addCapability(window_state) failed:', err));
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes('entityName') && newSettings.entityName !== this._entityName) {
      // This setting is informational identity, not a rename control -- data.id (this
      // device's actual identity) cannot change after pairing. Reject the save rather than
      // silently ignoring it, so the user isn't left thinking it took effect.
      throw new Error(this.homey.__('device.entityNameImmutable'));
    }
    if (changedKeys.includes('address') && newSettings.address !== oldSettings.address) {
      await this._connectGateway(newSettings.address);
    }
  }

  async onUninit() {
    if (this._positionDebounceTimer) {
      clearTimeout(this._positionDebounceTimer);
      this._positionDebounceTimer = null;
    }
    this._releaseGateway();
  }

  /** Called by Driver#onRepair once a new address has been verified to reach this same window. */
  reconnectGateway() {
    this._connectGateway(this.getSetting('address')).catch((err) => {
      this.error('reconnectGateway failed:', err);
    });
  }

  // --- Flow action entry points (driver.js registers these against the custom open/close/stop
  // action cards) -------------------------------------------------------------------------

  async openWindow() {
    this._lastCommand = null;
    await this._gateway.openCover(this._entityName);
  }

  async closeWindow() {
    this._lastCommand = null;
    await this._gateway.closeCover(this._entityName);
  }

  async stopWindow() {
    this._lastCommand = null;
    await this._gateway.stopCover(this._entityName);
  }

  // --- Capability listeners (Homey -> device) ---------------------------------------------

  async _onSetState(value) {
    this._lastCommand = null;
    if (value === 'up') return this._gateway.openCover(this._entityName);
    if (value === 'down') return this._gateway.closeCover(this._entityName);
    return this._gateway.stopCover(this._entityName);
  }

  async _onSetPosition(value) {
    // `value` is already a 0.0-1.0 fraction (windowcoverings_set's own range) -- the same
    // scale the firmware's /cover/<name>/set?position= endpoint expects, verified live.
    this._lastCommand = null;
    if (this._positionDebounceTimer) clearTimeout(this._positionDebounceTimer);
    // Resolves immediately -- Homey's own UI already echoes the dragged-to value optimistically
    // (see "Desired vs. confirmed position" in README.md), so there's nothing lost by not
    // waiting on the actual (debounced) command below.
    this._positionDebounceTimer = setTimeout(() => {
      this._positionDebounceTimer = null;
      this._gateway.setCoverPosition(this._entityName, value).catch((err) => {
        this.error('setCoverPosition failed:', err);
      });
    }, POSITION_DEBOUNCE_MS);
  }

  async _onPressVentilation() {
    // Only an intent marker for window_state -- see that capability's description for why this
    // can't be a hardware-confirmed mode on this API.
    this._lastCommand = 'venting';
    await this._gateway.pressButton(this._ventilationButtonName);
  }

  // --- Gateway lifecycle --------------------------------------------------------------------

  async _connectGateway(address) {
    if (!address) {
      await this.setUnavailable(this.homey.__('device.noAddress'));
      return;
    }

    this._releaseGateway();

    this._address = address;
    this._gateway = this.driver.getGateway(address);
    this._unsubscribeState = this._gateway.onState((entity) => this._handleState(entity));
    this._unsubscribeConnection = this._gateway.onConnectionChange((connected) => this._handleConnectionChange(connected));
    this._gateway.acquire();
    this._gatewayAcquired = true;

    // acquire() may reuse an already-connected shared Gateway (another window on the same
    // gateway got there first) -- reflect its current state immediately rather than waiting
    // for the next event, which might be a long time away on a quiet connection.
    this._handleConnectionChange(this._gateway.isConnected());
  }

  _releaseGateway() {
    if (this._unsubscribeState) {
      this._unsubscribeState();
      this._unsubscribeState = null;
    }
    if (this._unsubscribeConnection) {
      this._unsubscribeConnection();
      this._unsubscribeConnection = null;
    }
    if (this._gatewayAcquired && this._gateway) {
      this._gateway.release();
      this._gatewayAcquired = false;
    }
  }

  // --- Gateway -> device feedback -----------------------------------------------------------

  _handleConnectionChange(connected) {
    if (connected) {
      this.setAvailable().catch((err) => this.error('setAvailable failed:', err));
    } else {
      this.setUnavailable(this.homey.__('device.unreachable')).catch((err) => this.error('setUnavailable failed:', err));
    }
    // alarm_connectivity is true = disconnected (stock semantics, confirmed in homey-lib) --
    // its tile title is "Connection lost" precisely so true reads correctly here.
    this._safeSetCapabilityValue('alarm_connectivity', !connected);
  }

  _handleState(entity) {
    // Only the very first SSE event for a given entity (the initial connect burst) carries
    // `domain`/`name` -- every subsequent update (the ones that actually matter, e.g. live
    // position while moving) omits both and carries only `id` (e.g. "cover/<name>") plus the
    // changed fields. Confirmed live against the real gateway: relying on `domain`/`name` here
    // meant every update after the first was silently dropped, forever. `id` is always present.
    if (typeof entity.id !== 'string') return;
    const slashIndex = entity.id.indexOf('/');
    if (slashIndex === -1) return;
    const domain = entity.id.slice(0, slashIndex);
    const name = entity.id.slice(slashIndex + 1);
    if (domain === 'cover' && name === this._entityName) {
      this._handleCoverState(entity);
    } else if (domain === 'binary_sensor' && name === this._rainSensorName) {
      this._handleRainState(entity);
    }
  }

  _handleCoverState(entity) {
    if (typeof entity.position === 'number') {
      this._safeSetCapabilityValue('windowcoverings_set', entity.position);
    }
    const operation = entity.current_operation;
    if (operation === 'OPENING') this._safeSetCapabilityValue('windowcoverings_state', 'up');
    else if (operation === 'CLOSING') this._safeSetCapabilityValue('windowcoverings_state', 'down');
    else if (operation === 'IDLE') this._safeSetCapabilityValue('windowcoverings_state', 'idle');

    // Only settle window_state once movement has actually stopped -- windowcoverings_state
    // already shows up/down while mid-motion, so there's nothing useful to derive before IDLE.
    if (operation === 'IDLE' && typeof entity.position === 'number') {
      if (entity.position === 0) {
        this._lastCommand = null; // reaching fully closed unambiguously isn't "venting"
        this._safeSetCapabilityValue('window_state', 'closed');
      } else if (this._lastCommand === 'venting') {
        this._safeSetCapabilityValue('window_state', 'venting');
      } else {
        this._safeSetCapabilityValue('window_state', 'open');
      }
    }
  }

  _handleRainState(entity) {
    if (typeof entity.value !== 'boolean') return; // defensive: malformed/unexpected frame
    this._safeSetCapabilityValue('alarm_rain', entity.value);
  }

  async _safeSetCapabilityValue(capabilityId, value) {
    try {
      await this.setCapabilityValue(capabilityId, value);
    } catch (err) {
      this.error(`setCapabilityValue(${capabilityId}, ${value}) failed:`, err);
    }
  }

}

module.exports = VeluxWindowDevice;
