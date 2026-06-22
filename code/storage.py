from __future__ import annotations

import json
import tempfile
from copy import deepcopy
from pathlib import Path
from typing import Any

from models import MaterialDepotBase, RepairTeamBase, RoadEdgeBase, RoadNodeBase


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"


DEFAULT_DATA: dict[str, Any] = {
    "network": {
        "nodes": [
            {"id": "A", "name": "中心路口", "x": 120, "y": 180, "type": "intersection"},
            {"id": "B", "name": "东一路口", "x": 260, "y": 180, "type": "intersection"},
            {"id": "C", "name": "西一路口", "x": 120, "y": 80, "type": "intersection"},
            {"id": "D", "name": "北环路口", "x": 260, "y": 80, "type": "intersection"},
            {"id": "E", "name": "中央枢纽", "x": 380, "y": 180, "type": "intersection"},
            {"id": "F", "name": "排水仓库", "x": 520, "y": 180, "type": "depot"},
            {"id": "G", "name": "西南路口", "x": 120, "y": 320, "type": "intersection"},
            {"id": "H", "name": "南环路口", "x": 380, "y": 320, "type": "intersection"},
            {"id": "I", "name": "抢修站", "x": 560, "y": 320, "type": "station"},
        ],
        "edges": [
            {"id": "AB", "fromNode": "A", "toNode": "B", "length": 1.2, "speed": 40, "flow": 900, "status": "normal"},
            {"id": "AC", "fromNode": "A", "toNode": "C", "length": 1.0, "speed": 35, "flow": 500, "status": "normal"},
            {"id": "BD", "fromNode": "B", "toNode": "D", "length": 1.1, "speed": 35, "flow": 700, "status": "normal"},
            {"id": "BE", "fromNode": "B", "toNode": "E", "length": 1.3, "speed": 40, "flow": 1100, "status": "normal"},
            {"id": "CD", "fromNode": "C", "toNode": "D", "length": 1.5, "speed": 30, "flow": 600, "status": "congested"},
            {"id": "DE", "fromNode": "D", "toNode": "E", "length": 1.0, "speed": 30, "flow": 800, "status": "normal"},
            {"id": "EG", "fromNode": "E", "toNode": "G", "length": 2.6, "speed": 30, "flow": 650, "status": "normal"},
            {"id": "EH", "fromNode": "E", "toNode": "H", "length": 1.4, "speed": 35, "flow": 1000, "status": "normal"},
            {"id": "FH", "fromNode": "F", "toNode": "H", "length": 1.7, "speed": 35, "flow": 750, "status": "normal"},
            {"id": "FI", "fromNode": "F", "toNode": "I", "length": 1.8, "speed": 35, "flow": 400, "status": "normal"},
            {"id": "GH", "fromNode": "G", "toNode": "H", "length": 2.0, "speed": 30, "flow": 550, "status": "normal"},
            {"id": "HI", "fromNode": "H", "toNode": "I", "length": 1.6, "speed": 30, "flow": 1300, "status": "normal"},
        ],
    },
    "events": {"events": []},
    "resources": {
        "teams": [
            {"id": "T01", "name": "抢修一队", "locationNode": "A", "workers": 8, "vehicles": 2, "skill": "road_repair", "efficiency": 0.8, "status": "idle"},
            {"id": "T02", "name": "排水抢险队", "locationNode": "I", "workers": 6, "vehicles": 1, "skill": "drainage", "efficiency": 0.9, "status": "idle"},
            {"id": "T03", "name": "桥梁维护队", "locationNode": "F", "workers": 7, "vehicles": 2, "skill": "bridge_repair", "efficiency": 0.75, "status": "idle"},
        ],
        "depots": [
            {"id": "D01", "nodeId": "F", "materialType": "asphalt", "stock": 300},
            {"id": "D02", "nodeId": "I", "materialType": "drainage_pump", "stock": 40},
            {"id": "D03", "nodeId": "F", "materialType": "steel", "stock": 180},
            {"id": "D04", "nodeId": "I", "materialType": "pipe", "stock": 150},
            {"id": "D05", "nodeId": "F", "materialType": "general", "stock": 200},
        ],
    },
    "scenarios": {
        "scenarios": [
            {"id": "S001", "type": "road_collapse", "roadId": "HI", "severity": "high", "startTime": "08:10", "workload": 120, "blocked": True},
            {"id": "S002", "type": "waterlogging", "roadId": "CD", "severity": "medium", "startTime": "09:00", "workload": 80, "blocked": False},
        ]
    },
    "plans": {"plans": []},
    "simulations": {"simulations": []},
}


def init_data_files() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for name, payload in DEFAULT_DATA.items():
        path = DATA_DIR / f"{name}.json"
        if not path.exists():
            atomic_write_json(path, payload)


def data_path(name: str) -> Path:
    return DATA_DIR / f"{name}.json"


def load_json(name: str) -> Any:
    path = data_path(name)
    if not path.exists():
        atomic_write_json(path, deepcopy(DEFAULT_DATA[name]))
    with path.open("r", encoding="utf-8") as file_obj:
        return json.load(file_obj)


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=path.parent) as temp_file:
        json.dump(payload, temp_file, ensure_ascii=False, indent=2)
        temp_name = temp_file.name
    Path(temp_name).replace(path)


def save_json(name: str, payload: Any) -> None:
    atomic_write_json(data_path(name), payload)


def reset_data_files() -> None:
    for name, payload in DEFAULT_DATA.items():
        save_json(name, deepcopy(payload))


def validate_network_import(payload: dict[str, Any]) -> dict[str, Any]:
    if "nodes" not in payload or "edges" not in payload:
        raise ValueError("network import must include nodes and edges")
    node_ids: set[str] = set()
    edge_ids: set[str] = set()
    validated_nodes = []
    validated_edges = []
    for node in payload["nodes"]:
        model = RoadNodeBase.model_validate(node)
        if model.id in node_ids:
            raise ValueError(f"duplicate node id: {model.id}")
        node_ids.add(model.id)
        validated_nodes.append(model.model_dump())
    for edge in payload["edges"]:
        model = RoadEdgeBase.model_validate(edge)
        if model.id in edge_ids:
            raise ValueError(f"duplicate edge id: {model.id}")
        if model.fromNode not in node_ids or model.toNode not in node_ids:
            raise ValueError(f"edge {model.id} references missing nodes")
        edge_ids.add(model.id)
        validated_edges.append(model.model_dump())
    return {"nodes": validated_nodes, "edges": validated_edges}


def validate_resources_import(payload: dict[str, Any], node_ids: set[str]) -> dict[str, Any]:
    if "teams" not in payload or "depots" not in payload:
        raise ValueError("resources import must include teams and depots")
    team_ids: set[str] = set()
    depot_ids: set[str] = set()
    teams = []
    depots = []
    for team in payload["teams"]:
        model = RepairTeamBase.model_validate(team)
        if model.id in team_ids:
            raise ValueError(f"duplicate team id: {model.id}")
        if model.locationNode not in node_ids:
            raise ValueError(f"team {model.id} references missing locationNode")
        team_ids.add(model.id)
        teams.append(model.model_dump())
    for depot in payload["depots"]:
        model = MaterialDepotBase.model_validate(depot)
        if model.id in depot_ids:
            raise ValueError(f"duplicate depot id: {model.id}")
        if model.nodeId not in node_ids:
            raise ValueError(f"depot {model.id} references missing nodeId")
        depot_ids.add(model.id)
        depots.append(model.model_dump())
    return {"teams": teams, "depots": depots}
