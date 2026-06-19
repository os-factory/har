# Python FastAPI PG Fixture

A minimal Python + FastAPI + PostgreSQL app used for testing `har`.

## Stack

- Python / FastAPI on port 8000
- PostgreSQL database
- Alembic migrations

## Running

```bash
pip install -e .
uvicorn app.main:app --reload
```

Health: `http://localhost:8000/api/v1/health`
