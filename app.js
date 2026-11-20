/**
 * Sideload — 100% static APK installer (WebUSB + local Termux bridge).
 *
 * No backend, no build step: ADB comes from esm.sh via the import map in
 * index.html, JSZip unpacks split bundles in memory, and the RSA key used for
 * WebUSB ADB authentication is stored by @yume-chan/adb-credential-web in
 * IndexedDB. The Termux bridge is a local WebSocket on the same phone.
 *
 * To promote the beta to production, set BETA = false below (or remove the
 * badge from index.html) and add the CNAME file described in README.md.
 */

import { BRIDGE_STATES, createBridgeConnection } from "./connection.js";

const BETA = true;

const $ = (id) => document.getElementById(id);

const els = {
  betaBadge: $("beta-badge"),

  browserBanner: $("browser-banner"),
  browserBannerTitle: $("browser-banner-title"),
  browserBannerText: $("browser-banner-text"),

  deviceIconUse: $("device-icon-use"),
  deviceSubtitle: $("device-subtitle"),
  deviceChip: $("device-chip"),
  deviceChipText: $("device-chip-text"),
  connectedPanel: $("connected-panel"),
  deviceName: $("device-name"),
  deviceMeta: $("device-meta"),
  deviceSerial: $("device-serial"),
  deviceHint: $("device-hint"),
  connectBtn: $("connect-btn"),
  connectBtnLabel: $("connect-btn-label"),
  connectSpinner: $("connect-spinner"),
  disconnectBtn: $("disconnect-btn"),
  deviceExtra: $("device-extra"),
  infoBtn: $("info-btn"),
  restartBtn: $("restart-btn"),
  resetBtn: $("reset-btn"),

  modeUsbBtn: $("mode-usb-btn"),
  modeBridgeBtn: $("mode-bridge-btn"),
  usbPanel: $("usb-panel"),
  bridgePanel: $("bridge-panel"),
  bridgeChip: $("bridge-chip"),
  bridgeChipText: $("bridge-chip-text"),
  bridgeAddress: $("bridge-address"),
  bridgePort: $("bridge-port"),
  bridgeConnectBtn: $("bridge-connect-btn"),
  bridgeDisconnectBtn: $("bridge-disconnect-btn"),
  bridgeReconnectBtn: $("bridge-reconnect-btn"),
  bridgeSpinner: $("bridge-spinner"),
  bridgePairDetails: $("bridge-pair-details"),
  pairPort: $("pair-port"),
  pairCode: $("pair-code"),
  adbPort: $("adb-port"),
  bridgePairBtn: $("bridge-pair-btn"),
  bridgeAdbConnectBtn: $("bridge-adb-connect-btn"),

  dropzone: $("dropzone"),
  fileInput: $("file-input"),
  dropzoneEmpty: $("dropzone-empty"),
  fileRow: $("file-row"),
  fileName: $("file-name"),
  fileSize: $("file-size"),
  fileKind: $("file-kind"),
  removeFileBtn: $("remove-file-btn"),

  installChip: $("install-chip"),
  installChipText: $("install-chip-text"),
  progressPanel: $("progress-panel"),
  progressTitle: $("progress-title"),
  progressPercent: $("progress-percent"),
  progressTrack: $("progress-track"),
  progressFill: $("progress-fill"),
  progressDetail: $("progress-detail"),
  installBtn: $("install-btn"),
  installSpinner: $("install-spinner"),
  cancelBtn: $("cancel-btn"),
  logDrawer: $("log-drawer"),
  logOutput: $("log-output"),
  copyLogBtn: $("copy-log-btn"),

  snackbar: $("snackbar"),
  infoDialog: $("info-dialog"),
  infoList: $("info-list"),
  restartDialog: $("restart-dialog"),
  restartConfirmBtn: $("restart-confirm-btn"),
};

const TEMP_APK = "/data/local/tmp/mystic_install.apk";
const CREDENTIAL_DB = "Tango"; // database used by @yume-chan/adb-credential-web@2.x
const SUPPORTED_EXTENSIONS = /\.(apk|xapk|apkm|zip)$/i;

const state = {
  mode: "usb", // "usb" | "bridge"
  adb: null,
  transport: null,
  device: null,
  credentialStore: null,
  deviceInfo: null,
  selectedFile: null,
  busy: false,
  usbSupported: false,
  libsFailed: false,
  abortController: null,
  bridge: null,
  bridgeDeviceReady: false,
  bridgeCancelled: false,
};

let libsPromise = null;
let snackbarTimer = null;

/* -------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* -------------------------------------------------------------------------- */

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function friendlyError(error) {
  const message = String(error?.message ?? error ?? "Unknown error");
  if (/unauthor|reject|denied/i.test(message)) {
    return "The phone didn't approve the connection. Tap Reset authorization and try again.";
  }
  if (/busy|claim interface/i.test(message)) {
    return "Another program is using the phone. Close other ADB tools or tabs and try again.";
  }
  if (/notfound|no device selected/i.test(message)) {
    return "No device was selected.";
  }
  if (/failed to fetch|dynamically imported|networkerror|cdn/i.test(message)) {
    return "Couldn't load the ADB libraries. Check your connection and reload the page.";
  }
  return message;
}

function log(message, level = "info") {
  els.logOutput.querySelector(".log-empty")?.remove();
  const line = document.createElement("div");
  line.className = `log-line ${level}`;
  const time = new Date().toLocaleTimeString([], { hour12: false });
  line.textContent = `[${time}] ${message}`;
  els.logOutput.appendChild(line);
  while (els.logOutput.childElementCount > 400) {
    els.logOutput.removeChild(els.logOutput.firstChild);
  }
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}

