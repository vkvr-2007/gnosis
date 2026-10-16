import asyncio
import os

from gnosis.core.policy import ALLOW, ASK, DENY, ApprovalManager, Policy


def make():
    return Policy({
        "default": "ask",
        "tools": {"get_time": "allow", "read_file": "allow", "purchase": "deny", "write_file": "ask"},
        "filesystem": {"read": ["~/Documents"], "write": ["~/Documents/Gnosis"], "deny": ["~/.ssh"]},
    })


def test_tool_actions():
    p = make()
    assert p.decide("get_time").action == ALLOW
    assert p.decide("purchase").action == DENY
    assert p.decide("unknown_tool").action == ASK


def test_paths():
    p = make()
    assert p.decide("read_file", {"path": "~/Documents/notes.txt"}).action == ALLOW
    assert p.decide("read_file", {"path": "~/Pictures/x.png"}).action == ASK
    assert p.decide("read_file", {"path": "~/.ssh/id_rsa"}).action == DENY
    # A sibling folder that only shares a prefix is not inside the allowed root.
    assert p.decide("read_file", {"path": "~/Documents-old/x"}).action == ASK
    assert p.decide("read_file", {"path": os.path.expanduser("~/Documents/../.ssh/key")}).action == DENY


def test_approvals_resolve_and_time_out():
    async def run():
        m = ApprovalManager()
        a = m.create("send_message", {}, "why")
        asyncio.get_running_loop().call_later(0.01, m.resolve, a.id, True)
        assert await m.wait(a, 1) is True
        b = m.create("send_message", {}, "why")
        assert await m.wait(b, 0.01) is False
        assert m.pending == {}
    asyncio.run(run())
