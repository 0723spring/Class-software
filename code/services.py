from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from typing import Any

from algorithms import (
    calculate_risk_penalty,
    estimate_required_materials,
    normalize_plan_metrics,
    shortest_path,
    skill_match_score,
)
from models import EventStatus, RoadStatus, SimulationStatus, TeamStatus
from storage import (
    load_json,
    reset_data_files,
    save_json,
    validate_network_import,
    validate_resources_import,
)


class ServiceError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def next_id(prefix: str, items: list[dict[str, Any]]) -> str:
    max_value = 0
    for item in items:
        raw_id = item["id"]
        if raw_id.startswith(prefix):
            suffix = raw_id[len(prefix) :]
            if suffix.isdigit():
                max_value = max(max_value, int(suffix))
    return f"{prefix}{max_value + 1:03d}"


def load_all() -> dict[str, Any]:
    return {
        "network": load_json("network"),
        "events": load_json("events")["events"],
        "resources": load_json("resources"),
        "scenarios": load_json("scenarios")["scenarios"],
        "plans": load_json("plans")["plans"],
        "simulations": load_json("simulations")["simulations"],
    }


def save_all(payload: dict[str, Any]) -> None:
    save_json("network", payload["network"])
    save_json("events", {"events": payload["events"]})
    save_json("resources", payload["resources"])
    save_json("scenarios", {"scenarios": payload["scenarios"]})
    save_json("plans", {"plans": payload["plans"]})
    save_json("simulations", {"simulations": payload["simulations"]})


def remove_event_plans(dataset: dict[str, Any], event_id: str) -> None:
    dataset["plans"] = [plan for plan in dataset["plans"] if plan["eventId"] != event_id]


def planning_fields_changed(event: dict[str, Any], payload: dict[str, Any]) -> bool:
    tracked_fields = {"type", "roadId", "severity", "workload", "blocked", "startTime"}
    return any(field in payload and payload[field] != event.get(field) for field in tracked_fields)


def active_event_statuses() -> set[str]:
    return {EventStatus.created.value, EventStatus.planned.value, EventStatus.running.value}


def active_simulation_statuses() -> set[str]:
    return {SimulationStatus.running.value, SimulationStatus.paused.value}


def current_active_simulation_count(dataset: dict[str, Any]) -> int:
    return sum(1 for simulation in dataset["simulations"] if simulation["status"] in active_simulation_statuses())


def severity_factor(severity: str) -> float:
    return {"low": 0.8, "medium": 1.0, "high": 1.25}.get(severity, 1.0)


def team_skill_factor(event_type: str, team_skill: str) -> float:
    skill_score = skill_match_score(event_type, team_skill)
    return {2: 1.0, 1: 0.65, 0: 0.2}.get(skill_score, 0.2)


def calculate_affected_vehicles(edge_flow: float, total_time: float, severity: str, strategy: str) -> float:
    strategy_factor = {"nearest": 1.0, "skill_first": 0.92, "collaboration": 0.88}.get(strategy, 1.0)
    impact = edge_flow * severity_factor(severity) * max(total_time, 1.0) / 10 * strategy_factor
    return round(impact, 2)


def calculate_material_cost(required_materials: list[dict[str, Any]]) -> float:
    unit_prices = {
        "asphalt": 18,
        "drainage_pump": 120,
        "steel": 32,
        "pipe": 24,
        "general": 10,
    }
    return round(sum(item["quantity"] * unit_prices.get(item["materialType"], 12) for item in required_materials), 2)


