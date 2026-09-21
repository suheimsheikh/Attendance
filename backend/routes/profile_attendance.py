"""Read-only self and admin member registers, using existing access dependencies."""
from fastapi import APIRouter, Depends, HTTPException

from profile_models import ProfileAttendanceMonth
from services.profile_attendance import attendance_month


def make_router(db, get_current_user, require_admin, grid_impl) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/me/attendance-month", response_model=ProfileAttendanceMonth)
    async def own_month(month: str | None = None, user: dict = Depends(get_current_user)):
        return await attendance_month(db, grid_impl, user, month)

    @router.get("/admin/members/{member_id}/attendance-month", response_model=ProfileAttendanceMonth)
    async def member_month(member_id: str, month: str | None = None,
                           admin: dict = Depends(require_admin)):
        user = await db.users.find_one({"id": member_id}, {
            "_id": 0, "id": 1, "category": 1, "status": 1, "dar_exempt": 1, "dar_required": 1,
        })
        if not user:
            raise HTTPException(404, "Member not found")
        return await attendance_month(db, grid_impl, user, month)

    return router