function snackbar(message, type = "info") {
  clearTimeout(snackbarTimer);
  els.snackbar.textContent = message;
  els.snackbar.className = `snackbar show ${type}`;
  snackbarTimer = setTimeout(() => {
    els.snackbar.className = "snackbar";
  }, 4800);
}

function setDeviceStatus(stateName, text) {
  els.deviceChip.dataset.state = stateName;
  els.deviceChipText.textContent = text;
}

function setBridgeStatus(stateName, text) {
  els.bridgeChip.dataset.state = stateName;
  els.bridgeChipText.textContent = text;
}

function setInstallStatus(stateName, text) {
  els.installChip.dataset.state = stateName;
  els.installChipText.textContent = text;
}

function setProgress(fraction, title, detail = "") {
  const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  els.progressPanel.hidden = false;
  els.progressTitle.textContent = title;
  els.progressPercent.textContent = `${percent}%`;
  els.progressFill.style.width = `${percent}%`;
  els.progressTrack.setAttribute("aria-valuenow", String(percent));
  els.progressDetail.textContent = detail;
}

function isDeviceConnected() {
  if (state.mode === "bridge") {
    return Boolean(state.bridge?.isConnected) && state.bridgeDeviceReady;
  }
  return Boolean(state.adb);
}

function updateBridgeAddress() {
  const port = state.bridge?.port || els.bridgePort.value || 8765;
  els.bridgeAddress.textContent = `ws://127.0.0.1:${port}`;
}

function updateModeUI() {
  const usbMode = state.mode === "usb";
  els.usbPanel.hidden = !usbMode;
  els.bridgePanel.hidden = usbMode;
  els.modeUsbBtn.classList.toggle("active", usbMode);
  els.modeBridgeBtn.classList.toggle("active", !usbMode);
  els.modeUsbBtn.setAttribute("aria-pressed", String(usbMode));
  els.modeBridgeBtn.setAttribute("aria-pressed", String(!usbMode));
  els.deviceIconUse.setAttribute("href", usbMode ? "#ic-usb" : "#ic-terminal");
  els.deviceSubtitle.textContent = usbMode
    ? "Connect over USB/OTG, or use Termux on this phone"
    : "Connect to the local bridge running in Termux on this phone";
  updateBridgeAddress();
}

function refreshButtons() {
  const usbMode = state.mode === "usb";
  const bridgeConnected = !usbMode && Boolean(state.bridge?.isConnected);
  const deviceReady = usbMode ? Boolean(state.adb) : bridgeConnected && state.bridgeDeviceReady;
  const pairable = bridgeConnected && !state.busy;

  els.connectBtn.disabled = !state.usbSupported || deviceReady || state.busy;
  els.connectBtnLabel.textContent = deviceReady ? "Connected" : "Connect USB device";
  els.connectSpinner.hidden = !(usbMode && state.busy && !deviceReady);
  els.disconnectBtn.hidden = !deviceReady || state.busy;

  els.bridgeConnectBtn.disabled = bridgeConnected || state.busy;
  els.bridgeDisconnectBtn.hidden = !bridgeConnected || state.busy;
  els.bridgeReconnectBtn.hidden = !bridgeConnected || state.busy;
  els.bridgeSpinner.hidden = !(!usbMode && state.busy && !bridgeConnected);
  els.bridgePort.disabled = !usbMode && (bridgeConnected || state.busy);
  els.pairPort.disabled = !pairable;
  els.pairCode.disabled = !pairable;
  els.adbPort.disabled = !pairable;
  els.bridgePairBtn.disabled = !pairable;
  els.bridgeAdbConnectBtn.disabled = !pairable;

  els.installSpinner.hidden = !(state.busy && deviceReady);
  els.installBtn.disabled = !deviceReady || !state.selectedFile || state.busy;
  els.cancelBtn.hidden = !(state.busy && deviceReady);
  els.resetBtn.disabled = state.busy;
  els.deviceExtra.hidden = !deviceReady || state.busy;
}

async function setMode(mode) {
  if ((mode !== "usb" && mode !== "bridge") || mode === state.mode) return;
  if (state.busy) {
    snackbar("Wait for the current task to finish before switching modes.");
    return;
  }

  if (state.mode === "usb") {
    if (state.adb) await disconnectDevice();
  } else if (state.bridge) {
    state.bridge.disconnect();
    state.bridgeDeviceReady = false;
    state.deviceInfo = null;
    els.connectedPanel.hidden = true;
    setDeviceStatus("idle", "Not connected");
    setInstallStatus("idle", "Ready");
  }

  state.mode = mode;
  updateModeUI();
  updateBrowserBanner();
  refreshButtons();
  log(mode === "usb" ? "Switched to USB / OTG mode." : "Switched to Termux bridge mode.");
}

/* -------------------------------------------------------------------------- */
/* CDN modules                                                                */
/* -------------------------------------------------------------------------- */

function loadLibraries() {
  return Promise.all([
    import("@yume-chan/adb"),
    import("@yume-chan/adb-daemon-webusb"),
    import("@yume-chan/adb-credential-web"),
    import("jszip"),
  ]).then(([adb, webusb, credential, jszip]) => ({
    adb,
    webusb,
    credential,
    JSZip: jszip.default || jszip.JSZip || jszip,
  }));
}

