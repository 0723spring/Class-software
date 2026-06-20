from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from typing import Any

from algorithms import normalize_plan_metrics, shortest_path, skill_match_score
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
    network = load_json("network")
    events = load_json("events")["events"]
    resources = load_json("resources")
    scenarios = load_json("scenarios")["scenarios"]
    plans = load_json("plans")["plans"]
    simulations = load_json("simulations")["simulations"]
    return {
        "network": network,
        "events": events,
        "resources": resources,
        "scenarios": scenarios,
        "plans": plans,
        "simulations": simulations,
    }


def save_all(payload: dict[str, Any]) -> None:
    save_json("network", payload["network"])
    save_json("events", {"events": payload["events"]})
    save_json("resources", payload["resources"])
    save_json("scenarios", {"scenarios": payload["scenarios"]})
    save_json("plans", {"plans": payload["plans"]})
    save_json("simulations", {"simulations": payload["simulations"]})


def find_by_id(items: list[dict[str, Any]], item_id: str, label: str) -> dict[str, Any]:
    for item in items:
        if item["id"] == item_id:
            return item
    raise ServiceError(404, f"{label}不存在")


def get_state() -> dict[str, Any]:
    dataset = load_all()
    metrics = build_metrics(dataset)
    return {
        "nodes": dataset["network"]["nodes"],
        "edges": dataset["network"]["edges"],
        "events": dataset["events"],
        "teams": dataset["resources"]["teams"],
        "depots": dataset["resources"]["depots"],
        "plans": dataset["plans"],
        "simulations": dataset["simulations"],
        "metrics": metrics,
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
    active_events = [event for event in events if event["status"] in {EventStatus.created.value, EventStatus.planned.value, EventStatus.running.value}]
    affected_vehicles = 0
    for event in active_events:
        edge = next((edge for edge in dataset["network"]["edges"] if edge["id"] == event["roadId"]), None)
        affected_vehicles += 0 if edge is None else edge["flow"]
    recovered_roads = sum(1 for edge in dataset["network"]["edges"] if edge["status"] == RoadStatus.recovered.value)
    return {
        "eventCount": len(events),
        "activeTasks": len(active_events),
        "averageRecoveryTime": average_recovery_time,
        "affectedVehicles": affected_vehicles,
        "recoveredRoads": recovered_roads,
    }


def reset_data() -> dict[str, Any]:
    reset_data_files()
    return get_state()


def list_network() -> dict[str, Any]:
    network = load_json("network")
    return network


def list_nodes() -> list[dict[str, Any]]:
    return load_json("network")["nodes"]


def list_edges() -> list[dict[str, Any]]:
    return load_json("network")["edges"]


def create_node(payload: dict[str, Any]) -> dict[str, Any]:
    dataset = load_all()
    nodes = dataset["network"]["nodes"]
    if any(node["id"] == payload["id"] for node in nodes):
        raise ServiceError(409, "节点 id 已存在")
    nodes.append(payload)
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
    edges = dataset["network"]["edges"]
    node_ids = {node["id"] for node in dataset["network"]["nodes"]}
    if payload["id"] in {edge["id"] for edge in edges}:
        raise ServiceError(409, "道路 id 已存在")
    if payload["fromNode"] not in node_ids or payload["toNode"] not in node_ids:
        raise ServiceError(400, "道路引用的节点不存在")
    edges.append(payload)
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
    active_events = {EventStatus.created.value, EventStatus.planned.value, EventStatus.running.value}
    for event in dataset["events"]:
        if event["roadId"] == edge_id and event["status"] in active_events:
            raise ServiceError(409, "道路被未完成事件引用，无法删除")
    dataset["network"]["edges"] = [edge for edge in dataset["network"]["edges"] if edge["id"] != edge_id]
    save_all(dataset)


def export_network() -> dict[str, Any]:
    return load_json("network")


def import_network(payload: dict[str, Any]) -> dict[str, Any]:
    validated = validate_network_import(payload)
    dataset = load_all()
    current_node_ids = {node["id"] for node in validated["nodes"]}
    for team in dataset["resources"]["teams"]:
        if team["locationNode"] not in current_node_ids:
            raise ServiceError(409, f"导入后会导致队伍 {team['id']} 丢失位置节点")
    for depot in dataset["resources"]["depots"]:
        if depot["nodeId"] not in current_node_ids:
            raise ServiceError(409, f"导入后会导致仓库 {depot['id']} 丢失节点")
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
    old_road_id = event["roadId"]
    new_road_id = payload.get("roadId", old_road_id)
    if new_road_id != old_road_id:
        find_by_id(dataset["network"]["edges"], new_road_id, "道路")
    event.update(payload)
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
    dataset["plans"] = [plan for plan in dataset["plans"] if plan["eventId"] != event_id]
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
    for simulation in dataset["simulations"]:
        if simulation["status"] in {SimulationStatus.running.value, SimulationStatus.paused.value} and team_id in simulation["teamPositions"]:
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
    find_by_id(dataset["resources"]["depots"], depot_id, "仓库")
    dataset["resources"]["depots"] = [item for item in dataset["resources"]["depots"] if item["id"] != depot_id]
    save_all(dataset)


def export_resources() -> dict[str, Any]:
    return load_json("resources")


def import_resources(payload: dict[str, Any]) -> dict[str, Any]:
    node_ids = {node["id"] for node in load_json("network")["nodes"]}
    validated = validate_resources_import(payload, node_ids)
    dataset = load_all()
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

    plans: list[dict[str, Any]] = []
    plans.append(build_plan(dataset, event, allocate_plan_id(), "nearest", "最近队伍优先", [candidates_by_arrival[0]]))
    plans.append(build_plan(dataset, event, allocate_plan_id(), "skill_first", "专业能力优先", [candidates_by_skill[0]]))

    collaboration_members = candidates_by_skill[:2] if len(candidates_by_skill) >= 2 else [candidates_by_skill[0]]
    collaboration_plan = build_plan(dataset, event, allocate_plan_id(), "collaboration", "多队伍协同", collaboration_members)
    if len(collaboration_members) < 2:
        collaboration_plan["reason"] += "；当前空闲队伍不足两支，已降级为单队伍协同方案"
    plans.append(collaboration_plan)

    plans = normalize_plan_metrics(plans)
    best_plan = min(plans, key=lambda item: item["score"])
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
    arrival_time = max(member["arrivalTime"] for member in members)
    route = members[0]["route"]["path"]
    total_efficiency = sum(member["team"]["efficiency"] for member in members)
    if len(members) == 1:
        repair_time = event["workload"] / total_efficiency
    else:
        repair_time = event["workload"] / total_efficiency * 0.85
    affected_vehicles = related_edge["flow"] * max(1, event["workload"] / 100)
    cost = 2500 + 700 * len(members) + repair_time * 12
    risk_penalty = 0.05
    if event["severity"] == "high":
        risk_penalty += 0.05
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
        "arrivalTime": round(arrival_time, 2),
        "repairTime": round(repair_time, 2),
        "totalTime": round(arrival_time + repair_time, 2),
        "cost": round(cost, 2),
        "affectedVehicles": round(affected_vehicles, 2),
        "riskPenalty": round(risk_penalty, 2),
        "score": 0.0,
        "isRecommended": False,
        "reason": reason,
        "createdAt": now_text(),
    }


