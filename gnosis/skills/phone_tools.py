"""Tools for the owner's Android phone: calls, messages, apps, notifications and contacts."""

from __future__ import annotations

import asyncio
import functools
import re
from typing import Any

from gnosis.core.tools import ToolRegistry
from gnosis.phone.adb import Phone, normalize_number

PHONE_NUMBER = "phone_number"  # Memory predicate for a contact's number


def find_contact(memory: Any, who: str) -> tuple[str, str] | list[str] | None:
    """Looks `who` up in synced contacts: (name, number), a list of close names if unclear, or None."""
    contacts = [(f.subject, f.value) for f in memory.store.facts() if f.predicate == PHONE_NUMBER]
    q = who.strip().lower()
    exact = [c for c in contacts if c[0].lower() == q]
    if len(exact) == 1:
        return exact[0]
    words = set(re.findall(r"\w+", q))
    partial = [c for c in contacts if words and words <= set(re.findall(r"\w+", c[0].lower()))]
    if len(partial) == 1:
        return partial[0]
    if partial:
        return sorted(c[0] for c in partial)[:5]
    return None


def register_phone_tools(registry: ToolRegistry, phone: Phone, memory: Any) -> None:
    # One task at a time drives the phone's screen.
    tool = functools.partial(registry.tool, resource="phone")

    async def run(fn, *args):
        return await asyncio.to_thread(fn, *args)

    def resolve(who: str) -> tuple[str, str] | dict:
        try:
            return who, normalize_number(who)
        except ValueError:
            pass
        found = find_contact(memory, who)
        if isinstance(found, tuple):
            return found
        if isinstance(found, list):
            return {"error": f"Which one do you mean: {', '.join(found)}?"}
        return {"error": f"I don't have a number for '{who}'. Ask me to sync your phone contacts, "
                         "or tell me the number."}

    @tool("phone_status", "Check that the phone is connected, and its battery.")
    async def phone_status() -> dict:
        return await run(phone.status)

    @tool("call", "Call someone from the owner's Android phone, by contact name or number.",
          {"type": "object", "properties": {"who": {"type": "string"}}, "required": ["who"]})
    async def call(who: str) -> dict:
        target = resolve(who)
        if isinstance(target, dict):
            return target
        name, number = target
        await run(phone.call, number)
        return {"calling": name}  # The number stays out of the reply

    @tool("end_call", "Hang up the current call on the phone.")
    async def end_call() -> str:
        return await run(phone.end_call)

    @tool("send_sms", "Send a text message (SMS) from the phone.",
          {"type": "object", "properties": {"to": {"type": "string", "description": "Contact name or number"},
                                            "text": {"type": "string"}}, "required": ["to", "text"]})
    async def send_sms(to: str, text: str) -> dict:
        target = resolve(to)
        if isinstance(target, dict):
            return target
        result = await run(phone.send_sms, target[1], text)
        return {"result": result.replace(target[1], target[0])}

    @tool("send_whatsapp", "Send a WhatsApp message from the phone.",
          {"type": "object", "properties": {"to": {"type": "string", "description": "Contact name or number"},
                                            "text": {"type": "string"}}, "required": ["to", "text"]})
    async def send_whatsapp(to: str, text: str) -> dict:
        target = resolve(to)
        if isinstance(target, dict):
            return target
        result = await run(phone.send_whatsapp, target[1], text)
        return {"result": result.replace("+" + target[1].lstrip("+"), target[0])}

    @tool("phone_open_app", "Open an app on the phone, e.g. 'YouTube' or 'Maps'.",
          {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]})
    async def phone_open_app(name: str) -> str:
        return await run(phone.open_app, name)

    @tool("phone_notifications", "Read the notifications on the phone (stays on this laptop).",
          tags=("phone_data",))
    async def phone_notifications() -> list[dict]:
        return (await run(phone.notifications))[:30]

    @tool("sync_contacts", "Copy the phone's contacts into Gnosis's local memory so it can call and message "
                           "people by name.")
    async def sync_contacts() -> dict:
        contacts = await run(phone.contacts)
        for name, number in contacts:
            memory.store.upsert_fact(name, PHONE_NUMBER, number, source="phone", confidence=1.0, sensitive=True)
        return {"synced": len(contacts)}
