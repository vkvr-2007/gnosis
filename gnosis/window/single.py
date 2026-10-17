"""Only one Gnosis window runs at a time: starting it again just brings the open one forward."""

from __future__ import annotations

import socket
import threading
from typing import Callable

PORT = 47812  # Localhost only; carries nothing but the word "show"


def claim(on_show: Callable[[], None], port: int = PORT) -> socket.socket | None:
    """The listening socket if this is the only Gnosis window. Otherwise tells the running one to show
    itself and returns None."""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):  # Windows would otherwise let a second process share the port
        server.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    try:
        server.bind(("127.0.0.1", port))
    except OSError:
        server.close()
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=2) as c:
                c.sendall(b"show")
        except OSError:
            pass
        return None
    server.listen(4)

    def serve() -> None:
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                return  # Closed: the app is quitting
            with conn:
                conn.settimeout(2)
                try:
                    if conn.recv(16) == b"show":
                        on_show()
                except OSError:
                    pass

    threading.Thread(target=serve, name="gnosis-single", daemon=True).start()
    return server