/* -------------------------------------------------------------------------- */
/* WebUSB connection                                                          */
/* -------------------------------------------------------------------------- */

function updateBrowserBanner() {
  if (state.libsFailed) {
    els.browserBanner.hidden = false;
    els.browserBannerTitle.textContent = "Couldn't load the app libraries";
    els.browserBannerText.textContent =
      "The ADB libraries are loaded from a CDN. Check your internet connection and reload this page.";
    return;
  }

  if (state.mode === "bridge" || state.usbSupported) {
    els.browserBanner.hidden = true;
    return;
  }

  els.browserBanner.hidden = false;
  if (!window.isSecureContext) {
    els.browserBannerTitle.textContent = "This page needs a secure connection";
    els.browserBannerText.textContent =
      "WebUSB only works over HTTPS or localhost. The Termux bridge mode also works here — choose it above, or use the GitHub Pages beta URL for USB.";
  } else {
    els.browserBannerTitle.textContent = "This browser doesn't support WebUSB";
    els.browserBannerText.textContent =
      "Use Chrome, Edge or Brave for USB/OTG. You can also choose “This phone (Termux)” above and keep everything on this phone.";
  }
}

function checkBrowser() {
  state.usbSupported = Boolean(navigator.usb) && window.isSecureContext === true;

  if (!state.usbSupported && state.mode === "usb") {
    log("WebUSB unavailable in this browser/context.", "warn");
  }
  updateBrowserBanner();
  refreshButtons();
}

async function connectDevice() {
  if (state.mode !== "usb" || state.busy || state.adb) return;

  state.busy = true;
  setDeviceStatus("connecting", "Connecting…");
  els.deviceHint.textContent = "Choose your phone in the browser list, then approve the prompt on the phone.";
  refreshButtons();

  try {
    const libs = await libsPromise;
    const Manager = libs.webusb.AdbDaemonWebUsbDeviceManager.BROWSER;
    if (!Manager) throw new Error("WebUSB is not available in this browser.");

    log("Opening device picker…");
    // Must happen inside the click's user activation, so it is the first await
    // after the (already cached) library promise.
    const device = await Manager.requestDevice();
    if (!device) {
      setDeviceStatus("idle", "Not connected");
      snackbar("No device selected.");
      log("Device picker was cancelled.");
      return;
    }

    state.device = device;
    log(`Selected: ${device.name || "Android device"}`);
    setDeviceStatus("connecting", "Authenticating…");

    let connection;
    try {
      connection = await device.connect();
    } catch (error) {
      if (error?.name === "DeviceBusyError" || error instanceof libs.webusb.AdbDaemonWebUsbDevice.DeviceBusyError) {
        throw new Error("The phone is already in use by another program. Close other ADB tools and tabs, then try again.");
      }
      throw error;
    }

    state.credentialStore = new libs.credential.default("Sideload");
    log("Authenticating with the phone (approve the prompt if shown)…");

    const transport = await libs.adb.AdbDaemonTransport.authenticate({
      serial: device.serial || "android-device",
      connection,
      credentialStore: state.credentialStore,
    });
    const adb = new libs.adb.Adb(transport);
    state.adb = adb;
    state.transport = transport;

    device.raw?.addEventListener?.("disconnect", handleUsbDisconnect, { once: true });
    transport.disconnected.then(handleUsbDisconnect).catch(() => {});

    await loadDeviceInfo(adb, device);

    setDeviceStatus("connected", "Connected");
    els.deviceHint.textContent = "Connected and ready. Choose an app file to install.";
    log("Device connected and authenticated.", "success");
    snackbar("Phone connected. You're ready to install.", "success");
  } catch (error) {
    log(`Connection failed: ${friendlyError(error)}`, "error");
    setDeviceStatus("error", "Connection failed");
    snackbar(friendlyError(error), "error");
    await cleanupConnection();
    setDeviceStatus("idle", "Not connected");
  } finally {
    state.busy = false;
    refreshButtons();
  }
}

async function loadDeviceInfo(adb, device) {
  const get = async (key) => {
    try {
      return (await adb.getProp(key)).trim();
    } catch {
      return "";
    }
  };

  const [model, manufacturer, version, sdk, product, board] = await Promise.all([
    get("ro.product.model"),
    get("ro.product.manufacturer"),
    get("ro.build.version.release"),
    get("ro.build.version.sdk"),
    get("ro.product.name"),
    get("ro.board.platform"),
  ]);

  state.deviceInfo = { model, manufacturer, version, sdk, product, board, serial: device.serial || "" };
  renderDeviceInfo(state.deviceInfo, device.name);
}

function renderDeviceInfo(info, fallbackName = "Android device") {
  els.deviceName.textContent = info.model || fallbackName || "Android device";
  els.deviceMeta.textContent = info.version
    ? `Android ${info.version}${info.sdk ? ` · API ${info.sdk}` : ""}`
    : "Android device";
  els.deviceSerial.textContent = info.serial
    ? `Serial ${info.serial.slice(0, 4)}••••${info.serial.slice(-4)}`
    : "";
  els.connectedPanel.hidden = false;

  log(`Device: ${[info.manufacturer, info.model].filter(Boolean).join(" ") || "Android"} · Android ${info.version || "?"} (API ${info.sdk || "?"})`);
}

/* -------------------------------------------------------------------------- */
/* Termux bridge connection                                                   */
/* -------------------------------------------------------------------------- */

