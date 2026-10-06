"""Round-trip proof: full backup of the app DB → restore (replace) into an
empty scratch DB → compare every collection document-by-document.
Read-only on the source DB; the scratch DB is dropped at the end."""
import asyncio
import hashlib
import io
import json
import os
import sys
import tarfile

sys.path.insert(0, "/app/backend")
from dotenv import load_dotenv  # noqa: E402

load_dotenv("/app/backend/.env")
import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from routes.admin_tools import build_full_backup, make_router  # noqa: E402

SCRATCH = os.environ["DB_NAME"] + "_restore_check"


def canon(d):
    d = dict(d)
    d.pop("_id", None)
    return hashlib.sha1(json.dumps(d, sort_keys=True, default=str).encode()).hexdigest()


async def digest(db, names):
    out = {}
    for n in names:
        out[n] = sorted([canon(d) async for d in db[n].find({})])
    return out


async def main():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    src, dst = client[os.environ["DB_NAME"]], client[SCRATCH]
    await client.drop_database(SCRATCH)
    data, fname = await build_full_backup(src)
    names = sorted(n for n in await src.list_collection_names() if not n.startswith("system."))
    before = await digest(src, names)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
        manifest = json.loads(tf.extractfile("ych-full/manifest.json").read())
    print(f"backup {fname}: {len(data)/1e6:.1f} MB gz, {len(manifest['collections'])} collections, "
          f"{sum(manifest['collections'].values())} docs")

    admin = await src.users.find_one({"email": "admin@attendance.app"}, {"_id": 0})
    app = FastAPI()
    app.include_router(make_router(dst, lambda: admin))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/api/admin/restore", params={"mode": "replace"},
                         files={"file": (fname, data, "application/gzip")}, timeout=600)
        print("restore:", r.status_code, str(r.json())[:200])

    after = await digest(dst, names)
    bad = 0
    for n in names:
        a, b = before[n], after.get(n, [])
        if a != b:
            bad += 1
            print(f"  MISMATCH {n}: source {len(a)} docs, restored {len(b)}")
    extra = sorted(set(await dst.list_collection_names()) - set(names))
    print("collections compared:", len(names), "mismatched:", bad, "extra in restored:", extra)
    await client.drop_database(SCRATCH)


asyncio.run(main())
