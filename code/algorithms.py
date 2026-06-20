from __future__ import annotations

import heapq
from math import inf
from typing import Any


SKILL_MAP = {
    "road_collapse": {"road_repair"},
    "waterlogging": {"drainage"},
    "bridge_damage": {"bridge_repair"},
    "pipe_burst": {"pipe_repair"},
    "traffic_accident": {"general", "road_repair"},
}


def congestion_factor(status: str) -> float | None:
    if status in {"closed", "damaged", "repairing"}:
        return None
    if status == "congested":
        return 1.5
    return 1.0


def build_graph(edges: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    graph: dict[str, list[dict[str, Any]]] = {}
    for edge in edges:
        graph.setdefault(edge["fromNode"], []).append(edge)
        graph.setdefault(edge["toNode"], []).append(
            {
                **edge,
                "fromNode": edge["toNode"],
                "toNode": edge["fromNode"],
            }
        )
    return graph


def shortest_path(nodes: list[dict[str, Any]], edges: list[dict[str, Any]], start: str, end: str) -> dict[str, Any]:
    node_ids = {node["id"] for node in nodes}
    if start not in node_ids:
        raise ValueError("起点不存在")
    if end not in node_ids:
        raise ValueError("终点不存在")
    if start == end:
        return {"from": start, "to": end, "path": [start], "cost": 0.0, "distance": 0.0, "blockedEdgesSkipped": []}

    graph = build_graph(edges)
    queue: list[tuple[float, str]] = [(0.0, start)]
    distances = {start: 0.0}
    prev: dict[str, tuple[str, str]] = {}
    lengths = {start: 0.0}
    blocked_skipped: set[str] = set()

    while queue:
        current_cost, current_node = heapq.heappop(queue)
        if current_cost > distances.get(current_node, inf):
            continue
        if current_node == end:
            break
        for edge in graph.get(current_node, []):
            factor = congestion_factor(edge["status"])
            if factor is None:
                blocked_skipped.add(edge["id"])
                continue
            edge_cost = (edge["length"] / edge["speed"]) * factor
            next_cost = current_cost + edge_cost
            next_node = edge["toNode"]
            if next_cost < distances.get(next_node, inf):
                distances[next_node] = next_cost
                lengths[next_node] = lengths[current_node] + edge["length"]
                prev[next_node] = (current_node, edge["id"])
                heapq.heappush(queue, (next_cost, next_node))

    if end not in distances:
        raise ValueError("当前道路不可达")

    path_nodes = [end]
    cursor = end
    while cursor != start:
        cursor = prev[cursor][0]
        path_nodes.append(cursor)
    path_nodes.reverse()
    return {
        "from": start,
        "to": end,
        "path": path_nodes,
        "cost": round(distances[end] * 60, 2),
        "distance": round(lengths[end], 2),
        "blockedEdgesSkipped": sorted(blocked_skipped),
    }


def skill_match_score(event_type: str, team_skill: str) -> int:
    target_skills = SKILL_MAP.get(event_type, {"general"})
    if team_skill in target_skills:
        return 2
    if team_skill == "general":
        return 1
    return 0


def normalize_plan_metrics(plans: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not plans:
        return plans
    time_values = [plan["totalTime"] for plan in plans]
    affected_values = [plan["affectedVehicles"] for plan in plans]
    cost_values = [plan["cost"] for plan in plans]

    def normalize(value: float, series: list[float]) -> float:
        min_value = min(series)
        max_value = max(series)
        if max_value == min_value:
            return 0.5
        return (value - min_value) / (max_value - min_value)

    for plan in plans:
        score = (
            0.45 * normalize(plan["totalTime"], time_values)
            + 0.25 * normalize(plan["affectedVehicles"], affected_values)
            + 0.20 * normalize(plan["cost"], cost_values)
            + 0.10 * plan["riskPenalty"]
        )
        plan["score"] = round(score, 4)
    return plans
