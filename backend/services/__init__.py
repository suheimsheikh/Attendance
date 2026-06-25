"""
Pure-helper modules extracted from `server.py`.

These modules contain **only** stateless utilities — no database access, no
FastAPI request objects, no Pydantic models. They can be unit-tested in
isolation and are imported by the route handlers in `server.py` (and, after
the planned router-split, the `routes/*` modules).
"""