function handleBridgeStateChange(bridgeState) {
  if (state.mode !== "bridge") return;

  if (bridgeState === BRIDGE_STATES.CONNECTED) {
    setBridgeStatus("connected", "Bridge connected");
    setDeviceStatus(state.bridgeDeviceReady ? "connected" : "idle",
      state.bridgeDeviceReady ? "Connected" : "Connect ADB");
    // A silent automatic reconnect needs its ADB state refreshed; a manual
    // connectBridge() call already does this while `busy` is true.
    if (!state.busy && !state.bridgeDeviceReady) {
      void refreshBridgeDeviceState().catch((error) => {
        log(`Bridge status refresh failed: ${friendlyError(error)}`, "warn");
      });
    }
  } else if (bridgeState === BRIDGE_STATES.CONNECTING) {
    setBridgeStatus("connecting", "Connecting…");
    setDeviceStatus("connecting", "Connecting…");
  } else if (bridgeState === BRIDGE_STATES.ERROR) {
    setBridgeStatus("error", "Bridge error");
    setDeviceStatus("error", "Bridge error");
  } else {
    state.bridgeDeviceReady = false;
    state.deviceInfo = null;
    els.connectedPanel.hidden = true;
    setBridgeStatus("idle", "Bridge not connected");
    setDeviceStatus("idle", "Not connected");
  }
  refreshButtons();
}

function handleBridgeProgress(message) {
  const raw = Number(message.percent);
  const fraction = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) / 100 : 0;
  const phases = {
    upload: [0.03, 0.57, "Sending app to the bridge…"],
    push: [0.60, 0.20, "Copying app to your phone…"],
    install: [0.80, 0.18, "Installing app…"],
  };
  const [base, span, title] = phases[message.phase] || [0.03, 0.75, "Working…"];
  setProgress(base + span * fraction, title, message.detail || "");
}

function initBridge() {
  state.bridge = createBridgeConnection({
    onStateChange: handleBridgeStateChange,
    onLog: (message, level) => log(message, level),
    onProgress: handleBridgeProgress,
  });
  els.bridgePort.value = String(state.bridge.port);
  updateBridgeAddress();
}

async function refreshBridgeDeviceState() {
  const response = await state.bridge.status();
  const connected = Boolean(response.data?.connected);
  const adbState = response.data?.state || "none";

  state.bridgeDeviceReady = connected;
  if (connected) {
    try {
      const info = await state.bridge.info();
      state.deviceInfo = info.data || {};
      renderDeviceInfo(state.deviceInfo);
      setDeviceStatus("connected", "Connected");
    } catch (error) {
      log(`Device info unavailable: ${friendlyError(error)}`, "warn");
      state.deviceInfo = null;
      els.connectedPanel.hidden = true;
      setDeviceStatus("connected", "Connected");
    }
  } else {
    state.deviceInfo = null;
    els.connectedPanel.hidden = true;
    const label = adbState === "unauthorized"
      ? "Approve prompt"
      : adbState === "offline"
        ? "Device offline"
        : "Connect ADB";
    setDeviceStatus("idle", label);
  }
  return response;
}

async function connectBridge({ reconnect = false } = {}) {
  if (state.busy) return;
  if (state.bridge?.isConnected && !reconnect) return;

  state.busy = true;
  setBridgeStatus("connecting", "Connecting…");
  setDeviceStatus("connecting", "Connecting…");
  refreshButtons();

  try {
    state.bridge.setPort(els.bridgePort.value);
    updateBridgeAddress();
    if (reconnect) state.bridge.disconnect();
    await state.bridge.connect();
    const response = await refreshBridgeDeviceState();
    setBridgeStatus("connected", "Bridge connected");
    log(`Bridge ready on ws://127.0.0.1:${state.bridge.port}.`, "success");
    snackbar(
      response.data?.connected
        ? "Bridge connected. Choose an app file to install."
        : "Bridge connected. Pair or connect ADB in Wireless Debugging.",
      "success",
    );
  } catch (error) {
    log(`Bridge connection failed: ${friendlyError(error)}`, "error");
    setBridgeStatus("error", "Bridge error");
    setDeviceStatus("error", "Bridge error");
    snackbar(friendlyError(error), "error");
  } finally {
    state.busy = false;
    refreshButtons();
  }
}

function disconnectBridge() {
  if (state.mode !== "bridge" || !state.bridge || state.busy) return;
  state.bridge.disconnect();
  state.bridgeDeviceReady = false;
  state.deviceInfo = null;
  els.connectedPanel.hidden = true;
  setDeviceStatus("idle", "Not connected");
  setInstallStatus("idle", "Ready");
  log("Disconnected from the Termux bridge.");
  snackbar("Bridge disconnected.");
  refreshButtons();
}

async function pairWithBridge() {
  if (!state.bridge?.isConnected || state.busy) return;
  const code = els.pairCode.value.trim();
  if (!/^[A-Za-z0-9]{6}$/.test(code)) {
    snackbar("Enter the 6-digit pairing code from Wireless Debugging.", "error");
    return;
  }

  state.busy = true;
  setBridgeStatus("working", "Pairing…");
  refreshButtons();
  try {
    const response = await state.bridge.pair({ port: els.pairPort.value, code });
    log(response.message || "Paired with Wireless Debugging.", "success");
    if (response.data?.output) log(response.data.output);
    snackbar("Paired. Now connect ADB on the Wireless Debugging port.", "success");
  } catch (error) {
    log(`Pairing failed: ${friendlyError(error)}`, "error");
    snackbar(friendlyError(error), "error");
  } finally {
    state.busy = false;
    setBridgeStatus("connected", "Bridge connected");
    refreshButtons();
  }
}

