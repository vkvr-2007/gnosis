"""Starts Gnosis.

  python -m gnosis              open the app (window + tray icon)
  python -m gnosis --check      check the model connection and exit
  python -m gnosis --shortcut   add Gnosis to the Start menu (add --desktop for a desktop icon too)
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from gnosis import __version__
from gnosis.identity import load_identity
from gnosis.settings import load_settings


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="gnosis", description="Gnosis, your desktop assistant")
    p.add_argument("--check", action="store_true", help="check the model connection and exit")
    p.add_argument("--shortcut", action="store_true", help="add Gnosis to the Start menu")
    p.add_argument("--desktop", action="store_true", help="with --shortcut, also add a desktop icon")
    p.add_argument("--version", action="version", version=f"Gnosis {__version__}")
    args = p.parse_args(argv)

    settings = load_settings()
    identity = load_identity()

    if args.check:
        from gnosis.brain import Brain
        result = asyncio.run(Brain(settings.brain).check())
        print(f"{'OK' if result.ok else 'PROBLEM'}: {result.message} ({result.ms} ms)")
        return 0 if result.ok else 1

    if args.shortcut:
        from gnosis.app.shortcut import install
        for link in install(settings.data_dir, identity.name, desktop=args.desktop):
            print(f"Added {link}")
        return 0

    from gnosis.app.window import run_app
    return run_app(settings, identity)


if __name__ == "__main__":
    sys.exit(main())
