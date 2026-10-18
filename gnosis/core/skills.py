"""Which tools a request gets to see.

Sending every tool on every call made each request about 5,600 tokens and slowed the first word. Tools
are grouped into skills: a small core set always goes, other skills go when the request (or the last
few turns) mentions them, and the model can load any other skill itself with `more_tools`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable

MORE_TOOLS = "more_tools"


@dataclass(frozen=True)
class Skill:
    name: str
    summary: str  # Shown to the model in more_tools, so it knows what it can load
    tools: tuple[str, ...]
    words: str = ""  # Regex of words in a request that bring this skill in


SKILLS = [
    Skill("core", "time, system info, memory, opening and closing apps, websites, YouTube, music, reminders",
          ("get_time", "system_info", "remember", "search_memory", "forget", "open_app", "close_app",
           "play_music", "play_youtube", "open_website", "set_reminder")),
    Skill("desktop", "operate the open window: read it, click, type, press keys, look at the screen",
          ("list_windows", "focus_window", "look_at_window", "click", "click_element", "type_text", "press_keys",
           "read_screen", "look_at_screen", "vision_click"),
          r"type|write|click|press|window|screen|tab|button|scroll|notepad|select|paste|copy|"
          r"what'?s (this|on)|read (this|it)|in (it|there)|explain this|error"),
    Skill("files", "read files from the folders Gnosis may use", ("read_file",),
          r"file|folder|document|pdf|docx?|\.txt|read (my|the)"),
    Skill("vision", "look at an attached image or through the webcam", ("look_at_image", "look_through_camera"),
          r"image|picture|photo|camera|webcam|attached image|holding|see me|look at"),
    Skill("tasks", "list, pause, resume or cancel running tasks",
          ("list_tasks", "pause_task", "resume_task", "cancel_task"),
          r"task|pause|resume|cancel|running|in progress|stop (that|it|the)"),
    Skill("schedule", "reminders, routines, do-not-disturb and the briefing",
          ("schedule_routine", "list_reminders", "cancel_reminder", "do_not_disturb", "briefing"),
          r"remind|reminder|routine|every (day|morning|week|evening)|schedule|briefing|disturb|quiet|alarm"),
    Skill("phone", "the paired Android phone: calls, SMS, WhatsApp, notifications, its apps",
          ("phone_status", "call", "end_call", "send_sms", "send_whatsapp", "phone_open_app",
           "phone_notifications", "sync_contacts"),
          r"phone|call|ring|sms|text (him|her|them|mom|dad)|message|whatsapp|notification|contact"),
    Skill("teach", "learn a task by watching the owner, and run saved skills",
          ("teach_start", "teach_stop", "recent_actions", "save_skill", "run_skill", "list_skills", "delete_skill"),
          r"teach|watch me|show you how|learn (this|how)|saved skill|skills?\b|do it again|like (i|I) showed"),
    Skill("code", "write, run and deploy code projects",
          ("code_new_project", "code_write_file", "code_edit_file", "code_read_file", "code_list_files",
           "code_run", "code_open_in_vscode", "git_push", "deploy"),
          r"code|coding|project|website|web ?app|script|python|javascript|typescript|html|react|deploy|"
          r"github|git\b|vs ?code|program|build (me|a)|bug"),
]

_BY_NAME = {s.name: s for s in SKILLS}
_PATTERNS = {s.name: re.compile(rf"\b(?:{s.words})", re.I) for s in SKILLS if s.words}


def skills_for(texts: Iterable[str]) -> set[str]:
    """The skills a request needs, from its text and the recent turns."""
    chosen = {"core"}
    joined = "\n".join(t for t in texts if t)
    for name, pattern in _PATTERNS.items():
        if pattern.search(joined):
            chosen.add(name)
    return chosen


def tools_of(skills: Iterable[str], available: Iterable[str]) -> list[str]:
    """Tool names for these skills, in skill order. Tools no skill lists go with the core set, so a newly
    added tool is never invisible."""
    available = list(available)
    listed = {t for s in SKILLS for t in s.tools}
    names = [t for s in SKILLS if s.name in set(skills) for t in s.tools if t in available]
    names += [t for t in available if t not in listed]
    return names


def more_tools_schema(loaded: set[str]) -> dict[str, Any] | None:
    """The `more_tools` tool, offering the skills that aren't loaded yet (None when all are)."""
    rest = [s for s in SKILLS if s.name not in loaded]
    if not rest:
        return None
    lines = "; ".join(f"{s.name}: {s.summary}" for s in rest)
    return {"type": "function", "function": {
        "name": MORE_TOOLS,
        "description": f"Load more tools when none of yours fits the request. Skills you can load: {lines}.",
        "parameters": {"type": "object", "properties": {
            "skill": {"type": "string", "enum": [s.name for s in rest]}}, "required": ["skill"]}}}


def skill_exists(name: str) -> bool:
    return name in _BY_NAME
