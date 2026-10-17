"""Coding agent tools: build a project from scratch in the sandbox, then publish it to GitHub and Vercel.

The model works in a loop: create the project, write files, run the build or tests, read the errors,
fix, and repeat. Pushing and deploying ask the owner once per project.
"""

from __future__ import annotations

import asyncio
import os
import re
import shlex
import shutil
import subprocess
from typing import Any

from gnosis.coder.sandbox import Sandbox, SandboxError, WSLSandbox, check_project
from gnosis.core.tools import ToolRegistry

TEMPLATES = {
    "vite-react": "npm create vite@latest {name} -- --template react-ts && cd {name} && npm install",
    "vite-vanilla": "npm create vite@latest {name} -- --template vanilla-ts && cd {name} && npm install",
    "static": "mkdir -p {name} && cd {name} && printf '<!doctype html>\\n<title>{name}</title>\\n' > index.html",
    "python": "mkdir -p {name} && cd {name} && python3 -m venv .venv && printf '.venv/\\n__pycache__/\\n' > .gitignore",
    "empty": "mkdir -p {name}",
}
_URL = re.compile(r"https://[a-z0-9.-]+\.vercel\.app\S*", re.I)
_PROJECT_ARG = {"project": {"type": "string", "description": "Project name, e.g. 'ember-coffee'"}}


