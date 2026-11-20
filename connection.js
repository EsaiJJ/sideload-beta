/**
 * Sideload local bridge connection (Termux, ws://127.0.0.1:<port>).
 *
 * This module is intentionally independent of the WebUSB code in app.js.
 * The wire protocol is documented at the top of termux/bridge.py and must be
 * kept in sync with it.
 */

export const BRIDGE_STATES = Object.freeze({
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  ERROR: "error",
});

const DEFAULT_PORT = 8765;
const PORT_STORAGE_KEY = "sideload.bridge.port";
const MAX_RECONNECT_ATTEMPTS = 3;
const BINARY_CHUNK_DATA = 1;
const BINARY_CHUNK_END = 2;

export class BridgeError extends Error {
  constructor(message, code = "BRIDGE_ERROR") {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

function storedPort() {
  try {
    const value = Number(localStorage.getItem(PORT_STORAGE_KEY));
    return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

function normalisePort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new BridgeError("Enter a port between 1 and 65535.", "BAD_PORT");
  }
  return value;
}

/** Binary frame: [kind:1][part index:uint16 BE][bytes...] */
function binaryFrame(kind, index, data = new Uint8Array(0)) {
  const frame = new Uint8Array(3 + data.byteLength);
  frame[0] = kind;
  frame[1] = (index >> 8) & 0xff;
  frame[2] = index & 0xff;
  frame.set(data, 3);
  return frame;
}

export class BridgeConnection {
  constructor({ onStateChange, onLog, onProgress } = {}) {
    this.port = storedPort();
    this.state = BRIDGE_STATES.DISCONNECTED;
    this.ws = null;
    this.pending = new Map();
    this.sequence = 0;

    this.onStateChange = onStateChange || (() => {});
    this.onLog = onLog || (() => {});
    this.onProgress = onProgress || (() => {});

    this.autoReconnect = true;
    this.shouldReconnect = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.lastError = null;
  }

  /* --------------------------- state helpers --------------------------- */

  _setState(state, detail = "") {
    this.state = state;
    this.onStateChange(state, detail);
  }

  _log(message, level = "info") {
    this.onLog(message, level);
  }

  get isConnected() {
    return this.state === BRIDGE_STATES.CONNECTED && this.ws?.readyState === WebSocket.OPEN;
  }

  setPort(port) {
    this.port = normalisePort(port);
    try {
      localStorage.setItem(PORT_STORAGE_KEY, String(this.port));
    } catch {
      /* localStorage can be unavailable in private mode */
    }
    return this.port;
  }

  setAutoReconnect(enabled) {
    this.autoReconnect = Boolean(enabled);
    if (!this.autoReconnect) this._clearReconnectTimer();
  }

  _clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /* --------------------------- connect / close ------------------------- */

  connect({ port, preserveReconnect = false } = {}) {
    if (port !== undefined) this.setPort(port);
    if (this.state === BRIDGE_STATES.CONNECTED || this.state === BRIDGE_STATES.CONNECTING) {
      return Promise.resolve();
    }

    this._clearReconnectTimer();
    if (!preserveReconnect) this.shouldReconnect = false;
    this._setState(BRIDGE_STATES.CONNECTING);
    this.lastError = null;
    this._log(`Connecting to ws://127.0.0.1:${this.port}…`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error, result) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(result);
      };

      let socket;
      try {
        socket = new WebSocket(`ws://127.0.0.1:${this.port}`);
      } catch (error) {
        this._setState(BRIDGE_STATES.ERROR, error.message);
        settle(error);
        return;
      }
      this.ws = socket;

      // The bridge may send progress while we're waiting on the status reply.
      socket.addEventListener("message", (event) => this._handleMessage(event));

      socket.addEventListener("open", async () => {
        try {
          const response = await this._request("status", {}, 8000);
          if (!response.ok) {
            throw new BridgeError(response.error || "The bridge refused the status check.", response.code);
          }
          this.shouldReconnect = true;
          this.reconnectAttempts = 0;
          this._setState(BRIDGE_STATES.CONNECTED, response.data?.state || "");
          this._log(`Bridge connected (ADB: ${response.data?.state || "unknown"}).`, "success");
          settle(null, response);
        } catch (error) {
          this.lastError = error;
          this._setState(BRIDGE_STATES.ERROR, error.message);
          settle(error);
          this._teardownSocket();
        }
      });

      socket.addEventListener("error", () => {
        const error = new BridgeError(
          "Couldn't reach the bridge. Start start.sh in Termux and check the port.",
          "BRIDGE_UNREACHABLE",
        );
        this.lastError = error;
        this._setState(BRIDGE_STATES.ERROR, error.message);
        this._log(error.message, "error");
        settle(error);
      });

      socket.addEventListener("close", () => {
        if (!settled) {
          const error = new BridgeError("The bridge closed before connecting.", "BRIDGE_CLOSED");
          this.lastError = error;
          settle(error);
        }
        this._handleClose();
      });
    });
  }

  disconnect() {
    this.shouldReconnect = false;
    this._clearReconnectTimer();
    this._rejectPending(new BridgeError("Disconnected.", "DISCONNECTED"));
    this._teardownSocket();
    this._setState(BRIDGE_STATES.DISCONNECTED);
    this._log("Bridge disconnected.");
  }

  /** Cancel an active install by closing the socket (bridge cleans up in finally). */
  cancel() {
    this.disconnect();
  }

  _teardownSocket() {
    const socket = this.ws;
    this.ws = null;
    if (!socket) return;
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }

  _handleClose() {
    this._rejectPending(new BridgeError("Bridge connection closed.", "BRIDGE_CLOSED"));
    this.ws = null;
    if (this.state === BRIDGE_STATES.CONNECTED) {
      this._setState(BRIDGE_STATES.DISCONNECTED);
      this._log("Bridge connection lost.", "warn");
    } else if (this.state === BRIDGE_STATES.CONNECTING) {
      this._setState(BRIDGE_STATES.DISCONNECTED);
    }

    if (this.shouldReconnect && this.autoReconnect && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts += 1;
      const delay = 1200 * this.reconnectAttempts;
      this._log(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`, "warn");
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect({ preserveReconnect: true }).catch(() => {
          if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            this._log("Automatic reconnect stopped. Tap Connect to try again.", "error");
            this.shouldReconnect = false;
          }
        });
      }, delay);
    }
  }

  reconnect() {
    this.disconnect();
    return this.connect();
  }

  /* --------------------------- message plumbing ------------------------ */

  _request(type, payload = {}, timeout = 30000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BridgeError("The bridge isn't connected.", "NOT_CONNECTED"));
    }
    const id = `c-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("The bridge didn't answer in time.", "TIMEOUT"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, type, ...payload }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _rejectPending(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  _handleMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      this._log("Bridge sent an unreadable message.", "warn");
      return;
    }

    if (message.type === "progress") {
      this.onProgress(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.ok === false) {
      pending.reject(new BridgeError(message.error || "The bridge command failed.", message.code));
    } else {
      pending.resolve(message);
    }
  }

  _sendBinary(frame) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new BridgeError("The bridge connection closed during upload.", "NOT_CONNECTED");
    }
    this.ws.send(frame);
  }

  /* ------------------------------ commands ----------------------------- */

  async pair({ port, code }) {
    const response = await this._request("pair", { port: normalisePort(port), code: String(code || "") }, 90000);
    if (!response.ok) throw new BridgeError(response.error, response.code);
    return response;
  }

  async adbConnect({ port }) {
    const response = await this._request("connect", { port: normalisePort(port) }, 60000);
    if (!response.ok) throw new BridgeError(response.error, response.code);
    return response;
  }

  async status() {
    const response = await this._request("status", {}, 20000);
    if (!response.ok) throw new BridgeError(response.error, response.code);
    return response;
  }

  async info() {
    const response = await this._request("info", {}, 30000);
    if (!response.ok) throw new BridgeError(response.error, response.code);
    return response;
  }

  async reboot() {
    const response = await this._request("reboot", {}, 30000);
    if (!response.ok) throw new BridgeError(response.error, response.code);
    return response;
  }

  /**
   * Upload app parts and let the bridge install them.
   * parts: [{ name, size, bytes?: Uint8Array, file?: File }]
   */
  async install({ parts, mode = "single", onProgress, timeout = 10 * 60 * 1000 }) {
    if (!this.isConnected) throw new BridgeError("The bridge isn't connected.", "NOT_CONNECTED");
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new BridgeError("There is no app file to install.", "NO_FILE");
    }
    if (onProgress) this.onProgress = onProgress;

    const announcements = parts.map((part) => ({ name: part.name, size: part.size }));
    const total = announcements.reduce((sum, part) => sum + part.size, 0);
    const responsePromise = this._request("install", { mode, size: total, parts: announcements }, timeout);

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part.bytes) {
        const CHUNK = 64 * 1024;
        for (let offset = 0; offset < part.bytes.byteLength; offset += CHUNK) {
          const slice = part.bytes.subarray(offset, Math.min(offset + CHUNK, part.bytes.byteLength));
          this._sendBinary(binaryFrame(BINARY_CHUNK_DATA, index, slice));
        }
      } else if (part.file) {
        const reader = part.file.stream().getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            this._sendBinary(binaryFrame(BINARY_CHUNK_DATA, index, value));
          }
        } finally {
          reader.releaseLock();
        }
      } else {
        throw new BridgeError(`Part ${index + 1} has no data.`, "NO_FILE");
      }
      this._sendBinary(binaryFrame(BINARY_CHUNK_END, index));
    }

    const response = await responsePromise;
    if (!response.ok) throw new BridgeError(response.error || "Install failed.", response.code);
    return response;
  }
}

export function createBridgeConnection(options) {
  return new BridgeConnection(options);
}

export default BridgeConnection;