async function connectAdbViaBridge() {
  if (!state.bridge?.isConnected || state.busy) return;

  state.busy = true;
  setBridgeStatus("working", "Connecting ADB…");
  refreshButtons();
  try {
    const response = await state.bridge.adbConnect({ port: els.adbPort.value });
    log(response.message || "ADB connected.", "success");
    if (response.data?.output) log(response.data.output);
    await refreshBridgeDeviceState();
    snackbar(isDeviceConnected()
      ? "Phone connected. Choose an app file to install."
      : "ADB command finished. Check the phone for an authorization prompt.",
      "success");
  } catch (error) {
    log(`ADB connect failed: ${friendlyError(error)}`, "error");
    snackbar(friendlyError(error), "error");
  } finally {
    state.busy = false;
    setBridgeStatus("connected", "Bridge connected");
    refreshButtons();
  }
}

function handleUsbDisconnect() {
  if (!state.adb && !state.device) return;
  log("USB device disconnected.", "warn");
  state.abortController?.abort(new Error("Device disconnected"));
  cleanupConnection();
  setDeviceStatus("idle", "Not connected");
  setInstallStatus("idle", "Not connected");
  snackbar("Phone disconnected.");
}

async function cleanupConnection(forgetPermission = false) {
  const adb = state.adb;
  const device = state.device;
  const raw = device?.raw;

  // Clear state first so the transport's disconnected event doesn't recurse.
  state.adb = null;
  state.transport = null;
  state.device = null;
  state.deviceInfo = null;

  try { raw?.removeEventListener?.("disconnect", handleUsbDisconnect); } catch { /* ignore */ }
  try { await adb?.close?.(); } catch { /* device may already be gone */ }
  try { await raw?.close?.(); } catch { /* ignore */ }
  if (forgetPermission) {
    try { await raw?.forget?.(); } catch { /* ignore */ }
  }

  els.connectedPanel.hidden = true;
  refreshButtons();
}

async function disconnectDevice() {
  if (state.mode !== "usb" || !state.adb || state.busy) return;
  await cleanupConnection();
  setDeviceStatus("idle", "Not connected");
  setInstallStatus("idle", "Ready");
  log("Disconnected from phone.");
  snackbar("Phone disconnected.");
}

async function resetAuthorization() {
  if (state.busy) return;
  if (state.mode === "bridge") {
    els.bridgePairDetails.open = true;
    log("Bridge mode: authorization is managed by Android's Wireless Debugging settings.");
    snackbar("In Termux mode: revoke USB debugging authorizations in Developer options, then pair again below.");
    return;
  }
  log("Resetting local ADB authorization…");
  await cleanupConnection(true);
  setDeviceStatus("idle", "Not connected");

  // Delete the RSA keys saved in IndexedDB by adb-credential-web.
  try {
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(CREDENTIAL_DB);
      request.onsuccess = () => resolve("success");
      request.onerror = () => resolve("error");
      request.onblocked = () => resolve("blocked");
    });
    log("Saved ADB key removed from this browser.", "success");
  } catch (error) {
    log(`Could not clear saved key: ${error.message}`, "warn");
  }

  state.credentialStore = null;
  snackbar("Authorization reset. Reconnect and approve the prompt again.", "success");
}

function showDeviceInfo() {
  if (!state.deviceInfo) return;
  const info = state.deviceInfo;
  const rows = [
    ["Model", info.model],
    ["Manufacturer", info.manufacturer],
    ["Android version", info.version],
    ["API level", info.sdk],
    ["Product", info.product],
    ["Platform", info.board],
    ["Serial", info.serial],
  ];
  els.infoList.replaceChildren(
    ...rows.map(([label, value]) => {
      const row = document.createElement("div");
      row.className = "info-row";
      const key = document.createElement("span");
      key.textContent = label;
      const val = document.createElement("span");
      val.textContent = value || "—";
      row.append(key, val);
      return row;
    }),
  );
  els.infoDialog.showModal();
}

function restartDevice() {
  if (!isDeviceConnected()) return;
  els.restartDialog.showModal();
}

async function confirmRestart() {
  els.restartDialog.close();
  if (!isDeviceConnected()) return;
  try {
    setDeviceStatus("connecting", "Restarting…");
    log("Rebooting device…");
    if (state.mode === "bridge") {
      await state.bridge.reboot();
    } else {
      await state.adb.power.reboot();
    }
    snackbar("Restarting your phone…", "success");
  } catch (error) {
    log(`Restart failed: ${friendlyError(error)}`, "error");
    snackbar(friendlyError(error), "error");
    setDeviceStatus("connected", "Connected");
  }
}

/* -------------------------------------------------------------------------- */
/* File selection                                                             */
/* -------------------------------------------------------------------------- */

function selectFile(file) {
  if (!file) return;
  if (!SUPPORTED_EXTENSIONS.test(file.name)) {
    snackbar("Please choose an .apk, .xapk, .apkm or .zip file.", "error");
    return;
  }
  if (file.size === 0) {
    snackbar("That file is empty. Choose the original app file.", "error");
    return;
  }

  state.selectedFile = file;
  els.dropzoneEmpty.hidden = true;
  els.fileRow.hidden = false;
  els.fileName.textContent = file.name;
  els.fileSize.textContent = formatBytes(file.size);
  els.fileKind.textContent = /\.apk$/i.test(file.name) ? "Single APK" : "App bundle";
  log(`Selected file: ${file.name} (${formatBytes(file.size)})`);
  refreshButtons();
}

