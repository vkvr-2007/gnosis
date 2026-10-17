from datetime import datetime
from zoneinfo import ZoneInfo

from gnosis.conversation import Conversation, now_stamp


def test_stamp():
    t = datetime(2026, 10, 17, 18, 58, tzinfo=ZoneInfo("Asia/Kolkata"))
    assert now_stamp("Asia/Kolkata", t) == "[Now: Saturday 17 October 2026, 18:58 IST]"


def test_survives_restart_and_builds_model_messages(tmp_path):
    c = Conversation(tmp_path, history_messages=3)
    c.add("user", "one", ask="a")
    c.add("assistant", "first answer", ask="a")
    c.add("user", "two", ask="b")
    c.add("assistant", "second answer", ask="b")
    with c.path.open("a", encoding="utf-8") as f:
        f.write('{"role": "user", "cont')  # cut short by a crash
    c2 = Conversation(tmp_path, history_messages=3)
    assert [m["content"] for m in c2.messages] == ["one", "first answer", "two", "second answer"]
    msgs = c2.for_model("SYSTEM", "three?")
    assert msgs[0] == {"role": "system", "content": "SYSTEM"}
    # Last 3 would start with an answer, which is dropped so the history starts with a question
    assert [m["content"] for m in msgs[1:-1]] == ["two", "second answer"]
    assert msgs[-1]["role"] == "user" and msgs[-1]["content"].startswith("[Now: ")
    assert msgs[-1]["content"].endswith("] three?")


def test_new_chat_keeps_the_old_one_on_disk(tmp_path):
    c = Conversation(tmp_path)
    c.add("user", "hello")
    c.clear()
    assert c.messages == [] and not c.path.exists()
    assert len(list(tmp_path.glob("conversation-*.jsonl"))) == 1
    assert Conversation(tmp_path).messages == []
