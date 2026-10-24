"""Every choice field a seed ships must carry its options.

The template editor (frontend TemplateManager) refuses to save a choice field
with no options, so a seeded enum/enum[] field without them left its template
impossible to save after any unrelated edit (UI review, 2026-10-24).
"""
from __future__ import annotations

from app import seed_templates


def _all_seeded_fields() -> list[tuple[str, dict]]:
    found = []
    for name, value in vars(seed_templates).items():
        if name.endswith("_FIELDS") and isinstance(value, list):
            found.extend((name, field) for field in value)
    return found


def test_every_seeded_choice_field_has_options():
    fields = _all_seeded_fields()
    assert fields, "no seeded field lists found"
    choice = [(n, f) for n, f in fields if f["type"] in ("enum", "enum[]")]
    assert choice
    missing = [f"{n}.{f['name']}" for n, f in choice if not f.get("options")]
    assert missing == []


def test_laser_configuration_offers_every_wavelength_the_notes_mention():
    lasers = [f for _, f in _all_seeded_fields() if f["name"] == "laser_configuration"]
    assert len(lasers) == 2
    for f in lasers:
        assert f["options"] == ["355nm", "405nm", "488nm", "561nm", "640nm"]
