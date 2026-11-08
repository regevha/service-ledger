"""Instrument types, makers, models, places and instruments."""
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

from .enums import (
    DEFAULT_INSTRUMENT_TYPE_KEY,
    InstrumentStatus,
    _uuid_pk,
)

if TYPE_CHECKING:
    from .reports import Report


class InstrumentType(Base):
    """A kind of instrument ("Flow cytometer", "Electron microscope"). `key` is
    the stable value stored in `instruments.instrument_type` and
    `report_templates.instrument_type`; `display_name` is what people see. The
    columns stay plain strings (not foreign keys) and are validated against this
    table by the API (services/instrument_types.py), so older rows and seed
    scripts keep working. Distinct from `Instrument.manufacturer`, which says
    who makes the instrument, not what kind it is."""

    __tablename__ = "instrument_types"

    id: Mapped[uuid.UUID] = _uuid_pk()
    key: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Manufacturer(Base):
    """Who makes an instrument ("BD", "Cytek Biosciences"), as a record of its own,
    so one maker is one row however it was typed ("BD", "Becton Dickinson") and
    maker-specific knowledge has a place to live (the proposal for manufacturer-neutral
    support, section 3). `name` is the canonical spelling people see; `aliases` are
    other spellings that mean the same maker. Instruments and models point here
    (`manufacturer_id`) and their `manufacturer` text is kept equal to `name` by
    services/manufacturers.py on every save. Distinct from the instrument type (what
    kind it is) and from the distributor (who services it locally)."""

    __tablename__ = "manufacturers"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String, nullable=False)
    # Other spellings of this maker, as typed ("Becton Dickinson"). Matching ignores
    # case, spaces and punctuation, so "becton-dickinson" matches too.
    aliases: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (Index("uq_manufacturers_name_lower", text("lower(name)"), unique=True),)


