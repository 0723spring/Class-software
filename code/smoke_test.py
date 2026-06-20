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

        print("smoke test passed")
    finally:
        reset_data()


if __name__ == "__main__":
    main()
