"""Seeds a few field alias groups, so the Admin "Field aliases" screen and the
template comparison's "possible match" rows have something to show on a fresh
database. Optional and manual, like the demo seeds: run it with
`python -m app.seed_field_aliases`, and `python -m app.seed_templates` calls it
too. It is never called from the app's startup seed, so a plain test database
still starts with no groups.

Each group is a set of names that mean the same thing under different wording.
`fault_description` and `service_description` are deliberately not grouped (the
CSV export plan keeps them as two separate columns).

Idempotent. A name that is already in some group (a name belongs to at most one,
a unique index) is skipped, so groups people made by hand are never changed.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import FieldAliasGroup, FieldAliasName
from app.services.template_compare import normalize_name

# (label, names). The first name is the one the seeded templates use.
ALIAS_GROUPS: list[tuple[str, list[str]]] = [
    ("Labor hours", ["labor_hours", "labour_hours", "work_hours", "hours_worked"]),
    ("Work performed", ["work_performed", "work_done", "action_taken", "actions_taken"]),
    ("Root cause", ["root_cause", "cause", "fault_cause"]),
    ("Fault category", ["fault_category", "fault_type", "failure_category"]),
    ("Components replaced", ["components_replaced", "parts_used", "parts_replaced"]),
]


def seed(db: Session) -> list[FieldAliasGroup]:
    """Adds the groups above. Returns the groups created by this call."""
    taken = {normalized for (normalized,) in db.query(FieldAliasName.normalized).all()}
    created: list[FieldAliasGroup] = []
    for label, names in ALIAS_GROUPS:
        free = [n for n in names if normalize_name(n) not in taken]
        # A group needs at least two names to say anything.
        if len(free) < 2:
            continue
        group = FieldAliasGroup(label=label)
        group.names = [
            FieldAliasName(name=n, normalized=normalize_name(n), position=i) for i, n in enumerate(free)
        ]
        db.add(group)
        taken.update(normalize_name(n) for n in free)
        created.append(group)
    db.commit()
    for group in created:
        db.refresh(group)
    return created


if __name__ == "__main__":
    with SessionLocal() as session:
        rows = seed(session)
        print(f"Created {len(rows)} field alias groups:")
        for row in rows:
            print(f"  - {row.label}: {', '.join(n.name for n in row.names)}")
