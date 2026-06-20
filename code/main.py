from __future__ import annotations

from functools import wraps

import uvicorn
from fastapi import FastAPI, Query
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from models import (
    EventCreate,
    EventUpdate,
    MaterialDepotCreate,
    MaterialDepotUpdate,
    PlanGenerateRequest,
    RepairTeamCreate,
    RepairTeamUpdate,
    RoadEdgeCreate,
    RoadEdgeUpdate,
    RoadNodeCreate,
    RoadNodeUpdate,
    ScenarioLoadRequest,
    SimulationActionRequest,
    SimulationSpeedRequest,
    SimulationStartRequest,
)
from services import (
    ServiceError,
    build_report,
    create_depot,
    create_edge,
    create_event,
    create_node,
    create_team,
    delete_depot,
    delete_edge,
    delete_event,
    delete_node,
    delete_team,
    export_network,
    export_report,
    export_resources,
    generate_plans,
    get_event,
    get_path,
    get_simulation,
    get_state,
    import_network,
    import_resources,
    list_depots,
    list_edges,
    list_events,
    list_network,
    list_nodes,
    list_plans_for_event,
    list_scenarios,
    list_teams,
    load_scenario,
    pause_simulation,
    reset_data,
    reset_simulation,
    resume_simulation,
    start_simulation,
    step_simulation,
    update_simulation_speed,
    update_depot,
    update_edge,
    update_event,
    update_node,
    update_team,
)
from storage import BASE_DIR, init_data_files


app = FastAPI(title="城市道路突发事件应急抢修仿真与辅助决策系统")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = BASE_DIR / "static"


def ok(data=None, message: str = "success") -> dict:
    return {"code": 200, "message": message, "data": data}


def handle_service(func):
    @wraps(func)
    async def wrapper(*args, **kwargs):
        try:
            return ok(func(*args, **kwargs))
        except ServiceError as exc:
            return {"code": exc.code, "message": exc.message, "data": None}
        except ValueError as exc:
            return {"code": 400, "message": str(exc), "data": None}
        except Exception as exc:  # pragma: no cover
            return {"code": 500, "message": str(exc), "data": None}

    return wrapper


@app.on_event("startup")
def on_startup() -> None:
    init_data_files()


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_, exc: RequestValidationError):
    return JSONResponse(status_code=200, content={"code": 400, "message": "参数错误", "data": {"errors": exc.errors()}})


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/api/state")
@handle_service
def api_state():
    return get_state()


@app.post("/api/reset-data")
@handle_service
def api_reset_data():
    return reset_data()


@app.get("/api/network")
@handle_service
def api_network():
    return list_network()


@app.get("/api/nodes")
@handle_service
def api_nodes():
    return list_nodes()


@app.post("/api/nodes")
@handle_service
def api_create_node(payload: RoadNodeCreate):
    return create_node(payload.model_dump())


@app.put("/api/nodes/{node_id}")
@handle_service
def api_update_node(node_id: str, payload: RoadNodeUpdate):
    return update_node(node_id, payload.model_dump(exclude_none=True))


@app.delete("/api/nodes/{node_id}")
@handle_service
def api_delete_node(node_id: str):
    delete_node(node_id)
    return None


@app.get("/api/edges")
@handle_service
def api_edges():
    return list_edges()


@app.post("/api/edges")
@handle_service
def api_create_edge(payload: RoadEdgeCreate):
    return create_edge(payload.model_dump())


@app.put("/api/edges/{edge_id}")
@handle_service
def api_update_edge(edge_id: str, payload: RoadEdgeUpdate):
    return update_edge(edge_id, payload.model_dump(exclude_none=True))


@app.delete("/api/edges/{edge_id}")
@handle_service
def api_delete_edge(edge_id: str):
    delete_edge(edge_id)
    return None


@app.get("/api/network/export")
@handle_service
def api_export_network():
    return export_network()


@app.post("/api/network/import")
@handle_service
def api_import_network(payload: dict):
    return import_network(payload)


@app.get("/api/events")
@handle_service
def api_events():
    return list_events()


