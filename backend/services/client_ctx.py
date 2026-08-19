"""Per-request client id (X-Client-Id header) so live-update signals can
tell clients which browser tab originated a change (echo suppression)."""
from contextvars import ContextVar

current_client_id: ContextVar[str] = ContextVar("current_client_id", default="")
