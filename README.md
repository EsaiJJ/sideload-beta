# Sideload — beta release

A 100% static, zero-backend web app for installing `.apk`, `.xapk`, `.apkm` and `.zip` (split APK) files on an Android phone. It supports two local connection modes:

- **USB / OTG** — WebUSB talks directly to an attached Android device (Chrome/Edge).
- **This phone (Termux)** — a tiny Python WebSocket bridge runs in Termux on the same phone and talks to Android Wireless Debugging over `adb`.

The app is designed to look and feel like stock Android system settings (Material You).

Files:

- `index.html` — structure, Material-inspired components, import map for CDN ES modules
- `style.css` — light Material You styling, responsive layout
- `app.js` — connection switching, file handling, single + split install flows
- `connection.js` — browser client for the local Termux bridge
- `termux/bridge.py` — stdlib-only WebSocket + ADB bridge for Termux
- `termux/start.sh` — Termux launcher/package check

> Nothing is uploaded to a remote server. USB files are streamed directly from the browser; bridge files go only to `ws://127.0.0.1` on the same phone. WebUSB RSA keys are kept in this site's IndexedDB.

---

## 1. Stage the beta on GitHub Pages

WebUSB requires a **secure context**, so the beta must be served over HTTPS (or `localhost`). GitHub Pages gives you HTTPS for free.

```bash
cd sideload-beta

git init
git add index.html style.css app.js connection.js termux README.md .nojekyll CNAME.example
git commit -m "Sideload beta: static WebUSB APK installer"

# Create an EMPTY public repository named e.g. "sideload-beta" on GitHub, then:
git remote add origin https://github.com/<username>/sideload-beta.git
git branch -M main
git push -u origin main
```

In the new repository go to **Settings → Pages → Build and deployment**:

- **Source:** `Deploy from a branch`
- **Branch:** `main` / `/(root)`
- Save, wait ~1 minute for the build.

The live beta for this repository is:

```
https://esaijj.github.io/sideload-beta/
```

For a fork, the pattern is `https://<username>.github.io/<repo>/`.

Local CSS/JS links use `?v=4` cache-busting (the copied Termux command also downloads `bridge.py` with that version). Bump that number in `index.html` and `app.js` whenever you push changes so beta testers don't keep a stale script for GitHub Pages' 10-minute cache.

The small **Beta** badge in the header is intentional during testing. It is controlled by `const BETA = true;` near the top of `app.js`.

### What to test on the beta URL

| Test | What to check |
| --- | --- |
| Computer + USB cable | Chrome/Edge select the phone, the ADB prompt is approved, device model/Android version appear |
| Phone + USB-OTG | Chrome for Android sees the second phone and the install completes without the page losing focus |
| Termux bridge | `bash start.sh` starts on 127.0.0.1:8765, the browser connects, Pair + Connect ADB reach Wireless Debugging |
| Single `.apk` | Progress runs to 100%, `pm install -r -g` succeeds, `-r` fallback works on older devices, temp file is gone |
| `.xapk` / `.apkm` / `.zip` | Split parts are read in memory, `install-create` / `install-write` / `install-commit` work, failed sessions are abandoned |
| Edge cases | Unplug mid-copy → clean error; wrong file type → friendly message; device busy → clear guidance; reset authorization → new prompt on phone; cancel bridge upload → local/remote temps removed |
| Technical log | Drawer expands, lines are readable, Copy works |

Open the page in a normal browser tab (not an incognito window if you want the RSA key to persist). The log drawer is the first place to look when something goes wrong.

---

## 2. Use the Termux bridge on the same phone

This mode avoids USB entirely. The browser page and the bridge both run on the phone; the bridge listens only on `127.0.0.1`.

1. On the phone, enable **Developer options → Wireless Debugging**.
2. In the website, choose **This phone (Termux)** and tap **Copy Termux command**.
3. Paste that command into Termux and press Enter. It installs `python` and `android-tools` (`adb`) only if missing, downloads the current `bridge.py` from this site, and starts it on the port shown in the page. Keep Termux open while installing.

   Manual alternative: copy the `termux/` folder into Termux and run `bash start.sh` from there.

4. Tap **Connect to bridge** in the website.
5. Open **Pair Wireless Debugging** in the page. On the phone go to **Wireless Debugging → Pair device** and enter the pairing port and 6-digit code in the page, then tap **Pair**.
6. Enter the **Wireless Debugging port** (the main debugging port, not the pairing port) and tap **Connect ADB**. Approve the USB debugging prompt on the phone if shown.
7. Select an app file and tap **Install**. Keep Termux and the browser tab in the foreground.

To change the listening port, edit the **Bridge port** field in the page *before* copying the command — the copied command uses that port automatically.

For manual setup, `SIDELOAD_PORT=9000 bash start.sh` also works. Advanced options: `SIDELOAD_HOST` (default `127.0.0.1`) and `SIDELOAD_ALLOWED_ORIGINS` (comma-separated patterns; defaults include the beta GitHub Pages origin, localhost, and `sideload.mystichero.eu`).

