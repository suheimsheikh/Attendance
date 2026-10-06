"""Safety-backup-before-restore proof, run against a throwaway scratch DB
(the app DB is only read). Checks: safety copy taken on merge + replace,
undo of a bad replace restores the exact prior data, 5-slot rotation, a
corrupt archive takes no safety copy, a failed safety copy aborts with
nothing changed. Scratch DB is dropped at the end."""
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

import routes.admin_tools as at  # noqa: E402
import services.object_storage as osx  # noqa: E402

SCRATCH = os.environ["DB_NAME"] + "_safety_check"


def tar_of(files: dict) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, docs in files.items():
            b = json.dumps(docs).encode()
            info = tarfile.TarInfo(f"ych-full/{name}.json")
            info.size = len(b)
            tf.addfile(info, io.BytesIO(b))
    return buf.getvalue()


async def digest(db, skip=("pre_restore_backups",)):
    out = {}
    for n in sorted(await db.list_collection_names()):
        if n in skip:
            continue
        rows = []
        async for d in db[n].find({}):
            d.pop("_id", None)
            rows.append(hashlib.sha1(json.dumps(d, sort_keys=True, default=str).encode()).hexdigest())
        out[n] = sorted(rows)
    return out


def check(label, ok):
    print(("PASS " if ok else "FAIL ") + label)
    return ok


async def main():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    src, dst = client[os.environ["DB_NAME"]], client[SCRATCH]
    await client.drop_database(SCRATCH)
    admin = await src.users.find_one({"email": "admin@attendance.app"}, {"_id": 0})
    app = FastAPI()
    app.include_router(at.make_router(dst, lambda: admin))
    results = []
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t", timeout=600) as c:
        async def restore(data, mode, name="test.tar.gz"):
            return await c.post("/api/admin/restore", params={"mode": mode},
                                files={"file": (name, data, "application/gzip")})

        b0, _ = await at.build_full_backup(src)
        r = await restore(b0, "replace", "source.tar.gz")
        results.append(check("replace restore into empty DB → 200 with safety_backup",
                             r.status_code == 200 and r.json().get("safety_backup", {}).get("slot") == "1"))
        s1 = await digest(dst)

        bad = tar_of({"attendance": []})
        r = await restore(bad, "replace", "bad.tar.gz")
        results.append(check("bad replace wipes attendance", r.status_code == 200 and await dst.attendance.count_documents({}) == 0))
        slot = r.json()["safety_backup"]["slot"]
        st = (await c.get("/api/admin/backup-status")).json()
        results.append(check("backup-status lists the safety copies", {b["slot"] for b in st["pre_restore_backups"]} == {"1", "2"}))
        dl = await c.get(f"/api/admin/backup/pre-restore/{slot}/download")
        results.append(check("safety copy downloads", dl.status_code == 200 and "BeforeRestore" in dl.headers["content-disposition"]))
        r = await restore(dl.content, "replace", "undo.tar.gz")
        results.append(check("UNDO: restoring the safety copy brings back the exact prior data",
                             r.status_code == 200 and await digest(dst) == s1))

        for i in range(3):
            r = await restore(tar_of({"sms_log": []}), "merge", f"merge{i}.tar.gz")
        docs = await dst.pre_restore_backups.find({}, {"_id": 0}).to_list(20)
        newest = max(docs, key=lambda d: d["created_at"])
        results.append(check("merge restores also take a safety copy; 5 slots kept, oldest (slot 1) overwritten",
                             len(docs) == 5 and newest["slot"] == "1" and newest["mode"] == "merge"))

        before = sorted(d["created_at"] for d in docs)
        r = await restore(b"not a tar", "replace", "corrupt.tar.gz")
        after = sorted([d["created_at"] async for d in dst.pre_restore_backups.find({}, {"_id": 0})])
        results.append(check("corrupt archive → 400 and no safety slot used", r.status_code == 400 and before == after))

        real_put = osx.put_object
        osx.put_object = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("storage down"))
        snap = await digest(dst)
        r = await restore(bad, "replace", "bad-again.tar.gz")
        osx.put_object = real_put
        results.append(check("safety copy fails → 503 and nothing changed",
                             r.status_code == 503 and "nothing was restored" in r.json()["detail"] and await digest(dst) == snap))
    await client.drop_database(SCRATCH)
    print(f"{sum(results)}/{len(results)} passed")


asyncio.run(main())
