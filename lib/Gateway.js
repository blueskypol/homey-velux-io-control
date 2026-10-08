'use strict';

const http = require('http');
const EventSource = require('eventsource');

// The gateway's own SSE heartbeat (`event: ping`) arrives roughly every 30s (ESPHome
// web_server's own interval, confirmed against a running hioc-velux-hub.local). Three missed
// heartbeats is a genuine lost connection, not a slow/late single packet.
const STALE_AFTER_MS = 90000;
const STALE_CHECK_INTERVAL_MS = 10000;

// The `eventsource` package has its own internal retry, but it proved unreliable over hours on
// a long-running Homey Pro process (observed: a gateway that stayed genuinely reachable the
// whole time, yet its SSE connection never recovered on its own). This wrapper adds a backstop:
// on error, it waits `_reconnectDelay`, then only tears down and recreates the EventSource if
// still disconnected at that point -- `onopen`/`_markAlive()` cancel the pending teardown the
// moment the package's own retry (or this wrapper's own) succeeds, so a connection that heals
// itself quickly is left alone rather than being killed and restarted anyway.
const RECONNECT_BASE_DELAY_MS = 5000;
const RECONNECT_MAX_DELAY_MS = 60000;

/**
 * One shared REST + SSE connection to a single home_io_control gateway (ESPHome
 * web_server:, port 80). Reference-counted: multiple Device instances on the same gateway
 * address share one Gateway, so removing one window's Homey device never breaks the others --
 * the underlying SSE connection only closes once the last device referencing it is gone.
 */
class Gateway {
  constructor({ address, log }) {
    this.address = address;
    this.log = log || (() => {});
    this._refCount = 0;
    this._stateListeners = new Set();
    this._connectionListeners = new Set();
    this._es = null;
    this._lastEventAt = 0;
    this._staleTimer = null;
    this._connected = false;
    this._reconnectTimer = null;
    this._reconnectDelay = RECONNECT_BASE_DELAY_MS;
    this._stopped = true; // true once release()d to refcount 0 -- reconnects must not fire after that
    // Reused across REST calls so a burst of commands (e.g. a slider drag) doesn't open a flurry
    // of brand-new TCP connections alongside the already-open SSE stream -- the gateway is a
    // resource-constrained ESP32 whose httpd has previously shown issues with concurrent
    // connections (see the firmware's own single-server history), so capping and reusing
    // sockets here is a precaution, not just an optimization.
    this._restAgent = new http.Agent({ keepAlive: true, maxSockets: 2 });
  }

  get baseUrl() {
    return `http://${this.address}`;
  }

  isConnected() {
    return this._connected;
  }

  /** Call once per Device that wants this gateway's events; opens the SSE connection on the first caller. */
  acquire() {
    this._refCount += 1;
    if (this._refCount === 1) this._connect();
    return this;
  }

  /** Call once per Device being removed/uninitialized; only actually disconnects at refcount 0. */
  release() {
    this._refCount = Math.max(0, this._refCount - 1);
    if (this._refCount === 0) this._disconnect();
  }

  /** @param {(entity: {id: string, domain: string, name: string, [key: string]: unknown}) => void} cb */
  onState(cb) {
    this._stateListeners.add(cb);
    return () => this._stateListeners.delete(cb);
  }

  /** @param {(connected: boolean) => void} cb */
  onConnectionChange(cb) {
    this._connectionListeners.add(cb);
    return () => this._connectionListeners.delete(cb);
  }

  _connect() {
    this._stopped = false;
    this.log(`Gateway[${this.address}] connecting`);
    this._es = new EventSource(`${this.baseUrl}/events`);
    this._es.addEventListener('ping', () => this._markAlive());
    this._es.addEventListener('state', (ev) => {
      this._markAlive();
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch (err) {
        return;
      }
      for (const cb of this._stateListeners) {
        try {
          cb(data);
        } catch (err) {
          this.log(`Gateway[${this.address}] state listener error:`, err);
        }
      }
    });
    this._es.onopen = () => {
      // A fresh connection -- including one the `eventsource` package silently recovered on its
      // own -- earns back the short retry delay and cancels any pending explicit teardown below.
      this._reconnectDelay = RECONNECT_BASE_DELAY_MS;
      this._cancelReconnect();
    };
    this._es.onerror = () => {
      this.log(`Gateway[${this.address}] SSE connection error`);
      this._setConnected(false);
      this._scheduleReconnect();
    };
    this._staleTimer = setInterval(() => this._checkStale(), STALE_CHECK_INTERVAL_MS);
  }

