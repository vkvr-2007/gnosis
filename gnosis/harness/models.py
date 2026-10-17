"""`gnosis check-models`: does each model role call tools properly before Gnosis relies on it?

Every role that takes tools gets the same three cases: a tool with no arguments, one with a string
argument, and one with several; then it must turn a tool result into a plain answer. This catches what
broke in testing: a chat template that never closed its tool calls, a model ID the key can't use, and
answers that leaked <think> blocks or memory ids.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any

from gnosis.core.llm import LLMClient
from gnosis.core.model_router import ModelRouter

TOOLS = [
    {"type": "function", "function": {"name": "get_time", "description": "Current local date, time and timezone.",
                                      "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {"name": "open_app", "description": "Open an app installed on this PC by name.",
                                      "parameters": {"type": "object", "properties": {"name": {"type": "string"}},
                                                     "required": ["name"]}}},
    {"type": "function", "function": {
        "name": "remember", "description": "Save a durable fact the owner asked you to remember.",
        "parameters": {"type": "object", "properties": {
            "subject": {"type": "string", "description": "'owner' for the owner"},
            "predicate": {"type": "string", "description": "Short snake_case relation, e.g. prefers_language"},
            "value": {"type": "string"}}, "required": ["subject", "predicate", "value"]}}},
]
SYSTEM = "You are Gnosis, a personal assistant on the owner's laptop. Act through tools. Be brief."


@dataclass
class Case:
    ask: str
    tool: str
    args_ok: Any  # callable(dict) -> bool
    result: str
    answer_has: str


CASES = [
    Case("What time is it?", "get_time", lambda a: True,
         "Saturday 17 October 2026, 18:01 (India Standard Time)", "18:01|6:01"),
    Case("Open Notepad.", "open_app", lambda a: "notepad" in str(a.get("name", "")).lower(),
         '{"opened": "Notepad", "window": "Untitled - Notepad"}', "notepad"),
    Case("Remember that I prefer TypeScript.", "remember",
         lambda a: "typescript" in str(a.get("value", "")).lower(),
         '{"saved": "owner prefers_language: TypeScript", "id": 1}', "typescript"),
]


@dataclass
class RoleReport:
    role: str
    model: str
    passed: int = 0
    failures: list[str] = field(default_factory=list)
    latencies_ms: list[int] = field(default_factory=list)


async def _run_case(client: LLMClient, role: str, case: Case, report: RoleReport) -> None:
    messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": case.ask}]
    started = time.monotonic()
    try:
        first = await client.chat(role, messages, tools=TOOLS)
    except Exception as e:
        report.failures.append(f"{case.ask!r}: the model call failed: {type(e).__name__}: {e}")
        return
    calls = first.message.tool_calls or []
    if not calls or calls[0].function.name != case.tool:
        said = (first.message.content or "").strip()[:120]
        report.failures.append(f"{case.ask!r}: expected a {case.tool} call, got "
                               f"{calls[0].function.name if calls else 'no tool call'} ({said!r})")
        return
    try:
        args = json.loads(calls[0].function.arguments or "{}")
    except ValueError:
        report.failures.append(f"{case.ask!r}: tool arguments aren't JSON: {calls[0].function.arguments!r}")
        return
    if not case.args_ok(args):
        report.failures.append(f"{case.ask!r}: wrong arguments {args}")
        return
    messages += [
        {"role": "assistant", "content": first.message.content or "", "tool_calls": [
            {"id": calls[0].id, "type": "function",
             "function": {"name": calls[0].function.name, "arguments": calls[0].function.arguments}}]},
        {"role": "tool", "tool_call_id": calls[0].id, "content": case.result},
    ]
    try:
        final = await client.chat(role, messages, tools=TOOLS)
    except Exception as e:
        report.failures.append(f"{case.ask!r}: the answer call failed: {type(e).__name__}: {e}")
        return
    report.latencies_ms.append(int((time.monotonic() - started) * 1000))
    answer = (final.message.content or "").strip()
    problems = []
    if final.message.tool_calls:
        problems.append("called another tool instead of answering")
    if not any(w in answer.lower() for w in case.answer_has.lower().split("|")):
        problems.append(f"answer doesn't use the tool result ({answer[:100]!r})")
    if "<think>" in answer or "[#" in answer:
        problems.append(f"answer leaks internal text ({answer[:100]!r})")
    if problems:
        report.failures.append(f"{case.ask!r}: " + "; ".join(problems))
    else:
        report.passed += 1


async def check_models(models_cfg: dict[str, Any], roles: list[str] | None = None) -> list[RoleReport]:
    router = ModelRouter(models_cfg)
    client = LLMClient(router)
    tool_roles = [r for r in router.roles if r not in ("embed", "vision")]
    reports = []
    for role in roles or tool_roles:
        report = RoleReport(role, router.roles[role]["model"])
        for case in CASES:
            await _run_case(client, role, case, report)
        reports.append(report)
    return reports


def print_reports(reports: list[RoleReport]) -> bool:
    ok = True
    for r in reports:
        status = "PASS" if not r.failures else "FAIL"
        ok &= not r.failures
        lat = f"{sorted(r.latencies_ms)[len(r.latencies_ms) // 2] / 1000:.1f} s median" if r.latencies_ms else "-"
        print(f"{status}  {r.role:<8} {r.model:<45} {r.passed}/{len(CASES)}  {lat}")
        for f in r.failures:
            print(f"        {f}")
    return ok


def main(models_cfg: dict[str, Any], roles: list[str] | None) -> bool:
    return print_reports(asyncio.run(check_models(models_cfg, roles)))
