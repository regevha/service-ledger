"""Where the words are on a page of a stored PDF.

The template editor shows a page as an image and lets a person click a word or
drag a box to turn that text into a template field. To know what is under the
pointer it needs every word's rectangle, which only the PDF's own text layer
can tell it. pypdfium2 (already used to render the page) gives each character's
box, and this module joins characters into words.

Boxes are returned as fractions of the page (0 to 1, origin at the top left),
so the browser can place them over the image at any zoom without knowing the
page size in points. A scan with no text layer returns no words; the editor
then still lets a person draw a box and type the name.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

# A gap wider than this many character heights starts a new word, so two
# columns that sit on one line ("Laser delay      Range") are not one word.
_GAP_IN_HEIGHTS = 0.9
# Characters whose vertical centres differ by more than this many heights are on different lines.
_LINE_SHIFT_IN_HEIGHTS = 0.6
# Pages are capped so a hostile or huge document cannot make one request build a giant list.
MAX_WORDS_PER_PAGE = 6000


@dataclass(frozen=True)
class WordBox:
    text: str
    x: float
    y: float
    w: float
    h: float
    line: int


def page_words(path: str | Path, page: int) -> tuple[list[WordBox], bool]:
    """(the words on 1-based `page`, whether the page has any text at all).

    Raises IndexError for a page outside the document and pypdfium2's own
    PdfiumError for a file that cannot be opened; the router turns both into
    HTTP errors."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(str(path))
    try:
        if page < 1 or page > len(pdf):
            raise IndexError(page)
        pdf_page = pdf[page - 1]
        width, height = pdf_page.get_size()
        text_page = pdf_page.get_textpage()
        count = text_page.count_chars()
        words: list[WordBox] = []
        # The word being built: its text and the extent of its characters in PDF points.
        buf = ""
        left = bottom = right = top = 0.0
        line = 0
        last_centre: float | None = None
        last_h = 0.0

        def flush() -> None:
            nonlocal buf
            if buf and width > 0 and height > 0:
                words.append(
                    WordBox(
                        text=buf,
                        x=round(left / width, 5),
                        y=round((height - top) / height, 5),
                        w=round((right - left) / width, 5),
                        h=round((top - bottom) / height, 5),
                        line=line,
                    )
                )
            buf = ""

        for i in range(count):
            ch = text_page.get_text_range(i, 1)
            l, b, r, t = text_page.get_charbox(i)
            # Spaces, line breaks and characters with no box (generated breaks) end a word.
            if not ch.strip() or r <= l or t <= b:
                flush()
                continue
            char_h = t - b
            centre = (t + b) / 2
            # Punctuation has a tiny box (a full stop is a dot), so judging a shift or a gap by its own height
            # would split "29.40" at the dot. Compare against the larger of this character and what came before.
            ref_h = max(char_h, (top - bottom) if buf else last_h)
            if buf:
                new_line = last_centre is not None and abs(centre - last_centre) > _LINE_SHIFT_IN_HEIGHTS * ref_h
                wide_gap = l - right > _GAP_IN_HEIGHTS * ref_h
                if new_line or wide_gap:
                    flush()
                    if new_line:
                        line += 1
            elif last_centre is not None and abs(centre - last_centre) > _LINE_SHIFT_IN_HEIGHTS * ref_h:
                line += 1
            if not buf:
                left, bottom, right, top = l, b, r, t
            else:
                left, bottom, right, top = min(left, l), min(bottom, b), max(right, r), max(top, t)
            buf += ch
            last_centre = centre
            last_h = char_h
            if len(words) >= MAX_WORDS_PER_PAGE:
                break
        flush()
        return words, count > 0
    finally:
        pdf.close()
