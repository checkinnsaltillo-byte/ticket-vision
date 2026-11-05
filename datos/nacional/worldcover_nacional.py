#!/usr/bin/env python3
"""Copia ESA WorldCover 10 m (2021, v200) de los cuadros de 3° que cubren México a Cloud Storage (worldcover/2021/<id>.tif), para no depender de AWS.
Cada tarea de un Cloud Run Job copia los cuadros que le tocan (CLOUD_RUN_TASK_INDEX / CLOUD_RUN_TASK_COUNT). Reanudable: salta los ya copiados. Índice: --fusiona."""
import os, sys, time, json, urllib.request, urllib.error, datetime
from google.cloud import storage
BUCKET = os.environ.get("BUCKET", "check-in-493804-panel")
URL = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_%s_Map.tif"
def log(*a): print(time.strftime("%H:%M:%S"), *a, flush=True)
IDS = [f"N{la:02d}W{lo:03d}" for la in range(12, 33, 3) for lo in range(120, 83, -3)]
b = storage.Client().bucket(BUCKET)
if "--fusiona" in sys.argv:
    t = sorted(x.name.split("/")[-1][:-4] for x in b.list_blobs(prefix="worldcover/2021/") if x.name.endswith(".tif"))
    b.blob("worldcover/2021/index.json").upload_from_string(json.dumps({"at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "tiles": t, "fuente": "ESA WorldCover 10 m 2021 v200 (CC BY 4.0)"}).encode(), content_type="application/json"); log("índice:", len(t), "cuadros"); sys.exit(0)
ti, tn = int(os.environ.get("CLOUD_RUN_TASK_INDEX", 0)), int(os.environ.get("CLOUD_RUN_TASK_COUNT", 1))
import tempfile
for id_ in IDS[ti::tn]:
    bl = b.blob(f"worldcover/2021/{id_}.tif")
    if bl.exists(): log(id_, "ya está"); continue
    for i in range(5):
        tmp = os.path.join(tempfile.gettempdir(), id_ + ".tif")
        try:
            with urllib.request.urlopen(URL % id_, timeout=300) as r, open(tmp, "wb") as f:
                while True:
                    blk = r.read(1 << 22)
                    if not blk: break
                    f.write(blk)
            bl.upload_from_filename(tmp, content_type="image/tiff"); os.remove(tmp); log(id_, "copiado"); break
        except urllib.error.HTTPError as e:
            if e.code in (403, 404): log(id_, "no existe (mar)"); break
            log(id_, "reintento", e); time.sleep(8 * (i + 1))
        except Exception as e: log(id_, "reintento", e); time.sleep(8 * (i + 1))
        finally:
            if os.path.exists(tmp): os.remove(tmp)