function clearFile() {
  state.selectedFile = null;
  els.fileInput.value = "";
  els.dropzoneEmpty.hidden = false;
  els.fileRow.hidden = true;
  els.fileName.textContent = "—";
  els.fileSize.textContent = "—";
  refreshButtons();
}

/* -------------------------------------------------------------------------- */
/* ADB helpers                                                                */
/* -------------------------------------------------------------------------- */

async function getSync(adb) {
  // 2.x exposes adb.sync() as a function; newer releases expose a service object.
  const value = adb.sync;
  return typeof value === "function" ? await value.call(adb) : value;
}

async function writeFileToDevice(sync, path, readable) {
  if (typeof sync.createWritable === "function") {
    // Newer Tango releases: createWritable({ path }) + pipe to session.writable
    const session = await sync.createWritable({ path });
    await readable.pipeTo(session.writable);
  } else {
    // Tango 2.x: write({ filename, file })
    await sync.write({ filename: path, file: readable });
  }
}

async function drainStream(stream, onText) {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.byteLength) onText(decoder.decode(value, { stream: true }));
    }
    const rest = decoder.decode();
    if (rest) onText(rest);
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

/**
 * Spawn a command on the device, optionally feeding bytes to stdin.
 * Uses shell:v2 when the device supports it (so we get an exit code),
 * otherwise falls back to the universal "none" protocol.
 */
async function runCommand(adb, args, options = {}) {
  const { stdinBytes, onBytes, signal } = options;
  const shell = adb.subprocess.shellProtocol;

  if (!shell && !adb.subprocess.noneProtocol) {
    throw new Error("This device doesn't support ADB subprocesses.");
  }
  if (signal?.aborted) throw signal.reason || new Error("Cancelled");

  const process = await (shell
    ? shell.spawn(args, signal)
    : adb.subprocess.noneProtocol.spawn(args, signal));

  let stdout = "";
  let stderr = "";
  const readers = [];

  if (process.stdout) {
    readers.push(drainStream(process.stdout, (text) => { stdout += text; }));
  }
  if (process.stderr) {
    readers.push(drainStream(process.stderr, (text) => { stderr += text; }));
  }
  if (process.output) {
    readers.push(drainStream(process.output, (text) => { stdout += text; }));
  }

  if (stdinBytes) {
    const writer = process.stdin.getWriter();
    const CHUNK = 64 * 1024;
    try {
      for (let offset = 0; offset < stdinBytes.length; offset += CHUNK) {
        if (signal?.aborted) throw signal.reason || new Error("Cancelled");
        const slice = stdinBytes.subarray(offset, Math.min(offset + CHUNK, stdinBytes.length));
        await writer.write(slice);
        onBytes?.(slice.byteLength);
      }
      await writer.close();
    } catch (error) {
      try { writer.releaseLock(); } catch { /* ignore */ }
      throw error;
    }
  }

  await Promise.all(readers);

  let exitCode = null;
  try {
    exitCode = process.exited ? await process.exited : null;
  } catch (error) {
    if (!signal?.aborted) throw error;
  }
  try { await process.kill?.(); } catch { /* ignore */ }

  return { stdout, stderr, exitCode };
}

function commandSucceeded(result) {
  if (typeof result.exitCode === "number") return result.exitCode === 0;
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase().trim();
  if (!text) return true; // "none" protocol reports no result for quiet commands
  if (/fail|error|cannot|unable|invalid|denied/.test(text)) return false;
  return text.includes("success");
}

async function pm(adb, args, options = {}) {
  log(`$ pm ${args.join(" ")}`);
  const result = await runCommand(adb, ["pm", ...args], options);
  const output = `${result.stdout}${result.stderr}`.trim();
  if (output) {
    output.split("\n").forEach((line) => {
      const text = line.trim();
      if (text) log(`  ${text}`);
    });
  }
  return result;
}

