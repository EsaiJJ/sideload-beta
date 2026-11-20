#!/usr/bin/env python3
"""
Sideload local bridge — runs inside Termux on the same Android phone.

It exposes a tiny WebSocket server on 127.0.0.1:8765 that the static website
uses to talk to `adb` over Android Wireless Debugging. No external Python
packages are required: the WebSocket protocol is implemented with the stdlib.

--------------------------------------------------------------------------
WIRE PROTOCOL (keep in sync with connection.js)
--------------------------------------------------------------------------
Text request  (client -> server), JSON:
    {"id":"c-1","type":"pair","port":5555,"code":"123456"}
    {"id":"c-2","type":"connect","port":5555}
    {"id":"c-3","type":"status"}
    {"id":"c-4","type":"info"}
    {"id":"c-5","type":"reboot"}
    {"id":"c-6","type":"install","mode":"single|split","size":123,
     "parts":[{"name":"base.apk","size":123}, ...]}

Binary frames (client -> server), sent after an `install` request:
    byte 0      : 1 = data chunk, 2 = end of part
    bytes 1..2  : part index, unsigned big-endian uint16
    bytes 3..   : raw APK bytes (empty for the end marker)

Text response (server -> client), JSON:
    {"id":"c-1","ok":true,"type":"pair","message":"...","data":{...}}
    {"id":"c-1","ok":false,"type":"pair","error":"...","code":"..."}
    {"id":"c-6","type":"progress","phase":"upload|push|install",
     "received":123,"total":456,"percent":27,"detail":"..."}

Only one install can be in flight per WebSocket connection.
--------------------------------------------------------------------------
"""

from __future__ import annotations

import argparse
import base64
import fnmatch
import hashlib
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_FRAME_SIZE = 32 * 1024 * 1024
MAX_HANDSHAKE_BYTES = 64 * 1024
DEFAULT_ORIGINS = ",".join(
    [
        "https://sideload.mystichero.eu",
        "https://*.github.io",
        "http://localhost:*",
        "http://127.0.0.1:*",
    ]
)
CHUNK_KIND_DATA = 1
CHUNK_KIND_END = 2
ADB_LOCK = threading.Lock()

SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]")
PROP_LINE = re.compile(r"^\[([^\]]+)\]: \[(.*)\]$")


class BridgeError(Exception):
    def __init__(self, message: str, code: str = "BRIDGE_ERROR"):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------
