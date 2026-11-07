"""Pydantic request/response shapes for the API in app/routers/.

Kept close to the ORM models but separate from them on purpose — a report in
`draft` has no instrument or template yet (§4/§5), so the response shape has
to make those genuinely optional rather than just nullable columns leaking
through.
"""
from __future__ import annotations

from app.schemas.config import *  # noqa: F401,F403
from app.schemas.instruments import *  # noqa: F401,F403
from app.schemas.instrument_models import *  # noqa: F401,F403
from app.schemas.places import *  # noqa: F401,F403
from app.schemas.templates import *  # noqa: F401,F403
from app.schemas.reports import *  # noqa: F401,F403
from app.schemas.extraction import *  # noqa: F401,F403
from app.schemas.analytics import *  # noqa: F401,F403
from app.schemas.saved_filters import *  # noqa: F401,F403
from app.schemas.home import *  # noqa: F401,F403