@app.get("/api/events/{event_id}")
@handle_service
def api_get_event(event_id: str):
    return get_event(event_id)


@app.post("/api/events")
@handle_service
def api_create_event(payload: EventCreate):
    return create_event(payload.model_dump())


@app.put("/api/events/{event_id}")
@handle_service
def api_update_event(event_id: str, payload: EventUpdate):
    return update_event(event_id, payload.model_dump(exclude_none=True))


@app.delete("/api/events/{event_id}")
@handle_service
def api_delete_event(event_id: str):
    delete_event(event_id)
    return None


@app.get("/api/scenarios")
@handle_service
def api_scenarios():
    return list_scenarios()


@app.post("/api/scenarios/load")
@handle_service
def api_load_scenario(payload: ScenarioLoadRequest):
    return load_scenario(payload.scenarioId)


@app.get("/api/teams")
@handle_service
def api_teams():
    return list_teams()


@app.post("/api/teams")
@handle_service
def api_create_team(payload: RepairTeamCreate):
    return create_team(payload.model_dump())


@app.put("/api/teams/{team_id}")
@handle_service
def api_update_team(team_id: str, payload: RepairTeamUpdate):
    return update_team(team_id, payload.model_dump(exclude_none=True))


@app.delete("/api/teams/{team_id}")
@handle_service
def api_delete_team(team_id: str):
    delete_team(team_id)
    return None


@app.get("/api/depots")
@handle_service
def api_depots():
    return list_depots()


@app.post("/api/depots")
@handle_service
def api_create_depot(payload: MaterialDepotCreate):
    return create_depot(payload.model_dump())


@app.put("/api/depots/{depot_id}")
@handle_service
def api_update_depot(depot_id: str, payload: MaterialDepotUpdate):
    return update_depot(depot_id, payload.model_dump(exclude_none=True))


@app.delete("/api/depots/{depot_id}")
@handle_service
def api_delete_depot(depot_id: str):
    delete_depot(depot_id)
    return None


@app.get("/api/resources/export")
@handle_service
def api_export_resources():
    return export_resources()


@app.post("/api/resources/import")
@handle_service
def api_import_resources(payload: dict):
    return import_resources(payload)


@app.get("/api/path")
@handle_service
def api_path(from_node: str = Query(..., alias="from"), to_node: str = Query(..., alias="to")):
    return get_path(from_node, to_node)


@app.post("/api/plans/generate")
@handle_service
def api_generate_plans(payload: PlanGenerateRequest):
    return generate_plans(payload.eventId)


@app.get("/api/plans/{event_id}")
@handle_service
def api_plans(event_id: str):
    return list_plans_for_event(event_id)


@app.post("/api/simulation/start")
@handle_service
def api_start_simulation(payload: SimulationStartRequest):
    return start_simulation(payload.eventId, payload.planId)


@app.post("/api/simulation/step")
@handle_service
def api_step_simulation(payload: SimulationActionRequest):
    return step_simulation(payload.simulationId)


@app.post("/api/simulation/pause")
@handle_service
def api_pause_simulation(payload: SimulationActionRequest):
    return pause_simulation(payload.simulationId)


@app.post("/api/simulation/resume")
@handle_service
def api_resume_simulation(payload: SimulationActionRequest):
    return resume_simulation(payload.simulationId)


@app.post("/api/simulation/reset")
@handle_service
def api_reset_simulation(payload: SimulationActionRequest):
    return reset_simulation(payload.simulationId)


@app.post("/api/simulation/speed")
@handle_service
def api_update_simulation_speed(payload: SimulationSpeedRequest):
    return update_simulation_speed(payload.simulationId, payload.speed)


@app.get("/api/simulation/{simulation_id}")
@handle_service
def api_get_simulation(simulation_id: str):
    return get_simulation(simulation_id)


@app.get("/api/report/{event_id}")
@handle_service
def api_report(event_id: str):
    return build_report(event_id)


@app.get("/api/report/{event_id}/export")
@handle_service
def api_export_report(event_id: str):
    return export_report(event_id)


if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=False)
