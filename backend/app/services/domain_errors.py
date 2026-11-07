"""Errors a service raises for a request it has to refuse.

A service says what went wrong in plain words; app/main.py turns each type into
the HTTP status the routers used to raise by hand (the body is the same
`{"detail": message}`). That keeps routers thin and the rules testable without
FastAPI, in the same way `PlaceTextError` (services/places.py) already works.
"""
from __future__ import annotations


class DomainError(Exception):
    """Base class — the message is shown to the person."""


class NotFoundError(DomainError):
    """The record asked for does not exist (404)."""


class ConflictError(DomainError):
    """The request clashes with what is already stored (409)."""


class InvalidError(DomainError):
    """The request cannot be carried out as written (422)."""
