"""Template resolution — §2 / §5 / §9's `GET /report-templates` behavior in
one place, so the classify flow, the manual fallback picker, and any future
caller all resolve a (instrument_type, report_type, model) triple the same way.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models import ReportTemplate


def resolve_template(
    db: Session, *, instrument_type: str, report_type: str, model: str | None
) -> ReportTemplate | None:
    """A model-specific row takes precedence; a NULL-model row is the fallback
    for every model that doesn't have its own row (§2)."""
    if model:
        specific = (
            db.query(ReportTemplate)
            .filter(
                ReportTemplate.instrument_type == instrument_type,
                ReportTemplate.report_type == report_type,
                ReportTemplate.model == model,
            )
            .one_or_none()
        )
        if specific:
            return specific
    return (
        db.query(ReportTemplate)
        .filter(
            ReportTemplate.instrument_type == instrument_type,
            ReportTemplate.report_type == report_type,
            ReportTemplate.model.is_(None),
        )
        .one_or_none()
    )


# ---------------------------------------------------------------------------
# Suggestions: which existing template is the best starting point for a new one
# (proposal-template-suggestion.md, Option 2). Advice only: nothing here writes,
# and nothing is applied until a person edits and saves the new template.
# ---------------------------------------------------------------------------

# Ranking tiers, strongest first. The tier decides the order; shared leading
# words and then field count only break ties inside a tier.
TIER_SAME_MODEL = 3  # the same model written differently ("facsaria iii" vs "FACSAria III")
TIER_SAME_FAMILY = 2  # shares the first word(s) of the model name ("FACSAria III" / "FACSAria Fusion")
TIER_GENERIC = 1  # the "any model" template: a neutral baseline
TIER_OTHER_MODEL = 0  # same report type, unrelated model: better than a blank page

_WORD = re.compile(r"[A-Za-z0-9]+")


def _words(model: str | None) -> list[str]:
    """The model name as its alphanumeric words, original casing kept."""
    return _WORD.findall(model or "")


def _leading_text(model: str, count: int) -> str:
    """The model's own text up to the end of its first `count` words, so a
    family reads as written ("E2E-Fam-1", not "E2E Fam 1")."""
    matches = list(_WORD.finditer(model))
    return model[: matches[count - 1].end()] if 0 < count <= len(matches) else model


def _shared_leading_words(a: list[str], b: list[str]) -> int:
    count = 0
    for left, right in zip(a, b):
        if left.lower() != right.lower():
            break
        count += 1
    return count


@dataclass(frozen=True)
class TemplateSuggestion:
    template: ReportTemplate
    score: int
    reason: str
    field_count: int


def _score(candidate: ReportTemplate, wanted_words: list[str]) -> tuple[int, int, str]:
    """(tier, shared leading words, reason) for one candidate."""
    if candidate.model is None:
        return TIER_GENERIC, 0, "same report type, applies to any model"
    candidate_words = _words(candidate.model)
    shared = _shared_leading_words(candidate_words, wanted_words)
    if wanted_words and shared == len(candidate_words) == len(wanted_words):
        return TIER_SAME_MODEL, shared, f"same report type, same model ({candidate.model})"
    if shared >= 1:
        family = _leading_text(candidate.model, shared)
        return TIER_SAME_FAMILY, shared, f"same report type, same {family} family ({candidate.model})"
    return TIER_OTHER_MODEL, 0, f"same report type, different model ({candidate.model})"


def suggest_templates(
    db: Session,
    *,
    instrument_type: str,
    report_type: str,
    model: str | None,
    limit: int = 3,
) -> list[TemplateSuggestion]:
    """Existing templates ranked as a starting point for a new one for
    (instrument_type, report_type, model).

    Required: same instrument type and same report type, so a repair template
    is never offered for a PM report. Then, strongest first: the same
    model written differently, a model of the same family (shared leading
    words), the "any model" template, any other model. Ties go to the template
    with more fields (a fuller starting point), then the older one, so the
    order is stable. The row that already has exactly this model is left out:
    it is the template that resolves today, and a second one cannot be saved.
    An empty list means nothing shares the report type."""
    wanted_words = _words(model)
    candidates = (
        db.query(ReportTemplate)
        .filter(ReportTemplate.instrument_type == instrument_type, ReportTemplate.report_type == report_type)
        .all()
    )
    ranked = []
    for candidate in candidates:
        if model and candidate.model == model:
            continue
        tier, shared, reason = _score(candidate, wanted_words)
        field_count = len(candidate.field_schema.get("fields", []))
        ranked.append((tier, shared, field_count, candidate, reason))
    ranked.sort(key=lambda r: (-r[0], -r[1], -r[2], r[3].created_at, str(r[3].id)))
    return [
        TemplateSuggestion(template=c, score=tier * 10 + shared, reason=reason, field_count=count)
        for tier, shared, count, c, reason in ranked[: max(limit, 0)]
    ]