def _schema(props: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {"type": "object", "properties": {**_PROJECT_ARG, **props}, "required": ["project", *required]}


def register_coder_tools(registry: ToolRegistry, sandbox: Sandbox, notifier: Any = None,
                         isolated: bool | None = None) -> None:
    """`isolated`: whether commands are kept away from the owner's files (the WSL distro, or a container)."""
    if isolated is None:
        isolated = isinstance(sandbox, WSLSandbox)

    async def run(*args, **kwargs):
        return await asyncio.to_thread(*args, **kwargs)

    def unsandboxed(_args: dict) -> str | None:
        return None if isolated else "this runs on this computer itself, not in an isolated sandbox"

    def project_scope(args: dict) -> str:
        return f"project {args.get('project', '?')}"

    @registry.tool("code_new_project",
                   "Start a new coding project in Gnosis's sandbox. Templates: vite-react (React + TypeScript "
                   "website), vite-vanilla, static (plain HTML), python, empty. Then write files, run the build, "
                   "fix errors, and repeat until it works.",
                   _schema({"template": {"type": "string", "enum": list(TEMPLATES)}}, ["template"]))
    async def code_new_project(project: str, template: str) -> dict:
        check_project(project)
        if await run(sandbox.exists, project):
            return {"error": f"A project called '{project}' already exists. Pick another name or keep working on it."}
        r = await run(sandbox.run, None, TEMPLATES[template].format(name=project), 600)
        if r.code != 0:
            return {"error": "Setting up the project failed", **r.to_dict()}
        files = await run(sandbox.run, project, "find . -path ./node_modules -prune -o -path ./.venv -prune -o "
                                                "-type f -print | sort | head -50", 30)
        return {"created": project, "where": sandbox.label, "files": files.output.split()}

    @registry.tool("code_write_file", "Create or overwrite a file in a project with its full contents.",
                   _schema({"path": {"type": "string"}, "content": {"type": "string"}}, ["path", "content"]))
    async def code_write_file(project: str, path: str, content: str) -> str:
        await run(sandbox.write, project, path, content)
        return f"Wrote {path} ({len(content)} characters)"

    @registry.tool("code_edit_file", "Replace one exact piece of text in a file (it must appear exactly once).",
                   _schema({"path": {"type": "string"}, "old": {"type": "string"}, "new": {"type": "string"}},
                           ["path", "old", "new"]))
    async def code_edit_file(project: str, path: str, old: str, new: str) -> dict:
        text = await run(sandbox.read, project, path, 2_000_000)
        count = text.count(old)
        if count != 1:
            return {"error": f"The text to replace appears {count} times in {path}; it must appear exactly once"}
        await run(sandbox.write, project, path, text.replace(old, new))
        return {"edited": path}

    @registry.tool("code_read_file", "Read a file in a project.",
                   _schema({"path": {"type": "string"}}, ["path"]))
    async def code_read_file(project: str, path: str) -> str:
        return await run(sandbox.read, project, path)

    @registry.tool("code_list_files", "List a project's files (without node_modules and .venv).",
                   _schema({}, []))
    async def code_list_files(project: str) -> list[str]:
        r = await run(sandbox.run, project, "find . -path ./node_modules -prune -o -path ./.venv -prune -o "
                                            "-path ./.git -prune -o -type f -print | sort | head -300", 30)
        if r.code != 0:
            raise SandboxError(r.output.strip())
        return r.output.split()

    @registry.tool("code_run",
                   "Run a shell command inside a project in the sandbox, e.g. 'npm run build', 'npm install zod', "
                   "'pytest'. Returns the exit code and the end of the output. Don't start servers that never exit.",
                   _schema({"command": {"type": "string"},
                            "timeout_s": {"type": "integer", "description": "Default 300"}}, ["command"]),
                   escalate=unsandboxed)
    async def code_run(project: str, command: str, timeout_s: int = 300) -> dict:
        return (await run(sandbox.run, project, command, min(max(int(timeout_s), 5), 1800))).to_dict()

    @registry.tool("code_open_in_vscode", "Open the project in VS Code on the laptop so the owner can watch.",
                   _schema({}, []))
    async def code_open_in_vscode(project: str) -> str:
        check_project(project)
        code = shutil.which("code")
        if code is None:
            return "VS Code isn't installed (or `code` isn't on PATH)"
        if isinstance(sandbox, WSLSandbox):
            home = (await run(sandbox.run, None, "echo $HOME", 30)).output.strip()
            args = [code, "--remote", f"wsl+{sandbox.distro}", f"{home}/gnosis-workspace/{project}"]
        else:
            args = [code, shlex.split(sandbox.root)[0] + "/" + project]
        subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return f"Opened {project} in VS Code"

    @registry.tool("git_push",
                   "Commit the project and push it to a new or existing GitHub repository (the owner's account). "
                   "Needs the GH_TOKEN environment variable on the laptop.",
                   _schema({"message": {"type": "string", "description": "Commit message"},
                            "private": {"type": "boolean", "description": "Make a new repo private (default true)"}},
                           ["message"]),
                   approval_scope=project_scope)
    async def git_push(project: str, message: str, private: bool = True) -> dict:
        token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
        if not token:
            return {"error": "Set a GitHub token first: a GH_TOKEN user environment variable on the laptop"}
        visibility = "--private" if private else "--public"
        script = (
            "git init -q -b main 2>/dev/null || true; "
            "git config user.name >/dev/null || git config user.name Gnosis; "
            "git config user.email >/dev/null || git config user.email gnosis@localhost; "
            "[ -f .gitignore ] || printf 'node_modules/\\n.venv/\\ndist/\\n.env\\n.vercel/\\n' > .gitignore; "
            f"git add -A && (git diff --cached --quiet || git commit -q -m {shlex.quote(message)}); "
            "if git remote get-url origin >/dev/null 2>&1; then gh auth setup-git && git push -u origin HEAD; "
            f"else gh repo create {shlex.quote(project)} {visibility} --source . --push; fi; "
            "gh repo view --json url -q .url"
        )
        r = await run(sandbox.run, project, script, 300, env={"GH_TOKEN": token})
        if r.code != 0:
            return {"error": "Pushing to GitHub failed", **r.to_dict()}
        return {"pushed": project, "repo": r.output.strip().splitlines()[-1]}

    @registry.tool("deploy",
                   "Deploy a website project to Vercel (production) and get its public URL. Run the build first "
                   "and fix any errors. Needs the VERCEL_TOKEN environment variable on the laptop.",
                   _schema({}, []), approval_scope=project_scope)
    async def deploy(project: str) -> dict:
        token = os.environ.get("VERCEL_TOKEN")
        if not token:
            return {"error": "Set a Vercel token first: a VERCEL_TOKEN user environment variable on the laptop"}
        r = await run(sandbox.run, project, 'npx --yes vercel@latest deploy --prod --yes --token "$VERCEL_TOKEN"',
                      900, env={"VERCEL_TOKEN": token})
        urls = _URL.findall(r.output)
        if r.code != 0 or not urls:
            return {"error": "The deploy failed", **r.to_dict()}
        url = urls[-1].rstrip(".,)")
        if notifier is not None:
            from gnosis.proactive import Notice

            await notifier.notify(Notice("It's live", f"{project} is live at {url}", "high", "deploy"))
        return {"deployed": project, "url": url}