class InstrumentModel(Base):
    """A model of instrument ("FACSAria III") as a record of its own, so facts
    that belong to the model live once instead of being typed on every unit
    (plans: "plan for instrument models"). Step 1 of that plan: the table is
    filled from the instruments' model text and every instrument links to one,
    but nothing reads it yet. `name` is the exact model text, unique;
    near-duplicates ("FACSAria III" / "FACS Aria III") are never merged by
    guess. `manufacturer` and `instrument_type` mirror the instrument's own
    copies (the instrument keeps them for now). `service_interval_months` is
    for the later overdue badge; empty means a model never shows as overdue."""

    __tablename__ = "instrument_models"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    manufacturer: Mapped[str | None] = mapped_column(String, nullable=True)
    # The maker's own record; `manufacturer` above is kept equal to its name.
    manufacturer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("manufacturers.id"), nullable=True, index=True
    )
    manufacturer_record: Mapped["Manufacturer | None"] = relationship()
    instrument_type: Mapped[str] = mapped_column(String, nullable=False, default=DEFAULT_INSTRUMENT_TYPE_KEY)
    service_interval_months: Mapped[int | None] = mapped_column(Integer, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


PLACE_KINDS = ("institution", "faculty", "room")


class Place(Base):
    """A place an instrument can be in, as a record of its own (plans: "plan for
    instrument locations"): an institution, a faculty inside an institution, or a
    room inside an institution or a faculty. One table with a `kind` and a
    `parent_id` rather than three, because an instrument points at the most
    specific place known (a room, else a faculty, else just the institution), and
    a lab or group level can later be one more kind. Step 1: filled from the
    instruments' institution and room text, and every instrument links to one, but
    nothing reads it yet. Names are stored with spaces collapsed; a name is unique
    (ignoring case) among places of the same kind under the same parent.
    Near-duplicates ("Bar Ilan" / "Bar-Ilan University") are never merged by guess."""

    __tablename__ = "places"

    id: Mapped[uuid.UUID] = _uuid_pk()
    kind: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("places.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # selectin: the room -> faculty -> institution chain is read for every
    # instrument (its institution and room text come from it), so load it in bulk
    parent: Mapped["Place | None"] = relationship(remote_side="Place.id", lazy="selectin")

    __table_args__ = (
        Index(
            "uq_places_kind_parent_name",
            "kind",
            text("coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)"),
            text("lower(name)"),
            unique=True,
        ),
        Index("ix_places_parent_id", "parent_id"),
    )


class Instrument(Base):
    """§5: the physical asset. `instrument_type` is the `key` of an
    InstrumentType row (default "flow_cytometer", shown as "Flow cytometer"), stored as a
    plain string rather than a native enum so adding a type needs no migration."""

    __tablename__ = "instruments"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String, nullable=False)
    instrument_type: Mapped[str] = mapped_column(String, nullable=False, default=DEFAULT_INSTRUMENT_TYPE_KEY)
    model: Mapped[str] = mapped_column(String, nullable=False)
    # The model's own record (instrument_models). Kept in step with `model` by
    # services/instrument_models.py on every save, so it is only empty for a
    # moment inside a transaction. The text above stays the source for now.
    model_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("instrument_models.id"), nullable=True, index=True
    )
    # The maker's name as people see it ("BD", "Beckman Coulter"); NULL when not
    # recorded. Typed text is matched to a Manufacturer record (by name or alias,
    # services/manufacturers.py) and replaced by that record's canonical name.
    manufacturer: Mapped[str | None] = mapped_column(String, nullable=True)
    manufacturer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("manufacturers.id"), nullable=True, index=True
    )
    manufacturer_record: Mapped["Manufacturer | None"] = relationship()
    # Free text: the company that sells and services this unit locally when that
    # is not the maker ("Rhenium", "almog diagnostic"); NULL when there is none or
    # it is not recorded. Optional, unlike the manufacturer.
    distributor: Mapped[str | None] = mapped_column(String, nullable=True)
    serial_number: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    # Where the unit is: the most specific place known (a room, else a faculty, else
    # the institution). The place record is the only copy; `institution` and
    # `location` (the room) below are read from it, and writing them finds or
    # creates the matching places (services/places.py).
    place_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("places.id", name="fk_instruments_place_id"), nullable=True, index=True
    )
    status: Mapped[InstrumentStatus] = mapped_column(
        Enum(InstrumentStatus, name="instrument_status"), nullable=False, default=InstrumentStatus.active
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # passive_deletes=True for the same reason as ReportTemplate.reports: without
    # it the ORM would null out each Report's instrument_id as part of deleting
    # an Instrument, silently defeating routers/instruments.py's in-use check
    # under a race. Left alone, the FK (no ondelete, so RESTRICT) rejects the
    # delete at commit time, which delete_instrument turns into a clean 409.
    reports: Mapped[list["Report"]] = relationship(back_populates="instrument", passive_deletes=True)
    model_record: Mapped["InstrumentModel | None"] = relationship()
    place: Mapped["Place | None"] = relationship(lazy="selectin")

    # `institution` (the university or company) and `location` (the room) are not
    # columns: the place record is the only copy (places plan, step 4). Reading
    # them gives the names along the place's chain; writing them (the API, the
    # seeds, tests) is remembered until the next flush, when services/places.py
    # finds or creates the matching places and points `place` at the most
    # specific one. Setting one keeps the other as it was.
    def _text(self, index: int) -> str | None:
        from app.services.places import text_of  # noqa: PLC0415 (places imports models)

        edit = self.__dict__.get("_text_edit")
        return (edit if edit is not None else text_of(self.place))[index]

    def _set_text(self, index: int, value: str | None) -> None:
        from sqlalchemy import inspect as sa_inspect  # noqa: PLC0415
        from sqlalchemy.orm.attributes import flag_modified  # noqa: PLC0415

        from app.services.places import text_of  # noqa: PLC0415

        edit = list(self.__dict__.get("_text_edit") or text_of(self.place))
        edit[index] = value
        self.__dict__["_text_edit"] = tuple(edit)
        if sa_inspect(self).persistent:
            self.place_id  # noqa: B018 (load it, so it can be marked as changed and the flush runs)
            flag_modified(self, "place_id")

    @property
    def institution(self) -> str | None:
        return self._text(0)

    @institution.setter
    def institution(self, value: str | None) -> None:
        self._set_text(0, value)

    @property
    def location(self) -> str | None:
        return self._text(1)

    @location.setter
    def location(self, value: str | None) -> None:
        self._set_text(1, value)
