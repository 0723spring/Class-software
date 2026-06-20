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

        recommended = next(plan for plan in plans if plan["isRecommended"])
        simulation = assert_code(
            client.post("/api/simulation/start", json={"eventId": event["id"], "planId": recommended["id"]}).json()
        )

        speed = assert_code(client.post("/api/simulation/speed", json={"simulationId": simulation["id"], "speed": 2}).json())
        assert speed["speed"] == 2

        step = assert_code(client.post("/api/simulation/step", json={"simulationId": simulation["id"]}).json())
        assert step["progress"] > 0

        delete_running_event = client.delete(f"/api/events/{event['id']}").json()
        assert delete_running_event["code"] == 409, delete_running_event

        busy_team_id = recommended["teams"][0]
        delete_busy_team = client.delete(f"/api/teams/{busy_team_id}").json()
        assert delete_busy_team["code"] == 409, delete_busy_team

        report = assert_code(client.get(f"/api/report/{event['id']}").json())
        assert {"event", "recommendedPlan", "plans", "simulation", "summary"}.issubset(report)

        validation_error = client.post("/api/events", json={"type": "road_collapse"}).json()
        assert validation_error["code"] == 400, validation_error

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

        print("smoke test passed")
    finally:
        reset_data()


if __name__ == "__main__":
    main()
