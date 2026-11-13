#!/usr/bin/env python3
"""Compare tokens.json with the app's CSS variables, so this folder does not drift from the app.

The app is the source of truth: frontend/src/index.css, light values in the first `:root` block and dark
values in `:root[data-theme='dark']`. Prints every colour token whose value differs or is missing, and exits
1 if there is any. Usage, from the repository root:  python3 docs/design-system/check_tokens.py
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CSS = (ROOT / "frontend/src/index.css").read_text()
TOKENS = json.loads((Path(__file__).parent / "tokens.json").read_text())


def block(selector_pattern: str) -> dict[str, str]:
    match = re.search(selector_pattern + r"\s*\{(.*?)\n\}", CSS, re.S | re.M)
    if not match:
        sys.exit(f"Could not find the block {selector_pattern!r} in index.css")
    return {name: value.strip() for name, value in re.findall(r"--([\w-]+)\s*:\s*([^;]+);", match.group(1))}


def norm(value: str) -> str:
    return re.sub(r"\s+", "", value).lower()


themes = {"light": block(r"^:root"), "dark": block(r"^:root\[data-theme='dark'\]")}
problems = []
for token in TOKENS["color"]["tokens"]:
    for theme, css in themes.items():
        want = token["value"][theme]
        # A variable the dark block does not set inherits the light value (on-fill, paper).
        have = css.get(token["name"]) or (themes["light"].get(token["name"]) if theme == "dark" else None)
        if have is None:
            problems.append(f"{theme:5} --{token['name']}: missing in index.css (tokens.json has {want})")
        elif norm(have) != norm(want):
            problems.append(f"{theme:5} --{token['name']}: index.css {have}, tokens.json {want}")

if problems:
    print("tokens.json differs from frontend/src/index.css:")
    print("\n".join("  " + p for p in problems))
    sys.exit(1)
print(f"ok: {len(TOKENS['color']['tokens'])} colour tokens match index.css in light and dark.")