function makeProgressStream(file, onProgress, signal) {
  let sent = 0;
  const reader = file.stream().getReader();
  return new ReadableStream({
    async pull(controller) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        controller.error(signal.reason || new Error("Cancelled"));
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        sent += value.byteLength;
        onProgress(sent);
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function cleanupTempFiles(adb) {
  if (!adb) return;
  try {
    await adb.rm(TEMP_APK, { force: true });
    log("Removed temporary install file from the phone.");
  } catch (error) {
    log(`Temporary file cleanup skipped: ${error.message}`, "warn");
  }
}

/* -------------------------------------------------------------------------- */
/* Install flows                                                              */
/* -------------------------------------------------------------------------- */

async function installSingleApk(adb, file, ctx) {
  const { signal, progress, libs } = ctx;

  progress(0.03, "Copying app to your phone…", formatBytes(file.size));
  const sync = await getSync(adb);
  try {
    const stream = makeProgressStream(file, (sent) => {
      const fraction = file.size ? sent / file.size : 1;
      progress(0.03 + 0.55 * fraction, "Copying app to your phone…", `${formatBytes(sent)} of ${formatBytes(file.size)}`);
    }, signal);
    await writeFileToDevice(sync, TEMP_APK, stream);
  } finally {
    try { await sync.dispose?.(); } catch { /* ignore */ }
  }

  log(`Copied to ${TEMP_APK}`, "success");
  progress(0.62, "Installing app…", "Android is checking and installing the app.");

  let result = await pm(adb, ["install", "-r", "-g", TEMP_APK], { signal });
  if (!commandSucceeded(result)) {
    log("Install with -g didn't work; retrying with standard options…", "warn");
    progress(0.76, "Installing app…", "Retrying with standard options.");
    result = await pm(adb, ["install", "-r", TEMP_APK], { signal });
  }
  if (!commandSucceeded(result)) {
    throw new Error(`Android couldn't install this app. ${result.stdout}${result.stderr}`.trim());
  }

  progress(0.94, "Almost done…", "");
  return result;
}

async function prepareSplitParts(file, libs, { signal, progress } = {}) {
  progress?.(0.02, "Opening app bundle…", file.name);
  const zip = await libs.JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter(
    (entry) => !entry.dir && /\.(apk|apkm)$/i.test(entry.name),
  );
  if (entries.length === 0) {
    throw new Error("This bundle doesn't contain any .apk files.");
  }

  progress?.(0.06, "Reading app files…", `${entries.length} split part${entries.length === 1 ? "" : "s"} found`);
  const parts = [];
  for (const entry of entries) {
    if (signal?.aborted) throw signal.reason || new Error("Cancelled");
    const bytes = await entry.async("uint8array");
    let name = entry.name.split("/").pop().replace(/[^A-Za-z0-9._-]/g, "_");
    if (!/\.apk$/i.test(name)) name = `${name}.apk`;
    if (parts.some((part) => part.name === name)) name = `${parts.length + 1}_${name}`;
    parts.push({ name, bytes });
  }
  // The base APK is traditionally named base.apk; install it first.
  parts.sort((a, b) => Number(b.name.toLowerCase() === "base.apk") - Number(a.name.toLowerCase() === "base.apk"));

  const totalBytes = parts.reduce((sum, part) => sum + part.bytes.byteLength, 0);
  progress?.(0.1, "Preparing installation…", `${parts.length} parts · ${formatBytes(totalBytes)}`);
  log(`Split bundle: ${parts.length} parts, ${formatBytes(totalBytes)} total`);
  return { parts, totalBytes };
}

async function installSplitBundle(adb, file, ctx) {
  const { signal, progress, libs } = ctx;
  const { parts, totalBytes } = await prepareSplitParts(file, libs, { signal, progress });

  const create = await pm(adb, ["install-create", "-S", String(totalBytes)], { signal });
  if (!commandSucceeded(create)) {
    throw new Error(`Couldn't start the install session. ${create.stdout}${create.stderr}`.trim());
  }
  const sessionMatch = `${create.stdout}${create.stderr}`.match(/\[(\d+)\]/);
  if (!sessionMatch) {
    throw new Error("Couldn't read the install session ID from the device.");
  }
  const sessionId = sessionMatch[1];
  log(`Install session: ${sessionId}`, "success");

  let written = 0;
  const updateWriteProgress = (name) => {
    const fraction = totalBytes ? written / totalBytes : 1;
    progress(0.12 + 0.7 * fraction, `Writing ${name}…`, `${formatBytes(written)} of ${formatBytes(totalBytes)}`);
  };

  try {
    for (const part of parts) {
      if (signal?.aborted) throw signal.reason || new Error("Cancelled");
      updateWriteProgress(part.name);

      const result = await pm(
        adb,
        ["install-write", "-S", String(part.bytes.byteLength), sessionId, part.name],
        {
          signal,
          stdinBytes: part.bytes,
          onBytes: () => updateWriteProgress(part.name),
        },
      );
      if (!commandSucceeded(result)) {
        throw new Error(`Couldn't write ${part.name} to the phone.`);
      }
      written += part.bytes.byteLength;
    }

    progress(0.88, "Finishing installation…", "Android is verifying all app parts.");
    const commit = await pm(adb, ["install-commit", sessionId], { signal });
    if (!commandSucceeded(commit)) {
      throw new Error(`Android couldn't finish the install. ${commit.stdout}${commit.stderr}`.trim());
    }
    progress(0.96, "Almost done…", "");
  } catch (error) {
    log(`Install failed — abandoning session ${sessionId}.`, "warn");
    try {
      await pm(adb, ["install-abandon", sessionId]);
    } catch (abandonError) {
      log(`Couldn't abandon session: ${abandonError.message}`, "warn");
    }
    throw error;
  }
}

async function installWithBridge(file, ctx) {
  const { signal, libs } = ctx;
  let parts;

  if (/\.apk$/i.test(file.name)) {
    parts = [{ name: file.name, size: file.size, file }];
  } else {
    const prepared = await prepareSplitParts(file, libs, { signal, progress: setProgress });
    parts = prepared.parts.map(({ name, bytes }) => ({
      name,
      size: bytes.byteLength,
      bytes,
    }));
    setProgress(0.12, "Sending app to the bridge…", `${parts.length} parts ready`);
  }

  const mode = parts.length > 1 ? "split" : "single";
  log(`Uploading ${parts.length} app part${parts.length === 1 ? "" : "s"} to the Termux bridge.`);
  await state.bridge.install({
    parts,
    mode,
    onProgress: handleBridgeProgress,
  });
}

async function installApp() {
  if (state.busy || !isDeviceConnected() || !state.selectedFile) return;

  const useBridge = state.mode === "bridge";
  const adb = state.adb;
  const file = state.selectedFile;
  const controller = new AbortController();
  state.abortController = controller;
  state.bridgeCancelled = false;
  state.busy = true;

  setInstallStatus("working", "Installing…");
  setProgress(0, "Getting ready…", "Preparing your app file.");
  refreshButtons();

  try {
    const libs = await libsPromise;
    const ctx = { signal: controller.signal, progress: setProgress, libs };
    log(`Starting install: ${file.name}`);

    if (useBridge) {
      await installWithBridge(file, ctx);
    } else if (/\.apk$/i.test(file.name)) {
      await installSingleApk(adb, file, ctx);
    } else {
      await installSplitBundle(adb, file, ctx);
    }

    setProgress(1, "App installed", "You can find it in your app drawer.");
    setInstallStatus("done", "Installed");
    log("Install completed successfully.", "success");
    snackbar("App installed successfully.", "success");
  } catch (error) {
    const cancelled = state.bridgeCancelled || controller.signal.aborted;
    const message = friendlyError(error);
    log(`${cancelled ? "Install cancelled" : "Install failed"}: ${message}`, cancelled ? "warn" : "error");
    setInstallStatus(cancelled ? "idle" : "error", cancelled ? "Cancelled" : "Failed");
    els.progressTitle.textContent = cancelled ? "Install cancelled" : "Install failed";
    els.progressDetail.textContent = cancelled ? "Nothing was changed on your phone." : message;
    if (!cancelled) snackbar(message, "error");
  } finally {
    // WebUSB temp files are always removed here; the bridge cleans up its own
    // local and remote temp paths in bridge.py's finally blocks.
    if (!useBridge && state.adb) await cleanupTempFiles(state.adb);
    state.abortController = null;
    state.bridgeCancelled = false;
    state.busy = false;
    refreshButtons();
  }
}

function cancelInstall() {
  if (!state.abortController) return;
  state.abortController.abort(new Error("Install cancelled by you"));
  if (state.mode === "bridge" && state.bridge?.isConnected) {
    state.bridgeCancelled = true;
    state.bridge.cancel();
  }
  setInstallStatus("cancelling", "Cancelling…");
  els.progressTitle.textContent = "Cancelling…";
  log("Cancel requested.");
  snackbar("Cancelling the install…");
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

function setupEvents() {
  els.modeUsbBtn.addEventListener("click", () => setMode("usb"));
  els.modeBridgeBtn.addEventListener("click", () => setMode("bridge"));

  els.connectBtn.addEventListener("click", connectDevice);
  els.disconnectBtn.addEventListener("click", disconnectDevice);
  els.bridgeConnectBtn.addEventListener("click", connectBridge);
  els.bridgeDisconnectBtn.addEventListener("click", disconnectBridge);
  els.bridgeReconnectBtn.addEventListener("click", () => connectBridge({ reconnect: true }));
  els.bridgePairBtn.addEventListener("click", pairWithBridge);
  els.bridgeAdbConnectBtn.addEventListener("click", connectAdbViaBridge);
  els.bridgePort.addEventListener("input", updateBridgeAddress);

  els.infoBtn.addEventListener("click", showDeviceInfo);
  els.restartBtn.addEventListener("click", restartDevice);
  els.resetBtn.addEventListener("click", resetAuthorization);
  els.restartConfirmBtn.addEventListener("click", confirmRestart);

  els.dropzone.addEventListener("click", (event) => {
    if (event.target.closest("#remove-file-btn")) return;
    els.fileInput.click();
  });
  els.dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener("change", () => selectFile(els.fileInput.files?.[0]));
  els.removeFileBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    clearFile();
  });

  ["dragenter", "dragover"].forEach((type) => {
    els.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropzone.classList.add("dragging");
    });
  });
  ["dragleave", "drop"].forEach((type) => {
    els.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropzone.classList.remove("dragging");
    });
  });
  els.dropzone.addEventListener("drop", (event) => {
    selectFile(event.dataTransfer?.files?.[0]);
  });
  // Don't let the browser navigate away if a file is dropped outside the zone.
  ["dragover", "drop"].forEach((type) => {
    document.addEventListener(type, (event) => event.preventDefault());
  });

  els.installBtn.addEventListener("click", installApp);
  els.cancelBtn.addEventListener("click", cancelInstall);

  els.copyLogBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(els.logOutput.innerText);
      snackbar("Technical log copied.", "success");
    } catch {
      snackbar("Couldn't copy the log. Select the text and copy manually.", "error");
    }
  });

  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog")?.close());
  });
  [els.infoDialog, els.restartDialog].forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  window.addEventListener("beforeunload", () => {
    if (state.adb) void cleanupConnection();
    state.bridge?.disconnect();
  });
}

function init() {
  if (!BETA) els.betaBadge.hidden = true;
  els.logOutput.innerHTML = '<div class="log-empty">Log output appears here once you connect or install.</div>';

  initBridge();
  updateModeUI();
  setupEvents();
  log("Sideload ready. Libraries are loading from the CDN…");

  libsPromise = loadLibraries().then((libs) => {
    log("ADB and JSZip loaded.", "success");
    return libs;
  }).catch((error) => {
    log(`Could not load libraries: ${friendlyError(error)}`, "error");
    state.libsFailed = true;
    updateBrowserBanner();
    throw error;
  });
  // Mark the rejection as handled so an offline page doesn't spam the console.
  libsPromise.catch(() => {});

  checkBrowser();
}

init();
