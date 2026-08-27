#!/usr/bin/env python3
"""Run the Waitress application and its local Caddy TLS proxy as one service."""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import time
import ctypes
from ctypes import wintypes
from datetime import datetime
from pathlib import Path


APP_DIRECTORY = Path(__file__).resolve().parent
PYTHON = APP_DIRECTORY / ".venv" / "Scripts" / "python.exe"
CADDY = APP_DIRECTORY / "runtime" / "caddy" / "caddy.exe"
CADDYFILE = APP_DIRECTORY / "Caddyfile"
LOG_DIRECTORY = APP_DIRECTORY / "logs"
# The scheduled task redirects the supervisor's own output to aim_startup.log
# and holds that file exclusively on Windows. Child processes use a separate log.
LOG_FILE = LOG_DIRECTORY / "aim_runtime.log"
WAITRESS_HOST = "127.0.0.1"
WAITRESS_PORT = 5055
STARTUP_TIMEOUT_SECONDS = 120
SHUTDOWN_TIMEOUT_SECONDS = 10
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000


class _JobObjectBasicLimitInformation(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _IoCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class _JobObjectExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JobObjectBasicLimitInformation),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class _WindowsProcessJob:
    """Own child processes so Task Scheduler End terminates the whole stack."""

    def __init__(self) -> None:
        self._handle = None
        if os.name != "nt":
            return

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        self._kernel32 = kernel32

        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())

        information = _JobObjectExtendedLimitInformation()
        information.BasicLimitInformation.LimitFlags = (
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        )
        if not kernel32.SetInformationJobObject(
            handle,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            ctypes.byref(information),
            ctypes.sizeof(information),
        ):
            error = ctypes.WinError(ctypes.get_last_error())
            kernel32.CloseHandle(handle)
            raise error
        self._handle = handle

    def add(self, process: subprocess.Popen) -> None:
        if self._handle is None:
            return
        if not self._kernel32.AssignProcessToJobObject(
            self._handle, wintypes.HANDLE(process._handle)
        ):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self) -> None:
        if self._handle is not None:
            self._kernel32.CloseHandle(self._handle)
            self._handle = None


def _require_file(path: Path, description: str) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"{description} was not found at {path}")


def _wait_for_listener(process: subprocess.Popen, host: str, port: int) -> None:
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        return_code = process.poll()
        if return_code is not None:
            raise RuntimeError(
                f"Waitress exited during startup with status {return_code}"
            )
        try:
            with socket.create_connection((host, port), timeout=1):
                return
        except OSError:
            time.sleep(0.5)
    raise TimeoutError(
        f"Waitress did not listen on {host}:{port} within "
        f"{STARTUP_TIMEOUT_SECONDS} seconds"
    )


def _stop_process(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=SHUTDOWN_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=SHUTDOWN_TIMEOUT_SECONDS)


def main() -> int:
    _require_file(PYTHON, "Virtual-environment Python")
    _require_file(CADDY, "Caddy")
    _require_file(CADDYFILE, "Caddy configuration")

    LOG_DIRECTORY.mkdir(parents=True, exist_ok=True)
    app_environment = os.environ.copy()
    app_environment.update(
        {
            "APP_ENV": app_environment.get("APP_ENV", "production"),
            "ENABLE_HTTPS": "0",
            "EXTERNAL_HTTPS": "1",
            "HOST": WAITRESS_HOST,
            "PORT": str(WAITRESS_PORT),
            "SERVER_BACKEND": "waitress",
            "WAITRESS_THREADS": app_environment.get("WAITRESS_THREADS", "32"),
            "WAITRESS_CHANNEL_TIMEOUT": app_environment.get(
                "WAITRESS_CHANNEL_TIMEOUT", "120"
            ),
            "WAITRESS_TRUSTED_PROXY": WAITRESS_HOST,
        }
    )

    storage_root = app_environment.get("SHOWBASE_STORAGE_ROOT")
    if not storage_root:
        app_environment["SHOWBASE_STORAGE_ROOT"] = str(
            APP_DIRECTORY.parent / "showbase-storage"
        )

    waitress_process = None
    caddy_process = None
    process_job = _WindowsProcessJob()
    stop_requested = False

    def request_stop(_signum, _frame):
        nonlocal stop_requested
        stop_requested = True

    for signal_name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        if hasattr(signal, signal_name):
            signal.signal(getattr(signal, signal_name), request_stop)

    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)

    with LOG_FILE.open("a", encoding="utf-8", buffering=1) as log:
        log.write("=" * 60 + "\n")
        log.write(f"Starting Showbase HTTPS stack: {datetime.now().isoformat()}\n")
        log.flush()

        validation = subprocess.run(
            [str(CADDY), "validate", "--config", str(CADDYFILE), "--adapter", "caddyfile"],
            cwd=APP_DIRECTORY,
            stdout=log,
            stderr=subprocess.STDOUT,
            creationflags=creation_flags,
            check=False,
        )
        if validation.returncode:
            log.write(f"Caddy configuration validation failed: {validation.returncode}\n")
            return validation.returncode

        try:
            waitress_process = subprocess.Popen(
                [str(PYTHON), str(APP_DIRECTORY / "app.py")],
                cwd=APP_DIRECTORY,
                env=app_environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                creationflags=creation_flags,
            )
            process_job.add(waitress_process)
            _wait_for_listener(waitress_process, WAITRESS_HOST, WAITRESS_PORT)
            log.write(
                f"Waitress is ready on http://{WAITRESS_HOST}:{WAITRESS_PORT}\n"
            )
            log.flush()

            caddy_process = subprocess.Popen(
                [str(CADDY), "run", "--config", str(CADDYFILE), "--adapter", "caddyfile"],
                cwd=APP_DIRECTORY,
                stdout=log,
                stderr=subprocess.STDOUT,
                creationflags=creation_flags,
            )
            process_job.add(caddy_process)

            while not stop_requested:
                waitress_status = waitress_process.poll()
                caddy_status = caddy_process.poll()
                if waitress_status is not None:
                    log.write(f"Waitress exited unexpectedly: {waitress_status}\n")
                    return waitress_status or 1
                if caddy_status is not None:
                    log.write(f"Caddy exited unexpectedly: {caddy_status}\n")
                    return caddy_status or 1
                time.sleep(1)
            return 0
        except Exception as exc:
            log.write(f"HTTPS stack failed: {exc}\n")
            return 1
        finally:
            _stop_process(caddy_process)
            _stop_process(waitress_process)
            process_job.close()
            log.write(f"Stopped Showbase HTTPS stack: {datetime.now().isoformat()}\n")


if __name__ == "__main__":
    raise SystemExit(main())