  /**
   * Explicitly tear down and recreate the EventSource -- see the RECONNECT_* comment above for
   * why. Waits `_reconnectDelay` first and re-checks `_connected`: the `eventsource` package
   * often recovers a dropped connection on its own within a second or two (it has its own
   * internal retry), and `_markAlive()`/`onopen` cancel this timer the moment that happens --
   * so by the time this fires, it only still runs for a connection that's genuinely still down.
   * (An earlier version always tore down and recreated after the delay regardless, which fought
   * the package's own successful retries and produced a connect/disconnect loop in practice.)
   */
  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;
    const delay = this._reconnectDelay;
    this.log(`Gateway[${this.address}] reconnecting in ${delay}ms`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._stopped || this._connected) return;
      if (this._es) {
        this._es.close();
        this._es = null;
      }
      if (this._staleTimer) {
        clearInterval(this._staleTimer);
        this._staleTimer = null;
      }
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
      this._connect();
    }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }

  _cancelReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _disconnect() {
    this.log(`Gateway[${this.address}] disconnecting (no devices left)`);
    this._stopped = true;
    this._cancelReconnect();
    this._reconnectDelay = RECONNECT_BASE_DELAY_MS;
    if (this._es) {
      this._es.close();
      this._es = null;
    }
    if (this._staleTimer) {
      clearInterval(this._staleTimer);
      this._staleTimer = null;
    }
    this._restAgent.destroy();
    this._setConnected(false);
  }

  _markAlive() {
    this._lastEventAt = Date.now();
    this._setConnected(true);
    this._cancelReconnect();
  }

  _checkStale() {
    if (this._connected && Date.now() - this._lastEventAt > STALE_AFTER_MS) {
      this.log(`Gateway[${this.address}] no events for >${STALE_AFTER_MS}ms, marking disconnected`);
      this._setConnected(false);
      // A connection that's gone quiet without the EventSource itself ever firing `onerror`
      // (observed on the real Homey Pro) would otherwise sit stale forever -- force a reconnect.
      this._scheduleReconnect();
    }
  }

  _setConnected(value) {
    if (this._connected === value) return;
    this._connected = value;
    for (const cb of this._connectionListeners) {
      try {
        cb(value);
      } catch (err) {
        this.log(`Gateway[${this.address}] connection listener error:`, err);
      }
    }
  }

  // --- REST calls, built on Node's own http module (no fetch/undici version assumptions
  // about Homey's runtime) ------------------------------------------------------------

  _request(method, path) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${this.baseUrl}${path}`,
        { method, timeout: 8000, agent: this._restAgent },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(body);
            } else {
              reject(new Error(`HTTP ${res.statusCode} for ${method} ${path}`));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Timed out calling ${method} ${path}`)));
      req.on('error', reject);
      req.end();
    });
  }

  async _getJson(path) {
    const body = await this._request('GET', path);
    return JSON.parse(body);
  }

  async getCover(name) {
    return this._getJson(`/cover/${encodeURIComponent(name)}`);
  }

  async getBinarySensor(name) {
    return this._getJson(`/binary_sensor/${encodeURIComponent(name)}`);
  }

  async openCover(name) {
    return this._request('POST', `/cover/${encodeURIComponent(name)}/open`);
  }

  async closeCover(name) {
    return this._request('POST', `/cover/${encodeURIComponent(name)}/close`);
  }

  async stopCover(name) {
    return this._request('POST', `/cover/${encodeURIComponent(name)}/stop`);
  }

  /** @param {string} name @param {number} fraction 0.0 (closed) - 1.0 (open) */
  async setCoverPosition(name, fraction) {
    const clamped = Math.max(0, Math.min(1, fraction));
    return this._request('POST', `/cover/${encodeURIComponent(name)}/set?position=${clamped}`);
  }

  async pressButton(name) {
    return this._request('POST', `/button/${encodeURIComponent(name)}/press`);
  }

  /**
   * Discover every "cover" entity this gateway exposes, by briefly connecting to /events and
   * collecting the initial state burst every ESPHome web_server SSE client receives on
   * connect. `GET /cover` (domain-only listing) returns an empty body on this firmware
   * (verified against a running hioc-velux-hub.local, ESPHome 2026.9.1) -- the SSE burst is
   * the only reliable generic discovery mechanism this REST/SSE API offers.
   * @returns {Promise<Array<{name: string, position: number, state: string}>>}
   */
  static async discoverCovers(address, { timeoutMs = 4000 } = {}) {
    return new Promise((resolve, reject) => {
      const found = new Map();
      let settled = false;
      let es;

      const timer = setTimeout(() => finish(), timeoutMs);

      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (es) es.close();
        if (err) reject(err);
        else resolve(Array.from(found.values()));
      };

      try {
        es = new EventSource(`http://${address}/events`);
      } catch (err) {
        finish(err);
        return;
      }

      es.addEventListener('state', (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.domain === 'cover' && data.name) {
            found.set(data.name, { name: data.name, position: data.position, state: data.state });
          }
        } catch (err) {
          // malformed frame, ignore
        }
      });

      es.onerror = () => {
        // A connection that never opened at all is a real failure. One that opened and then
        // dropped mid-burst still resolves with whatever covers were found before the timeout.
        if (found.size === 0) finish(new Error('unreachable'));
      };
    });
  }
}

module.exports = Gateway;
