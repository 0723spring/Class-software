from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, field_validator


class RoadNodeType(str, Enum):
    intersection = "intersection"
    station = "station"
    depot = "depot"


class RoadStatus(str, Enum):
    normal = "normal"
    congested = "congested"
    damaged = "damaged"
    closed = "closed"
    repairing = "repairing"
    recovered = "recovered"


class EventType(str, Enum):
    road_collapse = "road_collapse"
    waterlogging = "waterlogging"
    bridge_damage = "bridge_damage"
    pipe_burst = "pipe_burst"
    traffic_accident = "traffic_accident"


class Severity(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"


class EventStatus(str, Enum):
    created = "created"
    planned = "planned"
    running = "running"
    finished = "finished"
    cancelled = "cancelled"


class TeamSkill(str, Enum):
    road_repair = "road_repair"
    drainage = "drainage"
    bridge_repair = "bridge_repair"
    pipe_repair = "pipe_repair"
    general = "general"


class TeamStatus(str, Enum):
    idle = "idle"
    busy = "busy"
    offline = "offline"


class MaterialType(str, Enum):
    asphalt = "asphalt"
    drainage_pump = "drainage_pump"
    steel = "steel"
    pipe = "pipe"
    general = "general"


class PlanStrategy(str, Enum):
    nearest = "nearest"
    skill_first = "skill_first"
    collaboration = "collaboration"


class SimulationStatus(str, Enum):
    ready = "ready"
    running = "running"
    paused = "paused"
    finished = "finished"
    reset = "reset"


class ApiEnvelope(BaseModel):
    code: int = 200
    message: str = "success"
    data: Any = None


class RoadNodeBase(BaseModel):
    id: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    x: float
    y: float
    type: RoadNodeType


class RoadNodeCreate(RoadNodeBase):
    pass


class RoadNodeUpdate(BaseModel):
    name: str | None = None
    x: float | None = None
    y: float | None = None
    type: RoadNodeType | None = None


class RoadEdgeBase(BaseModel):
    id: str = Field(..., min_length=1)
    fromNode: str = Field(..., min_length=1)
    toNode: str = Field(..., min_length=1)
    length: float
    speed: float
    flow: float
    status: RoadStatus

    @field_validator("length", "speed")
    @classmethod
    def positive_number(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("must be greater than 0")
        return value

    @field_validator("flow")
    @classmethod
    def non_negative_flow(cls, value: float) -> float:
        if value < 0:
            raise ValueError("must be greater than or equal to 0")
        return value


class RoadEdgeCreate(RoadEdgeBase):
    pass


class RoadEdgeUpdate(BaseModel):
    fromNode: str | None = None
    toNode: str | None = None
    length: float | None = None
    speed: float | None = None
    flow: float | None = None
    status: RoadStatus | None = None


class EventCreate(BaseModel):
    type: EventType
    roadId: str
    severity: Severity
    startTime: str
    workload: float = Field(..., gt=0)
    blocked: bool


class EventUpdate(BaseModel):
    type: EventType | None = None
    roadId: str | None = None
    severity: Severity | None = None
    startTime: str | None = None
    workload: float | None = Field(None, gt=0)
    blocked: bool | None = None


class ScenarioLoadRequest(BaseModel):
    scenarioId: str


class RepairTeamBase(BaseModel):
    id: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    locationNode: str
    workers: int = Field(..., ge=0)
    vehicles: int = Field(..., ge=0)
    skill: TeamSkill
    efficiency: float = Field(..., gt=0)
    status: TeamStatus


class RepairTeamCreate(RepairTeamBase):
    pass


class RepairTeamUpdate(BaseModel):
    name: str | None = None
    locationNode: str | None = None
    workers: int | None = Field(None, ge=0)
    vehicles: int | None = Field(None, ge=0)
    skill: TeamSkill | None = None
    efficiency: float | None = Field(None, gt=0)
    status: TeamStatus | None = None


class MaterialDepotBase(BaseModel):
    id: str = Field(..., min_length=1)
    nodeId: str
    materialType: MaterialType
    stock: float = Field(..., ge=0)


class MaterialDepotCreate(MaterialDepotBase):
    pass


class MaterialDepotUpdate(BaseModel):
    nodeId: str | None = None
    materialType: MaterialType | None = None
    stock: float | None = Field(None, ge=0)


class PlanGenerateRequest(BaseModel):
    eventId: str


class SimulationStartRequest(BaseModel):
    eventId: str
    planId: str


class SimulationActionRequest(BaseModel):
    simulationId: str


class SimulationSpeedRequest(BaseModel):
    simulationId: str
    speed: float = Field(..., gt=0, le=10)
