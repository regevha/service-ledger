"""The two read-only command-line listings: `python -m app.tools.list_instrument_models` and
`python -m app.tools.list_places`. They print what is in the database and which names look
like the same thing; they change nothing."""
from __future__ import annotations

import runpy

import pytest
from sqlalchemy import text
from sqlalchemy.orm import sessionmaker

from app import models
from app.tools import list_instrument_models, list_places


@pytest.fixture
def factory(db_session, monkeypatch):
    """Point both tools (and `python -m`, which re-imports app.db) at the test database."""
    session_factory = sessionmaker(bind=db_session.get_bind(), future=True)
    monkeypatch.setattr(list_instrument_models, "SessionLocal", session_factory)
    monkeypatch.setattr(list_places, "SessionLocal", session_factory)
    monkeypatch.setattr("app.db.SessionLocal", session_factory)
    return session_factory


def _unit(serial, model="ZetaSorter III", **extra):
    return models.Instrument(name=f"Unit {serial}", model=model, serial_number=serial, instrument_type="facs", **extra)


def _counts(db_session):
    return (
        db_session.query(models.Instrument).count(),
        db_session.query(models.InstrumentModel).count(),
        db_session.query(models.Place).count(),
    )


# ---------- list_instrument_models ----------


def test_models_listing_of_an_empty_database(factory, capsys):
    list_instrument_models.main()
    out = capsys.readouterr().out
    assert "0 models, 0 instruments without a model record" in out
    assert "No near-duplicate names." in out


def test_models_listing_counts_units_and_flags_look_alike_names(db_session, factory, capsys):
    db_session.add_all(
        [
            _unit("T1", manufacturer="BD"),
            _unit("T2", manufacturer="BD"),
            _unit("T3", model="Zeta Sorter III", manufacturer="BD"),
            _unit("T4", model="Tecnai X"),
        ]
    )
    db_session.add(models.InstrumentModel(name="Spare Sorter", manufacturer="Cytek", instrument_type="facs"))
    db_session.commit()
    before = _counts(db_session)

    list_instrument_models.main()
    out = capsys.readouterr().out

    assert "4 models, 0 instruments without a model record" in out
    assert "  ZetaSorter III  (BD, facs): 2 unit(s)" in out
    assert "  Zeta Sorter III  (BD, facs): 1 unit(s)" in out
    assert "  Tecnai X  (no maker, facs): 1 unit(s)" in out
    assert "  Spare Sorter  (Cytek, facs): 0 unit(s)" in out
    # Look-alike names are only reported, never merged.
    assert "Names that may be the same model (nothing was merged):" in out
    assert "  - Zeta Sorter III  |  ZetaSorter III" in out
    assert "No near-duplicate names." not in out
    assert _counts(db_session) == before


def test_models_listing_is_sorted_by_name_and_counts_unlinked_instruments(db_session, factory, capsys):
    db_session.add_all([_unit("T1", model="B Model"), _unit("T2", model="A Model")])
    db_session.commit()
    # The app links every instrument; this is what a row from before the link would look like.
    db_session.execute(text("UPDATE instruments SET model_id = NULL WHERE serial_number = 'T2'"))
    db_session.commit()

    list_instrument_models.main()
    out = capsys.readouterr().out

    assert "2 models, 1 instruments without a model record" in out
    assert out.index("  A Model") < out.index("  B Model")
    assert "  A Model  (no maker, facs): 0 unit(s)" in out  # its only unit lost the link


@pytest.mark.filterwarnings("ignore::RuntimeWarning")  # runpy: the module was already imported above
def test_models_listing_runs_as_a_module(db_session, factory, capsys):
    db_session.add(_unit("T1"))
    db_session.commit()
    runpy.run_module("app.tools.list_instrument_models", run_name="__main__")
    assert "ZetaSorter III" in capsys.readouterr().out


# ---------- list_places ----------


def test_places_listing_of_an_empty_database(factory, capsys):
    list_places.main()
    out = capsys.readouterr().out
    assert "0 places; 0 instruments with no place" in out
    assert "Not linked" not in out
    assert "may be the same place" not in out


def test_places_listing_shows_each_kind_with_its_parent_and_counts(db_session, factory, capsys):
    db_session.add(_unit("P1", institution="Bar-Ilan University", location="Room 205"))
    db_session.add(_unit("P2", institution="Bar-Ilan University"))
    db_session.commit()
    institution = db_session.query(models.Place).filter_by(kind="institution", name="Bar-Ilan University").one()
    faculty = models.Place(kind="faculty", name="Life Sciences", parent_id=institution.id)
    db_session.add(faculty)
    db_session.commit()
    db_session.add(models.Place(kind="room", name="Room 7", parent_id=faculty.id))
    db_session.commit()
    before = _counts(db_session)

    list_places.main()
    out = capsys.readouterr().out

    assert "4 places; 0 instruments with no place" in out
    assert "\ninstitutions\n  Bar-Ilan University: 1 instrument(s) pointing directly here" in out
    assert "\nfaculties\n  Life Sciences in Bar-Ilan University: 0 instrument(s) pointing directly here" in out
    assert "  Room 205 in Bar-Ilan University: 1 instrument(s) pointing directly here" in out
    assert "  Room 7 in Life Sciences: 0 instrument(s) pointing directly here" in out
    # Kinds are listed in a fixed order.
    assert out.index("institutions") < out.index("faculties") < out.index("rooms")
    assert _counts(db_session) == before


def test_places_listing_names_the_instruments_with_no_place(db_session, factory, capsys):
    db_session.add(_unit("P1"))
    db_session.commit()

    list_places.main()
    out = capsys.readouterr().out

    assert "0 places; 1 instruments with no place" in out
    assert "No place recorded:" in out
    assert "  Unit P1 (P1)" in out


def test_places_listing_flags_look_alike_institutions_and_rooms(db_session, factory, capsys):
    db_session.add_all(
        [
            _unit("P1", institution="Bar-Ilan University", location="Room 205"),
            _unit("P2", institution="Bar Ilan", location="205"),
        ]
    )
    db_session.commit()

    list_places.main()
    out = capsys.readouterr().out

    assert "Institution names that may be the same place (nothing was merged):" in out
    assert "  - Bar Ilan  |  Bar-Ilan University" in out
    assert "Room names that may be the same place (nothing was merged):" in out
    assert "  - 205  |  Room 205" in out


@pytest.mark.filterwarnings("ignore::RuntimeWarning")  # runpy: the module was already imported above
def test_places_listing_runs_as_a_module(db_session, factory, capsys):
    db_session.add(_unit("P1", institution="Weizmann Institute"))
    db_session.commit()
    runpy.run_module("app.tools.list_places", run_name="__main__")
    assert "Weizmann Institute" in capsys.readouterr().out
