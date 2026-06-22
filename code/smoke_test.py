from __future__ import annotations

from fastapi.testclient import TestClient

from main import app
from services import reset_data


def assert_code(payload: dict, code: int = 200) -> dict:
    assert payload["code"] == code, payload
    return payload["data"]


def main() -> None:
    reset_data()
    client = TestClient(app)

    try:
        state = assert_code(client.get("/api/state").json())
        assert state["nodes"] and state["edges"]

        event = assert_code(
            client.post(
                "/api/events",
                json={
                    "type": "road_collapse",
                    "roadId": "HI",
                    "severity": "high",
                    "startTime": "08:10",
                    "workload": 120,
                    "blocked": True,
                },
            ).json()
        )

        plans = assert_code(client.post("/api/plans/generate", json={"eventId": event["id"]}).json())
        assert len(plans) == 3
        assert len({plan["id"] for plan in plans}) == 3
        assert all("requiredMaterials" in plan for plan in plans)
        assert all("materialFeasible" in plan for plan in plans)

        recommended = next(plan for plan in plans if plan["isRecommended"])
        assert recommended["strategy"] == "skill_first"
        before_depots = {item["id"]: item["stock"] for item in assert_code(client.get("/api/depots").json())}
        simulation = assert_code(
            client.post("/api/simulation/start", json={"eventId": event["id"], "planId": recommended["id"]}).json()
        )
        assert simulation["roadStatus"] == "repairing"
        assert simulation["consumedMaterials"]

        after_start_depots = {item["id"]: item["stock"] for item in assert_code(client.get("/api/depots").json())}
        assert any(after_start_depots[depot_id] < before_depots[depot_id] for depot_id in before_depots)

        speed = assert_code(client.post("/api/simulation/speed", json={"simulationId": simulation["id"], "speed": 2}).json())
        assert speed["speed"] == 2

        step = assert_code(client.post("/api/simulation/step", json={"simulationId": simulation["id"]}).json())
        assert step["progress"] > 0
        first_affected = step["currentAffectedVehicles"]
        step_again = assert_code(client.post("/api/simulation/step", json={"simulationId": simulation["id"]}).json())
        assert step_again["currentAffectedVehicles"] < first_affected

        delete_running_event = client.delete(f"/api/events/{event['id']}").json()
        assert delete_running_event["code"] == 409, delete_running_event

        busy_team_id = recommended["teams"][0]
        delete_busy_team = client.delete(f"/api/teams/{busy_team_id}").json()
        assert delete_busy_team["code"] == 409, delete_busy_team

        report = assert_code(client.get(f"/api/report/{event['id']}").json())
        assert {"event", "recommendedPlan", "plans", "simulation", "summary"}.issubset(report)
        assert report["summary"]["consumedMaterials"]

        validation_error = client.post("/api/events", json={"type": "road_collapse"}).json()
        assert validation_error["code"] == 400, validation_error

        reset_simulation = assert_code(client.post("/api/simulation/reset", json={"simulationId": simulation["id"]}).json())
        assert reset_simulation["status"] == "reset"
        after_reset_depots = {item["id"]: item["stock"] for item in assert_code(client.get("/api/depots").json())}
        assert after_reset_depots == before_depots

        # Editing a planned event invalidates old plans and puts it back into created state.
        reset_data()
        event = assert_code(
            client.post(
                "/api/events",
                json={
                    "type": "road_collapse",
                    "roadId": "HI",
                    "severity": "high",
                    "startTime": "08:10",
                    "workload": 120,
                    "blocked": True,
                },
            ).json()
        )
        generated_plans = assert_code(client.post("/api/plans/generate", json={"eventId": event["id"]}).json())
        assert generated_plans
        updated_event = assert_code(
            client.put(
                f"/api/events/{event['id']}",
                json={"workload": 160, "blocked": False},
            ).json()
        )
        assert updated_event["status"] == "created"
        assert updated_event["selectedPlanId"] is None
        event_plans_after_edit = assert_code(client.get(f"/api/plans/{event['id']}").json())
        assert event_plans_after_edit == []

        # Plans protect referenced teams from deletion.
        regenerated_plans = assert_code(client.post("/api/plans/generate", json={"eventId": event["id"]}).json())
        protected_team_id = regenerated_plans[0]["teams"][0]
        protected_delete = client.delete(f"/api/teams/{protected_team_id}").json()
        assert protected_delete["code"] == 409, protected_delete

        # Imports should reject payloads that break active plans or simulations.
        bad_resources = {
            "teams": [
                {
                    "id": "T03",
                    "name": "桥梁维护队",
                    "locationNode": "F",
                    "workers": 7,
                    "vehicles": 2,
                    "skill": "bridge_repair",
                    "efficiency": 0.75,
                    "status": "idle",
                }
            ],
            "depots": [
                {"id": "D01", "nodeId": "F", "materialType": "asphalt", "stock": 300}
            ],
        }
        bad_resource_import = client.post("/api/resources/import", json=bad_resources).json()
        assert bad_resource_import["code"] == 409, bad_resource_import

        started_simulation = assert_code(
            client.post(
                "/api/simulation/start",
                json={"eventId": event["id"], "planId": next(plan["id"] for plan in regenerated_plans if plan["isRecommended"])},
            ).json()
        )
        bad_network = {
            "nodes": [
                {"id": "A", "name": "中心路口", "x": 120, "y": 180, "type": "intersection"},
                {"id": "B", "name": "东一路口", "x": 260, "y": 180, "type": "intersection"},
            ],
            "edges": [
                {"id": "AB", "fromNode": "A", "toNode": "B", "length": 1.2, "speed": 40, "flow": 900, "status": "normal"}
            ],
        }
        bad_network_import = client.post("/api/network/import", json=bad_network).json()
        assert bad_network_import["code"] == 409, bad_network_import
        assert started_simulation["status"] == "running"

        # Multiple simulations can coexist as long as they use different available teams.
        reset_data()
        event_a = assert_code(
            client.post(
                "/api/events",
                json={
                    "type": "road_collapse",
                    "roadId": "HI",
                    "severity": "high",
                    "startTime": "08:10",
                    "workload": 120,
                    "blocked": True,
                },
            ).json()
        )
        plans_a = assert_code(client.post("/api/plans/generate", json={"eventId": event_a["id"]}).json())
        plan_a = next(plan for plan in plans_a if plan["strategy"] == "skill_first")
        sim_a = assert_code(client.post("/api/simulation/start", json={"eventId": event_a["id"], "planId": plan_a["id"]}).json())
        assert sim_a["status"] == "running"

        event_b = assert_code(
            client.post(
                "/api/events",
                json={
                    "type": "waterlogging",
                    "roadId": "GH",
                    "severity": "medium",
                    "startTime": "09:00",
                    "workload": 13,
                    "blocked": True,
                },
            ).json()
        )
        plans_b = assert_code(client.post("/api/plans/generate", json={"eventId": event_b["id"]}).json())
        plan_b = next(plan for plan in plans_b if plan["strategy"] == "skill_first")
        sim_b = assert_code(client.post("/api/simulation/start", json={"eventId": event_b["id"], "planId": plan_b["id"]}).json())
        assert sim_b["status"] == "running"

        state_after_parallel = assert_code(client.get("/api/state").json())
        active_simulations = [item for item in state_after_parallel["simulations"] if item["status"] in {"running", "paused"}]
        assert len(active_simulations) == 2

        print("smoke test passed")
    finally:
        reset_data()


if __name__ == "__main__":
    main()
