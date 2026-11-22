"""The readable text of an HTML report.

A service report can arrive as an HTML file (saved from an email or a web
portal). It is read as text, never rendered and never served back as a web
page: scripts, styles and hidden parts are dropped, tables keep one row per
line with tab-separated cells, and Hebrew stays in logical order (HTML stores it
that way, so there is none of the reversed-text problem a PDF text layer has).
"""
from __future__ import annotations

import re
from html.parser import HTMLParser

# Enough for any real report; bounds what one upload can cost to read.
MAX_TEXT_CHARS = 200_000

_HTML_START = re.compile(rb"<!doctype\s+html|<(html|head|body|meta|title|table)[\s>/]", re.IGNORECASE)
_CHARSET = re.compile(rb"""charset\s*=\s*["']?\s*([A-Za-z0-9_\-:.]+)""", re.IGNORECASE)

_SKIP = {"script", "style", "noscript", "template", "svg", "object", "iframe"}
_BLOCK = {
    "p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article",
    "table", "ul", "ol", "pre", "hr", "header", "footer", "form", "dl", "dt", "dd", "caption",
}
_CELL = {"td", "th"}


def looks_like_html(data: bytes) -> bool:
    """True when the first bytes open like an HTML document. A file that merely
    mentions a tag in prose does not count: it has to start with markup."""
    head = data[:2048].lstrip(b"\xef\xbb\xbf \t\r\n\x00")
    return head[:1] == b"<" and _HTML_START.search(head[:1024]) is not None


def decode_html(data: bytes) -> str:
    """UTF-8 unless a byte-order mark or a declared charset says otherwise."""
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", errors="replace")
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", errors="replace")
    match = _CHARSET.search(data[:2048])
    if match:
        try:
            return data.decode(match.group(1).decode("ascii"), errors="replace")
        except (LookupError, ValueError):
            pass
    return data.decode("utf-8", errors="replace")


class _TextCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip_depth = 0
        self._in_title = False
        self.title = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _SKIP:
            self._skip_depth += 1
        elif tag == "title":
            self._in_title = True
        elif tag in _BLOCK:
            self.parts.append("\n")
        elif tag in _CELL:
            self.parts.append("\t")

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP:
            self._skip_depth = max(0, self._skip_depth - 1)
        elif tag == "title":
            self._in_title = False
        elif tag in _BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
        elif self._skip_depth == 0:
            self.parts.append(data)


def html_to_text(data: bytes) -> str:
    """The visible text of an HTML file, whitespace tidied. Empty when `data` is
    not HTML. Never raises."""
    if not looks_like_html(data):
        return ""
    try:
        collector = _TextCollector()
        collector.feed(decode_html(data)[: MAX_TEXT_CHARS * 4])
        collector.close()
    except Exception:  # noqa: BLE001 - a malformed page must not fail an upload
        return ""
    lines = []
    for raw in "".join(collector.parts).split("\n"):
        line = re.sub(r"[ \f\v ]+", " ", raw).strip(" \t")
        line = re.sub(r"\t[\t ]*", "\t", line)
        if line.strip():
            lines.append(line)
    title = collector.title.strip()
    text = "\n".join(([title] if title else []) + lines)
    return text[:MAX_TEXT_CHARS]
