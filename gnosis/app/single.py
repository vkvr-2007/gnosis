"""Only one Gnosis runs at a time: starting it again just brings the open window forward."""

from __future__ import annotations

import socket
import threading
from typing import Callable

PORT = 47812  # Localhost only; carries nothing but the word "show"


def claim(on_show: Callable[[], None]) -> bool:
    """True if this is the only Gnosis; otherwise tells the running one to show itself and returns False."""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        server.bind(("127.0.0.1", PORT))
    except OSError:
        server.close()
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=2) as c:
                c.sendall(b"show")
        except OSError:
            pass
        return False
    server.listen(4)

    def serve() -> None:
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            with conn:
                conn.settimeout(2)
                try:
                    if conn.recv(16) == b"show":
                        on_show()
                except OSError:
                    pass

    threading.Thread(target=serve, name="gnosis-single", daemon=True).start()
    return True
