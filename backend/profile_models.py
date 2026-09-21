"""Allowlisted response models for the read-only member attendance register."""
from typing import Optional

from pydantic import BaseModel, Field


class ProfileExcursion(BaseModel):
    out_at: Optional[str] = None
    in_at: Optional[str] = None
    expected_return: Optional[str] = None
    reason: Optional[str] = None


class ProfileSession(BaseModel):
    id: str
    check_in_at: Optional[str] = None
    check_out_at: Optional[str] = None
    hours: Optional[float] = None
    late_minutes: int = 0
    early_out_minutes: int = 0
    overtime_total_min: int = 0
    site_name: Optional[str] = None
    method: Optional[str] = None
    geo_reason: Optional[str] = None
    early_out_reason: Optional[str] = None
    overtime_reason: Optional[str] = None
    missing_checkout: bool = False
    needs_correction: bool = False
    out_of_geofence: bool = False
    excursions: list[ProfileExcursion] = Field(default_factory=list)


class ProfileLeave(BaseModel):
    id: str
    type: str
    status: str
    start_date: str
    end_date: str
    reason: Optional[str] = None
    half_day: Optional[str] = None
    decided_by: Optional[str] = None
    decided_at: Optional[str] = None
    converted_to_lop: bool = False


class ProfileDayMeta(BaseModel):
    break_name: Optional[str] = None
    applied_by: Optional[str] = None
    applied_at: Optional[str] = None
    range: Optional[str] = None
    reason: Optional[str] = None
    half_day: Optional[str] = None
    approved_by: Optional[str] = None
    balance_split: Optional[str] = None


class ProfileAttendanceDay(BaseModel):
    date: str
    code: str
    is_future: bool
    is_today: bool
    sessions: list[ProfileSession]
    leaves: list[ProfileLeave]
    meta: ProfileDayMeta
    manual_override: bool = False
    dar_status: str


class ProfileMonthTotals(BaseModel):
    present: int
    absent: int
    leave: int
    tour: int
    late: int
    lop: int
    ot_minutes: int
    early_out: int
    dar_missed: int


class ProfileAttendanceMonth(BaseModel):
    member_id: str
    member_name: Optional[str] = None
    month: str
    today: str
    timezone: str
    work_start: str
    work_end: str
    totals: ProfileMonthTotals
    days: list[ProfileAttendanceDay]