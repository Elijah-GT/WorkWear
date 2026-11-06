import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def db_file(tmp_path):
    return tmp_path / "test.db"


@pytest.fixture
def client(db_file):
    # The context manager runs startup, which creates the database.
    with TestClient(create_app(db_file)) as c:
        yield c
