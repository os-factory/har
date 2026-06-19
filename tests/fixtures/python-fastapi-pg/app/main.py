import os
from fastapi import FastAPI

app = FastAPI()


@app.get("/api/v1/health")
def health():
    port = int(os.getenv("PORT", 8000))
    return {"status": "ok", "port": port}
