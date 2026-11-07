"""Regression: parallel requests (dashboard + helmets) must not fail.

FastAPI may open a request's database connection on one worker thread and run the
route on another. Found by the dashboard in D2: 63 of 153 requests returned 500.
"""

import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor

from app import db
from payloads import telemetry


def test_connection_can_be_used_from_another_thread(db_file):
    db.init_db(db_file)
    conn = db.connect(db_file)
    errors = []

    def use():
        try:
            conn.execute("SELECT 1").fetchone()
        except sqlite3.ProgrammingError as e:
            errors.append(e)

    t = threading.Thread(target=use)
    t.start()
    t.join()
    conn.close()
    assert errors == []


def test_parallel_requests_all_succeed(client):
    def call(i):
        if i % 3 == 0:
            return client.post("/api/telemetry", json=telemetry(device_id=f"helmet-{i % 4}", uptime_ms=i)).status_code
        if i % 3 == 1:
            return client.get("/api/devices").status_code
        return client.get("/api/incidents?limit=200").status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        codes = list(pool.map(call, range(120)))
    assert codes == [200] * 120
