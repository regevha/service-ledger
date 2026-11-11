"""The alias seed adds its groups once, never touches names that people already
grouped, and its groups show up as "possible match" in the Admin list."""
from __future__ import annotations

from app import seed_field_aliases
from app.models import FieldAliasGroup, FieldAliasName
from app.services.template_compare import normalize_name


def _groups(db):
    return {g.label: [n.name for n in g.names] for g in db.query(FieldAliasGroup).all()}


def test_a_fresh_database_gets_the_groups(db_session):
    seed_field_aliases.seed(db_session)
    groups = _groups(db_session)
    assert set(groups) == {label for label, _ in seed_field_aliases.ALIAS_GROUPS}
    assert groups["Labor hours"][0] == "labor_hours"


def test_seeding_twice_adds_nothing(db_session):
    seed_field_aliases.seed(db_session)
    ids = {g.id for g in db_session.query(FieldAliasGroup).all()}
    assert seed_field_aliases.seed(db_session) == []
    assert {g.id for g in db_session.query(FieldAliasGroup).all()} == ids


def test_a_name_already_grouped_by_hand_is_left_alone(db_session):
    mine = FieldAliasGroup(label="Mine")
    mine.names = [
        FieldAliasName(name="Labour Hours", normalized=normalize_name("Labour Hours"), position=0),
        FieldAliasName(name="man hours", normalized=normalize_name("man hours"), position=1),
    ]
    db_session.add(mine)
    db_session.commit()

    seed_field_aliases.seed(db_session)

    groups = _groups(db_session)
    assert groups["Mine"] == ["Labour Hours", "man hours"]
    assert "labour_hours" not in groups["Labor hours"]
    assert "labor_hours" in groups["Labor hours"]
