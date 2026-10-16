"""Command line entry point.

    python -m gnosis serve           Start Gnosis and its dashboard on http://127.0.0.1:8765
    python -m gnosis serve --voice   ...and listen for "Hey Gnosis" on the microphone
    python -m gnosis chat            Talk to Gnosis in the terminal
    python -m gnosis enroll          Teach Gnosis your voice (voice ID)
    python -m gnosis models          List the Nemotron models your Nebius key can use
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys


def _serve(args: argparse.Namespace) -> None:
    import uvicorn

    from gnosis.app import build
    from gnosis.config import load_settings
    from gnosis.server.api import create_app

    settings = load_settings(args.config)
    g = build(settings)
    server = uvicorn.Server(uvicorn.Config(create_app(g), host=settings.host, port=settings.port,
                                           log_level="warning"))
    print(f"Gnosis dashboard: http://{settings.host}:{settings.port}")

    async def main() -> None:
        if not getattr(args, "voice", False):
            await server.serve()
            return
        from gnosis.voice import run_voice

        voice = asyncio.create_task(run_voice(g))
        voice.add_done_callback(lambda t: t.cancelled() or not t.exception() or
                                print(f"Voice stopped: {type(t.exception()).__name__}: {t.exception()}"))
        try:
            await server.serve()
        finally:
            voice.cancel()

    asyncio.run(main())


def _enroll(args: argparse.Namespace) -> None:
    from gnosis.app import build
    from gnosis.config import load_settings
    from gnosis.voice import enroll

    chunks = enroll(build(load_settings(args.config)))
    print(f"Done. Gnosis learned your voice from {chunks} clips.")


def _chat(args: argparse.Namespace) -> None:
    from gnosis.app import build
    from gnosis.config import load_settings

    g = build(load_settings(args.config))

    async def on_approval() -> None:
        queue = g.events.subscribe()
        while True:
            event = await queue.get()
            if event["type"] == "approval_needed":
                answer = await asyncio.to_thread(
                    input, f"  Gnosis wants to run {event['tool']} {event['args']}. Allow? [y/N] ")
                g.approvals.resolve(event["approval_id"], answer.strip().lower() in ("y", "yes"))

    async def loop() -> None:
        asyncio.create_task(on_approval())
        while True:
            try:
                text = await asyncio.to_thread(input, "you> ")
            except EOFError:
                return
            if text.strip() in ("exit", "quit"):
                return
            if text.strip():
                print("gnosis>", await g.orchestrator.handle(text, "terminal"))

    asyncio.run(loop())


def _models(args: argparse.Namespace) -> None:
    from openai import OpenAI

    from gnosis.config import load_settings

    nebius = load_settings(args.config).models["providers"]["nebius"]
    key = os.environ.get(nebius["api_key_env"])
    if not key:
        sys.exit(f"Set {nebius['api_key_env']} to your Nebius Token Factory API key first.")
    client = OpenAI(base_url=nebius["base_url"], api_key=key)
    ids = sorted(m.id for m in client.models.list())
    nemotron = [i for i in ids if "nemotron" in i.lower()]
    print("Nemotron models available to you:")
    for i in nemotron or ["(none found; showing all)"] + ids:
        print("  ", i)


def main() -> None:
    parser = argparse.ArgumentParser(prog="gnosis")
    parser.add_argument("--config", help="Path to gnosis.yaml")
    sub = parser.add_subparsers(dest="cmd")
    serve = sub.add_parser("serve")
    serve.add_argument("--voice", action="store_true", help='Listen for "Hey Gnosis" on the microphone')
    serve.set_defaults(func=_serve)
    sub.add_parser("enroll").set_defaults(func=_enroll)
    sub.add_parser("chat").set_defaults(func=_chat)
    sub.add_parser("models").set_defaults(func=_models)
    args = parser.parse_args()
    getattr(args, "func", _serve)(args)


if __name__ == "__main__":
    main()
