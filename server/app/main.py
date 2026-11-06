"""WorkWear server. Routes follow docs/PROTOCOL.md.

Run from the server/ folder:
    uvicorn app.main:app --host 0.0.0.0 --port 8000
"""

from collections.abc import Iterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles

from . import db

DASHBOARD_DIR = Path(__file__).resolve().parent.parent.parent / "dashboard"


def create_app(db_path: Path | None = None) -> FastAPI:
    path = db_path or db.db_path()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db.init_db(path)
        yield

    app = FastAPI(title="WorkWear server", lifespan=lifespan)
    app.state.db_path = path

    # API routes are added in S2 and S3.

    # Serve the dashboard from "/" once it exists. Registered last, so /api/* wins.
    if DASHBOARD_DIR.is_dir():
        app.mount("/", StaticFiles(directory=DASHBOARD_DIR, html=True), name="dashboard")

    return app


def get_conn(request: Request) -> Iterator:
    """FastAPI dependency: one SQLite connection per request."""
    conn = db.connect(request.app.state.db_path)
    try:
        yield conn
    finally:
        conn.close()


app = create_app()