The bridge is stdlib-only Python and uses a short JSON/binary WebSocket protocol documented at the top of `termux/bridge.py`. Uploads are written under `~/.sideload_upload_*` in Termux and pushed to `/data/local/tmp/` for `pm install`; both are removed in `finally` blocks, including on failure or cancel.

> `ws://127.0.0.1` is allowed from an HTTPS page as a localhost exception. Chrome may still show a Local Network Access permission prompt — allow it once for the site.

---

## 3. Promote to `sideload.mystichero.eu`

Only after the beta has been tested:

1. In **Cloudflare / your DNS provider**, create a `CNAME` record:

   ```
   sideload.mystichero.eu  →  <username>.github.io
   ```

2. Rename `CNAME.example` to `CNAME` (its contents are `sideload.mystichero.eu`) and commit it to the repository root:

   ```bash
   cp CNAME.example CNAME
   git add CNAME
   git commit -m "Add custom domain"
   git push
   ```

3. In **Settings → Pages → Custom domain**, enter `sideload.mystichero.eu` and enable **Enforce HTTPS**. Wait for the TLS certificate to be issued.

4. Set `const BETA = false;` in `app.js` (or remove the badge element from `index.html`) and push again.

5. Keep the repo as the single source of truth. Future updates are just `git push`.

> If you want to keep beta and production separate, use two repositories (e.g. `sideload-beta` and `sideload`) or two branches (`beta` and `main`) with a separate Pages environment. Only the production repo should contain the `CNAME` file.

---

## 4. How it works

### USB connection

1. `AdbDaemonWebUsbDeviceManager.BROWSER.requestDevice()` opens the browser device picker (user gesture required).
2. `device.connect()` opens the WebUSB device and claims the ADB interface.
3. `AdbWebCredentialStore("Sideload")` generates/loads a 2048-bit RSA key and stores it in IndexedDB (`Tango` / `Authentication`).
4. `AdbDaemonTransport.authenticate()` performs the ADB handshake. Approve the prompt on the phone.
5. A `disconnect` listener and `transport.disconnected` handler clear state and abort an in-progress install.

**Reset authorization** forgets the WebUSB permission for that device, deletes the IndexedDB key database, and asks you to reconnect and approve again. If the phone still refuses, also use *Settings → Developer options → Revoke USB debugging authorizations* on the phone.

### Bridge connection

1. `connection.js` opens `ws://127.0.0.1:<port>` and verifies the bridge with a `status` command.
2. `pair` sends the Wireless Debugging pairing port/code; `connect` runs `adb connect 127.0.0.1:<port>` and checks `adb devices`.
3. `info` fills the same device card used by WebUSB; `reboot` runs `adb reboot`.
4. `install` announces part names/sizes as JSON, then sends binary frames `[kind][index][bytes]`; the bridge saves them, pushes to `/data/local/tmp/`, runs `pm install...`, and cleans up.
5. The client tracks states (`disconnected`, `connecting`, `connected`, `error`), retries a dropped connection up to three times, and closes the socket to cancel an install.

### Single APK

```
file.stream() → sync.write(/data/local/tmp/mystic_install.apk)   [live progress]
             → pm install -r -g /data/local/tmp/mystic_install.apk
             → pm install -r ...                                  [fallback]
             → adb.rm(/data/local/tmp/mystic_install.apk)         [always, in finally]
```

### Split bundle (`.xapk`, `.apkm`, `.zip`)

```
JSZip.loadAsync(file) → all .apk/.apkm entries read into memory
                      → pm install-create -S <total bytes>
                      → pm install-write -S <size> <session> <split>   (per part, via stdin)
                      → pm install-commit <session>
                      → pm install-abandon <session> on any failure
                      → temp cleanup on every path
```

### Pinned CDN modules

`index.html` pins exact versions in the import map so the ADB packages share one copy of their stream/extra helpers:

| Package | Version |
| --- | --- |
| `@yume-chan/adb` | 2.6.4 |
| `@yume-chan/adb-daemon-webusb` | 2.3.2 |
| `@yume-chan/adb-credential-web` | 2.1.0 |
| `jszip` | 3.10.1 |

When upgrading, update all Tango packages together and re-run the beta test matrix above.

---

## 5. Browser support notes

- WebUSB works in Chromium browsers (Chrome, Edge, Brave, Opera) on desktop, and Chrome on Android with USB-OTG.
- Firefox and Safari cannot use WebUSB, but can use the **This phone (Termux)** bridge mode on the same phone. The warning banner points to that option.
- `file://` will not work — ES modules and WebUSB need HTTP(S). Use the GitHub Pages URL or `python3 -m http.server 8000` on localhost.
- On Android, keep the browser tab in the foreground while flashing; some OEMs suspend background tabs and break the USB connection.
