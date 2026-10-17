"""Seeing: images the owner attached, and the laptop's camera."""

from __future__ import annotations

import asyncio
from typing import Any

from gnosis.attachments import AttachmentError, Inbox
from gnosis.core.tools import ToolRegistry

_DEFAULT_Q = "Describe what you see, briefly."


def _camera_photo(device: int = 0):
    import cv2
    from PIL import Image

    cam = cv2.VideoCapture(device, cv2.CAP_DSHOW) if hasattr(cv2, "CAP_DSHOW") else cv2.VideoCapture(device)
    try:
        if not cam.isOpened():
            raise RuntimeError("Couldn't open the camera. Is another app using it?")
        frame = None
        for _ in range(8):  # The first frames are often dark while the camera adjusts
            ok, frame = cam.read()
        if frame is None or not ok:
            raise RuntimeError("The camera didn't return a picture")
        return Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    finally:
        cam.release()


def register_vision_tools(registry: ToolRegistry, llm: Any, inbox: Inbox, camera: bool) -> None:
    @registry.tool("look_at_image", "Look at an image the owner attached and answer a question about it.",
                   {"type": "object", "properties": {
                       "file_id": {"type": "string", "description": "The id given in the attachment note"},
                       "question": {"type": "string"}},
                    "required": ["file_id"]})
    async def look_at_image(file_id: str, question: str = _DEFAULT_Q) -> str:
        from PIL import Image

        from gnosis.skills.desktop.vision import ask_about

        try:
            a = inbox.get(file_id)
        except AttachmentError as e:
            return str(e)
        if a.kind != "image":
            return f"{a.name} isn't an image"
        img = await asyncio.to_thread(lambda: Image.open(a.path).convert("RGB"))
        # The owner chose to share this image, like typing a message, so it can go to the vision model.
        return await ask_about(llm, img, question, tags=set())

    if not camera:
        return

    @registry.tool("look_through_camera",
                   "Take one photo with the laptop's camera and answer a question about it ('what am I "
                   "holding?', 'read this label'). The photo isn't saved.",
                   {"type": "object", "properties": {"question": {"type": "string"}}})
    async def look_through_camera(question: str = _DEFAULT_Q) -> str:
        from gnosis.skills.desktop.vision import ask_about

        try:
            img = await asyncio.to_thread(_camera_photo)
        except ImportError:
            return 'The camera needs one more package: pip install -e ".[camera]"'
        except RuntimeError as e:
            return str(e)
        return await ask_about(llm, img, question, tags=set())
