"""Where Gnosis's code runs: a dedicated WSL2 distro on Windows, or a plain workspace folder elsewhere.

On Windows, `scripts/setup_wsl.ps1` creates a separate "Gnosis" distro with Windows drives not mounted
and Windows programs not callable, so code Gnosis writes and runs can't touch your Windows files.
Every project lives in ~/gnosis-workspace/<project> inside it.
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

_PROJECT = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
MAX_OUTPUT = 6000


class SandboxError(RuntimeError):
    pass


@dataclass
class RunResult:
    code: int
    output: str          # stdout and stderr together, trimmed to the end (where errors usually are)
    timed_out: bool = False

    def to_dict(self) -> dict:
        out = {"exit_code": self.code, "output": self.output}
        if self.timed_out:
            out["timed_out"] = True
        return out


def check_project(name: str) -> str:
    if not _PROJECT.match(name or ""):
        raise SandboxError("Project names use lowercase letters, digits and dashes, e.g. 'ember-coffee'")
    return name


def check_path(path: str) -> str:
    """A file path inside the project: relative, no '..'."""
    p = PurePosixPath(path.replace("\\", "/"))
    if not path or p.is_absolute() or ".." in p.parts:
        raise SandboxError(f"'{path}' must be a path inside the project, like 'src/App.tsx'")
    return str(p)


def _tail(data: bytes) -> str:
    text = data.decode("utf-8", errors="replace")
    return text if len(text) <= MAX_OUTPUT else "[... earlier output cut]\n" + text[-MAX_OUTPUT:]


class Sandbox:
    root = "~/gnosis-workspace"
    label = "sandbox"

    def _exec(self, script: str, timeout: float, stdin: bytes | None, env: dict[str, str]) -> subprocess.CompletedProcess:
        raise NotImplementedError

    def run(self, project: str | None, command: str, timeout: float = 300, stdin: bytes | None = None,
            env: dict[str, str] | None = None) -> RunResult:
        where = self.root + ("/" + shlex.quote(check_project(project)) if project else "")
        # `timeout` inside the sandbox, so a stuck command is really stopped there.
        script = (f"mkdir -p {self.root} && cd {where} && "
                  f"timeout -k 5 {int(timeout)} bash -c {shlex.quote(command)}")
        try:
            out = self._exec(script, timeout + 30, stdin, env or {})
        except subprocess.TimeoutExpired:
            return RunResult(124, "Timed out", True)
        except FileNotFoundError as e:
            raise SandboxError(f"The sandbox isn't set up ({e}). Run scripts\\setup_wsl.ps1.") from None
        return RunResult(out.returncode, _tail(out.stdout), out.returncode == 124)

    def write(self, project: str, path: str, content: str) -> None:
        path = check_path(path)
        parent = str(PurePosixPath(path).parent)
        r = self.run(project, f"mkdir -p {shlex.quote(parent)} && cat > {shlex.quote(path)}", 30,
                     stdin=content.encode("utf-8"))
        if r.code != 0:
            raise SandboxError(r.output.strip() or f"Couldn't write {path}")

    def read(self, project: str, path: str, limit: int = 60_000) -> str:
        path = check_path(path)
        r = self.run(project, f"head -c {int(limit)} {shlex.quote(path)}", 30)
        if r.code != 0:
            raise SandboxError(r.output.strip() or f"Couldn't read {path}")
        return r.output

    def exists(self, project: str) -> bool:
        check_project(project)
        return self.run(None, f"test -d {shlex.quote(project)}", 30).code == 0


class LocalSandbox(Sandbox):
    """A workspace folder on this machine (Linux/macOS, and the hosted demo inside its container).

    Commands get a minimal environment (no API keys) but this is not isolation by itself.
    """

    label = "local workspace"

    def __init__(self, root: Path):
        self.root = shlex.quote(str(root))

    def _exec(self, script, timeout, stdin, env):
        base = {k: os.environ[k] for k in ("PATH", "HOME", "LANG", "TERM", "TMPDIR") if k in os.environ}
        return subprocess.run(["bash", "-c", script], input=stdin, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              timeout=timeout, env={**base, **env})


class WSLSandbox(Sandbox):
    label = "WSL2"

    def __init__(self, distro: str = "Gnosis"):
        self.distro = distro

    def _exec(self, script, timeout, stdin, env):
        # Only the variables named in WSLENV cross into Linux, so other Windows secrets stay out.
        full_env = {**os.environ, **env, "WSLENV": ":".join(f"{k}/u" for k in env)}
        return subprocess.run(["wsl.exe", "-d", self.distro, "--", "bash", "-lc", script], input=stdin,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout, env=full_env)


def default_sandbox(data_dir: Path, distro: str = "Gnosis") -> Sandbox:
    if sys.platform == "win32":
        return WSLSandbox(distro)
    root = data_dir / "workspace"
    root.mkdir(parents=True, exist_ok=True)
    return LocalSandbox(root)
