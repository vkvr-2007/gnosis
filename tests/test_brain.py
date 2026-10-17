import random

import httpx
import openai
import pytest

from conftest import FakeClient, brain_with
from gnosis.brain import Brain, BrainError, ThinkFilter

REQ = httpx.Request("POST", "https://example.invalid/v1/chat/completions")


def status_error(cls, code, message="nope"):
    return cls(message, response=httpx.Response(code, request=REQ), body=None)


def run_filter(pieces):
    f = ThinkFilter()
    return "".join(f.feed(p) for p in pieces) + f.flush()


@pytest.mark.parametrize("pieces, expected", [
    (["Hello", " there."], "Hello there."),
    (["<think>plan</think>", "\n\nAnswer."], "Answer."),
    (["<th", "ink>secret", " stuff</thi", "nk>Answer", " here."], "Answer here."),
    (["reasoning the template opened</think>", "Answer."], "reasoning the template openedAnswer."),
    (["A <b> tag stays", "."], "A <b> tag stays."),
    (["Unfinished <think>never closed"], "Unfinished "),
    (["   ", "\n", "Hi"], "Hi"),
])
def test_think_filter(pieces, expected):
    assert run_filter(pieces) == expected


def test_think_filter_any_split():
    text = "<think>step one, step two</think>The answer is 42. <think>more</think>Done."
    rng = random.Random(7)
    for _ in range(200):
        cuts = sorted(rng.sample(range(1, len(text)), rng.randint(1, 12)))
        pieces = [text[a:b] for a, b in zip([0, *cuts], [*cuts, len(text)])]
        assert run_filter(pieces) == "The answer is 42. Done."


async def test_stream_yields_answer_and_turns_thinking_off(settings):
    brain = brain_with(settings, ["<think>x</think>", "Hi", " there."])
    assert [p async for p in brain.stream([{"role": "user", "content": "hi"}])] == ["Hi", " there."]
    req = brain.client.requests[0]
    assert req["stream"] is True and req["model"] == settings.brain.model
    assert req["extra_body"] == {"chat_template_kwargs": {"enable_thinking": False}}


@pytest.mark.parametrize("error, words", [
    (status_error(openai.AuthenticationError, 401), "rejected the key in GNOSIS_TEST_KEY"),
    (status_error(openai.NotFoundError, 404), "isn't available"),
    (status_error(openai.RateLimitError, 429), "too many requests"),
    (status_error(openai.InternalServerError, 503), "status 503"),
    (openai.APIConnectionError(request=REQ), "couldn't reach"),
    (openai.APITimeoutError(request=REQ), "within 60 seconds"),
])
async def test_errors_become_plain_sentences(settings, error, words):
    brain = brain_with(settings, error)
    with pytest.raises(BrainError, match=words):
        [p async for p in brain.stream([])]


async def test_error_mid_stream(settings):
    brain = brain_with(settings, {"pieces": ["Half"], "fail": openai.APIConnectionError(request=REQ)})
    got = []
    with pytest.raises(BrainError):
        async for p in brain.stream([]):
            got.append(p)
    assert got == ["Half"]


async def test_missing_key_says_which_variable(settings, monkeypatch):
    monkeypatch.delenv("GNOSIS_TEST_KEY", raising=False)
    with pytest.raises(BrainError, match="GNOSIS_TEST_KEY isn't set"):
        [p async for p in Brain(settings.brain).stream([])]
    result = await Brain(settings.brain).check()
    assert not result.ok and "GNOSIS_TEST_KEY" in result.message


async def test_check(settings):
    assert (await brain_with(settings, ["OK"]).check()).ok
    empty = await brain_with(settings, ["<think>only thoughts</think>"]).check()
    assert not empty.ok and "answered with nothing" in empty.message
    bad = await brain_with(settings, status_error(openai.AuthenticationError, 401)).check()
    assert not bad.ok and "rejected the key" in bad.message
