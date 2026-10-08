'use strict';

const Homey = require('homey');
const Gateway = require('../../lib/Gateway');

/**
 * Owns the shared per-gateway-address connections (see lib/Gateway.js) so that deleting one
 * window's Homey device never tears down another window's SSE connection on the same
 * gateway -- Device instances acquire()/release() the Gateway they need by address; the
 * Gateway itself only disconnects once nothing references it anymore.
 *
 * Also registers the hand-written custom flow cards (open/close/stop, position_above/below).
 * Everything else (position changed, rain detected/cleared, reachability changed, set
 * position, set state, press ventilation button) comes for free from the standard
 * `windowcoverings_set`/`windowcoverings_state`/`alarm_rain`/`alarm_connectivity`/`button`
 * capabilities' own built-in $flow definitions -- no registerRunListener needed for those;
 * Homey wires them automatically to registerCapabilityListener / setCapabilityValue.
 */
class VeluxWindowDriver extends Homey.Driver {

  async onInit() {
    /** @type {Map<string, Gateway>} gateway address -> shared Gateway instance */
    this._gateways = new Map();

    this.homey.flow.getActionCard('open')
      .registerRunListener(async (args) => args.device.openWindow());
    this.homey.flow.getActionCard('close')
      .registerRunListener(async (args) => args.device.closeWindow());
    this.homey.flow.getActionCard('stop')
      .registerRunListener(async (args) => args.device.stopWindow());

    this.homey.flow.getConditionCard('position_above')
      .registerRunListener(async (args) => {
        const position = args.device.getCapabilityValue('windowcoverings_set');
        return typeof position === 'number' && position * 100 > args.percentage;
      });
    this.homey.flow.getConditionCard('position_below')
      .registerRunListener(async (args) => {
        const position = args.device.getCapabilityValue('windowcoverings_set');
        return typeof position === 'number' && position * 100 < args.percentage;
      });

    this.log('VeluxWindowDriver initialized');
  }

  /**
   * Get (or lazily create) the shared Gateway for one address. Does NOT acquire() it --
   * callers are responsible for acquire() in onInit() and release() in onUninit()/onDeleted()
   * so the reference count (and therefore the shared SSE connection's lifetime) stays correct.
   */
  getGateway(address) {
    let gateway = this._gateways.get(address);
    if (!gateway) {
      gateway = new Gateway({ address, log: (...args) => this.log('[Gateway]', ...args) });
      this._gateways.set(address, gateway);
    }
    return gateway;
  }

  async onPair(session) {
    let testedAddress = null;

    session.setHandler('test_connection', async ({ address }) => {
      if (!address || !address.trim()) {
        return { success: false, error: 'Enter an address.' };
      }
      try {
        const covers = await Gateway.discoverCovers(address.trim(), { timeoutMs: 4000 });
        testedAddress = address.trim();
        if (covers.length === 0) {
          return {
            success: false,
            error: 'Gateway reachable, but no cover (window) entities were found on it.',
          };
        }
        return { success: true, count: covers.length };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    session.setHandler('list_devices', async () => {
      if (!testedAddress) {
        throw new Error('No gateway address confirmed yet.');
      }

      // Re-discover fresh here rather than trusting the connection_test result, in case the
      // user paused a long time on that screen before continuing.
      const covers = await Gateway.discoverCovers(testedAddress, { timeoutMs: 4000 });

      // Duplicate prevention: this device's stable identity (see device.js) is the firmware
      // entity name alone, so a window already added under this or any other gateway address
      // is simply skipped from the list.
      const existingIds = this.getDevices().map((device) => device.getData().id);

      return covers
        .filter((cover) => !existingIds.includes(cover.name))
        .map((cover) => ({
          name: cover.name,
          data: { id: cover.name },
          settings: { address: testedAddress, entityName: cover.name },
        }));
    });
  }

  async onRepair(session, device) {
    session.setHandler('test_connection', async ({ address }) => {
      const trimmed = (address || '').trim();
      if (!trimmed) {
        return { success: false, error: 'Enter an address.' };
      }
      try {
        const covers = await Gateway.discoverCovers(trimmed, { timeoutMs: 4000 });
        const entityName = device.getData().id;
        const stillThere = covers.some((cover) => cover.name === entityName);
        if (!stillThere) {
          return {
            success: false,
            error: `Gateway reachable, but no window named "${entityName}" was found there. `
              + 'Check the firmware\'s cover name, or this may be the wrong gateway.',
          };
        }
        // settings is the single source of truth for the gateway address (see device.js's
        // class doc) -- no store write here, so there's nothing to drift out of sync.
        await device.setSettings({ address: trimmed });
        device.reconnectGateway();
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });
  }

}

module.exports = VeluxWindowDriver;
