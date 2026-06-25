"""
Sub-routers split out of `server.py`. Each module exposes a `make_router(...)`
factory matching the same pattern as `camps.py`, `breaks.py`, `sms.py`, etc.
The factories receive their callable dependencies (admin guard, current-user
guard, helper functions) as arguments — keeps the modules import-cycle-free
with the monolith server module.
"""
