'use strict';

const Homey = require('homey');

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
 * that they share one sensor.
 */
class VeluxWindowDevice extends Homey.Device {

  async onInit() {
    this._entityName = this.getData().id;
    this._rainSensorName = `${this._entityName} Rain sensor`;
    this._ventilationButtonName = `${this._entityName} Ventilation Position`;
    this._rainKnown = false; // true once a real binary_sensor reply has ever been seen
    this._gatewayAcquired = false;

    // Unknown/stale until a real reply proves otherwise -- never default alarm_rain itself,
    // Homey already persists its last confirmed value across app/device restarts, which is
    // exactly the "keep the last confirmed value" behaviour this needs.
    await this._safeSetCapabilityValue('alarm_rain_stale', true);

    this.registerCapabilityListener('windowcoverings_state', (value) => this._onSetState(value));
    this.registerCapabilityListener('windowcoverings_set', (value) => this._onSetPosition(value));
    this.registerCapabilityListener('button.ventilation', () => this._onPressVentilation());

    await this._connectGateway(this.getSetting('address'));

    this.log(`VeluxWindowDevice "${this._entityName}" initialized (gateway: ${this._address})`);
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
    await this._gateway.openCover(this._entityName);
  }

  async closeWindow() {
    await this._gateway.closeCover(this._entityName);
  }

  async stopWindow() {
    await this._gateway.stopCover(this._entityName);
  }

  // --- Capability listeners (Homey -> device) ---------------------------------------------

  async _onSetState(value) {
    if (value === 'up') return this._gateway.openCover(this._entityName);
    if (value === 'down') return this._gateway.closeCover(this._entityName);
    return this._gateway.stopCover(this._entityName);
  }

  async _onSetPosition(value) {
    // `value` is already a 0.0-1.0 fraction (windowcoverings_set's own range) -- the same
    // scale the firmware's /cover/<name>/set?position= endpoint expects, verified live.
    await this._gateway.setCoverPosition(this._entityName, value);
  }

  async _onPressVentilation() {
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
      // The connection itself is gone, so any rain reading we're still showing can no longer
      // be trusted as current -- mark it stale without touching alarm_rain's own last
      // confirmed value (never fabricate a "no rain" default on disconnect).
      this._safeSetCapabilityValue('alarm_rain_stale', true);
    }
    this._safeSetCapabilityValue('alarm_connectivity', !connected);
  }

  _handleState(entity) {
    if (entity.domain === 'cover' && entity.name === this._entityName) {
      this._handleCoverState(entity);
    } else if (entity.domain === 'binary_sensor' && entity.name === this._rainSensorName) {
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
  }

  _handleRainState(entity) {
    if (typeof entity.value !== 'boolean') return; // defensive: malformed/unexpected frame
    this._rainKnown = true;
    this._safeSetCapabilityValue('alarm_rain', entity.value);
    // A real reply just arrived over a connection we know is live -- the reading is current.
    this._safeSetCapabilityValue('alarm_rain_stale', false);
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
