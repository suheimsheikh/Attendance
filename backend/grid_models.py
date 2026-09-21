"""External payroll Grid response, preserving the legacy row contract."""
from pydantic import BaseModel, ConfigDict, Field


class GridPunchCell(BaseModel):
    code: str
    in_time: str | None = Field(default=None, alias="in")
    out_time: str | None = Field(default=None, alias="out")


class GridReadRow(BaseModel):
    model_config = ConfigDict(extra="allow")

    member_id: str
    member_name: str | None
    rank: str | None
    category: str | None
    fleet: str | None
    institution: str | None
    work_start: str
    work_end: str
    cells: list[str]
    cell_meta: dict[str, GridPunchCell]
    totals: dict[str, int]


class GridReadResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    month: str
    start: str
    end: str
    today: str
    days: list[str]
    rows: list[GridReadRow]