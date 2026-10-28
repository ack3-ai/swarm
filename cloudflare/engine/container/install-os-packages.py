#!/usr/bin/python3 -I
"""Install literal packages from the image's configured OS repositories only.

The agent may invoke this helper via sudo; it cannot choose APT options,
repositories, package files, environment variables, or arbitrary root commands.
"""

import os
import re
import signal
import subprocess
import sys


APT_ENV = {
    "PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME": "/root",
    "DEBIAN_FRONTEND": "noninteractive",
    "APT_LISTCHANGES_FRONTEND": "none",
    "LC_ALL": "C",
}
PACKAGE = re.compile(r"[a-z0-9][a-z0-9+.-]{0,127}\Z", re.ASCII)


def run(command, seconds):
    process = subprocess.Popen(
        command,
        cwd="/",
        env=APT_ENV,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        return process.wait(timeout=seconds)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        raise RuntimeError("OS package operation exceeded its time limit") from None


def main():
    names = sys.argv[1:]
    if not 1 <= len(names) <= 8:
        raise ValueError("specify 1 to 8 literal OS package names")
    for name in names:
        if not PACKAGE.fullmatch(name) or name.endswith(("+", "-")) or ".." in name:
            raise ValueError("invalid OS package name")
    if os.geteuid() != 0:
        raise PermissionError("run through the installed passwordless sudo rule")
    if run(["/usr/bin/apt-get", "update", "-o", "Acquire::Retries=1"], 120) != 0:
        raise RuntimeError("configured OS repository refresh failed")
    for name in names:
        result = subprocess.run(
            ["/usr/bin/apt-cache", "show", "--no-all-versions", name],
            cwd="/", env=APT_ENV, stdin=subprocess.DEVNULL,
            capture_output=True, text=True, timeout=10,
        )
        records = re.findall(r"^Package: (.+)$", result.stdout, re.MULTILINE)
        if result.returncode != 0 or not records or any(value != name for value in records):
            raise ValueError("requested package is not an exact configured-repository name")
    if run([
        "/usr/bin/apt-get", "install", "--yes", "--no-install-recommends",
        "--no-remove", "--no-upgrade", "--", *names,
    ], 240) != 0:
        raise RuntimeError("configured OS package install failed")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, PermissionError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"OS package installation unavailable: {error}", file=sys.stderr)
        sys.exit(1)
