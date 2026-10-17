"""Command line entry point.

    python -m gnosis serve           Start Gnosis and its dashboard on http://127.0.0.1:8765
    python -m gnosis serve --voice   ...and listen for "Hey Gnosis" on the microphone
    python -m gnosis chat            Talk to Gnosis in the terminal
    python -m gnosis enroll          Teach Gnosis your voice (voice ID)
    python -m gnosis models          List the Nemotron models your Nebius key can use
    python -m gnosis phone pair ...  Pair your Android phone (then `phone connect`)
    python -m gnosis invite          Print a one-time link (and QR code) that lets a browser use Gnosis
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
    _harden()
    g = build(settings)
    server = uvicorn.Server(uvicorn.Config(create_app(g), host=settings.host, port=settings.port,
                                           log_level="warning"))
    print(f"Gnosis dashboard: http://{settings.host}:{settings.port}")
    print(f"Kill switch: {settings.kill_switch} stops everything Gnosis is doing")

    async def main() -> None:
        from gnosis import killswitch

        killswitch.start(g.stop_all, settings.kill_switch)
        background = [asyncio.create_task(g.run_background())]
        if getattr(args, "voice", False):
            from gnosis.voice import run_voice

            background.append(asyncio.create_task(run_voice(g)))
        for task in background:
            task.add_done_callback(lambda t: t.cancelled() or not t.exception() or
                                   print(f"Stopped: {type(t.exception()).__name__}: {t.exception()}"))
        try:
            await server.serve()
        finally:
            for task in background:
                task.cancel()

    asyncio.run(main())


def _harden() -> None:
    """On Linux, stops other processes running as the same user (such as code the coding agent runs)
    from reading this process's memory or environment, where the API keys are."""
    if sys.platform.startswith("linux"):
        import ctypes

        try:
            ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE = 0
        except (OSError, AttributeError):
            pass


def _invite(args: argparse.Namespace) -> None:
    """Asks the running server for a pairing link. Only works on the same machine (or inside the container)."""
    import httpx
    import segno

    from gnosis.config import load_settings

    settings = load_settings(args.config)
    try:
        r = httpx.post(f"http://127.0.0.1:{settings.port}/api/phone/pair", headers={"Host": "localhost"}, timeout=10)
        r.raise_for_status()
    except httpx.HTTPError as e:
        sys.exit(f"Couldn't reach Gnosis on port {settings.port}. Is `gnosis serve` running? ({e})")
    url = r.json()["url"]
    segno.make(url, error="m").terminal(compact=True)
    print(f"\n{url}\n\nOpen it within 5 minutes. It works once, on one device; run this again for each person.")


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


def _check_models(args: argparse.Namespace) -> None:
    from gnosis.config import load_settings
    from gnosis.harness import models

    if not models.main(load_settings(args.config).models, args.roles or None):
        sys.exit(1)


def _accept(args: argparse.Namespace) -> None:
    from gnosis.config import load_settings
    from gnosis.harness import accept

    report_dir = load_settings(args.config).data_dir / "reports"
    if not accept.main(args.url, args.desktop, report_dir):
        sys.exit(1)


def _bench(args: argparse.Namespace) -> None:
    from gnosis.harness import bench

    if not bench.main(args.url, args.rounds):
        sys.exit(1)


def _phone(args: argparse.Namespace) -> None:
    from gnosis.config import load_settings
    from gnosis.phone.adb import AdbError, Phone, find_adb, subprocess_runner

    settings = load_settings(args.config)
    adb = find_adb(settings.data_dir)
    if adb is None:
        sys.exit("adb isn't installed. Run .\\scripts\\get_adb.ps1 first.")
    phone = Phone(subprocess_runner(adb), settings.data_dir / "phone.json")
    try:
        if args.action == "pair":
            # Phone: Settings > Developer options > Wireless debugging > Pair device with pairing code
            print(phone.pair(args.address, args.code))
            print("Paired. Now run: python -m gnosis phone connect <the IP address and port shown under "
                  "Wireless debugging (not the pairing one)>")
        elif args.action == "connect":
            print(phone.connect(args.address))
            print("Connected:", phone.status())
        else:
            print(phone.status())
    except AdbError as e:
        sys.exit(str(e))


def main() -> None:
    parser = argparse.ArgumentParser(prog="gnosis")
    parser.add_argument("--config", default=os.environ.get("GNOSIS_CONFIG"), help="Path to gnosis.yaml")
    sub = parser.add_subparsers(dest="cmd")
    serve = sub.add_parser("serve")
    serve.add_argument("--voice", action="store_true", help='Listen for "Hey Gnosis" on the microphone')
    serve.set_defaults(func=_serve)
    sub.add_parser("enroll").set_defaults(func=_enroll)
    sub.add_parser("chat").set_defaults(func=_chat)
    sub.add_parser("models").set_defaults(func=_models)
    sub.add_parser("invite", help="One-time link that pairs a phone or browser").set_defaults(func=_invite)
    check = sub.add_parser("check-models", help="Test that each model role calls tools properly")
    check.add_argument("roles", nargs="*", help="Roles to check (default: all that take tools)")
    check.set_defaults(func=_check_models)
    acc = sub.add_parser("accept", help="Run the laptop acceptance suite against a running server")
    acc.add_argument("--url", default="http://127.0.0.1:8765")
    acc.add_argument("--desktop", action="store_true", help="Include steps that open and close real apps")
    acc.set_defaults(func=_accept)
    ben = sub.add_parser("bench", help="Time standard requests against a running server")
    ben.add_argument("--url", default="http://127.0.0.1:8765")
    ben.add_argument("--rounds", type=int, default=3)
    ben.set_defaults(func=_bench)
    phone = sub.add_parser("phone", help="Pair and connect your Android phone over wireless debugging")
    phone_sub = phone.add_subparsers(dest="action", required=True)
    pair = phone_sub.add_parser("pair", help="One time: pair with the code from Wireless debugging")
    pair.add_argument("address", help="IP:port shown on the pairing screen")
    pair.add_argument("code", help="6-digit pairing code")
    connect = phone_sub.add_parser("connect", help="Connect (Gnosis reconnects by itself after this)")
    connect.add_argument("address", help="IP:port shown under Wireless debugging")
    phone_sub.add_parser("status")
    phone.set_defaults(func=_phone)
    args = parser.parse_args()
    getattr(args, "func", _serve)(args)


if __name__ == "__main__":
    main()
