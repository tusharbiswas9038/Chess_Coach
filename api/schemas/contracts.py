from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class StatusResponse(BaseModel):
    status: str


class JobActionResponse(StatusResponse):
    vacuum: bool | None = None


class JobStatusResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    status: str | None = None
    id: str | None = None
    queue_size: int
    queue_max_size: int
    worker_running: bool
    recent_jobs: list[dict[str, Any]] = Field(default_factory=list)


class SessionDayResponse(BaseModel):
    games_played: int
    tilt_detected: int
    result_sequence: str


class WeeklyFocusResponse(BaseModel):
    window_days: int
    primary_focus: dict[str, Any] | None = None
    secondary_focus: dict[str, Any] | None = None
    due_drills: int
    recent_games_total: int
    recent_games_analyzed: int
    mistake_trend: str
    actions: list[str]


class PlayerModelResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    status: str | None = None
    message: str | None = None


class StatsResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    profile: dict[str, Any]
    games: dict[str, int]
    hanging_piece_rate: float
    blunders_per_game: float
    recent_games: list[dict[str, Any]]
    mistake_breakdown: list[dict[str, Any]]
    weekly_stats: list[dict[str, Any]]
    drills_due: int
    due_drills_warning: bool


class DashboardBootstrapResponse(BaseModel):
    stats: StatsResponse
    weekly_focus: WeeklyFocusResponse
    latest_session: dict[str, Any] | None = None