def allocate_materials(dataset: dict[str, Any], required_materials: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    allocations: list[dict[str, Any]] = []
    shortages: list[dict[str, Any]] = []
    depots = dataset["resources"]["depots"]
    for item in required_materials:
        material_type = item["materialType"]
        remaining = float(item["quantity"])
        candidate_depots = sorted(
            [
                depot
                for depot in depots
                if depot["materialType"] in {material_type, "general"} and float(depot["stock"]) > 0
            ],
            key=lambda depot: (depot["materialType"] != material_type, -float(depot["stock"])),
        )
        for depot in candidate_depots:
            if remaining <= 0:
                break
            used = min(float(depot["stock"]), remaining)
            if used <= 0:
                continue
            depot["stock"] = round(float(depot["stock"]) - used, 2)
            remaining = round(remaining - used, 2)
            allocations.append({"depotId": depot["id"], "materialType": material_type, "quantity": used})
        if remaining > 0:
            shortages.append({"materialType": material_type, "missing": remaining})
    return allocations, shortages


def restore_materials(dataset: dict[str, Any], allocations: list[dict[str, Any]]) -> None:
    depot_by_id = {depot["id"]: depot for depot in dataset["resources"]["depots"]}
    for item in allocations:
        depot = depot_by_id.get(item["depotId"])
        if depot is not None:
            depot["stock"] = round(float(depot["stock"]) + float(item["quantity"]), 2)


def assess_material_availability(dataset: dict[str, Any], required_materials: list[dict[str, Any]]) -> tuple[bool, list[dict[str, Any]]]:
    dataset_copy = {"resources": {"depots": deepcopy(dataset["resources"]["depots"])}}
    _, shortages = allocate_materials(dataset_copy, required_materials)
    return len(shortages) == 0, shortages


def simulation_phase(progress: float) -> str:
    if progress < 20:
        return "dispatch"
    if progress < 40:
        return "travel"
    if progress < 85:
        return "repairing"
    if progress < 100:
        return "finishing"
    return "finished"


def update_team_positions(simulation: dict[str, Any], plan: dict[str, Any]) -> None:
    team_routes = plan.get("teamRoutes", {})
    progress = simulation["progress"]
    for team_id in list(simulation["teamPositions"].keys()):
        route = team_routes.get(team_id) or plan.get("route", [])
        if not route:
            continue
        if progress < 40:
            travel_progress = progress / 40
            route_index = min(len(route) - 1, int(travel_progress * max(1, len(route) - 1)))
            current_node = route[route_index]
        else:
            current_node = route[-1]
        simulation["teamPositions"][team_id] = current_node


def current_affected_vehicle_count(plan: dict[str, Any], progress: float) -> float:
    base = float(plan.get("affectedVehicles", 0))
    if progress < 20:
        factor = max(0.92, 1.0 - progress / 250)
    elif progress < 40:
        factor = max(0.75, 0.92 - (progress - 20) / 120)
    elif progress < 85:
        factor = max(0.15, 0.75 - (progress - 40) / 75)
    else:
        factor = max(0.0, 0.15 - (progress - 85) / 35)
    return round(base * factor, 2)


def find_by_id(items: list[dict[str, Any]], item_id: str, label: str) -> dict[str, Any]:
    for item in items:
        if item["id"] == item_id:
            return item
    raise ServiceError(404, f"{label}不存在")


def get_state() -> dict[str, Any]:
    dataset = load_all()
    return {
        "nodes": dataset["network"]["nodes"],
        "edges": dataset["network"]["edges"],
        "events": dataset["events"],
        "teams": dataset["resources"]["teams"],
        "depots": dataset["resources"]["depots"],
        "plans": dataset["plans"],
        "simulations": dataset["simulations"],
        "metrics": build_metrics(dataset),
    }


def build_metrics(dataset: dict[str, Any]) -> dict[str, Any]:
    events = dataset["events"]
    simulations = dataset["simulations"]
    plans = dataset["plans"]
    finished_simulations = [simulation for simulation in simulations if simulation["status"] == SimulationStatus.finished.value]
    average_recovery_time = 0.0
    if finished_simulations:
        related_plans = {plan["id"]: plan for plan in plans}
        total = sum(related_plans.get(simulation["planId"], {}).get("totalTime", 0) for simulation in finished_simulations)
        average_recovery_time = round(total / len(finished_simulations), 2)
    active_events = [event for event in events if event["status"] in active_event_statuses()]
    affected_vehicles = 0
    for event in active_events:
        running_simulation = next(
            (
                simulation
                for simulation in dataset["simulations"]
                if simulation["eventId"] == event["id"] and simulation["status"] in active_simulation_statuses()
            ),
            None,
        )
        if running_simulation is not None:
            affected_vehicles += running_simulation.get("currentAffectedVehicles", 0)
        else:
            edge = next((edge for edge in dataset["network"]["edges"] if edge["id"] == event["roadId"]), None)
            affected_vehicles += 0 if edge is None else edge["flow"]
    recovered_roads = sum(1 for edge in dataset["network"]["edges"] if edge["status"] == RoadStatus.recovered.value)
    return {
        "eventCount": len(events),
        "activeTasks": len(active_events),
        "averageRecoveryTime": average_recovery_time,
        "affectedVehicles": round(affected_vehicles, 2),
        "recoveredRoads": recovered_roads,
    }


def reset_data() -> dict[str, Any]:
    reset_data_files()
    return get_state()


def list_network() -> dict[str, Any]:
    return load_json("network")


def list_nodes() -> list[dict[str, Any]]:
    return load_json("network")["nodes"]


def list_edges() -> list[dict[str, Any]]:
    return load_json("network")["edges"]


def create_node(payload: dict[str, Any]) -> dict[str, Any]:
    dataset = load_all()
    if any(node["id"] == payload["id"] for node in dataset["network"]["nodes"]):
        raise ServiceError(409, "节点 id 已存在")
    dataset["network"]["nodes"].append(payload)
    save_all(dataset)
    return payload


def update_node(node_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    dataset = load_all()
    node = find_by_id(dataset["network"]["nodes"], node_id, "节点")
    node.update(payload)
    save_all(dataset)
    return node


def delete_node(node_id: str) -> None:
    dataset = load_all()
    for edge in dataset["network"]["edges"]:
        if edge["fromNode"] == node_id or edge["toNode"] == node_id:
            raise ServiceError(409, "节点被道路引用，无法删除")
    for team in dataset["resources"]["teams"]:
        if team["locationNode"] == node_id:
            raise ServiceError(409, "节点被抢修队引用，无法删除")
    for depot in dataset["resources"]["depots"]:
        if depot["nodeId"] == node_id:
            raise ServiceError(409, "节点被仓库引用，无法删除")
    dataset["network"]["nodes"] = [node for node in dataset["network"]["nodes"] if node["id"] != node_id]
    save_all(dataset)


def create_edge(payload: dict[str, Any]) -> dict[str, Any]:
    dataset = load_all()
    node_ids = {node["id"] for node in dataset["network"]["nodes"]}
    if payload["id"] in {edge["id"] for edge in dataset["network"]["edges"]}:
        raise ServiceError(409, "道路 id 已存在")
    if payload["fromNode"] not in node_ids or payload["toNode"] not in node_ids:
        raise ServiceError(400, "道路引用的节点不存在")
    dataset["network"]["edges"].append(payload)
    save_all(dataset)
    return payload


def update_edge(edge_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    dataset = load_all()
    edge = find_by_id(dataset["network"]["edges"], edge_id, "道路")
    node_ids = {node["id"] for node in dataset["network"]["nodes"]}
    merged = {**edge, **payload}
    if merged["fromNode"] not in node_ids or merged["toNode"] not in node_ids:
        raise ServiceError(400, "道路引用的节点不存在")
    edge.update(payload)
    save_all(dataset)
    return edge


def delete_edge(edge_id: str) -> None:
    dataset = load_all()
    for event in dataset["events"]:
        if event["roadId"] == edge_id and event["status"] in active_event_statuses():
            raise ServiceError(409, "道路被未完成事件引用，无法删除")
    dataset["network"]["edges"] = [edge for edge in dataset["network"]["edges"] if edge["id"] != edge_id]
    save_all(dataset)


def export_network() -> dict[str, Any]:
    return load_json("network")


def import_network(payload: dict[str, Any]) -> dict[str, Any]:
    validated = validate_network_import(payload)
    dataset = load_all()
    current_node_ids = {node["id"] for node in validated["nodes"]}
    current_edge_ids = {edge["id"] for edge in validated["edges"]}
    for event in dataset["events"]:
        if event["roadId"] not in current_edge_ids:
            raise ServiceError(409, f"导入后会导致事件 {event['id']} 丢失 roadId")
    for team in dataset["resources"]["teams"]:
        if team["locationNode"] not in current_node_ids:
            raise ServiceError(409, f"导入后会导致队伍 {team['id']} 丢失位置节点")
    for depot in dataset["resources"]["depots"]:
        if depot["nodeId"] not in current_node_ids:
            raise ServiceError(409, f"导入后会导致仓库 {depot['id']} 丢失节点")
    event_status_by_id = {event["id"]: event["status"] for event in dataset["events"]}
    for plan in dataset["plans"]:
        if event_status_by_id.get(plan["eventId"]) in active_event_statuses():
            if any(node_id not in current_node_ids for node_id in plan.get("route", [])):
                raise ServiceError(409, f"导入后会导致方案 {plan['id']} 路径节点失效")
            for route in plan.get("teamRoutes", {}).values():
                if any(node_id not in current_node_ids for node_id in route):
                    raise ServiceError(409, f"导入后会导致方案 {plan['id']} 队伍路线失效")
    for simulation in dataset["simulations"]:
        if simulation["status"] in active_simulation_statuses():
            if simulation["roadId"] not in current_edge_ids:
                raise ServiceError(409, f"导入后会导致仿真 {simulation['id']} 丢失 roadId")
            if any(node_id not in current_node_ids for node_id in simulation.get("teamPositions", {}).values()):
                raise ServiceError(409, f"导入后会导致仿真 {simulation['id']} 队伍位置失效")
            snapshot_nodes = [item["locationNode"] for item in simulation.get("beforeSimulationSnapshot", {}).get("teams", [])]
            if any(node_id not in current_node_ids for node_id in snapshot_nodes):
                raise ServiceError(409, f"导入后会导致仿真 {simulation['id']} 快照节点失效")
    dataset["network"] = validated
    for event in dataset["events"]:
        recalculate_road_status(dataset, event["roadId"])
    save_all(dataset)
    return validated


def list_events() -> list[dict[str, Any]]:
    return load_json("events")["events"]


def get_event(event_id: str) -> dict[str, Any]:
    return find_by_id(load_json("events")["events"], event_id, "事件")


def create_event(payload: dict[str, Any]) -> dict[str, Any]:
    dataset = load_all()
    edge = find_by_id(dataset["network"]["edges"], payload["roadId"], "道路")
    event = {
        "id": next_id("E", dataset["events"]),
        **payload,
        "status": EventStatus.created.value,
        "originalRoadStatus": edge["status"],
        "selectedPlanId": None,
        "currentSimulationId": None,
        "createdAt": now_text(),
        "updatedAt": now_text(),
    }
    dataset["events"].append(event)
    recalculate_road_status(dataset, payload["roadId"])
    save_all(dataset)
    return event


def update_event(event_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    dataset = load_all()
    event = find_by_id(dataset["events"], event_id, "事件")
    if event["status"] not in {EventStatus.created.value, EventStatus.planned.value}:
        raise ServiceError(409, "当前事件状态不允许修改核心字段")
    should_reset_plans = planning_fields_changed(event, payload)
    old_road_id = event["roadId"]
    new_road_id = payload.get("roadId", old_road_id)
    if new_road_id != old_road_id:
        find_by_id(dataset["network"]["edges"], new_road_id, "道路")
    event.update(payload)
    if should_reset_plans:
        remove_event_plans(dataset, event_id)
        event["selectedPlanId"] = None
        event["currentSimulationId"] = None
        event["status"] = EventStatus.created.value
    event["updatedAt"] = now_text()
    recalculate_road_status(dataset, old_road_id)
    recalculate_road_status(dataset, event["roadId"])
    save_all(dataset)
    return event


def delete_event(event_id: str) -> None:
    dataset = load_all()
    event = find_by_id(dataset["events"], event_id, "事件")
    if event["status"] == EventStatus.running.value:
        raise ServiceError(409, "running 事件不可删除")
    road_id = event["roadId"]
    dataset["events"] = [item for item in dataset["events"] if item["id"] != event_id]
    remove_event_plans(dataset, event_id)
    if event.get("currentSimulationId"):
        dataset["simulations"] = [simulation for simulation in dataset["simulations"] if simulation["id"] != event["currentSimulationId"]]
    recalculate_road_status(dataset, road_id)
    save_all(dataset)


def list_scenarios() -> list[dict[str, Any]]:
    return load_json("scenarios")["scenarios"]


def load_scenario(scenario_id: str) -> dict[str, Any]:
    scenario = find_by_id(load_json("scenarios")["scenarios"], scenario_id, "预设场景")
    return create_event({key: scenario[key] for key in ["type", "roadId", "severity", "startTime", "workload", "blocked"]})


def list_teams() -> list[dict[str, Any]]:
    return load_json("resources")["teams"]


def create_team(payload: dict[str, Any]) -> dict[str, Any]:
    dataset = load_all()
    if payload["id"] in {team["id"] for team in dataset["resources"]["teams"]}:
        raise ServiceError(409, "队伍 id 已存在")
    node_ids = {node["id"] for node in dataset["network"]["nodes"]}
    if payload["locationNode"] not in node_ids:
        raise ServiceError(400, "locationNode 不存在")
    dataset["resources"]["teams"].append(payload)
    save_all(dataset)
    return payload


def update_team(team_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    dataset = load_all()
    team = find_by_id(dataset["resources"]["teams"], team_id, "队伍")
    node_ids = {node["id"] for node in dataset["network"]["nodes"]}
    if payload.get("locationNode") and payload["locationNode"] not in node_ids:
        raise ServiceError(400, "locationNode 不存在")
    team.update(payload)
    save_all(dataset)
    return team


def delete_team(team_id: str) -> None:
    dataset = load_all()
    team = find_by_id(dataset["resources"]["teams"], team_id, "队伍")
    if team["status"] == TeamStatus.busy.value:
        raise ServiceError(409, "busy 队伍不可删除")
    event_status_by_id = {event["id"]: event["status"] for event in dataset["events"]}
    for plan in dataset["plans"]:
        if team_id in plan["teams"] and event_status_by_id.get(plan["eventId"]) in active_event_statuses():
            raise ServiceError(409, "队伍被现有方案引用，无法删除")
    for simulation in dataset["simulations"]:
        if simulation["status"] in active_simulation_statuses() and team_id in simulation["teamPositions"]:
            raise ServiceError(409, "队伍被运行中仿真引用，无法删除")
    dataset["resources"]["teams"] = [item for item in dataset["resources"]["teams"] if item["id"] != team_id]
    save_all(dataset)


def list_depots() -> list[dict[str, Any]]:
    return load_json("resources")["depots"]


def create_depot(payload: dict[str, Any]) -> dict[str, Any]:
    dataset = load_all()
    if payload["id"] in {depot["id"] for depot in dataset["resources"]["depots"]}:
        raise ServiceError(409, "仓库 id 已存在")
    node_ids = {node["id"] for node in dataset["network"]["nodes"]}
    if payload["nodeId"] not in node_ids:
        raise ServiceError(400, "nodeId 不存在")
    dataset["resources"]["depots"].append(payload)
    save_all(dataset)
    return payload


def update_depot(depot_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    dataset = load_all()
    depot = find_by_id(dataset["resources"]["depots"], depot_id, "仓库")
    node_ids = {node["id"] for node in dataset["network"]["nodes"]}
    if payload.get("nodeId") and payload["nodeId"] not in node_ids:
        raise ServiceError(400, "nodeId 不存在")
    depot.update(payload)
    save_all(dataset)
    return depot


def delete_depot(depot_id: str) -> None:
    dataset = load_all()
    depot = find_by_id(dataset["resources"]["depots"], depot_id, "仓库")
    event_status_by_id = {event["id"]: event["status"] for event in dataset["events"]}
    for plan in dataset["plans"]:
        if event_status_by_id.get(plan["eventId"]) in active_event_statuses():
            for material in plan.get("requiredMaterials", []):
                if depot["materialType"] in {material["materialType"], "general"}:
                    raise ServiceError(409, "仓库可能被现有方案依赖，无法删除")
    dataset["resources"]["depots"] = [item for item in dataset["resources"]["depots"] if item["id"] != depot_id]
    save_all(dataset)


def export_resources() -> dict[str, Any]:
    return load_json("resources")


def import_resources(payload: dict[str, Any]) -> dict[str, Any]:
    node_ids = {node["id"] for node in load_json("network")["nodes"]}
    validated = validate_resources_import(payload, node_ids)
    dataset = load_all()
    new_team_ids = {team["id"] for team in validated["teams"]}
    event_status_by_id = {event["id"]: event["status"] for event in dataset["events"]}
    for plan in dataset["plans"]:
        if event_status_by_id.get(plan["eventId"]) in active_event_statuses():
            missing_teams = [team_id for team_id in plan["teams"] if team_id not in new_team_ids]
            if missing_teams:
                raise ServiceError(409, f"导入后会导致方案 {plan['id']} 丢失队伍")
    for simulation in dataset["simulations"]:
        if simulation["status"] in active_simulation_statuses():
            missing_teams = [team_id for team_id in simulation["teamPositions"] if team_id not in new_team_ids]
            if missing_teams:
                raise ServiceError(409, f"导入后会导致仿真 {simulation['id']} 丢失队伍")
    dataset["resources"] = validated
    save_all(dataset)
    return validated


def get_path(from_node: str, to_node: str) -> dict[str, Any]:
    network = load_json("network")
    try:
        return shortest_path(network["nodes"], network["edges"], from_node, to_node)
    except ValueError as exc:
        raise ServiceError(400, str(exc)) from exc


def list_plans_for_event(event_id: str) -> list[dict[str, Any]]:
    return [plan for plan in load_json("plans")["plans"] if plan["eventId"] == event_id]


def generate_plans(event_id: str) -> list[dict[str, Any]]:
    dataset = load_all()
    event = find_by_id(dataset["events"], event_id, "事件")
    if event["status"] not in {EventStatus.created.value, EventStatus.planned.value}:
        raise ServiceError(409, "当前事件状态不允许生成方案")
    idle_teams = [team for team in dataset["resources"]["teams"] if team["status"] == TeamStatus.idle.value]
    if not idle_teams:
        raise ServiceError(409, "当前没有可用空闲队伍")

    edge = find_by_id(dataset["network"]["edges"], event["roadId"], "道路")
    endpoints = [edge["fromNode"], edge["toNode"]]
    candidates = []
    for team in idle_teams:
        best_route = None
        for endpoint in endpoints:
            try:
                route = shortest_path(dataset["network"]["nodes"], dataset["network"]["edges"], team["locationNode"], endpoint)
            except ValueError:
                continue
            if best_route is None or route["cost"] < best_route["cost"]:
                best_route = route
        if best_route is not None:
            candidates.append(
                {
                    "team": team,
                    "route": best_route,
                    "arrivalTime": round(best_route["cost"], 2),
                    "skillScore": skill_match_score(event["type"], team["skill"]),
                }
            )
    if not candidates:
        raise ServiceError(400, "事故路段不可达")

    candidates_by_arrival = sorted(candidates, key=lambda item: item["arrivalTime"])
    candidates_by_skill = sorted(candidates, key=lambda item: (-item["skillScore"], item["arrivalTime"]))

    dataset["plans"] = [plan for plan in dataset["plans"] if plan["eventId"] != event_id]
    existing_plans = list(dataset["plans"])
    next_number = 0
    existing_ids = {plan["id"] for plan in existing_plans}

    def allocate_plan_id() -> str:
        nonlocal next_number
        while True:
            next_number += 1
            candidate = f"P{len(existing_plans) + next_number:03d}"
            if candidate not in existing_ids:
                existing_ids.add(candidate)
                return candidate

    plans = [
        build_plan(dataset, event, allocate_plan_id(), "nearest", "最近队伍优先", [candidates_by_arrival[0]]),
        build_plan(dataset, event, allocate_plan_id(), "skill_first", "专业能力优先", [candidates_by_skill[0]]),
    ]

    collaboration_members = candidates_by_skill[:2] if len(candidates_by_skill) >= 2 else [candidates_by_skill[0]]
    collaboration_plan = build_plan(dataset, event, allocate_plan_id(), "collaboration", "多队伍协同", collaboration_members)
    if len(collaboration_members) < 2:
        collaboration_plan["reason"] += "；当前空闲队伍不足两支，已降级为单队伍协同方案"
    plans.append(collaboration_plan)

    for plan in plans:
        material_feasible, shortages = assess_material_availability(dataset, plan.get("requiredMaterials", []))
        plan["materialFeasible"] = material_feasible
        plan["materialShortage"] = shortages
        if shortages:
            shortage_text = ", ".join(f"{item['materialType']} 缺少 {item['missing']}" for item in shortages)
            plan["reason"] += f"；库存约束：{shortage_text}"

    plans = normalize_plan_metrics(plans)
    feasible_plans = [plan for plan in plans if plan.get("materialFeasible")]
    best_plan = min(feasible_plans or plans, key=lambda item: item["score"])
    for plan in plans:
        plan["isRecommended"] = plan["id"] == best_plan["id"]

    dataset["plans"] = dataset["plans"] + plans
    event["selectedPlanId"] = best_plan["id"]
    event["status"] = EventStatus.planned.value
    event["updatedAt"] = now_text()
    save_all(dataset)
    return plans


def build_plan(
    dataset: dict[str, Any],
    event: dict[str, Any],
    plan_id: str,
    strategy: str,
    strategy_name: str,
    members: list[dict[str, Any]],
) -> dict[str, Any]:
    related_edge = find_by_id(dataset["network"]["edges"], event["roadId"], "道路")
    teams = [member["team"]["id"] for member in members]
    team_routes = {member["team"]["id"]: member["route"]["path"] for member in members}
    arrival_time = max(member["arrivalTime"] for member in members)
    route = max((member["route"]["path"] for member in members), key=len)
    weighted_efficiencies = [
        member["team"]["efficiency"] * team_skill_factor(event["type"], member["team"]["skill"]) for member in members
    ]
    total_efficiency = max(0.1, sum(weighted_efficiencies))
    if len(members) == 1:
        repair_time = event["workload"] / total_efficiency
    else:
        repair_time = event["workload"] / total_efficiency * 1.12
    required_materials = estimate_required_materials(event, len(members))
    material_cost = calculate_material_cost(required_materials)
    total_time = round(arrival_time + repair_time, 2)
    affected_vehicles = calculate_affected_vehicles(related_edge["flow"], total_time, event["severity"], strategy)
    coordination_cost = 450 * max(0, len(members) - 1)
    cost = 2500 + 900 * len(members) + repair_time * 15 + arrival_time * 20 + coordination_cost + material_cost
    risk_penalty = calculate_risk_penalty(event["severity"], strategy)
    if strategy == "nearest":
        reason = "到达速度快，但综合修复效率一般"
    elif strategy == "skill_first":
        reason = "专业匹配度高，风险较低"
    else:
        reason = "多队伍协同可缩短总恢复时间"
    return {
        "id": plan_id,
        "eventId": event["id"],
        "strategy": strategy,
        "strategyName": strategy_name,
        "teams": teams,
        "route": route,
        "teamRoutes": team_routes,
        "arrivalTime": round(arrival_time, 2),
        "repairTime": round(repair_time, 2),
        "totalTime": total_time,
        "cost": round(cost, 2),
        "affectedVehicles": round(affected_vehicles, 2),
        "riskPenalty": round(risk_penalty, 2),
        "score": 0.0,
        "isRecommended": False,
        "reason": reason,
        "requiredMaterials": required_materials,
        "createdAt": now_text(),
    }


def start_simulation(event_id: str, plan_id: str) -> dict[str, Any]:
    dataset = load_all()
    event = find_by_id(dataset["events"], event_id, "事件")
    plan = find_by_id(dataset["plans"], plan_id, "方案")
    if current_active_simulation_count(dataset) >= 10:
        raise ServiceError(409, "最多只允许 10 个运行中或暂停中的仿真")
    if plan["eventId"] != event_id:
        raise ServiceError(409, "planId 不属于当前 eventId")
    if event["status"] != EventStatus.planned.value:
        raise ServiceError(409, "只有 planned 事件可以启动仿真")
    for simulation in dataset["simulations"]:
        if simulation["eventId"] == event_id and simulation["status"] in active_simulation_statuses():
            raise ServiceError(409, "同一事件不能存在 running 或 paused 仿真")
    teams = [find_by_id(dataset["resources"]["teams"], team_id, "队伍") for team_id in plan["teams"]]
    for team in teams:
        if team["status"] != TeamStatus.idle.value:
            raise ServiceError(409, "方案中的队伍必须处于 idle 状态")
    edge = find_by_id(dataset["network"]["edges"], event["roadId"], "道路")

    material_allocations, shortages = allocate_materials(dataset, plan.get("requiredMaterials", []))
    if shortages:
        restore_materials(dataset, material_allocations)
        shortage_text = ", ".join(f"{item['materialType']} 缺少 {item['missing']}" for item in shortages)
        raise ServiceError(409, f"库存不足，无法启动仿真：{shortage_text}")

    simulation = {
        "id": next_id("SIM", dataset["simulations"]),
        "eventId": event_id,
        "planId": plan_id,
        "status": SimulationStatus.running.value,
        "currentTime": 0,
        "progress": 0,
        "speed": 1,
        "roadId": event["roadId"],
        "roadStatus": edge["status"],
        "teamPositions": {team["id"]: team["locationNode"] for team in teams},
        "phase": "dispatch",
        "currentAffectedVehicles": plan.get("affectedVehicles", 0),
        "consumedMaterials": material_allocations,
        "inventoryApplied": True,
        "logs": [
            f"仿真启动，采用{plan['strategyName']}方案",
            f"抢修队 {', '.join(plan['teams'])} 已出发",
        ],
        "beforeSimulationSnapshot": {
            "eventStatus": event["status"],
            "roadStatus": edge["status"],
            "teams": [{"id": team["id"], "status": team["status"], "locationNode": team["locationNode"]} for team in teams],
        },
        "startedAt": now_text(),
        "finishedAt": None,
    }
    event["status"] = EventStatus.running.value
    event["selectedPlanId"] = plan_id
    event["currentSimulationId"] = simulation["id"]
    event["updatedAt"] = now_text()
    edge["status"] = RoadStatus.repairing.value
    simulation["roadStatus"] = edge["status"]
    for team in teams:
        team["status"] = TeamStatus.busy.value
    dataset["simulations"].append(simulation)
    save_all(dataset)
    return simulation


def get_simulation(simulation_id: str) -> dict[str, Any]:
    return find_by_id(load_json("simulations")["simulations"], simulation_id, "仿真")


def step_simulation(simulation_id: str) -> dict[str, Any]:
    dataset = load_all()
    simulation = find_by_id(dataset["simulations"], simulation_id, "仿真")
    if simulation["status"] != SimulationStatus.running.value:
        return simulation
    plan = find_by_id(dataset["plans"], simulation["planId"], "方案")
    event = find_by_id(dataset["events"], simulation["eventId"], "事件")
    edge = find_by_id(dataset["network"]["edges"], simulation["roadId"], "道路")
    increment = 5 * simulation["speed"]
    simulation["currentTime"] += increment
    simulation["progress"] = min(100, round(simulation["currentTime"] / max(plan["totalTime"], 1) * 100, 2))
    simulation["phase"] = simulation_phase(simulation["progress"])
    update_team_positions(simulation, plan)
    simulation["currentAffectedVehicles"] = current_affected_vehicle_count(plan, simulation["progress"])

    if simulation["phase"] in {"dispatch", "travel"}:
        edge["status"] = RoadStatus.repairing.value
        simulation["roadStatus"] = edge["status"]
        stage_text = f"第{simulation['currentTime']}分钟：抢修队正在赶往事故路段"
    elif simulation["phase"] in {"repairing", "finishing"}:
        edge["status"] = RoadStatus.repairing.value
        simulation["roadStatus"] = edge["status"]
        stage_text = f"第{simulation['currentTime']}分钟：道路 {simulation['roadId']} 进入修复中，影响车辆降至 {simulation['currentAffectedVehicles']}"
    else:
        stage_text = f"第{simulation['currentTime']}分钟：抢修完成，道路恢复通行"
    simulation["logs"].append(stage_text)

    if simulation["progress"] >= 100:
        simulation["status"] = SimulationStatus.finished.value
        simulation["finishedAt"] = now_text()
        event["status"] = EventStatus.finished.value
        event["currentSimulationId"] = simulation["id"]
        event["updatedAt"] = now_text()
        for team_id in plan["teams"]:
            team = find_by_id(dataset["resources"]["teams"], team_id, "队伍")
            team["status"] = TeamStatus.idle.value
            team["locationNode"] = edge["toNode"]
        recalculate_road_status(dataset, simulation["roadId"])
        simulation["roadStatus"] = edge["status"]
        simulation["currentAffectedVehicles"] = 0
    save_all(dataset)
    return simulation


def pause_simulation(simulation_id: str) -> dict[str, Any]:
    dataset = load_all()
    simulation = find_by_id(dataset["simulations"], simulation_id, "仿真")
    if simulation["status"] != SimulationStatus.running.value:
        raise ServiceError(409, "只有 running 仿真可以暂停")
    simulation["status"] = SimulationStatus.paused.value
    simulation["logs"].append("仿真已暂停")
    save_all(dataset)
    return simulation


def resume_simulation(simulation_id: str) -> dict[str, Any]:
    dataset = load_all()
    simulation = find_by_id(dataset["simulations"], simulation_id, "仿真")
    if simulation["status"] != SimulationStatus.paused.value:
        raise ServiceError(409, "只有 paused 仿真可以继续")
    simulation["status"] = SimulationStatus.running.value
    simulation["logs"].append("仿真已继续")
    save_all(dataset)
    return simulation


def reset_simulation(simulation_id: str) -> dict[str, Any]:
    dataset = load_all()
    simulation = find_by_id(dataset["simulations"], simulation_id, "仿真")
    event = find_by_id(dataset["events"], simulation["eventId"], "事件")
    edge = find_by_id(dataset["network"]["edges"], simulation["roadId"], "道路")
    snapshot = simulation["beforeSimulationSnapshot"]
    event["status"] = snapshot["eventStatus"]
    event["currentSimulationId"] = simulation["id"]
    event["updatedAt"] = now_text()
    for team_snapshot in snapshot["teams"]:
        team = find_by_id(dataset["resources"]["teams"], team_snapshot["id"], "队伍")
        team["status"] = team_snapshot["status"]
        team["locationNode"] = team_snapshot["locationNode"]
    simulation["status"] = SimulationStatus.reset.value
    simulation["progress"] = 0
    simulation["currentTime"] = 0
    simulation["phase"] = "dispatch"
    simulation["teamPositions"] = {item["id"]: item["locationNode"] for item in snapshot["teams"]}
    simulation["logs"].append("仿真已重置，状态恢复到启动前")
    if simulation.get("inventoryApplied"):
        restore_materials(dataset, simulation.get("consumedMaterials", []))
        simulation["inventoryApplied"] = False
    edge["status"] = snapshot["roadStatus"]
    recalculate_road_status(dataset, simulation["roadId"])
    simulation["roadStatus"] = edge["status"]
    plan = find_by_id(dataset["plans"], simulation["planId"], "方案")
    simulation["currentAffectedVehicles"] = plan.get("affectedVehicles", 0)
    save_all(dataset)
    return simulation


def update_simulation_speed(simulation_id: str, speed: float) -> dict[str, Any]:
    dataset = load_all()
    simulation = find_by_id(dataset["simulations"], simulation_id, "仿真")
    if simulation["status"] not in active_simulation_statuses():
        raise ServiceError(409, "只有 running 或 paused 仿真可以调整倍速")
    simulation["speed"] = speed
    simulation["logs"].append(f"仿真倍速调整为 {speed}x")
    save_all(dataset)
    return simulation


def build_report(event_id: str) -> dict[str, Any]:
    dataset = load_all()
    event = find_by_id(dataset["events"], event_id, "事件")
    plans = [plan for plan in dataset["plans"] if plan["eventId"] == event_id]
    recommended_plan = next((plan for plan in plans if plan["isRecommended"]), None)
    simulation = None
    if event.get("currentSimulationId"):
        simulation = next((item for item in dataset["simulations"] if item["id"] == event["currentSimulationId"]), None)
    if simulation is None:
        simulation = next((item for item in reversed(dataset["simulations"]) if item["eventId"] == event_id), None)
    summary = {
        "eventStatus": event["status"],
        "planCount": len(plans),
        "recommendedStrategy": None if recommended_plan is None else recommended_plan["strategyName"],
        "simulationStatus": None if simulation is None else simulation["status"],
        "logCount": 0 if simulation is None else len(simulation["logs"]),
        "currentAffectedVehicles": 0 if simulation is None else simulation.get("currentAffectedVehicles", 0),
        "consumedMaterials": [] if simulation is None else simulation.get("consumedMaterials", []),
    }
    return {
        "event": event,
        "recommendedPlan": recommended_plan,
        "plans": plans,
        "simulation": simulation,
        "logs": [] if simulation is None else simulation["logs"],
        "summary": summary,
    }


def export_report(event_id: str) -> dict[str, Any]:
    return build_report(event_id)


def recalculate_road_status(dataset: dict[str, Any], road_id: str) -> None:
    edge = find_by_id(dataset["network"]["edges"], road_id, "道路")
    road_events = [event for event in dataset["events"] if event["roadId"] == road_id]
    running_events = [event for event in road_events if event["status"] == EventStatus.running.value]
    if running_events:
        edge["status"] = RoadStatus.repairing.value
        return
    blocked_events = [event for event in road_events if event["status"] in {EventStatus.created.value, EventStatus.planned.value} and event["blocked"]]
    if blocked_events:
        edge["status"] = RoadStatus.closed.value
        return
    damaged_events = [event for event in road_events if event["status"] in {EventStatus.created.value, EventStatus.planned.value} and not event["blocked"]]
    if damaged_events:
        edge["status"] = RoadStatus.damaged.value
        return
    finished_events = [event for event in road_events if event["status"] == EventStatus.finished.value]
    if finished_events:
        edge["status"] = RoadStatus.recovered.value
        return
    last_original_status = next((event["originalRoadStatus"] for event in reversed(road_events) if event.get("originalRoadStatus")), RoadStatus.normal.value)
    edge["status"] = last_original_status
