"""Files and camera photos the owner attaches to a request, kept in the data folder's inbox.

Text files are put into the request itself. Images stay in the inbox and the model looks at them with
the look_at_image tool, so a photo is only sent to the vision model when it's actually needed.
"""

from __future__ import annotations

import re
import secrets
import time
from dataclasses import dataclass
from pathlib import Path

MAX_BYTES = 20 * 1024 * 1024
MAX_TEXT_CHARS = 30_000
IMAGE_TYPES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
_ID = re.compile(r"^[a-z0-9]{12}$")


class AttachmentError(ValueError):
    pass


@dataclass
class Attachment:
    id: str
    name: str
    kind: str  # image | text | other
    path: Path

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "kind": self.kind}


def _kind(name: str, data: bytes) -> str:
    if Path(name).suffix.lower() in IMAGE_TYPES:
        return "image"
    if b"\x00" in data[:4096]:
        return "other"
    try:
        data[:MAX_TEXT_CHARS * 4].decode("utf-8")
        return "text"
    except UnicodeDecodeError as e:
        return "text" if e.start > MAX_TEXT_CHARS else "other"  # Cut mid-character is fine


class Inbox:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)

    def save(self, name: str, data: bytes) -> Attachment:
        if not data:
            raise AttachmentError("The file is empty")
        if len(data) > MAX_BYTES:
            raise AttachmentError(f"Files can be up to {MAX_BYTES // (1024 * 1024)} MB")
        safe = re.sub(r"[^\w.-]+", "_", Path(name or "file").name)[-80:].lstrip(".") or "file"
        file_id = secrets.token_hex(6)
        folder = self.root / file_id
        folder.mkdir()
        path = folder / safe
        path.write_bytes(data)
        return Attachment(file_id, safe, _kind(safe, data), path)

    def get(self, file_id: str) -> Attachment:
        if not _ID.match(file_id or ""):
            raise AttachmentError(f"No attachment '{file_id}'")
        files = list((self.root / file_id).glob("*")) if (self.root / file_id).is_dir() else []
        if not files:
            raise AttachmentError(f"No attachment '{file_id}'")
        path = files[0]
        return Attachment(file_id, path.name, _kind(path.name, path.read_bytes()[:MAX_TEXT_CHARS * 4]), path)

    def clean(self, older_than_s: float = 7 * 86400) -> None:
        cutoff = time.time() - older_than_s
        for folder in self.root.iterdir():
            if folder.is_dir() and folder.stat().st_mtime < cutoff:
                for f in folder.iterdir():
                    f.unlink()
                folder.rmdir()

    def describe(self, file_ids: list[str]) -> str:
        """What gets added to the request text for its attachments."""
        parts = []
        for file_id in file_ids:
            a = self.get(file_id)
            if a.kind == "text":
                text = a.path.read_bytes()[:MAX_TEXT_CHARS * 4].decode("utf-8", errors="replace")[:MAX_TEXT_CHARS]
                more = " (cut short)" if a.path.stat().st_size > len(text.encode()) else ""
                # Saying the text is right here stops models from trying read_file on the name.
                parts.append(f'[Attached file "{a.name}"{more}. Its full text is below; no need to open it.]\n'
                             f'{text}\n[End of "{a.name}"]')
            elif a.kind == "image":
                parts.append(f'[Attached image "{a.name}", id {a.id}. Use look_at_image to see it.]')
            else:
                parts.append(f'[Attached "{a.name}", which isn\'t text or an image, so Gnosis can\'t read it]')
        return "\n\n".join(parts)
