"""Tool registry. Every skill exposes its abilities as tools with a JSON schema."""

from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

ToolFunc = Callable[..., Any | Awaitable[Any]]


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    func: ToolFunc
    # Privacy tags on the tool's output; tagged results keep the rest of the task on the local model.
    tags: tuple[str, ...] = field(default_factory=tuple)
    # For "ask_once" tools: what an approval covers, e.g. the app a screenshot would show.
    approval_scope: Callable[[dict[str, Any]], str | Awaitable[str]] | None = None
    # Lets an allowed call ask anyway when this particular use is risky (e.g. clicking "Send").
    # Returns the reason to ask, or None.
    escalate: Callable[[dict[str, Any]], str | None] | None = None

    def schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }

    async def run(self, **kwargs: Any) -> Any:
        result = self.func(**kwargs)
        if inspect.isawaitable(result):
            result = await result
        return result


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> Tool:
        if tool.name in self._tools:
            raise ValueError(f"Tool '{tool.name}' is already registered")
        self._tools[tool.name] = tool
        return tool

    def tool(self, name: str, description: str, parameters: dict[str, Any] | None = None,
             tags: tuple[str, ...] = (), approval_scope=None, escalate=None):
        """Decorator form of register()."""
        def wrap(func: ToolFunc) -> ToolFunc:
            self.register(Tool(name, description,
                               parameters or {"type": "object", "properties": {}},
                               func, tags, approval_scope, escalate))
            return func
        return wrap

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def schemas(self) -> list[dict[str, Any]]:
        return [t.schema() for t in self._tools.values()]

    def names(self) -> list[str]:
        return list(self._tools)
