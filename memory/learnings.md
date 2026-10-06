# Learnings / gotchas

- FastAPI + `from __future__ import annotations`: request-body Pydantic models MUST be module-level. A model declared inside a router factory (`def make_router(...)`) can't be resolved from the function's globals, so FastAPI silently treats `body` as a required query param → every call 422 `loc: [query, body]`. Scan: iterate `app.routes`, check `route.dependant.query_params` for annotations that are str/ForwardRef.
- When splitting closures into modules, verify the ORDERED route table (route priority) and run ruff F821. Watch `Path(__file__)` (depth changes when a module becomes a package) and `logging.getLogger(__name__)`.
- Splitter tooling used for meals/reports: /root/pkg_step1.py + /root/pkg_extract.py (may be lost on pod restart).
