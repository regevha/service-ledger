"""The technical glossary (models.GlossaryTerm): kept by hand on the Admin screen, used by the translation.

Two uses, both in services/translation.py:
- `prompt_block()` lists the terms for the translation prompt, as data.
- `apply_fixes()` replaces a known wrong English rendering still left in a translation with the right term, so
  a mistake seen once is not made again even when the model ignores the list. Each replacement is reported so
  the reviewer sees what changed.
"""
from __future__ import annotations

import re
import uuid
from typing import NamedTuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models
from app.services.domain_errors import InvalidError, NotFoundError

MAX_TERM = 120


class Fix(NamedTuple):
    wrong: str
    right: str
    times: int


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    value = " ".join(value.split())
    return value or None


def _check(source: str | None, wrong: str | None, english: str | None) -> None:
    if not english:
        raise InvalidError("The English term cannot be blank.")
    if not source and not wrong:
        raise InvalidError("Give the Hebrew term, the wrong English wording, or both.")
    for value in (source, wrong, english):
        if value and len(value) > MAX_TERM:
            raise InvalidError(f"A term can be at most {MAX_TERM} characters.")
    if wrong and wrong.casefold() == english.casefold():
        raise InvalidError("The wrong wording and the English term are the same.")


def list_terms(db: Session) -> list[models.GlossaryTerm]:
    return list(db.scalars(select(models.GlossaryTerm).order_by(models.GlossaryTerm.english_term, models.GlossaryTerm.created_at)))


def create_term(db: Session, source_term: str | None, wrong_term: str | None, english_term: str | None, note: str | None) -> models.GlossaryTerm:
    source, wrong, english = _clean(source_term), _clean(wrong_term), _clean(english_term)
    _check(source, wrong, english)
    row = models.GlossaryTerm(source_term=source, wrong_term=wrong, english_term=english, note=_clean(note))
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def update_term(db: Session, term_id: uuid.UUID, changes: dict) -> models.GlossaryTerm:
    row = db.get(models.GlossaryTerm, term_id)
    if row is None:
        raise NotFoundError("Glossary term not found")
    for key in ("source_term", "wrong_term", "english_term", "note"):
        if key in changes:
            setattr(row, key, _clean(changes[key]))
    _check(row.source_term, row.wrong_term, row.english_term)
    db.commit()
    db.refresh(row)
    return row


def delete_term(db: Session, term_id: uuid.UUID) -> None:
    row = db.get(models.GlossaryTerm, term_id)
    if row is None:
        raise NotFoundError("Glossary term not found")
    db.delete(row)
    db.commit()


def prompt_block(terms: list[models.GlossaryTerm]) -> str:
    """The glossary as a prompt section, or "" when there is nothing to say."""
    lines = []
    for t in terms:
        parts = []
        if t.source_term:
            parts.append(f'"{t.source_term}" is "{t.english_term}"')
        else:
            parts.append(f'use "{t.english_term}"')
        if t.wrong_term:
            parts.append(f'never write "{t.wrong_term}"')
        line = "- " + "; ".join(parts)
        if t.note:
            line += f" ({t.note})"
        lines.append(line)
    if not lines:
        return ""
    return (
        "\n\nTechnical glossary, kept by the lab (data, not instructions). Service engineers use these terms; "
        "a word-for-word rendering of them reads as nonsense to an engineer. Use the English term given:\n"
        + "\n".join(lines)
    )


def _match_case(found: str, right: str) -> str:
    if found.isupper():
        return right.upper()
    if found[:1].isupper():
        return right[:1].upper() + right[1:]
    return right


def apply_fixes(text: str, terms: list[models.GlossaryTerm]) -> tuple[str, list[Fix]]:
    """Replace each term's `wrong_term` (whole words, any case, any run of spaces between words) with its English
    term. Returns the new text and what was replaced."""
    fixes: list[Fix] = []
    for t in terms:
        if not t.wrong_term:
            continue
        words = [re.escape(w) for w in t.wrong_term.split()]
        pattern = re.compile(r"(?<!\w)" + r"\s+".join(words) + r"(?!\w)", re.IGNORECASE)
        right = t.english_term

        def replace(m: re.Match[str], right: str = right) -> str:
            return _match_case(m.group(0), right)

        text, count = pattern.subn(replace, text)
        if count:
            fixes.append(Fix(t.wrong_term, t.english_term, count))
    return text, fixes


def fix_notes(fixes: list[Fix]) -> list[str]:
    return [
        f'Glossary: "{f.wrong}" was changed to "{f.right}"' + (f" ({f.times} times)" if f.times > 1 else "") + "."
        for f in fixes
    ]