# Tiny RFC 6455 WebSocket implementation (stdlib only)
# ---------------------------------------------------------------------------
class WebSocket:
    def __init__(self, sock: socket.socket, initial: bytes = b""):
        self.sock = sock
        self.buffer = bytearray(initial)
        self.send_lock = threading.Lock()
        self.closed = False

    def _recv_exact(self, count: int) -> bytes:
        while len(self.buffer) < count:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("Connection closed")
            self.buffer.extend(chunk)
        result = bytes(self.buffer[:count])
        del self.buffer[:count]
        return result

    def recv_frame(self) -> tuple[bool, int, bytes]:
        first, second = self._recv_exact(2)
        fin = bool(first & 0x80)
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F

        if length == 126:
            length = struct.unpack(">H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._recv_exact(8))[0]
        if length > MAX_FRAME_SIZE:
            raise ValueError("WebSocket frame too large")

        mask = self._recv_exact(4) if masked else None
        payload = self._recv_exact(length)
        if mask:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        return fin, opcode, payload

    def send_frame(self, payload: bytes | str, opcode: int = 0x1) -> None:
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        header = bytearray([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header.append(length)
        elif length < 65536:
            header.append(126)
            header.extend(struct.pack(">H", length))
        else:
            header.append(127)
            header.extend(struct.pack(">Q", length))
        with self.send_lock:
            if self.closed:
                return
            self.sock.sendall(bytes(header) + payload)

    def send_json(self, value: dict[str, Any]) -> None:
        self.send_frame(json.dumps(value, ensure_ascii=False), 0x1)

    def close(self) -> None:
        if self.closed:
            return
        try:
            self.send_frame(b"", 0x8)
        except OSError:
            pass
        finally:
            self.closed = True
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


def websocket_handshake(sock: socket.socket, allowed_origins: str) -> WebSocket | None:
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(4096)
        if not chunk:
            return None
        data += chunk
        if len(data) > MAX_HANDSHAKE_BYTES:
            return None

    head, rest = data.split(b"\r\n\r\n", 1)
    lines = head.decode("iso-8859-1").split("\r\n")
    headers = {
        key.strip().lower(): value.strip()
        for key, _, value in (line.partition(":") for line in lines[1:])
    }

    origin = headers.get("origin", "")
    if origin and not any(
        fnmatch.fnmatch(origin.lower(), pattern.strip().lower())
        for pattern in allowed_origins.split(",")
        if pattern.strip()
    ):
        sock.sendall(
            b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        return None

    key = headers.get("sec-websocket-key")
    if not key:
        sock.sendall(
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        return None

    accept = base64.b64encode(
        hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
    ).decode("ascii")
    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n"
        "\r\n"
    )
    sock.sendall(response.encode("ascii"))
    return WebSocket(sock, rest)


# ---------------------------------------------------------------------------
# ADB helpers
# ---------------------------------------------------------------------------
def adb_binary() -> str:
    return shutil.which("adb") or "adb"


def run_adb(
    args: list[str],
    timeout: int = 90,
    stdin_source: Any = subprocess.DEVNULL,
) -> tuple[int, str, str]:
    command = [adb_binary(), *args]
    try:
        with ADB_LOCK:
            completed = subprocess.run(
                command,
                stdin=stdin_source,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                check=False,
            )
    except FileNotFoundError as error:
        raise BridgeError(
            "adb wasn't found. Install it in Termux with: pkg install android-tools",
            "ADB_MISSING",
        ) from error
    except subprocess.TimeoutExpired as error:
        raise BridgeError("adb timed out. Try again.", "ADB_TIMEOUT") from error

    stdout = completed.stdout.decode("utf-8", errors="replace").strip()
    stderr = completed.stderr.decode("utf-8", errors="replace").strip()
    return completed.returncode, stdout, stderr


def device_state() -> tuple[str | None, str]:
    """Return (serial, state) using the first non-offline entry from `adb devices`."""
    _, stdout, stderr = run_adb(["devices"], timeout=20)
    fallback: tuple[str | None, str] = (None, "none")
    for line in stdout.splitlines()[1:]:
        columns = line.split()
        if len(columns) >= 2:
            fallback = (columns[0], columns[1])
            if columns[1] == "device":
                return columns[0], "device"
    if stderr and fallback[0] is None:
        raise BridgeError(stderr, "ADB_ERROR")
    return fallback


def require_device() -> str:
    serial, state = device_state()
    if state == "unauthorized":
        raise BridgeError(
            "The phone shows an 'Allow USB debugging?' prompt. Approve it, "
            "or revoke authorizations in Developer options and pair again.",
            "ADB_UNAUTHORIZED",
        )
    if state == "offline":
        raise BridgeError(
            "The phone is offline. Toggle Wireless Debugging off and on, then reconnect.",
            "ADB_OFFLINE",
        )
    if state != "device" or not serial:
        raise BridgeError(
            "No ADB device connected. Pair and connect to Wireless Debugging first.",
            "ADB_DISCONNECTED",
        )
    return serial


def validate_port(value: Any) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError) as error:
        raise BridgeError("Enter a valid port number.", "BAD_PORT") from error
    if not 1 <= port <= 65535:
        raise BridgeError("The port must be between 1 and 65535.", "BAD_PORT")
    return port


def safe_filename(name: Any) -> str:
    text = str(name or "app.apk").split("/")[-1].split("\\")[-1]
    cleaned = SAFE_NAME.sub("_", text).strip("._")
    return cleaned or "app.apk"


# ---------------------------------------------------------------------------
# Upload handling
# ---------------------------------------------------------------------------
class Upload:
    def __init__(self, request_id: str, mode: str, parts: list[dict[str, Any]]):
        self.request_id = request_id
        self.mode = mode
        self.parts = parts
        self.temp_dir = Path.home() / f".sideload_upload_{os.getpid()}_{request_id}"
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        self.files: list[Any] = []
        self.paths: list[Path] = []
        self.received = [0] * len(parts)
        self.ended = [False] * len(parts)
        self.lock = threading.Lock()
        self.last_percent = -2

        for index, part in enumerate(parts):
            filename = f"part_{index}_{safe_filename(part.get('name'))}"
            path = self.temp_dir / filename
            self.paths.append(path)
            self.files.append(path.open("wb"))

    def write(self, index: int, data: bytes) -> None:
        if index < 0 or index >= len(self.files):
            raise BridgeError("Unknown split part index.", "BAD_UPLOAD")
        with self.lock:
            if self.ended[index]:
                raise BridgeError("Data arrived after a part was closed.", "BAD_UPLOAD")
            if self.received[index] + len(data) > int(self.parts[index]["size"]) + 1024:
                raise BridgeError("Received more data than announced.", "BAD_UPLOAD")
            self.files[index].write(data)
            self.received[index] += len(data)

    def end_part(self, index: int) -> bool:
        with self.lock:
            if 0 <= index < len(self.files):
                if not self.files[index].closed:
                    self.files[index].close()
                self.ended[index] = True
        return all(self.ended) and all(
            self.received[i] >= int(part["size"])
            for i, part in enumerate(self.parts)
        )

    def cancel(self) -> None:
        for handle in self.files:
            try:
                if not handle.closed:
                    handle.close()
            except OSError:
                pass
        shutil.rmtree(self.temp_dir, ignore_errors=True)


def upload_progress(
    ws: WebSocket,
    request_id: str,
    phase: str,
    received: int,
    total: int,
    detail: str,
    force: bool = False,
) -> None:
    percent = min(100, round(received * 100 / total)) if total else 100
    state = getattr(upload_progress, "state", {})
    key = f"{request_id}:{phase}"
    if not force and percent - state.get(key, -2) < 2 and percent != 100:
        return
    state[key] = percent
    try:
        ws.send_json(
            {
                "id": request_id,
                "type": "progress",
                "phase": phase,
                "received": received,
                "total": total,
                "percent": percent,
                "detail": detail,
            }
        )
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
def command_pair(payload: dict[str, Any]) -> dict[str, Any]:
    port = validate_port(payload.get("port"))
    code = str(payload.get("code") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9]{6}", code):
        raise BridgeError(
            "Enter the 6-digit pairing code shown in Wireless Debugging.", "BAD_CODE"
        )
    return_code, stdout, stderr = run_adb(
        ["pair", f"127.0.0.1:{port}", code], timeout=60
    )
    if return_code != 0 or re.search(r"failed|cannot|error", stdout + stderr, re.I):
        raise BridgeError(
            (stdout + stderr).strip() or "Pairing failed. Check the code and port.",
            "PAIR_FAILED",
        )
    return {"message": "Paired with Wireless Debugging.", "data": {"output": stdout}}


def command_connect(payload: dict[str, Any]) -> dict[str, Any]:
    port = validate_port(payload.get("port"))
    return_code, stdout, stderr = run_adb(
        ["connect", f"127.0.0.1:{port}"], timeout=40
    )
    combined = (stdout + stderr).strip()
    lowered = combined.lower()
    failed_to_connect = any(
        phrase in lowered
        for phrase in ("failed to connect", "cannot connect", "unable to connect", "connection refused")
    )
    if failed_to_connect or (return_code != 0 and "already connected" not in lowered):
        raise BridgeError(
            combined or "Couldn't connect. Check the Wireless Debugging port and try again.",
            "CONNECT_FAILED",
        )

    # `adb connect` can return before the device shows up in `adb devices`.
    # Poll briefly so a successful connect isn't reported as a failure.
    serial, state = None, "none"
    deadline = time.monotonic() + 8
    while True:
        serial, state = device_state()
        if state == "device" or time.monotonic() >= deadline:
            break
        time.sleep(0.5)

    if state == "unauthorized":
        raise BridgeError(
            "Approve the 'Allow USB debugging?' prompt on the phone, then try again.",
            "ADB_UNAUTHORIZED",
        )
    if state != "device":
        raise BridgeError(
            "ADB didn't finish connecting (state: "
            + str(state)
            + "). Make sure Wireless Debugging is on, then pair again and use "
            "the main Wireless Debugging port (not the pairing port).",
            "ADB_OFFLINE",
        )
    return {
        "message": f"Connected to {serial}.",
        "data": {"serial": serial, "state": state, "output": combined},
    }


def command_status() -> dict[str, Any]:
    serial, state = device_state()
    _, stdout, _ = run_adb(["devices"], timeout=20)
    devices = []
    for line in stdout.splitlines()[1:]:
        columns = line.split()
        if len(columns) >= 2:
            devices.append({"serial": columns[0], "state": columns[1]})
    return {
        "message": f"Device state: {state}.",
        "data": {
            "devices": devices,
            "connected": state == "device",
            "state": state,
            "serial": serial,
        },
    }


def command_info() -> dict[str, Any]:
    require_device()
    _, stdout, _ = run_adb(["shell", "getprop"], timeout=30)
    props: dict[str, str] = {}
    for line in stdout.splitlines():
        match = PROP_LINE.match(line.strip())
        if match:
            props[match.group(1)] = match.group(2)
    data = {
        "model": props.get("ro.product.model", ""),
        "manufacturer": props.get("ro.product.manufacturer", ""),
        "version": props.get("ro.build.version.release", ""),
        "sdk": props.get("ro.build.version.sdk", ""),
        "product": props.get("ro.product.name", ""),
        "board": props.get("ro.board.platform", ""),
        "serial": device_state()[0] or "",
    }
    return {"message": "Device information loaded.", "data": data}


def command_reboot() -> dict[str, Any]:
    require_device()
    run_adb(["reboot"], timeout=30)
    return {"message": "Reboot command sent.", "data": {}}


def pm_arguments(args: list[str]) -> list[str]:
    return ["shell", *args]


def parse_session(output: str) -> str:
    match = re.search(r"\[(\d+)\]", output)
    if not match:
        raise BridgeError(
            f"Couldn't read the install session ID. Device said: {output.strip()}",
            "NO_SESSION",
        )
    return match.group(1)


def install_single(
    ws: WebSocket,
    upload: Upload,
    total: int,
) -> None:
    temp_name = "mystic_install.apk"
    remote = f"/data/local/tmp/{temp_name}"
    local = upload.paths[0]

    try:
        upload_progress(ws, upload.request_id, "push", 0, total, "Copying app to the phone…", True)
        return_code, stdout, stderr = run_adb(["push", str(local), remote], timeout=300)
        if return_code != 0:
            raise BridgeError((stderr or stdout).strip() or "Couldn't copy the app.", "PUSH_FAILED")

        upload_progress(ws, upload.request_id, "install", 0, total, "Installing app…", True)
        return_code, stdout, stderr = run_adb(
            pm_arguments(["pm", "install", "-r", "-g", remote]), timeout=600
        )
        output = (stdout + stderr).strip()
        if return_code != 0:
            upload_progress(
                ws, upload.request_id, "install", total // 2, total,
                "Retrying with standard options…", True,
            )
            return_code, stdout, stderr = run_adb(
                pm_arguments(["pm", "install", "-r", remote]), timeout=600
            )
            output = (stdout + stderr).strip()
        if return_code != 0:
            raise BridgeError(output or "Android couldn't install this app.", "INSTALL_FAILED")

        upload_progress(ws, upload.request_id, "install", total, total, "App installed.", True)
    finally:
        try:
            run_adb(pm_arguments(["rm", "-f", remote]), timeout=60)
        except Exception:
            pass


def install_split(
    ws: WebSocket,
    upload: Upload,
    total: int,
) -> None:
    session: str | None = None
    remote_dir = f"/data/local/tmp/sideload_{upload.request_id}"
    try:
        require_device()

        return_code, stdout, stderr = run_adb(
            pm_arguments(["mkdir", "-p", remote_dir]), timeout=30
        )
        if return_code != 0:
            raise BridgeError("Couldn't create a temporary folder on the phone.", "PUSH_FAILED")

        pushed = 0
        for index, part in enumerate(upload.parts):
            size = int(part["size"])
            name = safe_filename(part.get("name"))
            return_code, _, push_error = run_adb(
                ["push", str(upload.paths[index]), f"{remote_dir}/{name}"], timeout=300
            )
            if return_code != 0:
                raise BridgeError(push_error or f"Couldn't copy {name}.", "PUSH_FAILED")
            pushed += size
            upload_progress(
                ws, upload.request_id, "push", pushed, total,
                f"Copying app part {index + 1} of {len(upload.parts)}…", True,
            )

        return_code, stdout, stderr = run_adb(
            pm_arguments(["pm", "install-create", "-S", str(total)]), timeout=60
        )
        output = (stdout + stderr).strip()
        if return_code != 0:
            raise BridgeError(output or "Couldn't start the install session.", "CREATE_FAILED")
        session = parse_session(output)

        written = 0
        for index, part in enumerate(upload.parts):
            size = int(part["size"])
            name = safe_filename(part.get("name"))
            return_code, stdout, stderr = run_adb(
                pm_arguments(
                    [
                        "pm",
                        "install-write",
                        "-S",
                        str(size),
                        session,
                        name,
                        f"{remote_dir}/{name}",
                    ]
                ),
                timeout=180,
            )
            output = (stdout + stderr).strip()
            if return_code != 0:
                raise BridgeError(output or f"Couldn't write {name}.", "WRITE_FAILED")
            written += size
            upload_progress(
                ws, upload.request_id, "install", written, total,
                f"Writing app part {index + 1} of {len(upload.parts)}…", True,
            )

        return_code, stdout, stderr = run_adb(
            pm_arguments(["pm", "install-commit", session]), timeout=600
        )
        output = (stdout + stderr).strip()
        if return_code != 0:
            raise BridgeError(output or "Android couldn't finish the install.", "COMMIT_FAILED")
        upload_progress(ws, upload.request_id, "install", total, total, "App installed.", True)
    except Exception:
        if session:
            try:
                run_adb(pm_arguments(["pm", "install-abandon", session]), timeout=60)
            except Exception:
                pass
        raise
    finally:
        try:
            run_adb(pm_arguments(["rm", "-rf", remote_dir]), timeout=60)
        except Exception:
            pass


def perform_install(ws: WebSocket, upload: Upload) -> None:
    total = sum(int(part["size"]) for part in upload.parts)
    try:
        require_device()
        if upload.mode == "single" or len(upload.parts) == 1:
            install_single(ws, upload, total)
        else:
            install_split(ws, upload, total)
        ws.send_json(
            {
                "id": upload.request_id,
                "ok": True,
                "type": "install",
                "message": "App installed successfully.",
                "data": {},
            }
        )
    except BridgeError as error:
        ws.send_json(
            {
                "id": upload.request_id,
                "ok": False,
                "type": "install",
                "error": str(error),
                "code": error.code,
            }
        )
    except Exception as error:  # noqa: BLE001 - always answer the browser
        ws.send_json(
            {
                "id": upload.request_id,
                "ok": False,
                "type": "install",
                "error": f"Unexpected bridge error: {error}",
                "code": "INTERNAL",
            }
        )
    finally:
        upload.cancel()


# ---------------------------------------------------------------------------
# Client session
# ---------------------------------------------------------------------------
class Session:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.upload: Upload | None = None

    def handle_text(self, text: str) -> None:
        try:
            message = json.loads(text)
        except json.JSONDecodeError:
            self.ws.send_json(
                {"id": None, "ok": False, "error": "Invalid JSON message.", "code": "BAD_JSON"}
            )
            return

        request_id = str(message.get("id") or "unknown")
        command = str(message.get("type") or "")

        if command == "install":
            self.handle_install(message, request_id)
            return

        handlers: dict[str, Callable[[], dict[str, Any]]] = {
            "pair": lambda: command_pair(message),
            "connect": lambda: command_connect(message),
            "status": command_status,
            "info": command_info,
            "reboot": command_reboot,
        }
        handler = handlers.get(command)
        if not handler:
            self.reply(request_id, command, ok=False, error="Unknown command.", code="UNKNOWN")
            return

        try:
            result = handler()
            self.reply(request_id, command, ok=True, **result)
        except BridgeError as error:
            self.reply(request_id, command, ok=False, error=str(error), code=error.code)
        except Exception as error:  # noqa: BLE001
            self.reply(
                request_id, command, ok=False,
                error=f"Unexpected bridge error: {error}", code="INTERNAL",
            )

    def reply(self, request_id: str, command: str, ok: bool, **fields: Any) -> None:
        self.ws.send_json({"id": request_id, "ok": ok, "type": command, **fields})

    def handle_install(self, message: dict[str, Any], request_id: str) -> None:
        parts = message.get("parts")
        if not isinstance(parts, list) or not parts:
            self.reply(
                request_id, "install", ok=False,
                error="No app parts were announced.", code="BAD_UPLOAD",
            )
            return
        normalised = [
            {"name": safe_filename(part.get("name")), "size": int(part.get("size", 0))}
            for part in parts
        ]
        if any(part["size"] <= 0 for part in normalised):
            self.reply(
                request_id, "install", ok=False,
                error="An app part has an invalid size.", code="BAD_UPLOAD",
            )
            return

        mode = "split" if message.get("mode") == "split" or len(normalised) > 1 else "single"
        self.upload = Upload(request_id, mode, normalised)
        upload_progress(
            self.ws, request_id, "upload", 0,
            sum(part["size"] for part in normalised),
            "Waiting for app data…", True,
        )

    def handle_binary(self, payload: bytes) -> None:
        if self.upload is None or len(payload) < 3:
            return
        kind = payload[0]
        index = (payload[1] << 8) | payload[2]
        data = payload[3:]

        if kind == CHUNK_KIND_DATA:
            self.upload.write(index, data)
            self.try_upload_progress()
        elif kind == CHUNK_KIND_END:
            if self.upload.end_part(index):
                upload = self.upload
                self.upload = None
                threading.Thread(
                    target=perform_install, args=(self.ws, upload), daemon=True
                ).start()

    def try_upload_progress(self) -> None:
        if not self.upload:
            return
        received = sum(self.upload.received)
        total = sum(int(part["size"]) for part in self.upload.parts)
        upload_progress(
            self.ws, self.upload.request_id, "upload", received, total,
            "Sending app to the bridge…",
        )

    def cleanup(self) -> None:
        if self.upload:
            self.upload.cancel()
            self.upload = None


def serve_client(sock: socket.socket, allowed_origins: str, verbose: bool) -> None:
    try:
        ws = websocket_handshake(sock, allowed_origins)
        if ws is None:
            return
        session = Session(ws)
        fragments: list[bytes] = []
        fragment_opcode = 0
        if verbose:
            print("Client connected", flush=True)
        while True:
            try:
                fin, opcode, payload = ws.recv_frame()
            except (ConnectionError, OSError, ValueError):
                break

            if opcode == 0x9:  # ping
                ws.send_frame(payload, 0xA)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode == 0x8:  # close
                break

            if opcode == 0x0:  # continuation
                fragments.append(payload)
                if not fin:
                    continue
                complete = b"".join(fragments)
                complete_opcode = fragment_opcode
                fragments = []
                fragment_opcode = 0
            elif opcode in (0x1, 0x2):
                if not fin:
                    fragments = [payload]
                    fragment_opcode = opcode
                    continue
                complete = payload
                complete_opcode = opcode
            else:
                continue

            try:
                if complete_opcode == 0x1:
                    session.handle_text(complete.decode("utf-8", errors="replace"))
                elif complete_opcode == 0x2:
                    session.handle_binary(complete)
            except (ConnectionError, OSError):
                break
            except Exception as error:  # noqa: BLE001
                ws.send_json(
                    {
                        "id": None,
                        "ok": False,
                        "error": f"Bridge error: {error}",
                        "code": "INTERNAL",
                    }
                )
        session.cleanup()
        ws.close()
        if verbose:
            print("Client disconnected", flush=True)
    finally:
        try:
            sock.close()
        except OSError:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Sideload local ADB bridge for Termux")
    parser.add_argument("--host", default=os.environ.get("SIDELOAD_HOST", "127.0.0.1"))
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("SIDELOAD_PORT", "8765")),
    )
    parser.add_argument(
        "--allowed-origins",
        default=os.environ.get("SIDELOAD_ALLOWED_ORIGINS", DEFAULT_ORIGINS),
        help="Comma-separated Origin patterns allowed to use the bridge",
    )
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((args.host, args.port))
    server.listen(8)

    if not args.quiet:
        print(f"Sideload bridge listening on ws://{args.host}:{args.port}", flush=True)
        print("Press Ctrl+C to stop.", flush=True)

    try:
        while True:
            client, address = server.accept()
            client.settimeout(None)
            threading.Thread(
                target=serve_client,
                args=(client, args.allowed_origins, not args.quiet),
                daemon=True,
            ).start()
    except KeyboardInterrupt:
        if not args.quiet:
            print("\nBridge stopped.", flush=True)
    finally:
        server.close()


if __name__ == "__main__":
    main()