def start_simulation(event_id: str, plan_id: str) -> dict[str, Any]:
    dataset = load_all()
    event = find_by_id(dataset["events"], event_id, "事件")
    plan = find_by_id(dataset["plans"], plan_id, "方案")
    if plan["eventId"] != event_id:
        raise ServiceError(409, "planId 不属于当前 eventId")
    if event["status"] != EventStatus.planned.value:
        raise ServiceError(409, "只有 planned 事件可以启动仿真")
    for simulation in dataset["simulations"]:
        if simulation["eventId"] == event_id and simulation["status"] in {SimulationStatus.running.value, SimulationStatus.paused.value}:
            raise ServiceError(409, "同一事件不能存在 running 或 paused 仿真")
    teams = [find_by_id(dataset["resources"]["teams"], team_id, "队伍") for team_id in plan["teams"]]
    for team in teams:
        if team["status"] != TeamStatus.idle.value:
            raise ServiceError(409, "方案中的队伍必须处于 idle 状态")
    edge = find_by_id(dataset["network"]["edges"], event["roadId"], "道路")

    simulation = {
        "id": next_id("SIM", dataset["simulations"]),
        "eventId": event_id,
        "planId": plan_id,
        "status": SimulationStatus.running.value,
        "currentTime": 0,
        "progress": 0,
        "speed": 1,
        "roadId": event["roadId"],
        "roadStatus": RoadStatus.repairing.value,
        "teamPositions": {team["id"]: team["locationNode"] for team in teams},
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
    event["currentSimulationId"] = simulation["id"]
    event["updatedAt"] = now_text()
    edge["status"] = RoadStatus.repairing.value
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
    if simulation["progress"] < 40:
        stage_text = f"第{simulation['currentTime']}分钟：抢修队正在赶往事故路段"
    elif simulation["progress"] < 100:
        stage_text = f"第{simulation['currentTime']}分钟：道路 {simulation['roadId']} 进入修复中"
    else:
        stage_text = f"第{simulation['currentTime']}分钟：抢修完成，道路恢复通行"
    simulation["logs"].append(stage_text)
    if simulation["progress"] >= 100:
        simulation["status"] = SimulationStatus.finished.value
        simulation["finishedAt"] = now_text()
        event["status"] = EventStatus.finished.value
        event["currentSimulationId"] = simulation["id"]
        event["updatedAt"] = now_text()
        edge["status"] = RoadStatus.recovered.value
        for team_id in plan["teams"]:
            team = find_by_id(dataset["resources"]["teams"], team_id, "队伍")
            team["status"] = TeamStatus.idle.value
            team["locationNode"] = edge["toNode"]
        simulation["roadStatus"] = RoadStatus.recovered.value
    save_all(dataset)
    return simulation


def pause_simulation(simulation_id: str) -> dict[str, Any]:
    dataset = load_all()
    simulation = find_by_id(dataset["simulations"], simulation_id, "仿真")
    if simulation["status"] != SimulationStatus.running.value:
        raise ServiceError(409, "只有 running 仿真可以暂停")
    simulation["status"] = SimulationStatus.paused.value
    save_all(dataset)
    return simulation


def resume_simulation(simulation_id: str) -> dict[str, Any]:
    dataset = load_all()
    simulation = find_by_id(dataset["simulations"], simulation_id, "仿真")
    if simulation["status"] != SimulationStatus.paused.value:
        raise ServiceError(409, "只有 paused 仿真可以继续")
    simulation["status"] = SimulationStatus.running.value
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
    edge["status"] = snapshot["roadStatus"]
    for team_snapshot in snapshot["teams"]:
        team = find_by_id(dataset["resources"]["teams"], team_snapshot["id"], "队伍")
        team["status"] = team_snapshot["status"]
        team["locationNode"] = team_snapshot["locationNode"]
    simulation["status"] = SimulationStatus.reset.value
    simulation["progress"] = 0
    simulation["currentTime"] = 0
    simulation["roadStatus"] = snapshot["roadStatus"]
    simulation["teamPositions"] = {item["id"]: item["locationNode"] for item in snapshot["teams"]}
    simulation["logs"].append("仿真已重置，状态恢复到启动前")
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
